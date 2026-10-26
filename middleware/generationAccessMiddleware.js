
const mongoose = require("mongoose");
const crypto = require("crypto");

const GenerationQuota = require("../models/GenerationQuota");
const BookChapterQuota = require("../models/BookChapterQuota");
const Book = require("../models/Book");
const Payment = require("../models/Payment");

const FREE_LIMIT = 4;
const FREE_OUTLINE_CHAPTERS = 4;

const OUTLINE_PRICE_PER_EXTRA_CHAPTER = 500; // ₹5 in paise
const CHAPTER_GENERATION_PRICE = 1000; // ₹10 in paise

const STALE_RESERVATION_MS = 30 * 60 * 1000;

// Create or retrieve the existing user-level outline quota.
const getOrCreateOutlineQuota = async (userId) => {
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

// Create or retrieve the quota for one specific book.
const getOrCreateBookQuota = async (userId, bookId) => {
  try {
    return await BookChapterQuota.findOneAndUpdate(
      { userId, bookId },
      {
        $setOnInsert: {
          userId,
          bookId,
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
      return BookChapterQuota.findOne({ userId, bookId });
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

    let bookId = null;
    let quota = null;
    let access = null;
    let finalized = false;
    let finalizationPromise = null;

    const releaseAccess = async () => {
      if (finalized || !access) return;

      if (finalizationPromise) {
        return finalizationPromise;
      }

      finalizationPromise = (async () => {
        // Release a reserved free generation if AI generation failed.
        if (access.source === "free" && access.reservedQuota) {
          let result;

          if (taskType === "chapter") {
            result = await BookChapterQuota.updateOne(
              {
                userId,
                bookId,
                chapterUsed: { $gt: 0 },
              },
              {
                $inc: { chapterUsed: -1 },
              }
            );
          } else {
            result = await GenerationQuota.updateOne(
              {
                userId,
                outlineUsed: { $gt: 0 },
              },
              {
                $inc: { outlineUsed: -1 },
              }
            );
          }

          if (result.matchedCount !== 1) {
            throw new Error(
              "Could not release the free generation reservation."
            );
          }
        }

        // Release a paid reservation so a failed generation can be retried.
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

    const commitAccess = async () => {
      if (finalized || !access) return;

      if (finalizationPromise) {
        await finalizationPromise;
        if (finalized) return;
      }

      finalizationPromise = (async () => {
        // Mark payment as consumed only after successful AI generation.
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

        // Successful free reservations remain counted.
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

      // 2. Validate outline details and preserve outline pricing.
      if (taskType === "outline") {
        const {
          title,
          topic,
          targetAudience,
          numberOfChapters,
          writingStyle,
        } = req.body;

        const requestedChapterCount = Number(numberOfChapters);

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

        // The first four outline chapters remain free.
        if (requestedChapterCount <= FREE_OUTLINE_CHAPTERS) {
          req.generationAccess = {
            taskType,
            source: "free",
          };

          return next();
        }

        quota = await getOrCreateOutlineQuota(userId);

        if (!quota) {
          throw new Error("Could not load outline quota.");
        }

        req.requestedChapterCount = requestedChapterCount;
      }

      // 3. Validate chapter generation and book ownership.
      if (taskType === "chapter") {
        const {
          title,
          topic,
          targetAudience,
          numberOfChapters,
          writingStyle,
          chapterTitle,
          bookId: requestedBookId,
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

        if (
          !requestedBookId ||
          !mongoose.isValidObjectId(requestedBookId)
        ) {
          return res.status(400).json({
            message: "A valid book ID is required.",
          });
        }

        bookId = new mongoose.Types.ObjectId(requestedBookId);

        // A user can generate content only for their own book.
        const ownedBook = await Book.findOne({
          _id: bookId,
          userId,
        }).select("_id");

        if (!ownedBook) {
          return res.status(404).json({
            message: "Book not found.",
          });
        }

        quota = await getOrCreateBookQuota(userId, bookId);

        if (!quota) {
          throw new Error("Could not load book chapter quota.");
        }
      }

      // 4. Calculate the required payment on the server.
      const requiredAmount =
        taskType === "outline"
          ? (req.requestedChapterCount - FREE_OUTLINE_CHAPTERS) *
            OUTLINE_PRICE_PER_EXTRA_CHAPTER
          : CHAPTER_GENERATION_PRICE;

      // 5. Reserve a free chapter generation atomically for this book.
      let reservedQuota = null;

      if (taskType === "chapter") {
        reservedQuota = await BookChapterQuota.findOneAndUpdate(
          {
            userId,
            bookId,
            chapterUsed: { $lt: FREE_LIMIT },
          },
          {
            $inc: { chapterUsed: 1 },
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
        // 6. No free chapter quota remains, or this is a paid outline.
        const paymentOrderId = req.body.paymentOrderId;

        if (
          typeof paymentOrderId !== "string" ||
          !paymentOrderId.trim()
        ) {
          return res.status(402).json({
            message:
              taskType === "outline"
                ? `This ${req.requestedChapterCount}-chapter outline costs ₹${requiredAmount / 100}. The first 4 chapters are free; each additional chapter costs ₹5.`
                : "Your four free chapter generations for this book have been used. Pay ₹10 to generate another chapter.",
            paymentRequired: true,
            paymentType: taskType,
            pricePaise: requiredAmount,
            priceRupees: requiredAmount / 100,
            freeLimit:
              taskType === "outline"
                ? FREE_OUTLINE_CHAPTERS
                : FREE_LIMIT,
            used:
              taskType === "outline"
                ? quota.outlineUsed
                : quota.chapterUsed,
            bookId: taskType === "chapter" ? String(bookId) : undefined,
          });
        }

        const requestId = crypto.randomUUID();
        const staleBefore = new Date(
          Date.now() - STALE_RESERVATION_MS
        );

        // 7. Claim a verified, unused payment atomically.
        // Chapter payments must match the exact book as well as the user.
        const paymentFilter = {
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
        };

        if (taskType === "chapter") {
          paymentFilter.bookId = bookId;
        }

        const payment = await Payment.findOneAndUpdate(
          paymentFilter,
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
              "A verified, unused payment for this user, book, generation type and exact amount is required.",
            paymentRequired: true,
            paymentType: taskType,
            pricePaise: requiredAmount,
            priceRupees: requiredAmount / 100,
            freeLimit:
              taskType === "outline"
                ? FREE_OUTLINE_CHAPTERS
                : FREE_LIMIT,
            used:
              taskType === "outline"
                ? quota.outlineUsed
                : quota.chapterUsed,
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

      // 8. Commit or release the reservation based on the AI response.
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
