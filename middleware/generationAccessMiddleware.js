
const mongoose = require("mongoose");
const crypto = require("crypto");

const AIUsage = require("../models/AIUsage");
const GenerationQuota = require("../models/GenerationQuota");
const Payment = require("../models/Payment");

const FREE_LIMIT = 4;
const FREE_OUTLINE_CHAPTERS = 4;

const OUTLINE_PRICE_PER_EXTRA_CHAPTER = 500; // ₹5 in paise
const CHAPTER_GENERATION_PRICE = 1000; // ₹10 in paise

// Allow recovery of abandoned reservations after 30 minutes.
const STALE_RESERVATION_MS = 30 * 60 * 1000;

const getOrCreateQuota = async (userId) => {
  const [outlineCount, chapterCount] = await Promise.all([
    AIUsage.countDocuments({
      userId,
      taskType: "outline",
      status: "success",
    }),
    AIUsage.countDocuments({
      userId,
      taskType: "chapter",
      status: "success",
    }),
  ]);

  try {
    return await GenerationQuota.findOneAndUpdate(
      { userId },
      {
        $setOnInsert: {
          userId,
          outlineUsed: 0,
          chapterUsed: 0,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );
  } catch (error) {
    if (error.code === 11000) {
      return GenerationQuota.findOne({ userId });
    }

    throw error;
  }
};

const generationAccessMiddleware = (taskType) => {
  if (!["outline", "chapter"].includes(taskType)) {
    throw new Error(`Unsupported generation type: ${taskType}`);
  }

  return async (req, res, next) => {
    const userId = req.user?.userId;

    const quotaField =
      taskType === "outline" ? "outlineUsed" : "chapterUsed";

    let access = null;
    let finalized = false;
    let finalizationPromise = null;

    // Release a reservation when generation fails.
    const releaseAccess = async () => {
      if (finalized || !access) return;

      if (finalizationPromise) {
        return finalizationPromise;
      }

      finalizationPromise = (async () => {
        if (access.source === "free" && access.reservedQuota) {
          const result = await GenerationQuota.updateOne(
            {
              userId,
              [quotaField]: { $gt: 0 },
            },
            {
              $inc: { [quotaField]: -1 },
            }
          );

          if (result.matchedCount !== 1) {
            throw new Error("Could not release free quota reservation.");
          }
        }

        if (access.source === "paid") {
          const result = await Payment.updateOne(
            {
              _id: access.paymentId,
              user: userId,
              status: "paid",
              generationGranted: false,
              generationInProgress: true,
              generationRequestId: access.requestId,
            },
            {
              $set: {
                generationInProgress: false,
                generationRequestId: null,
                generationReservedAt: null,
              },
            }
          );

          if (result.matchedCount !== 1) {
            throw new Error("Could not release payment reservation.");
          }
        }

        finalized = true;
      })();

      try {
        await finalizationPromise;
      } finally {
        finalizationPromise = null;
      }
    };

    // Mark a paid generation as consumed only after successful generation.
    const commitAccess = async () => {
      if (finalized || !access) return;

      if (finalizationPromise) {
        await finalizationPromise;
        if (finalized) return;
      }

      finalizationPromise = (async () => {
        if (access.source === "paid") {
          const result = await Payment.updateOne(
            {
              _id: access.paymentId,
              user: userId,
              status: "paid",
              generationGranted: false,
              generationInProgress: true,
              generationRequestId: access.requestId,
            },
            {
              $set: {
                generationGranted: true,
                generationInProgress: false,
                generationRequestId: null,
                generationReservedAt: null,
                generationUsedAt: new Date(),
              },
            }
          );

          if (result.matchedCount !== 1) {
            throw new Error(
              "Could not finalize the paid generation reservation."
            );
          }
        }

        // Successful free generations remain counted.
        finalized = true;
      })();

      try {
        await finalizationPromise;
      } finally {
        finalizationPromise = null;
      }
    };

    try {
      // 1. Validate authentication.
      if (!userId || !mongoose.isValidObjectId(userId)) {
        return res.status(401).json({
          message: "Valid user authentication is required.",
        });
      }

      let requestedChapterCount;

      // 2. Validate outline details and apply outline pricing.
      if (taskType === "outline") {
        const {
          title,
          topic,
          targetAudience,
          numberOfChapters,
          writingStyle,
        } = req.body;

        requestedChapterCount = Number(numberOfChapters);

        if (
          !title ||
          !topic ||
          !targetAudience ||
          !writingStyle ||
          !Number.isInteger(requestedChapterCount) ||
          requestedChapterCount < 1
        ) {
          return res.status(400).json({
            message:
              "Provide a title, topic, target audience, positive chapter count and writing style.",
          });
        }

        // Outlines containing 1–4 chapters are free.
        // This rule is independent of chapter-content generation quota.
        if (requestedChapterCount <= FREE_OUTLINE_CHAPTERS) {
          req.generationAccess = {
            taskType,
            source: "free",
          };

          return next();
        }
      }

      // 3. Validate chapter-content generation details.
      if (taskType === "chapter") {
        const {
          title,
          topic,
          targetAudience,
          numberOfChapters,
          writingStyle,
          chapterTitle,
        } = req.body;

        if (
          !title ||
          !topic ||
          !targetAudience ||
          !Number.isInteger(Number(numberOfChapters)) ||
          Number(numberOfChapters) < 1 ||
          !writingStyle ||
          !chapterTitle
        ) {
          return res.status(400).json({
            message: "Book details and chapter title are required.",
          });
        }
      }

      // 4. Calculate the exact server-side payment amount.
      const requiredAmount =
        taskType === "outline"
          ? (requestedChapterCount - FREE_OUTLINE_CHAPTERS) *
            OUTLINE_PRICE_PER_EXTRA_CHAPTER
          : CHAPTER_GENERATION_PRICE;

      // 5. Load the quota record.
      const quota = await getOrCreateQuota(userId);

      if (!quota) {
        throw new Error("Could not load generation quota.");
      }

      // 6. Reserve a free chapter-content generation atomically.
      // Outline requests above four chapters always require payment.
      let reservedQuota = null;

      if (taskType === "chapter") {
        reservedQuota = await GenerationQuota.findOneAndUpdate(
          {
            userId,
            [quotaField]: { $lt: FREE_LIMIT },
          },
          {
            $inc: { [quotaField]: 1 },
          },
          { new: true }
        );
      }

      if (reservedQuota) {
        access = {
          source: "free",
          reservedQuota: true,
        };
      } else {
        // 7. No free chapter generations remain, or this is a paid outline.
        const paymentOrderId = req.body.paymentOrderId;

        if (
          typeof paymentOrderId !== "string" ||
          !paymentOrderId.trim()
        ) {
          return res.status(402).json({
            message:
              taskType === "outline"
                ? `This ${requestedChapterCount}-chapter outline costs ₹${requiredAmount / 100}. The first 4 chapters are free; each additional chapter costs ₹5.`
                : "Your four free chapter generations have been used. Pay ₹10 to generate another chapter.",
            paymentRequired: true,
            paymentType: taskType,
            pricePaise: requiredAmount,
            priceRupees: requiredAmount / 100,
            freeLimit:
              taskType === "outline"
                ? FREE_OUTLINE_CHAPTERS
                : FREE_LIMIT,
            used: quota[quotaField],
          });
        }

        const requestId = crypto.randomUUID();
        const staleBefore = new Date(
          Date.now() - STALE_RESERVATION_MS
        );

        // 8. Claim a verified payment for this user, type and exact amount.
        // Atomic update prevents the same payment being used concurrently.
        const payment = await Payment.findOneAndUpdate(
          {
            user: userId,
            paymentType: taskType,
            razorpayOrderId: paymentOrderId,
            status: "paid",
            currency: "INR",
            amount: requiredAmount,
            generationGranted: false,
            $or: [
              { generationInProgress: false },
              { generationInProgress: { $exists: false } },
              { generationReservedAt: { $lt: staleBefore } },
            ],
          },
          {
            $set: {
              generationInProgress: true,
              generationRequestId: requestId,
              generationReservedAt: new Date(),
            },
          },
          { new: true }
        );

        if (!payment) {
          return res.status(402).json({
            message:
              "A verified, unused payment for the exact generation type and amount is required.",
            paymentRequired: true,
            paymentType: taskType,
            pricePaise: requiredAmount,
            priceRupees: requiredAmount / 100,
            freeLimit:
              taskType === "outline"
                ? FREE_OUTLINE_CHAPTERS
                : FREE_LIMIT,
            used: quota[quotaField],
          });
        }

        access = {
          source: "paid",
          paymentId: payment._id,
          requestId,
        };
      }

      req.generationAccess = {
        taskType,
        source: access.source,
      };

      // 9. Commit or release access before sending the AI response.
      const originalJson = res.json.bind(res);

      res.json = function (body) {
        if (finalized) {
          return originalJson(body);
        }

        const successful =
          res.statusCode >= 200 &&
          res.statusCode < 300 &&
          (taskType === "outline"
            ? Boolean(body?.outline?.chapters?.length)
            : Boolean(body?.content));

        (async () => {
          try {
            if (successful) {
              await commitAccess();
              originalJson(body);
            } else {
              await releaseAccess();
              originalJson(body);
            }
          } catch (error) {
            console.error(
              "Generation finalization error:",
              error.message
            );

            if (!res.headersSent && !res.destroyed) {
              res.status(500);

              originalJson({
                message:
                  "Unable to finalize this generation. Please check its status before retrying.",
              });
            }
          }
        })();

        return res;
      };

      // Release reservations if the client disconnects before completion.
      res.on("close", () => {
        if (!res.writableEnded && !finalized) {
          releaseAccess().catch((error) => {
            console.error(
              "Could not release disconnected generation:",
              error.message
            );
          });
        }
      });

      return next();
    } catch (error) {
      try {
        await releaseAccess();
      } catch (releaseError) {
        console.error(
          "Reservation cleanup error:",
          releaseError.message
        );
      }

      console.error(
        "Generation access middleware error:",
        error.message
      );

      if (!res.headersSent && !res.destroyed) {
        return res.status(500).json({
          message:
            "Unable to authorize this generation. Please try again.",
        });
      }
    }
  };
};

module.exports = generationAccessMiddleware;
