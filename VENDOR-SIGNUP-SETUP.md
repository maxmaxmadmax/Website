# Vendor Signup - setup

The page is live in the site already and works right now in **preview mode**:
every screen can be clicked through, but nothing saves and no payment can be
taken. The banner at the top of the page says so.

To switch it on you need a Firebase project and a Stripe account. These are the
steps, in order.

---

## 1. Firebase project

```bash
npm install -g firebase-tools
firebase login
firebase projects:create soundzgood-vendors      # or use an existing one
```

Then point this repository at it:

```bash
firebase use --add            # choose the project, alias it "default"
```

In the Firebase console, turn on:

- **Authentication** -> Sign-in method -> **Email/Password**
- **Firestore Database** -> create, production mode, region `australia-southeast1`
- **Storage** -> create, same region
- **Blaze plan** - Cloud Functions and outbound calls to Stripe both need it

## 2. Web config

Firebase console -> Project settings -> Your apps -> Web app -> Config.

Copy those values into **`js/firebase-config.js`**, replacing the
`REPLACE_WITH_...` placeholders. The page detects this and leaves preview mode
on its own.

Those values are not secrets and are safe in this public repository - Firestore
rules and the Cloud Functions are what protect the data. The Stripe secret key
is a different matter, see step 4.

## 3. Deploy rules and functions

```bash
cd functions && npm install && cd ..

firebase deploy --only firestore:rules,firestore:indexes,storage,functions
```

## 4. Stripe

Create the account, then set the secret key as a Functions secret. It must
never be committed:

```bash
firebase functions:secrets:set STRIPE_SECRET_KEY
```

Add the webhook in the Stripe dashboard:

- **URL** - the `stripeWebhook` function URL printed by the deploy, which looks
  like `https://australia-southeast1-<project>.cloudfunctions.net/stripeWebhook`
- **Events** - `checkout.session.completed` and `checkout.session.expired`

Copy the signing secret it gives you and set it:

```bash
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
firebase deploy --only functions        # redeploy so they pick up the secrets
```

**The webhook is what confirms a booking, not the browser redirect.** Someone
can close the tab, or type the success URL by hand; neither confirms anything.

## 5. Make yourself an admin

The first admin has to be granted before the admin page will let anyone in.
Set an allowlist, deploy, then call the function once:

```bash
firebase functions:config:set   # not needed - use an env var instead:
# in functions, set ADMIN_BOOTSTRAP_EMAILS=you@soundzgood.com.au
firebase deploy --only functions
```

Then sign in once at `/vendor-signup` with that email to create the account,
and call `setAdminRole` with `{ email: "you@soundzgood.com.au", makeAdmin: true }`.
After that, remove the bootstrap variable and redeploy.

## 6. Create the event

Open **`/vendor-admin`**, sign in, go to **Setup** and press
**Seed Event Layout**. That writes:

- the event (Eatz & Beatz Halloween Edition, 31 October 2026, Bowen Sports Complex)
- 28 sites - 12 food, 8 market 3x3, 4 market 3x6, 4 community
- 34 categories - 18 food, 16 market - each with a limit

Safe to run more than once; it never overwrites what is already there.

---

## How the important bits work

**Double bookings** - a site is only ever allocated inside a Firestore
transaction (`holdSite`, then `confirmBooking`). Two people pressing at the same
moment cannot both get it; the second gets "that site has just been taken".

**Category limits** - checked in the same transaction, not only on screen.
Raising a limit in the admin dashboard reopens the category immediately, because
the page compares the live count against the limit rather than storing a
"full" flag.

The limits the seed sets are a **starting point only**, not a rule anyone gave
me: food categories default to 2 (catch-all "Other Food" 4), market to 6
("Other Market Stall" 10). Set them to whatever you actually want before you
open bookings.

**Market stall sizes** - market sites come in 3x3 ($50) and 3x6 ($80). The size
is part of the price key (`market-3x3`, `market-3x6`) and is stamped on each
site, so a 3x3 booking cannot take a 3x6 space it has not paid for. That is
enforced in `holdSite`, not only by hiding sites on the map.

**Power and water** - this event has none on site. Every vendor confirms they
are bringing their own before they can go past the setup step, and what they
are bringing is recorded on the booking.

**The 10 minute hold** - `holdSite` stamps `holdExpiresAt`. The `expireHolds`
function runs every minute and hands back anything past its time, so an
abandoned checkout does not keep a site out of circulation.

**No bar vendors** - only food, market and community are offered anywhere in
the flow, and `holdSite` rejects any other type. SoundzGood runs the bar.

---

## Files

| File | What it is |
|---|---|
| `vendor-signup.html` | the public page, served at `/vendor-signup` |
| `vendor-signup.css` | page styles, all prefixed `.vs-` |
| `js/vendor-signup.js` | the booking flow |
| `js/vendor-map.js` | the site map, drawn as SVG from Firestore data |
| `js/firebase-config.js` | **your config goes here** |
| `vendor-admin.html` | staff dashboard, `noindex`, not in the menu |
| `js/vendor-admin.js` | dashboard logic |
| `functions/index.js` | holds, checkout, webhook, admin actions |
| `functions/lib/layout.js` | the seed layout for Bowen Sports Complex |
| `firestore.rules` | who can read and write what |
| `storage.rules` | vendor documents, own folder only |

## Changing the site layout later

The layout is **not** hard coded in the page. Sites live in Firestore at
`events/{eventId}/sites/{siteId}` with `x`, `y`, `w`, `h`, `type` and `label`,
and the map draws whatever is there. Edit them in the Firebase console or the
admin dashboard and the map updates for everyone, live.

`functions/lib/layout.js` is only the starting point used by the seed.
