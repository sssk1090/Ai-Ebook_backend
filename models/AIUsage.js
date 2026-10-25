
const mongoose = require("mongoose");

const aiUsageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    bookId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Book",
      default: null,
    },

    taskType: {
      type: String,
      enum: ["outline", "chapter"],
      required: true,
    },

    provider: {
      type: String,
      enum: ["gemini", "groq", "none"],
      default: "none",
      required: true,
    },

    model: {
      type: String,
      default: null,
    },

    status: {
      type: String,
      enum: ["success", "failed"],
      required: true,
    },

    fallbackUsed: {
      type: Boolean,
      default: false,
    },

    durationMs: {
      type: Number,
      default: null,
      min: 0,
    },

    promptTokens: {
      type: Number,
      default: null,
      min: 0,
    },

    completionTokens: {
      type: Number,
      default: null,
      min: 0,
    },

    errorMessage: {
      type: String,
      default: null,
      maxlength: 1000,
    },
  },
  {
    timestamps: true,
    collection: "aiusages",
  }
);

// Helpful indexes for admin dashboard queries.
aiUsageSchema.index({ createdAt: -1 });
aiUsageSchema.index({ provider: 1, status: 1 });
aiUsageSchema.index({ taskType: 1, createdAt: -1 });

module.exports = mongoose.model("AIUsage", aiUsageSchema);