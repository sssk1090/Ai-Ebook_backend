
const mongoose = require("mongoose");
const AIUsage = require("../models/AIUsage");
const User = require("../models/User");
const Book = require("../models/Book");

// =====================================================
// GET AI USAGE STATISTICS
// GET /api/admin/ai-usage/stats
// =====================================================

const getAIUsageStats = async (req, res) => {
  try {
    const [
      totalRequests,
      successfulRequests,
      failedRequests,
      fallbackRequests,
      providerStats,
      taskStats,
      tokenStats,
      durationStats,
      uniqueUsers,
      dailyStats,
    ] = await Promise.all([
      AIUsage.countDocuments(),

      AIUsage.countDocuments({
        status: "success",
      }),

      AIUsage.countDocuments({
        status: "failed",
      }),

      AIUsage.countDocuments({
        fallbackUsed: true,
      }),

      AIUsage.aggregate([
        {
          $group: {
            _id: "$provider",
            requests: { $sum: 1 },
            successful: {
              $sum: {
                $cond: [
                  { $eq: ["$status", "success"] },
                  1,
                  0,
                ],
              },
            },
            failed: {
              $sum: {
                $cond: [
                  { $eq: ["$status", "failed"] },
                  1,
                  0,
                ],
              },
            },
          },
        },
        {
          $sort: { requests: -1 },
        },
      ]),

      AIUsage.aggregate([
        {
          $group: {
            _id: "$taskType",
            requests: { $sum: 1 },
            successful: {
              $sum: {
                $cond: [
                  { $eq: ["$status", "success"] },
                  1,
                  0,
                ],
              },
            },
            failed: {
              $sum: {
                $cond: [
                  { $eq: ["$status", "failed"] },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),

      AIUsage.aggregate([
        {
          $group: {
            _id: null,
            promptTokens: {
              $sum: {
                $ifNull: ["$promptTokens", 0],
              },
            },
            completionTokens: {
              $sum: {
                $ifNull: ["$completionTokens", 0],
              },
            },
            recordsWithTokenData: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      {
                        $ne: ["$promptTokens", null],
                      },
                      {
                        $ne: ["$completionTokens", null],
                      },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),

      AIUsage.aggregate([
        {
          $match: {
            durationMs: { $ne: null },
          },
        },
        {
          $group: {
            _id: null,
            averageDurationMs: {
              $avg: "$durationMs",
            },
          },
        },
      ]),

      AIUsage.distinct("userId", {
        userId: { $ne: null },
      }),

      getDailyUsage(),
    ]);

    const tokenData = tokenStats[0] || {
      promptTokens: 0,
      completionTokens: 0,
      recordsWithTokenData: 0,
    };

    const averageDurationMs =
      durationStats.length > 0
        ? Math.round(
            durationStats[0].averageDurationMs
          )
        : 0;

    const successRate =
      totalRequests > 0
        ? Number(
            (
              (successfulRequests / totalRequests) *
              100
            ).toFixed(2)
          )
        : 0;

    return res.status(200).json({
      message: "AI usage statistics fetched successfully",

      statistics: {
        totalRequests,
        successfulRequests,
        failedRequests,
        fallbackRequests,
        successRate,
        uniqueUsers: uniqueUsers.length,
        averageDurationMs,
        promptTokens: tokenData.promptTokens,
        completionTokens: tokenData.completionTokens,
        totalKnownTokens:
          tokenData.promptTokens +
          tokenData.completionTokens,
        recordsWithTokenData:
          tokenData.recordsWithTokenData,
      },

      providerStats,
      taskStats,
      dailyStats,
    });
  } catch (error) {
    console.error("Get AI usage stats error:", error);

    return res.status(500).json({
      message: "Server error while fetching AI usage statistics",
    });
  }
};

// =====================================================
// HELPER: LAST 7 DAYS OF USAGE
// =====================================================

const getDailyUsage = async () => {
  const startDate = new Date();

  startDate.setHours(0, 0, 0, 0);
  startDate.setDate(startDate.getDate() - 6);

  return AIUsage.aggregate([
    {
      $match: {
        createdAt: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$createdAt",
          },
        },
        requests: { $sum: 1 },
        successful: {
          $sum: {
            $cond: [
              { $eq: ["$status", "success"] },
              1,
              0,
            ],
          },
        },
        failed: {
          $sum: {
            $cond: [
              { $eq: ["$status", "failed"] },
              1,
              0,
            ],
          },
        },
        promptTokens: {
          $sum: {
            $ifNull: ["$promptTokens", 0],
          },
        },
        completionTokens: {
          $sum: {
            $ifNull: ["$completionTokens", 0],
          },
        },
      },
    },
    {
      $sort: { _id: 1 },
    },
  ]);
};

// =====================================================
// GET AI USAGE HISTORY
// GET /api/admin/ai-usage/history
// =====================================================

const getAIUsageHistory = async (req, res) => {
  try {
    const {
      search = "",
      taskType = "all",
      status = "all",
      provider = "all",
      page = "1",
      limit = "10",
    } = req.query;

    // Validate filters.
    if (
      !["all", "outline", "chapter"].includes(taskType)
    ) {
      return res.status(400).json({
        message: "Invalid task type filter",
      });
    }

    if (
      !["all", "success", "failed"].includes(status)
    ) {
      return res.status(400).json({
        message: "Invalid status filter",
      });
    }

    if (
      !["all", "gemini", "groq", "none"].includes(provider)
    ) {
      return res.status(400).json({
        message: "Invalid provider filter",
      });
    }

    const currentPage = Math.max(
      1,
      parseInt(page, 10) || 1
    );

    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(limit, 10) || 10)
    );

    const filter = {};

    if (taskType !== "all") {
      filter.taskType = taskType;
    }

    if (status !== "all") {
      filter.status = status;
    }

    if (provider !== "all") {
      filter.provider = provider;
    }

    // Search users by name/email and books by title.
    const searchText = String(search).trim().slice(0, 100);

    if (searchText) {
      const escapedSearch = searchText.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      const searchRegex = new RegExp(
        escapedSearch,
        "i"
      );

      const [matchingUsers, matchingBooks] =
        await Promise.all([
          User.find({
            $or: [
              { fullName: searchRegex },
              { email: searchRegex },
            ],
          })
            .select("_id")
            .lean(),

          Book.find({
            title: searchRegex,
          })
            .select("_id")
            .lean(),
        ]);

      const matchingUserIds = matchingUsers.map(
        (user) => user._id
      );

      const matchingBookIds = matchingBooks.map(
        (book) => book._id
      );

      const searchConditions = [];

      if (matchingUserIds.length > 0) {
        searchConditions.push({
          userId: { $in: matchingUserIds },
        });
      }

      if (matchingBookIds.length > 0) {
        searchConditions.push({
          bookId: { $in: matchingBookIds },
        });
      }

      if (searchConditions.length === 0) {
        return res.status(200).json({
          message: "AI usage history fetched successfully",
          history: [],
          pagination: {
            currentPage,
            pageSize,
            totalRecords: 0,
            totalPages: 0,
          },
        });
      }

      filter.$or = searchConditions;
    }

    const totalRecords =
      await AIUsage.countDocuments(filter);

    const history = await AIUsage.find(filter)
      .populate("userId", "fullName email")
      .populate("bookId", "title")
      .sort({ createdAt: -1 })
      .skip((currentPage - 1) * pageSize)
      .limit(pageSize)
      .lean();

    return res.status(200).json({
      message: "AI usage history fetched successfully",
      history,
      pagination: {
        currentPage,
        pageSize,
        totalRecords,
        totalPages: Math.ceil(
          totalRecords / pageSize
        ),
      },
    });
  } catch (error) {
    console.error("Get AI usage history error:", error);

    return res.status(500).json({
      message: "Server error while fetching AI usage history",
    });
  }
};

// =====================================================
// EXPORT
// =====================================================

module.exports = {
  getAIUsageStats,
  getAIUsageHistory,
};
