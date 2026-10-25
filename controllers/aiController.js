
const { GoogleGenAI } = require("@google/genai");
const Groq = require("groq-sdk");
const mongoose = require("mongoose");
const AIUsage = require("../models/AIUsage");
const PlatformSettings = require("../models/PlatformSettings");

// ====================================================
// AI CLIENTS
// ====================================================

const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const GROQ_MODEL = "openai/gpt-oss-120b";
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

// ====================================================
// GET ADMIN AI SETTINGS
// ====================================================

const getAISettings = async () => {
  const saved = await PlatformSettings.findOne({
    key: "global",
  }).lean();

  const configuredModel = String(
    saved?.aiModel || ""
  ).trim();

  // Admin dropdown labels are not necessarily API model IDs.
  const geminiModel =
    configuredModel.toLowerCase().startsWith("gemini-")
      ? configuredModel
      : DEFAULT_GEMINI_MODEL;

  return {
    enableAI: saved?.enableAI !== false,
    geminiModel,

    maxTokens: Math.min(
      10000,
      Math.max(100, Number(saved?.maxTokens) || 3000)
    ),

    temperature: Math.min(
      2,
      Math.max(0, Number(saved?.temperature ?? 0.7))
    ),

    chapterWordLimit: Math.min(
      5000,
      Math.max(
        100,
        Number(saved?.chapterWordLimit) || 700
      )
    ),
  };
};

// ====================================================
// CHECK WHETHER GROQ FALLBACK IS REQUIRED
// ====================================================

const shouldUseGroq = (error) => {
  const status =
    error?.status ||
    error?.statusCode ||
    error?.response?.status;

  const code = error?.code;

  const message = String(
    error?.message || ""
  ).toLowerCase();

  return (
    Number(status) === 429 ||
    Number(code) === 429 ||
    Number(status) === 503 ||
    Number(code) === 503 ||
    message.includes("429") ||
    message.includes("503") ||
    message.includes("resource_exhausted") ||
    message.includes("quota exceeded") ||
    message.includes("unavailable") ||
    message.includes("high demand") ||
    message.includes("overloaded")
  );
};

// ====================================================
// RETRY GEMINI FOR TEMPORARY 503 ERRORS
// ====================================================

const executeWithGeminiRetry = async (
  apiCall,
  maxRetries = 3
) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await apiCall();
    } catch (error) {
      const status =
        error?.status ||
        error?.statusCode ||
        error?.response?.status;

      const code = error?.code;

      const message = String(
        error?.message || ""
      ).toLowerCase();

      const is429 =
        Number(status) === 429 ||
        Number(code) === 429 ||
        message.includes("429") ||
        message.includes("resource_exhausted") ||
        message.includes("quota exceeded");

      const is503 =
        Number(status) === 503 ||
        Number(code) === 503 ||
        message.includes("503") ||
        message.includes("unavailable") ||
        message.includes("high demand") ||
        message.includes("overloaded");

      // Do not waste time retrying quota errors.
      if (is429) {
        console.log(
          "⚠️ Gemini quota/rate limit reached."
        );
        throw error;
      }

      // Retry temporary availability errors.
      if (is503 && attempt < maxRetries) {
        const delay = attempt * 2000;

        console.log(
          `⚠️ Gemini attempt ${attempt}/${maxRetries} failed.`
        );

        console.log(
          `🔄 Retrying Gemini in ${delay / 1000} seconds...`
        );

        await new Promise((resolve) =>
          setTimeout(resolve, delay)
        );

        continue;
      }

      throw error;
    }
  }

  throw new Error(
    "Gemini failed after maximum retry attempts."
  );
};

// ====================================================
// CLEAN JSON RETURNED BY AI
// ====================================================

const cleanJsonString = (text) => {
  if (!text) return text;

  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
};

// ====================================================
// RECORD AI USAGE
// ====================================================

const recordAIUsage = async ({
  req,
  taskType,
  provider,
  model = null,
  status,
  fallbackUsed = false,
  startedAt,
  usage = null,
  errorMessage = null,
}) => {
  try {
    const rawUserId =
      req.user?.userId ||
      req.user?.id ||
      req.user?._id ||
      null;

    const rawBookId = req.body?.bookId || null;

    const userId =
      rawUserId &&
      mongoose.isValidObjectId(rawUserId)
        ? rawUserId
        : null;

    const bookId =
      rawBookId &&
      mongoose.isValidObjectId(rawBookId)
        ? rawBookId
        : null;

    await AIUsage.create({
      userId,
      bookId,
      taskType,
      provider,
      model,
      status,
      fallbackUsed,

      durationMs:
        typeof startedAt === "number"
          ? Math.max(0, Date.now() - startedAt)
          : null,

      promptTokens:
        usage?.promptTokenCount ??
        usage?.prompt_tokens ??
        null,

      completionTokens:
        usage?.candidatesTokenCount ??
        usage?.completion_tokens ??
        null,

      errorMessage: errorMessage
        ? String(errorMessage).slice(0, 1000)
        : null,
    });
  } catch (error) {
    // Logging errors must not stop generation.
    console.error(
      "⚠️ Failed to record AI usage:",
      error.message
    );
  }
};

// ====================================================
// GROQ: GENERATE CHAPTER
// ====================================================

const generateChapterWithGroq = async ({
  aiSettings,
  title,
  topic,
  description,
  targetAudience,
  numberOfChapters,
  writingStyle,
  chapterTitle,
}) => {
  console.log("🤖 Provider: Groq");
  console.log("📖 Generating chapter with Groq...");

  const prompt = `
You are an expert educational eBook writer.

BOOK TITLE:
${title}

TOPIC:
${topic}

DESCRIPTION:
${description || "No additional description provided"}

TARGET AUDIENCE:
${targetAudience}

TOTAL CHAPTERS:
${numberOfChapters}

WRITING STYLE:
${writingStyle}

CURRENT CHAPTER:
${chapterTitle}

Write the complete content for this chapter.

Requirements:
1. Write original and informative content.
2. Match the target audience and writing style.
3. Begin with a Markdown H1 heading containing the chapter title.
4. Use Markdown H2 headings for sections.
5. Include examples and lists where useful.
6. Maintain logical flow.
7. Do not write other chapters.
8. Do not include commentary about being an AI.
9. Return only the chapter content in Markdown.
10. Aim for approximately ${aiSettings.chapterWordLimit} words.
`;

  const response = await groq.chat.completions.create({
    model: GROQ_MODEL,

    messages: [
      {
        role: "system",
        content:
          "You are an expert educational eBook writer. Return only the requested chapter content.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],

    max_completion_tokens: aiSettings.maxTokens,
    temperature: aiSettings.temperature,
  });

  const content =
    response.choices?.[0]?.message?.content;

  if (!content || !content.trim()) {
    throw new Error(
      "Groq did not return chapter content."
    );
  }

  return content.trim();
};

// ====================================================
// GROQ: GENERATE BOOK OUTLINE
// ====================================================

const generateOutlineWithGroq = async ({
  aiSettings,
  title,
  topic,
  description,
  targetAudience,
  numberOfChapters,
  writingStyle,
}) => {
  console.log("🤖 Provider: Groq");
  console.log("📚 Generating book outline with Groq...");

  const chapterCount = Number(numberOfChapters);

  if (
    !Number.isInteger(chapterCount) ||
    chapterCount < 1
  ) {
    throw new Error("Invalid number of chapters.");
  }

  const prompt = `
You are an expert eBook planner.

Create an outline for this book.

TITLE:
${title}

TOPIC:
${topic}

DESCRIPTION:
${description || "No description provided"}

TARGET AUDIENCE:
${targetAudience}

WRITING STYLE:
${writingStyle}

Create EXACTLY ${chapterCount} chapters.

Every chapter must have both:
- title
- description

Chapters should follow a logical progression.
The first chapter should introduce the topic.
The final chapter should provide an appropriate conclusion.

Return ONLY valid JSON in this structure:

{
  "chapters": [
    {
      "title": "Chapter title",
      "description": "What the chapter covers"
    }
  ]
}

Do not include Markdown or explanations.
`;

  // JSON schema uses a fixed structure and requires both fields.
  const response = await groq.chat.completions.create({
    model: GROQ_MODEL,

    messages: [
      {
        role: "system",
        content:
          "You are an expert eBook planner. Return a valid JSON object. Every chapter must have a title and description.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],

    response_format: {
      type: "json_schema",
      json_schema: {
        name: "ebook_outline",
        strict: true,
        schema: {
          type: "object",
          properties: {
            chapters: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: {
                    type: "string",
                  },
                  description: {
                    type: "string",
                  },
                },
                required: ["title", "description"],
                additionalProperties: false,
              },
            },
          },
          required: ["chapters"],
          additionalProperties: false,
        },
      },
    },

    max_completion_tokens: aiSettings.maxTokens,
    temperature: aiSettings.temperature,
  });

  const generatedText =
    response.choices?.[0]?.message?.content;

  if (!generatedText) {
    throw new Error(
      "Groq did not return an outline."
    );
  }

  let outline;

  try {
    outline = JSON.parse(
      cleanJsonString(generatedText)
    );
  } catch (error) {
    console.error(
      "Groq returned invalid JSON:",
      generatedText
    );

    throw new Error(
      "Groq returned invalid outline JSON."
    );
  }

  if (
    !outline ||
    !Array.isArray(outline.chapters)
  ) {
    throw new Error(
      "Groq returned an invalid outline structure."
    );
  }

  if (outline.chapters.length !== chapterCount) {
    throw new Error(
      `Groq returned ${outline.chapters.length} chapters instead of ${chapterCount}.`
    );
  }

  outline.chapters.forEach((chapter, index) => {
    if (
      !chapter ||
      typeof chapter.title !== "string" ||
      !chapter.title.trim() ||
      typeof chapter.description !== "string" ||
      !chapter.description.trim()
    ) {
      throw new Error(
        `Groq chapter ${index + 1} is missing a title or description.`
      );
    }
  });

  return outline;
};

// ====================================================
// GENERATE BOOK CHAPTER
// ====================================================

const generateBookContent = async (req, res) => {
  const startedAt = Date.now();
  let aiSettings;

  try {
    console.log("\n====================================");
    console.log("🚀 CHAPTER GENERATION STARTED");
    console.log("====================================");

    aiSettings = await getAISettings();

    if (!aiSettings.enableAI) {
      console.log("⚠️ AI generation is disabled by admin.");

      return res.status(503).json({
        message:
          "AI generation is currently disabled by the administrator.",
      });
    }

    const {
      title,
      topic,
      description,
      targetAudience,
      numberOfChapters,
      writingStyle,
      chapterTitle,
    } = req.body;

    if (
      !title ||
      !topic ||
      !targetAudience ||
      !numberOfChapters ||
      !writingStyle ||
      !chapterTitle
    ) {
      return res.status(400).json({
        message:
          "Title, topic, target audience, number of chapters, writing style and chapter title are required.",
      });
    }

    console.log("📖 Chapter:", chapterTitle);
    console.log(
      "📝 Target word count:",
      aiSettings.chapterWordLimit
    );

    const prompt = `
You are an expert educational eBook writer.

BOOK TITLE:
${title}

TOPIC:
${topic}

DESCRIPTION:
${description || "No additional description provided"}

TARGET AUDIENCE:
${targetAudience}

TOTAL CHAPTERS:
${numberOfChapters}

WRITING STYLE:
${writingStyle}

CURRENT CHAPTER:
${chapterTitle}

Write the complete chapter.

Requirements:
1. Write original and informative content.
2. Match the target audience and writing style.
3. Start with a Markdown H1 heading containing the chapter title.
4. Use Markdown H2 headings for sections.
5. Include examples and lists where useful.
6. Do not write content for other chapters.
7. Do not include commentary about being an AI.
8. Return only the chapter content in Markdown.

Aim for approximately ${aiSettings.chapterWordLimit} words.
`;

    // --------------------------------------------
    // TRY GEMINI FIRST
    // --------------------------------------------

    try {
      console.log(
        `🔄 Trying Gemini (${aiSettings.geminiModel})...`
      );

      const response = await executeWithGeminiRetry(
        () =>
          gemini.models.generateContent({
            model: aiSettings.geminiModel,
            contents: prompt,
            config: {
              maxOutputTokens: aiSettings.maxTokens,
              temperature: aiSettings.temperature,
            },
          }),
        3
      );

      const generatedContent = response.text;

      if (
        !generatedContent ||
        !generatedContent.trim()
      ) {
        throw new Error(
          "Gemini did not return chapter content."
        );
      }

      const wordCount = generatedContent
        .trim()
        .split(/\s+/).length;

      console.log("\n✅ CHAPTER GENERATED SUCCESSFULLY");
      console.log("🤖 Provider: Gemini");
      console.log("📖 Chapter:", chapterTitle);
      console.log("📝 Word count:", wordCount);
      console.log(
        "⏱️ Duration:",
        `${((Date.now() - startedAt) / 1000).toFixed(2)} seconds`
      );
      console.log("====================================\n");

      await recordAIUsage({
        req,
        taskType: "chapter",
        provider: "gemini",
        model: aiSettings.geminiModel,
        status: "success",
        fallbackUsed: false,
        startedAt,
        usage: response.usageMetadata,
      });

      return res.status(200).json({
        message: "Chapter generated successfully",
        content: generatedContent,
        provider: "gemini",
      });
    } catch (geminiError) {
      console.error(
        "❌ Gemini chapter generation failed:",
        geminiError.message
      );

      if (!shouldUseGroq(geminiError)) {
        await recordAIUsage({
          req,
          taskType: "chapter",
          provider: "none",
          model: aiSettings.geminiModel,
          status: "failed",
          fallbackUsed: false,
          startedAt,
          errorMessage: geminiError.message,
        });

        return res.status(500).json({
          message: "Failed to generate chapter with Gemini.",
        });
      }

      // --------------------------------------------
      // FALL BACK TO GROQ
      // --------------------------------------------

      console.log("🔁 Gemini failed. Switching to Groq...");

      try {
        const groqContent = await generateChapterWithGroq({
          aiSettings,
          title,
          topic,
          description,
          targetAudience,
          numberOfChapters,
          writingStyle,
          chapterTitle,
        });

        const wordCount = groqContent
          .trim()
          .split(/\s+/).length;

        console.log("\n✅ CHAPTER GENERATED SUCCESSFULLY");
        console.log("🤖 Provider: Groq (fallback)");
        console.log("📖 Chapter:", chapterTitle);
        console.log("📝 Word count:", wordCount);
        console.log(
          "⏱️ Duration:",
          `${((Date.now() - startedAt) / 1000).toFixed(2)} seconds`
        );
        console.log("====================================\n");

        await recordAIUsage({
          req,
          taskType: "chapter",
          provider: "groq",
          model: GROQ_MODEL,
          status: "success",
          fallbackUsed: true,
          startedAt,
        });

        return res.status(200).json({
          message:
            "Chapter generated successfully using Groq fallback",
          content: groqContent,
          provider: "groq",
        });
      } catch (groqError) {
        console.error(
          "❌ Groq chapter generation failed:",
          groqError.message
        );

        await recordAIUsage({
          req,
          taskType: "chapter",
          provider: "none",
          model: GROQ_MODEL,
          status: "failed",
          fallbackUsed: true,
          startedAt,
          errorMessage: groqError.message,
        });

        return res.status(502).json({
          message:
            "Both Gemini and Groq failed to generate the chapter. Please try again later.",
        });
      }
    }
  } catch (error) {
    console.error(
      "❌ Chapter controller error:",
      error.message
    );

    await recordAIUsage({
      req,
      taskType: "chapter",
      provider: "none",
      status: "failed",
      fallbackUsed: false,
      startedAt,
      errorMessage: error.message,
    });

    return res.status(500).json({
      message:
        "Server error while generating chapter.",
    });
  }
};

// ====================================================
// GENERATE BOOK OUTLINE
// ====================================================

const generateBookOutline = async (req, res) => {
  const startedAt = Date.now();
  let aiSettings;

  try {
    console.log("\n====================================");
    console.log("🚀 BOOK OUTLINE GENERATION STARTED");
    console.log("====================================");

    aiSettings = await getAISettings();

    if (!aiSettings.enableAI) {
      console.log("⚠️ AI generation is disabled by admin.");

      return res.status(503).json({
        message:
          "AI generation is currently disabled by the administrator.",
      });
    }

    const {
      title,
      topic,
      description,
      targetAudience,
      numberOfChapters,
      writingStyle,
    } = req.body;

    if (
      !title ||
      !topic ||
      !targetAudience ||
      !numberOfChapters ||
      !writingStyle
    ) {
      return res.status(400).json({
        message:
          "Title, topic, target audience, number of chapters and writing style are required.",
      });
    }

    const chapterCount = Number(numberOfChapters);

    if (
      !Number.isInteger(chapterCount) ||
      chapterCount < 1
    ) {
      return res.status(400).json({
        message:
          "Number of chapters must be a positive integer.",
      });
    }

    console.log("📚 Book:", title);
    console.log("📑 Requested chapters:", chapterCount);

    const prompt = `
You are an expert eBook planner.

Create a professional chapter outline.

BOOK TITLE:
${title}

TOPIC:
${topic}

DESCRIPTION:
${description || "No description provided"}

TARGET AUDIENCE:
${targetAudience}

WRITING STYLE:
${writingStyle}

Create EXACTLY ${chapterCount} chapters.

Every chapter must have:
- title
- description

Chapters must follow a logical progression.
The first chapter should introduce the topic.
The final chapter should provide a suitable conclusion.

Return ONLY valid JSON using this structure:

{
  "chapters": [
    {
      "title": "Chapter title",
      "description": "Short description of the chapter"
    }
  ]
}

Do not include Markdown or explanations.
`;

    // --------------------------------------------
    // TRY GEMINI FIRST
    // --------------------------------------------

    try {
      console.log(
        `🔄 Trying Gemini (${aiSettings.geminiModel}) for outline...`
      );

      const response = await executeWithGeminiRetry(
        () =>
          gemini.models.generateContent({
            model: aiSettings.geminiModel,
            contents: prompt,
            config: {
              responseMimeType: "application/json",
              maxOutputTokens: Math.min(
                aiSettings.maxTokens,
                3000
              ),
              temperature: aiSettings.temperature,
            },
          }),
        3
      );

      if (!response?.text) {
        throw new Error(
          "Gemini did not return an outline."
        );
      }

      let outline;

      try {
        outline = JSON.parse(
          cleanJsonString(response.text)
        );
      } catch (error) {
        throw new Error(
          "Gemini returned invalid outline JSON."
        );
      }

      if (
        !outline ||
        !Array.isArray(outline.chapters)
      ) {
        throw new Error(
          "Gemini returned an invalid outline structure."
        );
      }

      if (outline.chapters.length !== chapterCount) {
        throw new Error(
          `Gemini returned ${outline.chapters.length} chapters instead of ${chapterCount}.`
        );
      }

      outline.chapters.forEach((chapter, index) => {
        if (
          !chapter ||
          typeof chapter.title !== "string" ||
          !chapter.title.trim() ||
          typeof chapter.description !== "string" ||
          !chapter.description.trim()
        ) {
          throw new Error(
            `Chapter ${index + 1} is missing a title or description.`
          );
        }
      });

      console.log("\n✅ OUTLINE GENERATED SUCCESSFULLY");
      console.log("🤖 Provider: Gemini");
      console.log(
        "📚 Chapters generated:",
        outline.chapters.length
      );
      console.log(
        "⏱️ Duration:",
        `${((Date.now() - startedAt) / 1000).toFixed(2)} seconds`
      );
      console.log("====================================\n");

      await recordAIUsage({
        req,
        taskType: "outline",
        provider: "gemini",
        model: aiSettings.geminiModel,
        status: "success",
        fallbackUsed: false,
        startedAt,
        usage: response.usageMetadata,
      });

      return res.status(200).json({
        message: "Book outline generated successfully",
        outline,
        provider: "gemini",
      });
    } catch (geminiError) {
      console.error(
        "❌ Gemini outline generation failed:",
        geminiError.message
      );

      if (!shouldUseGroq(geminiError)) {
        await recordAIUsage({
          req,
          taskType: "outline",
          provider: "none",
          model: aiSettings.geminiModel,
          status: "failed",
          fallbackUsed: false,
          startedAt,
          errorMessage: geminiError.message,
        });

        return res.status(500).json({
          message:
            "Failed to generate book outline with Gemini.",
        });
      }

      // --------------------------------------------
      // FALL BACK TO GROQ
      // --------------------------------------------

      console.log(
        "🔁 Gemini failed. Switching to Groq for outline..."
      );

      try {
        const groqOutline = await generateOutlineWithGroq({
          aiSettings,
          title,
          topic,
          description,
          targetAudience,
          numberOfChapters: chapterCount,
          writingStyle,
        });

        console.log("\n✅ OUTLINE GENERATED SUCCESSFULLY");
        console.log("🤖 Provider: Groq (fallback)");
        console.log(
          "📚 Chapters generated:",
          groqOutline.chapters.length
        );
        console.log(
          "⏱️ Duration:",
          `${((Date.now() - startedAt) / 1000).toFixed(2)} seconds`
        );
        console.log("====================================\n");

        await recordAIUsage({
          req,
          taskType: "outline",
          provider: "groq",
          model: GROQ_MODEL,
          status: "success",
          fallbackUsed: true,
          startedAt,
        });

        return res.status(200).json({
          message:
            "Book outline generated successfully using Groq fallback",
          outline: groqOutline,
          provider: "groq",
        });
      } catch (groqError) {
        console.error(
          "❌ Groq outline generation failed:",
          groqError.message
        );

        await recordAIUsage({
          req,
          taskType: "outline",
          provider: "none",
          model: GROQ_MODEL,
          status: "failed",
          fallbackUsed: true,
          startedAt,
          errorMessage: groqError.message,
        });

        return res.status(502).json({
          message:
            "Both Gemini and Groq failed to generate the book outline. Please try again later.",
        });
      }
    }
  } catch (error) {
    console.error(
      "❌ Outline controller error:",
      error.message
    );

    await recordAIUsage({
      req,
      taskType: "outline",
      provider: "none",
      status: "failed",
      fallbackUsed: false,
      startedAt,
      errorMessage: error.message,
    });

    return res.status(500).json({
      message:
        "Server error while generating book outline.",
    });
  }
};

// ====================================================
// EXPORT CONTROLLERS
// ====================================================

module.exports = {
  generateBookContent,
  generateBookOutline,
};
