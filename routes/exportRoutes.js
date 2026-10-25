const express = require("express");

const {
  exportPDF,
  exportDOCX,
} = require("../controllers/exportController");

const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// All export routes require login
router.use(authMiddleware);

// PDF
router.get("/pdf/:id", exportPDF);

// DOCX
router.get("/docx/:id", exportDOCX);

module.exports = router;