
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

// A reservation left behind by a crashed request can be reclaimed
// after 30 minutes. Keep this longer than your normal AI request time.
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
  if (!Object.prototype.hasOwnProperty.call(
    GENERATION_PRICES,
    taskType
  )) {
    throw new Error(`Unsupported generation type: ${taskType}`);
  }

  return async (req, res, next) => {
    const userId = req.user?.userId;
    const quotaField =
      taskType === "outline" ? "outlineUsed" : "chapterUsed";

    let access = null;
    let finalized = false;
    let finalizationPromise = null;

    // Release a reservation after a failed generation.
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
            throw new Error("Could not release free quota reservation.");
          }
        } else if (access.source === "paid") {
          // Only the request that owns this reservation can release it.
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

    // Mark a reservation as consumed only after a valid AI result.
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

        // A successful free generation remains counted in the quota.
        finalized = true;
      })();

      try {
        await finalizationPromise;
      } finally {
        finalizationPromise = null;
      }
    };

    try {
      if (!userId || !mongoose.isValidObjectId(userId)) {
        return res.status(401).json({
          message: "Valid user authentication is required.",
        });
      }

      // Validate input before reserving quota or payment.
      if (taskType === "outline") {
        const {
          title,
          topic,
          targetAudience,
          numberOfChapters,
          writingStyle,
        } = req.body;

        const count = Number(numberOfChapters);

        if (
          !title ||
          !topic ||
          !targetAudience ||
          !writingStyle ||
          !Number.isInteger(count) ||
          count < 1
        ) {
          return res.status(400).json({
            message:
              "Provide a title, topic, target audience, positive chapter count and writing style.",
          });
        }
      }

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
            message: "Book details and chapter title are required.",
          });
        }
      }

      const quota = await getOrCreateQuota(userId);

      if (!quota) {
        throw new Error("Could not load generation quota.");
      }

      // Atomically reserve a free generation.
      const reservedQuota = await GenerationQuota.findOneAndUpdate(
        {
          userId,
          [quotaField]: { $lt: FREE_LIMIT },
        },
        {
          $inc: { [quotaField]: 1 },
        },
        { new: true }
      );

      if (reservedQuota) {
        access = { source: "free" };
      } else {
        const paymentOrderId = req.body.paymentOrderId;

        if (
          typeof paymentOrderId !== "string" ||
          !paymentOrderId.trim()
        ) {
          return res.status(402).json({
            message:
              taskType === "outline"
                ? "Your four free outline generations have been used. Pay ₹5 to generate another outline."
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

        // Claim a verified payment atomically. A payment already
        // consumed cannot be claimed again. An abandoned reservation
        // can be reclaimed after the stale-reservation window.
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

      // Express does not wait for async response wrappers, so this
      // wrapper handles finalization before sending the JSON response.
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

            // Do not return generated content if payment/quota
            // finalization could not be completed safely.
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

      // If the client disconnects before the response is complete,
      // attempt to release the reservation.
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
          message: "Unable to authorize this generation. Please try again.",
        });
      }
    }
  };
};

module.exports = generationAccessMiddleware;
