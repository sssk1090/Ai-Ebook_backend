 
const Payment = require("../models/Payment");

// GET /api/admin/payment-analysis/stats
const getPaymentAnalysisStats = async (req, res) => {
  try {
    const [
      statusStats,
      typeStats,
      monthlyStats,
    ] = await Promise.all([
      // Transaction counts and amounts grouped by status
      Payment.aggregate([
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            amountPaise: { $sum: "$amount" },
          },
        },
      ]),

      // Revenue grouped by payment type
      Payment.aggregate([
        { $match: { status: "paid" } },
        {
          $group: {
            _id: "$paymentType",
            count: { $sum: 1 },
            amountPaise: { $sum: "$amount" },
          },
        },
      ]),

      // Last 12 months of successful payment revenue
      Payment.aggregate([
        { $match: { status: "paid" } },
        {
          $addFields: {
            revenueDate: {
              $ifNull: [
                "$paidAt",
                { $ifNull: ["$updatedAt", "$createdAt"] },
              ],
            },
          },
        },
        {
          $match: {
            revenueDate: {
              $gte: (() => {
                const date = new Date();
                date.setUTCDate(1);
                date.setUTCHours(0, 0, 0, 0);
                date.setUTCMonth(date.getUTCMonth() - 11);
                return date;
              })(),
            },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: "$revenueDate" },
              month: { $month: "$revenueDate" },
            },
            count: { $sum: 1 },
            amountPaise: { $sum: "$amount" },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]),
    ]);

    const statusMap = {};
    for (const item of statusStats) {
      statusMap[item._id] = item;
    }

    const typeMap = {};
    for (const item of typeStats) {
      typeMap[item._id] = item;
    }

    const paid = statusMap.paid || {};
    const refunded = statusMap.refunded || {};

    const monthlyMap = new Map(
      monthlyStats.map((item) => [
        `${item._id.year}-${String(item._id.month).padStart(2, "0")}`,
        item,
      ])
    );

    const monthlyRevenue = [];
    const now = new Date();

    for (let i = 11; i >= 0; i--) {
      const date = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)
      );

      const key =
        `${date.getUTCFullYear()}-` +
        `${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

      const item = monthlyMap.get(key);

      monthlyRevenue.push({
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        label: date.toLocaleString("en-US", {
          month: "short",
          timeZone: "UTC",
        }) + ` ${date.getUTCFullYear()}`,
        transactions: item?.count || 0,
        revenue: (item?.amountPaise || 0) / 100,
      });
    }

    const outline = typeMap.outline || {};
    const chapter = typeMap.chapter || {};

    res.status(200).json({
      success: true,
      overview: {
        totalRevenue: (paid.amountPaise || 0) / 100,
        netRevenue:
          ((paid.amountPaise || 0) - (refunded.amountPaise || 0)) / 100,
        paidTransactions: paid.count || 0,
        createdTransactions: statusMap.created?.count || 0,
        failedTransactions: statusMap.failed?.count || 0,
        refundedTransactions: refunded.count || 0,
        refundedAmount: (refunded.amountPaise || 0) / 100,
        outlineRevenue: (outline.amountPaise || 0) / 100,
        outlineTransactions: outline.count || 0,
        chapterRevenue: (chapter.amountPaise || 0) / 100,
        chapterTransactions: chapter.count || 0,
        totalTransactions: statusStats.reduce(
          (sum, item) => sum + item.count,
          0
        ),
      },
      monthlyRevenue,
    });
  } catch (error) {
    console.error("Payment analysis stats error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load payment analysis statistics.",
    });
  }
};

// GET /api/admin/payment-analysis/transactions
const getPaymentTransactions = async (req, res) => {
  try {
    const {
      page = "1",
      limit = "10",
      status,
      paymentType,
      startDate,
      endDate,
    } = req.query;

    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(limit, 10) || 10)
    );

    const filter = {};

    if (status) {
      if (!["created", "paid", "failed", "refunded"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid payment status.",
        });
      }

      filter.status = status;
    }

    if (paymentType) {
      if (!["outline", "chapter"].includes(paymentType)) {
        return res.status(400).json({
          success: false,
          message: "Invalid payment type.",
        });
      }

      filter.paymentType = paymentType;
    }

    if (startDate || endDate) {
      const dateFilter = {};

      if (startDate) {
        const start = new Date(startDate);

        if (Number.isNaN(start.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Invalid start date.",
          });
        }

        dateFilter.$gte = start;
      }

      if (endDate) {
        const end = new Date(endDate);

        if (Number.isNaN(end.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Invalid end date.",
          });
        }

        // Include the entire selected end date for YYYY-MM-DD inputs.
        if (/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
          end.setUTCHours(23, 59, 59, 999);
        }

        dateFilter.$lte = end;
      }

      if (
        dateFilter.$gte &&
        dateFilter.$lte &&
        dateFilter.$gte > dateFilter.$lte
      ) {
        return res.status(400).json({
          success: false,
          message: "Start date must not be after end date.",
        });
      }

      filter.createdAt = dateFilter;
    }

    const [transactions, total] = await Promise.all([
      Payment.find(filter)
        .select(
          "user paymentType amount currency status razorpayOrderId " +
          "razorpayPaymentId paidAt createdAt updatedAt"
        )
        .populate("user", "name email")
        .sort({ createdAt: -1, _id: -1 })
        .skip((pageNumber - 1) * pageSize)
        .limit(pageSize)
        .lean(),

      Payment.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      transactions,
      pagination: {
        page: pageNumber,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    console.error("Payment transaction history error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load payment transactions.",
    });
  }
};

module.exports = {
  getPaymentAnalysisStats,
  getPaymentTransactions,
};
