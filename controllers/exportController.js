const Book = require("../models/Book");
const PDFDocument = require("pdfkit");

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  PageBreak,
} = require("docx");

// ==================================================
// Helper: Get book and check permission
// ==================================================

const getBookForExport = async (bookId, userId) => {
  const book = await Book.findById(bookId);

  if (!book) {
    const error = new Error("Book not found");
    error.statusCode = 404;
    throw error;
  }

  // Private books can only be exported by their owner.
  // Public books can be exported by authenticated users.
  if (
    book.visibility === "private" &&
    book.userId.toString() !== userId
  ) {
    const error = new Error(
      "You are not allowed to export this book"
    );

    error.statusCode = 403;
    throw error;
  }

  return book;
};

// ==================================================
// Helper: Safe filename
// ==================================================

const safeFileName = (title) => {
  return (title || "ebook")
    .replace(/[^a-z0-9\s-_]/gi, "")
    .trim()
    .replace(/\s+/g, "-")
    .substring(0, 100) || "ebook";
};

// ==================================================
// EXPORT PDF
// ==================================================

const exportPDF = async (req, res) => {
  try {
    const { id } = req.params;

    const book = await getBookForExport(
      id,
      req.user.userId
    );

    const fileName = `${safeFileName(book.title)}.pdf`;

    res.setHeader(
      "Content-Type",
      "application/pdf"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`
    );

    const pdf = new PDFDocument({
      size: "A4",
      margins: {
        top: 60,
        bottom: 60,
        left: 60,
        right: 60,
      },
      info: {
        Title: book.title,
        Author: book.author,
        Subject: book.description || book.topic,
      },
    });

    // Send PDF directly to browser
    pdf.pipe(res);

    // ==================================================
    // COVER
    // ==================================================

    pdf
      .fontSize(32)
      .font("Helvetica-Bold")
      .text(book.title, {
        align: "center",
      });

    pdf.moveDown(1);

    pdf
      .fontSize(16)
      .font("Helvetica")
      .text(
        book.description ||
          "An AI generated eBook created using AI eBook Creator.",
        {
          align: "center",
        }
      );

    pdf.moveDown(3);

    pdf
      .fontSize(14)
      .text(`Written by ${book.author}`, {
        align: "center",
      });

    pdf.moveDown(0.5);

    pdf
      .fontSize(12)
      .fillColor("#666666")
      .text(
        book.createdAt
          ? new Date(book.createdAt).getFullYear().toString()
          : new Date().getFullYear().toString(),
        {
          align: "center",
        }
      );

    pdf.fillColor("#000000");

    // ==================================================
    // TABLE OF CONTENTS
    // ==================================================

    pdf.addPage();

    pdf
      .fontSize(24)
      .font("Helvetica-Bold")
      .text("Table of Contents");

    pdf.moveDown(1);

    (book.chapters || []).forEach((chapter, index) => {
      pdf
        .fontSize(13)
        .font("Helvetica")
        .text(
          `${index + 1}. ${chapter.title || `Chapter ${index + 1}`}`
        );

      pdf.moveDown(0.5);
    });

    // ==================================================
    // CHAPTERS
    // ==================================================

    (book.chapters || []).forEach((chapter, index) => {
      pdf.addPage();

      pdf
        .fontSize(12)
        .font("Helvetica-Bold")
        .fillColor("#6d28d9")
        .text(
          `CHAPTER ${String(index + 1).padStart(2, "0")}`
        );

      pdf.moveDown(0.7);

      pdf
        .fontSize(24)
        .font("Helvetica-Bold")
        .fillColor("#000000")
        .text(
          chapter.title ||
            `Chapter ${index + 1}`
        );

      pdf.moveDown(1);

      const content = chapter.content || "";

      const paragraphs = content.split(/\n\s*\n/);

      paragraphs.forEach((paragraph) => {
        const cleanedParagraph = paragraph
          .replace(/^#+\s*/gm, "")
          .trim();

        if (!cleanedParagraph) {
          return;
        }

        pdf
          .fontSize(12)
          .font("Helvetica")
          .fillColor("#333333")
          .text(cleanedParagraph, {
            align: "left",
            lineGap: 5,
          });

        pdf.moveDown(0.8);
      });
    });

    // ==================================================
    // END
    // ==================================================

    pdf.addPage();

    pdf
      .fontSize(20)
      .font("Helvetica-Bold")
      .fillColor("#000000")
      .text("End of the Book", {
        align: "center",
      });

    pdf.moveDown(1);

    pdf
      .fontSize(12)
      .font("Helvetica")
      .fillColor("#666666")
      .text("Thank you for reading.", {
        align: "center",
      });

    pdf.end();
  } catch (error) {
    console.error("PDF export error:", error);

    if (!res.headersSent) {
      res.status(error.statusCode || 500).json({
        message:
          error.message ||
          "Failed to export PDF",
      });
    }
  }
};

// ==================================================
// EXPORT DOCX
// ==================================================

const exportDOCX = async (req, res) => {
  try {
    const { id } = req.params;

    const book = await getBookForExport(
      id,
      req.user.userId
    );

    const fileName = `${safeFileName(book.title)}.docx`;

    // ==================================================
    // Document content
    // ==================================================

    const children = [];

    // --------------------------------------------------
    // Title
    // --------------------------------------------------

    children.push(
      new Paragraph({
        text: book.title,
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: {
          after: 300,
        },
      })
    );

    // --------------------------------------------------
    // Description
    // --------------------------------------------------

    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text:
              book.description ||
              "An AI generated eBook created using AI eBook Creator.",
            italics: true,
            size: 24,
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: {
          after: 300,
        },
      })
    );

    // --------------------------------------------------
    // Author
    // --------------------------------------------------

    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Written by ${book.author}`,
            bold: true,
            size: 24,
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: {
          after: 500,
        },
      })
    );

    // --------------------------------------------------
    // Page break
    // --------------------------------------------------

    children.push(
      new Paragraph({
        children: [
          new PageBreak(),
        ],
      })
    );

    // ==================================================
    // TABLE OF CONTENTS
    // ==================================================

    children.push(
      new Paragraph({
        text: "Table of Contents",
        heading: HeadingLevel.HEADING_1,
        spacing: {
          after: 300,
        },
      })
    );

    (book.chapters || []).forEach(
      (chapter, index) => {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `${index + 1}. ${
                  chapter.title ||
                  `Chapter ${index + 1}`
                }`,
                size: 24,
              }),
            ],
            spacing: {
              after: 150,
            },
          })
        );
      }
    );

    // --------------------------------------------------
    // Page break
    // --------------------------------------------------

    children.push(
      new Paragraph({
        children: [
          new PageBreak(),
        ],
      })
    );

    // ==================================================
    // CHAPTERS
    // ==================================================

    (book.chapters || []).forEach(
      (chapter, index) => {
        children.push(
          new Paragraph({
            text: `Chapter ${String(
              index + 1
            ).padStart(2, "0")}`,
            heading: HeadingLevel.HEADING_2,
            spacing: {
              after: 150,
            },
          })
        );

        children.push(
          new Paragraph({
            text:
              chapter.title ||
              `Chapter ${index + 1}`,
            heading: HeadingLevel.HEADING_1,
            spacing: {
              after: 300,
            },
          })
        );

        const content = chapter.content || "";

        const paragraphs = content.split(
          /\n\s*\n/
        );

        paragraphs.forEach((paragraph) => {
          const cleanedParagraph = paragraph
            .replace(/^#+\s*/gm, "")
            .trim();

          if (!cleanedParagraph) {
            return;
          }

          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: cleanedParagraph,
                  size: 24,
                }),
              ],
              spacing: {
                after: 250,
                line: 320,
              },
            })
          );
        });

        // Page break between chapters
        if (
          index <
          (book.chapters || []).length - 1
        ) {
          children.push(
            new Paragraph({
              children: [
                new PageBreak(),
              ],
            })
          );
        }
      }
    );

    // ==================================================
    // Create DOCX
    // ==================================================

    const document = new Document({
      sections: [
        {
          properties: {},
          children,
        },
      ],
      creator: "AI eBook Creator",
      title: book.title,
      description:
        book.description || book.topic,
      subject: book.topic,
      author: book.author,
    });

    const buffer =
      await Packer.toBuffer(document);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`
    );

    res.send(buffer);
  } catch (error) {
    console.error("DOCX export error:", error);

    if (!res.headersSent) {
      res.status(error.statusCode || 500).json({
        message:
          error.message ||
          "Failed to export DOCX",
      });
    }
  }
};

module.exports = {
  exportPDF,
  exportDOCX,
};