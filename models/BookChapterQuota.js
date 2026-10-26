
const mongoose = require("mongoose");

const bookChapterQuotaSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    bookId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Book",
      required: true,
    },

    chapterUsed: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
    collection: "bookchapterquotas",
  }
);

// Each user gets a separate quota for each book.
bookChapterQuotaSchema.index(
  { userId: 1, bookId: 1 },
  { unique: true }
);

module.exports = mongoose.model(
  "BookChapterQuota",
  bookChapterQuotaSchema
);
