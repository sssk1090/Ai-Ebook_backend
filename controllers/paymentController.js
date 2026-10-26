
const Razorpay = require("razorpay");
const mongoose = require("mongoose");
const crypto = require("crypto");

const Payment = require("../models/Payment");
const Book = require("../models/Book");

const OUTLINE_PRICE_PER_EXTRA_CHAPTER = 500; // ₹5 in paise
const FREE_OUTLINE_CHAPTERS = 4;
const CHAPTER_GENERATION_PRICE = 1000; // ₹10 in paise

const getExpectedOutlineAmount = (chapterCount) =>
  Math.max(0, chapterCount - FREE_OUTLINE_CHAPTERS) *
  OUTLINE_PRICE_PER_EXTRA_CHAPTER;

const isValidStoredAmount = (paymentRecord) => {
  if (paymentRecord.paymentType === "chapter") {
    return paymentRecord.amount === CHAPTER_GENERATION_PRICE;
  }

  if (paymentRecord.paymentType === "outline") {
    return (
      Number.isInteger(paymentRecord.amount) &&
      paymentRecord.amount >= OUTLINE_PRICE_PER_EXTRA_CHAPTER &&
      paymentRecord.amount % OUTLINE_PRICE_PER_EXTRA_CHAPTER === 0
    );
  }

  return false;
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
    const chapterCount = Number(req.body.chapterCount);

    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(401).json({
        message: "Valid user authentication is required.",
      });
    }

    if (!["outline", "chapter"].includes(paymentType)) {
      return res.status(400).json({
        message: "paymentType must be outline or chapter.",
      });
    }

    let amount;
    let bookId = null;

    // Outline pricing remains unchanged.
    if (paymentType === "outline") {
      if (
        !Number.isInteger(chapterCount) ||
        chapterCount <= FREE_OUTLINE_CHAPTERS
      ) {
        return res.status(400).json({
          message:
            "Outlines with 4 or fewer chapters are free. Paid outline orders require at least 5 chapters.",
        });
      }

      amount = getExpectedOutlineAmount(chapterCount);
    } else {
      // Every paid chapter generation costs ₹10.
      amount = CHAPTER_GENERATION_PRICE;

      // Chapter payments must be linked to a valid book.
      const requestedBookId = req.body.bookId;

      if (
        !requestedBookId ||
        !mongoose.isValidObjectId(requestedBookId)
      ) {
        return res.status(400).json({
          message: "A valid book ID is required for chapter payments.",
        });
      }

      bookId = new mongoose.Types.ObjectId(requestedBookId);

      // Ensure this book belongs to the logged-in user.
      const ownedBook = await Book.findOne({
        _id: bookId,
        userId,
      }).select("_id");

      if (!ownedBook) {
        return res.status(404).json({
          message: "Book not found.",
        });
      }
    }

    const razorpay = getRazorpay();

    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: `gen_${new mongoose.Types.ObjectId().toString()}`,
      notes: {
        userId: userId.toString(),
        paymentType,
        ...(paymentType === "outline"
          ? { chapterCount: String(chapterCount) }
          : { bookId: bookId.toString() }),
      },
    });

    // Store the book ID for chapter payments.
    await Payment.create({
      user: userId,
      paymentType,
      ...(paymentType === "chapter" ? { bookId } : {}),
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
      ...(paymentType === "chapter"
        ? { bookId: bookId.toString() }
        : {}),
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

    // Only retrieve orders belonging to the authenticated user.
    const paymentRecord = await Payment.findOne({
      user: userId,
      razorpayOrderId: orderId,
    });

    if (!paymentRecord) {
      return res.status(404).json({
        message: "Payment order not found for this user.",
      });
    }

    // Validate the stored amount and currency.
    if (
      !isValidStoredAmount(paymentRecord) ||
      paymentRecord.currency !== "INR"
    ) {
      return res.status(400).json({
        message: "The stored payment amount or currency is invalid.",
      });
    }

    // New chapter payments must be associated with a book.
    // Legacy chapter payments without bookId cannot authorize new generations.
    if (
      paymentRecord.paymentType === "chapter" &&
      !paymentRecord.bookId
    ) {
      return res.status(400).json({
        message:
          "This chapter payment is not associated with a book. Create a new payment order.",
      });
    }

    // Make verification retries safe for the same payment.
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

    // Verify the Razorpay HMAC signature.
    const expectedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(`${paymentRecord.razorpayOrderId}|${paymentId}`)
      .digest();

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

    // Verify payment details directly with Razorpay.
    const razorpay = getRazorpay();
    const razorpayPayment = await razorpay.payments.fetch(paymentId);

    if (
      razorpayPayment.order_id !== paymentRecord.razorpayOrderId ||
      Number(razorpayPayment.amount) !== paymentRecord.amount ||
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

    // Atomically mark the order as paid.
    // The generation middleware grants generation access separately.
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
      // Handle concurrent verification requests safely.
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
      bookId: updatedPayment.bookId?.toString() || null,
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
