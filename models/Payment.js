
const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    // User who initiated the payment
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // What the user is paying to generate
    paymentType: {
      type: String,
      enum: ["outline", "chapter"],
      required: true,
    },

    // Book associated with a chapter-generation payment.
    // Optional for compatibility with outline and historical payments.
    bookId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Book",
      default: null,
      index: true,
    },

    // Amount in paise: ₹5 = 500, ₹10 = 1000
    amount: {
      type: Number,
      required: true,
      min: 1,
    },

    currency: {
      type: String,
      default: "INR",
      enum: ["INR"],
    },

    // Unique Razorpay order ID
    razorpayOrderId: {
      type: String,
      required: true,
      unique: true,
    },

    // Filled after payment is verified
    razorpayPaymentId: {
      type: String,
      default: null,
    },

    razorpaySignature: {
      type: String,
      default: null,
    },

    // Payment lifecycle
    status: {
      type: String,
      enum: ["created", "paid", "failed", "refunded"],
      default: "created",
      index: true,
    },

    // True when this payment has authorized a successful generation.
    generationGranted: {
      type: Boolean,
      default: false,
    },

    // Prevent two requests from using the same payment simultaneously.
    generationInProgress: {
      type: Boolean,
      default: false,
    },

    // Identifies the generation request currently using this payment.
    generationRequestId: {
      type: String,
      default: null,
    },

    // Records when the current generation reservation was made.
    generationReservedAt: {
      type: Date,
      default: null,
    },

    // Records when the paid generation was successfully completed.
    generationUsedAt: {
      type: Date,
      default: null,
    },

    paidAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "payments",
  }
);

// A Razorpay payment ID can belong to at most one payment record.
paymentSchema.index(
  { razorpayPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      razorpayPaymentId: { $type: "string" },
    },
  }
);

module.exports = mongoose.model("Payment", paymentSchema);
