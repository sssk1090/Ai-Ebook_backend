

const express = require("express");

const authMiddleware = require("../middleware/authMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");

const {
  getDashboard,
  getUsers,
  deleteUser,
  changeUserRole,
  getAdminBooks,
  getAdminBookById,
  changeBookVisibility,
  deleteAdminBook,
  getAdminAnalytics,
} = require("../controllers/adminController");

const {
  getAIUsageStats,
  getAIUsageHistory,
} = require("../controllers/adminAIUsageController");

const {
  getPaymentAnalysisStats,
  getPaymentTransactions,
} = require("../controllers/adminPaymentAnalysisController");


const {
  getSettings,
  updateSettings,
  resetSettings,
} = require("../controllers/adminSettingsController");


const router = express.Router();

// =====================================================
// ADMIN SECURITY
// All routes below require authentication and admin role
// =====================================================

router.use(authMiddleware);
router.use(adminMiddleware);

// =====================================================
// ADMIN TEST
// =====================================================

router.get("/test", (req, res) => {
  res.status(200).json({
    message: "Admin access granted",
    admin: req.user,
  });
});

// =====================================================
// ADMIN DASHBOARD
// =====================================================

router.get("/dashboard", getDashboard);

// =====================================================
// ADMIN USER MANAGEMENT
// =====================================================

router.get("/users", getUsers);
router.delete("/users/:id", deleteUser);
router.put("/users/:id/role", changeUserRole);

// =====================================================
// ADMIN BOOK MANAGEMENT
// =====================================================

router.get("/books", getAdminBooks);
router.get("/books/:id", getAdminBookById);
router.put("/books/:id/visibility", changeBookVisibility);
router.delete("/books/:id", deleteAdminBook);

// =====================================================
// ADMIN AI USAGE
// =====================================================

router.get("/ai-usage/stats", getAIUsageStats);
router.get("/ai-usage/history", getAIUsageHistory);
router.get("/analytics", getAdminAnalytics);



router.get("/settings", getSettings);
router.put("/settings", updateSettings);
router.post("/settings/reset", resetSettings);

router.get(
  "/payment-analysis/stats",
  getPaymentAnalysisStats
);

router.get(
  "/payment-analysis/transactions",
  getPaymentTransactions
);


module.exports = router;