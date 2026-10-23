/* --------------------------------------------------------------------------
   SoundzGood - vendor signup backend

   Everything that decides something important happens here, not in the
   browser:

     - which sites are taken           (Firestore transaction)
     - whether a food category is full (same transaction)
     - whether a booking is paid       (Stripe webhook, not the redirect)

   The browser can ask for a site to be held, and can fill in its own draft,
   but it can never mark itself paid or grab a site someone else has.
   -------------------------------------------------------------------------- */

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

require('./lib/mail-log');   // every email the system sends is logged (Messages > Sent emails)
const layout = require('./lib/layout');
const { sendBookingEmails } = require('./lib/email');
const { sendQuoteEmail } = require('./lib/quote-email');
const { sendQuoteLinkEmail } = require('./lib/quote-doc-email');
const { sendLeadEmail } = require('./lib/lead-email');

/*  SEND, AND WRITE DOWN WHAT HAPPENED

    sendBookingEmails never throws - it hands back what worked and what
    did not - so the only record of a failure was a log line. The booking
    keeps the answer now, which is what the admin desk reads to say Sent,
    Failed or Not sent beside each vendor.

    The write is best effort: a booking that is paid and confirmed must not
    come undone because we could not write a status onto it.           */
async function sendAndRecord(booking, bookingId, event, ref) {
  const result = await sendBookingEmails(booking, bookingId, event);

  if (!ref) return result;

  try {
    const sent = Boolean(result && result.vendor);
    const why = (result && result.errors && result.errors.length)
      ? result.errors.join(' | ')
      : ((result && result.reason) || '');

    await ref.update({
      emailStatus: sent ? 'sent' : 'failed',
      emailAt: FieldValue.serverTimestamp(),
      emailError: sent ? FieldValue.delete() : String(why).slice(0, 500),
    });
  } catch (err) {
    logger.warn('could not record the email status', {
      bookingId, message: err && err.message,
    });
  }

  return result;
}

initializeApp();
const db = getFirestore();

// Sydney is the closest region to North Queensland that runs everything.
setGlobalOptions({ region: 'australia-southeast1', maxInstances: 10 });

/* Secrets. These never appear in the repository - they are set with
   `firebase functions:secrets:set STRIPE_SECRET_KEY` and friends. */
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

/*  Google Workspace SMTP, for the booking confirmations. SMTP_PASS is an
    app password, not the account password - Google will not accept the
    account password from a script with 2FA on. */
const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');

/* Where to send people back to after Stripe. Set with
   `firebase functions:config` style env var, or leave the default. */
const SITE_URL = process.env.SITE_URL || 'https://www.soundzgood.com.au';

/* -------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------- */

function requireAuth(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Please sign in first.');
  }
  return request.auth.uid;
}

/*  RATE LIMIT (security audit, 20 Oct 2026). The public forms need no login,
    so without this a script could flood the database or use the estimate
    bot to email strangers. Counts per visitor (by IP, hashed - no IPs are
    stored) per form, in a fixed window. rateLimits/ is closed to browsers. */
function callerIp(request) {
  const r = request.rawRequest || {};
  const fwd = String((r.headers && r.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return String(r.ip || fwd || 'unknown');
}
async function rateLimit(key, max, windowMins) {
  const ref = db.collection('rateLimits').doc(crypto.createHash('sha256').update(key).digest('hex').slice(0, 40));
  const now = Date.now();
  const win = windowMins * 60000;
  const ok = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.exists ? snap.data() : {};
    const fresh = !d.start || now - d.start >= win;
    const n = fresh ? 1 : (d.n || 0) + 1;
    tx.set(ref, { start: fresh ? now : d.start, n, expireAt: new Date((fresh ? now : d.start) + win) });
    return n <= max;
  });
  if (!ok) throw new HttpsError('resource-exhausted', 'Too many tries - please wait a while and try again, or call Max on 0422 393 022.');
}
const limitIp = (request, form, max, mins) => rateLimit(form + '|ip|' + callerIp(request), max, mins);

function requireAdmin(request) {
  requireAuth(request);
  if (request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Admins only.');
  }
  return request.auth.uid;
}

function getStripe() {
  // Required lazily so the module still loads when the secret is absent,
  // which keeps the emulator and `node --check` usable.
  const Stripe = require('stripe');
  const key = STRIPE_SECRET_KEY.value();

  if (!key) {
    throw new HttpsError(
      'failed-precondition',
      'Stripe is not configured yet. Set the STRIPE_SECRET_KEY secret.'
    );
  }

  // No apiVersion pinned - Stripe uses the account default, so this cannot
  // break by naming a version that account has not been moved to yet.
  return new Stripe(key);
}

function siteRef(eventId, siteId) {
  return db.collection('events').doc(eventId).collection('sites').doc(siteId);
}

function categoryRef(eventId, categoryId) {
  return db.collection('events').doc(eventId).collection('categories').doc(categoryId);
}

/* A short human reference, EB-4F2K9. Used on the confirmation and in admin. */
function bookingReference() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
  let out = '';
  for (let i = 0; i < 5; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `EB-${out}`;
}

/* Which kind of site a vendor type occupies. */
function siteTypeFor(vendorType) {
  return vendorType === 'food' ? 'food' : 'market';
}

/* How many bays a booking may take.
   A food van is one 6 m x 3 m site. A market stall is any joined group of
   between one and eight bays. Anything outside that is rejected rather than
   quietly clamped, so a hand-made request cannot buy nine bays for the
   price of eight. */
function checkBayCount(event, vendorType, count) {
  if (vendorType !== 'market') {
    if (count !== 1) {
      throw new HttpsError('invalid-argument', 'A food van takes one site.');
    }
    return 1;
  }

  const max = event.maxMarketBays || 8;

  if (!Number.isInteger(count) || count < 1 || count > max) {
    throw new HttpsError(
      'invalid-argument',
      `A market stall must be between 1 and ${max} bays.`
    );
  }

  return count;
}

/* Food is a flat fee. Market stalls are per bay. */
function priceFor(event, vendorType, bayCount) {
  if (!event.pricing) {
    throw new HttpsError('failed-precondition', 'No pricing is set for this event.');
  }

  if (vendorType === 'food') {
    const cents = event.pricing.food;
    if (cents == null) {
      throw new HttpsError('failed-precondition', 'No food van price is set.');
    }
    return cents;
  }

  const perBay = event.pricing.marketPerBay;
  if (perBay == null) {
    throw new HttpsError('failed-precondition', 'No market bay price is set.');
  }

  return perBay * bayCount;
}

/* -------------------------------------------------------------------------
   WHAT A VENDOR ACTUALLY PAYS

   The site price is GST exclusive. On top of it go a booking fee, which
   covers the card charges and the running costs of all this, and then GST
   on the two of them together.

       fee   = 4% of the site price, plus 99c a transaction
       GST   = 10% of (site + fee)
       total = site + fee + GST

   A $100 food site therefore comes to $115.49, of which $10.50 is GST.

   The percentage is taken off the site price only, never off the GST -
   charging a percentage on top of tax is the sort of thing a vendor works
   out with a calculator and remembers.

   THIS IS THE ONLY PLACE THESE NUMBERS LIVE. The vendor page works out the
   same figures to show people before they commit, but nothing it says is
   trusted: the total is recomputed here when the checkout session is made,
   so a tampered browser cannot change the price.

   Defaults can be overridden per event, so a fee can change without a
   deploy.
   ------------------------------------------------------------------------- */
const FEE_PERCENT = 0.04;
const FEE_FIXED_CENTS = 99;
const GST_RATE = 0.10;

function feeBreakdown(event, siteCents) {
  const site = Math.max(0, Math.round(Number(siteCents) || 0));

  /*  A free site stays free. Charging 99c and GST on a site given away
      would make "free" a lie and is not worth the 99c. */
  if (site === 0) {
    return { siteCents: 0, bookingFeeCents: 0, gstCents: 0, totalCents: 0 };
  }

  const fees = (event && event.fees) || {};
  const pct = fees.percent != null ? Number(fees.percent) : FEE_PERCENT;
  const fixed = fees.fixedCents != null ? Number(fees.fixedCents) : FEE_FIXED_CENTS;
  const gstRate = fees.gstRate != null ? Number(fees.gstRate) : GST_RATE;

  const bookingFeeCents = Math.round(site * pct) + fixed;
  const gstCents = Math.round((site + bookingFeeCents) * gstRate);

  return {
    siteCents: site,
    bookingFeeCents,
    gstCents,
    totalCents: site + bookingFeeCents + gstCents,
  };
}

/* True when a site is there to be taken - free, or already held by the
   person asking, or holding an expired hold nobody has tidied up yet. */
function siteIsFree(site, uid, now) {
  if (site.status === 'blocked' || site.status === 'booked') return false;
  if (site.status === 'held') {
    return site.heldBy === uid || holdHasExpired(site, now);
  }
  return true;
}

/*  DO TWO BAYS TOUCH?

    Side by side or one above the other, with no more than a hairline
    between them. On the Bowen plan the gap down a column is 12 units and
    the two middle columns are 16 apart, while every aisle is 120 - so a
    threshold of 20 joins the bays that really do back on to each other
    and nothing across a walkway.

    Market bays only. A food van takes one site and never joins anything,
    and two of them sit on an angle where a rectangle would lie.

    THIS RULE IS ALSO IN js/vendor-map.js, which decides what a vendor is
    allowed to click. If it changes here it has to change there, or the
    page will offer a shape this function then refuses to allocate.   */
const BAY_TOUCH_GAP = 20;

function baysTouch(a, b) {
  if (a.type !== 'market' || b.type !== 'market') return false;
  if (a.rotate || b.rotate) return false;
  if ([a.x, a.y, a.w, a.h, b.x, b.y, b.w, b.h].some((n) => typeof n !== 'number')) {
    return false;
  }

  const gapX = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
  const gapY = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));

  /*  Close on one axis while genuinely overlapping on the other -
      otherwise two bays meeting at a corner would count.           */
  if (gapX < 0 && gapY >= 0 && gapY <= BAY_TOUCH_GAP) return true;
  if (gapY < 0 && gapX >= 0 && gapX <= BAY_TOUCH_GAP) return true;

  return false;
}

/* Every bay in a group must touch another bay in the same group, or the
   stall is not one stall - it is bays scattered around the market. Walks
   out from the first bay and checks it reaches all of them.

   Two bays count as touching if the layout wrote them down as neighbours
   (up and down a column) or if their rectangles back on to each other -
   which is how a stall can straddle the two middle columns without the
   forty bays already in Firestore having to be rewritten. */
function isJoinedUp(sitesById) {
  const ids = Object.keys(sitesById);
  if (ids.length <= 1) return true;

  const neighboursOf = (site) => {
    const listed = (site.adjacentIds || []).filter((id) => sitesById[id]);
    const touching = ids.filter((id) =>
      id !== site.id &&
      !listed.includes(id) &&
      baysTouch(site, sitesById[id]));
    return [...listed, ...touching];
  };

  const seen = new Set([ids[0]]);
  const queue = [ids[0]];

  while (queue.length) {
    const site = sitesById[queue.shift()];
    for (const neighbourId of neighboursOf(site)) {
      if (!seen.has(neighbourId)) {
        seen.add(neighbourId);
        queue.push(neighbourId);
      }
    }
  }

  return seen.size === ids.length;
}

/* True when a hold has run out. Anything not held is not expired. */
function holdHasExpired(site, now) {
  if (site.status !== 'held') return false;
  if (!site.holdExpiresAt) return true;
  return site.holdExpiresAt.toMillis() <= now;
}

/* -------------------------------------------------------------------------
   holdSite

   Puts a 10 minute hold on the bays a vendor has picked - one for a food
   van, or a joined group of up to eight for a market stall.

   Runs in a transaction so two people pressing at the same moment cannot
   both come away with the same bay, and checks the category limit, the
   joined-up rule and the release wave in the same transaction. The page
   checks all three as well, but only these ones count.
   ------------------------------------------------------------------------- */
exports.holdSite = onCall(async (request) => {
  const uid = requireAuth(request);
  const { eventId, siteId, siteIds, bookingId } = request.data || {};

  // Older callers sent a single siteId; both shapes are accepted.
  const requested = Array.isArray(siteIds) && siteIds.length
    ? siteIds
    : (siteId ? [siteId] : []);

  if (!eventId || !requested.length || !bookingId) {
    throw new HttpsError('invalid-argument', 'Missing event, site or booking.');
  }

  const uniqueIds = [...new Set(requested)];
  if (uniqueIds.length !== requested.length) {
    throw new HttpsError('invalid-argument', 'That site was listed twice.');
  }

  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const eventSnap = await tx.get(db.collection('events').doc(eventId));
    if (!eventSnap.exists) {
      throw new HttpsError('not-found', 'That event does not exist.');
    }
    const event = eventSnap.data();
    if (event.status !== 'open') {
      throw new HttpsError('failed-precondition', 'Vendor signup is closed for this event.');
    }

    const bookingRef = db.collection('bookings').doc(bookingId);
    const bookingSnap = await tx.get(bookingRef);
    if (!bookingSnap.exists) {
      throw new HttpsError('not-found', 'Booking not found.');
    }
    const booking = bookingSnap.data();
    if (booking.uid !== uid) {
      throw new HttpsError('permission-denied', 'That booking belongs to someone else.');
    }
    if (booking.status === 'confirmed') {
      throw new HttpsError('failed-precondition', 'This booking is already confirmed.');
    }

    const bayCount = checkBayCount(event, booking.vendorType, uniqueIds.length);
    const wantedType = siteTypeFor(booking.vendorType);

    /* Read every requested bay inside this transaction, so the whole group
       is allocated together or not at all. A stall can never end up with
       part of its space, and two vendors can never share a bay. */
    const wantedRefs = uniqueIds.map((id) => siteRef(eventId, id));
    const wanted = [];
    const byId = {};

    for (const ref of wantedRefs) {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new HttpsError('not-found', 'One of those sites does not exist.');
      }

      const s = snap.data();
      s.id = ref.id;
      wanted.push(s);
      byId[ref.id] = s;

      // Each bay must suit the vendor type - a market stall cannot take a
      // food van site, and vice versa.
      if (s.type !== wantedType) {
        throw new HttpsError(
          'failed-precondition',
          `Site ${s.label} is a ${s.type} site.`
        );
      }

      if (s.status === 'blocked') {
        throw new HttpsError('failed-precondition', `Site ${s.label} is not available.`);
      }
      if (s.status === 'booked') {
        throw new HttpsError('already-exists', `Site ${s.label} has just been taken.`);
      }
      if (s.status === 'held' && s.heldBy !== uid && !holdHasExpired(s, now)) {
        throw new HttpsError('already-exists', `Site ${s.label} is on hold for someone else.`);
      }
    }

    // A stall is one block of bays, not bays dotted around the market.
    if (!isJoinedUp(byId)) {
      throw new HttpsError(
        'failed-precondition',
        'The bays you picked are not all next to each other. Choose a joined-up block.'
      );
    }

    /*  HOW MUCH GROUND ONE PERSON MAY SIT ON AT ONCE.

        Above, this booking gives back whatever it held before, so no single
        booking can creep. Nothing stopped somebody making a second booking
        and holding eight more bays with it, then a third, until they were
        sitting on the whole field and no real vendor could get in. Holds
        expire after ten minutes, so it heals itself - but a script that
        re-takes them every ten minutes keeps the event shut indefinitely.

        That was always possible; it just needed a fresh email address each
        time. Now that signing in costs nothing at all, it needs nothing.

        So the limit is per person, not per booking: everything this uid is
        already holding on other bookings counts against the same ceiling a
        single booking gets. One vendor with one stall never notices. */
    const others = await tx.get(
      db.collection('bookings').where('uid', '==', uid)
    );

    let heldElsewhere = 0;
    others.forEach((d) => {
      if (d.id === bookingId) return;              // this booking, handled above
      const b = d.data();
      if (b.eventId !== eventId) return;           // a different event is their business
      if (b.status === 'cancelled') return;
      const ids = Array.isArray(b.siteIds) && b.siteIds.length
        ? b.siteIds
        : (b.siteId ? [b.siteId] : []);
      heldElsewhere += ids.length;
    });

    const ceiling = Math.max(Number(event.maxMarketBays) || 8, uniqueIds.length);

    if (heldElsewhere + uniqueIds.length > ceiling) {
      logger.warn('hold ceiling hit', { uid, eventId, heldElsewhere, wanting: uniqueIds.length });
      throw new HttpsError(
        'resource-exhausted',
        'You already have sites held on another application. Finish or cancel that one first.'
      );
    }

    /* Release waves. Bays carry a tier - the first three of each column are
       tier 1, the next three tier 2, and so on - and only the lowest tier
       that still has a free bay is open. That keeps the market filling from
       the front instead of leaving gaps down the rows.

       A stall only has to *start* inside the open wave; the rest of it may
       run on past the line, so a vendor who needs eight bays is not turned
       away while the market is nearly empty. */
    if (wantedType === 'market' && wanted.some((s) => s.tier)) {
      const marketSnap = await tx.get(
        db.collection('events').doc(eventId).collection('sites').where('type', '==', 'market')
      );

      let openTier = Infinity;
      for (const doc of marketSnap.docs) {
        const s = doc.data();
        if (!s.tier) continue;
        if (!siteIsFree(s, uid, now)) continue;
        if (s.tier < openTier) openTier = s.tier;
      }

      const startsInOpenWave = wanted.some((s) => !s.tier || s.tier <= openTier);
      if (openTier !== Infinity && !startsInOpenWave) {
        throw new HttpsError(
          'failed-precondition',
          'Those bays have not been released yet. Please start from the bays ' +
          'nearer the front of the market - your stall can then run back into these.'
        );
      }
    }

    /* The category is picked after the site now, so a booking may not have
       one yet. If it does, it is checked here as well - a vendor who goes
       back and changes it should not be able to hold a site under a
       category that has since filled up. The gate that actually matters is
       in createCheckout, which is the last point before money moves. */
    let categoryName = null;
    if (booking.categoryId) {
      const catSnap = await tx.get(categoryRef(eventId, booking.categoryId));
      if (!catSnap.exists) {
        throw new HttpsError('not-found', 'That category no longer exists.');
      }
      const category = catSnap.data();

      // A food vendor cannot take a market category, or the other way
      // round, even if the request is put together by hand.
      if (category.appliesTo !== booking.vendorType) {
        throw new HttpsError(
          'failed-precondition',
          `${category.name} is not a ${booking.vendorType} category.`
        );
      }

      // Count this vendor's own in-flight hold only once.
      const alreadyCounted = booking.countedCategoryId === booking.categoryId;
      if (!alreadyCounted && category.count >= category.limit) {
        throw new HttpsError(
          'resource-exhausted',
          `${category.name} is full for this event.`
        );
      }
      categoryName = category.name;
    }

    /* Let go of whatever this booking held before, including any bays it is
       not keeping. Everything is read before anything is written,
       because a Firestore transaction will not read after a write. */
    const previous = Array.isArray(booking.siteIds) && booking.siteIds.length
      ? booking.siteIds
      : (booking.siteId ? [booking.siteId] : []);

    const toRelease = [];
    for (const oldId of previous) {
      if (wantedRefs.some((r) => r.id === oldId)) continue; // keeping this one
      const oldRef = siteRef(eventId, oldId);
      const oldSnap = await tx.get(oldRef);
      if (oldSnap.exists && oldSnap.data().heldBy === uid && oldSnap.data().status === 'held') {
        toRelease.push(oldRef);
      }
    }

    for (const ref of toRelease) {
      tx.update(ref, {
        status: 'available',
        heldBy: FieldValue.delete(),
        holdExpiresAt: FieldValue.delete(),
        bookingId: FieldValue.delete(),
      });
    }

    const holdMinutes = event.holdMinutes || 10;
    const expiresAt = Timestamp.fromMillis(now + holdMinutes * 60 * 1000);

    for (const ref of wantedRefs) {
      tx.update(ref, {
        status: 'held',
        heldBy: uid,
        bookingId,
        holdExpiresAt: expiresAt,
      });
    }

    const heldIds = wantedRefs.map((r) => r.id);
    const siteLabel = wanted.map((s) => s.label).join(' + ');
    const amountCents = priceFor(event, booking.vendorType, bayCount);

    /*  Worked out as soon as the price is known, so the review screen, the
        admin list and the receipt all quote the same figures. Recomputed
        again at checkout, which is the one that decides what is charged. */
    const money = feeBreakdown(event, amountCents);

    tx.update(bookingRef, {
      siteId: heldIds[0],     // first bay, kept for anything reading one id
      siteIds: heldIds,       // every bay this booking holds
      siteLabel,              // "M4" or "M4 + M5 + M6"
      siteType: wantedType,
      bayCount,               // set from the bays taken, never from the client
      categoryName,
      amountCents,                                 // the site itself, ex GST
      bookingFeeCents: money.bookingFeeCents,
      gstCents: money.gstCents,
      totalCents: money.totalCents,                // what they actually pay
      currency: event.currency || 'aud',
      holdExpiresAt: expiresAt,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      siteLabel,
      siteIds: heldIds,
      bayCount,
      holdExpiresAt: expiresAt.toMillis(),
      amountCents,
    };
  });
});

/* -------------------------------------------------------------------------
   releaseHold - when someone backs out of the map step.
   ------------------------------------------------------------------------- */
exports.releaseHold = onCall(async (request) => {
  const uid = requireAuth(request);
  const { eventId, siteId, siteIds } = request.data || {};

  const wanted = Array.isArray(siteIds) && siteIds.length
    ? siteIds
    : (siteId ? [siteId] : []);

  if (!eventId || !wanted.length) {
    throw new HttpsError('invalid-argument', 'Missing event or site.');
  }

  await db.runTransaction(async (tx) => {
    const refs = wanted.map((id) => siteRef(eventId, id));
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));

    const mine = [];
    snaps.forEach((snap, i) => {
      if (!snap.exists) return;
      const site = snap.data();
      if (site.status === 'held' && site.heldBy === uid) {
        mine.push({ ref: refs[i], bookingId: site.bookingId });
      }
    });

    if (!mine.length) return;

    /*  The booking has to forget these sites too, not just the sites forget
        the booking. Leaving siteIds behind on the booking leaves a vendor
        looking like they are holding ground they gave back - which reads
        wrong in the admin list, and counts against the per-person ceiling
        in holdSite, locking them out of their own event.

        Read the bookings before writing anything, as ever. */
    const bookingIds = [...new Set(mine.map((m) => m.bookingId).filter(Boolean))];
    const bookingRefs = bookingIds.map((id) => db.collection('bookings').doc(id));
    const bookingSnaps = await Promise.all(bookingRefs.map((r) => tx.get(r)));

    // ---- reads done, writes from here ----

    mine.forEach(({ ref }) => {
      tx.update(ref, {
        status: 'available',
        heldBy: FieldValue.delete(),
        holdExpiresAt: FieldValue.delete(),
        bookingId: FieldValue.delete(),
      });
    });

    bookingSnaps.forEach((snap, i) => {
      if (!snap.exists) return;
      const b = snap.data();
      if (b.uid !== uid) return;              // not theirs to touch
      if (b.status === 'confirmed') return;   // paid for; leave it alone

      const keeping = (Array.isArray(b.siteIds) ? b.siteIds : [b.siteId])
        .filter(Boolean)
        .filter((id) => !wanted.includes(id));

      tx.update(bookingRefs[i], keeping.length
        ? { siteId: keeping[0], siteIds: keeping, updatedAt: FieldValue.serverTimestamp() }
        : {
            siteId: FieldValue.delete(),
            siteIds: FieldValue.delete(),
            siteLabel: FieldValue.delete(),
            holdExpiresAt: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          });
    });
  });

  return { ok: true };
});

/* -------------------------------------------------------------------------
   createCheckout

   A booking that costs nothing is confirmed here and never touches Stripe.
   Nothing is free by default any more, but an admin can price something at
   zero, and this keeps working if they do.
   Paid bookings get a Stripe Checkout session; the booking is only marked
   paid later by the webhook.
   ------------------------------------------------------------------------- */
exports.createCheckout = onCall(
  { secrets: [STRIPE_SECRET_KEY, SMTP_USER, SMTP_PASS] },
  async (request) => {
  const uid = requireAuth(request);
  const { bookingId, termsAccepted, termsVersion } = request.data || {};

  if (!bookingId) {
    throw new HttpsError('invalid-argument', 'Missing booking.');
  }

  const bookingRef = db.collection('bookings').doc(bookingId);
  const snap = await bookingRef.get();

  if (!snap.exists) throw new HttpsError('not-found', 'Booking not found.');
  const booking = snap.data();

  if (booking.uid !== uid) {
    throw new HttpsError('permission-denied', 'That booking belongs to someone else.');
  }
  if (booking.status === 'confirmed') {
    return { ok: true, alreadyConfirmed: true };
  }
  if (!booking.siteId) {
    throw new HttpsError('failed-precondition', 'Choose a site first.');
  }

  /* The Vendor Terms tick. Nothing moves to payment (or free confirmation)
     without it, and we keep when and which version was agreed. Keep the
     version in step with js/vendor-terms-data.js. */
  if (termsAccepted !== true) {
    throw new HttpsError('failed-precondition',
      'Please agree to the Eatz & Beatz Vendor Terms & Conditions first.');
  }
  await bookingRef.update({
    termsAcceptedAt: FieldValue.serverTimestamp(),
    termsVersion: String(termsVersion || '').slice(0, 60),
  });

  /* The category limit is checked here, right before money moves. The site
     is chosen earlier in the flow than the category, so holdSite cannot be
     the last word on it - and two vendors sitting on the last space in a
     category would otherwise both be able to pay. Reading and stamping the
     category name in one transaction means whoever gets here second is
     turned away before Stripe is ever called. */
  const categoryName = await db.runTransaction(async (tx) => {
    if (!booking.categoryId) {
      throw new HttpsError('failed-precondition', 'Choose a category first.');
    }

    const catSnap = await tx.get(categoryRef(booking.eventId, booking.categoryId));
    if (!catSnap.exists) {
      throw new HttpsError('not-found', 'That category no longer exists.');
    }

    const category = catSnap.data();

    if (category.appliesTo !== booking.vendorType) {
      throw new HttpsError(
        'failed-precondition',
        `${category.name} is not a ${booking.vendorType} category.`
      );
    }

    // A booking already counted against this category keeps its place.
    const alreadyCounted = booking.countedCategoryId === booking.categoryId;
    if (!alreadyCounted && category.count >= category.limit) {
      throw new HttpsError(
        'resource-exhausted',
        `${category.name} is full for this event. Please choose another category.`
      );
    }

    tx.update(bookingRef, { categoryName: category.name });
    return category.name;
  });

  /*  What the vendor will see on their card statement and receipt. Read off
      the event so it stays right when there is more than one. */
  const eventSnapshot = await db.collection('events').doc(booking.eventId).get();
  const eventForBooking = eventSnapshot.exists ? eventSnapshot.data() : {};

  /*  THE PRICE IS DERIVED HERE, NOT READ OFF THE BOOKING.

      amountCents on the document is written by holdSite and the Firestore
      rules stop a vendor changing it. That is worth having, but it should
      not be the only thing between somebody and a one dollar stall: a
      single mistake in those rules would otherwise be worth real money.

      So the site price is worked out again from the event's own pricing
      and the number of bays they are actually holding, and the fee and GST
      from that. Editing amountCents in a browser now achieves nothing,
      because nothing here reads it. */
  const bayIds = Array.isArray(booking.siteIds) && booking.siteIds.length
    ? booking.siteIds
    : (booking.siteId ? [booking.siteId] : []);

  if (!bayIds.length) {
    throw new HttpsError('failed-precondition', 'Choose a site first.');
  }

  /*  VALIDATE AGAINST THE HELD SITES, NOT THE BOOKING.

      vendorType and eventId are the two pricing inputs a vendor can
      still edit on their own draft - the rules lock the money and the
      site, but not these. So neither is trusted here: the sites they are
      holding are read back, and they were validated by holdSite (right
      type, right event, actually free) when they were held.

      A booking whose event was flipped has no such site under the new
      event; a booking whose type was flipped is holding sites of the
      wrong type. Either way this refuses before Stripe is called.    */
  const wantedType = siteTypeFor(booking.vendorType);
  const heldSnaps = await Promise.all(
    bayIds.map((id) => siteRef(booking.eventId, id).get())
  );

  heldSnaps.forEach((snap, i) => {
    if (!snap.exists) {
      throw new HttpsError('failed-precondition',
        `Site ${bayIds[i]} is not part of this event. Please choose your site again.`);
    }
    const site = snap.data();
    if (site.heldBy !== uid || site.status !== 'held') {
      throw new HttpsError('failed-precondition',
        `Site ${bayIds[i]} is not being held for you. Please choose your site again.`);
    }
    if (site.type !== wantedType) {
      throw new HttpsError('failed-precondition',
        `Site ${bayIds[i]} is a ${site.type} site, not a ${booking.vendorType} one.`);
    }
  });

  const heldBays = bayIds.length;
  const siteCents = priceFor(eventForBooking, booking.vendorType, heldBays);
  const money = feeBreakdown(eventForBooking, siteCents);
  const amount = money.totalCents;

  /*  If that disagrees with what the booking says, the booking is stale or
      has been tampered with. The charge follows this figure either way;
      the log is so it is visible if it ever happens. */
  if (booking.amountCents != null && booking.amountCents !== siteCents) {
    logger.warn('booking price did not match a fresh calculation', {
      bookingId, onBooking: booking.amountCents, recomputed: siteCents,
    });
  }

  // ---- Nothing to pay -----------------------------------------------------
  if (amount === 0) {
    await confirmAndNotify(bookingId, { paymentStatus: 'free' });
    return { ok: true, free: true };
  }

  // ---- Paid: hand off to Stripe -----------------------------------------

  /*  THE HOLD HAS TO OUTLIVE THE CHECKOUT SESSION.

      The browsing hold is 10 minutes, which is right for somebody picking a
      spot on the map. It is far too short once they are on Stripe's payment
      page: Stripe will not accept an expires_at less than 30 minutes away,
      so a 10 minute hold means expireHolds hands the site back while they
      are still typing their card in. Somebody else takes it, the first
      vendor pays anyway, and confirmBooking finds the site gone - money
      taken, refund owed, and a vendor with nowhere to stand.

      So the hold is pushed out past the session before the session is made.
      Extending first means the site is never held for less time than the
      vendor has to pay; if the Stripe call then fails, the site is simply
      held a bit longer than needed and expireHolds tidies it up. */
  const CHECKOUT_MINUTES = 30;             // Stripe's own minimum
  const HOLD_MARGIN_MINUTES = 5;           // webhook and clock-skew slack

  const sessionExpiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60;
  const holdUntil = Timestamp.fromMillis(
    (sessionExpiresAt + HOLD_MARGIN_MINUTES * 60) * 1000
  );

  /*  bayIds is the validated list from the price check above - the same
      sites, reused to push their hold out past the Stripe session.   */
  await Promise.all([
    ...bayIds.map((id) =>
      siteRef(booking.eventId, id).update({ holdExpiresAt: holdUntil })),
    bookingRef.update({ holdExpiresAt: holdUntil }),
  ]);

  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: booking.business?.email || undefined,
    client_reference_id: bookingId,
    metadata: {
      bookingId,
      eventId: booking.eventId,
      siteId: booking.siteId,
      uid,
    },
    /*  Three lines, not one total. These vendors are businesses claiming
        the GST back, so the receipt has to show the GST on its own to work
        as a tax invoice - and a fee that turns up as part of one lump is
        how you get an argument at the gate. */
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: booking.currency || 'aud',
          unit_amount: money.siteCents,
          product_data: {
            name: `${vendorTypeLabel(booking.vendorType)} site - ${booking.siteLabel}`
              + (categoryName ? ` (${categoryName})` : ''),
            // Read off the event, not hardcoded - a second event would
            // otherwise sell sites described as the first one.
            description: eventBlurb(eventForBooking),
          },
        },
      },
      {
        quantity: 1,
        price_data: {
          currency: booking.currency || 'aud',
          unit_amount: money.bookingFeeCents,
          product_data: {
            name: 'Booking fee',
            description: 'Card processing and online booking costs',
          },
        },
      },
      {
        quantity: 1,
        price_data: {
          currency: booking.currency || 'aud',
          unit_amount: money.gstCents,
          product_data: {
            name: 'GST (10%)',
            /*  Say what it is 10% OF. Stripe shows the three lines but no
                subtotal, so on its own $5.30 is neither a tenth of the
                $50 site nor of the $58.29 total, and it reads like an
                error to anybody who checks it. */
            description: 'Goods and services tax - 10% of '
              + `$${((money.siteCents + money.bookingFeeCents) / 100).toFixed(2)}`
              + ' (site fee plus booking fee)',
          },
        },
      },
    ],
    success_url: `${SITE_URL}/vendor-signup?booking=${bookingId}&paid=1`,
    cancel_url: `${SITE_URL}/vendor-signup?booking=${bookingId}&cancelled=1`,
    // The hold above was already pushed out past this, so the site cannot
    // be handed to somebody else while this session is still payable.
    expires_at: sessionExpiresAt,
  });

  await bookingRef.update({
    status: 'pending_payment',
    paymentStatus: 'unpaid',
    stripeSessionId: session.id,
    // the figures actually sent to Stripe, so the record matches the receipt
    bookingFeeCents: money.bookingFeeCents,
    gstCents: money.gstCents,
    totalCents: money.totalCents,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { ok: true, url: session.url };
});

function vendorTypeLabel(type) {
  if (type === 'food') return 'Food vendor';
  if (type === 'market') return 'Market stall';
  return 'Community group';
}

/* One line naming the event, for the Stripe receipt. */
function eventBlurb(event) {
  const parts = [event.name, event.venue, event.dateLabel].filter(Boolean);
  return parts.length ? parts.join(', ') : 'SoundzGood event';
}

/* -------------------------------------------------------------------------
   confirmBooking - the only place a booking becomes confirmed.

   Marks the site booked and bumps the category count, in one transaction.
   Safe to call twice: if the booking is already confirmed it does nothing,
   which matters because Stripe can deliver a webhook more than once.
   ------------------------------------------------------------------------- */
/*  CONFIRM, THEN TELL PEOPLE.

    Everything calls this rather than confirmBooking directly, so there is
    one path from "the money arrived" to "the vendor has their invoice".

    The email goes out after the transaction has committed, never inside
    it. A transaction can be retried, and sending mail from something that
    might run twice is how a vendor ends up with four receipts.

    It also cannot fail the booking. By the time we are here the money is
    taken and the site is theirs; a mail server having a bad afternoon is a
    nuisance, losing that is not. Every failure is logged and swallowed.

    Sent once: confirmationEmailAt is stamped on the booking, and Stripe
    delivering the same webhook twice finds it already set.
    ------------------------------------------------------------------------- */
async function confirmAndNotify(bookingId, extra = {}) {
  const result = await confirmBooking(bookingId, extra);

  // nothing was confirmed - a duplicate webhook, or a site taken first
  if (!result || result.ok === false || result.alreadyConfirmed) return result;

  // the vendor's tax invoice number + private link, ready for the Sales Pipeline.
  // Only makes the invoice - it is NOT emailed (Max sends those himself, for now).
  try { await ensureVendorInvoice(bookingId); }
  catch (err) { logger.warn('vendor invoice number failed', { bookingId, message: err && err.message }); }

  try {
    const ref = db.collection('bookings').doc(bookingId);
    const snap = await ref.get();
    if (!snap.exists) return result;

    const booking = snap.data();
    if (booking.confirmationEmailAt) return result;   // already told them

    const evSnap = await db.collection('events').doc(booking.eventId).get();
    const event = evSnap.exists ? evSnap.data() : {};

    /*  AUTO-SEND (Max, 19 Oct 2026): the vendor gets the tax invoice & event
        guide email (one email, not two); the office still gets its copy.
        confirmationEmailAt is the "already told them" guard above.       */
    await sendBookingEmails(booking, bookingId, event, { officeOnly: true });
    // paused in the Messages page? then no vendor email (the office copy still went)
    if (await invoiceEmailPaused(booking.eventId)) return result;
    const mail = await sendVendorInvoice(bookingId, {});
    await ref.update({
      emailStatus: mail.sent ? 'sent' : 'failed',
      emailAt: FieldValue.serverTimestamp(),
      ...(mail.sent ? { confirmationEmailAt: FieldValue.serverTimestamp() } : { emailError: String(mail.error || mail.reason || '').slice(0, 500) }),
    });
  } catch (err) {
    logger.error('confirmation email step failed, booking is still confirmed', {
      bookingId, message: err && err.message,
    });
  }

  return result;
}

async function confirmBooking(bookingId, extra = {}) {
  return db.runTransaction(async (tx) => {
    const bookingRef = db.collection('bookings').doc(bookingId);
    const snap = await tx.get(bookingRef);

    if (!snap.exists) {
      logger.warn('confirmBooking: booking missing', { bookingId });
      return { ok: false, reason: 'missing' };
    }

    const booking = snap.data();

    // Idempotency. A repeated webhook must not double count a category.
    if (booking.status === 'confirmed') {
      return { ok: true, alreadyConfirmed: true };
    }

    // A 3x6 stall holds two bays, so confirm every one of them.
    const bayIds = Array.isArray(booking.siteIds) && booking.siteIds.length
      ? booking.siteIds
      : (booking.siteId ? [booking.siteId] : []);

    if (!bayIds.length) {
      throw new Error(`Booking ${bookingId} has no site to confirm`);
    }

    const refs = bayIds.map((id) => siteRef(booking.eventId, id));
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));

    for (let i = 0; i < snaps.length; i++) {
      if (!snaps[i].exists) {
        throw new Error(`Site ${bayIds[i]} vanished while confirming ${bookingId}`);
      }
    }

    // If someone else got there first on any bay, do not silently double
    // book. The booking is flagged so an admin can refund and re-seat them.
    const stolen = snaps.find((s) => {
      const d = s.data();
      return d.status === 'booked' && d.bookingId !== bookingId;
    });

    if (stolen) {
      tx.update(bookingRef, {
        status: 'needs_attention',
        paymentStatus: extra.paymentStatus || 'paid',
        problem: 'Site was taken before payment completed. Needs a new site or a refund.',
        updatedAt: FieldValue.serverTimestamp(),
        ...stripeFields(extra),
      });
      logger.error('Site taken before payment settled', { bookingId, bayIds });
      return { ok: false, reason: 'site-taken' };
    }

    // Count the category now that the booking is real.
    if (booking.categoryId && !booking.countedCategoryId) {
      const catRef = categoryRef(booking.eventId, booking.categoryId);
      const catSnap = await tx.get(catRef);
      if (catSnap.exists) {
        tx.update(catRef, {
          count: FieldValue.increment(1),
        });
      }
    }

    for (const ref of refs) {
      tx.update(ref, {
        status: 'booked',
        bookingId,
        heldBy: FieldValue.delete(),
        holdExpiresAt: FieldValue.delete(),
      });
    }

    tx.update(bookingRef, {
      status: 'confirmed',
      paymentStatus: extra.paymentStatus || 'paid',
      countedCategoryId: booking.categoryId || null,
      reference: booking.reference || bookingReference(),
      confirmedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      holdExpiresAt: FieldValue.delete(),
      ...stripeFields(extra),
    });

    return { ok: true };
  });
}

function stripeFields(extra) {
  const out = {};
  if (extra.stripePaymentIntentId) out.stripePaymentIntentId = extra.stripePaymentIntentId;
  if (extra.amountPaidCents != null) out.amountPaidCents = extra.amountPaidCents;
  return out;
}

/* -------------------------------------------------------------------------
   stripeWebhook

   The source of truth for payment. The browser redirect after checkout is
   only a convenience - a vendor could close the tab, or hit the success URL
   by hand, so nothing is confirmed on the strength of it.
   ------------------------------------------------------------------------- */
/*  A quote paid by card: accept it and add the payment. Idempotent per
    Stripe session, so a webhook retry can't count the money twice.   */
async function recordQuotePayment(session) {
  const ref = db.collection('quotes').doc(String(session.metadata.quoteId));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const q = snap.data();
    const seen = Array.isArray(q.stripeSessions) ? q.stripeSessions : [];
    if (seen.includes(session.id)) return;
    const paidNow = (q.amountPaidCents || 0) + (session.amount_total || 0);
    const fullyPaid = paidNow >= quoteGrandTotal(q);   // includes any late payment charges
    // accept = invoice: take an invoice number the first time money comes in
    const num = q.invoiceNumber ? null : await nextInvoiceNumber(tx);
    if (num) num.write();
    tx.update(ref, {
      status: fullyPaid ? 'paid' : 'invoiced',
      kind: 'invoice',
      ...(num ? { invoiceNumber: invoiceNo(num.n), invoicedAt: FieldValue.serverTimestamp() } : {}),
      ...(fullyPaid ? { paidAt: FieldValue.serverTimestamp() } : {}),
      acceptedName: q.acceptedName || session.metadata.acceptedName || '',
      acceptedAt: q.acceptedAt || FieldValue.serverTimestamp(),
      paymentMethod: 'card',
      paymentStatus: fullyPaid ? 'paid' : 'deposit',
      amountPaidCents: paidNow,
      stripeSessions: [...seen, session.id],
      lastPaidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  logger.info('Quote payment recorded', { quoteId: session.metadata.quoteId, cents: session.amount_total });
}

exports.stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SMTP_USER, SMTP_PASS], cors: false },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed');
      return;
    }

    const Stripe = require('stripe');
    const stripe = new Stripe(STRIPE_SECRET_KEY.value());

    let event;
    try {
      // rawBody is required - the parsed body will not verify.
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers['stripe-signature'],
        STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (err) {
      logger.error('Stripe signature check failed', err);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    const bookingOf = (session) =>
      session.client_reference_id || session.metadata?.bookingId;

    try {
      switch (event.type) {
        /*  A card pays straight away and arrives here already paid. A
            delayed method - BECS direct debit, which is the common one in
            Australia - arrives here unpaid and settles days later as
            async_payment_succeeded. Both routes have to confirm, or the
            money lands in the account and the vendor is never given their
            site. */
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded': {
          const session = event.data.object;

          // A quote payment (quoteCheckout), not a vendor booking.
          if (session.metadata && session.metadata.quoteId) {
            if (session.payment_status === 'paid') {
              await recordQuotePayment(session);
              await autoGearOnDeposit(String(session.metadata.quoteId));   // gear list out once the deposit is in
            }
            break;
          }
          const bookingId = bookingOf(session);

          if (!bookingId) {
            logger.warn('Checkout completed with no booking reference', { id: session.id });
            break;
          }

          if (session.payment_status === 'paid') {
            await confirmAndNotify(bookingId, {
              paymentStatus: 'paid',
              stripePaymentIntentId: session.payment_intent,
              amountPaidCents: session.amount_total,
            });
            logger.info('Booking confirmed by webhook', { bookingId, via: event.type });
          } else {
            /*  Completed but not paid yet: a direct debit on its way. The
                site stays held rather than being handed to somebody else
                while their bank moves the money. */
            logger.info('Checkout completed, payment still pending', {
              bookingId, status: session.payment_status,
            });
          }
          break;
        }

        /* Their bank refused it. The site goes back on the market. */
        case 'checkout.session.async_payment_failed': {
          const bookingId = bookingOf(event.data.object);
          if (bookingId) {
            await releaseBookingHold(bookingId);
            logger.warn('Delayed payment failed, hold released', { bookingId });
          }
          break;
        }

        case 'checkout.session.expired': {
          const bookingId = bookingOf(event.data.object);
          if (bookingId) {
            await releaseBookingHold(bookingId);
            logger.info('Checkout expired, hold released', { bookingId });
          }
          break;
        }

        default:
          break;
      }

      res.json({ received: true });
    } catch (err) {
      logger.error('Webhook handler failed', err);
      // 500 so Stripe retries rather than dropping the event.
      res.status(500).send('Handler error');
    }
  }
);

/* Puts a site back after an abandoned or expired checkout. */
async function releaseBookingHold(bookingId) {
  return db.runTransaction(async (tx) => {
    const bookingRef = db.collection('bookings').doc(bookingId);
    const snap = await tx.get(bookingRef);
    if (!snap.exists) return;

    const booking = snap.data();
    if (booking.status === 'confirmed') return;

    // Give back every bay, not only the first - a 3x6 holds two.
    const bayIds = Array.isArray(booking.siteIds) && booking.siteIds.length
      ? booking.siteIds
      : (booking.siteId ? [booking.siteId] : []);

    if (!bayIds.length) return;

    const refs = bayIds.map((id) => siteRef(booking.eventId, id));
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));

    snaps.forEach((siteSnap, i) => {
      if (siteSnap.exists && siteSnap.data().status === 'held' &&
          siteSnap.data().bookingId === bookingId) {
        tx.update(refs[i], {
          status: 'available',
          heldBy: FieldValue.delete(),
          holdExpiresAt: FieldValue.delete(),
          bookingId: FieldValue.delete(),
        });
      }
    });

    tx.update(bookingRef, {
      status: 'draft',
      paymentStatus: 'none',
      siteId: FieldValue.delete(),
      siteIds: FieldValue.delete(),
      siteLabel: FieldValue.delete(),
      holdExpiresAt: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

/* -------------------------------------------------------------------------
   expireHolds - every minute, hand back anything whose 10 minutes ran out.
   ------------------------------------------------------------------------- */
exports.expireHolds = onSchedule('every 1 minutes', async () => {
  const now = Timestamp.now();

  const stale = await db
    .collectionGroup('sites')
    .where('status', '==', 'held')
    .where('holdExpiresAt', '<=', now)
    .limit(200)
    .get();

  if (stale.empty) return;

  let released = 0;

  for (const doc of stale.docs) {
    try {
      await db.runTransaction(async (tx) => {
        /*  EVERY READ FIRST.

            A Firestore transaction will not accept a read after a write, so
            the booking has to be fetched up here even though it is written
            last. Updating the site first and then reading the booking threw
            on every single site, which is why nothing was ever released. */
        const fresh = await tx.get(doc.ref);
        if (!fresh.exists) return;

        const site = fresh.data();
        if (site.status !== 'held') return;
        if (site.holdExpiresAt && site.holdExpiresAt.toMillis() > Date.now()) return;

        const bRef = site.bookingId
          ? db.collection('bookings').doc(site.bookingId)
          : null;
        const bSnap = bRef ? await tx.get(bRef) : null;

        // ---- reads done, writes from here ----

        tx.update(doc.ref, {
          status: 'available',
          heldBy: FieldValue.delete(),
          holdExpiresAt: FieldValue.delete(),
          bookingId: FieldValue.delete(),
          waitlistHold: FieldValue.delete(),
        });

        if (bSnap && bSnap.exists && bSnap.data().status !== 'confirmed') {
          tx.update(bRef, {
            status: 'draft',
            paymentStatus: 'none',
            siteId: FieldValue.delete(),
            siteIds: FieldValue.delete(),
            siteLabel: FieldValue.delete(),
            holdExpiresAt: FieldValue.delete(),
          });
        }
      });
      released++;
    } catch (err) {
      /*  err on its own serialises to {} in structured logging, which is how
          the read-after-write above stayed invisible. Log the message. */
      logger.error('Could not release hold', {
        site: doc.ref.path,
        message: err && err.message,
      });
    }
  }

  logger.info(`Released ${released} expired hold(s)`);
});

/* -------------------------------------------------------------------------
   Admin
   ------------------------------------------------------------------------- */

/* Creates the event, its sites and its categories from the seed layout.
   Safe to run again - it will not overwrite sites that already exist. */
exports.seedEvent = onCall(async (request) => {
  const eventId = (request.data && request.data.eventId) || 'eatz-beatz-halloween-2026';

  const eventRef = db.collection('events').doc(eventId);
  const existing = await eventRef.get();

  /*  FIRST RUN ONLY.

      Seeding normally needs an admin. But the very first seed cannot: an
      admin is granted to a signed-in account, an account is created on the
      vendor page, and the vendor page cannot be got through until there
      are categories to choose from - which is what seeding creates. A
      circle with no way in.

      So the first seed, and only the first, is allowed without a sign-in:
      when the event does not exist yet and the id is the one this site is
      built around. The moment that document exists this is an admin-only
      function again, for good. Nothing here reads or returns data, and it
      writes the same fixed layout every time, so the worst an anonymous
      call can do is create the layout we were going to create anyway. */
  const bootstrapping =
    !existing.exists && eventId === 'eatz-beatz-halloween-2026';

  if (!bootstrapping) {
    requireAdmin(request);
  } else {
    logger.warn('seedEvent ran without a sign-in - first run bootstrap', { eventId });
  }

  const batch = db.batch();

  if (!existing.exists) {
    batch.set(eventRef, {
      ...layout.defaultEvent(),
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  const sites = layout.defaultSites();
  const existingSites = await eventRef.collection('sites').get();
  const have = new Set(existingSites.docs.map((d) => d.id));

  let addedSites = 0;
  for (const site of sites) {
    if (have.has(site.id)) continue;
    batch.set(eventRef.collection('sites').doc(site.id), site);
    addedSites++;
  }

  const cats = layout.defaultCategories();
  const existingCats = await eventRef.collection('categories').get();
  const haveCats = new Set(existingCats.docs.map((d) => d.id));

  let addedCats = 0;
  for (const cat of cats) {
    if (haveCats.has(cat.id)) continue;
    batch.set(eventRef.collection('categories').doc(cat.id), { ...cat, count: 0 });
    addedCats++;
  }

  await batch.commit();

  return { ok: true, eventId, addedSites, addedCats, eventCreated: !existing.exists };
});

/* Grants or removes admin. The very first admin has to be set by hand with
   the Admin SDK or by listing an email in ADMIN_BOOTSTRAP_EMAILS. */
exports.setAdminRole = onCall(async (request) => {
  const bootstrap = (process.env.ADMIN_BOOTSTRAP_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  /*  An anonymous token has no email, so callerEmail is '' - and '' must
      never match its way onto the bootstrap list. filter(Boolean) above
      already strips blank entries, so an empty list cannot include '';
      this makes that a rule rather than a happy accident, because the
      whole internet holds a valid token now that anonymous sign-in is on. */
  const callerEmail = (request.auth?.token?.email || '').toLowerCase();
  const callerIsBootstrap = Boolean(callerEmail) && bootstrap.includes(callerEmail);

  if (!callerIsBootstrap) {
    requireAdmin(request);
  } else {
    requireAuth(request);
  }

  const { email, makeAdmin } = request.data || {};
  if (!email) throw new HttpsError('invalid-argument', 'Need an email address.');

  const user = await getAuth().getUserByEmail(email);
  await getAuth().setCustomUserClaims(user.uid, { admin: makeAdmin !== false });

  return { ok: true, uid: user.uid, admin: makeAdmin !== false };
});

/* Admin: free a site by hand, or block one off. */
exports.adminSetSiteStatus = onCall(async (request) => {
  requireAdmin(request);
  const { eventId, siteId, status } = request.data || {};

  if (!['available', 'blocked'].includes(status)) {
    throw new HttpsError('invalid-argument', 'Status must be available or blocked.');
  }

  await siteRef(eventId, siteId).update({
    status,
    heldBy: FieldValue.delete(),
    holdExpiresAt: FieldValue.delete(),
    bookingId: FieldValue.delete(),
  });

  return { ok: true };
});

/* Admin: change a category limit. Raising it reopens the category on its
   own, because the frontend compares count against limit. */
exports.adminSetCategoryLimit = onCall(async (request) => {
  requireAdmin(request);
  const { eventId, categoryId, limit } = request.data || {};

  const value = Number(limit);
  if (!Number.isInteger(value) || value < 0) {
    throw new HttpsError('invalid-argument', 'Limit must be a whole number, zero or more.');
  }

  await categoryRef(eventId, categoryId).update({ limit: value });
  return { ok: true, limit: value };
});

/* Admin: cancel a confirmed booking and give the site back. Does not refund;
   do that in Stripe so there is a record on their side too. */
exports.adminCancelBooking = onCall(async (request) => {
  requireAdmin(request);
  const { bookingId } = request.data || {};
  if (!bookingId) throw new HttpsError('invalid-argument', 'Missing booking.');

  await db.runTransaction(async (tx) => {
    const bRef = db.collection('bookings').doc(bookingId);
    const snap = await tx.get(bRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Booking not found.');

    const booking = snap.data();

    // Release every bay the booking held, a 3x6 included.
    const bayIds = Array.isArray(booking.siteIds) && booking.siteIds.length
      ? booking.siteIds
      : (booking.siteId ? [booking.siteId] : []);

    const bayRefs = bayIds.map((id) => siteRef(booking.eventId, id));

    /*  Every read first - a transaction refuses a read that follows a write.
        The category has to be fetched up here, before the bays are handed
        back, or the whole cancel throws. */
    const baySnaps = await Promise.all(bayRefs.map((r) => tx.get(r)));

    const catRef = booking.countedCategoryId
      ? categoryRef(booking.eventId, booking.countedCategoryId)
      : null;
    const catSnap = catRef ? await tx.get(catRef) : null;

    // ---- reads done, writes from here ----

    baySnaps.forEach((siteSnap, i) => {
      if (siteSnap.exists && siteSnap.data().bookingId === bookingId) {
        tx.update(bayRefs[i], {
          status: 'available',
          bookingId: FieldValue.delete(),
          heldBy: FieldValue.delete(),
          holdExpiresAt: FieldValue.delete(),
        });
      }
    });

    if (catSnap && catSnap.exists && catSnap.data().count > 0) {
      tx.update(catRef, { count: FieldValue.increment(-1) });
    }

    tx.update(bRef, {
      status: 'cancelled',
      cancelledAt: FieldValue.serverTimestamp(),
      countedCategoryId: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { ok: true };
});


/* =========================================================================
   THE ADMIN BACKEND

   Everything below is driven by /admin. None of it can be reached without
   the admin claim, and none of it is used by the public signup page - the
   vendor flow is untouched.

   Two fields the public page never writes are added here:

     reviewStatus   pending | approved | waitlisted | declined
     notes[]        internal, staff only, never shown to the vendor

   They are new rather than a change to status, so an application made
   before any of this existed still reads correctly - it simply has no
   review decision yet.
   ========================================================================= */

/* Who did it, for the audit trail on every admin change. */
function actor(request) {
  const t = (request.auth && request.auth.token) || {};
  return { uid: request.auth.uid, email: t.email || null };
}

/*  Hands every bay a booking holds back to the floor. Must be called inside
    a transaction, with the booking already read. */
async function freeBaysInTx(tx, bookingId, booking) {
  const bayIds = Array.isArray(booking.siteIds) && booking.siteIds.length
    ? booking.siteIds
    : (booking.siteId ? [booking.siteId] : []);

  if (!bayIds.length) return;

  const refs = bayIds.map((id) => siteRef(booking.eventId, id));
  const snaps = await Promise.all(refs.map((r) => tx.get(r)));

  snaps.forEach((snap, i) => {
    // Only give back what this booking is actually holding.
    if (snap.exists && snap.data().bookingId === bookingId) {
      tx.update(refs[i], {
        status: 'available',
        bookingId: FieldValue.delete(),
        heldBy: FieldValue.delete(),
        holdExpiresAt: FieldValue.delete(),
      });
    }
  });
}

/*  Undo the category count when a booking stops being real.

    Split in two on purpose. A Firestore transaction refuses a read that
    follows a write, and freeing a vendor's bays is a write - so the read
    has to be hoisted above it and only the write left behind. Callers do
    the read first, then all their writes, then this. */
async function readCategoryForUncount(tx, booking) {
  if (!booking.countedCategoryId) return null;
  const ref = categoryRef(booking.eventId, booking.countedCategoryId);
  const snap = await tx.get(ref);
  return { ref, snap };
}

function writeUncount(tx, read) {
  if (!read || !read.snap.exists) return;
  if ((read.snap.data().count || 0) <= 0) return;
  tx.update(read.ref, { count: FieldValue.increment(-1) });
}

/* -------------------------------------------------------------------------
   adminReviewBooking - approve, waitlist, decline, or put back to pending.

   Declining is the only decision that touches anything else: the site goes
   back on the market and the category count comes down, because a declined
   vendor is not taking up either. Approving is deliberately just a flag -
   it does not confirm them or take their money, it says a human has looked
   and said yes.
   ------------------------------------------------------------------------- */
const DECISIONS = ['pending', 'approved', 'waitlisted', 'declined'];

exports.adminReviewBooking = onCall(async (request) => {
  requireAdmin(request);
  const { bookingId, decision, reason } = request.data || {};

  if (!bookingId) throw new HttpsError('invalid-argument', 'Missing booking.');
  if (!DECISIONS.includes(decision)) {
    throw new HttpsError('invalid-argument',
      'Decision must be one of: ' + DECISIONS.join(', '));
  }

  const who = actor(request);

  await db.runTransaction(async (tx) => {
    const ref = db.collection('bookings').doc(bookingId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Booking not found.');

    const booking = snap.data();

    const update = {
      reviewStatus: decision,
      reviewedAt: FieldValue.serverTimestamp(),
      reviewedBy: who.email || who.uid,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (reason) update.reviewReason = String(reason).slice(0, 500);
    else update.reviewReason = FieldValue.delete();

    if (decision === 'declined') {
      /*  Category read before freeBaysInTx, because that frees the bays and
          a transaction will not read after a write. */
      const catRead = await readCategoryForUncount(tx, booking);

      await freeBaysInTx(tx, bookingId, booking);
      writeUncount(tx, catRead);

      update.status = 'cancelled';
      update.cancelledAt = FieldValue.serverTimestamp();
      update.countedCategoryId = FieldValue.delete();
      update.siteId = FieldValue.delete();
      update.siteIds = FieldValue.delete();
      update.siteLabel = FieldValue.delete();
      update.holdExpiresAt = FieldValue.delete();
    }

    tx.update(ref, update);
  });

  logger.info('admin review', { bookingId, decision, by: who.email });
  return { ok: true, decision };
});

/* -------------------------------------------------------------------------
   adminSetPayment - mark somebody paid, unpaid, or in for free.

   Marking a booking paid or free when it is holding a site confirms it
   properly, through the same confirmBooking the Stripe webhook uses. That
   way a vendor paid by bank transfer or waved in for free ends up in
   exactly the same state as one who paid by card - counted, sites booked,
   reference issued - instead of a second half-confirmed shape nothing
   else understands.
   ------------------------------------------------------------------------- */
const PAYMENT_STATES = ['none', 'unpaid', 'paid', 'free'];

exports.adminSetPayment = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  requireAdmin(request);
  const { bookingId, paymentStatus, amountPaidCents } = request.data || {};

  if (!bookingId) throw new HttpsError('invalid-argument', 'Missing booking.');
  if (!PAYMENT_STATES.includes(paymentStatus)) {
    throw new HttpsError('invalid-argument',
      'Payment status must be one of: ' + PAYMENT_STATES.join(', '));
  }

  const who = actor(request);
  const ref = db.collection('bookings').doc(bookingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Booking not found.');

  const booking = snap.data();
  const settled = paymentStatus === 'paid' || paymentStatus === 'free';
  const holdsSite = (booking.siteIds && booking.siteIds.length) || booking.siteId;

  if (settled && booking.status !== 'confirmed' && holdsSite) {
    /*  Default to the full total - fee and GST included - because that is
        what would have landed in the account if they paid by transfer.
        amountCents alone would quietly under-record every offline payment
        and leave the GST owing invisible. */
    const paid = amountPaidCents != null
      ? Number(amountPaidCents)
      : (paymentStatus === 'free'
          ? 0
          : (booking.totalCents != null ? booking.totalCents : booking.amountCents || 0));

    const result = await confirmAndNotify(bookingId, {
      paymentStatus,
      amountPaidCents: paid,
    });

    await ref.update({
      paidBy: who.email || who.uid,
      paidMarkedAt: FieldValue.serverTimestamp(),
    });

    logger.info('admin marked paid', { bookingId, paymentStatus, by: who.email });
    return { ok: result.ok !== false, confirmed: result.ok !== false, ...result };
  }

  // Not settling, or nothing to confirm - just record the state.
  const update = {
    paymentStatus,
    paidBy: who.email || who.uid,
    paidMarkedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (amountPaidCents != null) update.amountPaidCents = Number(amountPaidCents);

  await ref.update(update);
  return { ok: true, confirmed: false };
});

/* -------------------------------------------------------------------------
   adminAddNote - an internal note. Vendors never see these.

   Notes are appended rather than replaced, and carry who wrote them and
   when, so the thread reads as a history instead of one field that keeps
   being overwritten.
   ------------------------------------------------------------------------- */
exports.adminAddNote = onCall(async (request) => {
  requireAdmin(request);
  const { bookingId, text } = request.data || {};

  if (!bookingId) throw new HttpsError('invalid-argument', 'Missing booking.');

  const body = String(text || '').trim();
  if (!body) throw new HttpsError('invalid-argument', 'Note is empty.');
  if (body.length > 2000) {
    throw new HttpsError('invalid-argument', 'Note is too long - 2000 characters max.');
  }

  const who = actor(request);

  /*  serverTimestamp() is not allowed inside an array, so the note carries
      a plain client-independent time taken here on the server. */
  await db.collection('bookings').doc(bookingId).update({
    notes: FieldValue.arrayUnion({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      text: body,
      by: who.email || who.uid,
      at: Timestamp.now(),
    }),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { ok: true };
});

/* -------------------------------------------------------------------------
   adminAssignSite - put a vendor on a site, move them, or take the site
   away and leave them unseated.

   One transaction covers the lot: the old bays go back and the new ones
   are taken together, so a move can never end up holding both or neither.
   Pass an empty list to free them without giving them anywhere new.
   ------------------------------------------------------------------------- */
exports.adminAssignSite = onCall(async (request) => {
  requireAdmin(request);
  const { bookingId, siteIds } = request.data || {};

  if (!bookingId) throw new HttpsError('invalid-argument', 'Missing booking.');

  const wanted = Array.isArray(siteIds) ? siteIds.filter(Boolean) : [];
  if (wanted.length > 8) {
    throw new HttpsError('invalid-argument', 'Eight bays is the most anyone can have.');
  }

  const who = actor(request);

  const label = await db.runTransaction(async (tx) => {
    const bRef = db.collection('bookings').doc(bookingId);
    const bSnap = await tx.get(bRef);
    if (!bSnap.exists) throw new HttpsError('not-found', 'Booking not found.');

    const booking = bSnap.data();
    const eventId = booking.eventId;

    /*  Every read has to happen before any write in a transaction, so the
        new bays are read up front even though they are written last. */
    const newRefs = wanted.map((id) => siteRef(eventId, id));
    const newSnaps = await Promise.all(newRefs.map((r) => tx.get(r)));

    newSnaps.forEach((snap, i) => {
      if (!snap.exists) {
        throw new HttpsError('not-found', `Site ${wanted[i]} does not exist.`);
      }
      const site = snap.data();
      const takenBySomeoneElse =
        (site.status === 'booked' || site.status === 'held') &&
        site.bookingId !== bookingId;

      if (takenBySomeoneElse) {
        throw new HttpsError('failed-precondition',
          `Site ${site.label || wanted[i]} already belongs to another vendor.`);
      }
      if (site.status === 'blocked') {
        throw new HttpsError('failed-precondition',
          `Site ${site.label || wanted[i]} is blocked off.`);
      }
    });

    // Give back whatever they had that they are not keeping.
    await freeBaysInTx(tx, bookingId, booking);

    /*  A confirmed vendor stays booked on their new site. Anyone else is
        seated but not yet paid for, so the site is held for them without
        an expiry - an admin put them there, it should not time out. */
    const seatedStatus = booking.status === 'confirmed' ? 'booked' : 'held';

    newRefs.forEach((ref) => {
      tx.update(ref, {
        status: seatedStatus,
        bookingId,
        heldBy: booking.uid || null,
        holdExpiresAt: FieldValue.delete(),
      });
    });

    const labels = newSnaps
      .map((s) => s.data().label)
      .filter(Boolean)
      .join(', ');

    const update = {
      seatedBy: who.email || who.uid,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (wanted.length) {
      update.siteId = wanted[0];
      update.siteIds = wanted;
      update.siteLabel = labels;
      update.siteType = newSnaps[0].data().type || null;
      update.bayCount = wanted.length;
    } else {
      update.siteId = FieldValue.delete();
      update.siteIds = FieldValue.delete();
      update.siteLabel = FieldValue.delete();
      update.bayCount = FieldValue.delete();
    }

    tx.update(bRef, update);
    return labels;
  });

  logger.info('admin assigned site', { bookingId, siteIds: wanted, by: who.email });
  return { ok: true, siteLabel: label };
});

/* -------------------------------------------------------------------------
   adminCreateBooking - add a vendor by hand.

   For the ones who ring up, catch someone at a market, or send an email
   instead of using the form. The record it writes is the same shape the
   public page writes, so it appears in every list and count alongside the
   rest and can be seated and marked paid the same way.

   uid is null: there is no vendor account behind it. Nothing here depends
   on one, and if they later sign up the booking can be pointed at them.
   ------------------------------------------------------------------------- */
exports.adminCreateBooking = onCall(async (request) => {
  requireAdmin(request);
  const d = request.data || {};

  const eventId = d.eventId;
  if (!eventId) throw new HttpsError('invalid-argument', 'Missing event.');

  const vendorType = d.vendorType;
  if (!['food', 'market'].includes(vendorType)) {
    throw new HttpsError('invalid-argument', 'Vendor type must be food or market.');
  }

  const name = String((d.business && d.business.name) || '').trim();
  if (!name) throw new HttpsError('invalid-argument', 'A business name is needed.');

  const eventSnap = await db.collection('events').doc(eventId).get();
  if (!eventSnap.exists) throw new HttpsError('not-found', 'Event not found.');

  const bayCount = Number(d.bayCount) || 1;
  checkBayCount(eventSnap.data(), vendorType, bayCount);

  const who = actor(request);
  const biz = d.business || {};

  /*  A vendor added by hand is charged the same way as one who came
      through the form. If they end up paying by bank transfer it is the
      total that lands in the account, so that is what the booking says. */
  const manualMoney = feeBreakdown(
    eventSnap.data(),
    priceFor(eventSnap.data(), vendorType, bayCount)
  );

  const booking = {
    uid: null,
    eventId,
    vendorType,
    bayCount,

    business: {
      name,
      contactName: String(biz.contactName || '').trim(),
      email: String(biz.email || '').trim(),
      phone: String(biz.phone || '').trim(),
      socials: String(biz.socials || '').trim(),
      description: String(biz.description || '').trim(),
    },

    categoryId: d.categoryId || null,
    categoryName: d.categoryName || null,

    setup: {},
    documents: [],

    amountCents: manualMoney.siteCents,
    bookingFeeCents: manualMoney.bookingFeeCents,
    gstCents: manualMoney.gstCents,
    totalCents: manualMoney.totalCents,
    amountPaidCents: 0,
    currency: eventSnap.data().currency || 'aud',

    // Added by a human who has already spoken to them, so it starts approved.
    status: 'pending_payment',
    paymentStatus: 'unpaid',
    reviewStatus: 'approved',
    reviewedBy: who.email || who.uid,
    reviewedAt: FieldValue.serverTimestamp(),

    reference: bookingReference(),
    addedByAdmin: true,
    addedBy: who.email || who.uid,

    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  const ref = await db.collection('bookings').add(booking);

  logger.info('admin added vendor', { bookingId: ref.id, name, by: who.email });
  return { ok: true, bookingId: ref.id, reference: booking.reference };
});

/* -------------------------------------------------------------------------
   adminUpdateBooking - correct a vendor's own details.

   Contact details and setup notes only. Sites, money and status are not
   editable here on purpose: each of those has its own function above that
   keeps the sites, the counts and the booking in step with each other, and
   letting them be written straight through would go around all of that.
   ------------------------------------------------------------------------- */
exports.adminUpdateBooking = onCall(async (request) => {
  requireAdmin(request);
  const { bookingId, business, setup } = request.data || {};

  if (!bookingId) throw new HttpsError('invalid-argument', 'Missing booking.');

  const update = {
    updatedAt: FieldValue.serverTimestamp(),
    editedBy: actor(request).email || request.auth.uid,
  };

  const text = (v, max = 400) => String(v == null ? '' : v).trim().slice(0, max);

  if (business && typeof business === 'object') {
    const fields = ['name', 'contactName', 'email', 'phone', 'socials', 'description'];
    fields.forEach((k) => {
      if (business[k] !== undefined) {
        update[`business.${k}`] = text(business[k], k === 'description' ? 2000 : 400);
      }
    });
  }

  if (setup && typeof setup === 'object') {
    ['frontage', 'depth'].forEach((k) => {
      if (setup[k] !== undefined) update[`setup.${k}`] = Number(setup[k]) || null;
    });
    /*  ownPower is a dropdown holding words - 'Silent generator' - and was
        in this list of checkboxes, so !! turned it into true. An admin
        editing a booking lost which generator the vendor was bringing,
        which is the thing stages get placed around.                   */
    if (setup.ownPower !== undefined) update['setup.ownPower'] = text(setup.ownPower, 120);

    /*  readFaqs is the tick on the form now; selfSufficient and
        vehicleOnSite are still accepted so a booking taken before the
        form changed can still be edited.                             */
    ['readFaqs', 'selfSufficient', 'vehicleOnSite'].forEach((k) => {
      if (setup[k] !== undefined) update[`setup.${k}`] = !!setup[k];
    });
    if (setup.notes !== undefined) update['setup.notes'] = text(setup.notes, 2000);
  }

  await db.collection('bookings').doc(bookingId).update(update);
  return { ok: true };
});

/* -------------------------------------------------------------------------
   adminSaveEvent - create an event, or edit one.

   Opening and closing vendor signup is this same function: status is what
   holdSite already checks before it will give anybody a site, so closing
   an event stops new bookings at the point that matters rather than only
   hiding a button.

   Creating does not lay out the ground. seedEvent does that, and it is
   left separate because a new event usually wants a different map, and
   quietly stamping the Bowen layout on it would be a guess.
   ------------------------------------------------------------------------- */
const EVENT_STATES = ['draft', 'open', 'closed', 'archived'];

exports.adminSaveEvent = onCall(async (request) => {
  requireAdmin(request);
  const { eventId, create, fields } = request.data || {};

  const id = String(eventId || '').trim();
  if (!id) throw new HttpsError('invalid-argument', 'Missing event id.');

  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(id)) {
    throw new HttpsError('invalid-argument',
      'The id must be lower case letters, numbers and dashes.');
  }

  const f = fields || {};
  const update = { updatedAt: FieldValue.serverTimestamp() };
  const text = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

  ['name', 'subtitle', 'dateISO', 'dateLabel', 'venue', 'location'].forEach((k) => {
    if (f[k] !== undefined) update[k] = text(f[k]);
  });

  /*  THE CONFIRMATION EMAIL

      Subject and body, written in the admin desk. The body is HTML from a
      rich text box, so it gets a lot more room than a name - but a cap all
      the same, because a document pasted in wholesale has no business in a
      field nobody meant to be a document.

      Nothing is validated beyond length: this is our own admin writing our
      own email, and the mailer escapes every value it substitutes, so a
      vendor's business name cannot break out of it.                     */
  if (f.vendorEmail !== undefined) {
    const t = f.vendorEmail || {};
    if (t.subject !== undefined) update['vendorEmail.subject'] = text(t.subject, 300);
    if (t.body !== undefined) update['vendorEmail.body'] = text(t.body, 20000);
    update['vendorEmail.updatedAt'] = FieldValue.serverTimestamp();
  }

  if (f.status !== undefined) {
    if (!EVENT_STATES.includes(f.status)) {
      throw new HttpsError('invalid-argument',
        'Status must be one of: ' + EVENT_STATES.join(', '));
    }
    update.status = f.status;
  }

  const whole = (v, name, max) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > max) {
      throw new HttpsError('invalid-argument', `${name} does not look right.`);
    }
    return n;
  };

  if (f.holdMinutes !== undefined) update.holdMinutes = whole(f.holdMinutes, 'Hold minutes', 240);
  if (f.maxMarketBays !== undefined) update.maxMarketBays = whole(f.maxMarketBays, 'Max bays', 20);

  if (f.pricing && typeof f.pricing === 'object') {
    if (f.pricing.food !== undefined) {
      update['pricing.food'] = whole(f.pricing.food, 'Food price', 10000000);
    }
    if (f.pricing.marketPerBay !== undefined) {
      update['pricing.marketPerBay'] = whole(f.pricing.marketPerBay, 'Market price', 10000000);
    }
  }

  const ref = db.collection('events').doc(id);
  const snap = await ref.get();

  if (create) {
    if (snap.exists) throw new HttpsError('already-exists', 'An event with that id exists.');

    await ref.set({
      name: update.name || id,
      subtitle: update.subtitle || '',
      dateISO: update.dateISO || '',
      dateLabel: update.dateLabel || '',
      venue: update.venue || '',
      location: update.location || '',

      // New events start closed. Opening one is a decision, not a default.
      status: update.status || 'draft',

      currency: 'aud',
      holdMinutes: update.holdMinutes != null ? update.holdMinutes : 10,
      maxMarketBays: update.maxMarketBays != null ? update.maxMarketBays : 8,
      marketTierSize: layout.MARKET_TIER_SIZE,
      pricing: {
        food: update['pricing.food'] != null ? update['pricing.food'] : 10000,
        marketPerBay: update['pricing.marketPerBay'] != null
          ? update['pricing.marketPerBay'] : 5000,
      },
      map: { width: layout.MAP_WIDTH, height: layout.MAP_HEIGHT },
      landmarks: layout.defaultLandmarks ? layout.defaultLandmarks() : [],

      createdAt: FieldValue.serverTimestamp(),
      createdBy: actor(request).email || request.auth.uid,
    });

    logger.info('admin created event', { eventId: id });
    return { ok: true, eventId: id, created: true };
  }

  if (!snap.exists) throw new HttpsError('not-found', 'Event not found.');

  await ref.update(update);
  return { ok: true, eventId: id, created: false };
});

/* -------------------------------------------------------------------------
   THE GIG GUIDE

   Goes and finds what is on around Bowen and the Whitsundays once a day and
   writes it into Firestore, which is where /gig-guide reads it from. All of
   the work is in lib/gig-sources.js (where the events come from, and the
   rules it follows) and lib/gig-store.js (making the database match).

   FOUR IN THE MORNING, Queensland time. Nothing else runs then, the sites
   being read are idle, and it means the guide is right before anybody is
   awake to look at it.

   NINE MINUTES, because the very first run has no cache and reads every
   event page the sources list - about eight hundred of them, five minutes
   measured. Every run after that reads only what changed, which took seven
   seconds. The timeout is there for the cold start, not the daily cost.
   ------------------------------------------------------------------------- */
const { syncGigs } = require('./lib/gig-store');

exports.syncGigGuide = onSchedule(
  {
    schedule: '0 4 * * *',
    timeZone: 'Australia/Brisbane',
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    await syncGigs(db);
  },
);

/*  The same thing on demand, for an admin who has just added a source and
    does not want to wait until four in the morning to find out whether it
    works. Admin only: it is a few hundred outbound requests, not something
    a passer by should be able to set off.                                */
exports.syncGigGuideNow = onCall(
  { timeoutSeconds: 540, memory: '512MiB' },
  async (request) => {
    if (!request.auth || !request.auth.token || request.auth.token.admin !== true) {
      throw new HttpsError('permission-denied', 'Admins only.');
    }

    const status = await syncGigs(db);

    /*  serverTimestamp() comes back as a sentinel rather than a time, so
        it is dropped instead of being sent to the browser as an object
        that looks like a date and is not.                              */
    delete status.ranAt;
    return status;
  },
);

/* -------------------------------------------------------------------------
   adminSendTestVendorEmail

   Sends the confirmation email for an event to whoever asks for it, with
   made-up booking details, so the wording and the settings can both be
   checked without taking a payment to do it.

   This replaced smtpSmokeTest, which did the same job through a public
   URL with a token in it and a sample hard coded into this file. An
   admin-only callable is the same test without the open door.
   ------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------
   adminResendVendorEmail

   Sends a vendor their confirmation again - or for the first time, if it
   failed when they paid. Only for a booking that is actually paid: the
   email says "payment has been received", and sending that to somebody who
   has not paid is worse than sending nothing.
   ------------------------------------------------------------------------- */
exports.adminResendVendorEmail = onCall(
  { secrets: [SMTP_USER, SMTP_PASS] },
  async (request) => {
    requireAdmin(request);

    const { bookingId } = request.data || {};
    const id = String(bookingId || '').trim();
    if (!id) throw new HttpsError('invalid-argument', 'Missing booking.');

    const ref = db.collection('bookings').doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'No such booking.');

    const booking = snap.data();

    const paid = booking.status === 'confirmed'
      || booking.paymentStatus === 'paid'
      || booking.paymentStatus === 'free';

    if (!paid) {
      throw new HttpsError('failed-precondition',
        'That booking has not been paid, so there is nothing to confirm.');
    }

    if (!(booking.business || {}).email) {
      throw new HttpsError('failed-precondition',
        'That booking has no email address on it.');
    }

    const evSnap = await db.collection('events').doc(booking.eventId).get();
    const event = evSnap.exists ? evSnap.data() : {};

    const result = await sendAndRecord(booking, id, event, ref);
    logger.info('vendor email resent by an admin', { bookingId: id, result });

    return result;
  },
);

exports.adminSendTestVendorEmail = onCall(
  { secrets: [SMTP_USER, SMTP_PASS] },
  async (request) => {
    requireAdmin(request);

    const { eventId, to } = request.data || {};

    const address = String(to || request.auth.token.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      throw new HttpsError('invalid-argument', 'That is not an email address.');
    }

    const id = String(eventId || '').trim();
    if (!id) throw new HttpsError('invalid-argument', 'Missing event id.');

    const evSnap = await db.collection('events').doc(id).get();
    if (!evSnap.exists) throw new HttpsError('not-found', 'No such event.');
    const event = evSnap.data();

    /*  A booking that looks like a real one, so every placeholder has
        something to show and the figures add up the way they will on
        the day.                                                     */
    const siteCents = event.pricing && event.pricing.food ? event.pricing.food : 10000;
    const money = feeBreakdown(event, siteCents);

    const booking = {
      reference: 'TEST-0001',
      siteLabel: 'F5',
      vendorType: 'food',
      categoryName: 'BBQ / Smoked Meats',
      amountCents: siteCents,
      bookingFeeCents: money.bookingFeeCents,
      gstCents: money.gstCents,
      totalCents: money.totalCents,
      documents: [],
      business: {
        name: 'Test Kitchen Co',
        contactName: 'Sample Vendor',
        email: address,
        phone: '0400 000 000',
      },
    };

    const result = await sendBookingEmails(booking, 'test-email', event);
    logger.info('test vendor email', { eventId: id, to: address, result });

    /*  The result rather than a throw: "it did not send, and here is what
        Google said" is the whole point of pressing the button.       */
    return result;
  },
);

/* =========================================================================
   ESTIMATE BOT

   The public estimate bot is submitBotQuote (further down): it prices from
   packages, emails the visitor a price guide and creates a draft quote in the
   Sales Pipeline. The old Quote Leads page was removed on 20 Oct 2026.
   ========================================================================= */

/*  The equipment inventory. The bot prices the extras a visitor picks from
    the hire prices here, so it is read back server-side rather than trusted
    from the browser. An empty list if it cannot be read. */
async function loadQuoteInventory() {
  try {
    const snap = await db.collection('inventory').get();
    if (!snap.empty) {
      const items = [];
      snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
      if (items.length) return items;
    }
  } catch (err) {
    logger.warn('could not read inventory, using default', {
      message: err && err.message,
    });
  }
  return [];
}

/*  REMOVED 20 Oct 2026: the old Quote Leads page (adminUpdateQuoteLead,
    adminResendQuoteEmail). The bot's estimates live in the Sales Pipeline;
    old quoteLeads documents are left in the database untouched.          */


/* =========================================================================
   QUOTES / INVOICES

   One record moves Estimate -> Quote -> (customer accepts) -> Invoice.
   Line items are stored explicitly (the admin builds them, the kit engine
   having already expanded any required gear), so the server just validates
   and sums them. Prices are EX-GST; GST is 10% on top.

     adminSaveQuote        admin  - create/update, allocates SG-Q-#### + token
     adminSetQuoteStatus   admin  - move it along (sent/accepted/invoiced/paid)
     adminSendQuote        admin  - email the customer their link
     getQuote              public - fetch a quote by its secret token
     acceptQuote           public - customer accepts, by token

   The docs stay admin-only in the rules; the public sees theirs only through
   getQuote / acceptQuote, matched on an unguessable token.
   ========================================================================= */

const crypto = require('crypto');

// draft = Estimate, approved = Quote (Max approved it), sent = Quote emailed,
// invoiced = accepted -> Invoice, paid = Paid (Max, 16 Oct 2026)
const QUOTE_DOC_STATES = ['draft', 'approved', 'sent', 'accepted', 'declined', 'invoiced', 'paid', 'cancelled'];

/*  Totals from the stored lines. Prices are ex-GST; discounts come off the
    net; GST is 10% of the net; total is net + GST.                        */
function quoteMoney(quote) {
  const days = Math.max(1, Math.round((quote.hire && quote.hire.days) || 1));
  let subtotal = 0;
  let discount = Math.max(0, Math.round(quote.discountCents || 0));   // discount off the whole total
  (quote.lines || []).forEach((l) => {
    if (l.type === 'discount') { discount += Math.max(0, Math.round(l.amountCents || 0)); return; }
    const qty = Math.max(0, (l.perf ? Math.round(Number(l.qty || 0) * 4) / 4 : Math.round(Number(l.qty) || 0)));   // DJ hours can be 4.5 etc (Max, 23 Oct 2026)
    const unit = Math.max(0, Math.round(l.unitCents || 0));
    const lineDays = Math.max(1, Math.round(l.days || days));
    // quantity x day rate x number of days
    subtotal += Math.round(qty * unit * lineDays);
  });
  const net = Math.max(0, subtotal - discount);
  const gst = Math.round(net * 0.10);
  return { subtotalCents: subtotal, discountCents: discount, netCents: net, gstCents: gst, totalCents: net + gst };
}

function sanitizeQuote(q) {
  const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const days = Math.max(1, Math.round(Number(q.hire && q.hire.days) || 1));

  const customer = {
    name: text(q.customer && q.customer.name, 120),
    business: text(q.customer && q.customer.business, 120),
    email: text(q.customer && q.customer.email, 200),
    // a second address that gets a copy of the quote / invoice email (accounts etc.)
    // CC: one or more addresses separated by commas (Max, 20 Oct 2026) - only valid ones kept
    ccEmail: String((q.customer && q.customer.ccEmail) || '').split(/[,;\s]+/).map((e) => e.trim())
      .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).slice(0, 10).join(', ').slice(0, 600),
    phone: text(q.customer && q.customer.phone, 40),
    address: text(q.customer && q.customer.address, 300),
    eventName: text(q.customer && q.customer.eventName, 160),
    eventType: text(q.customer && q.customer.eventType, 40),
    eventDate: text(q.customer && q.customer.eventDate, 60),
    eventVenue: text(q.customer && q.customer.eventVenue, 200),   // venue (customer details form, 20 Oct 2026)
    eventStartTime: text(q.customer && q.customer.eventStartTime, 20),   // when the event starts - we work out bump-in from it
    customerNotes: text(q.customer && q.customer.customerNotes, 2000),   // "anything we should know" from the details form
    dayContact: text(q.customer && q.customer.dayContact, 200),   // event day contact - name & phone
    // the band / crew who get the gear list with NO prices - not the billing CC (Max, 20 Oct 2026)
    gearEmails: String((q.customer && q.customer.gearEmails) || '').split(/[,;\s]+/).map((e) => e.trim())
      .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).slice(0, 10).join(', ').slice(0, 600),
  };
  const hire = {
    startDate: text(q.hire && q.hire.startDate, 40),
    endDate: text(q.hire && q.hire.endDate, 40),
    days,
  };
  const lines = (Array.isArray(q.lines) ? q.lines : []).slice(0, 200).map((l) => {
    const type = ['item', 'kit', 'custom', 'discount', 'labour', 'delivery', 'fee'].includes(l.type) ? l.type : 'custom';
    const line = {
      type,
      itemId: text(l.itemId, 60),
      name: text(l.name, 200),
      description: text(l.description, 500),
      qty: type === 'discount' ? 1 : Math.max(0, (l.perf ? Math.round(Number(l.qty || 0) * 4) / 4 : Math.round(Number(l.qty) || 0))),
      unitCents: type === 'discount' ? 0 : Math.max(0, Math.round(Number(l.unitCents) || 0)),
      extraDayCents: Math.max(0, Math.round(Number(l.extraDayCents) || 0)),
      days: Math.max(1, Math.round(Number(l.days) || days)),
      amountCents: type === 'discount' ? Math.max(0, Math.round(Number(l.amountCents) || 0)) : 0,
    };
    if (['normal', 'discounted', 'free'].includes(l.charge)) line.charge = l.charge;
    // a system part's place in Max's own order (System builder) - kept on quotes
    if (l.sysOrder != null && Number.isFinite(Number(l.sysOrder))) line.sysOrder = Math.max(0, Math.round(Number(l.sysOrder)));
    if (l.pkgId) line.pkgId = text(l.pkgId, 60);   // belongs to a package (itemised + package discount)
    // parts Max removed from this kit on the quote - they stay off when it is rebuilt
    if (Array.isArray(l.removedParts) && l.removedParts.length) line.removedParts = l.removedParts.slice(0, 100).map((x) => text(x, 60)).filter(Boolean);
    // PUB NIGHTS (Max, 21 Oct 2026): the DJ lines the pub invoice swaps each week - never gear
    if (l.pubDj === true) line.pubDj = true;
    if (l.noPick === true) line.noPick = true;
    // a template's fill-in line: the DJ, their travel or the booking fee (Max, 22 Oct 2026)
    if (['dj', 'travel', 'fee'].includes(l.djSlot)) line.djSlot = l.djSlot;
    if (l.perf === true) line.perf = true;             // the DJ's performance fee (super is worked out on it)
    if (l.superLine === true) line.superLine = true;   // the performer super line itself
    // CREW & VEHICLES (from Crew & Vehicles): their own subtotal, never gear
    if (['staff', 'vehicle', 'trailer'].includes(l.resType)) {
      line.resType = l.resType;
      if (l.resourceId) line.resourceId = text(l.resourceId, 60);
      if (l.baseCents != null) line.baseCents = Math.max(0, Math.round(Number(l.baseCents) || 0));   // their own day rate (surcharges on top)
    }
    return line;
  }).filter((l) => l.name || l.itemId);

  const kind = ['estimate', 'quote', 'invoice'].includes(q.kind) ? q.kind : 'quote';
  return {
    customer, hire, lines, kind,
    discountCents: Math.max(0, Math.round(Number(q.discountCents) || 0)),
    labourExcluded: q.labourExcluded === true,
    feeExcluded: q.feeExcluded === true,
    superExcluded: q.superExcluded === true,   // performer super off (Max, 22 Oct 2026)
    autoSendOnDetails: q.autoSendOnDetails === true,   // send the quote when the customer fills in their details (Max, 20 Oct 2026)
    isTemplate: q.isTemplate === true,   // Sales Pipeline > Templates: a DJ gig invoice to copy - never sent (Max, 21 Oct 2026)
    templateName: text(q.templateName, 80),   // its own name, e.g. "Grand View Friday"
    labourPH: { setup: !!(q.labourPH && q.labourPH.setup), pack: !!(q.labourPH && q.labourPH.pack) },
    labourOff: { setup: !!(q.labourOff && q.labourOff.setup), pack: !!(q.labourOff && q.labourOff.pack) },
    labourPackDate: /^\d{4}-\d{2}-\d{2}$/.test(String(q.labourPackDate || '')) ? String(q.labourPackDate) : '',
    delivery: {
      town: text(q.delivery && q.delivery.town, 80),
      km: Math.max(0, Math.round(Number(q.delivery && q.delivery.km) || 0)),
    },
    notes: text(q.notes, 3000),
    terms: text(q.terms, 3000),
  };
}

exports.adminSaveQuote = onCall(async (request) => {
  requireAdmin(request);
  const { id, quote } = request.data || {};
  const clean = sanitizeQuote(quote || {});
  const money = quoteMoney(clean);

  if (id) {
    const ref = db.collection('quotes').doc(String(id));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'No such quote.');
    await ref.update({ ...clean, ...money, updatedAt: FieldValue.serverTimestamp() });
    return { id: String(id), ...money };
  }

  // New: allocate a sequential number + an unguessable token.
  const counterRef = db.collection('config').doc('counters');
  const seq = await db.runTransaction(async (tx) => {
    const c = await tx.get(counterRef);
    const n = ((c.exists && c.data().quoteSeq) || 0) + 1;
    tx.set(counterRef, { quoteSeq: n }, { merge: true });
    return n;
  });
  const number = 'SG-Q-' + String(seq).padStart(4, '0');
  const token = crypto.randomBytes(16).toString('hex');

  const ref = await db.collection('quotes').add({
    // made by Max in admin = a QUOTE straight away; only the website bot makes estimates (Max, 17 Oct 2026)
    number, token, status: 'approved', approvedAt: FieldValue.serverTimestamp(), ...clean, ...money,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    createdBy: (request.auth.token && request.auth.token.email) || request.auth.uid,
  });
  return { id: ref.id, number, token, ...money };
});

/*  NEXT INVOICE NUMBER - SG-I-0001, 0002 ... from config/counters.invoiceSeq.
    Pass a transaction to take the number inside it (reads before writes).  */
async function nextInvoiceNumber(tx) {
  const counterRef = db.collection('config').doc('counters');
  const take = async (t) => {
    const c = await t.get(counterRef);
    const n = ((c.exists && c.data().invoiceSeq) || 0) + 1;
    return { n, write: () => t.set(counterRef, { invoiceSeq: n }, { merge: true }) };
  };
  if (tx) return take(tx);
  return db.runTransaction(async (t) => { const r = await take(t); r.write(); return r; });
}
const invoiceNo = (n) => 'SG-I-' + String(n).padStart(4, '0');

exports.adminSetQuoteStatus = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  requireAdmin(request);
  const { id, status } = request.data || {};
  if (!QUOTE_DOC_STATES.includes(status)) throw new HttpsError('invalid-argument', 'Bad status.');

  const ref = db.collection('quotes').doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such quote.');

  const update = { status, updatedAt: FieldValue.serverTimestamp() };

  // UNDO ACCEPT (Max, 16 Oct 2026): back to "sent" and clear who accepted and
  // how they chose to pay. Never when card money has been taken.
  if (request.data.undoAccept === true) {
    if (status !== 'sent') throw new HttpsError('invalid-argument', 'Undo accept goes back to sent.');
    if ((snap.data().amountPaidCents || 0) > 0) {
      throw new HttpsError('failed-precondition', 'A payment has been taken on this quote - refund it in Stripe first.');
    }
    Object.assign(update, {
      acceptedName: FieldValue.delete(), acceptedAt: FieldValue.delete(),
      paymentStatus: FieldValue.delete(), paymentMethod: FieldValue.delete(),
      kind: 'quote', invoiceNumber: FieldValue.delete(), invoicedAt: FieldValue.delete(),
    });
  }

  // "Mark accepted" in admin = accepted AND turned into an invoice
  if (status === 'accepted') {
    update.status = 'invoiced';
    update.acceptedAt = FieldValue.serverTimestamp();
  }
  const stamp = {
    approved: 'approvedAt', sent: 'sentAt', accepted: 'acceptedAt', declined: 'declinedAt',
    invoiced: 'invoicedAt', paid: 'paidAt', cancelled: 'cancelledAt',
  };
  if (stamp[status]) update[stamp[status]] = FieldValue.serverTimestamp();

  if (update.status === 'invoiced') {
    update.kind = 'invoice';
    update.invoicedAt = FieldValue.serverTimestamp();
    if (!snap.data().invoiceNumber) update.invoiceNumber = invoiceNo((await nextInvoiceNumber()).n);
  }

  // MARK PAID (Max, 16 Oct 2026) - money came in another way (bank transfer, cash).
  // A paid job is always a tax invoice, and paid in full.
  if (update.status === 'paid') {
    const q = snap.data();
    update.kind = 'invoice';
    if (!q.invoiceNumber) { update.invoiceNumber = invoiceNo((await nextInvoiceNumber()).n); update.invoicedAt = FieldValue.serverTimestamp(); }
    update.paymentStatus = 'paid';
    update.paymentMethod = q.paymentMethod || 'bank';
    update.amountPaidCents = Math.max(q.amountPaidCents || 0, quoteGrandTotal(q));
  }

  await ref.update(update);
  if (update.status === 'paid') await autoGearOnDeposit(ref.id);   // paid in full by bank / cash - gear list out
  return { ok: true, invoiceNumber: update.invoiceNumber || snap.data().invoiceNumber || '' };
});

/*  ARCHIVE / RESTORE / DELETE a job from the Sales Pipeline (Max, 16 Oct 2026).
    Archive = status cancelled (link stops working), remembering where it was.
    Restore puts it back. Delete forever only for estimates / quotes with no
    money and no invoice number - tax invoices are kept (ATO: 5 years).      */
exports.adminArchiveQuote = onCall(async (request) => {
  requireAdmin(request);
  const { id, archive } = request.data || {};
  const ref = db.collection('quotes').doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such quote.');
  const q = snap.data();
  if (archive === true) {
    if (q.status === 'cancelled') return { ok: true };
    await ref.update({ status: 'cancelled', archivedFrom: q.status || 'draft', cancelledAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  } else {
    const back = QUOTE_DOC_STATES.includes(q.archivedFrom) && q.archivedFrom !== 'cancelled' ? q.archivedFrom : 'draft';
    await ref.update({ status: back, archivedFrom: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
  }
  return { ok: true };
});

exports.adminDeleteQuote = onCall(async (request) => {
  requireAdmin(request);
  const { id, force } = request.data || {};
  const ref = db.collection('quotes').doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) return { ok: true };
  const q = snap.data();
  // ARCHIVED (cancelled / declined) jobs can be deleted even with an invoice or
  // payment on them, when the admin typed DELETE to confirm (force) - Max, 19 Oct 2026
  const archived = q.status === 'cancelled' || q.status === 'declined';
  const ok = (['draft', 'approved', 'sent', 'declined', 'cancelled'].includes(q.status)
    && !q.invoiceNumber && !((q.amountPaidCents || 0) > 0) && q.kind !== 'invoice')
    || (archived && force === true);
  if (!ok) throw new HttpsError('failed-precondition', 'Invoices and paid jobs can\'t be deleted - archive it instead.');
  await ref.delete();
  logger.info('Quote deleted by admin', { id, number: q.number || '', by: (request.auth.token && request.auth.token.email) || request.auth.uid });
  return { ok: true };
});

/* =========================================================================
   PICK LIST (Max, 16 Oct 2026)
   Once the deposit is in, a job gets a private CREW link (crewToken) to a
   pick list: the gear with NO prices, plus Packed / Returned ticks that are
   saved here so Max can see progress. Separate from the customer token.
   ========================================================================= */

/* deposit in, or paid - the booking is confirmed (same rule as js/stock.js) */
function pickReady(q) {
  if (!q || q.status === 'cancelled' || q.status === 'declined') return false;
  return q.status === 'paid' || q.paymentStatus === 'deposit' || q.paymentStatus === 'paid';
}

/* the gear on a job, one entry per item (items + included kit added up).
   KEEP IN STEP with pickItems() in js/stock.js.                          */
function pickItems(lines) {
  const out = [];
  const byKey = {};
  (lines || []).forEach((l) => {
    if (!l || !['item', 'kit', 'custom'].includes(l.type)) return;
    if (l.resType || l.noPick) return;   // crew & vehicles (and pub DJ lines) are not gear to pack
    const qty = Math.max(0, Math.round(Number(l.qty) || 0));
    if (!qty) return;
    const name = String(l.name || '').replace(/ \(included\)$/i, '').trim();
    const key = l.itemId ? 'i:' + l.itemId : 'n:' + name.toLowerCase();
    if (!byKey[key]) { byKey[key] = { itemId: l.itemId || '', name, qty: 0, category: l.category || '' }; out.push(byKey[key]); }
    byKey[key].qty += qty;
  });
  return out;
}

/* a tick key that is safe as a Firestore field name */
const pickKey = (p) => (p.itemId ? 'i_' + p.itemId : 'n_' + p.name.toLowerCase()).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);

async function quoteByCrewToken(token) {
  if (!/^[a-f0-9]{20,40}$/.test(String(token || ''))) throw new HttpsError('invalid-argument', 'That link is not valid.');
  const snap = await db.collection('quotes').where('crewToken', '==', String(token)).limit(1).get();
  if (snap.empty) throw new HttpsError('not-found', 'That pick list link is not valid.');
  return snap.docs[0];
}

/* ADMIN - a bank-transfer deposit has arrived: books the job (it becomes an
   invoice if it isn't one yet) and unlocks the pick list.                 */
exports.adminDepositReceived = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  requireAdmin(request);
  const { id } = request.data || {};
  const ref = db.collection('quotes').doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such quote.');
  const q = snap.data();
  if (!['approved', 'sent', 'accepted', 'invoiced'].includes(q.status)) {
    throw new HttpsError('failed-precondition', 'Only quotes and unpaid invoices can take a deposit.');
  }
  const deposit = Math.round((q.totalCents || 0) * QUOTE_DEPOSIT_PCT / 100);
  const update = {
    status: 'invoiced', kind: 'invoice',
    paymentStatus: 'deposit', paymentMethod: q.paymentMethod || 'bank',
    amountPaidCents: Math.max(q.amountPaidCents || 0, deposit),
    acceptedAt: q.acceptedAt || FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (!q.invoiceNumber) { update.invoiceNumber = invoiceNo((await nextInvoiceNumber()).n); update.invoicedAt = FieldValue.serverTimestamp(); }
  if (!q.crewToken) update.crewToken = crypto.randomBytes(16).toString('hex');
  await ref.update(update);
  await autoGearOnDeposit(ref.id);   // gear list out once the deposit is in
  return { ok: true };
});

/* ADMIN - UNDO A DEPOSIT / PAYMENT that was marked by hand (Max, 16 Oct 2026):
   the job goes back to a sent quote, as if nothing was paid. Refused if any
   CARD money came through Stripe - refund that in Stripe instead.          */
exports.adminUndoPayment = onCall(async (request) => {
  requireAdmin(request);
  const { id } = request.data || {};
  const ref = db.collection('quotes').doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such quote.');
  const q = snap.data();
  if ((Array.isArray(q.stripeSessions) && q.stripeSessions.length) || q.paymentMethod === 'card') {
    throw new HttpsError('failed-precondition', 'A card payment came through Stripe on this job - refund it in Stripe first.');
  }
  await ref.update({
    status: 'sent', kind: 'quote',
    paymentStatus: FieldValue.delete(), paymentMethod: FieldValue.delete(), amountPaidCents: 0,
    acceptedName: FieldValue.delete(), acceptedAt: FieldValue.delete(),
    invoiceNumber: FieldValue.delete(), invoicedAt: FieldValue.delete(), paidAt: FieldValue.delete(),
    crewToken: FieldValue.delete(), pickTicks: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  logger.info('Payment undone by admin', { id, number: q.number || '' });
  return { ok: true };
});

/* ADMIN - the crew link for a booked job (makes one the first time) */
/*  ADMIN - the gear list link to text the band (Max, 21 Oct 2026) */
exports.adminGearListLink = onCall(async (request) => {
  requireAdmin(request);
  const ref = db.collection('quotes').doc(String((request.data || {}).id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Save the quote first.');
  const q = snap.data();
  if (!gearReady(q)) throw new HttpsError('failed-precondition', 'Approve the quote first - then the gear list link works.');
  let token = q.crewToken;
  if (!token) { token = crypto.randomBytes(16).toString('hex'); await ref.update({ crewToken: token }); }
  return { url: SITE_URL + '/picklist?t=' + token + '&v=gear' };
});

exports.adminPickListLink = onCall(async (request) => {
  requireAdmin(request);
  const { id } = request.data || {};
  const ref = db.collection('quotes').doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such quote.');
  const q = snap.data();
  if (!pickReady(q)) throw new HttpsError('failed-precondition', 'The pick list unlocks once the deposit is in.');
  let token = q.crewToken;
  if (!token) { token = crypto.randomBytes(16).toString('hex'); await ref.update({ crewToken: token }); }
  return { url: SITE_URL + '/picklist?t=' + token };
});

/* PUBLIC (crew link) - the pick list: job details and gear, NO prices */
/*  GEAR LIST for the band (Max, 21 Oct 2026): ?v=gear asks with gear:true and
    opens as soon as the quote is out (no prices, no ticks). The full pick
    list with Packed / Returned ticks still waits for the deposit.          */
const gearReady = (q) => !!q && ['approved', 'sent', 'accepted', 'invoiced', 'paid'].includes(q.status);

exports.getPickList = onCall(async (request) => {
  const doc = await quoteByCrewToken((request.data || {}).token);
  const q = doc.data();
  const gear = (request.data || {}).gear === true;
  if (!(pickReady(q) || (gear && gearReady(q)))) throw new HttpsError('failed-precondition', 'This list is not available yet.');
  // categories from inventory, so the gear can be grouped
  const inv = await loadQuoteInventory();
  const cat = {};
  inv.forEach((it) => { cat[it.id] = it.isSystem ? (it.bundleType === 'package' ? 'Packages' : 'Kits') : (it.category || ''); });   // kits & packages get their own groups
  const c = q.customer || {};
  const items = pickItems(q.lines).map((p) => ({ key: pickKey(p), name: p.name, qty: p.qty, category: cat[p.itemId] || p.category || 'Other' }));
  const crew = (q.lines || []).filter((l) => l.type === 'labour').map((l) => ({ name: l.name || '', note: String(l.description || '').replace(/@.*$/, '').trim() }))
    // operators and vehicles booked on the job
    .concat((q.lines || []).filter((l) => l.resType).map((l) => ({ name: (l.qty > 1 ? l.qty + ' × ' : '') + (l.name || ''), note: l.resType === 'staff' ? ((l.days || 1) + ' day' + ((l.days || 1) === 1 ? '' : 's')) : 'vehicle' })));
  const del = (q.lines || []).find((l) => l.type === 'delivery');
  /*  LAID OUT LIKE THE QUOTE (Max, 20 Oct 2026): every gear line in quote
      order; "sub" = an included part that sits under the item above it.
      Each line has its own tick (key), itemKey reads ticks saved before. */
  const rows = [];
  (q.lines || []).forEach((l, idx) => {
    if (!l || !['item', 'kit', 'custom'].includes(l.type) || l.resType || l.noPick) return;
    const qty = Math.max(0, Math.round(Number(l.qty) || 0));
    if (!qty) return;
    const name = String(l.name || '').replace(/ \(included\)$/i, '').trim();
    const itemKey = pickKey({ itemId: l.itemId || '', name });
    rows.push({
      key: itemKey.slice(0, 110) + '_L' + idx, itemKey, name, qty,
      sub: l.type === 'kit', custom: !l.itemId,
      category: l.category || cat[l.itemId] || '',
      sysOrder: l.sysOrder != null ? l.sysOrder : null,
    });
  });
  /*  THE BRIEF (Max, 22 Oct 2026): a DJ gig's gear list also carries what
      the DJ needs to know - set times, the booking notes (the venue's
      message), the venue's own notes, address and contact.            */
  let brief = null;
  if (q.gigBookingId) {
    const bs = await db.collection('talentSchedule').doc(String(q.gigBookingId)).get();
    const b = bs.exists ? bs.data() : {};
    const vs = await db.collection('venues').get();
    const core = (x) => String(x || '').toLowerCase().split(',')[0].replace(/\b(hotel|bar|the|pub|tavern)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const vd = vs.docs.map((d) => d.data()).find((v) => core(v.name) && (core(b.venue).includes(core(v.name)) || core(v.name).includes(core(b.venue)))) || {};
    const r = b.slug ? await db.collection('actRates').doc(b.slug).get() : null;
    const gd = q.gigDj || {};
    brief = {
      dj: gd.name || '',
      start: b.actualStart || b.start || gd.start || '', finish: b.actualFinish || b.finish || gd.finish || '',
      notes: String(b.notes || '').slice(0, 3000),
      venueNotes: String(vd.notes || '').slice(0, 1000),
      address: String(vd.address || '').slice(0, 200),
      venueContact: [vd.contactName, vd.phone].filter(Boolean).join(' · ').slice(0, 160),
      deck: String((r && r.exists && r.data().deck) || '').slice(0, 300),
    };
  }
  return {
    brief,
    rows,
    number: q.invoiceNumber || q.number || '',
    eventName: c.eventName || '',
    eventDate: c.eventDate || '',
    hire: { startDate: (q.hire && q.hire.startDate) || '', endDate: (q.hire && q.hire.endDate) || '', days: (q.hire && q.hire.days) || 1 },
    town: (q.delivery && q.delivery.town) || '',
    delivery: del ? (del.name || 'Delivery & pickup') : 'Customer pickup',
    contact: { name: c.name || '', business: c.business || '', phone: c.phone || '', address: c.address || '' },
    // from the customer details form (Max, 20 Oct 2026): where the gear goes, when it starts, what to know
    venue: c.eventVenue || '',
    times: { start: c.eventStartTime || q.botStart || '', finish: q.botFinish || '' },
    customerNotes: c.customerNotes || '',
    dayContact: c.dayContact || '',
    assigned: (q.crewAssigned || []).map((x) => ({ name: x.name || '', phone: x.phone || '' })),   // staff on the job (Max, 21 Oct 2026)
    crew,
    notes: q.crewNotes || '',
    items,
    ticks: q.pickTicks || {},
    paidInFull: q.paymentStatus === 'paid' || q.status === 'paid',
  };
});

/* PUBLIC (crew link) - tick / untick Packed or Returned on one item */
exports.setPickTick = onCall(async (request) => {
  const d = request.data || {};
  const field = d.field === 'returned' ? 'returned' : (d.field === 'packed' ? 'packed' : '');
  const key = String(d.key || '');
  if (!field || !/^[a-zA-Z0-9_-]{1,120}$/.test(key)) throw new HttpsError('invalid-argument', 'Bad tick.');
  const doc = await quoteByCrewToken(d.token);
  if (!pickReady(doc.data())) throw new HttpsError('failed-precondition', 'This pick list is not available.');
  await doc.ref.update({
    ['pickTicks.' + key + '.' + field]: d.value === true,
    pickUpdatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

exports.adminSendQuote = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  requireAdmin(request);
  const { id } = request.data || {};
  const ref = db.collection('quotes').doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such quote.');
  const q = snap.data();
  if (!(q.customer && q.customer.email)) {
    throw new HttpsError('failed-precondition', 'Add a customer email first.');
  }

  if (q.status === 'draft') throw new HttpsError('failed-precondition', 'Approve the estimate as a quote first.');
  if (q.isTemplate) throw new HttpsError('failed-precondition', 'This is a template - it can\'t be sent.');
  const link = SITE_URL + '/quote?t=' + q.token;
  const mail = await sendQuoteLinkEmail(q, link);

  const update = { updatedAt: FieldValue.serverTimestamp() };
  if (mail.sent && q.status === 'approved') {
    update.status = 'sent';
    update.sentAt = FieldValue.serverTimestamp();
  }
  // EMAIL RECORD (Max, 16 Oct 2026): when it last went out, to whom, how many times
  if (mail.sent) {
    update.lastEmailedAt = FieldValue.serverTimestamp();
    update.lastEmailedTo = String(q.customer.email || '') + (q.customer.ccEmail ? ' (cc ' + q.customer.ccEmail + ')' : '');
    update.emailCount = FieldValue.increment(1);
  }
  await ref.update(update);
  return mail;
});

/*  PUBLIC - fetch a quote by its token. Returns a customer-safe subset; the
    doc itself stays closed to browsers.                                    */
const QUOTE_DEPOSIT_PCT = 50;   // deposit to secure a booking (Max, 16 Oct 2026)

exports.getQuote = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  const token = String((request.data || {}).token || '').trim();
  if (!/^[a-f0-9]{20,40}$/.test(token)) throw new HttpsError('invalid-argument', 'That link is not valid.');

  const snap = await db.collection('quotes').where('token', '==', token).limit(1).get();
  if (snap.empty) throw new HttpsError('not-found', 'That link is not valid.');
  const q = snap.docs[0].data();
  if (q.status === 'cancelled') throw new HttpsError('failed-precondition', 'This quote is no longer available.');

  const secs = (t) => (t && t.seconds != null ? t.seconds : null);

  // included / required items are grouped by category on the customer's copy,
  // the same as in the quote builder (Max, 15 Oct 2026)
  const lines = (q.lines || []).map((l) => ({ ...l }));
  const kitIds = [...new Set(lines.filter((l) => l.itemId).map((l) => l.itemId))];   // all gear lines: used for the Audio / Lighting / Staging breakdown too
  if (kitIds.length) {
    try {
      const docs = await db.getAll(...kitIds.map((id) => db.collection('inventory').doc(id)));
      const cat = {};
      docs.forEach((d) => { if (d.exists) cat[d.id] = String(d.data().category || ''); });
      lines.forEach((l) => { if (l.itemId) l.category = cat[l.itemId] || ''; });
    } catch (e) { logger.warn('getQuote categories', e); }
  }

  return {
    number: q.number,
    invoiceNumber: q.invoiceNumber || '',
    kind: q.kind || 'quote',
    status: q.status,
    customer: q.customer || {},
    hire: q.hire || {},
    delivery: q.delivery || {},
    lines,
    notes: q.notes || '',
    terms: q.terms || '',
    subtotalCents: q.subtotalCents || 0,
    discountCents: q.discountCents || 0,
    gstCents: q.gstCents || 0,
    totalCents: q.totalCents || 0,
    lateFeeCents: q.lateFeeCents || 0,                 // late payment charges (on top of the total)
    lateFees: Array.isArray(q.lateFees) ? q.lateFees.map((x) => ({ cents: x.cents || 0, date: x.date || '' })) : [],
    acceptedName: q.acceptedName || '',
    acceptedAt: secs(q.acceptedAt),
    createdAt: secs(q.createdAt),
    paymentStatus: q.paymentStatus || '',      // '' | bank | deposit | paid
    bankPlan: q.bankPlan || '',                // bank payers: 'deposit' | 'full'
    payFull: q.payFull === true,               // "pay in full up front" - no deposit option (Max, 22 Oct 2026)
    gigDj: q.gigDj || (q.gigBookingId ? await gigDjFor(q.gigBookingId) : null),   // DJ gig quotes: who played + their set (Max, 22 Oct 2026)
    paymentMethod: q.paymentMethod || '',
    amountPaidCents: q.amountPaidCents || 0,
    depositPct: QUOTE_DEPOSIT_PCT,
    cardOn: !!STRIPE_SECRET_KEY.value(),
  };
});

/*  PUBLIC - the customer accepts, by token. Idempotent once accepted.     */
exports.acceptQuote = onCall(async (request) => {
  const data = request.data || {};
  const token = String(data.token || '').trim();
  const name = String(data.name || '').trim().slice(0, 120);
  if (!/^[a-f0-9]{20,40}$/.test(token)) throw new HttpsError('invalid-argument', 'That link is not valid.');

  const snap = await db.collection('quotes').where('token', '==', token).limit(1).get();
  if (snap.empty) throw new HttpsError('not-found', 'That link is not valid.');
  const doc = snap.docs[0];
  const q = doc.data();

  if (q.status === 'accepted' || q.kind === 'invoice') return { ok: true, already: true };
  if (!['approved', 'sent'].includes(q.status)) {
    throw new HttpsError('failed-precondition', 'This quote can no longer be accepted.');
  }

  const bank = data.method === 'bank';
  // ACCEPT = INVOICE (Max, 16 Oct 2026): the quote becomes a tax invoice straight away
  const inv = q.invoiceNumber || invoiceNo((await nextInvoiceNumber()).n);
  await doc.ref.update({
    status: 'invoiced',
    kind: 'invoice',
    invoiceNumber: inv,
    invoicedAt: FieldValue.serverTimestamp(),
    acceptedName: name,
    acceptedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    // BANK IN FULL (Max, 20 Oct 2026): a bank payer picks deposit or the whole amount
    ...(bank ? { paymentMethod: 'bank', paymentStatus: 'bank', bankPlan: data.plan === 'full' || q.payFull === true ? 'full' : 'deposit' } : {}),
  });
  return { ok: true };
});

/* -------------------------------------------------------------------------
   quoteCheckout  PUBLIC (Max, 16 Oct 2026)
   The customer accepts their quote and pays by card through Stripe -
   either the 50% deposit or the full amount (or the balance, once the
   deposit is in). The quote is only marked accepted / paid when Stripe's
   webhook confirms the money, never on the strength of this call.
   ------------------------------------------------------------------------- */
exports.quoteCheckout = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  const data = request.data || {};
  const token = String(data.token || '').trim();
  const name = String(data.name || '').trim().slice(0, 120);
  const option = data.option === 'full' ? 'full' : 'deposit';
  if (!/^[a-f0-9]{20,40}$/.test(token)) throw new HttpsError('invalid-argument', 'That link is not valid.');
  if (!name) throw new HttpsError('invalid-argument', 'Please type your name to accept.');
  if (data.agreed !== true) throw new HttpsError('invalid-argument', 'Please tick to accept the booking terms.');

  const snap = await db.collection('quotes').where('token', '==', token).limit(1).get();
  if (snap.empty) throw new HttpsError('not-found', 'That link is not valid.');
  const doc = snap.docs[0];
  const q = doc.data();
  if (!['approved', 'sent', 'accepted', 'invoiced'].includes(q.status) || q.paymentStatus === 'paid') {
    throw new HttpsError('failed-precondition', 'This quote can no longer be paid online.');
  }

  const total = Math.max(0, Math.round(quoteGrandTotal(q)));   // + any late payment charges
  const paid = Math.max(0, Math.round(q.amountPaidCents || 0));
  const owing = total - paid;
  // PAY IN FULL WITHIN 7 DAYS (Max, 20 Oct 2026): the balance is due 7 days
  // before the event, so from then on there is no deposit option.
  const dueDay = addDaysISO(q.hire && q.hire.startDate, -7);
  const fullOnly = (!!dueDay && dueDay <= brisbaneToday()) || q.payFull === true;   // or "pay in full up front" (Max, 22 Oct 2026)
  let amount = option === 'full' || paid > 0 || fullOnly ? owing : Math.round(total * QUOTE_DEPOSIT_PCT / 100);
  if (amount < 50) throw new HttpsError('failed-precondition', 'Nothing left to pay on this quote.');
  const label = paid > 0 ? 'balance' : (option === 'full' || fullOnly ? 'payment in full' : QUOTE_DEPOSIT_PCT + '% deposit');

  const stripe = getStripe();
  const back = SITE_URL + '/quote?t=' + token;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: (q.customer && q.customer.email) || undefined,
    client_reference_id: 'quote:' + doc.id,
    metadata: { quoteId: doc.id, payOption: label, acceptedName: name },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'aud',
        unit_amount: amount,
        product_data: {
          name: 'Quote ' + (q.number || '') + ' - ' + label,
          description: ((q.customer && q.customer.eventName) || 'SoundzGood Whitsundays booking') + ' (incl GST)',
        },
      },
    }],
    success_url: back + '&paid=1',
    cancel_url: back,
  });
  return { url: session.url };
});

/*  sendLeadEmail  admin - outreach to a prospect from the lead generator.
    The admin drafts and edits the message in the panel, then presses Send;
    this delivers it through the same SMTP as the rest of the site. Never
    auto-sends - it is always a human action. Stamps lastContacted / emailedAt
    onto the lead so the panel shows the mail went.                          */
exports.sendLeadEmail = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  requireAdmin(request);
  const d = request.data || {};
  const to = String(d.to || '').trim().slice(0, 200);
  const subject = String(d.subject || '').trim().slice(0, 200);
  const body = String(d.body || '').slice(0, 20000);
  const leadId = String(d.leadId || '').trim().slice(0, 60);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpsError('invalid-argument', 'That email does not look right.');
  if (!subject || !body.trim()) throw new HttpsError('invalid-argument', 'Add a subject and a message.');

  const mail = await sendLeadEmail({ to, subject, body });
  if (!mail.sent) {
    throw new HttpsError('internal', mail.reason === 'no-smtp'
      ? 'Email is not configured yet.'
      : ('Could not send: ' + (mail.error || mail.reason || 'unknown')));
  }

  if (leadId) {
    try {
      await db.collection('leads').doc(leadId).set({
        lastContacted: new Date().toISOString().slice(0, 10),
        emailedAt: FieldValue.serverTimestamp(),
        updatedAt: Date.now(),
      }, { merge: true });
    } catch (e) { logger.warn('lead email sent but stamp failed', { leadId, message: e && e.message }); }
  }
  return { ok: true };
});

/* =========================================================================
   BOT QUOTE  -  the public estimate bot (Phase 2)

   A visitor answers a few questions; the server matches the best package,
   prices it (gear + kit-required gear + labour + delivery + optional tech),
   creates a DRAFT quote for staff to review and send, and returns only an
   on-screen price range. Nothing bulky ships to the browser; the inventory
   and packages are read here, not in the page.
   ========================================================================= */
const { expandKit: botExpandKit } = require('./lib/kit');

const BOT_KM_RATE_CENTS = 80;        // $0.80/km travelled
const { labourParts, labourDayRate } = require('./lib/labour');   // crew rate + weekend / holiday loadings
const BOT_PACKDOWN_PCT = 0.75;
const BOT_ZONES = [
  ['Bowen (local)', 0], ['Merinda', 12], ['Guthalungra', 38], ['Proserpine', 64],
  ['Home Hill', 79], ['Cannonvale', 84], ['Cape Gloucester Resort', 85], ['Collinsville', 86], ['Scottville', 88],
  ['Airlie Beach', 88], ['Jubilee Pocket', 90], ['Ayr', 91], ['Bloomsbury', 95],
  ['Shute Harbour', 98], ['Brandon', 98], ['Giru', 130], ['Glenden', 150],
  ['Mackay', 189], ['Townsville', 200], ['Charters Towers', 245], ['Moranbah', 300],
  ['Clermont', 400], ['Hughenden', 450], ['Emerald', 500], ['Richmond', 560],
  ['Winton', 660], ['Julia Creek', 670], ['Cloncurry', 780], ['Longreach', 810],
  ['Mount Isa', 900], ['Barcaldine', 900],
];
function botZoneKm(town) {
  const t = String(town || '').trim().toLowerCase();
  const z = BOT_ZONES.find((z) => z[0].toLowerCase() === t);
  return z ? z[1] : null;
}

function botPickPackage(packages, eventType, guests) {
  const et = String(eventType || '').toLowerCase();
  const active = packages.filter((p) => p.active !== false && Array.isArray(p.items) && p.items.length);
  let typed = active.filter((p) => String(p.eventType || '').toLowerCase() === et);
  if (!typed.length) typed = active.filter((p) => {
    const pe = String(p.eventType || '').toLowerCase();
    return pe && (pe.includes(et) || et.includes(pe));
  });
  if (!typed.length) typed = active;
  if (!typed.length) return null;
  const fits = typed
    .filter((p) => !p.maxGuests || guests <= p.maxGuests)
    .sort((a, b) => (a.maxGuests || 1e9) - (b.maxGuests || 1e9));
  if (fits.length) return fits[0];
  return typed.slice().sort((a, b) => (b.maxGuests || 0) - (a.maxGuests || 0))[0];
}

const BOT_GENERATOR_CENTS = 25000;   // $250/day estimate when there's no mains power
const BOT_EXTRA_MAP = {
  mic: { label: 'Extra mic (speeches / MC)', kw: ['glxd', 'wireless'], qty: 1 },
  dancefloor: { label: 'Dance floor', kw: ['dance floor'], qty: 1 },
  staging: { label: 'Stage / riser', kw: ['stage 6m x 2m', 'stage 6m'], qty: 1 },
  lighting: { label: 'Extra lighting', kw: ['moving head', 'm1s80w'], qty: 2 },
  projector: { label: 'Projector & screen', kw: ['projector'], qty: 1 },
  haze: { label: 'Haze / smoke machine', kw: ['haze'], qty: 1 },
};
function botFindItem(inv, kws) {
  const low = (s) => String(s || '').toLowerCase();
  return inv.find((it) => it && it.name && kws.some((k) => low(it.name).includes(k))) || null;
}

exports.submitBotQuote = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  await limitIp(request, 'bot', 10, 60);   // security audit: 10 estimates an hour per visitor
  const d = request.data || {};
  if (String(d.website || d.company_url || '').trim()) return { ok: true };   // honeypot

  const a = d.answers || {};
  const eventType = String(a.eventType || '').trim().slice(0, 80);
  const guests = Math.max(0, Math.round(Number(a.guests) || 0));
  const days = Math.max(1, Math.round(Number(a.days) || 1));
  const town = String(a.town || '').trim().slice(0, 80);
  const support = ['full', 'delivery', 'pickup'].includes(a.support) ? a.support : 'delivery';
  const delivered = support !== 'pickup';
  const km = delivered ? (a.km != null ? Math.max(0, Math.round(Number(a.km) || 0)) : (botZoneKm(town) || 0)) : 0;
  const indoor = ['indoor', 'outdoor', 'mixed'].includes(a.indoor) ? a.indoor : '';
  const power = ['yes', 'no', 'unsure'].includes(a.power) ? a.power : '';
  const startTime = String(a.startTime || '').trim().slice(0, 40);
  const finishTime = String(a.finishTime || '').trim().slice(0, 40);
  const access = ['easy', 'stairs', 'tricky'].includes(a.access) ? a.access : 'easy';
  const extras = Array.isArray(a.extras) ? a.extras.filter((k) => typeof k === 'string').slice(0, 12) : [];
  const name = String(a.name || '').trim().slice(0, 120);
  const email = String(a.email || '').trim().slice(0, 200);
  const phone = String(a.phone || '').trim().slice(0, 40);
  const eventDate = String(a.eventDate || '').trim().slice(0, 60);
  const message = String(a.message || '').trim().slice(0, 2000);

  if (!eventType) throw new HttpsError('invalid-argument', 'Please choose an event type.');
  if (!name || !(email || phone)) throw new HttpsError('invalid-argument', 'Please leave your name and a contact.');
  if (email) await rateLimit('bot|to|' + email.toLowerCase(), 3, 24 * 60);   // security audit: never a spam cannon

  const inv = await loadQuoteInventory();
  const byId = {};
  inv.forEach((it) => { byId[it.id] = it; });

  // PACKAGES (Max, 17 Oct 2026): packages built in Inventory (kits + items)
  // that are ticked for the bot, plus any old-style ones not yet moved over.
  const pkgSnap = await db.collection('packages').get();
  const packages = [];
  pkgSnap.forEach((x) => { const p = x.data() || {}; if (!p.migratedTo) packages.push({ id: x.id, ...p }); });
  inv.filter((it) => it.isSystem && it.bundleType === 'package' && it.botOffer === true).forEach((it) => packages.push({
    id: it.id, name: it.name || 'Package', eventType: it.eventType || '', maxGuests: it.maxGuests || 0, active: true,
    items: [{ itemId: it.id, qty: 1 }],
    overrideCents: it.priceCents || 0,
    invPackage: it,   // built in Inventory: quoted ITEMISED (kit prices + package discount)
  }));

  const isOther = /^other/i.test(eventType);
  const pkg = isOther ? null : botPickPackage(packages, eventType, guests);

  // Build itemised lines from the matched package (if any) via the kit engine.
  // "Other" / no match still creates a draft from the extras + services below and
  // returns no instant range - staff build a custom quote from the intake.
  const lines = [];
  let discountCents = 0;
  if (pkg && pkg.invPackage) {
    // ITEMISED (Max, 17 Oct 2026): each kit / item priced, parts Included, then the package discount
    const P = pkg.invPackage;
    const eff = {};
    (P.requirements || []).forEach((r) => { if (r && r.itemId) eff[r.itemId] = (eff[r.itemId] || 0) + Math.max(0, Math.round(r.qty || 0)); });
    const order = [];
    ((P.systemParts && P.systemParts.length) ? P.systemParts : (P.requirements || [])).forEach((p) => { if (p && eff[p.itemId] && !order.includes(p.itemId)) order.push(p.itemId); });
    Object.keys(eff).forEach((id) => { if (!order.includes(id)) order.push(id); });
    let full = 0;
    order.forEach((id) => {
      const it = byId[id];
      if (!it) return;
      lines.push({ type: 'item', itemId: id, name: it.name || id, description: it.subtitle || '', qty: eff[id], unitCents: it.priceCents || 0, days, pkgId: P.id });
      full += (it.priceCents || 0) * eff[id] * days;
      botExpandKit({ [id]: eff[id] }, byId).required.forEach((r) => {
        const charged = r.charge === 'normal';
        lines.push({ type: 'kit', itemId: r.itemId, name: r.name, qty: r.qty, unitCents: charged ? r.unitCents : 0, charge: r.charge, days: charged ? days : 1 });
        if (charged) full += r.unitCents * r.qty * days;
      });
    });
    // crew in the package (Audio Operator...)
    (Array.isArray(P.crewParts) ? P.crewParts : []).forEach((c) => {
      const q2 = Math.max(1, Math.round(c.qty || 1));
      lines.push({ type: 'custom', name: c.name || 'Crew', qty: q2, unitCents: Math.max(0, Math.round(c.dayRateCents || 0)), days, resType: ['staff', 'vehicle', 'trailer'].includes(c.type) ? c.type : 'staff', pkgId: P.id });
      full += Math.max(0, Math.round(c.dayRateCents || 0)) * q2 * days;
    });
    const target = Math.max(0, Math.round(P.priceCents || 0)) * days;
    if (target > 0 && full > target) lines.push({ type: 'discount', name: (P.name || 'Package') + ' - package discount', amountCents: full - target, pkgId: P.id });
  } else if (pkg) {
    const cart = {};
    (pkg.items || []).forEach((i) => { if (i.itemId) cart[i.itemId] = (cart[i.itemId] || 0) + Math.max(0, Math.round(i.qty || 0)); });
    const kit = botExpandKit(cart, byId);
    kit.base.forEach((b) => {
      const it = byId[b.itemId] || {};
      lines.push({ type: 'item', itemId: b.itemId, name: it.name || b.itemId, description: it.subtitle || '', qty: b.qty, unitCents: it.priceCents || 0, days });
    });
    kit.required.forEach((r) => {
      const charged = r.charge === 'normal';
      lines.push({ type: 'kit', itemId: r.itemId, name: r.name /* no "(included)" - the Included column says it */, qty: r.qty, unitCents: charged ? r.unitCents : 0, charge: r.charge, days: charged ? days : 1 });
    });
    const gearValue = kit.base.reduce((s, b) => s + b.lineCents, 0) + kit.addCents;
    const afterDisc = Math.max(0, gearValue - Math.max(0, Math.round(pkg.discountCents || 0)));
    const target = pkg.overrideCents > 0 ? pkg.overrideCents : Math.max(Math.max(0, Math.round(pkg.minCents || 0)), afterDisc);
    const adjust = target - gearValue;
    if (adjust < 0) discountCents = -adjust;                        // discount down to target
    else if (adjust > 0) lines.push({ type: 'custom', name: (pkg.name || 'Package') + ' — package price', qty: 1, unitCents: adjust, days: 1 });   // top up to the floor/override
  }

  // Customer-picked extras, each mapped to a real inventory item (full price).
  const chosenExtras = [];
  extras.forEach((key) => {
    const spec = BOT_EXTRA_MAP[key];
    if (!spec) return;
    const it = botFindItem(inv, spec.kw);
    if (!it) return;
    lines.push({ type: 'item', itemId: it.id, name: it.name, description: it.subtitle || '', qty: spec.qty, unitCents: it.priceCents || 0, days });
    chosenExtras.push(spec.label);
  });

  // Generator when it's outdoors with no mains power.
  const needsGenerator = (indoor === 'outdoor' || indoor === 'mixed') && power === 'no';
  if (needsGenerator) {
    lines.push({ type: 'custom', name: 'Generator (no mains power)', description: 'Estimate — confirmed on review', qty: 1, unitCents: BOT_GENERATOR_CENTS, days });
  }

  if (delivered) {
    let mins = 0;
    lines.forEach((l) => { if (l.itemId && byId[l.itemId]) mins += Math.max(0, Math.round(byId[l.itemId].setupMins || 0)) * Math.max(0, Math.round(l.qty || 0)); });
    // Harder access = more crew time on site.
    const accessMins = access === 'tricky' ? 120 : (access === 'stairs' ? 60 : 0);
    const setupTotal = mins + accessMins;
    if (setupTotal > 0) {
      // same rates as the admin quote builder (lib/labour.js): crew rate + weekend / public holiday loadings
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(String(a.eventDateISO || '')) ? a.eventDateISO : '';
      const note = accessMins ? ` (incl. ${access} access)` : '';
      labourParts(setupTotal, { startDate: iso, endDate: iso, town }).forEach((p) => lines.push({
        type: 'labour', name: p.lineName,
        description: p.lineDesc + note + (iso ? '' : ' – weekend & public holiday surcharges may apply'),
        qty: 1, unitCents: p.cents, days: 1,
      }));
    }
    const del = km * 2 * BOT_KM_RATE_CENTS;
    if (del > 0) lines.push({ type: 'delivery', name: 'Travel & transport' + (town ? ' — ' + town : ''), description: 'Fuel and vehicle running costs · ' + km + ' km each way (' + (km * 2) + ' km return) @ $0.80/km', qty: 1, unitCents: del, days: 1 });
  }

  if (support === 'full') {
    let techRate = 60000;   // $600 default; use the highest active staff rate if set
    try {
      const rs = await db.collection('resources').where('type', '==', 'staff').limit(10).get();
      rs.forEach((x) => { const r = x.data(); if (r.active !== false && r.dayRateCents) techRate = Math.max(techRate, r.dayRateCents); });
    } catch (e) { /* default */ }
    // same day loadings as labour (Sat +25%, Sun +50%, public holiday +50%), day by day
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(String(a.eventDateISO || '')) ? a.eventDateISO : '';
    let techTotal = 0;
    for (let d = 0; d < days; d++) {
      let day = '';
      if (iso) { const [y, m, dd] = iso.split('-').map(Number); day = new Date(Date.UTC(y, m - 1, dd + d)).toISOString().slice(0, 10); }
      techTotal += Math.round(techRate * labourDayRate(day, town, false).mult);
    }
    lines.push({ type: 'custom', name: 'On-site AV technician', qty: 1, unitCents: Math.round(techTotal / days), baseCents: techRate, days, resType: 'staff' });
  }

  // BOOKING & ADMIN FEE: 2% of everything before GST - same as the admin quote builder (Max, 16 Oct 2026)
  // rounded to the nearest $10 so it reads cleanly (Max, 17 Oct 2026)
  const feeCents = Math.round(quoteMoney({ hire: { days }, lines, discountCents }).netCents * 2 / 100 / 1000) * 1000;
  if (feeCents > 0) lines.push({ type: 'fee', name: 'Booking & admin', qty: 1, unitCents: feeCents, days: 1 });

  const quote = {
    kind: 'quote',
    customer: { name, email, phone, business: '', address: '', eventName: eventType, eventDate },
    hire: { startDate: '', endDate: '', days },
    lines, discountCents, labourExcluded: false,
    delivery: { town: delivered ? town : '', km: delivered ? km : 0 },
    notes: '', terms: '',
  };
  const clean = sanitizeQuote(quote);
  const money = quoteMoney(clean);

  const counterRef = db.collection('config').doc('counters');
  const seq = await db.runTransaction(async (tx) => {
    const c = await tx.get(counterRef);
    const n = ((c.exists && c.data().quoteSeq) || 0) + 1;
    tx.set(counterRef, { quoteSeq: n }, { merge: true });
    return n;
  });
  const number = 'SG-Q-' + String(seq).padStart(4, '0');
  const token = crypto.randomBytes(16).toString('hex');

  const draftRef = await db.collection('quotes').add({
    number, token, status: 'draft', ...clean, ...money,
    source: 'bot', packageId: pkg ? pkg.id : '', packageName: pkg ? (pkg.name || '') : '', guests, botSupport: support,
    botMessage: message, botTown: town,
    botIndoor: indoor, botPower: power, botStart: startTime, botFinish: finishTime,
    botAccess: access, botExtras: chosenExtras, botGenerator: needsGenerator,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: 'bot',
  });

  // On-screen range (+/- 10%, rounded to $10) only when a package matched.
  // "Other" enquiries return no range - the team builds a custom quote.
  const resp = { ok: true, packageName: pkg ? (pkg.name || '') : '' };
  let lowCents = null;
  let highCents = null;
  if (pkg) {
    const total = money.totalCents;
    lowCents = Math.max(0, Math.floor((total * 0.9) / 1000) * 1000);
    highCents = Math.ceil((total * 1.1) / 1000) * 1000;
    resp.lowCents = lowCents;
    resp.highCents = highCents;
  } else {
    resp.custom = true;
  }

  /*  Instant price-guide email to the visitor. Reuses the same estimate
      template as the retired services bot (working as intended). It never
      throws - the draft is already saved, so a mail hiccup can't lose the
      enquiry; the send result is logged and folded back onto the draft.   */
  if (email) {
    const extraLabels = chosenExtras.slice();
    if (needsGenerator) extraLabels.push('Generator');
    if (support === 'full') extraLabels.push('On-site technician');
    const lead = {
      name, email,
      eventTypeLabel: eventType,
      locationLabel: town,
      sizeLabel: guests ? guests + ' guests' : '',
      durationLabel: days > 1 ? days + ' days' : '',
      serviceLabels: extraLabels,
      eventDate,
      estimateLowCents: lowCents,
      estimateHighCents: highCents,
    };
    const mail = await sendQuoteEmail(lead);
    try {
      await draftRef.update({
        emailStatus: mail.sent ? 'sent' : 'failed',
        emailAt: FieldValue.serverTimestamp(),
        emailError: mail.sent ? FieldValue.delete()
          : String(mail.error || mail.reason || '').slice(0, 500),
      });
    } catch (e) { /* logged inside sendQuoteEmail; don't fail the enquiry */ }
  }

  return resp;
});

/* =========================================================================
   TELL - Max's Telegram inbox for gig opportunities (see lib/tell.js).
   ========================================================================= */
const TELEGRAM_TOKEN = defineSecret('TELEGRAM_TOKEN');
const tell = require('./lib/tell');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');

exports.tellBot = onRequest({ secrets: [TELEGRAM_TOKEN], cors: false }, async (req, res) => {
  const token = TELEGRAM_TOKEN.value();
  // one-off: GET ?setup=1 points the bot at this URL
  if (req.method === 'GET' && req.query.setup === '1') {
    // the public address of this function (Cloud Run strips the /tellBot path from req.url, so it's fixed here)
    res.json(await tell.setup(token, 'https://australia-southeast1-soundzgood-8c86f.cloudfunctions.net/tellBot'));
    return;
  }
  // status: GET ?info=1 shows Telegram's delivery status (no secrets)
  if (req.method === 'GET' && req.query.info === '1') {
    const r = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`).then((x) => x.json()).catch(() => ({}));
    const i = r.result || {};
    res.json({ url: i.url, pending: i.pending_update_count, lastError: i.last_error_message || '', lastErrorAt: i.last_error_date ? new Date(i.last_error_date * 1000).toISOString() : '' });
    return;
  }
  if (req.method !== 'POST' || req.get('X-Telegram-Bot-Api-Secret-Token') !== tell.hookSecret(token)) { logger.warn('tellBot rejected', { method: req.method, hasHeader: !!req.get('X-Telegram-Bot-Api-Secret-Token') }); res.status(403).send('no'); return; }
  try { await tell.handleUpdate(token, req.body || {}); } catch (e) { logger.error('tellBot', e); }
  res.status(200).send('ok');   // always 200 so Telegram doesn't retry
});

exports.tellOutbox = onDocumentCreated({ document: 'tellOutbox/{id}', secrets: [TELEGRAM_TOKEN] }, async (event) => {
  if (event.data) await tell.sendOutbox(TELEGRAM_TOKEN.value(), event.data);
});

/* =========================================================================
   eventLineup - who's coming, for the punters' About page

   GET ?event=<eventId>  ->  { food: [{ name, category, categoryId, link }], market: [...] }

   Bookings are private (they hold contact details and money), so the page
   cannot read them itself. This hands out the business name and its
   category ONLY, and only for vendors who are confirmed AND paid (or
   marked free) - Max, 14 Oct 2026. Nothing else ever leaves here.
   ========================================================================= */
/*  The vendor's own link, from the "Social media links" box they filled in
    (free text). Only a real web address is used - the first one found,
    https added if they left it off. A bare @handle is skipped: it could
    be Instagram or Facebook, and a wrong guess sends people nowhere.    */
const LINK_ENDINGS = ['com', 'au', 'net', 'org', 'nz', 'co', 'io', 'me', 'info', 'biz', 'shop', 'store', 'online', 'site', 'page', 'link', 'app'];

/*  One short line about the vendor, in their own words: the first sentence
    of the description they wrote when they booked, cut to fit a card.  */
function lineupBlurb(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  let first = (t.match(/^.*?[.!?](\s|$)/) || [t])[0].trim();
  if (first.length > 80) first = first.slice(0, 77).replace(/\s+\S*$/, '') + '...';
  return first;
}

function lineupLink(text) {
  // word by word, so an email address (bob@gmail.com) is never taken for a website
  for (const word of String(text || '').split(/[\s,;|]+/)) {
    if (!word || word.includes('@')) continue;
    if (!/^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#]\S*)?$/i.test(word)) continue;
    let url = word.replace(/[).]+$/, '');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      const u = new URL(url);
      // a real web ending only - "re.weaved" is an Instagram name, not a site
      const end = u.hostname.split('.').pop();
      if (/^https?:$/.test(u.protocol) && LINK_ENDINGS.includes(end)) return u.href.slice(0, 300);
    } catch (e) { /* not a real address - try the next word */ }
  }
  return '';
}

exports.eventLineup = onRequest({ cors: true }, async (req, res) => {
  const eventId = String(req.query.event || '');
  if (!/^[a-z0-9-]{3,80}$/.test(eventId)) { res.status(400).json({ error: 'bad event' }); return; }
  try {
    const [snap, cats] = await Promise.all([
      db.collection('bookings').where('eventId', '==', eventId).where('status', '==', 'confirmed').get(),
      db.collection('events').doc(eventId).collection('categories').get(),
    ]);
    const catName = {};
    cats.forEach((d) => { catName[d.id] = d.data().name || ''; });
    const out = { food: [], market: [] };
    const seen = new Set();
    snap.forEach((d) => {
      const b = d.data();
      if (!['paid', 'free'].includes(b.paymentStatus)) return;
      const name = String((b.business && b.business.name) || '').trim().slice(0, 60);
      if (!name || seen.has(name.toLowerCase())) return;   // one line per business
      seen.add(name.toLowerCase());
      const list = b.vendorType === 'food' ? out.food : out.market;
      list.push({ name, category: String(catName[b.categoryId] || '').slice(0, 40), categoryId: String(b.categoryId || '').slice(0, 40), blurb: lineupBlurb(b.business && b.business.description), link: lineupLink(b.business && b.business.socials) });
    });
    out.food.sort((a, b) => a.name.localeCompare(b.name));
    out.market.sort((a, b) => a.name.localeCompare(b.name));
    res.set('Cache-Control', 'public, max-age=300');   // 5 minutes
    res.json(out);
  } catch (e) {
    logger.error('eventLineup', e);
    res.status(500).json({ error: 'failed' });
  }
});

/* -------------------------------------------------------------------------
   VENDOR TAX INVOICES  (Max, 19 Oct 2026)

   Each paid vendor booking gets an invoice number from the SAME sequence as
   the Sales Pipeline invoices (SG-I-0001 ...) and a private link to a
   printable page (/vendor-invoice?t=<token>) holding the tax invoice, a
   thank-you, the event details and the vendor instructions.

     adminVendorInvoiceLink   admin - makes the invoice number + link if
                              there isn't one yet, returns the link (preview)
     adminSendVendorInvoice   admin - emails it. { test: true } sends ONLY to
                              the signed-in admin and records nothing. Without
                              test it goes to the vendor.
     getVendorInvoice         public - the page's data, by token

   NOTHING IS SENT AUTOMATICALLY. Max previews one, then says go.
   ------------------------------------------------------------------------- */
const { sendVendorInvoiceEmail } = require('./lib/vendor-invoice-email');

function bookingIsPaid(b) {
  return b.status === 'confirmed' || b.paymentStatus === 'paid' || b.paymentStatus === 'free';
}

/*  Gives the booking an invoice number + token, once. Safe to call again. */
async function ensureVendorInvoice(bookingId) {
  const ref = db.collection('bookings').doc(bookingId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'No such booking.');
    const b = snap.data();
    if (!bookingIsPaid(b)) {
      throw new HttpsError('failed-precondition', 'That booking has not been paid, so there is no invoice.');
    }
    if (b.invoiceNumber && b.invoiceToken) {
      return { booking: b, invoiceNumber: b.invoiceNumber, token: b.invoiceToken };
    }
    const num = b.invoiceNumber ? null : await nextInvoiceNumber(tx);
    const invoiceNumber = b.invoiceNumber || invoiceNo(num.n);
    const token = b.invoiceToken || crypto.randomBytes(16).toString('hex');
    if (num) num.write();
    tx.update(ref, {
      invoiceNumber,
      invoiceToken: token,
      ...(b.invoicedAt ? {} : { invoicedAt: FieldValue.serverTimestamp() }),
    });
    return { booking: b, invoiceNumber, token };
  });
}

exports.adminVendorInvoiceLink = onCall(async (request) => {
  requireAdmin(request);
  const id = String((request.data || {}).bookingId || '').trim();
  if (!id) throw new HttpsError('invalid-argument', 'Missing booking.');
  const inv = await ensureVendorInvoice(id);
  return { ok: true, invoiceNumber: inv.invoiceNumber, link: SITE_URL + '/vendor-invoice?t=' + inv.token };
});

/*  Sends one vendor their invoice & guide email. opts.test + opts.to sends a
    TEST copy to that address only and records nothing.                   */
async function sendVendorInvoice(id, opts) {
  const inv = await ensureVendorInvoice(id);
  const b = inv.booking;
  const evSnap = await db.collection('events').doc(b.eventId).get();
  const ev = evSnap.exists ? evSnap.data() : {};
  const biz = b.business || {};
  const test = opts.test === true;
  const to = test ? String(opts.to || '') : String(biz.email || '');
  if (!to) return { sent: false, reason: 'no-address' };
  const total = b.totalCents != null ? b.totalCents : (b.amountCents || 0);
  // wording from the Messages page: the APPROVED copy (a test can use the draft)
  let tpl = {};
  try {
    const ms = await db.collection('messages').where('eventId', '==', b.eventId).get();
    const sys = ms.docs.map((x) => x.data()).find((x) => x.system === 'invoice');
    if (sys && opts.useDraft && sys.body) tpl = { subjectTpl: sys.subject, bodyTpl: sys.body };
    else if (sys && sys.approvedBody) tpl = { subjectTpl: sys.approvedSubject, bodyTpl: sys.approvedBody };
  } catch (e) { logger.warn('invoice wording', e && e.message); }
  const mail = await sendVendorInvoiceEmail({
    ...tpl,
    siteLabel: b.siteLabel || '',
    eventVenue: [ev.venue, ev.location].filter(Boolean).join(', '),
    to, test,
    link: SITE_URL + '/vendor-invoice?t=' + inv.token,
    invoiceNumber: inv.invoiceNumber,
    totalCents: total,
    businessName: biz.name || '',
    contactName: biz.contactName || '',
    eventName: ev.name || '',
    eventDate: ev.dateLabel || '',
  });
  if (mail.sent && !test) {
    await db.collection('bookings').doc(id).update({
      invoiceEmailedAt: FieldValue.serverTimestamp(),
      invoiceEmailedTo: to,
    });
  }
  return { ...mail, to, test, invoiceNumber: inv.invoiceNumber };
}

/*  SEND TO EVERY PAID VENDOR of an event who has not had theirs yet
    (Max said go, 19 Oct 2026). Pressed from the Sales Pipeline.        */
exports.adminSendVendorInvoicesAll = onCall({ secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 }, async (request) => {
  requireAdmin(request);
  const eventId = String((request.data || {}).eventId || '').trim();
  if (!eventId) throw new HttpsError('invalid-argument', 'Missing event.');
  const snap = await db.collection('bookings').where('eventId', '==', eventId).get();
  const out = { sent: 0, skipped: 0, failed: [] };
  for (const d of snap.docs) {
    const b = d.data();
    if (!bookingIsPaid(b) || b.status === 'cancelled' || b.invoiceEmailedAt) { out.skipped++; continue; }
    try {
      const r = await sendVendorInvoice(d.id, {});
      if (r.sent) out.sent++;
      else out.failed.push(((b.business || {}).name || d.id) + ': ' + (r.error || r.reason || 'not sent'));
    } catch (err) { out.failed.push(((b.business || {}).name || d.id) + ': ' + (err && err.message)); }
  }
  return out;
});

exports.adminSendVendorInvoice = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  requireAdmin(request);
  const data = request.data || {};
  const id = String(data.bookingId || '').trim();
  if (!id) throw new HttpsError('invalid-argument', 'Missing booking.');
  const test = data.test === true;
  if (test && !request.auth.token.email) throw new HttpsError('failed-precondition', 'Your admin login has no email address.');
  return sendVendorInvoice(id, { test, to: request.auth.token.email });
});

exports.getVendorInvoice = onCall(async (request) => {
  const token = String((request.data || {}).token || '').trim();
  if (!/^[a-f0-9]{20,40}$/.test(token)) throw new HttpsError('invalid-argument', 'That link is not valid.');

  const snap = await db.collection('bookings').where('invoiceToken', '==', token).limit(1).get();
  if (snap.empty) throw new HttpsError('not-found', 'That link is not valid.');
  const b = snap.docs[0].data();
  if (b.status === 'cancelled') throw new HttpsError('failed-precondition', 'This invoice is no longer available.');

  const evSnap = await db.collection('events').doc(b.eventId).get();
  const ev = evSnap.exists ? evSnap.data() : {};
  const biz = b.business || {};
  const secs = (t) => (t && t.seconds != null ? t.seconds : null);

  const site = b.amountCents || 0;
  const fee = b.bookingFeeCents != null ? b.bookingFeeCents : 0;
  const gst = b.gstCents != null ? b.gstCents : 0;
  const total = b.totalCents != null ? b.totalCents : site + fee + gst;

  // the site plan, with this vendor's site(s) marked (drawn on the invoice page)
  let map = null;
  try {
    const sitesSnap = await db.collection('events').doc(b.eventId).collection('sites').get();
    const sites = [];
    sitesSnap.forEach((d) => {
      const x = d.data();
      sites.push({ id: d.id, label: x.label || d.id, type: x.type || '', x: x.x, y: x.y, w: x.w, h: x.h, rotate: x.rotate || 0 });
    });
    map = {
      sites,
      landmarks: ev.landmarks || [],
      mapSize: ev.map || { width: 760, height: 1420 },
      mine: Array.isArray(b.siteIds) && b.siteIds.length ? b.siteIds : (b.siteId ? [b.siteId] : []),
    };
  } catch (e) { logger.warn('getVendorInvoice map', e); }

  // the documents this vendor uploaded - only links to our own storage bucket
  const DOC_HOSTS = ['firebasestorage.googleapis.com', 'storage.googleapis.com', 'soundzgood-8c86f.firebasestorage.app'];
  const documents = (Array.isArray(b.documents) ? b.documents : []).map((x) => {
    try {
      const u = new URL(String(x.url || ''));
      if (u.protocol !== 'https:' || !DOC_HOSTS.includes(u.hostname)) return null;
      return { name: String(x.name || 'Document').slice(0, 200), type: String(x.type || '').slice(0, 60), url: u.href };
    } catch (e) { return null; }
  }).filter(Boolean);

  return {
    map,
    documents,
    invoiceNumber: b.invoiceNumber || '',
    issuedAt: secs(b.confirmedAt) || secs(b.invoicedAt),
    reference: b.reference || '',
    business: { name: biz.name || '', contactName: biz.contactName || '', email: biz.email || '', phone: biz.phone || '' },
    siteLabel: b.siteLabel || '',
    categoryName: b.categoryName || '',
    vendorType: b.vendorType || '',
    bayCount: b.bayCount || 1,
    free: b.paymentStatus === 'free' || total === 0,
    siteCents: site, feeCents: fee, gstCents: gst, totalCents: total,
    event: {
      name: ev.name || '', subtitle: ev.subtitle || '', dateLabel: ev.dateLabel || '', dateISO: ev.dateISO || '', image: ev.image || '',
      venue: ev.venue || '', location: ev.location || '',
    },
    seller: {
      name: 'SoundzGood Whitsundays',
      legal: process.env.SG_LEGAL_NAME || '',
      abn: process.env.SG_ABN || '',
      email: process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au',
      phone: '0422 393 022',
      address: '34a Williams St, Bowen QLD 4805',
      site: 'www.soundzgood.com.au',
    },
  };
});

/*  Gives every paid vendor booking that has no invoice yet its number + link,
    so they all show in the Sales Pipeline. Makes invoices only - sends nothing. */
exports.adminEnsureVendorInvoices = onCall(async (request) => {
  requireAdmin(request);
  const snap = await db.collection('bookings').get();
  let made = 0;
  for (const d of snap.docs) {
    const b = d.data();
    if (!bookingIsPaid(b) || (b.invoiceNumber && b.invoiceToken)) continue;
    try { await ensureVendorInvoice(d.id); made++; }
    catch (err) { logger.warn('ensure vendor invoice', { id: d.id, message: err && err.message }); }
  }
  return { ok: true, made };
});

/* =========================================================================
   MESSAGES  (Max, 19 Oct 2026)  -  step 1: vendors

   Emails written in the admin Messages page, stored in messages/{id}:
     eventId, audience ('vendors'), name, subject, body (plain text + {{fields}}),
     who ('all' | 'food' | 'market'), promo (adds an unsubscribe link),
     trigger { type: 'payment' | 'daysBefore' | 'daysAfter' | 'date', days, date },
     status  'draft'    still being written
             'review'   complete, waiting for Max's OK
             'approved' sends itself at 9:35 am on its day
             'paused' | 'cancelled' | 'sent'
     system  'invoice' = the tax invoice & guide email sent on payment
   Each send is recorded in messages/{id}/sends/{bookingId}, so nobody gets
   the same message twice. NOTHING SENDS UNTIL MAX APPROVES IT, and any edit
   to an approved message puts it back to 'review'.
   ========================================================================= */
const { sendMessageEmail, fieldsFor } = require('./lib/message-email');

const MSG_TZ = 'Australia/Brisbane';
const MSG_SEND_AT = '9:35 am';
const UNSUB_URL = process.env.UNSUB_URL || 'https://vendorunsubscribe-4smug72szq-ts.a.run.app';

const brisbaneToday = () => new Date().toLocaleDateString('en-CA', { timeZone: MSG_TZ });   // YYYY-MM-DD
function brisbaneMinutesNow() {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: MSG_TZ, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
  const get = (t) => Number((parts.find((p) => p.type === t) || {}).value || 0);
  return (get('hour') % 24) * 60 + get('minute');
}
function addDaysISO(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10);
}
/*  The day a message goes out, or '' if it can't be worked out. */
function messageSendDate(msg, ev) {
  const t = msg.trigger || {};
  const days = Math.max(0, Math.round(Number(t.days) || 0));
  if (t.type === 'daysBefore') return addDaysISO(ev.dateISO, -days);
  if (t.type === 'daysAfter') return addDaysISO(ev.dateISO, days);
  if (t.type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(String(t.date || '')) ? t.date : '';
  return '';
}
function messageComplete(msg) {
  return !!(String(msg.subject || '').trim() && String(msg.body || '').trim() && msg.trigger && msg.trigger.type);
}

/*  Paid vendors of the event that this message is for. */
async function messageRecipients(msg) {
  const snap = await db.collection('bookings').where('eventId', '==', msg.eventId).get();
  return snap.docs.filter((d) => {
    const b = d.data();
    if (!bookingIsPaid(b) || b.status === 'cancelled') return false;
    if (!(b.business && b.business.email)) return false;
    if (msg.who === 'food' && b.vendorType !== 'food') return false;
    if (msg.who === 'market' && b.vendorType !== 'market') return false;
    if (msg.promo && b.promoOptOut) return false;
    return true;
  });
}

async function sendMessageTo(msg, ev, bookingDoc, opts) {
  const b = bookingDoc.data();
  const inv = await ensureVendorInvoice(bookingDoc.id);
  const values = fieldsFor(b, ev, SITE_URL + '/vendor-invoice?t=' + inv.token);
  return sendMessageEmail(msg, values, {
    to: opts.test ? opts.to : (b.business || {}).email,
    test: !!opts.test,
    unsubscribeLink: msg.promo ? UNSUB_URL + '?t=' + inv.token : '',
  });
}

/*  Recount sent / failed onto the message, from its sends. */
async function refreshMessageCounts(ref) {
  const sends = await ref.collection('sends').get();
  let sentCount = 0;
  const failed = [];
  sends.forEach((s) => {
    const x = s.data();
    if (x.ok) sentCount++;
    else failed.push({ bookingId: s.id, name: x.name || '', to: x.to || '', error: String(x.error || '').slice(0, 200) });
  });
  await ref.update({ sentCount, failed });
}

async function recordSend(ref, bookingDoc, result) {
  const b = bookingDoc.data();
  await ref.collection('sends').doc(bookingDoc.id).set({
    ok: !!result.sent,
    to: (b.business || {}).email || '',
    name: (b.business || {}).name || '',
    error: result.sent ? '' : String(result.error || result.reason || 'not sent'),
    at: FieldValue.serverTimestamp(),
  });
}

/*  Is the tax-invoice-on-payment email paused for this event? */
async function invoiceEmailPaused(eventId) {
  const snap = await db.collection('messages').where('eventId', '==', eventId).get();
  return snap.docs.some((d) => d.data().system === 'invoice' && d.data().status === 'paused');
}

/*  The invoice email's wording, as Max approved it on 19 Oct 2026. */
const INVOICE_SUBJECT = 'Your tax invoice & event guide - {{event_name}}';
const INVOICE_BODY = "Hi {{vendor_name}}, thank you for being part of {{event_name}} on {{event_date}}. Your tax invoice, event details and vendor instructions are all in one place.\n\nHelp us promote the event! A bigger crowd means more sales for every stall. Your guide includes the event poster, the A4 program and share links - please post them on your socials, share them with your customers, pop the poster up and help us advertise.";

/*  The starter messages: Max checks the wording and approves. */
function starterMessages(eventId) {
  const base = { eventId, audience: 'vendors', who: 'all', promo: false };
  return [
    { ...base, system: 'invoice', name: 'Booking confirmed + invoice & guide', status: 'approved',
      subject: INVOICE_SUBJECT, trigger: { type: 'payment' }, body: INVOICE_BODY,
      approvedSubject: INVOICE_SUBJECT, approvedBody: INVOICE_BODY },
    { ...base, name: 'One week to go', status: 'review',
      subject: 'One week to go - {{event_name}}', trigger: { type: 'daysBefore', days: 7 },
      body: "Hi {{vendor_name}},\n\n{{event_name}} is only a week away and we can't wait to have {{business_name}} with us at site {{site_number}}.\n\nA few reminders:\n- Set up and vehicle parked by 4:15 pm\n- No vehicles moving on site between 4:15 pm and 9:40 pm\n- Marquee secured, pegs 300 mm deep max\n- Take all your waste home\n\nYour site map, invoice, poster and program are all in your event guide below. Please help us spread the word!\n\nSee you soon,\nThe SoundzGood team" },
    { ...base, name: 'Day before', status: 'review',
      subject: 'See you tomorrow - {{event_name}}', trigger: { type: 'daysBefore', days: 1 },
      body: "Hi {{vendor_name}},\n\nTomorrow's the big night! Your quick checklist:\n- You're at site {{site_number}}\n- Set up and vehicle parked by 4:15 pm\n- Doors open 4:30 pm\n- No vehicles moving on site until 9:40 pm\n\nOn the night, please follow directions from our event staff.\n\nSee you tomorrow,\nThe SoundzGood team" },
    { ...base, name: 'Thank you', status: 'review',
      subject: 'Thank you for being part of {{event_name}}', trigger: { type: 'daysAfter', days: 1 },
      body: "Hi {{vendor_name}},\n\nThank you for joining us at {{event_name}} - we hope it was a great night for {{business_name}}.\n\nWe'd love your feedback. Just reply to this email and tell us what worked and what we can do better.\n\nFollow us on Instagram @soundzgood_events for our next events.\n\nThanks again,\nThe SoundzGood team" },
    // WAITLIST OFFER (Max, 20 Oct 2026): sent by the waitlist the moment a spot opens
    { ...base, system: 'waitlist', name: 'Waitlist - a spot opened', status: 'review', trigger: { type: 'waitlist' },
      subject: 'A spot just opened at {{event_name}} - claim it now',
      body: "Hi {{vendor_name}},\n\nGood news - a spot has just opened at {{event_name}} on {{event_date}}, and you're next on the waitlist.\n\nWe've reserved site {{site_number}} for {{business_name}} until {{expires_at}}. Press Accept below to book and pay - the spot is only yours once payment is received.\n\nCan't make it? Press Decline and we'll offer it to the next vendor.\n\nThanks,\nThe SoundzGood team" },
    // SPONSORSHIP (Max, 20 Oct 2026): the ask (sent when Max presses Send) and a follow-up 7 days later
    { ...base, audience: 'sponsors', system: 'sponsor-ask', name: 'Sponsorship - the ask', status: 'review', trigger: { type: 'manual' },
      subject: 'Partnering with {{event_name}} - keeping it free for local families',
      body: "Hi {{vendor_name}},\n\nI'm Max from SoundzGood - we run Eatz & Beatz, the free community night in Bowen with local food, markets and live music.\n\nWe're planning our next event and we'd love {{business_name}} to be part of it. Keeping the night free for families takes local businesses who believe in it, and in return we put your business in front of the whole community - on the posters, our socials, the event page and from the stage on the night.\n\nThere are a few ways to get involved, from a small supporter right up to presenting partner. Everything is on the page below - have a look and let me know if anything suits.\n\nThanks for considering it,\nMax\nSoundzGood Whitsundays - 0422 393 022" },
    { ...base, audience: 'sponsors', system: 'sponsor-followup', name: 'Sponsorship - follow-up', status: 'review', trigger: { type: 'sponsorFollowup', days: 7 },
      subject: 'Following up - {{event_name}}',
      body: "Hi {{vendor_name}},\n\nJust following up on my note last week about supporting {{event_name}}. No pressure at all - if it's not the right time, a quick reply is perfect and I won't chase again.\n\nIf you'd like to have a chat about it, I'm on 0422 393 022.\n\nThanks,\nMax" },
    // GOOGLE REVIEW (Max, 20 Oct 2026): 3 days after - the Tuesday after a Saturday event
    { ...base, name: 'Google review', status: 'review',
      subject: 'Could you leave us a quick review? - {{event_name}}', trigger: { type: 'daysAfter', days: 3 },
      body: "Hi {{vendor_name}},\n\nThanks again for being part of {{event_name}}. We hope it was a great night for {{business_name}}.\n\nCould you take 30 seconds to leave us a Google review? It really helps us grow community events like this one:\nhttps://g.page/r/CSUgRhfqGvdnEAI/review\n\nThank you!\nThe SoundzGood team" },
  ];
}

/*  First open of the Messages page for an event: add the starters. */
exports.adminMessagesSeed = onCall(async (request) => {
  requireAdmin(request);
  const eventId = String((request.data || {}).eventId || '').trim();
  if (!eventId) throw new HttpsError('invalid-argument', 'Missing event.');
  const have = await db.collection('messages').where('eventId', '==', eventId).get();
  if (!have.empty) {
    const sys = have.docs.find((d) => d.data().system === 'invoice');
    if (sys && !sys.data().approvedBody) {
      await sys.ref.update({ subject: INVOICE_SUBJECT, body: INVOICE_BODY, approvedSubject: INVOICE_SUBJECT, approvedBody: INVOICE_BODY });
    }
    // a starter added later (e.g. Google review) appears on events that already have messages
    const names = new Set(have.docs.map((d) => d.data().name));
    const missing = starterMessages(eventId).filter((m) => m.system !== 'invoice' && !names.has(m.name));
    for (const m of missing) {
      await db.collection('messages').add({ ...m, sentCount: 0, failed: [], createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    }
    return { ok: true, added: missing.length };
  }
  const batch = db.batch();
  starterMessages(eventId).forEach((m) => batch.set(db.collection('messages').doc(), {
    ...m, sentCount: 0, failed: [], createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  }));
  await batch.commit();
  return { ok: true, added: starterMessages(eventId).length };
});

/*  Save (new or edited). An edit to an approved / paused message goes back to
    'review' - it needs Max's OK again.                                       */
exports.adminMessageSave = onCall(async (request) => {
  requireAdmin(request);
  const d = request.data || {};
  const clean = (v, n) => String(v == null ? '' : v).slice(0, n);
  const t = d.trigger || {};
  const trigger = ['daysBefore', 'daysAfter', 'date'].includes(t.type)
    ? { type: t.type, days: Math.max(0, Math.min(365, Math.round(Number(t.days) || 0))), date: clean(t.date, 10) }
    : null;
  const fields = {
    name: clean(d.name, 120), subject: clean(d.subject, 200), body: clean(d.body, 20000),
    who: ['all', 'food', 'market'].includes(d.who) ? d.who : 'all',
    promo: d.promo === true, trigger,
    updatedAt: FieldValue.serverTimestamp(),
  };
  fields.status = messageComplete(fields) ? 'review' : 'draft';

  if (d.id) {
    const ref = db.collection('messages').doc(String(d.id));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'No such message.');
    const m = snap.data();
    if (m.system) {   // invoice email: wording only; vendors keep getting the approved copy until Max approves this
      await ref.update({ subject: fields.subject, body: fields.body, status: 'review', updatedAt: FieldValue.serverTimestamp() });
      return { ok: true, id: ref.id, status: 'review' };
    }
    if (m.status === 'sent') throw new HttpsError('failed-precondition', 'That message has already gone out.');
    await ref.update(fields);
    return { ok: true, id: ref.id, status: fields.status };
  }
  const eventId = clean(d.eventId, 100);
  if (!eventId) throw new HttpsError('invalid-argument', 'Missing event.');
  const ref = await db.collection('messages').add({
    ...fields, eventId, audience: 'vendors', sentCount: 0, failed: [], createdAt: FieldValue.serverTimestamp(),
  });
  return { ok: true, id: ref.id, status: fields.status };
});

/*  approve | pause | resume | cancel | delete */
exports.adminMessageAction = onCall(async (request) => {
  requireAdmin(request);
  const { id, action } = request.data || {};
  const ref = db.collection('messages').doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such message.');
  const m = snap.data();
  const by = (request.auth.token && request.auth.token.email) || request.auth.uid;

  if (m.system) {   // the invoice email: only pause / resume
    if (action === 'pause') { await ref.update({ status: 'paused', updatedAt: FieldValue.serverTimestamp() }); return { ok: true }; }
    if (action === 'resume') { await ref.update({ status: 'approved', updatedAt: FieldValue.serverTimestamp() }); return { ok: true }; }
    if (action === 'approve') {
      if (!String(m.subject || '').trim() || !String(m.body || '').trim()) throw new HttpsError('failed-precondition', 'Fill in the subject and the message first.');
      await ref.update({ status: 'approved', approvedSubject: m.subject, approvedBody: m.body, approvedAt: FieldValue.serverTimestamp(), approvedBy: by, updatedAt: FieldValue.serverTimestamp() });
      return { ok: true };
    }
    throw new HttpsError('failed-precondition', 'The invoice email can be edited, approved, paused or resumed.');
  }

  if (action === 'approve' || action === 'resume') {
    if (!messageComplete(m)) throw new HttpsError('failed-precondition', 'Fill in who, when, the subject and the message first.');
    const evSnap = await db.collection('events').doc(m.eventId).get();
    const day = messageSendDate(m, evSnap.exists ? evSnap.data() : {});
    if (!day) throw new HttpsError('failed-precondition', 'Pick when it should send.');
    const today = brisbaneToday();
    if (day < today || (day === today && brisbaneMinutesNow() >= 9 * 60 + 35)) {
      throw new HttpsError('failed-precondition', 'That send day (' + day + ', ' + MSG_SEND_AT + ') has already passed - pick a later day.');
    }
    await ref.update({ status: 'approved', approvedAt: FieldValue.serverTimestamp(), approvedBy: by, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true, sendDate: day };
  }
  if (action === 'pause') {
    if (m.status !== 'approved') throw new HttpsError('failed-precondition', 'Only an approved message can be paused.');
    await ref.update({ status: 'paused', updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  }
  if (action === 'cancel') {
    await ref.update({ status: 'cancelled', updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  }
  if (action === 'delete') {
    if ((m.sentCount || 0) > 0) throw new HttpsError('failed-precondition', 'That message has been sent to people - cancel it instead.');
    await ref.delete();
    return { ok: true };
  }
  throw new HttpsError('invalid-argument', 'Unknown action.');
});

/*  Test: the message as the first vendor would get it, to the admin only. */
exports.adminMessageTest = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  requireAdmin(request);
  const to = String(request.auth.token.email || '');
  if (!to) throw new HttpsError('failed-precondition', 'Your admin login has no email address.');
  const ref = db.collection('messages').doc(String((request.data || {}).id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such message.');
  const m = snap.data();
  const evSnap = await db.collection('events').doc(m.eventId).get();
  const ev = evSnap.exists ? evSnap.data() : {};
  const noList = m.system === 'waitlist' || m.audience === 'sponsors';
  const list = noList ? [] : await messageRecipients({ ...m, promo: false });
  if (!list.length && !noList) throw new HttpsError('failed-precondition', 'No paid vendors yet to fill the test with.');
  if (m.system === 'invoice') return sendVendorInvoice(list[0].id, { test: true, to, useDraft: true });
  if (m.system === 'sponsor-ask' || m.system === 'sponsor-followup') {
    const r = await sendMessageEmail({ subject: m.subject, body: m.body }, sponsorValues({ business: 'Sample Business', contactName: 'Sam' }, ev), {
      to, test: true, actions: [{ label: 'See the sponsor options', url: sponsorLink(m.eventId, ''), primary: true }], note: SPONSOR_NOTE,
    });
    return { ...r, to };
  }
  if (m.system === 'waitlist') {
    const r = await sendMessageEmail({ subject: m.subject, body: m.body }, {
      vendor_name: 'Sam', business_name: 'Sample Food Co', site_number: 'F4', event_name: ev.name || '', event_date: ev.dateLabel || '',
      event_venue: [ev.venue, ev.location].filter(Boolean).join(', '), expires_at: 'Sat 24 Oct, 1:35 pm', guide_link: '',
    }, { to, test: true, actions: [{ label: 'Accept & book my spot', url: SITE_URL + '/vendor-signup', primary: true }, { label: 'No thanks - decline', url: SITE_URL }],
      note: 'This spot is held for you until Sat 24 Oct, 1:35 pm. It is only yours once payment is received.' });
    return { ...r, to };
  }
  const r = await sendMessageTo(m, ev, list[0], { test: true, to });
  return { ...r, to };
});

/*  Resend one (from the failed list). */
exports.adminMessageResend = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  requireAdmin(request);
  const { id, bookingId } = request.data || {};
  const ref = db.collection('messages').doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such message.');
  const m = snap.data();
  const bSnap = await db.collection('bookings').doc(String(bookingId || '')).get();
  if (!bSnap.exists) throw new HttpsError('not-found', 'No such booking.');
  const evSnap = await db.collection('events').doc(m.eventId).get();
  const r = await sendMessageTo(m, evSnap.exists ? evSnap.data() : {}, bSnap, {});
  await recordSend(ref, bSnap, r);
  await refreshMessageCounts(ref);
  return r;
});

/*  Every morning at 9:35 am: send each approved message whose day is today. */
exports.sendScheduledMessages = onSchedule(
  { schedule: '35 9 * * *', timeZone: MSG_TZ, secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 540 },
  async () => {
    const today = brisbaneToday();
    const snap = await db.collection('messages').where('status', '==', 'approved').get();
    for (const doc of snap.docs) {
      const m = doc.data();
      if (m.system) continue;
      try {
        const evSnap = await db.collection('events').doc(m.eventId).get();
        const ev = evSnap.exists ? evSnap.data() : {};
        if (messageSendDate(m, ev) !== today) continue;
        const list = await messageRecipients(m);
        for (const b of list) {
          const already = await doc.ref.collection('sends').doc(b.id).get();
          if (already.exists && already.data().ok) continue;
          const r = await sendMessageTo(m, ev, b, {});
          await recordSend(doc.ref, b, r);
        }
        await refreshMessageCounts(doc.ref);
        await doc.ref.update({ status: 'sent', sentAt: FieldValue.serverTimestamp() });
        logger.info('scheduled message sent', { id: doc.id, name: m.name, count: list.length });
      } catch (err) {
        logger.error('scheduled message failed', { id: doc.id, message: err && err.message });
      }
    }
  },
);

/*  Unsubscribe from promotional emails (link at the bottom of them). */
exports.vendorUnsubscribe = onRequest(async (req, res) => {
  const token = String(req.query.t || '').trim();
  const page = (msg) => res.status(200).send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial;padding:40px;text-align:center;background:#f4f4f5"><div style="max-width:480px;margin:auto;background:#fff;padding:30px;border-radius:12px"><p style="color:#ff6b00;letter-spacing:2px;font-size:12px">SOUNDZGOOD WHITSUNDAYS</p><h2>' + msg + '</h2><p style="color:#666">You will still get emails about bookings you make.</p></div></body>');
  if (!/^[a-f0-9]{20,40}$/.test(token)) return page('That link is not valid.');
  const snap = await db.collection('bookings').where('invoiceToken', '==', token).limit(1).get();
  if (snap.empty) return page('That link is not valid.');
  // SECURITY AUDIT (20 Oct 2026): email scanners open links by themselves -
  // opening the link only shows a button; pressing it does the unsubscribe.
  if (req.method !== 'POST') return page('Unsubscribe from event news?<form method="post" style="margin-top:18px"><button style="background:#ff6b00;color:#fff;border:0;padding:12px 22px;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer">Yes, unsubscribe me</button></form>');
  await snap.docs[0].ref.update({ promoOptOut: true, promoOptOutAt: FieldValue.serverTimestamp() });
  return page('You have been unsubscribed from event news.');
});


/* =========================================================================
   LATE PAYMENT CHARGES  (Max, 20 Oct 2026)
   Terms "Overdue payments": an invoice still unpaid MORE THAN 28 DAYS after its
   due date (due = 7 days before the event) may get 2% of the outstanding
   balance, and another 2% for each further full month. NOTHING IS ADDED BY
   ITSELF - the Sales Pipeline shows "Late fee due" and Max presses Add.
   Kept separate from the hire lines: quotes/{id}.lateFees [{cents, date, by}]
   and lateFeeCents, so the original invoice is unchanged. No GST on them.
   KEEP IN STEP with lateFeeDue() in js/sales-pipeline.js.
   ========================================================================= */
function quoteGrandTotal(q) {
  return Math.round(q.totalCents || 0) + Math.round(q.lateFeeCents || 0);
}
function lateFeeState(q) {
  const owing = quoteGrandTotal(q) - Math.round(q.amountPaidCents || 0);
  if (owing <= 0 || q.status === 'cancelled' || q.status === 'declined' || q.paymentStatus === 'paid') return { allowed: 0, owing };
  if (!(q.kind === 'invoice' || ['accepted', 'invoiced'].includes(q.status))) return { allowed: 0, owing };
  const due = addDaysISO(q.hire && q.hire.startDate, -7);
  if (!due) return { allowed: 0, owing };
  const first = addDaysISO(due, 29);   // more than 28 days after the due date
  const today = brisbaneToday();
  if (today < first) return { allowed: 0, owing, first };
  const [fy, fm, fd] = first.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  const months = Math.max(0, (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0));
  return { allowed: 1 + months, owing, first };
}

exports.adminAddLateFee = onCall(async (request) => {
  requireAdmin(request);
  const ref = db.collection('quotes').doc(String((request.data || {}).id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such invoice.');
  const q = snap.data();
  const st = lateFeeState(q);
  const have = (q.lateFees || []).length;
  if (st.allowed <= have) throw new HttpsError('failed-precondition', 'No late fee is due on this invoice yet.');
  const cents = Math.round(st.owing * 0.02);
  if (cents < 1) throw new HttpsError('failed-precondition', 'Nothing outstanding.');
  const fee = { cents, date: brisbaneToday(), by: (request.auth.token && request.auth.token.email) || request.auth.uid };
  await ref.update({
    lateFees: FieldValue.arrayUnion(fee),
    lateFeeCents: Math.round(q.lateFeeCents || 0) + cents,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true, cents };
});

/*  Waive: take the last late fee off. */
exports.adminRemoveLateFee = onCall(async (request) => {
  requireAdmin(request);
  const ref = db.collection('quotes').doc(String((request.data || {}).id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such invoice.');
  const fees = (snap.data().lateFees || []).slice();
  if (!fees.length) return { ok: true };
  fees.pop();
  await ref.update({ lateFees: fees, lateFeeCents: fees.reduce((t, x) => t + (x.cents || 0), 0), updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

/*  PREVIEW A CLIENT EMAIL (Messages > Clients, Max, 20 Oct 2026). Shows the
    real layout: quote / invoice use your most recent one, the bot estimate
    and lead email use sample words. Sends nothing.                         */
exports.adminPreviewClientEmail = onCall(async (request) => {
  requireAdmin(request);
  const kind = String((request.data || {}).kind || '');
  if (kind === 'estimate') {
    const { __test } = require('./lib/quote-email');
    const lead = { name: 'Sam', eventTypeLabel: 'Wedding', locationLabel: 'Airlie Beach', sizeLabel: '80-150 guests',
      durationLabel: '5 hours', serviceLabels: ['Sound', 'Lighting'], estimateLowCents: 180000, estimateHighCents: 240000 };
    return { subject: 'Your SoundzGood estimate - Wedding', html: __test.leadHtml(lead), note: 'Sample details - each person sees their own answers and price range.' };
  }
  if (kind === 'lead') {
    const { leadHtml } = require('./lib/lead-email');
    return { subject: '(you write the subject)', html: leadHtml('Hi there,\n\nThis is where your own message goes - you write it each time in the Lead Generator.\n\nCheers,\nMax'), note: 'You write these each time - this shows the letterhead it goes out in.' };
  }
  if (kind === 'reminder') {   // payment reminder (Max, 22 Oct 2026)
    const { renderPaymentReminder } = require('./lib/quote-doc-email');
    const snap = await db.collection('quotes').orderBy('createdAt', 'desc').limit(60).get();
    const doc = snap.docs.find((d) => owesMoney(d.data()));
    const q = doc ? doc.data() : { kind: 'invoice', number: 'SG-Q-0000', invoiceNumber: 'SG-I-0000', customer: { name: 'Sam', eventName: 'Your event' }, totalCents: 100000, token: 'x' };
    const out = renderPaymentReminder(q, SITE_URL + '/quote?t=' + (q.token || ''), reminderInfo(q));
    return { ...out, note: doc ? 'As ' + ((q.customer && q.customer.name) || 'this client') + ' would get it (' + (q.invoiceNumber || q.number) + ').' : 'Sample details.' };
  }
  if (kind === 'quote' || kind === 'invoice') {
    const { renderQuoteLinkEmail } = require('./lib/quote-doc-email');
    const snap = await db.collection('quotes').orderBy('createdAt', 'desc').limit(40).get();
    const doc = snap.docs.find((d) => (kind === 'invoice' ? d.data().kind === 'invoice' : d.data().kind !== 'invoice' && d.data().status !== 'draft'));
    const q = doc ? doc.data() : { kind, number: 'SG-Q-0000', invoiceNumber: 'SG-I-0000', customer: { name: 'Sam', eventName: 'Your event' }, totalCents: 100000, token: 'x' };
    const out = renderQuoteLinkEmail(q, SITE_URL + '/quote?t=' + (q.token || ''));
    return { ...out, note: doc ? 'Your most recent ' + kind + ' (' + ((q.customer && q.customer.name) || '') + ').' : 'Sample ' + kind + '.' };
  }
  throw new HttpsError('invalid-argument', 'Unknown email.');
});

/* =========================================================================
   VENDOR WAITLIST  (Max, 20 Oct 2026)

   When a vendor type sells out, the vendor page offers "Join the waitlist".
   When a spot opens, the FIRST person waiting is emailed and that spot is
   reserved for them for 4 HOURS (the site is held with waitlistHold, so it
   still reads as sold out to everyone else). From the email they can:
     Accept  -> the vendor page, signed in, their site already held for them.
                The spot is NOT theirs until they pay - same checkout as
                everyone else.
     Decline -> the next person is offered it straight away.
   No answer in 4 hours -> the next person. A claimed spot not paid for by the
   end of the 4 hours -> the next person.
   The offer email is the "Waitlist - a spot opened" message in Messages and
   only goes once Max has approved its wording.

   waitlist/{id}: eventId, vendorType, name, contactName, email, phone,
     description, status waiting | offered | claimed | booked | declined |
     expired, siteId, siteLabel, token, offeredAt, offerExpiresAt, claimedUid
   ========================================================================= */
const WAITLIST_HOURS = 4;
const WAITLIST_URL = process.env.WAITLIST_URL || 'https://waitlistrespond-4smug72szq-ts.a.run.app';

/*  The vendor page: join. No account needed; one entry per email per type. */
exports.joinWaitlist = onCall(async (request) => {
  await limitIp(request, 'waitlist', 10, 60);   // security audit
  const d = request.data || {};
  const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const eventId = clean(d.eventId, 100);
  const vendorType = d.vendorType === 'food' ? 'food' : (d.vendorType === 'market' ? 'market' : '');
  const email = clean(d.email, 200).toLowerCase();
  const entry = {
    eventId, vendorType, email,
    name: clean(d.name, 120), contactName: clean(d.contactName, 120),
    phone: clean(d.phone, 40), description: clean(d.description, 300),
  };
  if (!eventId || !vendorType) throw new HttpsError('invalid-argument', 'Missing event or vendor type.');
  if (!entry.name || !entry.contactName) throw new HttpsError('invalid-argument', 'Please fill in your business and your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError('invalid-argument', 'Please enter a valid email address.');
  const evSnap = await db.collection('events').doc(eventId).get();
  if (!evSnap.exists) throw new HttpsError('not-found', 'That event does not exist.');

  const same = await db.collection('waitlist').where('eventId', '==', eventId).get();
  const mine = same.docs.find((x) => x.data().email === email && x.data().vendorType === vendorType
    && ['waiting', 'offered', 'claimed'].includes(x.data().status));
  const waiting = same.docs.filter((x) => x.data().vendorType === vendorType && x.data().status === 'waiting');
  if (mine) {
    return { ok: true, already: true, position: Math.max(1, waiting.findIndex((x) => x.id === mine.id) + 1) };
  }
  await db.collection('waitlist').add({ ...entry, status: 'waiting', createdAt: FieldValue.serverTimestamp() });
  return { ok: true, position: waiting.length + 1 };
});

/*  Release a waitlist hold on a site (if it is still ours). */
async function releaseWaitlistSite(eventId, siteId, entryId, claimedUid) {
  if (!eventId || !siteId) return;
  const ref = siteRef(eventId, siteId);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return;
    const x = s.data();
    if (x.status !== 'held') return;
    const ours = x.heldBy === 'waitlist:' + entryId || (claimedUid && x.heldBy === claimedUid && x.waitlistHold);
    if (!ours) return;
    tx.update(ref, { status: 'available', heldBy: FieldValue.delete(), holdExpiresAt: FieldValue.delete(), waitlistHold: FieldValue.delete(), bookingId: FieldValue.delete() });
  });
}

/*  The offer email, from the approved "Waitlist - a spot opened" message. */
async function sendWaitlistOffer(entryRef, entry, ev, msg, siteLabel, token, expires) {
  const when = expires.toLocaleString('en-AU', { timeZone: MSG_TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const values = {
    vendor_name: entry.contactName || entry.name || 'there',
    business_name: entry.name || '',
    site_number: siteLabel || '',
    event_name: ev.name || '',
    event_date: ev.dateLabel || ev.dateISO || '',
    event_venue: [ev.venue, ev.location].filter(Boolean).join(', '),
    expires_at: when,
    guide_link: '',
  };
  return sendMessageEmail(
    { subject: msg.approvedSubject || msg.subject, body: msg.approvedBody || msg.body },
    values,
    {
      to: entry.email,
      actions: [
        { label: 'Accept & book my spot', url: SITE_URL + '/vendor-signup?claim=' + token, primary: true },
        { label: 'No thanks - decline', url: WAITLIST_URL + '?t=' + token + '&a=decline' },
      ],
      note: 'This spot is held for you until ' + when + '. It is only yours once payment is received.',
    },
  );
}

/*  The work, every 2 minutes: expire old offers, mark bookings, offer spots. */
async function waitlistTick() {
  const now = Date.now();
  const snap = await db.collection('waitlist').where('status', 'in', ['waiting', 'offered', 'claimed']).get();
  if (snap.empty) return;
  const byEvent = {};
  snap.docs.forEach((d) => { (byEvent[d.data().eventId] = byEvent[d.data().eventId] || []).push(d); });

  for (const eventId of Object.keys(byEvent)) {
    try {
      const evSnap = await db.collection('events').doc(eventId).get();
      if (!evSnap.exists) continue;
      const ev = evSnap.data();
      const entries = byEvent[eventId];

      // 1. offers / claims: booked, or out of time
      for (const d of entries) {
        const w = d.data();
        if (w.status !== 'offered' && w.status !== 'claimed') continue;
        if (w.status === 'claimed' && w.claimedUid) {
          const bk = await db.collection('bookings').where('uid', '==', w.claimedUid).get();
          if (bk.docs.some((b) => b.data().eventId === eventId && b.data().status === 'confirmed')) {
            await d.ref.update({ status: 'booked', bookedAt: FieldValue.serverTimestamp() });
            continue;
          }
        }
        const exp = w.offerExpiresAt && w.offerExpiresAt.toMillis ? w.offerExpiresAt.toMillis() : 0;
        if (exp && exp <= now) {
          await d.ref.update({ status: 'expired', expiredAt: FieldValue.serverTimestamp() });
          await releaseWaitlistSite(eventId, w.siteId, d.id, w.claimedUid);
        }
      }

      // 2. offer free spots to the next people - only once Max approved the email
      const ms = await db.collection('messages').where('eventId', '==', eventId).get();
      const msgDoc = ms.docs.find((x) => x.data().system === 'waitlist');
      const msg = msgDoc && msgDoc.data();
      if (!msg || msg.status !== 'approved' || ev.status !== 'open') continue;

      const fresh = await db.collection('waitlist').where('eventId', '==', eventId).get();
      const waiting = fresh.docs.filter((x) => x.data().status === 'waiting')
        .sort((a, b) => ((a.data().createdAt && a.data().createdAt.toMillis()) || 0) - ((b.data().createdAt && b.data().createdAt.toMillis()) || 0));
      if (!waiting.length) continue;

      const sitesSnap = await db.collection('events').doc(eventId).collection('sites').get();
      for (const type of ['food', 'market']) {
        const queue = waiting.filter((x) => x.data().vendorType === type);
        if (!queue.length) continue;
        const free = sitesSnap.docs.filter((s) => {
          const x = s.data();
          if (x.type !== type) return false;
          if (x.status === 'available' || !x.status) return true;
          return x.status === 'held' && x.holdExpiresAt && x.holdExpiresAt.toMillis() <= now;
        });
        for (const site of free) {
          const next = queue.shift();
          if (!next) break;
          const token = crypto.randomBytes(16).toString('hex');
          const expires = new Date(now + WAITLIST_HOURS * 3600 * 1000);
          const got = await db.runTransaction(async (tx) => {
            const s = await tx.get(site.ref);
            const x = s.data();
            const isFree = x.status === 'available' || !x.status || (x.status === 'held' && x.holdExpiresAt && x.holdExpiresAt.toMillis() <= Date.now());
            if (!isFree) return false;
            tx.update(site.ref, { status: 'held', heldBy: 'waitlist:' + next.id, waitlistHold: true, holdExpiresAt: Timestamp.fromDate(expires), bookingId: FieldValue.delete() });
            tx.update(next.ref, { status: 'offered', siteId: site.id, siteLabel: x.label || site.id, token, offeredAt: FieldValue.serverTimestamp(), offerExpiresAt: Timestamp.fromDate(expires) });
            return true;
          });
          if (!got) { queue.unshift(next); continue; }
          const mail = await sendWaitlistOffer(next.ref, next.data(), ev, msg, site.data().label || site.id, token, expires);
          await next.ref.update({ offerEmailOk: !!mail.sent, offerEmailError: mail.sent ? '' : String(mail.error || mail.reason || '') });
          if (mail.sent && msgDoc) await msgDoc.ref.update({ sentCount: FieldValue.increment(1) });
          logger.info('waitlist offer', { eventId, entry: next.id, site: site.id, sent: !!mail.sent });
        }
      }
    } catch (err) {
      logger.error('waitlist tick failed', { eventId, message: err && err.message });
    }
  }
}

exports.waitlistTick = onSchedule(
  { schedule: 'every 2 minutes', secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 },
  async () => { await waitlistTick(); },
);

/*  Accept (from the vendor page, signed in): the held site moves to them. */
exports.claimWaitlist = onCall(async (request) => {
  const uid = requireAuth(request);
  const token = String((request.data || {}).token || '').trim();
  if (!/^[a-f0-9]{20,40}$/.test(token)) throw new HttpsError('invalid-argument', 'That link is not valid.');
  const snap = await db.collection('waitlist').where('token', '==', token).limit(1).get();
  if (snap.empty) throw new HttpsError('not-found', 'That link is not valid.');
  const ref = snap.docs[0].ref;
  return db.runTransaction(async (tx) => {
    const w = (await tx.get(ref)).data();
    const exp = w.offerExpiresAt && w.offerExpiresAt.toMillis ? w.offerExpiresAt.toMillis() : 0;
    if (w.status === 'booked') throw new HttpsError('failed-precondition', 'You have already booked this spot - thank you!');
    if (!['offered', 'claimed'].includes(w.status) || exp <= Date.now()) {
      throw new HttpsError('failed-precondition', 'Sorry - this offer has run out and has been passed to the next person.');
    }
    const sRef = siteRef(w.eventId, w.siteId);
    const s = (await tx.get(sRef)).data() || {};
    const ours = s.status === 'held' && (s.heldBy === 'waitlist:' + ref.id || s.heldBy === uid || s.heldBy === w.claimedUid);
    if (!ours) throw new HttpsError('failed-precondition', 'Sorry - this spot is no longer available.');
    tx.update(sRef, { heldBy: uid, waitlistHold: true, holdExpiresAt: w.offerExpiresAt });
    tx.update(ref, { status: 'claimed', claimedUid: uid, claimedAt: FieldValue.serverTimestamp() });
    return {
      ok: true, eventId: w.eventId, vendorType: w.vendorType, siteId: w.siteId, siteLabel: w.siteLabel,
      expiresAt: exp, name: w.name, contactName: w.contactName, email: w.email, phone: w.phone, description: w.description,
    };
  });
});

/*  Decline (link in the email) - the next person is offered it. */
exports.waitlistRespond = onRequest(async (req, res) => {
  const token = String(req.query.t || '').trim();
  const page = (title, msg) => res.status(200).send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial;padding:40px;text-align:center;background:#f4f4f5"><div style="max-width:480px;margin:auto;background:#fff;padding:30px;border-radius:12px"><p style="color:#ff6b00;letter-spacing:2px;font-size:12px">SOUNDZGOOD WHITSUNDAYS</p><h2>' + title + '</h2><p style="color:#666">' + msg + '</p></div></body>');
  if (!/^[a-f0-9]{20,40}$/.test(token)) return page('That link is not valid.', '');
  const snap = await db.collection('waitlist').where('token', '==', token).limit(1).get();
  if (snap.empty) return page('That link is not valid.', '');
  const d = snap.docs[0];
  const w = d.data();
  if (!['offered', 'claimed'].includes(w.status)) return page('All sorted.', 'This offer has already been answered.');
  // SECURITY AUDIT (20 Oct 2026): email scanners open links by themselves -
  // opening the link only asks; pressing the button gives the spot up.
  if (req.method !== 'POST') return page('Give up this spot?', 'If you can&rsquo;t make it, press the button and we&rsquo;ll offer the spot to the next vendor.<form method="post" style="margin-top:18px"><button style="background:#111;color:#fff;border:0;padding:12px 22px;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer">Yes, decline the spot</button></form>');
  await d.ref.update({ status: 'declined', declinedAt: FieldValue.serverTimestamp() });
  await releaseWaitlistSite(w.eventId, w.siteId, d.id, w.claimedUid);
  return page('No worries - thanks for letting us know.', 'We have passed the spot on to the next vendor. We hope to see you at a future event!');
});

/* =========================================================================
   SPONSORSHIP OUTREACH  (Max, 20 Oct 2026)

   Messages > Sponsors: Max adds businesses (Lead Generator, typed in, past
   sponsors), ticks who to ask and presses Send. Each gets the approved
   "Sponsorship - the ask" email with a personal link to /sponsor. Anyone
   still "Asked" 7 days later gets the approved follow-up at 9:35 am. The
   sponsor page's "I'm interested" form lands back here and emails the office.

   sponsors/{id}: eventId, business, contactName, email, phone, source,
     status todo | asked | interested | yes | no, level, amountCents, notes,
     message, token, askedAt, followedUpAt, interestedAt
   KEEP IN STEP: SPONSOR_LEVELS in js/sponsor-data.js (same keys / spots).
   ========================================================================= */
const SPONSOR_LEVELS = {
  platinum: { name: 'Platinum - Presenting Partner', priceCents: 500000, spots: 1 },
  gold: { name: 'Gold', priceCents: 200000, spots: 2 },
  silver: { name: 'Silver', priceCents: 100000, spots: 3 },
  bronze: { name: 'Bronze', priceCents: 50000, spots: 5 },
  supporter: { name: 'Supporter', priceCents: 0, spots: 0 },
};
const sponsorLink = (eventId, token) => SITE_URL + '/sponsor?e=' + encodeURIComponent(eventId) + (token ? '&t=' + token : '');
const SPONSOR_NOTE = 'Not for you? Just reply and let us know - we won\'t email you about it again.';

function sponsorValues(p, ev) {
  return {
    vendor_name: p.contactName || p.business || 'there',
    business_name: p.business || 'your business',
    site_number: '', guide_link: '',
    event_name: ev.name || 'Eatz & Beatz',
    event_date: ev.dateLabel || ev.dateISO || '',
    event_venue: [ev.venue, ev.location].filter(Boolean).join(', '),
  };
}

/*  PUBLIC: the sponsor page - event, spots left per level, and (personal link) who they are. */
exports.getSponsorInfo = onCall(async (request) => {
  const { eventId, token } = request.data || {};
  const id = String(eventId || '').trim();
  if (!id) throw new HttpsError('invalid-argument', 'Missing event.');
  const evSnap = await db.collection('events').doc(id).get();
  if (!evSnap.exists) throw new HttpsError('not-found', 'That event does not exist.');
  const ev = evSnap.data();
  const snap = await db.collection('sponsors').where('eventId', '==', id).get();
  const taken = {};
  let prospect = null;
  snap.forEach((d) => {
    const x = d.data();
    if (x.status === 'yes' && x.level) taken[x.level] = (taken[x.level] || 0) + 1;
    if (token && /^[a-f0-9]{20,40}$/.test(String(token)) && x.token === token) {
      prospect = { business: x.business || '', contactName: x.contactName || '', email: x.email || '', phone: x.phone || '' };
    }
  });
  const left = {};
  Object.keys(SPONSOR_LEVELS).forEach((k) => { left[k] = Math.max(0, SPONSOR_LEVELS[k].spots - (taken[k] || 0)); });
  return {
    event: { name: ev.name || '', dateLabel: ev.dateLabel || '', dateISO: ev.dateISO || '', venue: ev.venue || '', location: ev.location || '', image: ev.image || '' },
    left, prospect,
  };
});

/*  PUBLIC: "I'm interested" from the sponsor page. */
exports.sponsorInterest = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  await limitIp(request, 'sponsor', 10, 60);   // security audit
  const d = request.data || {};
  const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const eventId = clean(d.eventId, 100);
  const email = clean(d.email, 200).toLowerCase();
  const level = SPONSOR_LEVELS[d.level] ? d.level : 'supporter';
  const fields = {
    business: clean(d.business, 160), contactName: clean(d.contactName, 120), email,
    phone: clean(d.phone, 40), level, message: clean(d.message, 2000),
  };
  if (!eventId) throw new HttpsError('invalid-argument', 'Missing event.');
  if (!fields.business || !fields.contactName) throw new HttpsError('invalid-argument', 'Please fill in your business and your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError('invalid-argument', 'Please enter a valid email address.');
  const evSnap = await db.collection('events').doc(eventId).get();
  if (!evSnap.exists) throw new HttpsError('not-found', 'That event does not exist.');
  const ev = evSnap.data();

  const snap = await db.collection('sponsors').where('eventId', '==', eventId).get();
  const token = String(d.token || '');
  const match = snap.docs.find((x) => (token && x.data().token === token)) || snap.docs.find((x) => String(x.data().email || '').toLowerCase() === email);
  const update = { ...fields, interestedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
  if (match) {
    if (match.data().status !== 'yes') update.status = 'interested';
    await match.ref.update(update);
  } else {
    await db.collection('sponsors').add({ ...update, eventId, source: 'website', status: 'interested', createdAt: FieldValue.serverTimestamp() });
  }

  // tell the office straight away
  const lv = SPONSOR_LEVELS[level];
  await sendMessageEmail({
    subject: 'Sponsor interest: ' + fields.business + ' - ' + lv.name,
    body: 'New sponsor interest for ' + (ev.name || eventId) + ':\n\n'
      + '- Business: ' + fields.business + '\n- Contact: ' + fields.contactName + '\n- Email: ' + email
      + (fields.phone ? '\n- Phone: ' + fields.phone : '') + '\n- Level: ' + lv.name + (lv.priceCents ? ' ($' + (lv.priceCents / 100).toLocaleString('en-AU') + ' + GST)' : '')
      + (fields.message ? '\n\nTheir message:\n' + fields.message : '') + '\n\nSee it in the admin under Messages > Sponsors.',
  }, {}, { to: process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au' });
  return { ok: true };
});

/*  Send "the ask" to the ticked businesses (admin). */
exports.adminSponsorSend = onCall({ secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 }, async (request) => {
  requireAdmin(request);
  const { eventId, ids } = request.data || {};
  const evId = String(eventId || '');
  const ms = await db.collection('messages').where('eventId', '==', evId).get();
  const msgDoc = ms.docs.find((x) => x.data().system === 'sponsor-ask');
  const msg = msgDoc && msgDoc.data();
  if (!msg || msg.status !== 'approved') throw new HttpsError('failed-precondition', 'Approve the "Sponsorship - the ask" email first.');
  const evSnap = await db.collection('events').doc(evId).get();
  const ev = evSnap.exists ? evSnap.data() : {};
  const out = { sent: 0, skipped: 0, failed: [] };
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, 200)) {
    const ref = db.collection('sponsors').doc(String(id));
    const snap = await ref.get();
    if (!snap.exists) { out.skipped++; continue; }
    const p = snap.data();
    if (p.eventId !== evId || !p.email || p.status !== 'todo') { out.skipped++; continue; }
    const token = p.token || crypto.randomBytes(16).toString('hex');
    const r = await sendMessageEmail({ subject: msg.approvedSubject || msg.subject, body: msg.approvedBody || msg.body }, sponsorValues(p, ev), {
      to: p.email,
      actions: [{ label: 'See the sponsor options', url: sponsorLink(evId, token), primary: true }],
      note: SPONSOR_NOTE,
    });
    if (r.sent) {
      out.sent++;
      await ref.update({ status: 'asked', token, askedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    } else out.failed.push((p.business || id) + ': ' + (r.error || r.reason || 'not sent'));
  }
  if (out.sent && msgDoc) await msgDoc.ref.update({ sentCount: FieldValue.increment(out.sent) });
  return out;
});

/*  Every morning at 9:35 am: a polite follow-up 7 days after the ask (approved email only). */
exports.sponsorFollowups = onSchedule(
  { schedule: '35 9 * * *', timeZone: MSG_TZ, secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 },
  async () => {
    const msgs = await db.collection('messages').where('status', '==', 'approved').get();
    for (const md of msgs.docs) {
      const msg = md.data();
      if (msg.system !== 'sponsor-followup') continue;
      try {
        const evSnap = await db.collection('events').doc(msg.eventId).get();
        const ev = evSnap.exists ? evSnap.data() : {};
        const days = Math.max(1, Number((msg.trigger || {}).days) || 7);
        const cutoff = Date.now() - days * 86400000;
        const snap = await db.collection('sponsors').where('eventId', '==', msg.eventId).get();
        let sent = 0;
        for (const d of snap.docs) {
          const p = d.data();
          const asked = p.askedAt && p.askedAt.toMillis ? p.askedAt.toMillis() : 0;
          if (p.status !== 'asked' || !asked || asked > cutoff || p.followedUpAt || !p.email) continue;
          const r = await sendMessageEmail({ subject: msg.approvedSubject || msg.subject, body: msg.approvedBody || msg.body }, sponsorValues(p, ev), {
            to: p.email,
            actions: [{ label: 'See the sponsor options', url: sponsorLink(msg.eventId, p.token), primary: true }],
            note: SPONSOR_NOTE,
          });
          if (r.sent) { sent++; await d.ref.update({ followedUpAt: FieldValue.serverTimestamp() }); }
        }
        if (sent) await md.ref.update({ sentCount: FieldValue.increment(sent) });
      } catch (err) {
        logger.error('sponsor follow-ups failed', { id: md.id, message: err && err.message });
      }
    }
  },
);

/* =========================================================================
   CUSTOMER FILLS IN THEIR OWN DETAILS  (Max, 20 Oct 2026)
   From a quote, Max texts the customer a link (/details?t=<detailsToken>).
   They fill in name, business, email, billing CC, phone, address, event,
   date and venue. It lands straight on the quote and in Customers, and the
   office gets an email. Sends nothing to the customer.
   ========================================================================= */
const DETAIL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emailList = (v) => String(v || '').split(/[,;\s]+/).map((e) => e.trim()).filter((e) => DETAIL_EMAIL_RE.test(e)).slice(0, 10).join(', ');

exports.adminDetailsLink = onCall(async (request) => {
  requireAdmin(request);
  const ref = db.collection('quotes').doc(String((request.data || {}).id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Save the quote first.');
  let token = snap.data().detailsToken;
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    await ref.update({ detailsToken: token, detailsRequestedAt: FieldValue.serverTimestamp() });
  }
  return { url: SITE_URL + '/details?t=' + token };
});

async function quoteByDetailsToken(token) {
  const t = String(token || '').trim();
  if (!/^[a-f0-9]{20,40}$/.test(t)) throw new HttpsError('invalid-argument', 'That link is not valid.');
  const snap = await db.collection('quotes').where('detailsToken', '==', t).limit(1).get();
  if (snap.empty) throw new HttpsError('not-found', 'That link is not valid.');
  return snap.docs[0];
}

/*  PUBLIC: the form, pre-filled with what we already have. */
exports.getDetailsForm = onCall(async (request) => {
  const doc = await quoteByDetailsToken((request.data || {}).token);
  const q = doc.data();
  const c = q.customer || {};
  const ready = ['approved', 'sent', 'accepted', 'invoiced', 'paid'].includes(q.status) && q.token;
  return {
    customer: {
      name: c.name || '', business: c.business || '', email: c.email || '', ccEmail: c.ccEmail || '',
      phone: c.phone || '', address: c.address || '', eventName: c.eventName || '', eventDate: c.eventDate || '',
      eventVenue: c.eventVenue || '', eventStartTime: c.eventStartTime || '', customerNotes: c.customerNotes || '',
      dayContact: c.dayContact || '',
    },
    startDate: (q.hire && q.hire.startDate) || '',
    received: !!q.detailsReceivedAt,
    autoSend: !!(q.autoSendOnDetails && ready && !q.autoSentOnDetailsAt),   // quote goes out the moment they submit
    quoteLink: ready ? SITE_URL + '/quote?t=' + q.token : '',
  };
});

/*  PUBLIC: they press Submit. */
exports.submitDetails = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  await limitIp(request, 'details', 20, 60);   // security audit
  const d = request.data || {};
  const doc = await quoteByDetailsToken(d.token);
  const q = doc.data();
  const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const f = {
    name: clean(d.name, 120), business: clean(d.business, 120), email: clean(d.email, 200).toLowerCase(),
    ccEmail: emailList(d.ccEmail), phone: clean(d.phone, 40), address: clean(d.address, 300),
    eventName: clean(d.eventName, 160), eventDate: clean(d.eventDate, 60), eventVenue: clean(d.eventVenue, 200),
    eventStartTime: clean(d.eventStartTime, 20), customerNotes: clean(d.customerNotes, 2000),
    dayContact: clean(d.dayContact, 200),
  };
  if (!f.name) throw new HttpsError('invalid-argument', 'Please enter your name.');
  if (!DETAIL_EMAIL_RE.test(f.email)) throw new HttpsError('invalid-argument', 'Please enter a valid email address.');
  if (!f.phone) throw new HttpsError('invalid-argument', 'Please enter a phone number.');
  if (!f.eventName) throw new HttpsError('invalid-argument', 'Please enter the event name.');
  if (!f.eventStartTime) throw new HttpsError('invalid-argument', 'Please enter the event start time.');
  if (!f.eventVenue) throw new HttpsError('invalid-argument', 'Please enter the venue.');

  const customer = { ...(q.customer || {}) };
  Object.keys(f).forEach((k) => { if (f[k]) customer[k] = f[k]; });
  await doc.ref.update({ customer, detailsReceivedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });

  // the customer list: update the one with this email, or add them
  try {
    const cs = await db.collection('customers').where('email', '==', f.email).limit(1).get();
    const rec = { name: f.name, business: f.business, email: f.email, ccEmail: f.ccEmail, phone: f.phone, address: f.address, updatedAt: Date.now() };
    Object.keys(rec).forEach((k) => { if (rec[k] === '') delete rec[k]; });
    if (cs.empty) await db.collection('customers').add({ type: f.business ? 'business' : 'private', notes: '', ...rec, createdAt: Date.now() });
    else await cs.docs[0].ref.set(rec, { merge: true });
  } catch (err) { logger.warn('details: customer list', err && err.message); }

  await sendMessageEmail({
    subject: (f.name || 'A customer') + ' filled in their details - ' + (q.number || ''),
    body: (f.name || 'A customer') + ' filled in their details for quote ' + (q.number || '') + ':\n\n'
      + ['Name: ' + f.name, f.business && 'Business: ' + f.business, 'Email: ' + f.email, f.ccEmail && 'Billing CC: ' + f.ccEmail,
        'Phone: ' + f.phone, f.address && 'Address: ' + f.address, f.eventName && 'Event: ' + f.eventName,
        f.eventDate && 'Date: ' + f.eventDate, f.eventVenue && 'Venue: ' + f.eventVenue,
        f.eventStartTime && 'Event starts: ' + f.eventStartTime, f.dayContact && 'Event day contact: ' + f.dayContact, f.customerNotes && 'Notes: ' + f.customerNotes].filter(Boolean).map((x) => '- ' + x).join('\n')
      + '\n\nThey are already on the quote - open it in the Sales Pipeline.',
  }, {}, { to: process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au' });

  /*  PRE-APPROVED (Max, 20 Oct 2026): "Send them the quote automatically when
      they fill it in" was ticked - the quote goes to the email they just gave. */
  let autoSent = false;
  if (q.autoSendOnDetails && q.token && ['approved', 'sent'].includes(q.status) && !q.autoSentOnDetailsAt) {
    const link = SITE_URL + '/quote?t=' + q.token;
    const mail = await sendQuoteLinkEmail({ ...q, customer }, link);
    if (mail.sent) {
      autoSent = true;
      await doc.ref.update({
        ...(q.status === 'approved' ? { status: 'sent', sentAt: FieldValue.serverTimestamp() } : {}),
        autoSentOnDetailsAt: FieldValue.serverTimestamp(),
        lastEmailedAt: FieldValue.serverTimestamp(),
        lastEmailedTo: customer.email + (customer.ccEmail ? ' (cc ' + customer.ccEmail + ')' : ''),
        emailCount: FieldValue.increment(1),
      });
    }
  }

  const ready = ['approved', 'sent', 'accepted', 'invoiced', 'paid'].includes(q.status) && q.token;
  return { ok: true, autoSent, quoteLink: ready ? SITE_URL + '/quote?t=' + q.token : '' };
});

/* =========================================================================
   EMAIL THE GEAR LIST (no prices) to the band / crew  (Max, 20 Oct 2026)
   Goes to the quote's "Gear list to" emails (customer.gearEmails) - never
   the billing CC. Links to the pick list in read-only gear view.
   ========================================================================= */
exports.adminSendGearList = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  requireAdmin(request);
  const ref = db.collection('quotes').doc(String((request.data || {}).id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such quote.');
  const q = snap.data();
  if (!pickReady(q)) throw new HttpsError('failed-precondition', 'The gear list unlocks once the deposit is in.');
  // TEST (Max, 20 Oct 2026): the gear list + the pick list email, both to the signed-in admin only
  if ((request.data || {}).test === true) {
    const me = String(request.auth.token.email || '');
    if (!me) throw new HttpsError('failed-precondition', 'Your admin login has no email address.');
    const r = await sendGearListEmail(ref, q, 'deposit', me);
    return { ...r, to: me, test: true };
  }
  const to = emailList((q.customer || {}).gearEmails);
  if (!to) throw new HttpsError('failed-precondition', 'Add the band / crew emails in "Gear list to" on the quote first.');
  const r = await sendGearListEmail(ref, q, 'manual');
  return { ...r, to };
});

/* =========================================================================
   GEAR LIST - AUTOMATIC  (Max, 20 Oct 2026)
   "make it automatic when deposit is paid ... and 3 days before the event
   and again on the day". The band / crew in "Gear list to" get the gear
   list (no prices); the office gets the pick list link (with ticks) for
   staff. Nothing goes before the deposit is in. If the event date moves,
   the reminders follow the new date.
   ========================================================================= */

/*  "Tue 20 Oct 2026" or "2026-10-20" -> "2026-10-20"; falls back to the hire start. */
function quoteEventISO(q) {
  const raw = String(((q.customer || {}).eventDate) || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(raw);
  if (m && MON.indexOf(m[2].toLowerCase()) >= 0) {
    return m[3] + '-' + String(MON.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
  }
  return (q.hire && q.hire.startDate) || '';
}
const brisbaneTodayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: MSG_TZ }).format(new Date());

/*  Sends the gear list to "Gear list to" and (for automatic sends) the pick
    list link to the office. reason: 'manual' | 'deposit' | '3days' | 'today'. */
async function sendGearListEmail(ref, q, reason, testTo) {
  let token = q.crewToken;
  if (!token) { token = crypto.randomBytes(16).toString('hex'); await ref.update({ crewToken: token }); }
  const c = q.customer || {};
  const ev = c.eventName || 'your event';
  const when = c.eventDate || (q.hire && q.hire.startDate) || '';
  const lead = (testTo ? '[TEST] ' : '') + (reason === '3days' ? '3 days to go - ' : reason === 'today' ? 'Today - ' : '');
  const to = testTo || emailList(c.gearEmails);
  let r = { sent: false, reason: 'no gear list emails' };
  if (to) {
    r = await sendMessageEmail({
      subject: lead + 'Gear list - ' + ev + (when ? ' (' + when + ')' : ''),
      body: 'Hi,\n\n'
        + (reason === 'today' ? 'See you today! ' : reason === '3days' ? 'Your event is 3 days away. ' : '')
        + 'Here is the gear SoundzGood Whitsundays is supplying for ' + ev + (when ? ' on ' + when : '') + '. Have a look and let us know if anything is missing or needs changing.\n\nThanks,\nMax\nSoundzGood Whitsundays - 0422 393 022',
    }, {}, {
      to,
      actions: [{ label: 'View the gear list', url: SITE_URL + '/picklist?t=' + token + '&v=gear', primary: true }],
    });
    if (r.sent && !testTo) await ref.update({ gearListSentAt: FieldValue.serverTimestamp(), gearListSentTo: to });
  }
  // staff copy - the full pick list with Packed / Returned ticks (office + the crew on the job)
  if (reason !== 'manual') {
    const crewTo = emailList((q.crewAssigned || []).map((x) => x.email).filter(Boolean).join(', '));
    await sendMessageEmail({
      subject: lead + 'Pick list - ' + ev + (when ? ' (' + when + ')' : '') + ' - ' + (q.invoiceNumber || q.number || ''),
      body: (reason === 'deposit' ? 'The deposit is in, so this job is booked. ' : '')
        + 'Here is the pick list for ' + ev + (when ? ' on ' + when : '') + '.'
        + (to ? '\n\nThe gear list (no prices) also went to: ' + to : '\n\nNo "Gear list to" emails on this job, so the band / crew were not sent anything.'),
    }, {}, {
      to: testTo || [process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au'].concat(crewTo ? [crewTo] : []).join(', '),
      actions: [{ label: 'Open the pick list', url: SITE_URL + '/picklist?t=' + token, primary: true }],
    });
  }
  return { ...r, to };
}

/*  Once per job, the moment the deposit (or full payment) lands. */
async function autoGearOnDeposit(id) {
  try {
    const ref = db.collection('quotes').doc(String(id || ''));
    const snap = await ref.get();
    if (!snap.exists) return;
    const q = snap.data();
    if (!pickReady(q) || q.gearAutoDepositAt) return;
    await ref.update({ gearAutoDepositAt: FieldValue.serverTimestamp() });   // claim it first - a webhook retry can't double-send
    await sendGearListEmail(ref, { ...q }, 'deposit');
  } catch (err) { logger.error('gear list on deposit', { id, err: err && err.message }); }
}

/*  Every morning at 9:35: jobs 3 days out, and jobs on today. */
exports.gearListReminders = onSchedule(
  { schedule: '35 9 * * *', timeZone: MSG_TZ, secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 },
  async () => {
    const today = brisbaneTodayISO();
    const snap = await db.collection('quotes').where('status', 'in', ['invoiced', 'paid']).get();
    for (const doc of snap.docs) {
      const q = doc.data();
      if (!pickReady(q) || q.archived) continue;
      const ev = quoteEventISO(q);
      if (!ev) continue;
      const reason = addDaysISO(ev, -3) === today ? '3days' : ev === today ? 'today' : '';
      if (!reason) continue;
      const key = reason + '_' + ev;   // a new date = new reminders
      if (q.gearReminders && q.gearReminders[key]) continue;
      try {
        await doc.ref.update({ ['gearReminders.' + key]: FieldValue.serverTimestamp() });
        await sendGearListEmail(doc.ref, q, reason);
      } catch (err) { logger.error('gear list reminder', { id: doc.id, err: err && err.message }); }
    }
  }
);

/* =========================================================================
   ASSIGN CREW TO A JOB  (Max, 21 Oct 2026)
   From the dashboard: tick the staff (Crew & Vehicles) working a job. The
   names go on the quote (crewAssigned) and anyone NEWLY added with an email
   gets the job details + their pick list link. Staff are our own people -
   Max asked for this, and the admin confirms before it sends.
   ========================================================================= */
exports.adminAssignCrew = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  requireAdmin(request);
  const d = request.data || {};
  const ref = db.collection('quotes').doc(String(d.id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such job.');
  const q = snap.data();
  const ids = (Array.isArray(d.staffIds) ? d.staffIds : []).map(String).slice(0, 20);
  const staff = [];
  for (const sid of ids) {
    const r = await db.collection('resources').doc(sid).get();
    if (r.exists && (r.data().type || 'staff') === 'staff') {
      const x = r.data();
      staff.push({ id: sid, name: String(x.name || ''), email: String(x.email || '').trim(), phone: String(x.phone || '') });
    }
  }
  let token = q.crewToken;
  const update = { crewAssigned: staff, crewAssignedAt: FieldValue.serverTimestamp() };
  if (!token) { token = crypto.randomBytes(16).toString('hex'); update.crewToken = token; }
  await ref.update(update);

  // email the people who are new on this job
  const before = new Set((q.crewAssigned || []).map((x) => x.id));
  const fresh = staff.filter((x) => !before.has(x.id));
  const c = q.customer || {};
  const ev = c.eventName || c.business || c.name || 'a job';
  const when = c.eventDate || (q.hire && q.hire.startDate) || '';
  const link = SITE_URL + '/picklist?t=' + token + (pickReady(q) ? '' : '&v=gear');
  const sent = [], noEmail = [], failed = [];
  for (const x of fresh) {
    if (!DETAIL_EMAIL_RE.test(x.email)) { noEmail.push(x.name); continue; }
    const r = await sendMessageEmail({
      subject: "You're on: " + ev + (when ? ' (' + when + ')' : ''),
      body: 'Hi ' + (x.name.split(' ')[0] || 'there') + ',\n\nYou are on this job:\n\n'
        + ['Job: ' + ev, when && 'Date: ' + when, c.eventStartTime && 'Starts: ' + c.eventStartTime,
          c.eventVenue && 'Venue: ' + c.eventVenue, c.dayContact && 'On the day: ' + c.dayContact,
          'Crew: ' + staff.map((s) => s.name).join(', ')].filter(Boolean).map((t) => '- ' + t).join('\n')
        + (pickReady(q) ? '\n\nThe pick list is below - tick things off as you pack and when they come back.' : '\n\nHere is the gear list. The full pick list unlocks once the deposit is in.')
        + '\n\nThanks,\nMax\nSoundzGood Whitsundays - 0422 393 022',
    }, {}, { to: x.email, actions: [{ label: pickReady(q) ? 'Open the pick list' : 'View the gear list', url: link, primary: true }] });
    (r.sent ? sent : failed).push(x.name);
  }
  return { ok: true, assigned: staff.map((x) => x.name), sent, noEmail, failed };
});

/* =========================================================================
   PUB NIGHT INVOICES  (Max, 21 Oct 2026)

   Regular nights (regularNights/, e.g. Grand View Hotel every Friday) get an
   invoice per night that makes itself:
     - book a DJ at that pub (Entertainment) -> adminPubSync({ date, venue })
     - it COPIES THE PUB'S LAST INVOICE (same gear, production, billing, so
       the pick list lines up) and swaps in a line per DJ: hours x their
       rate + their travel (actRates/{slug}, private - talent/ is public)
     - after the gig the DJ gets a link (/dj-times?t=) to put in real times;
       the invoice updates
     - it WAITS FOR MAX'S OK (status 'approved' = ready); adminSendPubInvoice
       turns it into a tax invoice and emails it.
   The first invoice for a new pub is made by hand; after that it copies.
   No margin for now: the pub pays the DJ's rate + travel + production.
   ========================================================================= */
const PUB_WORDS = /\b(hotel|tavern|pub|bar|club|the|inn|bowen|qld|queensland)\b/g;
function pubCore(v) {
  return String(v || '').toLowerCase().split(',')[0].replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .replace(PUB_WORDS, ' ').replace(/\s+/g, ' ').trim();
}
const samePub = (a, b) => { const x = pubCore(a), y = pubCore(b); return !!x && !!y && (x.includes(y) || y.includes(x)); };

/*  "21:30" + "01:30" -> 4 (hours, to the quarter). Finishing after midnight is fine. */
function pubHours(start, finish) {
  const m = (t) => { const r = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return r ? +r[1] * 60 + +r[2] : null; };
  const a = m(start), b = m(finish);
  if (a == null || b == null) return 0;
  let mins = b - a;
  if (mins <= 0) mins += 24 * 60;
  return Math.round(mins / 15) / 4;
}
const ampm = (t) => { const r = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); if (!r) return ''; const h = +r[1]; return (h % 12 || 12) + (r[2] === '00' ? '' : ':' + r[2]) + (h < 12 ? 'am' : 'pm'); };
const prettyDay = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace(/,/g, ''); };

/*  DJ TRAVEL (Max, 21 Oct 2026): a FIXED fee per pair of towns, set by Max
    in Entertainment (travelFees/: e.g. Airlie Beach <-> Bowen $80, Mackay or
    Townsville <-> Bowen $150). The DJ's town is actRates.location; the gig's
    town is the last part of the venue ("Grand View Hotel, Bowen" -> Bowen).
    Same town = no travel. No fee set for that pair = no travel + a warning. */
const townKey = (t) => String(t || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\b(beach|city|qld|queensland)\b/g, ' ').replace(/\s+/g, ' ').trim();
const sameTown = (x, y) => { const p = townKey(x), q = townKey(y); return !!p && !!q && (p === q || p.includes(q) || q.includes(p)); };
async function djTravel(fromTown, venue) {
  const parts = String(venue || '').split(',').map((x) => x.trim()).filter(Boolean);
  const toTown = parts.length > 1 ? parts[parts.length - 1] : 'Bowen';
  if (!String(fromTown || '').trim()) return { cents: 0 };
  if (sameTown(fromTown, toTown)) return { cents: 0 };
  const snap = await db.collection('travelFees').get();
  let hit = null;
  snap.forEach((d) => {
    const f = d.data();
    if ((sameTown(f.from, fromTown) && sameTown(f.to, toTown)) || (sameTown(f.from, toTown) && sameTown(f.to, fromTown))) hit = hit || f;
  });
  if (!hit) return { cents: 0, missing: fromTown + ' to ' + toTown };
  return { cents: Math.max(0, Math.round(hit.cents || 0)), from: fromTown, to: toTown };
}

async function regularNightFor(venue) {
  const snap = await db.collection('regularNights').get();
  let hit = null;
  snap.forEach((d) => { if (!hit && samePub(d.data().venue, venue)) hit = { id: d.id, ...d.data() }; });
  return hit;
}

/*  Build / update / cancel the invoice for one pub on one night. Returns a
    short result the admin page can tell Max about.                      */
async function pubSync(date, venue) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { skipped: 'no date' };
  const night = await regularNightFor(venue);
  if (!night) return { skipped: 'not a regular night' };
  const key = pubCore(night.venue) + '|' + date;

  const bSnap = await db.collection('talentSchedule').where('date', '==', date).get();
  const bookings = [];
  bSnap.forEach((d) => { const b = d.data(); if (samePub(b.venue, night.venue) && b.status !== 'cancelled') bookings.push({ id: d.id, ...b }); });

  const existingSnap = await db.collection('quotes').where('pubKey', '==', key).limit(1).get();
  const existing = existingSnap.empty ? null : existingSnap.docs[0];
  const ex = existing ? existing.data() : null;

  // once it has gone to the pub it's theirs - don't change it under them
  if (ex && !['approved', 'cancelled'].includes(ex.status)) return { locked: true, id: existing.id };

  if (!bookings.length) {
    if (existing && ex.status === 'approved') await existing.ref.update({ status: 'cancelled', cancelledAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return { cancelled: !!existing };
  }

  // what to copy: this night's own invoice, else the pub's most recent one
  let base = ex;
  if (!base) {
    const all = await db.collection('quotes').get();
    const cands = [];
    all.forEach((d) => {
      const q = d.data();
      if (q.vendor || ['cancelled', 'declined', 'draft'].includes(q.status)) return;
      const c = q.customer || {};
      const isPub = (q.pubVenue && samePub(q.pubVenue, night.venue))
        || [c.business, c.name, c.eventVenue, c.eventName].some((t) => samePub(t, night.venue));
      if (isPub) cands.push(q);
    });
    cands.sort((a, b) => String((b.hire && b.hire.startDate) || '').localeCompare(String((a.hire && a.hire.startDate) || '')));
    base = cands.find((q) => String((q.hire && q.hire.startDate) || '') < date) || cands[0] || null;
  }
  if (!base) return { needFirst: true, venue: night.venue };

  // the DJs
  const djLines = [];
  const noRate = [];
  for (const b of bookings) {
    const t = await db.collection('talent').doc(b.slug).get();
    const name = (t.exists && t.data().name) || b.slug;
    const r = await db.collection('actRates').doc(b.slug).get();
    const rate = r.exists ? r.data() : {};
    const start = b.actualStart || b.start || night.start || '';
    const finish = b.actualFinish || b.finish || night.finish || '';
    const hours = pubHours(start, finish);
    const perHour = Math.max(0, Math.round(rate.hourlyRateCents || 0));
    if (!perHour) noRate.push(name);
    djLines.push({
      type: 'custom', name: 'DJ performance - ' + name,
      description: (hours ? hours + ' hrs' : 'Hours to confirm') + (perHour ? ' @ $' + (perHour / 100).toFixed(2).replace(/\.00$/, '') + '/hr' : '')
        + (start && finish ? ' · ' + ampm(start) + '-' + ampm(finish) : '') + (b.timesConfirmedAt ? ' (confirmed)' : ''),
      qty: 1, unitCents: Math.round(hours * perHour), days: 1, pubDj: true, noPick: true,
    });
    const tr = await djTravel(rate.location, b.venue || night.venue);
    if (tr.cents) djLines.push({ type: 'custom', name: 'Travel Charge - ' + tr.from + ' to ' + tr.to + ' Return', description: '', qty: 1, unitCents: tr.cents, days: 1, pubDj: true, noPick: true });
    if (tr.missing) noRate.push(name + ' (no travel fee set for ' + tr.missing + ')');
  }

  // gear / production lines copied; the booking fee worked out again on the new total
  const kept = (base.lines || []).filter((l) => !l.pubDj && l.type !== 'fee');
  let lines = kept.concat(djLines);
  const hadFee = (base.lines || []).some((l) => l.type === 'fee') && base.feeExcluded !== true;
  if (hadFee) {
    const pre = quoteMoney({ hire: { days: 1 }, lines, discountCents: base.discountCents || 0 });
    const fee = Math.round(pre.netCents * 2 / 100 / 1000) * 1000;
    if (fee > 0) lines.push({ type: 'fee', name: 'Booking & admin', qty: 1, unitCents: fee, days: 1 });
  }
  const clean = sanitizeQuote({
    ...base,
    kind: 'quote',
    customer: { ...(base.customer || {}), eventDate: prettyDay(date), eventStartTime: (bookings[0].actualStart || bookings[0].start || night.start || '') },
    hire: { startDate: date, endDate: date, days: 1 },
    labourPackDate: '',
    lines,
  });
  const money = quoteMoney(clean);
  const meta = { pubNight: true, pubKey: key, pubVenue: night.venue, pubDate: date, pubBookings: bookings.map((b) => b.id), pubNoRate: noRate };

  if (existing) {
    await existing.ref.update({ ...clean, ...money, ...meta, status: 'approved', updatedAt: FieldValue.serverTimestamp() });
    return { updated: true, id: existing.id, totalCents: money.totalCents, noRate };
  }
  const counterRef = db.collection('config').doc('counters');
  const seq = await db.runTransaction(async (tx) => {
    const c = await tx.get(counterRef);
    const n = ((c.exists && c.data().quoteSeq) || 0) + 1;
    tx.set(counterRef, { quoteSeq: n }, { merge: true });
    return n;
  });
  const ref = await db.collection('quotes').add({
    number: 'SG-Q-' + String(seq).padStart(4, '0'), token: crypto.randomBytes(16).toString('hex'),
    status: 'approved', approvedAt: FieldValue.serverTimestamp(), ...clean, ...money, ...meta,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: 'pub-auto',
  });
  return { created: true, id: ref.id, totalCents: money.totalCents, noRate };
}

exports.adminPubSync = onCall(async (request) => {
  requireAdmin(request);
  const d = request.data || {};
  return pubSync(String(d.date || ''), String(d.venue || ''));
});

/*  ADMIN - the link the DJ uses to put in their real times */
exports.adminPubTimesLink = onCall(async (request) => {
  requireAdmin(request);
  const ref = db.collection('talentSchedule').doc(String((request.data || {}).bookingId || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such booking.');
  let token = snap.data().timesToken;
  if (!token) { token = crypto.randomBytes(16).toString('hex'); await ref.update({ timesToken: token }); }
  const r = await db.collection('actRates').doc(snap.data().slug).get();
  return { url: SITE_URL + '/dj-times?t=' + token, phone: (r.exists && r.data().phone) || '' };
});

async function bookingByTimesToken(token) {
  const t = String(token || '').trim();
  if (!/^[a-f0-9]{20,40}$/.test(t)) throw new HttpsError('invalid-argument', 'That link is not valid.');
  const snap = await db.collection('talentSchedule').where('timesToken', '==', t).limit(1).get();
  if (snap.empty) throw new HttpsError('not-found', 'That link is not valid.');
  return snap.docs[0];
}

/*  PUBLIC - the DJ's page */
exports.getPubTimes = onCall(async (request) => {
  const doc = await bookingByTimesToken((request.data || {}).token);
  const b = doc.data();
  const t = await db.collection('talent').doc(b.slug).get();
  return {
    act: (t.exists && t.data().name) || b.slug, date: b.date, venue: b.venue || '',
    start: b.actualStart || b.start || '', finish: b.actualFinish || b.finish || '',
    confirmed: !!b.timesConfirmedAt,
    // before the gig the link asks "are you in?"; from 5pm on the night it asks for times (Max, 21 Oct 2026)
    mode: brisbaneTodayISO() < b.date || (brisbaneTodayISO() === b.date && brisbaneMinutesNow() < 17 * 60) ? 'confirm' : 'times',
    djConfirmed: !!b.djConfirmedAt,
    plannedStart: b.start || '', plannedFinish: b.finish || '',
  };
});

/*  PUBLIC - the DJ confirms their times (Max, 21 Oct 2026):
      - only 5pm to 2:30am can be picked; same start and finish is refused
      - more than 8 hours is refused ("check with Max")
      - 4 hours or less: the invoice goes to the customer straight away
      - more than 4 hours: it waits for Max to check and send            */
exports.submitPubTimes = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  await limitIp(request, 'djtimes', 20, 60);
  const d = request.data || {};
  if (tradingMins(d.start) == null || tradingMins(d.finish) == null) throw new HttpsError('invalid-argument', 'Please pick times between 5pm and 2:30am.');
  const hours = gigHours(d.start, d.finish);
  if (!hours) throw new HttpsError('invalid-argument', 'The finish time has to be after the start time.');
  if (hours > 8) throw new HttpsError('invalid-argument', 'That\'s more than 8 hours - please check with Max on 0422 393 022.');
  const doc = await bookingByTimesToken(d.token);
  const b = doc.data();
  await doc.ref.update({ actualStart: String(d.start), actualFinish: String(d.finish), timesConfirmedAt: FieldValue.serverTimestamp() });
  const res = await gigSync(doc.id);
  let sent = false, why = '';
  if (res.locked) why = 'The invoice had already been sent, so it was NOT changed - check it in the Sales Pipeline.';
  else if (!res.id) why = 'No invoice was made (' + (res.skipped || 'no template') + ') - nothing was sent.';
  else if (hours > 4) why = 'That\'s over 4 hours, so the invoice is WAITING for you to check and send it from the dashboard.';
  else {
    try { const m = await sendGigInvoice(res.id); sent = !!m.sent; why = sent ? 'The invoice (' + (m.invoiceNumber || '') + ') was sent to the customer automatically.' : 'The invoice did not send: ' + (m.error || m.reason || '') + ' - send it from the dashboard.'; }
    catch (e) { why = 'The invoice did not send: ' + e.message + ' - send it from the dashboard.'; }
  }
  const t = await db.collection('talent').doc(b.slug).get();
  const act = (t.exists && t.data().name) || b.slug;
  await sendMessageEmail({
    subject: act + ' confirmed ' + hours + ' hrs - ' + String(b.venue || 'gig').split(',')[0] + ' ' + prettyDay(b.date),
    body: act + ' played ' + ampm(d.start) + ' to ' + ampm(d.finish) + ' (' + hours + ' hrs) at ' + (b.venue || 'the gig') + ' on ' + prettyDay(b.date) + '.\n\n' + why,
  }, {}, { to: process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au' });
  return { ok: true, hours, sent, waiting: !sent && hours > 4 };
});

/*  Make it a tax invoice and email it to the customer. Used by Max's Send
    button and by the DJ confirming 4 hours or less (Max, 21 Oct 2026). */
async function sendGigInvoice(id) {
  const ref = db.collection('quotes').doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such invoice.');
  const q = snap.data();
  if (q.isTemplate) throw new HttpsError('failed-precondition', 'This is a template - it can\'t be sent.');
  if (!(q.customer && q.customer.email)) throw new HttpsError('failed-precondition', 'The customer has no email on this invoice - add it first.');
  if (!['approved', 'sent', 'invoiced'].includes(q.status)) throw new HttpsError('failed-precondition', 'This one can\'t be sent.');
  const update = { kind: 'invoice', status: 'invoiced', updatedAt: FieldValue.serverTimestamp() };
  if (!q.invoiceNumber) { update.invoiceNumber = invoiceNo((await nextInvoiceNumber()).n); update.invoicedAt = FieldValue.serverTimestamp(); }
  await ref.update(update);
  const mail = await sendQuoteLinkEmail({ ...q, ...update, invoiceNumber: update.invoiceNumber || q.invoiceNumber }, SITE_URL + '/quote?t=' + q.token);
  if (mail.sent) {
    await ref.update({
      sentAt: FieldValue.serverTimestamp(), lastEmailedAt: FieldValue.serverTimestamp(),
      lastEmailedTo: String(q.customer.email || '') + (q.customer.ccEmail ? ' (cc ' + q.customer.ccEmail + ')' : ''),
      emailCount: FieldValue.increment(1),
    });
  }
  return { ...mail, invoiceNumber: update.invoiceNumber || q.invoiceNumber };
}
exports.adminSendPubInvoice = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  requireAdmin(request);
  return sendGigInvoice((request.data || {}).id);
});

/* =========================================================================
   DJ GIG INVOICES - TEMPLATES  (Max, 21 Oct 2026 - replaces "copy the pub's
   last invoice" and regular nights)

   Sales Pipeline > Templates holds a generic DJ gig invoice (isTemplate).
   A CONFIRMED booking in Entertainment with a customer (Customers) and a
   template gets its own quote: the template's lines + "DJ performance:
   hours x the DJ's rate" + the fixed travel fee. One quote per booking
   (gigBookingId). The DJ then confirms the real times (5pm-2:30am only):
   4 hours or less sends the invoice straight away; more waits for Max.
   ========================================================================= */
const TRADE_FROM = 17 * 60;      // 5pm
const TRADE_TO = 2 * 60 + 30;    // 2:30am (next day)
function tradingMins(t) {
  const r = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  if (!r) return null;
  const m = +r[1] * 60 + +r[2];
  if (m >= TRADE_FROM) return m;
  if (m <= TRADE_TO) return m + 1440;
  return null;   // outside trading hours
}
/*  Hours played, across midnight ("22:00"-"03:00" = 5). Any venue - the
    5pm-2:30am trading window only checks what DJs type in (Max, 22 Oct 2026). */
function gigHours(start, finish) {
  const p = (t) => { const r = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return r ? +r[1] * 60 + +r[2] : null; };
  const a = p(start); let b = p(finish);
  if (a == null || b == null) return 0;
  if (b <= a) b += 1440;
  if (b - a > 720) return 0;   // over 12 hours - a typo
  return Math.round((b - a) / 15) / 4;
}

async function gigSync(bookingId, opts = {}) {
  const id = String(bookingId || '');
  const exSnap = await db.collection('quotes').where('gigBookingId', '==', id).limit(1).get();
  const existing = exSnap.empty ? null : exSnap.docs[0];
  const ex = existing ? existing.data() : null;
  const bSnap = await db.collection('talentSchedule').doc(id).get();
  const b = bSnap.exists ? bSnap.data() : null;
  // UNCONFIRMED (Max, 22 Oct 2026): a new venue's night, DJ held - it gets its quote too
  const live = b && ['confirmed', 'unconfirmed'].includes(b.status || 'confirmed') && b.templateId && b.customerId;
  /*  A SENT quote nobody has accepted or paid can be updated when Max says
      so (Max, 23 Oct 2026) - the venue's link shows the new version and it
      stays "sent". Accepted / invoiced / paid ones never change.        */
  const sentOk = ex && ex.status === 'sent' && opts.force === true && !ex.acceptedAt && !(ex.amountPaidCents > 0) && !['bank', 'deposit', 'paid'].includes(ex.paymentStatus);
  if (ex && !['approved', 'cancelled'].includes(ex.status) && !sentOk) return { locked: true, id: existing.id, status: ex.status };
  if (!live) {
    if (existing && ex.status === 'approved') await existing.ref.update({ status: 'cancelled', cancelledAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return { cancelled: !!existing, skipped: !b ? 'gone' : !b.templateId ? 'no template' : !b.customerId ? 'no customer' : 'not confirmed' };
  }
  const tSnap = await db.collection('quotes').doc(String(b.templateId)).get();
  if (!tSnap.exists || !tSnap.data().isTemplate) return { needTemplate: true };
  const tpl = tSnap.data();
  const cSnap = await db.collection('customers').doc(String(b.customerId)).get();
  const cust = cSnap.exists ? cSnap.data() : {};

  const t = await db.collection('talent').doc(b.slug).get();
  const slugName = String(b.slug || '').split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const name = (t.exists && t.data().name) || slugName;
  const r = await db.collection('actRates').doc(b.slug).get();
  const rate = r.exists ? r.data() : {};
  // the DJ's real times, else the booked times, else 9:30pm + 4 hours (Max, 22 Oct 2026)
  const start = b.actualStart || b.start || '21:30';
  const finish = b.actualFinish || (b.actualStart ? '' : b.finish) || plus4h(start);
  const hours = gigHours(start, finish);
  const perHour = Math.max(0, Math.round(rate.hourlyRateCents || 0));
  const notes = [];
  if (!perHour) notes.push(name);
  const djLine = {
    type: 'custom', name: 'DJ performance - ' + name,
    description: 'Hourly' + (start && finish ? ' · ' + ampm(start) + '-' + ampm(finish) : '') + (b.timesConfirmedAt ? ' (confirmed)' : '')
      + (hours ? '' : ' · hours to confirm') + (perHour ? '' : ' · NO RATE SET - add it on the DJs tab'),
    qty: hours || 0, unitCents: perHour, days: 1, pubDj: true, noPick: true, perf: true,   // qty = hours, amount = hourly rate (Max, 23 Oct 2026)
  };
  const tr = await djTravel(rate.location, b.venue);
  const travelLine = tr.cents ? { type: 'custom', name: 'Travel Charge - ' + tr.from + ' to ' + tr.to + ' Return', description: '', qty: 1, unitCents: tr.cents, days: 1, pubDj: true, noPick: true } : null;
  if (tr.missing) notes.push(name + ' (no travel fee set for ' + tr.missing + ')');
  // THE BOOKING FEE, ex GST - a setting on Entertainment (Max, 22 Oct 2026):
  // a fixed $ or a % of the DJ's performance only.
  const fee = await djFeeSetting();
  const perfCents = Math.round((djLine.qty || 0) * djLine.unitCents);
  const feeCents = fee.mode === 'percent' ? Math.round(perfCents * fee.pct / 100) : fee.cents;
  const feeLine = feeCents > 0 ? { type: 'custom', name: fee.name, description: fee.description, qty: 1, unitCents: feeCents, days: 1, pubDj: true, noPick: true } : null;

  /*  BUILT FROM THE TEMPLATE (Max, 22 Oct 2026): the template's fill-in lines
      are swapped in place - "DJ / Entertainer" becomes this DJ + price, "DJ
      travel" their travel (dropped if local), the booking fee the setting.
      No fee line in the template = no fee. No travel line = travel goes
      under the DJ. No DJ line (older templates) = DJ + travel at the top.  */
  const tplLines = tpl.lines || [];
  const hasSlot = (k) => tplLines.some((l) => l.djSlot === k);
  let lines = [];
  tplLines.forEach((l) => {
    if (l.type === 'fee') return;   // the 2% "Booking & admin" is worked out below
    if (l.djSlot === 'dj') { lines.push(djLine); if (!hasSlot('travel') && travelLine) lines.push(travelLine); return; }
    if (l.djSlot === 'travel') { if (travelLine) lines.push(travelLine); return; }
    if (l.djSlot === 'fee') { if (feeLine) lines.push(feeLine); return; }
    if (l.pubDj || l.superLine) return;   // old generated DJ lines / super (added below)
    lines.push(l);
  });
  if (!hasSlot('dj')) lines = [djLine].concat(!hasSlot('travel') && travelLine ? [travelLine] : [], lines);
  if ((tpl.lines || []).some((l) => l.type === 'fee') && tpl.feeExcluded !== true) {
    const pre = quoteMoney({ hire: { days: 1 }, lines, discountCents: tpl.discountCents || 0 });
    const fee = Math.round(pre.netCents * 2 / 100 / 1000) * 1000;
    if (fee > 0) lines.push({ type: 'fee', name: 'Booking & admin', qty: 1, unitCents: fee, days: 1 });
  }
  // PERFORMER SUPER - 12% of the DJ's performance, unless the template has it off (Max, 22 Oct 2026)
  const superCents = tpl.superExcluded === true ? 0 : Math.round(perfCents * 12 / 100);
  if (superCents > 0) {
    const at = lines.indexOf(djLine);
    lines.splice(at >= 0 ? at + 1 : lines.length, 0, { type: 'custom', name: "Performer superannuation (12%)", description: "Australian law requires super to be paid for performers. We pay it into your DJ's super fund for you.", qty: 1, unitCents: superCents, days: 1, superLine: true, pubDj: true, noPick: true });
  }
  const tc = tpl.customer || {};
  const clean = sanitizeQuote({
    ...tpl, isTemplate: false, templateName: '', kind: 'quote', labourPackDate: '', lines,
    customer: {
      name: cust.name || '', business: cust.business || '', email: cust.email || '', ccEmail: cust.ccEmail || '',
      phone: cust.phone || '', address: cust.address || '',
      /*  ONCE THE QUOTE EXISTS, ITS OWN CONTACT DETAILS STAY (Max, 22 Oct 2026):
          edits made on the quote, or by the customer on the details form, are
          no longer overwritten from the Customers list when it's rebuilt. */
      ...(ex && ex.customer ? ['name', 'business', 'email', 'ccEmail', 'phone', 'address', 'dayContact', 'customerNotes', 'gearEmails']
        .reduce((o, k) => { if (ex.customer[k] != null) o[k] = ex.customer[k]; return o; }, {}) : {}),
      eventName: tc.eventName || ('DJ - ' + String(b.venue || '').split(',')[0]), eventType: 'dj',   // always DJ / Entertainment (Max, 22 Oct 2026)
      eventVenue: b.venue || '', eventDate: prettyDay(b.date), eventStartTime: start,
    },
    hire: { startDate: b.date, endDate: b.date, days: 1 },
  });
  const money = quoteMoney(clean);
  // the DJ's own deck goes on the pick list so setup staff bring the right cables (Max, 21 Oct 2026)
  if (rate.deck) clean.crewNotes = 'DJ deck (' + name + '): ' + String(rate.deck).slice(0, 300);
  // who played - shown on the entertainment-style quote / invoice (Max, 22 Oct 2026)
  const gigDj = { name, photo: (t.exists && t.data().photo) || ('images/talent/' + b.slug + '.jpg'), start, finish, hours, confirmed: !!b.timesConfirmedAt, venue: b.venue || '', bio: String((t.exists && t.data().bio) || '').slice(0, 1200), styles: Array.isArray(rate.styles) ? rate.styles.slice(0, 8) : [] };
  const meta = { gigDj, payFull: b.payFull === true, gigBookingId: id, pubNight: true, pubKey: 'gig|' + id, pubVenue: b.venue || '', pubDate: b.date, pubBookings: [id], pubNoRate: notes, gigHours: hours, gigTemplateId: String(b.templateId) };
  if (existing) {
    await existing.ref.update({ ...clean, ...money, ...meta, status: sentOk ? 'sent' : 'approved', updatedAt: FieldValue.serverTimestamp() });
    return { updated: true, id: existing.id, totalCents: money.totalCents, hours, noRate: notes };
  }
  const counterRef = db.collection('config').doc('counters');
  const seq = await db.runTransaction(async (tx) => {
    const c = await tx.get(counterRef);
    const n = ((c.exists && c.data().quoteSeq) || 0) + 1;
    tx.set(counterRef, { quoteSeq: n }, { merge: true });
    return n;
  });
  const ref = await db.collection('quotes').add({
    number: 'SG-Q-' + String(seq).padStart(4, '0'), token: crypto.randomBytes(16).toString('hex'),
    status: 'approved', approvedAt: FieldValue.serverTimestamp(), ...clean, ...money, ...meta,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: 'gig-auto',
  });
  return { created: true, id: ref.id, totalCents: money.totalCents, hours, noRate: notes };
}

exports.adminGigSync = onCall(async (request) => {
  requireAdmin(request);
  return gigSync((request.data || {}).bookingId, { force: (request.data || {}).force === true });
});

/* =========================================================================
   DJ CONFIRMS + DJ EMAILS  (Max, 21 Oct 2026 - Entertainment overhaul)
   One link per gig (/dj-times?t=). Before the gig the DJ taps "I'm in"
   (djConfirmedAt); after it, they put in their times. Emails go to the DJ's
   email on the roster (actRates) - texts need a paid SMS service, which
   Max will look at later:
     - when Max books them: "You're booked - please confirm"
     - 9:35am the day before: a reminder
     - 9:35am the day after: "please put in your times" (if not in yet)
   ========================================================================= */
async function ensureTimesToken(ref, b) {
  if (b.timesToken) return b.timesToken;
  const token = crypto.randomBytes(16).toString('hex');
  await ref.update({ timesToken: token });
  return token;
}
async function djEmailFor(b) {
  const [t, r] = await Promise.all([db.collection('talent').doc(b.slug).get(), db.collection('actRates').doc(b.slug).get()]);
  return { name: (t.exists && t.data().name) || b.slug, email: String((r.exists && r.data().email) || '').trim() };
}
async function emailDj(ref, b, kind) {
  const dj = await djEmailFor(b);
  if (!DETAIL_EMAIL_RE.test(dj.email)) return { sent: false, reason: 'no email' };
  const token = await ensureTimesToken(ref, b);
  const link = SITE_URL + '/dj-times?t=' + token;
  const first = dj.name.split(' ')[0];
  const where = String(b.venue || 'the gig').split(',')[0];
  const when = prettyDay(b.date) + (b.start ? ', ' + ampm(b.start) + (b.finish ? ' to ' + ampm(b.finish) : '') : '');
  const msg = kind === 'booked'
    ? { subject: "You're booked: " + where + ' ' + prettyDay(b.date), body: 'Hi ' + first + ',\n\nYou are booked to play ' + where + ' on ' + when + '.\n\nPlease tap the button to confirm you are in.\n\nThanks,\nMax\nSoundzGood Whitsundays - 0422 393 022', label: "I'm in - confirm" }
    : kind === 'tomorrow'
      ? { subject: "Tomorrow: you're on at " + where, body: 'Hi ' + first + ',\n\nJust a reminder - you are playing ' + where + ' tomorrow, ' + when + '.' + (b.djConfirmedAt ? '' : '\n\nPlease tap the button to confirm you are in.') + '\n\nThanks,\nMax\nSoundzGood Whitsundays - 0422 393 022', label: b.djConfirmedAt ? 'View the gig' : "I'm in - confirm" }
      : { subject: 'Your times for ' + where + ' ' + prettyDay(b.date), body: 'Hi ' + first + ',\n\nThanks for playing ' + where + '! Please tap the button and put in when you started and finished.\n\nThanks,\nMax\nSoundzGood Whitsundays - 0422 393 022', label: 'Put in my times' };
  return sendMessageEmail({ subject: msg.subject, body: msg.body }, {}, { to: dj.email, actions: [{ label: msg.label, url: link, primary: true }] });
}

/*  ADMIN - right after booking: the "you're booked" email (once per booking) */
exports.adminDjBooked = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  requireAdmin(request);
  const ref = db.collection('talentSchedule').doc(String((request.data || {}).bookingId || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such booking.');
  const b = snap.data();
  if (b.bookedEmailAt || (b.status || 'confirmed') !== 'confirmed' || b.djConfirmedAt) return { skipped: true };
  if (b.date < brisbaneTodayISO()) return { skipped: true };
  const r = await emailDj(ref, b, 'booked');
  if (r.sent) await ref.update({ bookedEmailAt: FieldValue.serverTimestamp() });
  return { sent: !!r.sent, reason: r.reason || r.error || '' };
});

/*  PUBLIC - the DJ taps "I'm in" */
exports.submitDjConfirm = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  await limitIp(request, 'djconfirm', 20, 60);
  const doc = await bookingByTimesToken((request.data || {}).token);
  const b = doc.data();
  if (b.djConfirmedAt) return { ok: true, already: true };
  await doc.ref.update({ djConfirmedAt: FieldValue.serverTimestamp() });
  const dj = await djEmailFor(b);
  await sendMessageEmail({
    subject: dj.name + " is in - " + String(b.venue || 'gig').split(',')[0] + ' ' + prettyDay(b.date),
    body: dj.name + ' confirmed they are playing ' + (b.venue || 'the gig') + ' on ' + prettyDay(b.date) + '.',
  }, {}, { to: process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au' });
  return { ok: true };
});

/*  9:35am every day: tomorrow's reminders, yesterday's "put in your times" */
exports.djReminders = onSchedule(
  { schedule: '35 9 * * *', timeZone: MSG_TZ, secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 },
  async () => {
    const today = brisbaneTodayISO();
    const tomorrow = addDaysISO(today, 1), yesterday = addDaysISO(today, -1);
    for (const [day, kind, flag] of [[tomorrow, 'tomorrow', 'remindedAt'], [yesterday, 'times', 'timesAskedAt']]) {
      const snap = await db.collection('talentSchedule').where('date', '==', day).get();
      for (const d of snap.docs) {
        const b = d.data();
        if ((b.status || 'confirmed') !== 'confirmed' || b[flag]) continue;
        if (kind === 'times' && b.timesConfirmedAt) continue;
        try {
          const r = await emailDj(d.ref, b, kind);
          if (r.sent) await d.ref.update({ [flag]: FieldValue.serverTimestamp() });
        } catch (e) { logger.error('djReminders', { id: d.id, err: e && e.message }); }
      }
    }
  }
);

/*  A DJ's rate / location / deck saved (DJs tab) -> their upcoming gig quotes
    are rebuilt on the server, whatever the browser does (Max, 22 Oct 2026).
    Only quotes that already exist and haven't gone out are touched.        */
exports.onDjRatesChanged = require('firebase-functions/v2/firestore').onDocumentWritten('actRates/{slug}', async (event) => {
  const slug = event.params.slug;
  const today = brisbaneTodayISO();
  const snap = await db.collection('talentSchedule').where('slug', '==', slug).get();
  for (const d of snap.docs) {
    const b = d.data();
    if (b.date < today || !b.templateId || !b.customerId) continue;
    const q = await db.collection('quotes').where('gigBookingId', '==', d.id).limit(1).get();
    if (q.empty || q.docs[0].data().status !== 'approved') continue;
    try { await gigSync(d.id); } catch (e) { logger.error('onDjRatesChanged', { id: d.id, err: e && e.message }); }
  }
});

/*  The DJ on a gig, for quotes made before gigDj was stored (Max, 22 Oct 2026) */
async function gigDjFor(bookingId) {
  try {
    const b = await db.collection('talentSchedule').doc(String(bookingId)).get();
    if (!b.exists) return null;
    const x = b.data();
    const t = await db.collection('talent').doc(x.slug).get();
    const slugName = String(x.slug || '').split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const start = x.actualStart || x.start || '21:30', finish = x.actualFinish || (x.actualStart ? '' : x.finish) || plus4h(start);
    const r = await db.collection('actRates').doc(x.slug).get();
    return { name: (t.exists && t.data().name) || slugName, photo: (t.exists && t.data().photo) || ('images/talent/' + x.slug + '.jpg'),
      start, finish, hours: gigHours(start, finish), confirmed: !!x.timesConfirmedAt, venue: x.venue || '', bio: String((t.exists && t.data().bio) || '').slice(0, 1200),
      styles: r.exists && Array.isArray(r.data().styles) ? r.data().styles.slice(0, 8) : [] };
  } catch (e) { return null; }
}

/*  UNCONFIRMED -> CONFIRMED (Max, 22 Oct 2026): a new venue's gig quote paid
    in full (card, or bank marked in admin) confirms the booking, and the DJ
    gets the "you're booked" email. Before that the night just holds the DJ. */
exports.onGigQuotePaid = require('firebase-functions/v2/firestore').onDocumentWritten(
  { document: 'quotes/{id}', secrets: [SMTP_USER, SMTP_PASS] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after || !after.gigBookingId) return;
    const paidNow = after.paymentStatus === 'paid' || after.status === 'paid';
    const paidBefore = before.paymentStatus === 'paid' || before.status === 'paid';
    if (!paidNow || paidBefore) return;
    const ref = db.collection('talentSchedule').doc(String(after.gigBookingId));
    const snap = await ref.get();
    if (!snap.exists || snap.data().status !== 'unconfirmed') return;
    await ref.update({ status: 'confirmed', paidUpfrontAt: FieldValue.serverTimestamp() });
    const b = { ...snap.data(), status: 'confirmed' };
    if (b.bookedEmailAt || b.djConfirmedAt || b.date < brisbaneTodayISO()) return;
    try {
      const r = await emailDj(ref, b, 'booked');
      if (r.sent) await ref.update({ bookedEmailAt: FieldValue.serverTimestamp() });
    } catch (e) { logger.error('onGigQuotePaid', { id: snap.id, err: e && e.message }); }
  });

/*  DJ BOOKING FEE SETTING (Max, 22 Oct 2026) - djSettings/fee, edited on
    Admin > Entertainment. Until it's saved: $80 fixed, as before.       */
async function djFeeSetting() {
  const d = await db.collection('djSettings').doc('fee').get();
  const x = d.exists ? d.data() : {};
  return {
    mode: x.mode === 'percent' ? 'percent' : 'fixed',
    cents: Number.isFinite(x.cents) ? Math.max(0, Math.round(x.cents)) : 8000,
    pct: Number.isFinite(x.pct) ? Math.max(0, Math.min(100, x.pct)) : 15,
    name: String(x.name || 'Booking & management').slice(0, 120),
    description: String(x.description == null ? 'Sourcing, scheduling and managing your DJ, with backup cover' : x.description).slice(0, 300),
  };
}
/*  The fee changed -> upcoming gig quotes that haven't gone out are rebuilt */
exports.onDjFeeChanged = require('firebase-functions/v2/firestore').onDocumentWritten('djSettings/{id}', async () => {
  const today = brisbaneTodayISO();
  const snap = await db.collection('talentSchedule').where('date', '>=', today).get();
  for (const d of snap.docs) {
    const b = d.data();
    if (!b.templateId || !b.customerId) continue;
    const q = await db.collection('quotes').where('gigBookingId', '==', d.id).limit(1).get();
    if (q.empty || q.docs[0].data().status !== 'approved') continue;
    try { await gigSync(d.id); } catch (e) { logger.error('onDjFeeChanged', { id: d.id, err: e && e.message }); }
  }
});

/*  A start time + 4 hours ("21:30" -> "01:30") - a gig with no finish set
    is quoted at the usual 4 hours (Max, 22 Oct 2026).                 */
function plus4h(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  if (!m) return '01:30';
  const v = ((+m[1] * 60 + +m[2] + 240) % 1440);
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

/* =========================================================================
   PAYMENT REMINDERS (Max, 22 Oct 2026) - sent only when Max presses Send.
   ========================================================================= */
function owesMoney(q) {
  if (!q || q.isTemplate || q.vendor) return false;
  if (!['sent', 'accepted', 'invoiced'].includes(q.status)) return false;
  if (q.paymentStatus === 'paid') return false;
  return quoteGrandTotal(q) - Math.round(q.amountPaidCents || 0) > 0;
}
/*  What's due now: the deposit if nothing's paid and it's more than 7 days
    out (and not "pay in full"), otherwise everything still owing.        */
function reminderInfo(q) {
  const total = quoteGrandTotal(q);
  const paid = Math.max(0, Math.round(q.amountPaidCents || 0));
  const owing = Math.max(0, total - paid);
  const dueDay = addDaysISO(q.hire && q.hire.startDate, -7);
  const fullNow = q.payFull === true || (!!dueDay && dueDay <= brisbaneToday()) || q.bankPlan === 'full';
  if (!paid && !fullNow) {
    const pct = q.depositPct || QUOTE_DEPOSIT_PCT;
    return { dueCents: Math.round(total * pct / 100), dueLabel: pct + '% deposit due now', isDeposit: true, balanceDue: dueDay ? prettyDay(dueDay) : '' };
  }
  return { dueCents: owing, dueLabel: paid ? 'Balance owing' : 'Amount due', isDeposit: false, balanceDue: '' };
}
exports.adminSendPaymentReminder = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
  requireAdmin(request);
  const { sendPaymentReminderEmail } = require('./lib/quote-doc-email');
  const ref = db.collection('quotes').doc(String((request.data || {}).id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No such quote.');
  const q = snap.data();
  if (!owesMoney(q)) throw new HttpsError('failed-precondition', 'Nothing is owing on this one.');
  if (!(q.customer && q.customer.email)) throw new HttpsError('failed-precondition', 'There is no email on this quote - add it first.');
  const mail = await sendPaymentReminderEmail(q, SITE_URL + '/quote?t=' + q.token, reminderInfo(q));
  if (!mail.sent) throw new HttpsError('internal', 'The email did not send (' + (mail.reason || 'error') + ').');
  await ref.update({ lastReminderAt: FieldValue.serverTimestamp(), reminderCount: FieldValue.increment(1) });
  return { sent: true, to: q.customer.email };
});
