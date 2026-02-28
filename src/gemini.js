// ── Module Gemini — seule connexion externe autorisée ─────────────────
// Désactivable via GEMINI_ENABLED=false dans .env ou flag --no-ai

const GEMINI_ENABLED = process.env.GEMINI_ENABLED !== 'false';
const API_KEY = process.env.GEMINI_API_KEY || '';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${API_KEY}`;

function buildPrompt(context, userQuery) {
  const contextStr = context.length > 0
    ? `Contexte — derniers messages du réseau Archipel :\n${context.map(m => `[${m.from}]: ${m.text}`).join('\n')}\n\n`
    : '';
  return `${contextStr}Question : ${userQuery}\n\nTu es un assistant intégré dans Archipel, un réseau P2P chiffré. Réponds de manière concise et utile en français.`;
}

async function queryGemini(conversationContext, userQuery) {
  if (!GEMINI_ENABLED) {
    return { error: 'Assistant IA désactivé (mode hors-ligne)' };
  }

  if (!API_KEY) {
    return { error: 'Clé API manquante — ajoute GEMINI_API_KEY dans le fichier .env' };
  }

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text: buildPrompt(conversationContext, userQuery) }]
        }]
      })
    });

    if (!response.ok) {
      return { error: `Erreur Gemini : ${response.status} ${response.statusText}` };
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) return { error: 'Réponse vide de Gemini' };

    return { text };
  } catch (err) {
    // Fallback gracieux si Gemini inaccessible (mode offline)
    return { error: `Gemini inaccessible : ${err.message}` };
  }
}

module.exports = { queryGemini, GEMINI_ENABLED };