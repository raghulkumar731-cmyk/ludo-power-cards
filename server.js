// Tiny backend proxy for the "Create Your Own Card" feature — Gemini edition.
//
// The game's index.html calls POST /api/create-card with { description }.
// This server calls Google's Gemini API (key stays server-side, never shipped
// to the browser) and returns a card the game already knows how to run:
// one of its 12 real effects, plus an AI-generated name/icon/color/flavor line.
//
// Why Gemini: Google's free tier has no total-credit expiration (unlike
// Anthropic's one-time trial credit) — just ongoing per-minute/per-day caps.
// For an occasional feature like this, that's usually enough to run indefinitely
// at $0. See "About limits" in README.md for the honest fine print.
//
// Setup:
//   1. cd server && npm install
//   2. Get a free key at https://aistudio.google.com/app/apikey
//   3. export GEMINI_API_KEY=AIza...   (never commit this)
//   4. npm start
//   5. In index.html, set CUSTOM_CARD_API_URL to wherever this server runs.

const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 3001;

// Google renames/retires Gemini model IDs fairly often. This default was current
// as of writing — if you ever see a 404 NOT_FOUND error, check the current model
// list at https://ai.google.dev/gemini-api/docs/models and update this env var
// (or the fallback string below) to a currently-supported Flash model.
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

if (!process.env.GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY environment variable. Set it before starting the server.');
  process.exit(1);
}

const app = express();
app.use(cors()); // For production, restrict this to your game's actual domain.
app.use(express.json({ limit: '10kb' }));

// If you deploy behind a reverse proxy (Render, Railway, Fly.io, nginx, etc.),
// uncomment this so req.ip reflects the real client IP instead of the proxy's:
// app.set('trust proxy', 1);

// Minimal per-IP rate limiter — no extra dependency, just enough to stop one
// player from burning through your whole daily Gemini quota by themselves.
// Swap for express-rate-limit if you want something more robust/distributed.
const RATE_LIMIT_MAX = 10;         // requests
const RATE_LIMIT_WINDOW_MS = 60_000; // per 1 minute, per IP
const requestLog = new Map(); // ip -> array of request timestamps

function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many card requests from this device — wait a moment and try again.' });
  }
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  next();
}

// Prevent the timestamp map from growing forever on a long-running server.
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of requestLog) {
    const fresh = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length) requestLog.set(ip, fresh);
    else requestLog.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

// The 12 real effects the game engine can actually run. Every custom card must
// map to exactly one of these — the AI never invents new game logic, it only
// re-skins (name/icon/color/flavor) one of these mechanics to match what the
// player asked for.
const BASE_EFFECTS = {
  shield:      'Makes one of your tokens permanently immune to being captured.',
  invisible:   'Makes one of your tokens hidden from opponents so they can\'t be targeted or captured.',
  teleport:    'Instantly moves one of your tokens to a different spot on the board.',
  clone:       'Creates a duplicate of one of your tokens.',
  luck:        'Guarantees your next dice roll results in a favorable capture.',
  cannon:      'Sends an opponent\'s token straight back to their yard.',
  starSmasher: 'Destroys a safe-zone tile so it no longer protects tokens standing on it.',
  trap:        'Secretly hides traps on 4 track tiles that capture whoever lands on them.',
  blocker:     'Seals off an opponent\'s home stretch for 2 rounds so they can\'t enter it.',
  timeRewind:  'Rewinds the board state back to how it was a short time ago.',
  diceHack:    'Lets you pick the exact number your next dice roll shows.',
  gravityFlip: 'Reverses movement direction for everyone on the board for 2 rounds.'
};

const BASE_EFFECT_KEYS = Object.keys(BASE_EFFECTS);

const SYSTEM_PROMPT = `You are a card designer for a Ludo-style board game. A player will describe, in their own words, a card they'd like to have. Your job is to:

1. Pick the ONE existing effect from this fixed list that best matches what they described:
${Object.entries(BASE_EFFECTS).map(([k, v]) => `   - "${k}": ${v}`).join('\n')}

2. Invent a short, punchy custom name for the card (max 3 words) that fits their description and theme.
3. Pick a single emoji icon that fits the theme.
4. Pick a hex color (e.g. "#f5b942") that fits the theme.
5. Write one short, fun sentence (max 20 words) describing the card in-theme, making clear what it actually does.

Rules:
- ALWAYS pick the closest matching effect from the fixed list above, even if the player's idea isn't a perfect match. Never invent a new effect key — "baseEffect" MUST be exactly one of: ${BASE_EFFECT_KEYS.join(', ')}.
- If the request is empty, nonsensical, or clearly inappropriate/offensive, still pick the closest reasonable effect from the list and design a neutral, family-friendly card rather than refusing outright.
- Keep everything family-friendly regardless of what the player wrote.
- Respond with ONLY a single JSON object, no markdown fences, no commentary, in exactly this shape:
{"baseEffect": "<one of the keys above>", "label": "<card name>", "icon": "<single emoji>", "color": "<#rrggbb>", "desc": "<one sentence>"}`;

app.post('/api/create-card', rateLimit, async (req, res) => {
  try {
    const description = (req.body && req.body.description || '').toString().slice(0, 300).trim();
    if (!description) {
      return res.status(400).json({ error: 'A card description is required.' });
    }

    const geminiRes = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: `Player's card idea: "${description}"` }] }],
        generationConfig: {
          maxOutputTokens: 300,
          responseMimeType: 'application/json' // ask Gemini to return raw JSON, no markdown fences
        }
      })
    });

    if (!geminiRes.ok) {
      const body = await geminiRes.json().catch(() => ({}));
      const status = body && body.error && body.error.status;
      const message = (body && body.error && body.error.message) || '';

      if (geminiRes.status === 429 || status === 'RESOURCE_EXHAUSTED') {
        // Free-tier per-minute or per-day cap hit. This is temporary — it always
        // resolves on its own (next minute, or midnight Pacific for the daily cap).
        return res.status(429).json({
          error: 'Card creator is busy right now (free usage cap reached) — try again in a minute, or later today if it keeps happening.'
        });
      }
      if (geminiRes.status === 404 || status === 'NOT_FOUND') {
        console.error(`Gemini model "${MODEL}" not found — it may have been retired. Check https://ai.google.dev/gemini-api/docs/models for a current model name and set GEMINI_MODEL.`);
        return res.status(502).json({ error: 'Card creator is temporarily misconfigured. Please tell the game owner to check the server logs.' });
      }
      console.error('Gemini API error:', geminiRes.status, message || body);
      return res.status(502).json({ error: 'Card creation failed. Please try again.' });
    }

    const data = await geminiRes.json();
    const candidate = data.candidates && data.candidates[0];

    if (!candidate) {
      // Empty candidates usually means the safety filter blocked the response
      // (check data.promptFeedback.blockReason) rather than an actual server error.
      console.error('Gemini returned no candidates:', JSON.stringify(data.promptFeedback || data));
      return res.status(502).json({ error: 'Could not generate a card from that description. Try rephrasing it.' });
    }

    const rawText = (
      candidate.content &&
      candidate.content.parts &&
      candidate.content.parts.map(p => p.text || '').join('')
    ) || '';

    // responseMimeType:'application/json' should prevent markdown fences, but strip
    // them defensively anyway — not every model version honors it consistently.
    const text = rawText.trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim();

    if (!text) {
      console.error('Gemini returned an empty response body. Finish reason:', candidate.finishReason);
      return res.status(502).json({ error: 'The card designer came up empty. Try again.' });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error('Could not parse Gemini response as JSON:', text);
      return res.status(502).json({ error: 'The card designer returned something unexpected. Try again.' });
    }

    if (!parsed.baseEffect || !BASE_EFFECTS[parsed.baseEffect]) {
      return res.status(502).json({ error: 'Could not match that to a real card effect. Try rephrasing.' });
    }

    // Defense-in-depth: sanitize output fields here too, not just in the browser —
    // this endpoint could be called directly by something other than the game's own UI.
    const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
    res.json({
      baseEffect: parsed.baseEffect,
      label: typeof parsed.label === 'string' ? parsed.label.slice(0, 24) : 'Custom Card',
      icon: typeof parsed.icon === 'string' ? [...parsed.icon].slice(0, 2).join('') : '🃏',
      color: typeof parsed.color === 'string' && HEX_COLOR_RE.test(parsed.color) ? parsed.color : '#f5b942',
      desc: typeof parsed.desc === 'string' ? parsed.desc.slice(0, 160) : ''
    });
  } catch (err) {
    console.error('create-card error:', err);
    res.status(500).json({ error: 'Card creation failed. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`Custom card proxy (Gemini) listening on http://localhost:${PORT}, model: ${MODEL}`);
});
