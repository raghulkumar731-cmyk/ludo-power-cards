// ---------------------------------------------------------------------------
// functions/index.js — Firebase Cloud Functions for Ludo Power Cards
//
// Contains:
//   - verifyPlayPurchase   (real-money gem-pack purchases via Google Play Billing)
//   - publishMarketCard    (list a custom card on the Marketplace, costs 5 gems)
//   - buyMarketCard        (buy a listed card; splits the price 70% creator / 30% you)
//
// Deploy with: firebase deploy --only functions
// ---------------------------------------------------------------------------

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { google } = require('googleapis');

if (!admin.apps.length) admin.initializeApp();

const FUNCTIONS_REGION = 'asia-south1'; // must match FUNCTIONS_REGION in the web app

// ============================================================================
// verifyPlayPurchase — real-money gem pack purchases (Google Play Billing)
// ============================================================================
//
// Setup you still need to do yourself:
//   1. npm install googleapis   (inside your functions/ folder)
//   2. Create a Google Cloud service account with the "Service Account User"
//      role, link it in Play Console under Setup > API access, and grant it
//      "View financial data" + "Manage orders and subscriptions" permission.
//   3. Either run this Cloud Function with that service account's identity
//      (simplest: Cloud Functions' default service account, granted the same
//      Play Console access) or download a JSON key and set
//      GOOGLE_APPLICATION_CREDENTIALS — don't commit that key to git.
//   4. Set PACKAGE_NAME below to your real Android applicationId.
//   5. Create the in-app products in Play Console > Monetize > Products >
//      In-app products, with IDs matching GEM_PACK_AMOUNTS below exactly —
//      these must also match GEM_PACK_IDS' values in the web app.

const PACKAGE_NAME = 'com.mystudio.ludopowercards';

// Must match GEM_PACK_IDS' values in the web app AND the product IDs created in Play Console.
const GEM_PACK_AMOUNTS = {
  gems_50: 50,
  gems_120: 120,
  gems_300: 300,
};

let _publisherClient = null;
async function androidPublisherClient() {
  if (_publisherClient) return _publisherClient;
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  const authClient = await auth.getClient();
  _publisherClient = google.androidpublisher({ version: 'v3', auth: authClient });
  return _publisherClient;
}

exports.verifyPlayPurchase = functions
  .region(FUNCTIONS_REGION)
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Log in first.');
    }
    const uid = context.auth.uid;
    const packId = data && data.packId;
    const purchaseToken = data && data.purchaseToken;
    const gemsToCredit = GEM_PACK_AMOUNTS[packId];
    if (!gemsToCredit || !purchaseToken) {
      throw new functions.https.HttpsError('invalid-argument', 'Bad purchase data.');
    }

    // Idempotency: the purchase token is Google's unique ID for this exact purchase.
    // If we've already recorded it, never credit gems for it again.
    const db = admin.firestore();
    const purchaseRef = db.collection('processedPurchases').doc(purchaseToken);
    const already = await purchaseRef.get();

    if (!already.exists) {
      const publisher = await androidPublisherClient();
      const res = await publisher.purchases.products.get({
        packageName: PACKAGE_NAME,
        productId: packId,
        token: purchaseToken,
      });
      const purchase = res.data;

      // purchaseState: 0 = purchased, 1 = canceled, 2 = pending.
      if (purchase.purchaseState !== 0) {
        throw new functions.https.HttpsError('failed-precondition', 'Purchase was not completed.');
      }

      await db.runTransaction(async (tx) => {
        const dup = await tx.get(purchaseRef);
        if (dup.exists) return;
        tx.set(purchaseRef, {
          uid,
          packId,
          gemsToCredit,
          creditedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        tx.update(db.collection('players').doc(uid), {
          gems: admin.firestore.FieldValue.increment(gemsToCredit),
        });
      });
    }

    try {
      const publisher = await androidPublisherClient();
      await publisher.purchases.products.consume({
        packageName: PACKAGE_NAME,
        productId: packId,
        token: purchaseToken,
      });
    } catch (e) {
      console.error('consume() failed (gems were already credited, so this is not fatal):', e.message);
    }

    return { credited: gemsToCredit };
  });

// ============================================================================
// publishMarketCard — list a custom card on the Marketplace
// ============================================================================
// Flat cost to publish: PUBLISH_COST_GEMS, deducted from the author. The listing
// itself is priced by the author (priceGems), clamped to a sane range.

const PUBLISH_COST_GEMS = 5;
const MIN_PRICE_GEMS = 4;
const MAX_PRICE_GEMS = 100;

exports.publishMarketCard = functions
  .region(FUNCTIONS_REGION)
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Log in first.');
    }
    const uid = context.auth.uid;

    const label = String((data && data.label) || '').slice(0, 24);
    const icon = String((data && data.icon) || '🃏').slice(0, 4);
    const color = (data && /^#[0-9a-fA-F]{6}$/.test(data.color)) ? data.color : '#ffb300';
    const desc = String((data && data.desc) || '').slice(0, 160);
    const baseEffect = (data && data.baseEffect) || null;
    const recipe = (data && data.recipe) || null;
    if (!label || (!baseEffect && !recipe)) {
      throw new functions.https.HttpsError('invalid-argument', 'Card is missing required fields.');
    }

    let priceGems = parseInt(data && data.priceGems, 10);
    if (!Number.isFinite(priceGems)) priceGems = 10;
    priceGems = Math.min(MAX_PRICE_GEMS, Math.max(MIN_PRICE_GEMS, priceGems));

    const db = admin.firestore();
    const playerRef = db.collection('players').doc(uid);
    const listingRef = db.collection('marketplaceCards').doc();

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(playerRef);
      const profile = snap.data() || {};
      const gems = profile.gems || 0;
      if (gems < PUBLISH_COST_GEMS) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Not enough gems to publish (needs ' + PUBLISH_COST_GEMS + ').'
        );
      }
      tx.update(playerRef, { gems: admin.firestore.FieldValue.increment(-PUBLISH_COST_GEMS) });
      tx.set(listingRef, {
        authorId: uid,
        authorName: profile.displayName || 'Player',
        label, icon, color, desc, baseEffect, recipe,
        priceGems,
        purchases: 0,
        timesUsed: 0,
        winCount: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { id: listingRef.id };
    });

    return result;
  });

// ============================================================================
// buyMarketCard — buy a listed card, splitting the price between the creator
// and you (the platform).
// ============================================================================
//
// CREATOR_SHARE is the fraction of each sale paid to the card's original author,
// as spendable gems credited straight to their player doc. The remainder (your
// cut) is tracked in a running ledger doc (platformRevenue/summary) so you can
// see total gems taken in, and — if you set ADMIN_UID below — is ALSO credited
// as spendable gems to your own player account. Leave ADMIN_UID blank if you'd
// rather just review the ledger total without pulling it into a specific
// account's spendable balance.

const CREATOR_SHARE = 0.70; // creator gets 70%, platform keeps the remaining 30%
const ADMIN_UID = '1igelRkzKPNiusu2C0H2LetOPZz1';

exports.buyMarketCard = functions
  .region(FUNCTIONS_REGION)
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Log in first.');
    }
    const buyerUid = context.auth.uid;
    const cardId = data && data.cardId;
    if (!cardId) {
      throw new functions.https.HttpsError('invalid-argument', 'Missing cardId.');
    }

    const db = admin.firestore();
    const listingRef = db.collection('marketplaceCards').doc(cardId);
    const buyerRef = db.collection('players').doc(buyerUid);
    const collectionRef = buyerRef.collection('collection').doc(cardId);

    const purchasedCard = await db.runTransaction(async (tx) => {
      const [listingSnap, buyerSnap, ownedSnap] = await Promise.all([
        tx.get(listingRef),
        tx.get(buyerRef),
        tx.get(collectionRef),
      ]);

      if (!listingSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'This card is no longer listed.');
      }
      const listing = listingSnap.data();

      if (listing.authorId === buyerUid) {
        throw new functions.https.HttpsError('failed-precondition', 'This is your own card.');
      }
      if (ownedSnap.exists) {
        throw new functions.https.HttpsError('already-exists', 'You already own this card.');
      }

      const price = listing.priceGems || 10;
      const buyerGems = (buyerSnap.data() || {}).gems || 0;
      if (buyerGems < price) {
        throw new functions.https.HttpsError('failed-precondition', 'Not enough gems.');
      }

      // Reads must all happen before any writes in a Firestore transaction — this read
      // of the seller doc still comes before every tx.update/tx.set below, so it's safe.
      const sellerRef = db.collection('players').doc(listing.authorId);
      const sellerSnap = await tx.get(sellerRef);
      if (!sellerSnap.exists) {
        throw new functions.https.HttpsError('internal', 'Card creator no longer exists.');
      }

      const creatorCut = Math.floor(price * CREATOR_SHARE);
      const platformCut = price - creatorCut; // remainder, so the two cuts always add up to the full price

      tx.update(buyerRef, { gems: admin.firestore.FieldValue.increment(-price) });
      tx.update(sellerRef, { gems: admin.firestore.FieldValue.increment(creatorCut) });
      tx.update(listingRef, { purchases: admin.firestore.FieldValue.increment(1) });

      const cardData = {
        label: listing.label,
        icon: listing.icon,
        color: listing.color,
        desc: listing.desc,
        baseEffect: listing.baseEffect || null,
        recipe: listing.recipe || null,
        boughtFrom: cardId,
        pricePaid: price,
        purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      tx.set(collectionRef, cardData);

      const ledgerRef = db.collection('platformRevenue').doc('summary');
      tx.set(ledgerRef, {
        totalGems: admin.firestore.FieldValue.increment(platformCut),
        lastSaleAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      if (ADMIN_UID) {
        const adminRef = db.collection('players').doc(ADMIN_UID);
        tx.update(adminRef, { gems: admin.firestore.FieldValue.increment(platformCut) });
      }

      return cardData;
    });

    return purchasedCard;
  });

// ============================================================================
// deleteMyAccount — permanently deletes the calling player's account + data
// ============================================================================
//
// Removes: the player's marketplace listings (buyMarketCard would otherwise fail on
// them with "Card creator no longer exists"), their reserved username, their player
// doc and every subcollection under it (e.g. purchased cards), and finally the
// Firebase Auth user itself. Data is deleted BEFORE the auth user so that, if a step
// fails part-way, the player is still signed in and can simply retry.
//
// Kept on purpose: processedPurchases records (Google Play receipts, needed for
// financial/audit purposes) and anonymous communityFeed lines (not linked to a uid).
//
// The ADMIN_UID account is refused: buyMarketCard credits that player doc on every
// sale, and deleting it would make every marketplace purchase fail.

function normalizeDisplayName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function deleteQueryInBatches(query) {
  const db = admin.firestore();
  let snap = await query.limit(400).get();
  while (!snap.empty) {
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    snap = await query.limit(400).get();
  }
}

exports.deleteMyAccount = functions
  .region(FUNCTIONS_REGION)
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Log in first.');
    }
    if (!data || data.confirm !== 'DELETE') {
      throw new functions.https.HttpsError('invalid-argument', 'Deletion was not confirmed.');
    }
    const uid = context.auth.uid;
    if (ADMIN_UID && uid === ADMIN_UID) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This is the platform admin account and cannot be deleted from the app.'
      );
    }

    const db = admin.firestore();
    const playerRef = db.collection('players').doc(uid);
    const playerSnap = await playerRef.get();
    const profile = playerSnap.exists ? (playerSnap.data() || {}) : {};

    // 1. Their marketplace listings.
    await deleteQueryInBatches(db.collection('marketplaceCards').where('authorId', '==', uid));

    // 2. Their reserved username (only if it is really theirs).
    if (profile.displayName) {
      const usernameRef = db.collection('usernames').doc(normalizeDisplayName(profile.displayName));
      const usernameSnap = await usernameRef.get();
      if (usernameSnap.exists && (usernameSnap.data() || {}).uid === uid) {
        await usernameRef.delete();
      }
    }

    // 3. Player doc and all of its subcollections.
    const subcollections = await playerRef.listCollections();
    for (const sub of subcollections) {
      await deleteQueryInBatches(sub);
    }
    await playerRef.delete();

    // 4. The Firebase Auth user (last, so a failure above can be retried).
    try {
      await admin.auth().deleteUser(uid);
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }

    return { deleted: true };
  });
