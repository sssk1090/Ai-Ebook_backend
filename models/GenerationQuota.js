const mongoose = require("mongoose");

const generationQuotaSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    outlineUsed: {
      type: Number,
      default: 0,
      min: 0,
    },
    chapterUsed: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
    collection: "generationquotas",
  }
);

module.exports = mongoose.model(
  "GenerationQuota",
  generationQuotaSchema
);