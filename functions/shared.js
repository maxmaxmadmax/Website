/* SOUNDZGOOD SERVER - shared
   Starts Firebase and holds the secrets and the helpers more than one feature uses.
   Everything that decides something important happens on the server, never in the
   browser: which sites are taken, whether a category is full, whether a booking is paid. */

const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

require('./lib/mail-log'); // every email the system sends is logged (Messages > Sent emails)
const { sendBookingEmails } = require('./lib/email');
const { sendVendorInvoiceEmail } = require('./lib/vendor-invoice-email');
const { sendMessageEmail, fieldsFor } = require('./lib/message-email');

initializeApp();
const db = getFirestore();

// Sydney is the closest region to North Queensland that runs everything.
setGlobalOptions({ region: 'australia-southeast1', maxInstances: 10 });

/* Secrets. These never appear in the repository - they are set with
   `firebase functions:secrets:set STRIPE_SECRET_KEY` and friends. */
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

/* Google Workspace SMTP. SMTP_PASS is an app password, not the account
   password. */
const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');

/* Where Stripe sends people back to. Set by env var, or use the default. */
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

/* RATE LIMIT. The public forms need no login, so this stops a script
   flooding the database or using the estimate bot to email strangers.
   Counts per visitor (by hashed IP - no IPs are stored) per form, in a
   fixed window. rateLimits/ is closed to browsers. */
/* The visitor's address: the LAST x-forwarded-for entry is the one Google adds;
   anything before it the visitor can type in themselves, so it is ignored. */
function callerIp(request) {
    const r = request.rawRequest || {};
    const fwd = String((r.headers && r.headers['x-forwarded-for']) || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    return String(fwd[fwd.length - 1] || (r.socket && r.socket.remoteAddress) || 'unknown');
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
        throw new HttpsError('failed-precondition', 'Stripe is not configured yet. Set the STRIPE_SECRET_KEY secret.');
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
        throw new HttpsError('invalid-argument', `A market stall must be between 1 and ${max} bays.`);
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

   The site price is GST exclusive. On top of it go a booking fee (card
   charges and running costs), then GST on the two together.

       fee   = 4% of the site price, plus 99c a transaction
       GST   = 10% of (site + fee)
       total = site + fee + GST

   A $100 food site therefore comes to $115.49, of which $10.50 is GST.
   The percentage is taken off the site price only, never off the GST.

   THIS IS THE ONLY PLACE THESE NUMBERS LIVE. The vendor page shows the same
   figures, but the total is recomputed here at checkout, so a tampered
   browser cannot change the price. Defaults can be overridden per event.
   ------------------------------------------------------------------------- */
const FEE_PERCENT = 0.04;
const FEE_FIXED_CENTS = 99;
const GST_RATE = 0.1;

function feeBreakdown(event, siteCents) {
    const site = Math.max(0, Math.round(Number(siteCents) || 0));

    /* A free site stays free - no fee or GST on a site given away. */
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
        totalCents: site + bookingFeeCents + gstCents
    };
}

/* -------------------------------------------------------------------------
   confirmBooking - the only place a booking becomes confirmed.

   Marks the site booked and bumps the category count, in one transaction.
   Safe to call twice: if the booking is already confirmed it does nothing,
   which matters because Stripe can deliver a webhook more than once.
   ------------------------------------------------------------------------- */
/* CONFIRM, THEN TELL PEOPLE.
   Everything calls this rather than confirmBooking directly.
   Emails go out only after the transaction commits (a transaction can run
   twice), and can never fail the booking - failures are logged and
   swallowed. Sent once: confirmationEmailAt is stamped on the booking. */
async function confirmAndNotify(bookingId, extra = {}) {
    const result = await confirmBooking(bookingId, extra);

    // nothing was confirmed - a duplicate webhook, or a site taken first
    if (!result || result.ok === false || result.alreadyConfirmed) return result;

    // the vendor's tax invoice number + private link, ready for the Sales Pipeline.
    // This only makes the invoice; it is not emailed here.
    try {
        await ensureVendorInvoice(bookingId);
    } catch (err) {
        logger.warn('vendor invoice number failed', { bookingId, message: err && err.message });
    }

    try {
        const ref = db.collection('bookings').doc(bookingId);
        const snap = await ref.get();
        if (!snap.exists) return result;

        const booking = snap.data();
        if (booking.confirmationEmailAt) return result; // already told them

        const evSnap = await db.collection('events').doc(booking.eventId).get();
        const event = evSnap.exists ? evSnap.data() : {};

        /* AUTO-SEND: the vendor gets the tax invoice & event guide email (one
       email, not two); the office still gets its copy. confirmationEmailAt is
       the "already told them" guard above. */
        await sendBookingEmails(booking, bookingId, event, { officeOnly: true });
        // paused in the Messages page? then no vendor email (the office copy still went)
        if (await invoiceEmailPaused(booking.eventId)) return result;
        const mail = await sendVendorInvoice(bookingId, {});
        await ref.update({
            emailStatus: mail.sent ? 'sent' : 'failed',
            emailAt: FieldValue.serverTimestamp(),
            ...(mail.sent
                ? { confirmationEmailAt: FieldValue.serverTimestamp() }
                : { emailError: String(mail.error || mail.reason || '').slice(0, 500) })
        });
    } catch (err) {
        logger.error('confirmation email step failed, booking is still confirmed', {
            bookingId,
            message: err && err.message
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
        const bayIds = Array.isArray(booking.siteIds) && booking.siteIds.length ? booking.siteIds : booking.siteId ? [booking.siteId] : [];

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
                ...stripeFields(extra)
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
                    count: FieldValue.increment(1)
                });
            }
        }

        for (const ref of refs) {
            tx.update(ref, {
                status: 'booked',
                bookingId,
                heldBy: FieldValue.delete(),
                holdExpiresAt: FieldValue.delete()
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
            ...stripeFields(extra)
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

/* =========================================================================
   ESTIMATE BOT

   The public estimate bot is submitBotQuote (further down): it prices from
   packages, emails the visitor a price guide and creates a draft quote in
   the Sales Pipeline.
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
            message: err && err.message
        });
    }
    return [];
}

/*  Totals from the stored lines. Prices are ex-GST; discounts come off the
    net; GST is 10% of the net; total is net + GST.                        */
/*  A saved quote's discountCents is the TOTAL discount (discount lines + the
    whole-quote one). The whole-quote part on its own is the rest.          */
function ownDiscount(q) {
    const lineDisc = ((q && q.lines) || []).reduce(
        (n, l) => n + (l.type === 'discount' ? Math.max(0, Math.round(l.amountCents || 0)) : 0),
        0
    );
    return Math.max(0, Math.round((q && q.discountCents) || 0) - lineDisc);
}

function quoteMoney(quote) {
    const days = Math.max(1, Math.round((quote.hire && quote.hire.days) || 1));
    let subtotal = 0;
    let discount = Math.max(0, Math.round(quote.discountCents || 0)); // discount off the whole total
    (quote.lines || []).forEach((l) => {
        if (l.type === 'discount') {
            discount += Math.max(0, Math.round(l.amountCents || 0));
            return;
        }
        const qty = Math.max(0, l.perf ? Math.round(Number(l.qty || 0) * 4) / 4 : Math.round(Number(l.qty) || 0)); // DJ hours can be 4.5 etc
        const unit = Math.max(0, Math.round(l.unitCents || 0));
        const lineDays = Math.max(1, Math.round(l.days || days));
        subtotal += Math.round(qty * unit * lineDays);
    });
    const net = Math.max(0, subtotal - discount);
    const gst = Math.round(net * 0.1);
    return { subtotalCents: subtotal, discountCents: discount, netCents: net, gstCents: gst, totalCents: net + gst };
}

function sanitizeQuote(q) {
    const text = (v, max) =>
        String(v == null ? '' : v)
            .trim()
            .slice(0, max);
    const days = Math.max(1, Math.round(Number(q.hire && q.hire.days) || 1));

    const customer = {
        name: text(q.customer && q.customer.name, 120),
        business: text(q.customer && q.customer.business, 120),
        email: text(q.customer && q.customer.email, 200),
        // CC: one or more addresses (comma separated, e.g. accounts) that get a copy
        // of the quote / invoice email - only valid ones kept
        ccEmail: String((q.customer && q.customer.ccEmail) || '')
            .split(/[,;\s]+/)
            .map((e) => e.trim())
            .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
            .slice(0, 10)
            .join(', ')
            .slice(0, 600),
        phone: text(q.customer && q.customer.phone, 40),
        address: text(q.customer && q.customer.address, 300),
        eventName: text(q.customer && q.customer.eventName, 160),
        eventType: text(q.customer && q.customer.eventType, 40),
        eventDate: text(q.customer && q.customer.eventDate, 60),
        eventVenue: text(q.customer && q.customer.eventVenue, 200), // venue (customer details form)
        eventStartTime: text(q.customer && q.customer.eventStartTime, 20), // when the event starts - we work out bump-in from it
        eventEndTime: text(q.customer && q.customer.eventEndTime, 20),
        soundcheckTime: text(q.customer && q.customer.soundcheckTime, 20),
        customerNotes: text(q.customer && q.customer.customerNotes, 2000), // "anything we should know" from the details form
        dayContact: text(q.customer && q.customer.dayContact, 200), // event day contact - name & phone
        // the band / crew who get the gear list with NO prices - not the billing CC
        gearEmails: String((q.customer && q.customer.gearEmails) || '')
            .split(/[,;\s]+/)
            .map((e) => e.trim())
            .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
            .slice(0, 10)
            .join(', ')
            .slice(0, 600)
    };
    const hire = {
        startDate: text(q.hire && q.hire.startDate, 40),
        endDate: text(q.hire && q.hire.endDate, 40),
        days
    };
    const lines = (Array.isArray(q.lines) ? q.lines : [])
        .slice(0, 200)
        .map((l) => {
            const type = ['item', 'kit', 'custom', 'discount', 'labour', 'delivery', 'fee'].includes(l.type) ? l.type : 'custom';
            const line = {
                type,
                itemId: text(l.itemId, 60),
                name: text(l.name, 200),
                description: text(l.description, 500),
                qty:
                    type === 'discount' ? 1 : Math.max(0, l.perf ? Math.round(Number(l.qty || 0) * 4) / 4 : Math.round(Number(l.qty) || 0)),
                unitCents: type === 'discount' ? 0 : Math.max(0, Math.round(Number(l.unitCents) || 0)),
                extraDayCents: Math.max(0, Math.round(Number(l.extraDayCents) || 0)),
                days: Math.max(1, Math.round(Number(l.days) || days)),
                amountCents: type === 'discount' ? Math.max(0, Math.round(Number(l.amountCents) || 0)) : 0
            };
            if (['normal', 'discounted', 'free'].includes(l.charge)) line.charge = l.charge;
            // a system part's place in its order (System builder) - kept on quotes
            if (l.sysOrder != null && Number.isFinite(Number(l.sysOrder))) line.sysOrder = Math.max(0, Math.round(Number(l.sysOrder)));
            if (l.pkgId) line.pkgId = text(l.pkgId, 60); // belongs to a package (itemised + package discount)
            // parts removed from this kit on the quote - they stay off when it is rebuilt
            if (Array.isArray(l.removedParts) && l.removedParts.length)
                line.removedParts = l.removedParts
                    .slice(0, 100)
                    .map((x) => text(x, 60))
                    .filter(Boolean);
            // PUB NIGHTS: the DJ lines the pub invoice swaps each week - never gear
            if (l.pubDj === true) line.pubDj = true;
            if (l.noPick === true) line.noPick = true;
            // a template's fill-in line: the DJ, their travel or the booking fee
            if (['dj', 'travel', 'fee', 'accom'].includes(l.djSlot)) line.djSlot = l.djSlot;
            if (l.perf === true) line.perf = true; // the DJ's performance fee (super is worked out on it)
            if (l.superLine === true) line.superLine = true; // the performer super line itself
            if (l.accom === true) line.accom = true; // "accommodation provided by the venue" note
            // CREW & VEHICLES (from Crew & Vehicles): their own subtotal, never gear
            if (['staff', 'vehicle', 'trailer'].includes(l.resType)) {
                line.resType = l.resType;
                if (l.resourceId) line.resourceId = text(l.resourceId, 60);
                if (l.baseCents != null) line.baseCents = Math.max(0, Math.round(Number(l.baseCents) || 0)); // their own day rate (surcharges on top)
            }
            return line;
        })
        .filter((l) => l.name || l.itemId || l.type === 'discount'); // a discount can be left unnamed (the quote shows a default)

    const kind = ['estimate', 'quote', 'invoice'].includes(q.kind) ? q.kind : 'quote';
    return {
        customer,
        hire,
        lines,
        kind,
        discountCents: Math.max(0, Math.round(Number(q.discountCents) || 0)),
        labourExcluded: q.labourExcluded === true,
        feeExcluded: q.feeExcluded === true,
        superExcluded: q.superExcluded === true, // performer super off
        accomOff: q.accomOff === true, // accommodation note removed (DJ driving home)
        autoSendOnDetails: q.autoSendOnDetails === true, // send the quote when the customer fills in their details
        payFull: q.payFull === true, // "pay in full up front" - no deposit option
        isTemplate: q.isTemplate === true, // Sales Pipeline > Templates: a DJ gig invoice to copy - never sent
        templateName: text(q.templateName, 80), // its own name, e.g. "Grand View Friday"
        posterUrl: /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/soundzgood-8c86f[\w.-]*\/o\/quote-images%2F[^\s"'<>]+$/.test(
            String(q.posterUrl || '')
        )
            ? String(q.posterUrl).slice(0, 600)
            : '', // event poster on the quote
        labourPH: { setup: !!(q.labourPH && q.labourPH.setup), pack: !!(q.labourPH && q.labourPH.pack) },
        labourOff: { setup: !!(q.labourOff && q.labourOff.setup), pack: !!(q.labourOff && q.labourOff.pack) },
        labourPackDate: /^\d{4}-\d{2}-\d{2}$/.test(String(q.labourPackDate || '')) ? String(q.labourPackDate) : '',
        delivery: {
            town: text(q.delivery && q.delivery.town, 80),
            km: Math.max(0, Math.round(Number(q.delivery && q.delivery.km) || 0))
        },
        notes: text(q.notes, 3000),
        terms: text(q.terms, 3000)
    };
}

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
    return db.runTransaction(async (t) => {
        const r = await take(t);
        r.write();
        return r;
    });
}
const invoiceNo = (n) => 'SG-I-' + String(n).padStart(4, '0');

/* =========================================================================
   PICK LIST
   Once the deposit is in, a job gets a private CREW link (crewToken) to a
   pick list: the gear with NO prices, plus Packed / Returned ticks that are
   saved here so the office can see progress. Separate from the customer token.
   ========================================================================= */

/* deposit in, or paid - the booking is confirmed (same rule as js/admin/stock.js) */
function pickReady(q) {
    if (!q || q.status === 'cancelled' || q.status === 'declined') return false;
    return q.status === 'paid' || q.paymentStatus === 'deposit' || q.paymentStatus === 'paid' || !!q.jobConfirmedAt; // confirmed, paying later
}

/*  The GEAR LIST link the customer / band share (gearToken) is read-only:
    gear and times, no ticks, no extras, no payment status. It is a
    different code from the crew pick list link, so it can't tick anything. */
async function gearLinkToken(ref, q) {
    if (q.gearToken) return q.gearToken;
    const t = crypto.randomBytes(16).toString('hex');
    await ref.update({ gearToken: t });
    return t;
}

/*  The gear list and pick list LINKS open as soon as the quote exists (any
    status but cancelled). The automatic gear emails still wait for the deposit. */
const listOpen = (q) => !!q && !['cancelled', 'declined'].includes(q.status) && !q.isTemplate;

/*  PUBLIC - fetch a quote by its token. Returns a customer-safe subset; the
    doc itself stays closed to browsers.                                    */
const QUOTE_DEPOSIT_PCT = 50;

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
            ...(b.invoicedAt ? {} : { invoicedAt: FieldValue.serverTimestamp() })
        });
        return { booking: b, invoiceNumber, token };
    });
}

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
    const total = b.totalCents != null ? b.totalCents : b.amountCents || 0;
    // wording from the Messages page: the APPROVED copy (a test can use the draft)
    let tpl = {};
    try {
        const ms = await db.collection('messages').where('eventId', '==', b.eventId).get();
        const sys = ms.docs.map((x) => x.data()).find((x) => x.system === 'invoice');
        if (sys && opts.useDraft && sys.body) tpl = { subjectTpl: sys.subject, bodyTpl: sys.body };
        else if (sys && sys.approvedBody) tpl = { subjectTpl: sys.approvedSubject, bodyTpl: sys.approvedBody };
    } catch (e) {
        logger.warn('invoice wording', e && e.message);
    }
    const mail = await sendVendorInvoiceEmail({
        ...tpl,
        siteLabel: b.siteLabel || '',
        eventVenue: [ev.venue, ev.location].filter(Boolean).join(', '),
        to,
        test,
        link: SITE_URL + '/vendor-invoice?t=' + inv.token,
        invoiceNumber: inv.invoiceNumber,
        totalCents: total,
        businessName: biz.name || '',
        contactName: biz.contactName || '',
        eventName: ev.name || '',
        eventDate: ev.dateLabel || ''
    });
    if (mail.sent && !test) {
        await db.collection('bookings').doc(id).update({
            invoiceEmailedAt: FieldValue.serverTimestamp(),
            invoiceEmailedTo: to
        });
    }
    return { ...mail, to, test, invoiceNumber: inv.invoiceNumber };
}

const MSG_TZ = 'Australia/Brisbane';
const UNSUB_URL = process.env.UNSUB_URL || 'https://vendorunsubscribe-4smug72szq-ts.a.run.app';

const brisbaneToday = () => new Date().toLocaleDateString('en-CA', { timeZone: MSG_TZ }); // YYYY-MM-DD
function brisbaneMinutesNow() {
    const parts = new Intl.DateTimeFormat('en-AU', { timeZone: MSG_TZ, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(
        new Date()
    );
    const get = (t) => Number((parts.find((p) => p.type === t) || {}).value || 0);
    return (get('hour') % 24) * 60 + get('minute');
}
function addDaysISO(iso, n) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return '';
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10);
}

async function sendMessageTo(msg, ev, bookingDoc, opts) {
    const b = bookingDoc.data();
    const inv = await ensureVendorInvoice(bookingDoc.id);
    const values = { ...fieldsFor(b, ev, SITE_URL + '/vendor-invoice?t=' + inv.token), ...(opts.extra || {}) };
    return sendMessageEmail(msg, values, {
        to: opts.test ? opts.to : (b.business || {}).email,
        test: !!opts.test,
        unsubscribeLink: msg.promo ? UNSUB_URL + '?t=' + inv.token : ''
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
    await ref
        .collection('sends')
        .doc(bookingDoc.id)
        .set({
            ok: !!result.sent,
            to: (b.business || {}).email || '',
            name: (b.business || {}).name || '',
            error: result.sent ? '' : String(result.error || result.reason || 'not sent'),
            at: FieldValue.serverTimestamp()
        });
}

/*  Is the tax-invoice-on-payment email paused for this event? */
async function invoiceEmailPaused(eventId) {
    const snap = await db.collection('messages').where('eventId', '==', eventId).get();
    return snap.docs.some((d) => d.data().system === 'invoice' && d.data().status === 'paused');
}

/* =========================================================================
   LATE PAYMENT CHARGES
   Terms "Overdue payments": an invoice still unpaid MORE THAN 28 DAYS after its
   due date (due = 7 days before the event) may get 2% of the outstanding
   balance, and another 2% for each further full month. NOTHING IS ADDED BY
   ITSELF - the Sales Pipeline shows "Late fee due" and Max presses Add.
   Kept separate from the hire lines: quotes/{id}.lateFees [{cents, date, by}]
   and lateFeeCents, so the original invoice is unchanged. No GST on them.
   KEEP IN STEP with lateFeeDue() in js/admin/sales-pipeline.js.
   ========================================================================= */
function quoteGrandTotal(q) {
    return Math.round(q.totalCents || 0) + Math.round(q.lateFeeCents || 0);
}
const sponsorLink = (eventId, token) => SITE_URL + '/sponsor?e=' + encodeURIComponent(eventId) + (token ? '&t=' + token : '');
const SPONSOR_NOTE = "Not for you? Just reply and let us know - we won't email you about it again.";

function sponsorValues(p, ev) {
    return {
        vendor_name: p.contactName || p.business || 'there',
        business_name: p.business || 'your business',
        site_number: '',
        guide_link: '',
        event_name: ev.name || 'Eatz & Beatz',
        event_date: ev.dateLabel || ev.dateISO || '',
        event_venue: [ev.venue, ev.location].filter(Boolean).join(', ')
    };
}

/* =========================================================================
   CUSTOMER FILLS IN THEIR OWN DETAILS
   From a quote, Max texts the customer a link (/details?t=<detailsToken>).
   They fill in name, business, email, billing CC, phone, address, event,
   date and venue. It lands straight on the quote and in Customers, and the
   office gets an email. Sends nothing to the customer.
   ========================================================================= */
const DETAIL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emailList = (v) =>
    String(v || '')
        .split(/[,;\s]+/)
        .map((e) => e.trim())
        .filter((e) => DETAIL_EMAIL_RE.test(e))
        .slice(0, 10)
        .join(', ');

/*  Name, email and phone are needed before a customer can accept or pay. */
const hasPayDetails = (c) =>
    !!(c && String(c.name || '').trim() && DETAIL_EMAIL_RE.test(String(c.email || '').trim()) && String(c.phone || '').trim());
const brisbaneTodayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: MSG_TZ }).format(new Date());

/*  Sends the gear list to "Gear list to" and (for automatic sends) the pick
    list link to the office. reason: 'manual' | 'accepted' | 'deposit' | '3days' | 'today'. */
async function sendGearListEmail(ref, q, reason, testTo, parts = { gear: true, staff: true }) {
    let token = q.crewToken;
    if (!token) {
        token = crypto.randomBytes(16).toString('hex');
        await ref.update({ crewToken: token });
    }
    const c = q.customer || {};
    const ev = c.eventName || 'your event';
    const when = c.eventDate || (q.hire && q.hire.startDate) || '';
    const lead = (testTo ? '[TEST] ' : '') + (reason === '3days' ? '3 days to go - ' : reason === 'today' ? 'Today - ' : '');
    const to = testTo || emailList(c.gearEmails);
    let r = { sent: false, reason: 'no gear list emails' };
    if (to && parts.gear !== false) {
        r = await sendMessageEmail(
            {
                subject: lead + 'Gear list - ' + ev + (when ? ' (' + when + ')' : ''),
                body:
                    'Hi,\n\n' +
                    (reason === 'today' ? 'See you today! ' : reason === '3days' ? 'Your event is 3 days away. ' : '') +
                    'Here is the itemised gear list for ' +
                    ev +
                    (when ? ' on ' + when : '') +
                    ': the exact make and model of everything SoundzGood Whitsundays is supplying - amps, in-ears, microphones, cables and more. Please check it against your requirements and let us know if anything is missing or needs changing.\n\nThanks,\nMax\nSoundzGood Whitsundays - 0422 393 022'
            },
            {},
            {
                to,
                actions: [
                    {
                        label: 'View the gear list',
                        url: SITE_URL + '/picklist?t=' + (await gearLinkToken(ref, q)) + '&v=gear',
                        primary: true
                    }
                ]
            }
        );
        if (r.sent && !testTo) await ref.update({ gearListSentAt: FieldValue.serverTimestamp(), gearListSentTo: to });
    }
    // staff copy - the full pick list with Packed / Returned ticks (office + the crew on the job)
    if (reason !== 'manual' && parts.staff !== false) {
        const crewTo = emailList(
            (q.crewAssigned || [])
                .map((x) => x.email)
                .filter(Boolean)
                .join(', ')
        );
        await sendMessageEmail(
            {
                subject: lead + 'Pick list - ' + ev + (when ? ' (' + when + ')' : '') + ' - ' + (q.invoiceNumber || q.number || ''),
                body:
                    (reason === 'deposit' ? 'The deposit is in, so this job is booked. ' : '') +
                    'Here is the pick list for ' +
                    ev +
                    (when ? ' on ' + when : '') +
                    '.' +
                    (to
                        ? '\n\nThe gear list also went to: ' + to
                        : '\n\nNo "Gear list to" emails on this job, so the band / crew were not sent anything.')
            },
            {},
            {
                to: testTo || [process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au'].concat(crewTo ? [crewTo] : []).join(', '),
                actions: [{ label: 'Open the pick list', url: SITE_URL + '/picklist?t=' + token, primary: true }]
            }
        );
    }
    return { ...r, to };
}

/*  Once per job, the moment the customer ACCEPTS the quote: the gear list goes to
    their team (Max, 18 Nov 2026). The office pick list still waits for the booking. */
async function autoGearOnAccept(id) {
    try {
        const ref = db.collection('quotes').doc(String(id || ''));
        const snap = await ref.get();
        if (!snap.exists) return;
        const q = snap.data();
        if (q.gearAutoAcceptAt || !emailList((q.customer || {}).gearEmails)) return;
        await ref.update({ gearAutoAcceptAt: FieldValue.serverTimestamp() }); // claim it first - no double send
        await sendGearListEmail(ref, { ...q }, 'accepted', undefined, { gear: true, staff: false });
    } catch (err) {
        logger.error('gear list on accept', { id, err: err && err.message });
    }
}

/*  Once per job, the moment the deposit (or full payment) lands: the office pick list,
    plus the team's gear list if it didn't already go out when the quote was accepted. */
async function autoGearOnDeposit(id) {
    try {
        const ref = db.collection('quotes').doc(String(id || ''));
        const snap = await ref.get();
        if (!snap.exists) return;
        const q = snap.data();
        if (!pickReady(q) || q.gearAutoDepositAt) return;
        // the event is already over (e.g. marked paid weeks later): no gear / pick list email
        const end = (q.hire && (q.hire.endDate || q.hire.startDate)) || '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(end) && end < brisbaneTodayISO()) return;
        await ref.update({ gearAutoDepositAt: FieldValue.serverTimestamp() }); // claim it first - a webhook retry can't double-send
        await sendGearListEmail(ref, { ...q }, 'deposit', undefined, { gear: !q.gearAutoAcceptAt, staff: true });
    } catch (err) {
        logger.error('gear list on deposit', { id, err: err && err.message });
    }
}
const prettyDay = (iso) => {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d))
        .toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
        .replace(/,/g, '');
};
/*  Hours played, across midnight ("22:00"-"03:00" = 5). Any venue - the
    5pm-2:30am trading window only checks what DJs type in. */
function gigHours(start, finish) {
    const p = (t) => {
        const r = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
        return r ? +r[1] * 60 + +r[2] : null;
    };
    const a = p(start);
    let b = p(finish);
    if (a == null || b == null) return 0;
    if (b <= a) b += 1440;
    if (b - a > 720) return 0; // over 12 hours - a typo
    return Math.round((b - a) / 15) / 4;
}

/*  The DJ on a gig, for quotes made before gigDj was stored */
async function gigDjFor(bookingId) {
    try {
        const b = await db.collection('talentSchedule').doc(String(bookingId)).get();
        if (!b.exists) return null;
        const x = b.data();
        const t = await db.collection('talent').doc(x.slug).get();
        const slugName = String(x.slug || '')
            .split('-')
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
        const start = x.actualStart || x.start || '21:30',
            finish = x.actualFinish || (x.actualStart ? '' : x.finish) || plus4h(start);
        const r = await db.collection('actRates').doc(x.slug).get();
        return {
            name: (t.exists && t.data().name) || slugName,
            photo: (t.exists && t.data().photo) || 'data/images/talent/' + x.slug + '.jpg',
            start,
            finish,
            hours: gigHours(start, finish),
            confirmed: !!x.timesConfirmedAt,
            venue: x.venue || '',
            bio: String((t.exists && t.data().bio) || '').slice(0, 1200),
            styles: r.exists && Array.isArray(r.data().styles) ? r.data().styles.slice(0, 16) : []
        };
    } catch (e) {
        return null;
    }
}

/*  A start time + 4 hours ("21:30" -> "01:30") - a gig with no finish set
    is quoted at the usual 4 hours.                 */
function plus4h(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    if (!m) return '01:30';
    const v = (+m[1] * 60 + +m[2] + 240) % 1440;
    return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

module.exports = {
    DETAIL_EMAIL_RE,
    FEE_FIXED_CENTS,
    FEE_PERCENT,
    GST_RATE,
    MSG_TZ,
    QUOTE_DEPOSIT_PCT,
    SITE_URL,
    SMTP_PASS,
    SMTP_USER,
    SPONSOR_NOTE,
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
    UNSUB_URL,
    addDaysISO,
    autoGearOnDeposit,
    bookingIsPaid,
    bookingReference,
    brisbaneMinutesNow,
    brisbaneToday,
    brisbaneTodayISO,
    callerIp,
    categoryRef,
    checkBayCount,
    confirmAndNotify,
    confirmBooking,
    db,
    emailList,
    ensureVendorInvoice,
    feeBreakdown,
    gearLinkToken,
    getStripe,
    gigDjFor,
    gigHours,
    hasPayDetails,
    invoiceEmailPaused,
    invoiceNo,
    limitIp,
    listOpen,
    loadQuoteInventory,
    nextInvoiceNumber,
    ownDiscount,
    pickReady,
    plus4h,
    prettyDay,
    priceFor,
    quoteGrandTotal,
    quoteMoney,
    rateLimit,
    recordSend,
    refreshMessageCounts,
    requireAdmin,
    requireAuth,
    sanitizeQuote,
    sendGearListEmail,
    autoGearOnAccept,
    sendMessageTo,
    sendVendorInvoice,
    siteRef,
    siteTypeFor,
    sponsorLink,
    sponsorValues,
    stripeFields
};
