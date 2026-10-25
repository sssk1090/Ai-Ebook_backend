
const mongoose = require("mongoose");

const chapterSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },

    content: {
      type: String,
      default: "",
    },
  },
  {
    _id: true,
  }
);

const bookSchema = new mongoose.Schema(
  {
    // Book title
    title: {
      type: String,
      required: true,
      trim: true,
    },

    // Main topic
    topic: {
      type: String,
      required: true,
      trim: true,
    },

    // Book description
    description: {
      type: String,
      default: "",
      trim: true,
    },

    // Target audience
    targetAudience: {
      type: String,
      required: true,
      trim: true,
    },

    // Number of chapters requested
    numberOfChapters: {
      type: Number,
      required: true,
      min: 1,
      max: 50,
    },

    // Writing style
    writingStyle: {
      type: String,
      required: true,
      trim: true,
    },

    // Book author
    author: {
      type: String,
      required: true,
      trim: true,
    },

    // User who created the book
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Book visibility
    visibility: {
      type: String,
      enum: ["public", "private"],
      default: "private",
    },

    // Book chapters
    chapters: {
      type: [chapterSchema],
      default: [],
    },

    // Number of views
    views: {
      type: Number,
      default: 0,
    },

    // Number of likes
    likes: {
      type: Number,
      default: 0,
    },
  },

  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Book", bookSchema);

