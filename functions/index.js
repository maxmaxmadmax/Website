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
const admin = require('firebase-admin');

const layout = require('./lib/layout');

admin.initializeApp();
const db = admin.firestore();

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

/* True when a hold has run out. Anything not held is not expired. */
function holdHasExpired(site, now) {
  if (site.status !== 'held') return false;
  if (!site.holdExpiresAt) return true;
  return site.holdExpiresAt.toMillis() <= now;
}

/* -------------------------------------------------------------------------
   holdSite

   Puts a 10 minute hold on a site while the vendor finishes checkout.
   Runs in a transaction so two people pressing at the same moment cannot
   both come away with it, and checks the category limit in the same
   transaction for the same reason.
   ------------------------------------------------------------------------- */
exports.holdSite = onCall(async (request) => {
  const uid = requireAuth(request);
  const { eventId, siteId, bookingId } = request.data || {};

  if (!eventId || !siteId || !bookingId) {
    throw new HttpsError('invalid-argument', 'Missing event, site or booking.');
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

    const thisSiteRef = siteRef(eventId, siteId);
    const siteSnap = await tx.get(thisSiteRef);
    if (!siteSnap.exists) {
      throw new HttpsError('not-found', 'That site does not exist.');
    }
    const site = siteSnap.data();

    // The site must suit the vendor type - a market stall cannot take a
    // food site, and vice versa.
    if (site.type !== booking.vendorType) {
      throw new HttpsError(
        'failed-precondition',
        `Site ${site.label} is for ${site.type} vendors.`
      );
    }

    if (site.status === 'blocked') {
      throw new HttpsError('failed-precondition', `Site ${site.label} is not available.`);
    }
    if (site.status === 'booked') {
      throw new HttpsError('already-exists', `Site ${site.label} has just been taken.`);
    }
    if (site.status === 'held' && site.heldBy !== uid && !holdHasExpired(site, now)) {
      throw new HttpsError('already-exists', `Site ${site.label} is on hold for someone else.`);
    }

    // Food vendors must have a category, and it must not be full.
    let categoryName = null;
    if (booking.vendorType === 'food') {
      if (!booking.categoryId) {
        throw new HttpsError('failed-precondition', 'Choose a food category first.');
      }

      const catSnap = await tx.get(categoryRef(eventId, booking.categoryId));
      if (!catSnap.exists) {
        throw new HttpsError('not-found', 'That food category no longer exists.');
      }
      const category = catSnap.data();

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

    // Release any site this booking was holding previously.
    if (booking.siteId && booking.siteId !== siteId) {
      const oldRef = siteRef(eventId, booking.siteId);
      const oldSnap = await tx.get(oldRef);
      if (oldSnap.exists && oldSnap.data().heldBy === uid && oldSnap.data().status === 'held') {
        tx.update(oldRef, {
          status: 'available',
          heldBy: admin.firestore.FieldValue.delete(),
          holdExpiresAt: admin.firestore.FieldValue.delete(),
          bookingId: admin.firestore.FieldValue.delete(),
        });
      }
    }

    const holdMinutes = event.holdMinutes || 10;
    const expiresAt = admin.firestore.Timestamp.fromMillis(now + holdMinutes * 60 * 1000);

    tx.update(thisSiteRef, {
      status: 'held',
      heldBy: uid,
      bookingId,
      holdExpiresAt: expiresAt,
    });

    tx.update(bookingRef, {
      siteId,
      siteLabel: site.label,
      siteType: site.type,
      categoryName,
      amountCents: event.pricing[booking.vendorType] ?? 0,
      currency: event.currency || 'aud',
      holdExpiresAt: expiresAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      siteLabel: site.label,
      holdExpiresAt: expiresAt.toMillis(),
      amountCents: event.pricing[booking.vendorType] ?? 0,
    };
  });
});

/* -------------------------------------------------------------------------
   releaseHold - when someone backs out of the map step.
   ------------------------------------------------------------------------- */
exports.releaseHold = onCall(async (request) => {
  const uid = requireAuth(request);
  const { eventId, siteId } = request.data || {};

  if (!eventId || !siteId) {
    throw new HttpsError('invalid-argument', 'Missing event or site.');
  }

  await db.runTransaction(async (tx) => {
    const ref = siteRef(eventId, siteId);
    const snap = await tx.get(ref);
    if (!snap.exists) return;

    const site = snap.data();
    if (site.status === 'held' && site.heldBy === uid) {
      tx.update(ref, {
        status: 'available',
        heldBy: admin.firestore.FieldValue.delete(),
        holdExpiresAt: admin.firestore.FieldValue.delete(),
        bookingId: admin.firestore.FieldValue.delete(),
      });
    }
  });

  return { ok: true };
});

/* -------------------------------------------------------------------------
   createCheckout

   Free community bookings are confirmed here and never touch Stripe.
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

  const amount = booking.amountCents ?? 0;

  // ---- Free: community groups -------------------------------------------
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
            name: `${vendorTypeLabel(booking.vendorType)} site - ${booking.siteLabel}`,
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
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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

    const ref = siteRef(booking.eventId, booking.siteId);
    const siteSnap = await tx.get(ref);

    if (!siteSnap.exists) {
      throw new Error(`Site ${booking.siteId} vanished while confirming ${bookingId}`);
    }

    const site = siteSnap.data();

    // If someone else got there first, do not silently double book. The
    // booking is flagged so an admin can refund and re-seat them.
    if (site.status === 'booked' && site.bookingId !== bookingId) {
      tx.update(bookingRef, {
        status: 'needs_attention',
        paymentStatus: extra.paymentStatus || 'paid',
        problem: 'Site was taken before payment completed. Needs a new site or a refund.',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...stripeFields(extra),
      });
      logger.error('Site taken before payment settled', { bookingId, siteId: booking.siteId });
      return { ok: false, reason: 'site-taken' };
    }

    // Count the category now that the booking is real.
    if (booking.vendorType === 'food' && booking.categoryId && !booking.countedCategoryId) {
      const catRef = categoryRef(booking.eventId, booking.categoryId);
      const catSnap = await tx.get(catRef);
      if (catSnap.exists) {
        tx.update(catRef, {
          count: admin.firestore.FieldValue.increment(1),
        });
      }
    }

    tx.update(ref, {
      status: 'booked',
      bookingId,
      heldBy: admin.firestore.FieldValue.delete(),
      holdExpiresAt: admin.firestore.FieldValue.delete(),
    });

    tx.update(bookingRef, {
      status: 'confirmed',
      paymentStatus: extra.paymentStatus || 'paid',
      countedCategoryId: booking.categoryId || null,
      reference: booking.reference || bookingReference(),
      confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      holdExpiresAt: admin.firestore.FieldValue.delete(),
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
    if (booking.status === 'confirmed' || !booking.siteId) return;

    const ref = siteRef(booking.eventId, booking.siteId);
    const siteSnap = await tx.get(ref);

    if (siteSnap.exists && siteSnap.data().status === 'held' &&
        siteSnap.data().bookingId === bookingId) {
      tx.update(ref, {
        status: 'available',
        heldBy: admin.firestore.FieldValue.delete(),
        holdExpiresAt: admin.firestore.FieldValue.delete(),
        bookingId: admin.firestore.FieldValue.delete(),
      });
    }

    tx.update(bookingRef, {
      status: 'draft',
      paymentStatus: 'none',
      siteId: admin.firestore.FieldValue.delete(),
      siteLabel: admin.firestore.FieldValue.delete(),
      holdExpiresAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
}

/* -------------------------------------------------------------------------
   expireHolds - every minute, hand back anything whose 10 minutes ran out.
   ------------------------------------------------------------------------- */
exports.expireHolds = onSchedule('every 1 minutes', async () => {
  const now = admin.firestore.Timestamp.now();

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
          heldBy: admin.firestore.FieldValue.delete(),
          holdExpiresAt: admin.firestore.FieldValue.delete(),
          bookingId: admin.firestore.FieldValue.delete(),
        });

        if (site.bookingId) {
          const bRef = db.collection('bookings').doc(site.bookingId);
          const bSnap = await tx.get(bRef);
          if (bSnap.exists && bSnap.data().status !== 'confirmed') {
            tx.update(bRef, {
              status: 'draft',
              paymentStatus: 'none',
              siteId: admin.firestore.FieldValue.delete(),
              siteLabel: admin.firestore.FieldValue.delete(),
              holdExpiresAt: admin.firestore.FieldValue.delete(),
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
  requireAdmin(request);

  const eventId = (request.data && request.data.eventId) || 'eatz-beatz-halloween-2026';

  const eventRef = db.collection('events').doc(eventId);
  const existing = await eventRef.get();

  const batch = db.batch();

  if (!existing.exists) {
    batch.set(eventRef, {
      ...layout.defaultEvent(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
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

  const user = await admin.auth().getUserByEmail(email);
  await admin.auth().setCustomUserClaims(user.uid, { admin: makeAdmin !== false });

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
    heldBy: admin.firestore.FieldValue.delete(),
    holdExpiresAt: admin.firestore.FieldValue.delete(),
    bookingId: admin.firestore.FieldValue.delete(),
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

    if (booking.siteId) {
      const ref = siteRef(booking.eventId, booking.siteId);
      const siteSnap = await tx.get(ref);
      if (siteSnap.exists && siteSnap.data().bookingId === bookingId) {
        tx.update(ref, {
          status: 'available',
          bookingId: admin.firestore.FieldValue.delete(),
          heldBy: admin.firestore.FieldValue.delete(),
          holdExpiresAt: admin.firestore.FieldValue.delete(),
        });
      }
    }

    if (booking.countedCategoryId) {
      const catRef = categoryRef(booking.eventId, booking.countedCategoryId);
      const catSnap = await tx.get(catRef);
      if (catSnap.exists && catSnap.data().count > 0) {
        tx.update(catRef, { count: admin.firestore.FieldValue.increment(-1) });
      }
    }

    tx.update(bRef, {
      status: 'cancelled',
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      countedCategoryId: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return { ok: true };
});
