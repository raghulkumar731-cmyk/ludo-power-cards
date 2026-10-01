// ============================================================================
// ANTI-CHEAT ADDITIONS — paste these exports into your existing functions/index.js
// ============================================================================
// Why: index.html used to let the signed-in player's OWN browser write their coins,
// gems, xp, wins and rankPoints directly to Firestore (e.g. after "watching" an ad,
// buying a shop card, or winning a match). That only works safely if nobody opens
// devtools — anyone could call the same Firestore update with a bigger number and
// grant themselves unlimited currency. These functions move every one of those
// writes here, where only server code (running with admin rights) can touch them.
// The matching Firestore rules change (firestore-anticheat.rules, provided alongside
// this file) then REFUSES any client write to those fields, so this is the only path
// left that can change them.
//
// Setup:
//   1. Paste the block below into your existing functions/index.js, near your other
//      functions.region(...).https.onCall(...) exports (next to deleteMyAccount,
//      verifyPlayPurchase, publishMarketCard, buyMarketCard, composeCard).
//   2. Do NOT re-declare `functions`, `admin`, or `db` if your file already has them
//      at the top (it does — delete the three lines below marked "already in your file?").
//   3. Double-check every constant below against the matching constant in index.html —
//      they MUST stay identical on both sides, or players will see the wrong numbers.
//      (index.html's lines are cited in the comments so you can diff them easily.)
//   4. Deploy: firebase deploy --only functions
//
// Cost note: Cloud Functions requires the Blaze (pay-as-you-go) plan, not the free
// Spark plan — but the free tier inside Blaze covers 2,000,000 invocations/month,
// so for a game this size you should see $0 actual charges.
// ============================================================================

const functions = require('firebase-functions');   // already in your file?
const admin = require('firebase-admin');            // already in your file?
const db = admin.firestore();                       // already in your file?
const REGION = 'asia-south1'; // must match FUNCTIONS_REGION in index.html (line ~7390)

// ---- Keep these in sync with index.html ----
const AD_COINS_PER_WATCH  = 15;   // index.html: AD_COINS_PER_WATCH  (~line 7454)
const AD_MAX_PER_DAY      = 5;    // index.html: AD_MAX_PER_DAY      (~line 7455)
const SHOP_CARD_PRICE     = 50;   // index.html: MARKET_CARD_PRICE   (~line 3378)
const COIN_TO_GEM_RATE    = 100;  // index.html: COIN_TO_GEM_RATE    (~line 7306)
const CARD_CREATE_GEM_COST = 1;   // index.html: CARD_CREATE_GEM_COST (~line 8144)
const COIN_WIN_VS_PLAYER  = 25;   // index.html: COIN_WIN_VS_PLAYER  (~line 7655)
const COIN_WIN_VS_BOT     = 5;    // index.html: COIN_WIN_VS_BOT     (~line 7656)
const COIN_DAILY_CAP      = 150;  // index.html: COIN_DAILY_CAP      (~line 7657)
const XP_LOSS_PENALTY     = 10;   // index.html: XP_LOSS_PENALTY     (~line 7658)
const XP_WIN_GAIN         = 30;   // index.html: increment(30) in showWin (~line 7724)
const RANK_POINTS_PER_WIN = 25;   // index.html: RANK_POINTS_PER_WIN (~line 6853)

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// watchAdReward — replaces the direct coins+adsToday write after a rewarded ad.
// The AD_MAX_PER_DAY cap is now enforced here, where a client can't skip it.
// ---------------------------------------------------------------------------
exports.watchAdReward = functions.region(REGION).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Log in to earn coins.');
  }
  const ref = db.collection('players').doc(context.auth.uid);
  const day = todayKey();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const p = snap.data() || {};
    const already = (p.adsToday && p.adsToday.day === day) ? (p.adsToday.n || 0) : 0;
    if (already >= AD_MAX_PER_DAY) {
      throw new functions.https.HttpsError('resource-exhausted', "You've hit today's ad limit.");
    }
    tx.update(ref, {
      coins: admin.firestore.FieldValue.increment(AD_COINS_PER_WATCH),
      adsToday: { day, n: already + 1 },
    });
    return { grantedCoins: AD_COINS_PER_WATCH, adsWatchedToday: already + 1 };
  });
});

// ---------------------------------------------------------------------------
// buyShopCard — replaces the direct coins-minus / equipped[key]=true write when
// unlocking a fixed-price shop power card.
// ---------------------------------------------------------------------------
exports.buyShopCard = functions.region(REGION).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Log in first.');
  }
  const key = typeof (data && data.key) === 'string' ? data.key.trim() : '';
  if (!key) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing card key.');
  }
  const ref = db.collection('players').doc(context.auth.uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const coins = (snap.data() || {}).coins || 0;
    if (coins < SHOP_CARD_PRICE) {
      throw new functions.https.HttpsError('failed-precondition', 'Not enough coins.');
    }
    tx.update(ref, {
      coins: admin.firestore.FieldValue.increment(-SHOP_CARD_PRICE),
      ['equipped.' + key]: true,
    });
    return { spent: SHOP_CARD_PRICE, key };
  });
});

// ---------------------------------------------------------------------------
// convertCoinsToGems — replaces the direct coins-minus / gems-plus write.
// ---------------------------------------------------------------------------
exports.convertCoinsToGems = functions.region(REGION).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Log in first.');
  }
  const ref = db.collection('players').doc(context.auth.uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const coins = (snap.data() || {}).coins || 0;
    if (coins < COIN_TO_GEM_RATE) {
      throw new functions.https.HttpsError('failed-precondition', 'Not enough coins.');
    }
    tx.update(ref, {
      coins: admin.firestore.FieldValue.increment(-COIN_TO_GEM_RATE),
      gems: admin.firestore.FieldValue.increment(1),
    });
    return { spent: COIN_TO_GEM_RATE, gemsGained: 1 };
  });
});

// ---------------------------------------------------------------------------
// spendGemsForCardCreation — replaces the direct gems-minus write in
// spendGemsForCardCreation() (the AI card composer's gem cost).
// ---------------------------------------------------------------------------
exports.spendGemsForCardCreation = functions.region(REGION).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Log in first.');
  }
  const ref = db.collection('players').doc(context.auth.uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const gems = (snap.data() || {}).gems || 0;
    if (gems < CARD_CREATE_GEM_COST) {
      throw new functions.https.HttpsError('failed-precondition', 'Not enough gems.');
    }
    tx.update(ref, { gems: admin.firestore.FieldValue.increment(-CARD_CREATE_GEM_COST) });
    return { spent: CARD_CREATE_GEM_COST };
  });
});

// ---------------------------------------------------------------------------
// reportMatchResult — replaces the direct writes in showWin()/applyLossPenalty().
//
// HONEST LIMITATION: matches run peer-to-peer with no server referee (see the
// multiplayer explanation earlier in this conversation), so the server still has
// to take the caller's word for who won — there's no way around that without a
// much bigger architecture change (a trusted match authority). What THIS function
// does fix: a client can no longer grant itself an arbitrary amount by calling
// Firestore directly, because (a) the daily coin cap is enforced here, server-
// side, and (b) each matchId can only ever be claimed once — a player repeatedly
// calling this to farm coins just hits the same COIN_DAILY_CAP the game already
// intends, instead of being able to grant themselves unlimited coins.
// ---------------------------------------------------------------------------
exports.reportMatchResult = functions.region(REGION).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Log in first.');
  }
  const matchId = typeof (data && data.matchId) === 'string' ? data.matchId.trim() : '';
  const result = data && data.result === 'win' ? 'win' : (data && data.result === 'loss' ? 'loss' : '');
  if (!matchId || !result) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing matchId/result.');
  }
  const vsBots = !!(data && data.vsBots);
  const ranked = !!(data && data.ranked);

  const playerRef = db.collection('players').doc(context.auth.uid);
  const claimRef = playerRef.collection('claimedMatches').doc(matchId);

  return db.runTransaction(async (tx) => {
    const claimSnap = await tx.get(claimRef);
    if (claimSnap.exists) {
      throw new functions.https.HttpsError('already-exists', 'This match was already recorded.');
    }

    const snap = await tx.get(playerRef);
    const p = snap.data() || {};
    const day = todayKey();

    if (result === 'win') {
      const coinBase = vsBots ? COIN_WIN_VS_BOT : COIN_WIN_VS_PLAYER;
      const ct = p.coinsToday;
      const earnedToday = (ct && ct.day === day) ? (ct.n || 0) : 0;
      const coinGrant = Math.max(0, Math.min(coinBase, COIN_DAILY_CAP - earnedToday));

      const update = {
        xp: admin.firestore.FieldValue.increment(XP_WIN_GAIN),
        wins: admin.firestore.FieldValue.increment(1),
        gamesPlayed: admin.firestore.FieldValue.increment(1),
        coins: admin.firestore.FieldValue.increment(coinGrant),
        coinsToday: { day, n: earnedToday + coinGrant },
        updatedAt: Date.now(),
      };
      if (ranked) {
        update.rankPoints = admin.firestore.FieldValue.increment(RANK_POINTS_PER_WIN);
      }
      tx.update(playerRef, update);
      tx.set(claimRef, { result, at: Date.now() });
      return { result, coinGrant, xpGained: XP_WIN_GAIN };
    } else {
      const xp = p.xp || 0;
      const newXp = Math.max(0, xp - XP_LOSS_PENALTY);
      tx.update(playerRef, {
        xp: newXp,
        gamesPlayed: admin.firestore.FieldValue.increment(1),
        updatedAt: Date.now(),
      });
      tx.set(claimRef, { result, at: Date.now() });
      return { result, xpLost: xp - newXp };
    }
  });
});
