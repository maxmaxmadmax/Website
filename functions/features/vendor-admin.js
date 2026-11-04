/* SOUNDZGOOD SERVER - vendor-admin
   The admin side of vendor bookings: review, payment, notes, sites, add by hand, save an event.
   Helpers shared with other features come from ../shared.js. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const layout = require('../lib/layout');
const {
    SMTP_PASS,
    SMTP_USER,
    bookingReference,
    categoryRef,
    checkBayCount,
    confirmAndNotify,
    db,
    feeBreakdown,
    priceFor,
    recordSend,
    refreshMessageCounts,
    requireAdmin,
    requireAuth,
    sendMessageTo,
    siteRef
} = require('../shared');

/* -------------------------------------------------------------------------
   Admin
   ------------------------------------------------------------------------- */

/* Creates the event, its sites and its categories from the seed layout.
   Safe to run again - it will not overwrite sites that already exist. */
exports.seedEvent = onCall(async (request) => {
    const eventId = (request.data && request.data.eventId) || 'eatz-beatz-halloween-2026';

    const eventRef = db.collection('events').doc(eventId);
    const existing = await eventRef.get();

    /* FIRST RUN ONLY. The very first seed is allowed without a sign-in, because
     no admin can exist until there are categories to sign up under. Only
     when the event does not exist yet and the id is this site's; it always
     writes the same fixed layout. After that it is admin-only. */
    requireAdmin(request);

    const batch = db.batch();

    if (!existing.exists) {
        batch.set(eventRef, {
            ...layout.defaultEvent(),
            createdAt: FieldValue.serverTimestamp()
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

    /* An anonymous token has no email (''), and '' must never match the
     bootstrap list - anyone can get an anonymous token. */
    const callerEmail = (request.auth?.token?.email || '').toLowerCase();
    const callerIsBootstrap = Boolean(callerEmail) && bootstrap.includes(callerEmail) && request.auth?.token?.email_verified === true;

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
        bookingId: FieldValue.delete()
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
        const bayIds = Array.isArray(booking.siteIds) && booking.siteIds.length ? booking.siteIds : booking.siteId ? [booking.siteId] : [];

        const bayRefs = bayIds.map((id) => siteRef(booking.eventId, id));

        /* Every read first - a transaction refuses a read after a write, so the
       category is fetched before the bays are handed back. */
        const baySnaps = await Promise.all(bayRefs.map((r) => tx.get(r)));

        const catRef = booking.countedCategoryId ? categoryRef(booking.eventId, booking.countedCategoryId) : null;
        const catSnap = catRef ? await tx.get(catRef) : null;

        // ---- reads done, writes from here ----

        baySnaps.forEach((siteSnap, i) => {
            if (siteSnap.exists && siteSnap.data().bookingId === bookingId) {
                tx.update(bayRefs[i], {
                    status: 'available',
                    bookingId: FieldValue.delete(),
                    heldBy: FieldValue.delete(),
                    holdExpiresAt: FieldValue.delete()
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
            updatedAt: FieldValue.serverTimestamp()
        });
    });

    return { ok: true };
});

/* =========================================================================
   THE ADMIN BACKEND

   Everything below is driven by /admin. None of it can be reached without
   the admin claim, and none of it is used by the public signup page.

   Two fields the public page never writes are added here:

     reviewStatus   pending | approved | waitlisted | declined
     notes[]        internal, staff only, never shown to the vendor

   They sit beside status, so a booking with no reviewStatus simply has no
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
    const bayIds = Array.isArray(booking.siteIds) && booking.siteIds.length ? booking.siteIds : booking.siteId ? [booking.siteId] : [];

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
                holdExpiresAt: FieldValue.delete()
            });
        }
    });
}

/* Undo the category count when a booking stops being real.
   Split in two because a transaction refuses a read after a write: callers
   do the read first, then their writes, then this. */
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
        throw new HttpsError('invalid-argument', 'Decision must be one of: ' + DECISIONS.join(', '));
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
            updatedAt: FieldValue.serverTimestamp()
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

   Marking a booking paid or free while it holds a site confirms it through
   the same confirmBooking the Stripe webhook uses, so a bank transfer or
   free entry ends up in exactly the same state as a card payment.
   ------------------------------------------------------------------------- */
const PAYMENT_STATES = ['none', 'unpaid', 'paid', 'free'];

exports.adminSetPayment = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    requireAdmin(request);
    const { bookingId, paymentStatus, amountPaidCents } = request.data || {};

    if (!bookingId) throw new HttpsError('invalid-argument', 'Missing booking.');
    if (!PAYMENT_STATES.includes(paymentStatus)) {
        throw new HttpsError('invalid-argument', 'Payment status must be one of: ' + PAYMENT_STATES.join(', '));
    }

    const who = actor(request);
    const ref = db.collection('bookings').doc(bookingId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Booking not found.');

    const booking = snap.data();
    const settled = paymentStatus === 'paid' || paymentStatus === 'free';
    const holdsSite = (booking.siteIds && booking.siteIds.length) || booking.siteId;

    if (settled && booking.status !== 'confirmed' && holdsSite) {
        /* Default to the full total (fee and GST included) - what would land in
       the account by bank transfer. */
        const paid =
            amountPaidCents != null
                ? Number(amountPaidCents)
                : paymentStatus === 'free'
                  ? 0
                  : booking.totalCents != null
                    ? booking.totalCents
                    : booking.amountCents || 0;

        const result = await confirmAndNotify(bookingId, {
            paymentStatus,
            amountPaidCents: paid
        });

        await ref.update({
            paidBy: who.email || who.uid,
            paidMarkedAt: FieldValue.serverTimestamp()
        });

        logger.info('admin marked paid', { bookingId, paymentStatus, by: who.email });
        return { ok: result.ok !== false, confirmed: result.ok !== false, ...result };
    }

    // Not settling, or nothing to confirm - just record the state.
    const update = {
        paymentStatus,
        paidBy: who.email || who.uid,
        paidMarkedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
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
    await db
        .collection('bookings')
        .doc(bookingId)
        .update({
            notes: FieldValue.arrayUnion({
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
                text: body,
                by: who.email || who.uid,
                at: Timestamp.now()
            }),
            updatedAt: FieldValue.serverTimestamp()
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
exports.adminAssignSite = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    requireAdmin(request);
    const { bookingId, siteIds } = request.data || {};

    if (!bookingId) throw new HttpsError('invalid-argument', 'Missing booking.');

    const wanted = Array.isArray(siteIds) ? siteIds.filter(Boolean) : [];
    if (wanted.length > 8) {
        throw new HttpsError('invalid-argument', 'Eight bays is the most anyone can have.');
    }

    const who = actor(request);

    const res = await db.runTransaction(async (tx) => {
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
            const takenBySomeoneElse = (site.status === 'booked' || site.status === 'held') && site.bookingId !== bookingId;

            if (takenBySomeoneElse) {
                throw new HttpsError('failed-precondition', `Site ${site.label || wanted[i]} already belongs to another vendor.`);
            }
            if (site.status === 'blocked') {
                throw new HttpsError('failed-precondition', `Site ${site.label || wanted[i]} is blocked off.`);
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
                holdExpiresAt: FieldValue.delete()
            });
        });

        const labels = newSnaps
            .map((s) => s.data().label)
            .filter(Boolean)
            .join(', ');

        const update = {
            seatedBy: who.email || who.uid,
            updatedAt: FieldValue.serverTimestamp()
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
        return { labels, was: booking.siteLabel || '', status: booking.status, eventId };
    });
    const label = res.labels;
    logger.info('admin assigned site', { bookingId, siteIds: wanted, by: who.email });

    // a paid vendor moved to a different site gets the "Site changed" email - once Max has approved it
    let emailed = false;
    if (wanted.length && label && label !== res.was && res.status === 'confirmed') {
        try {
            const ms = await db.collection('messages').where('eventId', '==', res.eventId).get();
            const md = ms.docs.find((x) => x.data().system === 'site-moved');
            const m = md && md.data();
            if (m && m.status === 'approved') {
                const fresh = await db.collection('bookings').doc(bookingId).get();
                const evSnap = await db.collection('events').doc(res.eventId).get();
                const r = await sendMessageTo(
                    { subject: m.approvedSubject || m.subject, body: m.approvedBody || m.body, promo: false },
                    evSnap.exists ? evSnap.data() : {},
                    fresh,
                    { extra: { old_site: res.was || 'no site' } }
                );
                await recordSend(md.ref, fresh, r);
                await refreshMessageCounts(md.ref);
                emailed = !!r.sent;
            }
        } catch (e) {
            logger.warn('site moved email', { bookingId, error: e && e.message });
        }
    }
    return { ok: true, siteLabel: label, emailed };
});

/*  Email one vendor the approved "Site changed" message (their drawer). */
exports.adminSendSiteChanged = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    requireAdmin(request);
    const bookingId = String((request.data || {}).bookingId || '');
    const bSnap = await db.collection('bookings').doc(bookingId).get();
    if (!bSnap.exists) throw new HttpsError('not-found', 'Booking not found.');
    const b = bSnap.data();
    if (b.status !== 'confirmed' || !b.siteLabel) throw new HttpsError('failed-precondition', 'They need to be paid and on a site.');
    if (!(b.business || {}).email) throw new HttpsError('failed-precondition', 'They have no email address.');
    const ms = await db.collection('messages').where('eventId', '==', b.eventId).get();
    const md = ms.docs.find((x) => x.data().system === 'site-moved');
    const m = md && md.data();
    if (!m || m.status !== 'approved')
        throw new HttpsError('failed-precondition', 'Approve the "Site changed" email on the Messages page first.');
    const evSnap = await db.collection('events').doc(b.eventId).get();
    const r = await sendMessageTo(
        { subject: m.approvedSubject || m.subject, body: m.approvedBody || m.body, promo: false },
        evSnap.exists ? evSnap.data() : {},
        bSnap,
        { extra: { old_site: 'your previous site' } }
    );
    await recordSend(md.ref, bSnap, r);
    await refreshMessageCounts(md.ref);
    if (!r.sent) throw new HttpsError('internal', 'It did not send: ' + (r.error || r.reason || ''));
    return { ok: true, to: b.business.email };
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
    const manualMoney = feeBreakdown(eventSnap.data(), priceFor(eventSnap.data(), vendorType, bayCount));

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
            description: String(biz.description || '').trim()
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
        updatedAt: FieldValue.serverTimestamp()
    };

    const ref = await db.collection('bookings').add(booking);

    logger.info('admin added vendor', { bookingId: ref.id, name, by: who.email });
    return { ok: true, bookingId: ref.id, reference: booking.reference };
});

/* -------------------------------------------------------------------------
   adminSaveEvent - create an event, or edit one.

   Opening and closing vendor signup is this same function: holdSite checks
   status before it gives anybody a site.

   Creating does not lay out the ground - seedEvent does that, since a new
   event usually wants a different map.
   ------------------------------------------------------------------------- */
const EVENT_STATES = ['draft', 'open', 'closed', 'archived'];

exports.adminSaveEvent = onCall(async (request) => {
    requireAdmin(request);
    const { eventId, create, fields } = request.data || {};

    const id = String(eventId || '').trim();
    if (!id) throw new HttpsError('invalid-argument', 'Missing event id.');

    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(id)) {
        throw new HttpsError('invalid-argument', 'The id must be lower case letters, numbers and dashes.');
    }

    const f = fields || {};
    const update = { updatedAt: FieldValue.serverTimestamp() };
    const text = (v, max = 200) =>
        String(v == null ? '' : v)
            .trim()
            .slice(0, max);

    ['name', 'subtitle', 'dateISO', 'dateLabel', 'venue', 'location'].forEach((k) => {
        if (f[k] !== undefined) update[k] = text(f[k]);
    });
    if (f.intro !== undefined) update.intro = text(f.intro, 400);
    if (f.faq !== undefined) {
        update.faq = (Array.isArray(f.faq) ? f.faq : [])
            .slice(0, 12)
            .map((x) => ({ q: text(x && x.q, 120), a: text(x && x.a, 400) }))
            .filter((x) => x.q && x.a);
    }
    if (f.entryText !== undefined) update.entryText = text(f.entryText, 80);
    ['startTime', 'finishTime'].forEach((k) => {
        if (f[k] !== undefined) update[k] = /^\d{2}:\d{2}$/.test(String(f[k] || '')) ? String(f[k]) : '';
    });
    /* THE NOTICE - venue change, postponed, cancelled or an update. Shown big
     on the public page, the vendor guide and the signup page. kind '' clears it. */
    if (f.notice !== undefined) {
        const n = f.notice || {};
        const kind = ['venue', 'postponed', 'cancelled', 'info'].includes(n.kind) ? n.kind : '';
        update.notice = kind
            ? { kind, title: text(n.title, 120), text: text(n.text, 600), was: text(n.was, 200), at: FieldValue.serverTimestamp() }
            : FieldValue.delete();
    }
    // the poster: uploaded to our Storage from the event form, or a file already on the site
    if (f.image !== undefined) {
        const img = text(f.image, 600);
        const ours =
            /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[\w.-]+\/o\/event-images%2F[\w.%-]+\?[\w=&.-]+$/.test(img) ||
            /^\/?images\/[\w./-]+$/.test(img);
        update.image = ours ? (img.startsWith('http') || img.startsWith('/') ? img : '/' + img) : '';
    }

    /* THE CONFIRMATION EMAIL - subject and body (HTML) written in the admin
     desk. Only the length is capped; the mailer escapes every value it fills in. */
    if (f.vendorEmail !== undefined) {
        const t = f.vendorEmail || {};
        if (t.subject !== undefined) update['vendorEmail.subject'] = text(t.subject, 300);
        if (t.body !== undefined) update['vendorEmail.body'] = text(t.body, 20000);
        update['vendorEmail.updatedAt'] = FieldValue.serverTimestamp();
    }

    if (f.status !== undefined) {
        if (!EVENT_STATES.includes(f.status)) {
            throw new HttpsError('invalid-argument', 'Status must be one of: ' + EVENT_STATES.join(', '));
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
                marketPerBay: update['pricing.marketPerBay'] != null ? update['pricing.marketPerBay'] : 5000
            },
            map: { width: layout.MAP_WIDTH, height: layout.MAP_HEIGHT },
            landmarks: layout.defaultLandmarks ? layout.defaultLandmarks() : [],

            createdAt: FieldValue.serverTimestamp(),
            createdBy: actor(request).email || request.auth.uid
        });

        logger.info('admin created event', { eventId: id });
        return { ok: true, eventId: id, created: true };
    }

    if (!snap.exists) throw new HttpsError('not-found', 'Event not found.');

    await ref.update(update);
    return { ok: true, eventId: id, created: false };
});
