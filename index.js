// index.js (Appwrite Function: analyzeEmotion)
// Runtime: Node 18+
// deps: "node-appwrite", "ibm-watson"

import { Client, Databases, ID } from "node-appwrite";
import NaturalLanguageUnderstandingV1 from "ibm-watson/natural-language-understanding/v1.js";
import { IamAuthenticator } from "ibm-watson/auth/index.js";

/* ---------- helpers ---------- */
function parseJson(body) {
  if (!body) return {};
  try { return JSON.parse(body); } catch { return {}; }
}
function requireEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") throw new Error(`Missing environment variable: ${name}`);
  return v;
}
function truncate(str, max = 10000) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) : str;
}
async function withRetry(fn, { attempts = 2, delayMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs)); }
  }
  throw lastErr;
}

/* ---------- hoisted clients ---------- */
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
      .setEndpoint(requireEnv("APPWRITE_ENDPOINT"))
      .setProject(requireEnv("APPWRITE_PROJECT_ID"))
      .setKey(requireEnv("APPWRITE_API_KEY")); // scopes: rows.read + rows.write
    appwriteDB = new Databases(client);
  }
  return appwriteDB;
}

/* ---------- handler ---------- */
export default async ({ req, res, log, error }) => {
  try {
    const DB_ID = requireEnv("APPWRITE_DATABASE_ID");
    const ANALYSIS = requireEnv("APPWRITE_ANALYSIS_COLLECTION_ID");

    const WATSON_LANGUAGE = process.env.WATSON_LANGUAGE || "en";
    const MIN_LEN = Number(process.env.WATSON_MINLEN || 8);

    const { responseId, questionId = null, text } = parseJson(req.body);
    if (!responseId || typeof text !== "string" || text.trim() === "") {
      return res.json({ success: false, error: "Missing or invalid payload. Expect { responseId, questionId?, text }" }, 400);
    }

    const cleanText = truncate(text.trim(), 10000);
    const nowIso = new Date().toISOString();
    log(JSON.stringify({ msg: "Watson NLU analyze start", responseId, questionId, textLen: cleanText.length, lang: WATSON_LANGUAGE }));

    const db = getDB();

    // Short text → write neutral row (still include createdAt because your table requires it)
    if (cleanText.length < MIN_LEN) {
      const neutral = await db.createDocument(DB_ID, ANALYSIS, ID.unique(), {
        responseId,
        questionId,
        joy: 0, sadness: 0, anger: 0, fear: 0, disgust: 0,
        sentiment: 0,
        sentiment_label: "neutral",
        model: "watson-nlu-v1",
        processedAt: nowIso,
        createdAt: nowIso,            // <-- REQUIRED by your table
        textLen: cleanText.length,
        note: "too_short",
      });
      log(JSON.stringify({ msg: "Neutral analysis saved (too short)", analysisId: neutral.$id }));
      return res.json({ success: true, analysisId: neutral.$id, skipped: "too_short" }, 200);
    }

    // Watson call
    const nlu = getWatson();
    const result = await withRetry(() => nlu.analyze({
      text: cleanText,
      language: WATSON_LANGUAGE,
      features: { emotion: {}, sentiment: {} },
    }), { attempts: 2, delayMs: 600 });

    const emotions = result?.result?.emotion?.document?.emotion || {};
    const sentimentDoc = result?.result?.sentiment?.document || null;

    const saved = await db.createDocument(DB_ID, ANALYSIS, ID.unique(), {
      responseId,
      questionId,
      joy: Number(emotions.joy || 0),
      sadness: Number(emotions.sadness || 0),
      anger: Number(emotions.anger || 0),
      fear: Number(emotions.fear || 0),
      disgust: Number(emotions.disgust || 0),
      sentiment: typeof sentimentDoc?.score === "number" ? sentimentDoc.score : 0,
      sentiment_label: sentimentDoc?.label || "neutral",
      model: "watson-nlu-v1",
      processedAt: nowIso,
      createdAt: nowIso,            // <-- REQUIRED by your table
      textLen: cleanText.length,
      lang: WATSON_LANGUAGE,
    });

    log(JSON.stringify({ msg: "Watson NLU saved", analysisId: saved.$id, responseId, questionId }));
    return res.json({ success: true, analysisId: saved.$id, emotions: emotions, sentiment: sentimentDoc }, 200);

  } catch (err) {
    error(JSON.stringify({ msg: "Watson NLU processing failed", name: err?.name, message: err?.message, stack: err?.stack?.split("\n").slice(0, 3).join("\n") }));
    return res.json({ success: false, error: err?.message || "Internal error" }, 500);
  }
};
