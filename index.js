const { Client, Databases, ID } = require('node-appwrite');
const NaturalLanguageUnderstandingV1 = require('ibm-watson/natural-language-understanding/v1');
const { IamAuthenticator } = require('ibm-watson/auth');

// Initialize Appwrite client
const client = new Client();
client
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);

// Initialize Watson NLU
const naturalLanguageUnderstanding = new NaturalLanguageUnderstandingV1({
  version: '2022-04-07',
  authenticator: new IamAuthenticator({
    apikey: process.env.WATSON_API_KEY,
  }),
  serviceUrl: process.env.WATSON_URL,
});

module.exports = async ({ req, res, log, error }) => {
  try {
    // Parse the request body
    const { responseId, questionId, text } = JSON.parse(req.body);
    
    if (!responseId || !text) {
      return res.json({ 
        success: false, 
        error: 'Missing responseId or text' 
      }, 400);
    }

    log(`Processing Watson NLU for response: ${responseId}, question: ${questionId || 'overall'}`);

    // Call Watson NLU Emotion Analysis
    const analyzeParams = {
      text: text,
      features: {
        emotion: {
          targets: ['joy', 'sadness', 'anger', 'fear', 'disgust']
        },
        sentiment: {}
      }
    };

    const analysisResult = await naturalLanguageUnderstanding.analyze(analyzeParams);
    
    // Extract emotion scores
    const emotions = analysisResult.result.emotion?.document?.emotion || {};
    const sentiment = analysisResult.result.sentiment?.document;
    
    // Prepare analysis data
    const analysisData = {
      responseId: responseId,
      questionId: questionId || null, // null for overall analysis
      joy: emotions.joy || 0,
      sadness: emotions.sadness || 0,
      anger: emotions.anger || 0,
      fear: emotions.fear || 0,
      disgust: emotions.disgust || 0,
      sentiment: sentiment?.score || 0,
      sentiment_label: sentiment?.label || 'neutral',
      model: 'watson-nlu-v1',
      processedAt: new Date().toISOString()
    };

    // Save to analysis collection
    const analysisDoc = await databases.createDocument(
      process.env.APPWRITE_DATABASE_ID,
      process.env.APPWRITE_ANALYSIS_COLLECTION_ID,
      ID.unique(),
      analysisData
    );

    log(`Analysis saved: ${analysisDoc.$id}`);

    return res.json({ 
      success: true, 
      analysisId: analysisDoc.$id,
      emotions: emotions,
      sentiment: sentiment
    });

  } catch (err) {
    error(`Watson NLU processing failed: ${err.message}`);
    return res.json({ 
      success: false, 
      error: err.message 
    }, 500);
  }
};
