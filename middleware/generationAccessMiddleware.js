const mongoose = require("mongoose");
const crypto = require("crypto");
const AIUsage = require("../models/AIUsage");
const GenerationQuota = require("../models/GenerationQuota");
const Payment = require("../models/Payment");

const FREE_LIMIT = 4;

const GENERATION_PRICES = {
  outline: 500, // ₹5 in paise
  chapter: 1000, // ₹10 in paise
};

// An abandoned payment reservation can be reclaimed after 30 minutes.
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
          outlineUsed: outlineCount,
          chapterUsed: chapterCount,
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
  if (
    !Object.prototype.hasOwnProperty.call(
      GENERATION_PRICES,
      taskType
    )
  ) {
    throw new Error(`Unsupported generation type: ${taskType}`);
  }

  return async (req, res, next) => {
    const userId = req.user?.userId;

    const quotaField =
      taskType === "outline" ? "outlineUsed" : "chapterUsed";

    let access = null;
    let finalized = false;
    let finalizationPromise = null;

    // Release reserved quota or payment after failed generation.
    const releaseAccess = async () => {
      if (finalized || !access) return;

      if (finalizationPromise) {
        return finalizationPromise;
      }

      finalizationPromise = (async () => {
        if (access.source === "free") {
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
            throw new Error(
              "Could not release free quota reservation."
            );
          }
        } else if (access.source === "paid") {
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
            throw new Error(
              "Could not release payment reservation."
            );
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

    // Consume a paid generation only after successful AI generation.
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

        // Successful free chapter generations remain counted.
        finalized = true;
      })();

      try {
        await finalizationPromise;
      } finally {
        finalizationPromise = null;
      }
    };

    try {
      // Validate authentication.
      if (!userId || !mongoose.isValidObjectId(userId)) {
        return res.status(401).json({
          message: "Valid user authentication is required.",
        });
      }

      let requestedChapterCount;

      // Validate outline details.
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

        // RULE: Outlines with 1–4 chapters are always free.
        // They do not consume the paid-generation quota.
        if (requestedChapterCount <= 4) {
          req.generationAccess = {
            taskType,
            source: "free",
          };

          return next();
        }
      }

      // Validate chapter-generation details.
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
          !numberOfChapters ||
          !writingStyle ||
          !chapterTitle
        ) {
          return res.status(400).json({
            message:
              "Book details and chapter title are required.",
          });
        }
      }

      // Get the quota for chapter generations.
      // Outlines above 4 chapters always require payment,
      // regardless of the user's remaining chapter quota.
      const quota = await getOrCreateQuota(userId);

      if (!quota) {
        throw new Error("Could not load generation quota.");
      }

      let reservedQuota = null;

      if (taskType === "chapter") {
        // Preserve the existing four free chapter generations.
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
        access = { source: "free" };
      } else {
        // Outlines above 4 chapters and chapters exceeding the
        // free chapter quota need a verified payment.
        const paymentOrderId = req.body.paymentOrderId;

        if (
          typeof paymentOrderId !== "string" ||
          !paymentOrderId.trim()
        ) {
          return res.status(402).json({
            message:
              taskType === "outline"
                ? "Outlines with more than 4 chapters require payment. Pay ₹5 to generate this outline."
                : "Your four free chapter generations have been used. Pay ₹10 to generate another chapter.",
            paymentRequired: true,
            paymentType: taskType,
            pricePaise: GENERATION_PRICES[taskType],
            priceRupees: GENERATION_PRICES[taskType] / 100,
            freeLimit: FREE_LIMIT,
            used: quota[quotaField],
          });
        }

        const requestId = crypto.randomUUID();

        const staleBefore = new Date(
          Date.now() - STALE_RESERVATION_MS
        );

        // Claim a verified, unused payment atomically.
        const payment = await Payment.findOneAndUpdate(
          {
            user: userId,
            paymentType: taskType,
            razorpayOrderId: paymentOrderId,
            status: "paid",
            generationGranted: false,
            amount: GENERATION_PRICES[taskType],
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
              "A verified, unused payment for this generation is required. Please complete payment and try again.",
            paymentRequired: true,
            paymentType: taskType,
            pricePaise: GENERATION_PRICES[taskType],
            priceRupees: GENERATION_PRICES[taskType] / 100,
            freeLimit: FREE_LIMIT,
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

      const originalJson = res.json.bind(res);

      // Finalize quota/payment before sending the response.
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
                  "Unable to finalize this generation. Please check your generation status before retrying.",
              });
            }
          }
        })();

        return res;
      };

      // Release reservations if the client disconnects early.
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