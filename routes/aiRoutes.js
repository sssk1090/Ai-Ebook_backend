const express = require("express");

const {
  generateBookContent,
  generateBookOutline,
} = require("../controllers/aiController");

const authMiddleware = require("../middleware/authMiddleware");
const generationAccessMiddleware = require(
  "../middleware/generationAccessMiddleware"
);

const router = express.Router();

router.use(authMiddleware);

router.post(
  "/generate-chapter",
  generationAccessMiddleware("chapter"),
  generateBookContent
);

router.post(
  "/generate-outline",
  generationAccessMiddleware("outline"),
  generateBookOutline
);

module.exports = router;