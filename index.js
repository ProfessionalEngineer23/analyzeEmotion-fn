import fetch from "node-fetch";
import { Client, Databases, ID } from "node-appwrite";

const DB_ID = "app";
const ANALYSIS_COL = "Analysis";

export default async ({ req, res, log, error }) => {
  try {
    const {
      ANALYZER = "watson-nlu",
      WATSON_NLU_URL,
      WATSON_NLU_APIKEY,
      APPWRITE_ENDPOINT,
      APPWRITE_PROJECT_ID,
      APPWRITE_API_KEY
    } = process.env;

    const { responseId, text } = JSON.parse(req.body || "{}");
    if (!responseId || !text) return res.json({ error: "Missing responseId or text" }, 400);

    const url = `${WATSON_NLU_URL}/v1/analyze?version=2022-04-07`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":"application/json",
        "Authorization":"Basic " + Buffer.from("apikey:"+WATSON_NLU_APIKEY).toString("base64")
      },
      body: JSON.stringify({ text, features: { emotion: {} } })
    });
    const data = await r.json();
    const emotion = data?.emotion?.document?.emotion;
    if (!emotion) return res.json({ error: "No emotion returned", details: data }, 502);

    const client = new Client()
      .setEndpoint(APPWRITE_ENDPOINT)
      .setProject(APPWRITE_PROJECT_ID)
      .setKey(APPWRITE_API_KEY);

    const db = new Databases(client);
    const doc = await db.createDocument(DB_ID, ANALYSIS_COL, ID.unique(), {
      responseId,
      joy: emotion.joy,
      sadness: emotion.sadness,
      anger: emotion.anger,
      fear: emotion.fear,
      disgust: emotion.disgust,
      model: ANALYZER,
      createdAt: new Date().toISOString()
    });

    return res.json({ ok: true, analysisId: doc.$id, emotion });
  } catch (e) {
    error(e);
    return res.json({ error: String(e) }, 500);
  }
};
