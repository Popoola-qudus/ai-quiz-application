import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import saveQuizz from "./saveToDb";

interface Answer {
  answerText: string;
  isCorrect: boolean;
}

interface Question {
  questionText: string;
  answers: Answer[];
}

interface Quiz {
  name: string;
  description: string;
  questions: Question[];
}

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("Gemini API key is missing");
}

const genAI = new GoogleGenerativeAI(apiKey);

const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
});

const generationConfig = {
  temperature: 1,
  topP: 0.95,
  topK: 64,
  maxOutputTokens: 8192,
  responseMimeType: "text/plain",
};

const chunkText = (text: string, maxTokens: number): string[] => {
  const words = text.split(" ");
  const chunks = [];
  let chunk = [];

  for (const word of words) {
    if (chunk.join(" ").length + word.length > maxTokens) {
      chunks.push(chunk.join(" "));
      chunk = [];
    }
    chunk.push(word);
  }

  if (chunk.length > 0) {
    chunks.push(chunk.join(" "));
  }

  return chunks;
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.formData();
    const document = body.get("pdf");

    if (!document) {
      return NextResponse.json(
        { error: "No document provided" },
        { status: 400 }
      );
    }

    const pdfLoader = new PDFLoader(document as Blob, {
      parsedItemSeparator: " ",
    });

    const docs = await pdfLoader.load();
    console.log("Loaded PDF docs:", docs);

    const selectedDocuments = docs.filter(
      (doc) => doc.pageContent !== undefined
    );
    const texts = selectedDocuments.map((doc) => doc.pageContent).join(" ");

    const maxTokens = 64;
    const chunks = chunkText(texts, maxTokens);

    const limitedChunks = chunks.slice(0, 10);
    let quizData: Quiz = { name: "", description: "", questions: [] };

    for (const chunk of limitedChunks) {
      const prompt = `given the text which is a summary of the document, generate a quiz based on the text. Return json only that contains a quiz object with fields: name, description, and questions. The questions is an array of objects with fields: questionText, answers. The answers is an array of objects with fields: answerText, isCorrect.\nText: ${chunk}`;

      const chatSession = model.startChat({
        generationConfig,
        history: [],
      });

      try {
        const result = await chatSession.sendMessage(prompt);
        let response = await result.response.text();
        console.log("Raw Gemini AI Response:", response);

        response = response.replace(/```json/g, "").replace(/```/g, "");

        let quizObject: Quiz;
        try {
          quizObject = JSON.parse(response);
        } catch (parseError: unknown) {
          console.error("Failed to parse response:", response);
          console.error("Error details:", parseError);
          continue;
        }

        if (quizObject && Array.isArray(quizObject.questions)) {
          quizData.questions.push(...quizObject.questions);
        }
      } catch (apiError) {
        console.error("API error:", apiError);
        return NextResponse.json(
          { error: "Failed to generate quiz from AI." },
          { status: 500 }
        );
      }
    }

    if (quizData.questions.length === 0) {
      return NextResponse.json(
        { error: "Failed to generate valid quiz data" },
        { status: 500 }
      );
    }

    const { quizzId } = await saveQuizz(quizData);
    return NextResponse.json({ quizzId }, { status: 200 });
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.log("Error in quiz generation route:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    } else {
      console.log("Unknown error in quiz generation route:", error);
      return NextResponse.json(
        { error: "An unknown error occurred." },
        { status: 500 }
      );
    }
  }
}
