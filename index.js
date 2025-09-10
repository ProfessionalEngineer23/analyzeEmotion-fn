// index.js (Appwrite Function: analyzeEmotion)
// Runtime: Node 18+
// package.json deps: "node-appwrite", "ibm-watson"

import { Client, Databases, ID } from "node-appwrite";
import NaturalLanguageUnderstandingV1 from "ibm-watson/natural-language-understanding/v1.js";
import { IamAuthenticator } from "ibm-watson/auth/index.js";

/* ---------- Helpers ---------- */

function parseJson(body) {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return v;
}

function truncate(str, max = 10000) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) : str;
}

async function withRetry(fn, { attempts = 2, delayMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

/* ---------- Hoisted clients (cold start reuse) ---------- */

let watsonNLU = null;
let appwriteDB = null;

function getWatson() {
  if (!watsonNLU) {
    watsonNLU = new NaturalLanguageUnderstandingV1({
      version: "2022-04-07",
      authenticator: new IamAuthenticator({ apikey: requireEnv("WATSON_API_KEY") }),
      serviceUrl: requireEnv("WATSON_URL"),
    });
  }
  return watsonNLU;
}

function getDB() {
  if (!appwriteDB) {
    const client = new Client()
      .setEndpoint(requireEnv("APPWRITE_ENDPOINT")) // e.g. https://fra.cloud.appwrite.io/v1
      .setProject(requireEnv("APPWRITE_PROJECT_ID"))
      .setKey(requireEnv("APPWRITE_API_KEY")); // API key with rows.read + rows.write
    appwriteDB = new Databases(client);
  }
  return appwriteDB;
}

/* ---------- Handler ---------- */

export default async ({ req, res, log, error }) => {
  try {
    // Validate env up front (throws if missing)
    const DB_ID = requireEnv("APPWRITE_DATABASE_ID");
    const ANALYSIS = requireEnv("APPWRITE_ANALYSIS_COLLECTION_ID");

    // Parse request
    const { responseId, questionId = null, text } = parseJson(req.body);

    if (!responseId || typeof text !== "string" || text.trim() === "") {
      return res.json(
        {
          success: false,
          error: "Missing or invalid payload. Expect { responseId, questionId?, text }",
        },
        400
      );
    }

    const cleanText = truncate(text.trim(), 10000);

    log(
      JSON.stringify(
        {
          msg: "Watson NLU analyze start",
          responseId,
          questionId: questionId || null,
          textLen: cleanText.length,
        },
        null,
        2
      )
    );

    // Watson call (emotion + sentiment). No 'targets' here; document-level emotion is correct.
    const nlu = getWatson();
    const analyzeParams = {
      text: cleanText,
      features: {
        emotion: {}, // document-level emotion
        sentiment: {}, // document-level sentiment
      },
    };

    const analysisResult = await withRetry(() => nlu.analyze(analyzeParams), {
      attempts: 2,
      delayMs: 600,
    });

    const emotions = analysisResult?.result?.emotion?.document?.emotion || {};
    const sentimentDoc = analysisResult?.result?.sentiment?.document || null;

    const analysisData = {
      responseId,
      questionId, // null = overall
      joy: Number(emotions.joy || 0),
      sadness: Number(emotions.sadness || 0),
      anger: Number(emotions.anger || 0),
      fear: Number(emotions.fear || 0),
      disgust: Number(emotions.disgust || 0),
      sentiment: typeof sentimentDoc?.score === "number" ? sentimentDoc.score : 0,
      sentiment_label: sentimentDoc?.label || "neutral",
      model: "watson-nlu-v1",
      processedAt: new Date().toISOString(),
    };

    // Save document
    const db = getDB();
    const saved = await db.createDocument(DB_ID, ANALYSIS, ID.unique(), analysisData);

    log(
      JSON.stringify(
        {
          msg: "Watson NLU saved",
          analysisId: saved.$id,
          responseId,
          questionId,
        },
        null,
        2
      )
    );

    return res.json(
      {
        success: true,
        analysisId: saved.$id,
        emotions: analysisData,
      },
      200
    );
  } catch (err) {
    // Log full error safely
    error(
      JSON.stringify(
        {
          msg: "Watson NLU processing failed",
          name: err?.name,
          message: err?.message,
          stack: err?.stack?.split("\n").slice(0, 3).join("\n"),
        },
        null,
        2
      )
    );
    return res.json({ success: false, error: err?.message || "Internal error" }, 500);
  }
};
