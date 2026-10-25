
const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");

const {
  createPaymentOrder,
  verifyPayment,
} = require("../controllers/paymentController");

const router = express.Router();

router.use(authMiddleware);

router.post("/create-order", createPaymentOrder);
router.post("/verify", verifyPayment);

module.exports = router;
