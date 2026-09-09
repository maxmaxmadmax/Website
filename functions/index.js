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

const layout = require('./lib/layout');

initializeApp();
const db = getFirestore();

// Sydney is the closest region to North Queensland that runs everything.
setGlobalOptions({ region: 'australia-southeast1', maxInstances: 10 });

/* Secrets. These never appear in the repository - they are set with
   `firebase functions:secrets:set STRIPE_SECRET_KEY` and friends. */
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

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

/* True when a site is there to be taken - free, or already held by the
   person asking, or holding an expired hold nobody has tidied up yet. */
function siteIsFree(site, uid, now) {
  if (site.status === 'blocked' || site.status === 'booked') return false;
  if (site.status === 'held') {
    return site.heldBy === uid || holdHasExpired(site, now);
  }
  return true;
}

/* Every bay in a group must touch another bay in the same group, or the
   stall is not one stall - it is bays scattered around the market. Walks
   out from the first bay and checks it reaches all of them. */
function isJoinedUp(sitesById) {
  const ids = Object.keys(sitesById);
  if (ids.length <= 1) return true;

  const seen = new Set([ids[0]]);
  const queue = [ids[0]];

  while (queue.length) {
    const site = sitesById[queue.shift()];
    for (const neighbourId of site.adjacentIds || []) {
      if (sitesById[neighbourId] && !seen.has(neighbourId)) {
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

    tx.update(bookingRef, {
      siteId: heldIds[0],     // first bay, kept for anything reading one id
      siteIds: heldIds,       // every bay this booking holds
      siteLabel,              // "M4" or "M4 + M5 + M6"
      siteType: wantedType,
      bayCount,               // set from the bays taken, never from the client
      categoryName,
      amountCents,
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

    snaps.forEach((snap, i) => {
      if (!snap.exists) return;
      const site = snap.data();
      if (site.status === 'held' && site.heldBy === uid) {
        tx.update(refs[i], {
          status: 'available',
          heldBy: FieldValue.delete(),
          holdExpiresAt: FieldValue.delete(),
          bookingId: FieldValue.delete(),
        });
      }
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
exports.createCheckout = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  const uid = requireAuth(request);
  const { bookingId } = request.data || {};

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

  const amount = booking.amountCents ?? 0;

  // ---- Nothing to pay -----------------------------------------------------
  if (amount === 0) {
    await confirmBooking(bookingId, { paymentStatus: 'free' });
    return { ok: true, free: true };
  }

  // ---- Paid: hand off to Stripe -----------------------------------------
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
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: booking.currency || 'aud',
          unit_amount: amount,
          product_data: {
            name: `${vendorTypeLabel(booking.vendorType)} site - ${booking.siteLabel}`
              + (categoryName ? ` (${categoryName})` : ''),
            description: 'Eatz & Beatz Halloween Edition, Bowen Sports Complex, 31 October 2026',
          },
        },
      },
    ],
    success_url: `${SITE_URL}/vendor-signup?booking=${bookingId}&paid=1`,
    cancel_url: `${SITE_URL}/vendor-signup?booking=${bookingId}&cancelled=1`,
    // Give Stripe a little less time than our hold so the two do not
    // disagree about whether the site is still theirs.
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
  });

  await bookingRef.update({
    status: 'pending_payment',
    paymentStatus: 'unpaid',
    stripeSessionId: session.id,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { ok: true, url: session.url };
});

function vendorTypeLabel(type) {
  if (type === 'food') return 'Food vendor';
  if (type === 'market') return 'Market stall';
  return 'Community group';
}

/* -------------------------------------------------------------------------
   confirmBooking - the only place a booking becomes confirmed.

   Marks the site booked and bumps the category count, in one transaction.
   Safe to call twice: if the booking is already confirmed it does nothing,
   which matters because Stripe can deliver a webhook more than once.
   ------------------------------------------------------------------------- */
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
exports.stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET], cors: false },
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

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const bookingId = session.client_reference_id || session.metadata?.bookingId;

          if (!bookingId) {
            logger.warn('Checkout completed with no booking reference', { id: session.id });
            break;
          }

          if (session.payment_status === 'paid') {
            await confirmBooking(bookingId, {
              paymentStatus: 'paid',
              stripePaymentIntentId: session.payment_intent,
              amountPaidCents: session.amount_total,
            });
            logger.info('Booking confirmed by webhook', { bookingId });
          }
          break;
        }

        case 'checkout.session.expired': {
          const session = event.data.object;
          const bookingId = session.client_reference_id || session.metadata?.bookingId;
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
        const fresh = await tx.get(doc.ref);
        if (!fresh.exists) return;

        const site = fresh.data();
        if (site.status !== 'held') return;
        if (site.holdExpiresAt && site.holdExpiresAt.toMillis() > Date.now()) return;

        tx.update(doc.ref, {
          status: 'available',
          heldBy: FieldValue.delete(),
          holdExpiresAt: FieldValue.delete(),
          bookingId: FieldValue.delete(),
        });

        if (site.bookingId) {
          const bRef = db.collection('bookings').doc(site.bookingId);
          const bSnap = await tx.get(bRef);
          if (bSnap.exists && bSnap.data().status !== 'confirmed') {
            tx.update(bRef, {
              status: 'draft',
              paymentStatus: 'none',
              siteId: FieldValue.delete(),
              siteLabel: FieldValue.delete(),
              holdExpiresAt: FieldValue.delete(),
            });
          }
        }
      });
      released++;
    } catch (err) {
      logger.error('Could not release hold', { site: doc.ref.path, err });
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

  const callerEmail = (request.auth?.token?.email || '').toLowerCase();
  const callerIsBootstrap = bootstrap.includes(callerEmail);

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
    const baySnaps = await Promise.all(bayRefs.map((r) => tx.get(r)));

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

    if (booking.countedCategoryId) {
      const catRef = categoryRef(booking.eventId, booking.countedCategoryId);
      const catSnap = await tx.get(catRef);
      if (catSnap.exists && catSnap.data().count > 0) {
        tx.update(catRef, { count: FieldValue.increment(-1) });
      }
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
