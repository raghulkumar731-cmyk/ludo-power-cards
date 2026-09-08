# Custom Card Proxy (Gemini edition)

A tiny backend that powers the "🪄 Create Your Own Card" feature in the game.
It holds your Gemini API key safely on the server — the game's HTML page never
sees it.

## How it works

- The game has 12 real effects it can actually run (Shield, Teleport, Clone, Luck,
  Cannon, Star Smasher, Trap, Blocker, Time Rewind, Dice Hack, Gravity Flip, Invisible).
- A player types a free-text idea ("a card that makes me invisible").
- This server asks Gemini to match that idea to the closest real effect, then invent
  a name, icon, color, and one-line flavor description for it.
- The game "equips" the chosen effect with that custom skin — it plays exactly like
  the real effect, just relabeled/restyled.

## Setup

1. Get a free API key at https://aistudio.google.com/app/apikey (no credit card needed).
2. ```bash
   cd server
   npm install
   export GEMINI_API_KEY=AIza-your-key-here
   npm start
   ```

Requires Node 18+ (uses the built-in `fetch`). The server listens on
`http://localhost:3001` by default (override with `PORT`).

## Point the game at it

In `index.html`, find this line near the bottom (inside the Custom Card Creator script):

```js
const CUSTOM_CARD_API_URL = 'http://localhost:3001/api/create-card';
```

Change it to wherever you deploy this server, e.g.:

```js
const CUSTOM_CARD_API_URL = 'https://your-app.onrender.com/api/create-card';
```

## Deploying

Any Node host works (Render, Railway, Fly.io, a VPS, etc.). Just make sure:

- `GEMINI_API_KEY` is set as a server-side environment variable/secret — never
  committed to source control or exposed to the client.
- You update the `cors()` call in `server.js` to allow only your game's actual
  domain once you're not testing locally, e.g.:

  ```js
  app.use(cors({ origin: 'https://your-game-domain.com' }));
  ```

- Consider adding a `.env` file locally for convenience (see `.env.example`) —
  just remember it's git-ignored and never gets committed.
- A basic per-IP rate limiter is already built in (10 requests/minute/IP,
  in-memory) so one player can't burn through your whole daily Gemini quota
  alone. For serious production traffic across multiple server instances,
  swap it for something distributed like `express-rate-limit` + Redis.

## About limits (read this before relying on it for a real crowd of players)

- Google's Gemini free tier has **no total-credit expiration** — unlike
  Anthropic's one-time trial credit, it doesn't run out permanently. Instead it
  has ongoing caps: roughly **~10–15 requests per minute** and **~1,000–1,500
  requests per day** for the Flash model (Google adjusts these numbers over
  time — check https://ai.google.dev/gemini-api/docs/rate-limits for current
  values).
- Hitting a cap just pauses the feature briefly (a minute, or until the daily
  reset at midnight Pacific) — it doesn't need a payment method to recover,
  unlike Anthropic's spend-cap error.
- **Every player still shares your one key/project** — it's not "each player
  gets their own free usage." If you expect a lot of simultaneous players,
  add rate limiting per player/IP so one person can't eat the whole day's
  quota.
- Free tier note: Google may use free-tier prompts/outputs to improve their
  models. If that matters for your use case, that's a reason to eventually
  move to a paid Gemini key (which turns this off) rather than a reason not
  to use the free tier for a casual game.

## Model name

Gemini model IDs get renamed/retired more often than you'd expect (Google
shut down `gemini-2.0-flash` in mid-2026, for example). This server defaults
to `gemini-2.5-flash` via the `GEMINI_MODEL` env var. If you ever see a
"temporarily misconfigured" error from the game, check the server logs for a
404 and look up the current model name at
https://ai.google.dev/gemini-api/docs/models, then set `GEMINI_MODEL` to it.
