# Turn on real gem payments (Razorpay + Firebase)

The app file is already wired up. These steps connect it to your bank account.

## 1. Razorpay account (this is where your bank account goes)
1. Sign up at razorpay.com, complete KYC and add your bank account (settlements are paid there).
2. Dashboard > Account & Settings > API Keys > generate **Test** keys first (Key Id + Key Secret).
3. Later, after Razorpay activates your account, generate **Live** keys and repeat step 4 with them.

## 2. Firebase project `ludo-power-cards`
- Cloud Functions needs the **Blaze (pay-as-you-go)** plan. Small usage is normally within the free quota.
- Install tools: `npm i -g firebase-tools`, then `firebase login`.

## 3. Deploy the backend
From the `payments-backend` folder:
```
firebase init functions      # choose existing project ludo-power-cards, JavaScript, keep the existing functions/ files
cd functions && npm install && cd ..
echo "RAZORPAY_KEY_ID=rzp_test_xxxxxxxx" > functions/.env
firebase functions:secrets:set RAZORPAY_KEY_SECRET
firebase functions:secrets:set RAZORPAY_WEBHOOK_SECRET     # any long random string you invent
firebase deploy --only functions
```

## 4. Razorpay webhook (covers players who pay then close the app)
Dashboard > Settings > Webhooks > Add:
- URL: the `razorpayWebhook` URL printed by the deploy (looks like `https://asia-south1-ludo-power-cards.cloudfunctions.net/razorpayWebhook`)
- Secret: the same value you set as RAZORPAY_WEBHOOK_SECRET
- Events: `payment.captured` and `order.paid`

## 5. Firestore rules (important)
Merge `firestore.rules.snippet` into your rules and publish. Without this lock, a player could edit their own `gems` from the browser console.

## 6. Test
Use Test keys and Razorpay's test UPI id `success@razorpay` or their test cards. Log in as a normal player, open Shop > Gems, buy 50 gems, and the count should rise. Check the `orders` collection shows `status: paid`.

## Notes
- To change prices, edit `PACKS` in `functions/index.js` AND the shop button labels in the HTML, then redeploy.
- Coins, boosts, dice and pieces in the shop are still display-only.
- If you publish this as an Android/iOS app on a store, the stores require their own billing for in-app digital items. Razorpay is fine for the web version.

## AI card composer (custom cards)
Players describe any card; the AI turns it into rule blocks the game already knows (revive cards, bonus turn, freeze, steal, skip turn...).
1. Get an API key at console.anthropic.com and set it: `firebase functions:secrets:set ANTHROPIC_API_KEY`
2. `firebase deploy --only functions` (deploys `composeCard` with the payment functions).
3. Merge the `cardRequests` / `aiUsage` rules from `firestore.rules.snippet`.
Each player gets 30 AI cards per day. Until the function is deployed (or if it fails), the game silently falls back to its built-in keyword composer.
Ideas that need a rule block that doesn't exist yet are saved in the `cardRequests` collection: read them in the Firebase console to see which block to add next.
To add a block: add it to `LUDO_OPS` + `ludoRunOp` in the game file, and to `OPS` (and the prompt costs) in `functions/index.js`.

## Marketplace in gems (70% you / 30% creator)
- `publishMarketCard`: costs the creator 5 gems, validates the card (rule recipes are re-checked), max 10 per day.
- `buyMarketCard`: takes the price in gems from the buyer, gives the creator 30% (rounded down, min price is 4 gems so it is at least 1), the rest is yours.
- Every sale is written to the `marketSales` collection (buyer, creator, price, creatorShare, platformShare). That is your ledger.
- Tune the numbers at the top of that section in `functions/index.js` (`PUBLISH_FEE_GEMS`, `CREATOR_SHARE`, min/max price), then `firebase deploy --only functions`.
- Merge the new `marketplaceCards` / `collection` / `marketSales` rules from `firestore.rules.snippet` so nobody can list or grant cards from the browser.
- Old listings priced in coins are shown as coins / 10 gems (minimum 4).

## Rewarded ads (Sketchware / AdMob)
The Shop's "Watch an ad" button (Goodies tab) already calls a bridge function, `ludoShowRewardedAd(placement, onReward)`,
in the game file. Right now, with no native bridge, it shows a 3-second placeholder so you can test the button and the
coin credit (+15 coins, up to 5 a day) without an AdMob account yet.

To connect it to a real AdMob rewarded ad in Sketchware:
1. Create an AdMob account, add your app, and create a **Rewarded** ad unit. Use Google's test ad unit ID first.
2. **Sketchware Pro (recommended):** add a JavaScript interface to the WebView named `AndroidAds`, with a method
   `showRewardedAd(String placement)`. When the ad finishes and the reward is granted, call:
   `webview.loadUrl("javascript:if(window.onAdReward) window.onAdReward('" + placement + "')");`
   The game file auto-detects `window.AndroidAds.showRewardedAd` and uses it instead of the placeholder — no other
   change needed on the web side.
3. **Original Sketchware (no custom JS interface):** have the button instead navigate to `ludoad://rewarded?placement=shop_coins`.
   In the WebView's "page started" / URL-loading event, catch URLs starting with `ludoad://rewarded`, stop the page
   load, show the AdMob rewarded ad, and on reward call:
   `webview.loadUrl("javascript:onAdReward('shop_coins')");`
   (You'd swap the `ludoShowRewardedAd` function's fallback in the HTML to do this `location.href` redirect instead
   of the placeholder overlay — ask me and I'll make that change once you tell me which Sketchware you're using.)
4. The coin reward itself is written from the player's browser, same as wins/losses, so a determined player could
   fake it client-side. Low priority to fix now, given the small daily cap (75 coins/day max from ads).
