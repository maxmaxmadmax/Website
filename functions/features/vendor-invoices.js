/* SOUNDZGOOD SERVER - vendor-invoices
   Vendor tax invoices.
   Helpers shared with other features come from ../shared.js. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const {
    SITE_URL,
    SMTP_PASS,
    SMTP_USER,
    bookingIsPaid,
    db,
    ensureVendorInvoice,
    limitIp,
    requireAdmin,
    sendVendorInvoice
} = require('../shared');

/* -------------------------------------------------------------------------
   VENDOR TAX INVOICES

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

exports.adminVendorInvoiceLink = onCall(async (request) => {
    requireAdmin(request);
    const id = String((request.data || {}).bookingId || '').trim();
    if (!id) throw new HttpsError('invalid-argument', 'Missing booking.');
    const inv = await ensureVendorInvoice(id);
    return { ok: true, invoiceNumber: inv.invoiceNumber, link: SITE_URL + '/vendor-invoice?t=' + inv.token };
});

/*  SEND TO EVERY PAID VENDOR of an event who has not had theirs yet. Pressed from the Sales Pipeline.        */
exports.adminSendVendorInvoicesAll = onCall({ secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 }, async (request) => {
    requireAdmin(request);
    const eventId = String((request.data || {}).eventId || '').trim();
    if (!eventId) throw new HttpsError('invalid-argument', 'Missing event.');
    const snap = await db.collection('bookings').where('eventId', '==', eventId).get();
    const out = { sent: 0, skipped: 0, failed: [] };
    for (const d of snap.docs) {
        const b = d.data();
        if (!bookingIsPaid(b) || b.status === 'cancelled' || b.invoiceEmailedAt) {
            out.skipped++;
            continue;
        }
        try {
            const r = await sendVendorInvoice(d.id, {});
            if (r.sent) out.sent++;
            else out.failed.push(((b.business || {}).name || d.id) + ': ' + (r.error || r.reason || 'not sent'));
        } catch (err) {
            out.failed.push(((b.business || {}).name || d.id) + ': ' + (err && err.message));
        }
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
    await limitIp(request, 'tok', 120, 60);
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
            mine: Array.isArray(b.siteIds) && b.siteIds.length ? b.siteIds : b.siteId ? [b.siteId] : []
        };
    } catch (e) {
        logger.warn('getVendorInvoice map', e);
    }

    // the documents this vendor uploaded - only links to our own storage bucket
    const DOC_HOSTS = ['firebasestorage.googleapis.com', 'storage.googleapis.com', 'soundzgood-8c86f.firebasestorage.app'];
    const documents = (Array.isArray(b.documents) ? b.documents : [])
        .map((x) => {
            try {
                const u = new URL(String(x.url || ''));
                if (u.protocol !== 'https:' || !DOC_HOSTS.includes(u.hostname)) return null;
                return { name: String(x.name || 'Document').slice(0, 200), type: String(x.type || '').slice(0, 60), url: u.href };
            } catch (e) {
                return null;
            }
        })
        .filter(Boolean);

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
        siteCents: site,
        feeCents: fee,
        gstCents: gst,
        totalCents: total,
        event: {
            name: ev.name || '',
            subtitle: ev.subtitle || '',
            dateLabel: ev.dateLabel || '',
            dateISO: ev.dateISO || '',
            image: ev.image || '',
            venue: ev.venue || '',
            location: ev.location || ''
        },
        seller: {
            name: 'SoundzGood Whitsundays',
            legal: process.env.SG_LEGAL_NAME || '',
            abn: process.env.SG_ABN || '',
            email: process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au',
            phone: '0422 393 022',
            address: '34a Williams St, Bowen QLD 4805',
            site: 'www.soundzgood.com.au'
        }
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
        try {
            await ensureVendorInvoice(d.id);
            made++;
        } catch (err) {
            logger.warn('ensure vendor invoice', { id: d.id, message: err && err.message });
        }
    }
    return { ok: true, made };
});
