/* SOUNDZGOOD SERVER - vendor-booking
   Vendor signup: what a vendor pays, holding a site, checkout, Stripe, confirming, expiring holds.
   Helpers shared with other features come from ../shared.js. */
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const {
    SITE_URL,
    SMTP_PASS,
    SMTP_USER,
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
    autoGearOnDeposit,
    categoryRef,
    checkBayCount,
    confirmAndNotify,
    db,
    feeBreakdown,
    getStripe,
    invoiceNo,
    limitIp,
    nextInvoiceNumber,
    priceFor,
    quoteGrandTotal,
    rateLimit,
    requireAuth,
    siteRef,
    siteTypeFor
} = require('../shared');

/* True when a site is there to be taken - free, or already held by the
   person asking, or holding an expired hold nobody has tidied up yet. */
function siteIsFree(site, uid, now) {
    if (site.status === 'blocked' || site.status === 'booked') return false;
    if (site.status === 'held') {
        return site.heldBy === uid || holdHasExpired(site, now);
    }
    return true;
}

/* DO TWO BAYS TOUCH?
   Side by side or one above the other, with only a small gap. On the Bowen
   plan bays are 12-16 units apart and every aisle is 120, so a threshold
   of 20 joins bays that back on to each other but never across a walkway.
   Market bays only - food vans never join anything.

   KEEP IN STEP with js/site/vendor-map.js, or the page will offer a shape this
   function then refuses to allocate. */
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

/* Every bay in a group must touch another bay in the group, so the stall
   is one block. Walks out from the first bay and checks it reaches them all.
   Touching = listed as neighbours in the layout (up and down a column), or
   rectangles that back on to each other. */
function isJoinedUp(sitesById) {
    const ids = Object.keys(sitesById);
    if (ids.length <= 1) return true;

    const neighboursOf = (site) => {
        const listed = (site.adjacentIds || []).filter((id) => sitesById[id]);
        const touching = ids.filter((id) => id !== site.id && !listed.includes(id) && baysTouch(site, sitesById[id]));
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
    // a script cannot keep re-holding every site: 30 holds an hour per visitor, 20 per account
    await limitIp(request, 'hold', 30, 60);
    await rateLimit('hold|uid|' + uid, 20, 60);
    const { eventId, siteId, siteIds, bookingId } = request.data || {};

    // Accepts one siteId or a list of siteIds.
    const requested = Array.isArray(siteIds) && siteIds.length ? siteIds : siteId ? [siteId] : [];

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
                throw new HttpsError('failed-precondition', `Site ${s.label} is a ${s.type} site.`);
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
            throw new HttpsError('failed-precondition', 'The bays you picked are not all next to each other. Choose a joined-up block.');
        }

        /* PER-PERSON LIMIT. Bays this uid holds on other bookings count against
       the same ceiling, so one person cannot make several bookings and hold
       the whole field. */
        const others = await tx.get(db.collection('bookings').where('uid', '==', uid));

        let heldElsewhere = 0;
        others.forEach((d) => {
            if (d.id === bookingId) return; // this booking, handled above
            const b = d.data();
            if (b.eventId !== eventId) return; // a different event is their business
            if (b.status === 'cancelled') return;
            const ids = Array.isArray(b.siteIds) && b.siteIds.length ? b.siteIds : b.siteId ? [b.siteId] : [];
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
            const marketSnap = await tx.get(db.collection('events').doc(eventId).collection('sites').where('type', '==', 'market'));

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

        /* The category is picked after the site, so a booking may not have one
       yet. If it does, it is checked here too; the check that really matters
       is in createCheckout, the last point before money moves. */
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
                throw new HttpsError('failed-precondition', `${category.name} is not a ${booking.vendorType} category.`);
            }

            // Count this vendor's own in-flight hold only once.
            const alreadyCounted = booking.countedCategoryId === booking.categoryId;
            if (!alreadyCounted && category.count >= category.limit) {
                throw new HttpsError('resource-exhausted', `${category.name} is full for this event.`);
            }
            categoryName = category.name;
        }

        /* Let go of whatever this booking held before, including any bays it is
       not keeping. Everything is read before anything is written,
       because a Firestore transaction will not read after a write. */
        const previous =
            Array.isArray(booking.siteIds) && booking.siteIds.length ? booking.siteIds : booking.siteId ? [booking.siteId] : [];

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
                bookingId: FieldValue.delete()
            });
        }

        const holdMinutes = event.holdMinutes || 10;
        const expiresAt = Timestamp.fromMillis(now + holdMinutes * 60 * 1000);

        for (const ref of wantedRefs) {
            tx.update(ref, {
                status: 'held',
                heldBy: uid,
                bookingId,
                holdExpiresAt: expiresAt
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
            siteId: heldIds[0], // first bay, kept for anything reading one id
            siteIds: heldIds, // every bay this booking holds
            siteLabel, // "M4" or "M4 + M5 + M6"
            siteType: wantedType,
            bayCount, // set from the bays taken, never from the client
            categoryName,
            amountCents, // the site itself, ex GST
            bookingFeeCents: money.bookingFeeCents,
            gstCents: money.gstCents,
            totalCents: money.totalCents, // what they actually pay
            currency: event.currency || 'aud',
            holdExpiresAt: expiresAt,
            updatedAt: FieldValue.serverTimestamp()
        });

        return {
            ok: true,
            siteLabel,
            siteIds: heldIds,
            bayCount,
            holdExpiresAt: expiresAt.toMillis(),
            amountCents
        };
    });
});

/* -------------------------------------------------------------------------
   releaseHold - when someone backs out of the map step.
   ------------------------------------------------------------------------- */
exports.releaseHold = onCall(async (request) => {
    const uid = requireAuth(request);
    const { eventId, siteId, siteIds } = request.data || {};

    const wanted = Array.isArray(siteIds) && siteIds.length ? siteIds : siteId ? [siteId] : [];

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

        /* Clear the sites off the booking too, or the vendor still looks like they
       hold them (wrong in the admin list, and it counts against the per-person
       limit in holdSite). Read the bookings before writing anything. */
        const bookingIds = [...new Set(mine.map((m) => m.bookingId).filter(Boolean))];
        const bookingRefs = bookingIds.map((id) => db.collection('bookings').doc(id));
        const bookingSnaps = await Promise.all(bookingRefs.map((r) => tx.get(r)));

        // ---- reads done, writes from here ----

        mine.forEach(({ ref }) => {
            tx.update(ref, {
                status: 'available',
                heldBy: FieldValue.delete(),
                holdExpiresAt: FieldValue.delete(),
                bookingId: FieldValue.delete()
            });
        });

        bookingSnaps.forEach((snap, i) => {
            if (!snap.exists) return;
            const b = snap.data();
            if (b.uid !== uid) return; // not theirs to touch
            if (b.status === 'confirmed') return; // paid for; leave it alone

            const keeping = (Array.isArray(b.siteIds) ? b.siteIds : [b.siteId]).filter(Boolean).filter((id) => !wanted.includes(id));

            tx.update(
                bookingRefs[i],
                keeping.length
                    ? { siteId: keeping[0], siteIds: keeping, updatedAt: FieldValue.serverTimestamp() }
                    : {
                          siteId: FieldValue.delete(),
                          siteIds: FieldValue.delete(),
                          siteLabel: FieldValue.delete(),
                          holdExpiresAt: FieldValue.delete(),
                          updatedAt: FieldValue.serverTimestamp()
                      }
            );
        });
    });

    return { ok: true };
});

/* -------------------------------------------------------------------------
   createCheckout

   A booking that costs nothing (an admin priced it at zero) is confirmed
   here and never touches Stripe. Paid bookings get a Stripe Checkout
   session; the booking is only marked paid later by the webhook.
   ------------------------------------------------------------------------- */
exports.createCheckout = onCall({ secrets: [STRIPE_SECRET_KEY, SMTP_USER, SMTP_PASS] }, async (request) => {
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
     version in step with js/site/vendor-terms-data.js. */
    if (termsAccepted !== true) {
        throw new HttpsError('failed-precondition', 'Please agree to the Eatz & Beatz Vendor Terms & Conditions first.');
    }
    await bookingRef.update({
        termsAcceptedAt: FieldValue.serverTimestamp(),
        termsVersion: String(termsVersion || '').slice(0, 60)
    });

    /* The category limit is checked here, right before money moves. The
     category is chosen after the site, so holdSite cannot be the last word.
     Reading and stamping it in one transaction turns away whoever gets here
     second, before Stripe is called. */
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
            throw new HttpsError('failed-precondition', `${category.name} is not a ${booking.vendorType} category.`);
        }

        // A booking already counted against this category keeps its place.
        const alreadyCounted = booking.countedCategoryId === booking.categoryId;
        if (!alreadyCounted && category.count >= category.limit) {
            throw new HttpsError('resource-exhausted', `${category.name} is full for this event. Please choose another category.`);
        }

        tx.update(bookingRef, { categoryName: category.name });
        return category.name;
    });

    /*  What the vendor will see on their card statement and receipt. Read off
      the event so it stays right when there is more than one. */
    const eventSnapshot = await db.collection('events').doc(booking.eventId).get();
    const eventForBooking = eventSnapshot.exists ? eventSnapshot.data() : {};

    /* THE PRICE IS DERIVED HERE, NOT READ OFF THE BOOKING.
     The site price is worked out again from the event's pricing and the bays
     actually held, then the fee and GST from that - so editing amountCents in
     a browser achieves nothing. */
    const bayIds = Array.isArray(booking.siteIds) && booking.siteIds.length ? booking.siteIds : booking.siteId ? [booking.siteId] : [];

    if (!bayIds.length) {
        throw new HttpsError('failed-precondition', 'Choose a site first.');
    }

    /* VALIDATE AGAINST THE HELD SITES, NOT THE BOOKING.
     A vendor can still edit vendorType and eventId on their own draft, so
     neither is trusted: the sites they hold (checked by holdSite) are read
     back instead. A flipped event or type is refused before Stripe is called. */
    const wantedType = siteTypeFor(booking.vendorType);
    const heldSnaps = await Promise.all(bayIds.map((id) => siteRef(booking.eventId, id).get()));

    heldSnaps.forEach((snap, i) => {
        if (!snap.exists) {
            throw new HttpsError('failed-precondition', `Site ${bayIds[i]} is not part of this event. Please choose your site again.`);
        }
        const site = snap.data();
        if (site.heldBy !== uid || site.status !== 'held') {
            throw new HttpsError('failed-precondition', `Site ${bayIds[i]} is not being held for you. Please choose your site again.`);
        }
        if (site.type !== wantedType) {
            throw new HttpsError('failed-precondition', `Site ${bayIds[i]} is a ${site.type} site, not a ${booking.vendorType} one.`);
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
            bookingId,
            onBooking: booking.amountCents,
            recomputed: siteCents
        });
    }

    // ---- Nothing to pay -----------------------------------------------------
    if (amount === 0) {
        await confirmAndNotify(bookingId, { paymentStatus: 'free' });
        return { ok: true, free: true };
    }

    // ---- Paid: hand off to Stripe -----------------------------------------

    /* THE HOLD HAS TO OUTLIVE THE CHECKOUT SESSION.
     A Stripe session lasts at least 30 minutes, longer than the 10 minute
     hold, so the hold is pushed out first. Otherwise expireHolds could hand
     the site to someone else while the vendor is still paying. */
    const CHECKOUT_MINUTES = 30; // Stripe's own minimum
    const HOLD_MARGIN_MINUTES = 5; // webhook and clock-skew slack

    const sessionExpiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60;
    const holdUntil = Timestamp.fromMillis((sessionExpiresAt + HOLD_MARGIN_MINUTES * 60) * 1000);

    /*  bayIds is the validated list from the price check above - the same
      sites, reused to push their hold out past the Stripe session.   */
    await Promise.all([
        ...bayIds.map((id) => siteRef(booking.eventId, id).update({ holdExpiresAt: holdUntil })),
        bookingRef.update({ holdExpiresAt: holdUntil })
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
            uid
        },
        /* Three lines, not one total: the GST must show on its own for the
       receipt to work as a tax invoice. */
        line_items: [
            {
                quantity: 1,
                price_data: {
                    currency: booking.currency || 'aud',
                    unit_amount: money.siteCents,
                    product_data: {
                        name:
                            `${vendorTypeLabel(booking.vendorType)} site - ${booking.siteLabel}` +
                            (categoryName ? ` (${categoryName})` : ''),
                        // Read off the event, not hardcoded - a second event would
                        // otherwise sell sites described as the first one.
                        description: eventBlurb(eventForBooking)
                    }
                }
            },
            {
                quantity: 1,
                price_data: {
                    currency: booking.currency || 'aud',
                    unit_amount: money.bookingFeeCents,
                    product_data: {
                        name: 'Booking fee',
                        description: 'Card processing and online booking costs'
                    }
                }
            },
            {
                quantity: 1,
                price_data: {
                    currency: booking.currency || 'aud',
                    unit_amount: money.gstCents,
                    product_data: {
                        name: 'GST (10%)',
                        /* Say what the GST is 10% OF - Stripe shows no subtotal. */
                        description:
                            'Goods and services tax - 10% of ' +
                            `$${((money.siteCents + money.bookingFeeCents) / 100).toFixed(2)}` +
                            ' (site fee plus booking fee)'
                    }
                }
            }
        ],
        success_url: `${SITE_URL}/vendor-signup?booking=${bookingId}&paid=1`,
        cancel_url: `${SITE_URL}/vendor-signup?booking=${bookingId}&cancelled=1`,
        // The hold above was already pushed out past this, so the site cannot
        // be handed to somebody else while this session is still payable.
        expires_at: sessionExpiresAt
    });

    await bookingRef.update({
        status: 'pending_payment',
        paymentStatus: 'unpaid',
        stripeSessionId: session.id,
        // the figures actually sent to Stripe, so the record matches the receipt
        bookingFeeCents: money.bookingFeeCents,
        gstCents: money.gstCents,
        totalCents: money.totalCents,
        updatedAt: FieldValue.serverTimestamp()
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
        const fullyPaid = paidNow >= quoteGrandTotal(q); // includes any late payment charges
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
            updatedAt: FieldValue.serverTimestamp()
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
            event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET.value());
        } catch (err) {
            logger.error('Stripe signature check failed', err);
            res.status(400).send(`Webhook Error: ${err.message}`);
            return;
        }

        const bookingOf = (session) => session.client_reference_id || session.metadata?.bookingId;

        try {
            switch (event.type) {
                /* Cards arrive here already paid. Delayed methods (BECS direct debit)
           arrive unpaid and settle days later as async_payment_succeeded. Both
           routes must confirm. */
                case 'checkout.session.completed':
                case 'checkout.session.async_payment_succeeded': {
                    const session = event.data.object;

                    // A quote payment (quoteCheckout), not a vendor booking.
                    if (session.metadata && session.metadata.quoteId) {
                        if (session.payment_status === 'paid') {
                            await recordQuotePayment(session);
                            await autoGearOnDeposit(String(session.metadata.quoteId)); // gear list out once the deposit is in
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
                            amountPaidCents: session.amount_total
                        });
                        logger.info('Booking confirmed by webhook', { bookingId, via: event.type });
                    } else {
                        /*  Completed but not paid yet: a direct debit on its way. The
                site stays held rather than being handed to somebody else
                while their bank moves the money. */
                        logger.info('Checkout completed, payment still pending', {
                            bookingId,
                            status: session.payment_status
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
        const bayIds = Array.isArray(booking.siteIds) && booking.siteIds.length ? booking.siteIds : booking.siteId ? [booking.siteId] : [];

        if (!bayIds.length) return;

        const refs = bayIds.map((id) => siteRef(booking.eventId, id));
        const snaps = await Promise.all(refs.map((r) => tx.get(r)));

        snaps.forEach((siteSnap, i) => {
            if (siteSnap.exists && siteSnap.data().status === 'held' && siteSnap.data().bookingId === bookingId) {
                tx.update(refs[i], {
                    status: 'available',
                    heldBy: FieldValue.delete(),
                    holdExpiresAt: FieldValue.delete(),
                    bookingId: FieldValue.delete()
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
            updatedAt: FieldValue.serverTimestamp()
        });
    });
}

/* -------------------------------------------------------------------------
   expireHolds - every minute, hand back anything whose 10 minutes ran out.
   ------------------------------------------------------------------------- */
exports.expireHolds = onSchedule('every 1 minutes', async () => {
    const now = Timestamp.now();

    const stale = await db.collectionGroup('sites').where('status', '==', 'held').where('holdExpiresAt', '<=', now).limit(200).get();

    if (stale.empty) return;

    let released = 0;

    for (const doc of stale.docs) {
        try {
            await db.runTransaction(async (tx) => {
                /* EVERY READ FIRST - a Firestore transaction will not accept a read after
           a write, so the booking is fetched here even though it is written last. */
                const fresh = await tx.get(doc.ref);
                if (!fresh.exists) return;

                const site = fresh.data();
                if (site.status !== 'held') return;
                if (site.holdExpiresAt && site.holdExpiresAt.toMillis() > Date.now()) return;

                const bRef = site.bookingId ? db.collection('bookings').doc(site.bookingId) : null;
                const bSnap = bRef ? await tx.get(bRef) : null;

                // ---- reads done, writes from here ----

                tx.update(doc.ref, {
                    status: 'available',
                    heldBy: FieldValue.delete(),
                    holdExpiresAt: FieldValue.delete(),
                    bookingId: FieldValue.delete(),
                    waitlistHold: FieldValue.delete()
                });

                if (bSnap && bSnap.exists && bSnap.data().status !== 'confirmed') {
                    tx.update(bRef, {
                        status: 'draft',
                        paymentStatus: 'none',
                        siteId: FieldValue.delete(),
                        siteIds: FieldValue.delete(),
                        siteLabel: FieldValue.delete(),
                        holdExpiresAt: FieldValue.delete()
                    });
                }
            });
            released++;
        } catch (err) {
            /* Log err.message - err on its own serialises to {} in structured logging. */
            logger.error('Could not release hold', {
                site: doc.ref.path,
                message: err && err.message
            });
        }
    }

    logger.info(`Released ${released} expired hold(s)`);
});
