
const Razorpay = require("razorpay");
const mongoose = require("mongoose");
const crypto = require("crypto");
const Payment = require("../models/Payment");

const GENERATION_PRICES = {
  outline: 500, // ₹5 in paise
  chapter: 1000, // ₹10 in paise
};

const getRazorpay = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error("Razorpay credentials are not configured.");
  }

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
};

// POST /api/payments/create-order
const createPaymentOrder = async (req, res) => {
  try {
    const userId = req.user?.userId;
    const { paymentType } = req.body;

    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(401).json({
        message: "Valid user authentication is required.",
      });
    }

    if (!Object.prototype.hasOwnProperty.call(
      GENERATION_PRICES,
      paymentType
    )) {
      return res.status(400).json({
        message: "paymentType must be outline or chapter.",
      });
    }

    const amount = GENERATION_PRICES[paymentType];
    const razorpay = getRazorpay();

    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: `gen_${new mongoose.Types.ObjectId().toString()}`,
      notes: {
        userId: userId.toString(),
        paymentType,
      },
    });

    await Payment.create({
      user: userId,
      paymentType,
      amount,
      currency: "INR",
      razorpayOrderId: order.id,
      status: "created",
      generationGranted: false,
      generationInProgress: false,
      generationRequestId: null,
      generationReservedAt: null,
      generationUsedAt: null,
    });

    return res.status(201).json({
      message: "Payment order created successfully.",
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      paymentType,
    });
  } catch (error) {
    console.error("Create payment order error:", error.message);

    return res.status(500).json({
      message: "Unable to create payment order. Please try again.",
    });
  }
};

// POST /api/payments/verify
const verifyPayment = async (req, res) => {
  try {
    const userId = req.user?.userId;

    const {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    } = req.body;

    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(401).json({
        message: "Valid user authentication is required.",
      });
    }

    if (
      typeof orderId !== "string" ||
      typeof paymentId !== "string" ||
      typeof signature !== "string" ||
      !orderId.trim() ||
      !paymentId.trim() ||
      !signature.trim()
    ) {
      return res.status(400).json({
        message:
          "Razorpay order ID, payment ID and signature are required.",
      });
    }

    // Only find payment orders belonging to the logged-in user.
    const paymentRecord = await Payment.findOne({
      user: userId,
      razorpayOrderId: orderId,
    });

    if (!paymentRecord) {
      return res.status(404).json({
        message: "Payment order not found for this user.",
      });
    }

    // Check the stored price against the server-defined price.
    const expectedAmount = GENERATION_PRICES[paymentRecord.paymentType];

    if (
      !expectedAmount ||
      paymentRecord.amount !== expectedAmount ||
      paymentRecord.currency !== "INR"
    ) {
      return res.status(400).json({
        message: "The stored payment amount or currency is invalid.",
      });
    }

    // Repeated verification of the same payment is safe.
    if (paymentRecord.status === "paid") {
      if (paymentRecord.razorpayPaymentId === paymentId) {
        return res.status(200).json({
          message: "Payment has already been verified.",
          status: "paid",
          orderId,
          paymentType: paymentRecord.paymentType,
          amount: paymentRecord.amount,
        });
      }

      return res.status(409).json({
        message: "This order has already been paid with another payment.",
      });
    }

    if (paymentRecord.status !== "created") {
      return res.status(409).json({
        message: "This order is not available for verification.",
      });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keySecret) {
      throw new Error("Razorpay secret is not configured.");
    }

    // Verify the Razorpay signature using the saved order ID.
    const expectedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(`${paymentRecord.razorpayOrderId}|${paymentId}`)
      .digest();

      console.log("Razorpay verification diagnostics:", {
    orderIdReceived: Boolean(orderId),
     paymentIdReceived: Boolean(paymentId),
    signatureReceived: Boolean(signature),
    signatureLength: signature?.length,
    signatureIsHex: typeof signature === "string"
        ? /^[a-fA-F0-9]+$/.test(signature)
        : false,
    });

    // Reject malformed hexadecimal signatures.
    if (!/^[a-fA-F0-9]{64}$/.test(signature)) {
      return res.status(400).json({
        message: "Invalid payment signature.",
      });
    }

    const receivedSignature = Buffer.from(signature, "hex");

    if (
      receivedSignature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(expectedSignature, receivedSignature)
    ) {
      return res.status(400).json({
        message: "Payment signature verification failed.",
      });
    }

    // Confirm payment details directly with Razorpay.
    const razorpay = getRazorpay();
    const razorpayPayment = await razorpay.payments.fetch(paymentId);

    if (
      razorpayPayment.order_id !== paymentRecord.razorpayOrderId ||
      Number(razorpayPayment.amount) !== expectedAmount ||
      razorpayPayment.currency !== "INR"
    ) {
      return res.status(400).json({
        message: "Payment details do not match the expected order.",
      });
    }

    if (razorpayPayment.status !== "captured") {
      return res.status(409).json({
        message:
          "Payment has not been captured yet. Check its status before retrying.",
        paymentStatus: razorpayPayment.status,
      });
    }

    // Atomically mark the order as paid; do not grant a generation here.
    const updatedPayment = await Payment.findOneAndUpdate(
      {
        _id: paymentRecord._id,
        user: userId,
        status: "created",
        razorpayPaymentId: null,
      },
      {
        $set: {
          razorpayPaymentId: paymentId,
          razorpaySignature: signature,
          status: "paid",
          paidAt: new Date(),
        },
      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!updatedPayment) {
      // Another request may have verified this exact payment.
      const latestPayment = await Payment.findById(paymentRecord._id);

      if (
        latestPayment?.status === "paid" &&
        latestPayment.razorpayPaymentId === paymentId
      ) {
        return res.status(200).json({
          message: "Payment has already been verified.",
          status: "paid",
          orderId,
          paymentType: latestPayment.paymentType,
          amount: latestPayment.amount,
        });
      }

      return res.status(409).json({
        message: "Payment order has already been processed.",
      });
    }

    console.log("Razorpay payment verified:", {
      orderId,
      paymentId,
      paymentType: updatedPayment.paymentType,
      amount: updatedPayment.amount,
    });

    return res.status(200).json({
      message: "Payment verified successfully.",
      status: "paid",
      orderId,
      paymentType: updatedPayment.paymentType,
      amount: updatedPayment.amount,
    });
  } catch (error) {
    console.error("Verify payment error:", error.message);

    return res.status(500).json({
      message: "Unable to verify payment. Please try again.",
    });
  }
};

module.exports = {
  createPaymentOrder,
  verifyPayment,
};
