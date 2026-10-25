
const Book = require("../models/Book");
const User = require("../models/User");

// =====================================================
// CREATE BOOK
// POST /api/books
// =====================================================
const createBook = async (req, res) => {
  try {
    const {
      title,
      topic,
      description,
      targetAudience,
      numberOfChapters,
      writingStyle,
      visibility,
      chapters,
    } = req.body;

    // Validate required fields
    if (
      !title ||
      !topic ||
      !targetAudience ||
      !numberOfChapters ||
      !writingStyle
    ) {
      return res.status(400).json({
        message:
          "Title, topic, target audience, number of chapters and writing style are required",
      });
    }

    // Get logged-in user
    const user = await User.findById(req.user.userId);

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    // Create book
    const book = await Book.create({
      title,
      topic,
      description: description || "",
      targetAudience,
      numberOfChapters,
      writingStyle,
      author: user.fullName,
      userId: user._id,
      visibility: visibility === "public" ? "public" : "private",
      chapters: Array.isArray(chapters) ? chapters : [],
    });

    res.status(201).json({
      message: "Book created successfully",
      book,
    });
  } catch (error) {
    console.error("Create book error:", error);

    res.status(500).json({
      message: "Server error while creating book",
    });
  }
};

// =====================================================
// GET MY BOOKS
// GET /api/books/my
// =====================================================
const getMyBooks = async (req, res) => {
  try {
    const books = await Book.find({
      userId: req.user.userId,
    }).sort({
      updatedAt: -1,
    });

    res.status(200).json({
      books,
    });
  } catch (error) {
    console.error("Get my books error:", error);

    res.status(500).json({
      message: "Server error while fetching your books",
    });
  }
};

// =====================================================
// GET PUBLIC BOOKS
// GET /api/books/public
// =====================================================
const getPublicBooks = async (req, res) => {
  try {
    const books = await Book.find({
      visibility: "public",
    })
      .sort({
        createdAt: -1,
      })
      .populate("userId", "fullName");

    res.status(200).json({
      books,
    });
  } catch (error) {
    console.error("Get public books error:", error);

    res.status(500).json({
      message: "Server error while fetching public books",
    });
  }
};

// =====================================================
// GET SINGLE BOOK
// GET /api/books/:id
// =====================================================
// =====================================================
// GET SINGLE BOOK
// GET /api/books/:id
// =====================================================
const getBookById = async (req, res) => {
  try {
    const { id } = req.params;

    // First get the book WITHOUT populate
    const book = await Book.findById(id);

    if (!book) {
      return res.status(404).json({
        message: "Book not found",
      });
    }

    const ownerId = book.userId.toString();
    const currentUserId = req.user.userId.toString();
    

    // Private books can only be viewed by their owner
    if (
      book.visibility === "private" &&
      ownerId !== currentUserId
    ) {
      return res.status(403).json({
        message: "You do not have permission to view this book",
      });
    }

    // Increase views only when another user reads a PUBLIC book
    if (
  book.visibility === "public" &&
  ownerId !== currentUserId
) {
  console.log("INCREMENTING VIEW COUNT...");

  const updatedBook = await Book.findByIdAndUpdate(
    id,
    {
      $inc: { views: 1 },
    },
    {
      returnDocument: "after",
    }
  );

  console.log(
    "VIEW COUNT AFTER UPDATE:",
    updatedBook.views
  );
}

    // Fetch the latest version of the book
    const updatedBook = await Book.findById(id)
      .populate("userId", "fullName email");

    return res.status(200).json({
      message: "Book fetched successfully",
      book: updatedBook,
    });

  } catch (error) {
    console.error("Get book error:", error);

    return res.status(500).json({
      message: "Server error while fetching book",
    });
  }
};

// =====================================================
// UPDATE BOOK
// PUT /api/books/:id
// =====================================================
const updateBook = async (req, res) => {
  try {
    const { id } = req.params;

    const book = await Book.findById(id);

    if (!book) {
      return res.status(404).json({
        message: "Book not found",
      });
    }

    // Only owner can update
    if (book.userId.toString() !== req.user.userId) {
      return res.status(403).json({
        message: "You are not allowed to update this book",
      });
    }

    const {
      title,
      topic,
      description,
      targetAudience,
      numberOfChapters,
      writingStyle,
      visibility,
      chapters,
    } = req.body;

    // Update only fields that were provided
    if (title !== undefined) {
      book.title = title;
    }

    if (topic !== undefined) {
      book.topic = topic;
    }

    if (description !== undefined) {
      book.description = description;
    }

    if (targetAudience !== undefined) {
      book.targetAudience = targetAudience;
    }

    if (numberOfChapters !== undefined) {
      book.numberOfChapters = numberOfChapters;
    }

    if (writingStyle !== undefined) {
      book.writingStyle = writingStyle;
    }

    if (visibility !== undefined) {
      book.visibility =
        visibility === "public" ? "public" : "private";
    }

    if (chapters !== undefined && Array.isArray(chapters)) {
      book.chapters = chapters;
    }

    const updatedBook = await book.save();

    res.status(200).json({
      message: "Book updated successfully",
      book: updatedBook,
    });
  } catch (error) {
    console.error("Update book error:", error);

    res.status(500).json({
      message: "Server error while updating book",
    });
  }
};

// =====================================================
// DELETE BOOK
// DELETE /api/books/:id
// =====================================================
const deleteBook = async (req, res) => {
  try {
    const { id } = req.params;

    const book = await Book.findById(id);

    if (!book) {
      return res.status(404).json({
        message: "Book not found",
      });
    }

    // Only owner can delete
    if (book.userId.toString() !== req.user.userId) {
      return res.status(403).json({
        message: "You are not allowed to delete this book",
      });
    }

    await Book.findByIdAndDelete(id);

    res.status(200).json({
      message: "Book deleted successfully",
    });
  } catch (error) {
    console.error("Delete book error:", error);

    res.status(500).json({
      message: "Server error while deleting book",
    });
  }
};

module.exports = {
  createBook,
  getMyBooks,
  getPublicBooks,
  getBookById,
  updateBook,
  deleteBook,
};

