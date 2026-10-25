
const mongoose = require("mongoose");
const User = require("../models/User");
const Book = require("../models/Book");
const AIUsage = require("../models/AIUsage");

// =====================================================
// ADMIN DASHBOARD
// =====================================================

const getDashboard = async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalBooks = await Book.countDocuments();

    const publicBooks = await Book.countDocuments({
      visibility: "public",
    });

    const privateBooks = await Book.countDocuments({
      visibility: "private",
    });

    const viewsResult = await Book.aggregate([
      {
        $group: {
          _id: null,
          totalViews: { $sum: "$views" },
        },
      },
    ]);

    const totalViews =
      viewsResult.length > 0 ? viewsResult[0].totalViews : 0;

    const recentUsers = await User.find()
      .select("fullName email role createdAt")
      .sort({ createdAt: -1 })
      .limit(5);

    const recentBooks = await Book.find()
      .populate("userId", "fullName email")
      .select("title topic author visibility views createdAt userId")
      .sort({ createdAt: -1 })
      .limit(5);

    return res.status(200).json({
      message: "Admin dashboard data fetched successfully",
      statistics: {
        totalUsers,
        totalBooks,
        publicBooks,
        privateBooks,
        totalViews,
      },
      recentUsers,
      recentBooks,
    });
  } catch (error) {
    console.error("Admin dashboard error:", error);
    return res.status(500).json({
      message: "Server error while fetching admin dashboard data",
    });
  }
};

// =====================================================
// GET ALL USERS
// =====================================================

const getUsers = async (req, res) => {
  try {
    const users = await User.find()
      .select("fullName email role createdAt updatedAt")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      message: "Users fetched successfully",
      users,
    });
  } catch (error) {
    console.error("Get admin users error:", error);
    return res.status(500).json({
      message: "Server error while fetching users",
    });
  }
};

// =====================================================
// DELETE USER
// =====================================================

const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user._id.toString() === req.user.userId.toString()) {
      return res.status(400).json({
        message: "You cannot delete your own admin account",
      });
    }

    await User.findByIdAndDelete(id);

    return res.status(200).json({
      message: "User deleted successfully",
    });
  } catch (error) {
    console.error("Delete user error:", error);
    return res.status(500).json({
      message: "Server error while deleting user",
    });
  }
};

// =====================================================
// CHANGE USER ROLE
// =====================================================

const changeUserRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    if (!["user", "admin"].includes(role)) {
      return res.status(400).json({
        message: "Invalid role. Role must be user or admin.",
      });
    }

    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user._id.toString() === req.user.userId.toString()) {
      return res.status(400).json({
        message: "You cannot change your own admin role",
      });
    }

    user.role = role;
    await user.save();

    return res.status(200).json({
      message: "User role updated successfully",
      user: {
        _id: user._id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Change user role error:", error);
    return res.status(500).json({
      message: "Server error while changing user role",
    });
  }
};

// =====================================================
// GET ALL BOOKS - ADMIN
// GET /api/admin/books
// =====================================================

const getAdminBooks = async (req, res) => {
  try {
    const {
      search = "",
      visibility = "all",
      page = "1",
      limit = "10",
    } = req.query;

    if (!["all", "public", "private"].includes(visibility)) {
      return res.status(400).json({
        message: "Invalid visibility filter",
      });
    }

    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(limit, 10) || 10)
    );

    const filter = {};

    if (visibility !== "all") {
      filter.visibility = visibility;
    }

    const searchText = String(search).trim();

    if (searchText) {
      const escapedSearch = searchText.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      const searchRegex = new RegExp(escapedSearch, "i");

      filter.$or = [
        { title: searchRegex },
        { topic: searchRegex },
        { author: searchRegex },
      ];
    }

    const totalBooks = await Book.countDocuments(filter);

    const books = await Book.find(filter)
      .populate("userId", "fullName email")
      .select(
        "title topic description author userId visibility numberOfChapters chapters views likes createdAt updatedAt"
      )
      .sort({ createdAt: -1 })
      .skip((currentPage - 1) * pageSize)
      .limit(pageSize);

    return res.status(200).json({
      message: "Admin books fetched successfully",
      books,
      pagination: {
        currentPage,
        pageSize,
        totalBooks,
        totalPages: Math.ceil(totalBooks / pageSize),
      },
    });
  } catch (error) {
    console.error("Get admin books error:", error);
    return res.status(500).json({
      message: "Server error while fetching books",
    });
  }
};

// =====================================================
// GET ONE BOOK WITH CHAPTERS - ADMIN
// GET /api/admin/books/:id
// =====================================================

const getAdminBookById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid book ID" });
    }

    const book = await Book.findById(id).populate(
      "userId",
      "fullName email"
    );

    if (!book) {
      return res.status(404).json({ message: "Book not found" });
    }

    return res.status(200).json({
      message: "Book details fetched successfully",
      book,
    });
  } catch (error) {
    console.error("Get admin book details error:", error);
    return res.status(500).json({
      message: "Server error while fetching book details",
    });
  }
};

// =====================================================
// CHANGE BOOK VISIBILITY - ADMIN
// PUT /api/admin/books/:id/visibility
// =====================================================

const changeBookVisibility = async (req, res) => {
  try {
    const { id } = req.params;
    const { visibility } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid book ID" });
    }

    if (!["public", "private"].includes(visibility)) {
      return res.status(400).json({
        message: "Visibility must be public or private",
      });
    }

    const book = await Book.findById(id);

    if (!book) {
      return res.status(404).json({ message: "Book not found" });
    }

    book.visibility = visibility;
    await book.save();

    return res.status(200).json({
      message: `Book visibility changed to ${visibility}`,
      book: {
        _id: book._id,
        title: book.title,
        visibility: book.visibility,
      },
    });
  } catch (error) {
    console.error("Change book visibility error:", error);
    return res.status(500).json({
      message: "Server error while changing book visibility",
    });
  }
};

// =====================================================
// DELETE BOOK - ADMIN
// DELETE /api/admin/books/:id
// =====================================================

const deleteAdminBook = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid book ID" });
    }

    const book = await Book.findById(id);

    if (!book) {
      return res.status(404).json({ message: "Book not found" });
    }

    await Book.findByIdAndDelete(id);

    return res.status(200).json({
      message: "Book deleted successfully",
      deletedBook: {
        _id: book._id,
        title: book.title,
      },
    });
  } catch (error) {
    console.error("Delete admin book error:", error);
    return res.status(500).json({
      message: "Server error while deleting book",
    });
  }
};


const getAdminAnalytics = async (req, res) => {
  try {
    const { range = "6m" } = req.query;

    const allowedRanges = ["7d", "30d", "6m", "12m"];

    if (!allowedRanges.includes(range)) {
      return res.status(400).json({
        message: "Invalid analytics range",
      });
    }

    const now = new Date();
    let startDate;
    let groupFormat;
    let bucketCount;

    if (range === "7d" || range === "30d") {
      bucketCount = range === "7d" ? 7 : 30;

      startDate = new Date(now);
      startDate.setUTCHours(0, 0, 0, 0);
      startDate.setUTCDate(
        startDate.getUTCDate() - (bucketCount - 1)
      );

      groupFormat = "%Y-%m-%d";
    } else {
      bucketCount = range === "6m" ? 6 : 12;

      startDate = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth() - (bucketCount - 1),
          1
        )
      );

      groupFormat = "%Y-%m";
    }

    const totalUsers = await User.countDocuments();
    const totalBooks = await Book.countDocuments();

    const [
      totalViewsResult,
      publicBooks,
      privateBooks,
      usersCreated,
      booksCreated,
      aiGenerations,
      aiGenerationsInRange,
      topBooks,
      activeUserGroups,
      todayBooks,
      todayAI,
    ] = await Promise.all([
      Book.aggregate([
        {
          $group: {
            _id: null,
            totalViews: { $sum: "$views" },
          },
        },
      ]),

      Book.countDocuments({ visibility: "public" }),
      Book.countDocuments({ visibility: "private" }),

      User.aggregate([
        { $match: { createdAt: { $gte: startDate, $lte: now } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: groupFormat,
                date: "$createdAt",
                timezone: "UTC",
              },
            },
            count: { $sum: 1 },
          },
        },
      ]),

      Book.aggregate([
        { $match: { createdAt: { $gte: startDate, $lte: now } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: groupFormat,
                date: "$createdAt",
                timezone: "UTC",
              },
            },
            count: { $sum: 1 },
            views: { $sum: "$views" },
          },
        },
      ]),

      AIUsage.countDocuments(),

      AIUsage.countDocuments({
        createdAt: { $gte: startDate, $lte: now },
      }),

      Book.find()
        .select("title author views chapters numberOfChapters")
        .sort({ views: -1 })
        .limit(5)
        .lean(),

      AIUsage.aggregate([
        {
          $match: {
            userId: { $ne: null },
            createdAt: { $gte: startDate, $lte: now },
          },
        },
        {
          $group: {
            _id: "$userId",
            generations: { $sum: 1 },
          },
        },
        { $sort: { generations: -1 } },
        { $limit: 5 },
      ]),

      Book.countDocuments({
        createdAt: {
          $gte: new Date(
            Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth(),
              now.getUTCDate()
            )
          ),
          $lte: now,
        },
      }),

      AIUsage.countDocuments({
        createdAt: {
          $gte: new Date(
            Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth(),
              now.getUTCDate()
            )
          ),
          $lte: now,
        },
      }),
    ]);

    // Build buckets so dates without activity appear as zero.
    const buckets = [];

    for (let i = 0; i < bucketCount; i++) {
      const date = new Date(startDate);

      if (range === "7d" || range === "30d") {
        date.setUTCDate(date.getUTCDate() + i);
        buckets.push(date.toISOString().slice(0, 10));
      } else {
        date.setUTCMonth(date.getUTCMonth() + i);
        buckets.push(date.toISOString().slice(0, 7));
      }
    }

    const userMap = new Map(
      usersCreated.map((item) => [item._id, item.count])
    );

    const bookMap = new Map(
      booksCreated.map((item) => [item._id, item])
    );

    const userGrowth = buckets.map((date) => ({
      date,
      users: userMap.get(date) || 0,
    }));

    const ebookGrowth = buckets.map((date) => ({
      date,
      books: bookMap.get(date)?.count || 0,
    }));

    const viewsByBookCreation = buckets.map((date) => ({
      date,
      views: bookMap.get(date)?.views || 0,
    }));

    const userIds = activeUserGroups.map((item) => item._id);

    const activeUserRecords = await User.find({
      _id: { $in: userIds },
    })
      .select("fullName email")
      .lean();

    const userMapById = new Map(
      activeUserRecords.map((user) => [
        user._id.toString(),
        user,
      ])
    );

    const activeUsers = activeUserGroups.map((item) => {
      const user = userMapById.get(item._id.toString());

      return {
        userId: item._id,
        name: user?.fullName || "Unknown user",
        email: user?.email || "",
        generations: item.generations,
      };
    });

    return res.status(200).json({
      message: "Analytics fetched successfully",

      range,

      statistics: {
        totalUsers,
        totalBooks,
        totalViews: totalViewsResult[0]?.totalViews || 0,
        totalAIGenerations: aiGenerations,
        aiGenerationsInRange,
        publicBooks,
        privateBooks,
      },

      userGrowth,
      ebookGrowth,
      viewsByBookCreation,

      visibilityStats: [
        { name: "Public", books: publicBooks },
        { name: "Private", books: privateBooks },
      ],

      topBooks: topBooks.map((book) => ({
        _id: book._id,
        title: book.title,
        author: book.author,
        views: book.views || 0,
        chapters:
          book.chapters?.length || book.numberOfChapters || 0,
      })),

      activeUsers,

      activity: {
        booksCreatedToday: todayBooks,
        aiGenerationsToday: todayAI,
      },
    });
  } catch (error) {
    console.error("Admin analytics error:", error);

    return res.status(500).json({
      message: "Server error while fetching analytics",
    });
  }
};



// =====================================================
// EXPORT CONTROLLERS
// =====================================================

module.exports = {
  getDashboard,
  getUsers,
  deleteUser,
  changeUserRole,
  getAdminBooks,
  getAdminBookById,
  changeBookVisibility,
  deleteAdminBook,
  getAdminAnalytics,
};
