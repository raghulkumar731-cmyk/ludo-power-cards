// ---------------------------------------------------------------------------
// Reference implementation — paste into functions/index.js (or its own file
// required from there) in your Firebase Functions project, then remove the
// old createGemOrder / verifyGemPayment (Razorpay) functions.
//
// CHANGE FROM THE PREVIOUS VERSION: acknowledge() -> consume(). Gem packs are
// consumable in-app products (the player can buy the same one again), and Play
// requires consume() for that — acknowledge() alone leaves the product "owned"
// and blocks a repeat purchase of the same SKU until it's consumed. consume()
// also satisfies the 3-day acknowledgement requirement on its own, so the
// separate acknowledge() call is gone.
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
//   6. Deploy: firebase deploy --only functions:verifyPlayPurchase
// ---------------------------------------------------------------------------

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { google } = require('googleapis');

if (!admin.apps.length) admin.initializeApp();

const PACKAGE_NAME = 'com.yourcompany.ludopowercards'; // TODO: your real Android package name

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
  .region('asia-south1') // must match FUNCTIONS_REGION in the web app
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
    // If we've already recorded it, never credit gems for it again — this is what stops
    // a retried or replayed client call from crediting the same purchase twice.
    const db = admin.firestore();
    const purchaseRef = db.collection('processedPurchases').doc(purchaseToken);
    const already = await purchaseRef.get();

    if (!already.exists) {
      // Ask Google directly whether this purchase is real and actually paid — never trust
      // the client's own claim about what happened in the native billing flow.
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

      // Record the token and credit gems in the same transaction, so a retry after a
      // mid-flight failure still can't double-credit.
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

    // Gems are credited now (or were on an earlier attempt for this same token). consume()
    // is what actually tells Google this purchase was delivered: it acknowledges it (so the
    // 3-day auto-refund never fires) AND clears it so the player can buy the same gem pack
    // again — acknowledge() alone would NOT allow a repeat purchase of the same SKU.
    // Calling it again on a retry is safe: Google errors harmlessly if it's already consumed,
    // and gems are never re-credited because of the idempotency check above.
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
