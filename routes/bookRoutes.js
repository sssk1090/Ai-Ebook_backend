
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

// Public route: anyone can browse public eBooks.
router.get("/public", getPublicBooks);

// All routes below this line require authentication.
router.use(authMiddleware);

router.post("/", createBook);

router.get("/my", getMyBooks);

router.get("/:id", getBookById);

router.put("/:id", updateBook);

router.delete("/:id", deleteBook);

module.exports = router;
