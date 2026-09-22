# Ludo: Power Cards

## What's in this repo
- **`ludo-power-cards-win-to-home.html`** — the whole game. This is the file your Sketchware
  WebView loads.
- **`.gitignore`** — keeps secrets and build junk out of GitHub. Keep this at the repo root.
- **`backend/`** — the Firebase Cloud Functions that handle real money and gems (payments,
  the AI card composer, the Marketplace). Nothing in the game runs safely without these
  deployed.
  - `functions/index.js` — the functions themselves.
  - `functions/package.json` — their dependencies.
  - `firestore.rules.snippet` — rules to merge into your Firestore security rules.
  - `SETUP.md` — step-by-step: Razorpay, Firebase, deploying, AdMob wiring.

## Before you push this to GitHub
Nothing here needs removing — no keys are hardcoded anywhere. Your actual secrets
(Razorpay Key Secret, webhook secret, Anthropic API key) live only in Firebase's own
secret manager, set with `firebase functions:secrets:set`, never in a file.

## First time setup
```
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin <your GitHub repo URL>
git push -u origin main
```

## After pushing
Follow `backend/SETUP.md` to deploy the functions and merge the Firestore rules —
the app can't take payments, run the AI composer, or sell Marketplace cards until
that's done.
