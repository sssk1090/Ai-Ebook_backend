const express = require("express");

const {
  signup,
  login,
  getMe,
  updateProfile,
  changePassword,
} = require("../controllers/authController");

const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// Signup
router.post("/signup", signup);

// Login
router.post("/login", login);

// Get logged-in user
router.get("/me", authMiddleware, getMe);

// Update profile
router.put("/profile", authMiddleware, (req, res, next) => {
  console.log("");
  next();
}, updateProfile);

// Change password
router.put("/change-password", authMiddleware, changePassword);

module.exports = router;