
const mongoose = require("mongoose");

const platformSettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: "global",
      unique: true,
      immutable: true,
    },

    // General settings
    platformName: {
      type: String,
      default: "AI eBook Creator",
      trim: true,
    },
    platformEmail: {
      type: String,
      default: "admin@aebook.com",
      trim: true,
      lowercase: true,
    },
    timezone: {
      type: String,
      default: "Asia/Kolkata",
    },
    language: {
      type: String,
      default: "English",
    },

    // AI configuration
    aiModel: {
      type: String,
      default: "Gemini",
      enum: ["Gemini", "Gemini Flash"],
    },
    maxTokens: {
      type: Number,
      default: 8000,
      min: 100,
      max: 10000,
    },
    temperature: {
      type: Number,
      default: 0.7,
      min: 0,
      max: 2,
    },
    enableAI: {
      type: Boolean,
      default: true,
    },
    chapterWordLimit: {
      type: Number,
      default: 700,
      min: 100,
      max: 5000,
    },

    // eBook settings
    defaultVisibility: {
      type: String,
      default: "Private",
      enum: ["Private", "Public"],
    },
    maxChapters: {
      type: Number,
      default: 20,
      min: 1,
      max: 100,
    },
    allowExport: {
      type: Boolean,
      default: true,
    },
    allowPublicBooks: {
      type: Boolean,
      default: true,
    },

    // User settings
    allowRegistration: {
      type: Boolean,
      default: true,
    },
    requireEmailVerification: {
      type: Boolean,
      default: false,
    },
    allowProfileEditing: {
      type: Boolean,
      default: true,
    },

    // Notification preferences
    newUserNotification: {
      type: Boolean,
      default: true,
    },
    newBookNotification: {
      type: Boolean,
      default: true,
    },
    aiFailureNotification: {
      type: Boolean,
      default: true,
    },
    adminEmailNotification: {
      type: Boolean,
      default: true,
    },

    // Security settings
    requireStrongPassword: {
      type: Boolean,
      default: true,
    },
    enableTwoFactor: {
      type: Boolean,
      default: false,
    },
    sessionTimeout: {
      type: Number,
      default: 60,
      enum: [15, 30, 60, 120],
    },

    // System settings
    maintenanceMode: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "PlatformSettings",
  platformSettingsSchema
);
