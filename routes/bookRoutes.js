const express = require("express");

const {
  createBook,
  getMyBooks,
  getPublicBooks,
  getBookById,
  updateBook,
  deleteBook,
} = require("../controllers/bookController");

const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// All book routes require authentication for now
router.use(authMiddleware);

router.post("/", createBook);

router.get("/my", getMyBooks);

router.get("/public", getPublicBooks);

router.get("/:id", getBookById);

router.put("/:id", updateBook);

router.delete("/:id", deleteBook);

module.exports = router;