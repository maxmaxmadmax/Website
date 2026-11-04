/* SOUNDZGOOD SERVER - quotes
   Quotes, invoices, the pick list and quote checkout.
   Helpers shared with other features come from ../shared.js. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { FieldValue } = require('firebase-admin/firestore');
const { sendQuoteLinkEmail } = require('../lib/quote-doc-email');
const { sendLeadEmail } = require('../lib/lead-email');
const {
    QUOTE_DEPOSIT_PCT,
    SITE_URL,
    SMTP_PASS,
    SMTP_USER,
    STRIPE_SECRET_KEY,
    addDaysISO,
    autoGearOnDeposit,
    brisbaneToday,
    brisbaneTodayISO,
    db,
    gearLinkToken,
    getStripe,
    gigDjFor,
    hasPayDetails,
    invoiceNo,
    limitIp,
    listOpen,
    loadQuoteInventory,
    nextInvoiceNumber,
    quoteGrandTotal,
    quoteMoney,
    requireAdmin,
    sanitizeQuote
} = require('../shared');

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

// draft = Estimate, approved = Quote, sent = Quote emailed,
// invoiced = accepted -> Invoice, paid = Paid
const QUOTE_DOC_STATES = ['draft', 'approved', 'sent', 'accepted', 'declined', 'invoiced', 'paid', 'cancelled'];

exports.adminSaveQuote = onCall(async (request) => {
    requireAdmin(request);
    const { id, quote } = request.data || {};
    const clean = sanitizeQuote(quote || {});
    const money = quoteMoney(clean);

    if (id) {
        const ref = db.collection('quotes').doc(String(id));
        const snap = await ref.get();
        if (!snap.exists) throw new HttpsError('not-found', 'No such quote.');
        // made into a template: unlink it from its gig, so rebuilding the gig can't overwrite it
        const unlink = clean.isTemplate
            ? {
                  gigBookingId: FieldValue.delete(),
                  pubKey: FieldValue.delete(),
                  pubNight: FieldValue.delete(),
                  pubBookings: FieldValue.delete()
              }
            : {};
        clean.customer.gearEmails = (snap.data().customer || {}).gearEmails || ''; // set by the customer on their quote page
        await ref.update({ ...clean, ...money, ...unlink, updatedAt: FieldValue.serverTimestamp() });
        return { id: String(id), ...money };
    }

    // A new quote gets a sequential number + an unguessable token.
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
        // made in admin = a QUOTE straight away; only the website bot makes estimates
        number,
        token,
        status: 'approved',
        approvedAt: FieldValue.serverTimestamp(),
        ...clean,
        ...money,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        createdBy: (request.auth.token && request.auth.token.email) || request.auth.uid
    });
    return { id: ref.id, number, token, ...money };
});

exports.adminSetQuoteStatus = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    requireAdmin(request);
    const { id, status } = request.data || {};
    if (!QUOTE_DOC_STATES.includes(status)) throw new HttpsError('invalid-argument', 'Bad status.');

    const ref = db.collection('quotes').doc(String(id || ''));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'No such quote.');

    const update = { status, updatedAt: FieldValue.serverTimestamp() };

    // UNDO ACCEPT: back to "sent" and clear who accepted and
    // how they chose to pay. Never when card money has been taken.
    if (request.data.undoAccept === true) {
        if (status !== 'sent') throw new HttpsError('invalid-argument', 'Undo accept goes back to sent.');
        if ((snap.data().amountPaidCents || 0) > 0) {
            throw new HttpsError('failed-precondition', 'A payment has been taken on this quote - refund it in Stripe first.');
        }
        Object.assign(update, {
            acceptedName: FieldValue.delete(),
            acceptedAt: FieldValue.delete(),
            paymentStatus: FieldValue.delete(),
            paymentMethod: FieldValue.delete(),
            kind: 'quote',
            invoiceNumber: FieldValue.delete(),
            invoicedAt: FieldValue.delete()
        });
    }

    // "Mark accepted" in admin = accepted AND turned into an invoice
    if (status === 'accepted') {
        update.status = 'invoiced';
        update.acceptedAt = FieldValue.serverTimestamp();
    }
    const stamp = {
        approved: 'approvedAt',
        sent: 'sentAt',
        accepted: 'acceptedAt',
        declined: 'declinedAt',
        invoiced: 'invoicedAt',
        paid: 'paidAt',
        cancelled: 'cancelledAt'
    };
    if (stamp[status]) update[stamp[status]] = FieldValue.serverTimestamp();

    if (update.status === 'invoiced') {
        update.kind = 'invoice';
        update.invoicedAt = FieldValue.serverTimestamp();
        if (!snap.data().invoiceNumber) update.invoiceNumber = invoiceNo((await nextInvoiceNumber()).n);
    }

    // MARK PAID - money came in another way (bank transfer, cash).
    // A paid job is always a tax invoice, and paid in full.
    if (update.status === 'paid') {
        const q = snap.data();
        update.kind = 'invoice';
        if (!q.invoiceNumber) {
            update.invoiceNumber = invoiceNo((await nextInvoiceNumber()).n);
            update.invoicedAt = FieldValue.serverTimestamp();
        }
        update.paymentStatus = 'paid';
        update.paymentMethod = q.paymentMethod || 'bank';
        update.amountPaidCents = Math.max(q.amountPaidCents || 0, quoteGrandTotal(q));
    }

    await ref.update(update);
    if (update.status === 'paid') await autoGearOnDeposit(ref.id); // paid in full by bank / cash - gear list out
    return { ok: true, invoiceNumber: update.invoiceNumber || snap.data().invoiceNumber || '' };
});

/*  ARCHIVE / RESTORE / DELETE a job from the Sales Pipeline.
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
        await ref.update({
            status: 'cancelled',
            archivedFrom: q.status || 'draft',
            cancelledAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            ...(request.data.jobCancelled === true ? { jobCancelled: true } : {})
        }); // a called-off job stays in the pipeline
    } else {
        const back = QUOTE_DOC_STATES.includes(q.archivedFrom) && q.archivedFrom !== 'cancelled' ? q.archivedFrom : 'draft';
        await ref.update({
            status: back,
            archivedFrom: FieldValue.delete(),
            jobCancelled: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp()
        });
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
    // ARCHIVED (cancelled / declined) jobs can be deleted even with an invoice
    // or payment on them, when the admin typed DELETE to confirm (force)
    const archived = q.status === 'cancelled' || q.status === 'declined';
    const ok =
        (['draft', 'approved', 'sent', 'declined', 'cancelled'].includes(q.status) &&
            !q.invoiceNumber &&
            !((q.amountPaidCents || 0) > 0) &&
            q.kind !== 'invoice') ||
        (archived && force === true);
    if (!ok) throw new HttpsError('failed-precondition', "Invoices and paid jobs can't be deleted - archive it instead.");
    await ref.delete();
    logger.info('Quote deleted by admin', {
        id,
        number: q.number || '',
        by: (request.auth.token && request.auth.token.email) || request.auth.uid
    });
    return { ok: true };
});

/* the gear on a job, one entry per item (items + included kit added up).
   KEEP IN STEP with pickItems() in js/admin/stock.js.                          */
function pickItems(lines) {
    const out = [];
    const byKey = {};
    (lines || []).forEach((l) => {
        if (!l || !['item', 'kit', 'custom'].includes(l.type)) return;
        if (l.resType || l.noPick) return; // crew & vehicles (and pub DJ lines) are not gear to pack
        const qty = Math.max(0, Math.round(Number(l.qty) || 0));
        if (!qty) return;
        const name = String(l.name || '')
            .replace(/ \(included\)$/i, '')
            .trim();
        const key = l.itemId ? 'i:' + l.itemId : 'n:' + name.toLowerCase();
        if (!byKey[key]) {
            byKey[key] = { itemId: l.itemId || '', name, qty: 0, category: l.category || '' };
            out.push(byKey[key]);
        }
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
    const deposit = Math.round(((q.totalCents || 0) * QUOTE_DEPOSIT_PCT) / 100);
    const update = {
        status: 'invoiced',
        kind: 'invoice',
        paymentStatus: 'deposit',
        paymentMethod: q.paymentMethod || 'bank',
        amountPaidCents: Math.max(q.amountPaidCents || 0, deposit),
        acceptedAt: q.acceptedAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
    };
    if (!q.invoiceNumber) {
        update.invoiceNumber = invoiceNo((await nextInvoiceNumber()).n);
        update.invoicedAt = FieldValue.serverTimestamp();
    }
    if (!q.crewToken) update.crewToken = crypto.randomBytes(16).toString('hex');
    await ref.update(update);
    await autoGearOnDeposit(ref.id); // gear list out once the deposit is in
    return { ok: true };
});

/* ADMIN - CONFIRM A JOB, PAY LATER: the job goes ahead
   before any money - it becomes an unpaid invoice, the pick list unlocks
   and goes to the office + crew (and the gear list to the band) like a
   deposit would. Payment reminders still work. undo: true takes it back. */
exports.adminConfirmJob = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    requireAdmin(request);
    const { id, undo } = request.data || {};
    const ref = db.collection('quotes').doc(String(id || ''));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'No such quote.');
    const q = snap.data();
    if (undo === true) {
        await ref.update({ jobConfirmedAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
        return { ok: true };
    }
    if (!['approved', 'sent', 'accepted', 'invoiced'].includes(q.status))
        throw new HttpsError('failed-precondition', 'Only quotes and unpaid invoices can be confirmed this way.');
    const update = {
        jobConfirmedAt: FieldValue.serverTimestamp(),
        status: 'invoiced',
        kind: 'invoice',
        updatedAt: FieldValue.serverTimestamp()
    };
    if (!q.invoiceNumber) {
        update.invoiceNumber = invoiceNo((await nextInvoiceNumber()).n);
        update.invoicedAt = FieldValue.serverTimestamp();
    }
    if (!q.crewToken) update.crewToken = crypto.randomBytes(16).toString('hex');
    await ref.update(update);
    await autoGearOnDeposit(ref.id); // pick list out now, same as a deposit
    return { ok: true };
});

/* AUTO-ACCEPT FOR ACCOUNT VENUES (Grand View): a venue with
   autoAcceptDays set has its gig quotes accepted that many days before the
   gig - same as Confirm job (unpaid invoice, pick list unlocks), no deposit.
   Nothing is emailed to the venue. 6:30am daily, before the 9:35 lists.  */
exports.autoAcceptGigQuotes = onSchedule({ schedule: '30 6 * * *', timeZone: 'Australia/Brisbane', timeoutSeconds: 300 }, async () => {
    const today = brisbaneTodayISO();
    const core = (x) =>
        String(x || '')
            .toLowerCase()
            .split(',')[0]
            .replace(/\b(hotel|bar|the|pub|tavern)\b/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    const venues = (await db.collection('venues').get()).docs
        .map((d) => d.data())
        .filter((v) => (v.autoAcceptDays || 0) > 0 && core(v.name));
    if (!venues.length) return;
    const maxDays = Math.max(...venues.map((v) => v.autoAcceptDays));
    const gigs = await db.collection('talentSchedule').where('date', '>=', today).where('date', '<=', addDaysISO(today, maxDays)).get();
    for (const g of gigs.docs) {
        const b = g.data();
        if ((b.status || 'confirmed') !== 'confirmed') continue;
        const v = venues.find((x) => core(b.venue).includes(core(x.name)) || core(x.name).includes(core(b.venue)));
        if (!v || b.date > addDaysISO(today, v.autoAcceptDays)) continue;
        const qs = await db.collection('quotes').where('gigBookingId', '==', g.id).get();
        for (const qd of qs.docs) {
            const q = qd.data();
            if (q.isTemplate || !['approved', 'sent'].includes(q.status)) continue;
            try {
                const update = {
                    status: 'invoiced',
                    kind: 'invoice',
                    acceptedAt: FieldValue.serverTimestamp(),
                    autoAcceptedAt: FieldValue.serverTimestamp(),
                    jobConfirmedAt: FieldValue.serverTimestamp(),
                    updatedAt: FieldValue.serverTimestamp()
                };
                if (!q.invoiceNumber) {
                    update.invoiceNumber = invoiceNo((await nextInvoiceNumber()).n);
                    update.invoicedAt = FieldValue.serverTimestamp();
                }
                if (!q.crewToken) update.crewToken = crypto.randomBytes(16).toString('hex');
                await qd.ref.update(update);
                logger.info('auto-accepted gig quote', { id: qd.id, gig: g.id });
            } catch (err) {
                logger.error('auto-accept gig quote', { id: qd.id, err: err && err.message });
            }
        }
    }
});

/* ADMIN - UNDO A DEPOSIT / PAYMENT that was marked by hand:
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
        status: 'sent',
        kind: 'quote',
        paymentStatus: FieldValue.delete(),
        paymentMethod: FieldValue.delete(),
        amountPaidCents: 0,
        acceptedName: FieldValue.delete(),
        acceptedAt: FieldValue.delete(),
        invoiceNumber: FieldValue.delete(),
        invoicedAt: FieldValue.delete(),
        paidAt: FieldValue.delete(),
        crewToken: FieldValue.delete(),
        pickTicks: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp()
    });
    logger.info('Payment undone by admin', { id, number: q.number || '' });
    return { ok: true };
});

/*  ADMIN - the gear list link to text the band */
exports.adminGearListLink = onCall(async (request) => {
    requireAdmin(request);
    const ref = db.collection('quotes').doc(String((request.data || {}).id || ''));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Save the quote first.');
    const q = snap.data();
    if (!listOpen(q)) throw new HttpsError('failed-precondition', 'This quote is cancelled.');
    return { url: SITE_URL + '/picklist?t=' + (await gearLinkToken(ref, q)) + '&v=gear' };
});

/* ADMIN - the crew link for a booked job (makes one the first time) */
exports.adminPickListLink = onCall(async (request) => {
    requireAdmin(request);
    const { id } = request.data || {};
    const ref = db.collection('quotes').doc(String(id || ''));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'No such quote.');
    const q = snap.data();
    if (!listOpen(q)) throw new HttpsError('failed-precondition', 'This quote is cancelled.');
    let token = q.crewToken;
    if (!token) {
        token = crypto.randomBytes(16).toString('hex');
        await ref.update({ crewToken: token });
    }
    return { url: SITE_URL + '/picklist?t=' + token };
});

/* PUBLIC (crew link) - the pick list: job details and gear, NO prices */
exports.getPickList = onCall(async (request) => {
    await limitIp(request, 'tok', 120, 60);
    const tok = String((request.data || {}).token || '');
    if (!/^[a-f0-9]{20,40}$/.test(tok)) throw new HttpsError('invalid-argument', 'That link is not valid.');
    const byGear = await db.collection('quotes').where('gearToken', '==', tok).limit(1).get();
    const doc = byGear.empty ? await quoteByCrewToken(tok) : byGear.docs[0];
    const q = doc.data();
    const gearOnly = !byGear.empty; // the shared gear list link - read-only, always
    const gear = gearOnly || (request.data || {}).gear === true;
    // crew already on the job get the full pick list even before payment
    if (!listOpen(q)) throw new HttpsError('failed-precondition', 'This list is no longer available.');
    // categories from inventory, so the gear can be grouped
    const inv = await loadQuoteInventory();
    const cat = {};
    inv.forEach((it) => {
        cat[it.id] = it.isSystem ? (it.bundleType === 'package' ? 'Packages' : 'Kits') : it.category || '';
    }); // kits & packages get their own groups
    // each item's photo from Inventory - crew tap the item to see what it looks like
    const photo = {};
    inv.forEach((it) => {
        if (it.photoUrl) photo[it.id] = String(it.photoUrl);
    });
    const c = q.customer || {};
    const items = pickItems(q.lines).map((p) => ({
        key: pickKey(p),
        name: p.name,
        qty: p.qty,
        category: cat[p.itemId] || p.category || 'Other'
    }));
    const crew = (q.lines || [])
        .filter((l) => l.type === 'labour')
        .map((l) => ({
            name: l.name || '',
            note: String(l.description || '')
                .replace(/@.*$/, '')
                .trim()
        }))
        // operators and vehicles booked on the job
        .concat(
            (q.lines || [])
                .filter((l) => l.resType)
                .map((l) => ({
                    name: (l.qty > 1 ? l.qty + ' × ' : '') + (l.name || ''),
                    note: l.resType === 'staff' ? (l.days || 1) + ' day' + ((l.days || 1) === 1 ? '' : 's') : 'vehicle'
                }))
        );
    const del = (q.lines || []).find((l) => l.type === 'delivery');
    /*  LAID OUT LIKE THE QUOTE: every gear line in quote
      order; "sub" = an included part that sits under the item above it.
      Each line has its own tick (key), itemKey reads ticks saved before. */
    const rows = [];
    (q.lines || []).forEach((l, idx) => {
        if (!l || !['item', 'kit', 'custom'].includes(l.type) || l.resType || l.noPick) return;
        const qty = Math.max(0, Math.round(Number(l.qty) || 0));
        if (!qty) return;
        const name = String(l.name || '')
            .replace(/ \(included\)$/i, '')
            .trim();
        const itemKey = pickKey({ itemId: l.itemId || '', name });
        rows.push({
            key: itemKey.slice(0, 110) + '_L' + idx,
            itemKey,
            name,
            qty,
            photo: photo[l.itemId] || '',
            sub: l.type === 'kit',
            custom: !l.itemId,
            category: l.category || cat[l.itemId] || '',
            sysOrder: l.sysOrder != null ? l.sysOrder : null
        });
    });
    /*  THE BRIEF: a DJ gig's gear list also carries what
      the DJ needs to know - set times, the booking notes (the venue's
      message), the venue's own notes, address and contact.            */
    let brief = null;
    if (q.gigBookingId) {
        const bs = await db.collection('talentSchedule').doc(String(q.gigBookingId)).get();
        const b = bs.exists ? bs.data() : {};
        const vs = await db.collection('venues').get();
        const core = (x) =>
            String(x || '')
                .toLowerCase()
                .split(',')[0]
                .replace(/\b(hotel|bar|the|pub|tavern)\b/g, '')
                .replace(/[^a-z0-9]+/g, ' ')
                .trim();
        const vd =
            vs.docs
                .map((d) => d.data())
                .find((v) => core(v.name) && (core(b.venue).includes(core(v.name)) || core(v.name).includes(core(b.venue)))) || {};
        const r = b.slug ? await db.collection('actRates').doc(b.slug).get() : null;
        const gd = q.gigDj || {};
        brief = {
            dj: gd.name || '',
            start: b.actualStart || b.start || gd.start || '',
            finish: b.actualFinish || b.finish || gd.finish || '',
            notes: String(b.notes || '').slice(0, 3000),
            venueNotes: String(vd.notes || '').slice(0, 1000),
            address: String(vd.address || '').slice(0, 200),
            venueContact: [vd.contactName, vd.phone].filter(Boolean).join(' · ').slice(0, 160),
            deck: String((r && r.exists && r.data().deck) || '').slice(0, 300)
        };
    }
    return {
        brief,
        rows,
        // EXTRA GEAR added by the crew on the pick list - not on the quote, no price
        extras: gear ? [] : (q.pickExtras || []).map((x) => ({ key: x.key, name: x.name, qty: x.qty, photo: x.photo || '' })),
        inventory: gear
            ? []
            : inv
                  .filter((it) => it.name && it.active !== false && !it.isSystem)
                  .map((it) => ({ id: it.id, name: String(it.name).slice(0, 120), photo: it.photoUrl || '' }))
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .slice(0, 800),
        number: q.invoiceNumber || q.number || '',
        eventName: c.eventName || '',
        eventDate: c.eventDate || '',
        hire: {
            startDate: (q.hire && q.hire.startDate) || '',
            endDate: (q.hire && q.hire.endDate) || '',
            days: (q.hire && q.hire.days) || 1
        },
        town: (q.delivery && q.delivery.town) || '',
        delivery: del ? del.name || 'Delivery & pickup' : 'Customer pickup',
        contact: {
            name: c.name || '',
            business: c.business || '',
            phone: gearOnly ? '' : c.phone || '',
            address: gearOnly ? '' : c.address || ''
        },
        // from the customer details form: where the gear goes, when it starts, what to know
        venue: c.eventVenue || '',
        times: {
            soundcheck: c.soundcheckTime || '',
            start: c.eventStartTime || q.botStart || '',
            finish: c.eventEndTime || q.botFinish || ''
        },
        customerNotes: gearOnly ? '' : c.customerNotes || '',
        dayContact: c.dayContact || '',
        assigned: (q.crewAssigned || []).map((x) => ({ name: x.name || '', phone: gearOnly ? '' : x.phone || '' })), // staff on the job
        crew,
        notes: gearOnly ? '' : q.crewNotes || '',
        items,
        ticks: gearOnly ? {} : q.pickTicks || {},
        paidInFull: gearOnly ? false : q.paymentStatus === 'paid' || q.status === 'paid',
        gearOnly
    };
});

/* PUBLIC (crew link) - tick / untick Packed or Returned on one item */
exports.setPickTick = onCall(async (request) => {
    await limitIp(request, 'tok', 120, 60);
    const d = request.data || {};
    const field = d.field === 'returned' ? 'returned' : d.field === 'packed' ? 'packed' : '';
    const key = String(d.key || '');
    if (!field || !/^[a-zA-Z0-9_-]{1,120}$/.test(key)) throw new HttpsError('invalid-argument', 'Bad tick.');
    const doc = await quoteByCrewToken(d.token);
    const tq = doc.data();
    if (!listOpen(tq)) throw new HttpsError('failed-precondition', 'This pick list is not available.');
    await doc.ref.update({
        ['pickTicks.' + key + '.' + field]: d.value === true,
        pickUpdatedAt: FieldValue.serverTimestamp()
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
    if (q.isTemplate) throw new HttpsError('failed-precondition', "This is a template - it can't be sent.");
    const link = SITE_URL + '/quote?t=' + q.token;
    const mail = await sendQuoteLinkEmail(q, link);

    const update = { updatedAt: FieldValue.serverTimestamp() };
    if (mail.sent && q.status === 'approved') {
        update.status = 'sent';
        update.sentAt = FieldValue.serverTimestamp();
    }
    // EMAIL RECORD: when it last went out, to whom, how many times
    if (mail.sent) {
        update.lastEmailedAt = FieldValue.serverTimestamp();
        update.lastEmailedTo = String(q.customer.email || '') + (q.customer.ccEmail ? ' (cc ' + q.customer.ccEmail + ')' : '');
        update.emailCount = FieldValue.increment(1);
    }
    await ref.update(update);
    return mail;
}); // deposit to secure a booking

exports.getQuote = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
    await limitIp(request, 'tok', 120, 60);
    const token = String((request.data || {}).token || '').trim();
    if (!/^[a-f0-9]{20,40}$/.test(token)) throw new HttpsError('invalid-argument', 'That link is not valid.');

    const snap = await db.collection('quotes').where('token', '==', token).limit(1).get();
    if (snap.empty) throw new HttpsError('not-found', 'That link is not valid.');
    const q = snap.docs[0].data();
    if (q.status === 'cancelled') throw new HttpsError('failed-precondition', 'This quote is no longer available.');

    const secs = (t) => (t && t.seconds != null ? t.seconds : null);

    // included / required items are grouped by category on the customer's copy,
    // the same as in the quote builder
    const lines = (q.lines || []).map((l) => {
        const o = { ...l };
        delete o.baseCents;
        delete o.resourceId;
        delete o.sysOrder;
        delete o.removedParts;
        if (o.type === 'labour' && o.description) o.description = String(o.description).replace(/@.*$/, '').trim();
        return o;
    });
    const kitIds = [...new Set(lines.filter((l) => l.itemId).map((l) => l.itemId))]; // all gear lines: used for the Audio / Lighting / Staging breakdown too
    if (kitIds.length) {
        try {
            const docs = await db.getAll(...kitIds.map((id) => db.collection('inventory').doc(id)));
            const cat = {};
            docs.forEach((d) => {
                if (d.exists) cat[d.id] = String(d.data().category || '');
            });
            lines.forEach((l) => {
                if (l.itemId) l.category = cat[l.itemId] || '';
            });
        } catch (e) {
            logger.warn('getQuote categories', e);
        }
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
        posterUrl: q.posterUrl || '',
        needsDetails: !hasPayDetails(q.customer), // the page asks for name / email / phone before paying
        subtotalCents: q.subtotalCents || 0,
        discountCents: q.discountCents || 0,
        gstCents: q.gstCents || 0,
        totalCents: q.totalCents || 0,
        lateFeeCents: q.lateFeeCents || 0, // late payment charges (on top of the total)
        lateFees: Array.isArray(q.lateFees) ? q.lateFees.map((x) => ({ cents: x.cents || 0, date: x.date || '' })) : [],
        acceptedName: q.acceptedName || '',
        acceptedAt: secs(q.acceptedAt),
        createdAt: secs(q.createdAt),
        paymentStatus: q.paymentStatus || '', // '' | bank | deposit | paid
        bankPlan: q.bankPlan || '', // bank payers: 'deposit' | 'full'
        payFull: q.payFull === true, // "pay in full up front" - no deposit option
        gigDj: q.gigDj || (q.gigBookingId ? await gigDjFor(q.gigBookingId) : null), // DJ gig quotes: who played + their set
        paymentMethod: q.paymentMethod || '',
        amountPaidCents: q.amountPaidCents || 0,
        depositPct: QUOTE_DEPOSIT_PCT,
        cardOn: !!STRIPE_SECRET_KEY.value()
    };
});

/*  PUBLIC - the customer accepts, by token. Idempotent once accepted.     */
exports.acceptQuote = onCall(async (request) => {
    await limitIp(request, 'tok', 120, 60);
    const data = request.data || {};
    const token = String(data.token || '').trim();
    const name = String(data.name || '')
        .trim()
        .slice(0, 120);
    if (!/^[a-f0-9]{20,40}$/.test(token)) throw new HttpsError('invalid-argument', 'That link is not valid.');

    const snap = await db.collection('quotes').where('token', '==', token).limit(1).get();
    if (snap.empty) throw new HttpsError('not-found', 'That link is not valid.');
    const doc = snap.docs[0];
    const q = doc.data();

    if (q.status === 'accepted' || q.kind === 'invoice') return { ok: true, already: true };
    if (!['approved', 'sent'].includes(q.status)) {
        throw new HttpsError('failed-precondition', 'This quote can no longer be accepted.');
    }
    if (!hasPayDetails(q.customer)) throw new HttpsError('failed-precondition', 'Please fill in your details first.');

    const bank = data.method === 'bank';
    // ACCEPT = INVOICE: the quote becomes a tax invoice straight away
    const inv = q.invoiceNumber || invoiceNo((await nextInvoiceNumber()).n);
    await doc.ref.update({
        status: 'invoiced',
        kind: 'invoice',
        invoiceNumber: inv,
        invoicedAt: FieldValue.serverTimestamp(),
        acceptedName: name,
        acceptedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        // BANK IN FULL: a bank payer picks deposit or the whole amount
        ...(bank
            ? { paymentMethod: 'bank', paymentStatus: 'bank', bankPlan: data.plan === 'full' || q.payFull === true ? 'full' : 'deposit' }
            : {})
    });
    return { ok: true };
});

/* -------------------------------------------------------------------------
   quoteCheckout  PUBLIC
   The customer accepts their quote and pays by card through Stripe -
   either the 50% deposit or the full amount (or the balance, once the
   deposit is in). The quote is only marked accepted / paid when Stripe's
   webhook confirms the money, never on the strength of this call.
   ------------------------------------------------------------------------- */
exports.quoteCheckout = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
    await limitIp(request, 'tok', 120, 60);
    const data = request.data || {};
    const token = String(data.token || '').trim();
    const name = String(data.name || '')
        .trim()
        .slice(0, 120);
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
    if (!hasPayDetails(q.customer)) throw new HttpsError('failed-precondition', 'Please fill in your details first.');

    const total = Math.max(0, Math.round(quoteGrandTotal(q))); // + any late payment charges
    const paid = Math.max(0, Math.round(q.amountPaidCents || 0));
    const owing = total - paid;
    // PAY IN FULL WITHIN 7 DAYS: the balance is due 7 days
    // before the event, so from then on there is no deposit option.
    const dueDay = addDaysISO(q.hire && q.hire.startDate, -7);
    const fullOnly = (!!dueDay && dueDay <= brisbaneToday()) || q.payFull === true; // or "pay in full up front"
    let amount = option === 'full' || paid > 0 || fullOnly ? owing : Math.round((total * QUOTE_DEPOSIT_PCT) / 100);
    if (amount < 50) throw new HttpsError('failed-precondition', 'Nothing left to pay on this quote.');
    const label = paid > 0 ? 'balance' : option === 'full' || fullOnly ? 'payment in full' : QUOTE_DEPOSIT_PCT + '% deposit';

    const stripe = getStripe();
    const back = SITE_URL + '/quote?t=' + token;
    const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: (q.customer && q.customer.email) || undefined,
        client_reference_id: 'quote:' + doc.id,
        metadata: { quoteId: doc.id, payOption: label, acceptedName: name },
        line_items: [
            {
                quantity: 1,
                price_data: {
                    currency: 'aud',
                    unit_amount: amount,
                    product_data: {
                        name: 'Quote ' + (q.number || '') + ' - ' + label,
                        description: ((q.customer && q.customer.eventName) || 'SoundzGood Whitsundays booking') + ' (incl GST)'
                    }
                }
            }
        ],
        success_url: back + '&paid=1',
        cancel_url: back
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
    const to = String(d.to || '')
        .trim()
        .slice(0, 200);
    const subject = String(d.subject || '')
        .trim()
        .slice(0, 200);
    const body = String(d.body || '').slice(0, 20000);
    const leadId = String(d.leadId || '')
        .trim()
        .slice(0, 60);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpsError('invalid-argument', 'That email does not look right.');
    if (!subject || !body.trim()) throw new HttpsError('invalid-argument', 'Add a subject and a message.');

    const mail = await sendLeadEmail({ to, subject, body });
    if (!mail.sent) {
        throw new HttpsError(
            'internal',
            mail.reason === 'no-smtp' ? 'Email is not configured yet.' : 'Could not send: ' + (mail.error || mail.reason || 'unknown')
        );
    }

    if (leadId) {
        try {
            await db
                .collection('leads')
                .doc(leadId)
                .set(
                    {
                        lastContacted: new Date().toISOString().slice(0, 10),
                        emailedAt: FieldValue.serverTimestamp(),
                        updatedAt: Date.now()
                    },
                    { merge: true }
                );
        } catch (e) {
            logger.warn('lead email sent but stamp failed', { leadId, message: e && e.message });
        }
    }
    return { ok: true };
});

/* =========================================================================
   EXTRA GEAR ON THE PICK LIST - the crew add gear that
   isn't on the quote so it gets ticked out and back. Crew link only (not
   the band's gear list); never changes the quote or the price.
   ========================================================================= */
function crewCanPick(q) {
    return listOpen(q);
}
exports.addPickExtra = onCall(async (request) => {
    await limitIp(request, 'pickextra', 60, 60);
    const d = request.data || {};
    const doc = await quoteByCrewToken(d.token);
    if (!crewCanPick(doc.data())) throw new HttpsError('failed-precondition', 'This pick list is not available.');
    const name = String(d.name || '')
        .trim()
        .slice(0, 120);
    if (!name) throw new HttpsError('invalid-argument', 'Type what you are adding.');
    const qty = Math.max(1, Math.min(99, Math.round(Number(d.qty) || 1)));
    let photo = '',
        itemId = '';
    if (d.itemId) {
        const it = await db.collection('inventory').doc(String(d.itemId).slice(0, 60)).get();
        if (it.exists) {
            itemId = it.id;
            photo = String(it.data().photoUrl || '');
        }
    }
    const key = 'x' + crypto.randomBytes(6).toString('hex');
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(doc.ref);
        const list = (snap.data().pickExtras || []).slice(0, 59);
        list.push({ key, name, qty, itemId, photo, addedAt: Date.now() });
        tx.update(doc.ref, { pickExtras: list, pickUpdatedAt: FieldValue.serverTimestamp() });
    });
    return { ok: true, key };
});
exports.removePickExtra = onCall(async (request) => {
    await limitIp(request, 'pickextra', 60, 60);
    const d = request.data || {};
    const doc = await quoteByCrewToken(d.token);
    if (!crewCanPick(doc.data())) throw new HttpsError('failed-precondition', 'This pick list is not available.');
    const key = String(d.key || '');
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(doc.ref);
        const list = (snap.data().pickExtras || []).filter((x) => x.key !== key);
        tx.update(doc.ref, { pickExtras: list, ['pickTicks.' + key]: FieldValue.delete(), pickUpdatedAt: FieldValue.serverTimestamp() });
    });
    return { ok: true };
});
