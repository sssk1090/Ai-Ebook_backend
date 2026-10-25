
const PlatformSettings = require("../models/PlatformSettings");

// Fields that administrators are allowed to update.
// The controller checks these against the actual Mongoose schema.
const getAllowedSettingsFields = () => {
  const excludedFields = ["_id", "key", "__v", "createdAt", "updatedAt"];

  return Object.keys(PlatformSettings.schema.paths).filter(
    (field) => !excludedFields.includes(field)
  );
};

// Flatten nested settings objects into MongoDB field paths.
// Example: { general: { platformName: "My App" } }
// becomes { "general.platformName": "My App" }.
const flattenSettings = (obj, prefix = "") => {
  const result = {};

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return result;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      continue;
    }

    const path = prefix ? `${prefix}.${key}` : key;

    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      Object.assign(result, flattenSettings(value, path));
    } else {
      result[path] = value;
    }
  }

  return result;
};

// GET /api/admin/settings
const getSettings = async (req, res) => {
  try {
    let settings = await PlatformSettings.findOne({ key: "global" });

    // Create the default settings document on first access.
    if (!settings) {
      settings = await PlatformSettings.create({ key: "global" });
    }

    return res.status(200).json({
      success: true,
      message: "Settings retrieved successfully",
      settings,
    });
  } catch (error) {
    console.error("Get settings error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve settings",
    });
  }
};

// PUT /api/admin/settings
const updateSettings = async (req, res) => {
  try {
    const allowedFields = getAllowedSettingsFields();
    const allowedSet = new Set(allowedFields);
    const submittedSettings = flattenSettings(req.body);

    const updates = {};

    for (const [field, value] of Object.entries(submittedSettings)) {
      if (allowedSet.has(field)) {
        updates[field] = value;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid settings fields were provided",
      });
    }

    const settings = await PlatformSettings.findOneAndUpdate(
      { key: "global" },
      { $set: updates, $setOnInsert: { key: "global" } },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      }
    );

    return res.status(200).json({
      success: true,
      message: "Settings updated successfully",
      settings,
    });
  } catch (error) {
    console.error("Update settings error:", error);

    if (error.name === "ValidationError" || error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid settings value",
        error: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to update settings",
    });
  }
};

// POST /api/admin/settings/reset
const resetSettings = async (req, res) => {
  try {
    // A new model instance provides the schema's default values.
    const defaults = new PlatformSettings({ key: "global" }).toObject();

    // Never overwrite MongoDB identity or timestamp fields during reset.
    delete defaults._id;
    delete defaults.__v;
    delete defaults.createdAt;
    delete defaults.updatedAt;

    const settings = await PlatformSettings.findOneAndUpdate(
      { key: "global" },
      {
        $set: defaults,
        $setOnInsert: { key: "global" },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      }
    );

    return res.status(200).json({
      success: true,
      message: "Settings reset to defaults successfully",
      settings,
    });
  } catch (error) {
    console.error("Reset settings error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to reset settings",
    });
  }
};

module.exports = {
  getSettings,
  updateSettings,
  resetSettings,
};
