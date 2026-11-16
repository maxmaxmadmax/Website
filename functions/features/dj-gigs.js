/* SOUNDZGOOD SERVER - dj-gigs
   Pub nights and DJ gigs: invoices, templates, DJ confirms and emails.
   Helpers shared with other features come from ../shared.js. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { FieldValue } = require('firebase-admin/firestore');
const { sendQuoteLinkEmail } = require('../lib/quote-doc-email');
const crypto = require('crypto');
const { sendMessageEmail } = require('../lib/message-email');
const {
    DETAIL_EMAIL_RE,
    MSG_TZ,
    SITE_URL,
    SMTP_PASS,
    SMTP_USER,
    addDaysISO,
    brisbaneMinutesNow,
    brisbaneTodayISO,
    db,
    gigHours,
    invoiceNo,
    limitIp,
    nextInvoiceNumber,
    ownDiscount,
    plus4h,
    prettyDay,
    quoteMoney,
    requireAdmin,
    sanitizeQuote
} = require('../shared');

/* =========================================================================
   PUB NIGHT INVOICES

   Regular nights (regularNights/, e.g. Grand View Hotel every Friday) get an
   invoice per night that makes itself:
     - book a DJ at that pub (Entertainment) -> adminGigSync
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
    return String(v || '')
        .toLowerCase()
        .split(',')[0]
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(PUB_WORDS, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
const samePub = (a, b) => {
    const x = pubCore(a),
        y = pubCore(b);
    return !!x && !!y && (x.includes(y) || y.includes(x));
};

const ampm = (t) => {
    const r = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    if (!r) return '';
    const h = +r[1];
    return (h % 12 || 12) + (r[2] === '00' ? '' : ':' + r[2]) + (h < 12 ? 'am' : 'pm');
};

/*  DJ TRAVEL: a FIXED fee per pair of towns, set by Max
    in Entertainment (travelFees/: e.g. Airlie Beach <-> Bowen $80, Mackay or
    Townsville <-> Bowen $150). The DJ's town is actRates.location; the gig's
    town is the last part of the venue ("Grand View Hotel, Bowen" -> Bowen).
    Same town = no travel. No fee set for that pair = no travel + a warning. */
const townKey = (t) =>
    String(t || '')
        .toLowerCase()
        .replace(/[^a-z ]+/g, ' ')
        .replace(/\b(beach|city|qld|queensland)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
const sameTown = (x, y) => {
    const p = townKey(x),
        q = townKey(y);
    return !!p && !!q && (p === q || p.includes(q) || q.includes(p));
};
async function djTravel(fromTown, venue) {
    const parts = String(venue || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    const toTown = parts.length > 1 ? parts[parts.length - 1] : 'Bowen';
    if (!String(fromTown || '').trim()) return { cents: 0 };
    if (sameTown(fromTown, toTown)) return { cents: 0 };
    const snap = await db.collection('travelFees').get();
    let hit = null;
    snap.forEach((d) => {
        const f = d.data();
        if ((sameTown(f.from, fromTown) && sameTown(f.to, toTown)) || (sameTown(f.from, toTown) && sameTown(f.to, fromTown)))
            hit = hit || f;
    });
    if (!hit) return { cents: 0, missing: fromTown + ' to ' + toTown };
    return { cents: Math.max(0, Math.round(hit.cents || 0)), from: fromTown, to: toTown };
}

/*  ACCOMMODATION (Entertainment > Accommodation, kept in
    djSettings/accommodation). A gig's place: the one picked on the booking,
    else the venue's usual place when the DJ is from out of town.
    "none" on the booking = driving home.                                */
async function accomPlaces() {
    const s = await db.collection('djSettings').doc('accommodation').get();
    return s.exists && Array.isArray(s.data().places) ? s.data().places : [];
}
async function gigAccom(b, outOfTown) {
    if (b.accomId === 'none') return null;
    const places = await accomPlaces();
    let id = b.accomId || '';
    if (!id && outOfTown) {
        const vs = await db.collection('venues').get();
        vs.forEach((d) => {
            const v = d.data();
            if (!id && v.accomId && samePub(v.name, b.venue)) id = v.accomId;
        });
    }
    return places.find((p) => p.id === id) || null;
}
async function djAccom(b) {
    const r = await db.collection('actRates').doc(b.slug).get();
    const tr = await djTravel(r.exists ? r.data().location : '', b.venue);
    const p = await gigAccom(b, !!(tr.cents || tr.missing));
    return p
        ? { name: p.name || '', address: p.address || '', checkIn: p.checkIn || '', contact: p.contact || '', notes: p.notes || '' }
        : null;
}
function accomText(p) {
    if (!p) return '';
    return (
        '\n\nYOUR ACCOMMODATION\n' +
        [p.name + (p.address ? ', ' + p.address : ''), p.checkIn && 'Check-in: ' + p.checkIn, p.contact && 'Contact: ' + p.contact, p.notes]
            .filter(Boolean)
            .join('\n')
    );
}

/*  ADMIN - the link the DJ uses to put in their real times */
exports.adminPubTimesLink = onCall(async (request) => {
    requireAdmin(request);
    const ref = db.collection('talentSchedule').doc(String((request.data || {}).bookingId || ''));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'No such booking.');
    let token = snap.data().timesToken;
    if (!token) {
        token = crypto.randomBytes(16).toString('hex');
        await ref.update({ timesToken: token });
    }
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
    await limitIp(request, 'tok', 120, 60);
    const doc = await bookingByTimesToken((request.data || {}).token);
    const b = doc.data();
    const t = await db.collection('talent').doc(b.slug).get();
    return {
        act: (t.exists && t.data().name) || b.slug,
        date: b.date,
        venue: b.venue || '',
        start: b.actualStart || b.start || '',
        finish: b.actualFinish || b.finish || '',
        confirmed: !!b.timesConfirmedAt,
        // before the gig the link asks "are you in?"; from 5pm on the night it asks for times
        mode: brisbaneTodayISO() < b.date || (brisbaneTodayISO() === b.date && brisbaneMinutesNow() < 17 * 60) ? 'confirm' : 'times',
        djConfirmed: !!b.djConfirmedAt,
        plannedStart: b.start || '',
        plannedFinish: b.finish || '',
        accom: await djAccom(b)
    };
});

/*  PUBLIC - the DJ confirms their times:
      - only 5pm to 2:30am can be picked; same start and finish is refused
      - more than 8 hours is refused ("check with Max")
      - 4 hours or less: the invoice goes to the customer straight away
      - more than 4 hours: it waits for Max to check and send            */
exports.submitPubTimes = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    await limitIp(request, 'djtimes', 20, 60);
    const d = request.data || {};
    if (tradingMins(d.start) == null || tradingMins(d.finish) == null)
        throw new HttpsError('invalid-argument', 'Please pick times between 5pm and 2:30am.');
    const hours = gigHours(d.start, d.finish);
    if (!hours) throw new HttpsError('invalid-argument', 'The finish time has to be after the start time.');
    if (hours > 8) throw new HttpsError('invalid-argument', "That's more than 8 hours - please check with Max on 0422 393 022.");
    const doc = await bookingByTimesToken(d.token);
    const b = doc.data();
    if (brisbaneTodayISO() < b.date || (brisbaneTodayISO() === b.date && brisbaneMinutesNow() < 17 * 60))
        throw new HttpsError('failed-precondition', 'Times can be entered from 5pm on the night.');
    await doc.ref.update({ actualStart: String(d.start), actualFinish: String(d.finish), timesConfirmedAt: FieldValue.serverTimestamp() });
    const res = await gigSync(doc.id);
    let sent = false,
        why;
    if (res.locked) why = 'The invoice had already been sent, so it was NOT changed - check it in the Sales Pipeline.';
    else if (!res.id) why = 'No invoice was made (' + (res.skipped || 'no template') + ') - nothing was sent.';
    else if (hours > 4) why = "That's over 4 hours, so the invoice is WAITING for you to check and send it from the dashboard.";
    else {
        try {
            const m = await sendGigInvoice(res.id);
            sent = !!m.sent;
            why = sent
                ? 'The invoice (' + (m.invoiceNumber || '') + ') was sent to the customer automatically.'
                : 'The invoice did not send: ' + (m.error || m.reason || '') + ' - send it from the dashboard.';
        } catch (e) {
            why = 'The invoice did not send: ' + e.message + ' - send it from the dashboard.';
        }
    }
    const t = await db.collection('talent').doc(b.slug).get();
    const act = (t.exists && t.data().name) || b.slug;
    await sendMessageEmail(
        {
            subject: act + ' confirmed ' + hours + ' hrs - ' + String(b.venue || 'gig').split(',')[0] + ' ' + prettyDay(b.date),
            body:
                act +
                ' played ' +
                ampm(d.start) +
                ' to ' +
                ampm(d.finish) +
                ' (' +
                hours +
                ' hrs) at ' +
                (b.venue || 'the gig') +
                ' on ' +
                prettyDay(b.date) +
                '.\n\n' +
                why
        },
        {},
        { to: process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au' }
    );
    return { ok: true, hours, sent, waiting: !sent && hours > 4 };
});

/*  Make it a tax invoice and email it to the customer. Used by Max's Send
    button and by the DJ confirming 4 hours or less. */
async function sendGigInvoice(id) {
    const ref = db.collection('quotes').doc(String(id || ''));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'No such invoice.');
    const q = snap.data();
    if (q.isTemplate) throw new HttpsError('failed-precondition', "This is a template - it can't be sent.");
    if (!(q.customer && q.customer.email))
        throw new HttpsError('failed-precondition', 'The customer has no email on this invoice - add it first.');
    if (!['approved', 'sent', 'invoiced'].includes(q.status)) throw new HttpsError('failed-precondition', "This one can't be sent.");
    const update = { kind: 'invoice', status: 'invoiced', updatedAt: FieldValue.serverTimestamp() };
    if (!q.invoiceNumber) {
        update.invoiceNumber = invoiceNo((await nextInvoiceNumber()).n);
        update.invoicedAt = FieldValue.serverTimestamp();
    }
    await ref.update(update);
    const mail = await sendQuoteLinkEmail(
        { ...q, ...update, invoiceNumber: update.invoiceNumber || q.invoiceNumber },
        SITE_URL + '/quote?t=' + q.token
    );
    if (mail.sent) {
        await ref.update({
            sentAt: FieldValue.serverTimestamp(),
            lastEmailedAt: FieldValue.serverTimestamp(),
            lastEmailedTo: String(q.customer.email || '') + (q.customer.ccEmail ? ' (cc ' + q.customer.ccEmail + ')' : ''),
            emailCount: FieldValue.increment(1)
        });
    }
    return { ...mail, invoiceNumber: update.invoiceNumber || q.invoiceNumber };
}
exports.adminSendPubInvoice = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    requireAdmin(request);
    return sendGigInvoice((request.data || {}).id);
});

/* =========================================================================
   DJ GIG INVOICES - TEMPLATES

   Sales Pipeline > Templates holds a generic DJ gig invoice (isTemplate).
   A CONFIRMED booking in Entertainment with a customer (Customers) and a
   template gets its own quote: the template's lines + "DJ performance:
   hours x the DJ's rate" + the fixed travel fee. One quote per booking
   (gigBookingId). The DJ then confirms the real times (5pm-2:30am only):
   4 hours or less sends the invoice straight away; more waits for Max.
   ========================================================================= */
const TRADE_FROM = 17 * 60; // 5pm
const TRADE_TO = 2 * 60 + 30; // 2:30am (next day)
function tradingMins(t) {
    const r = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    if (!r) return null;
    const m = +r[1] * 60 + +r[2];
    if (m >= TRADE_FROM) return m;
    if (m <= TRADE_TO) return m + 1440;
    return null; // outside trading hours
}

async function gigSync(bookingId, opts = {}) {
    const id = String(bookingId || '');
    // a template is never the gig's quote, even if it was made from one
    const exSnap = await db.collection('quotes').where('gigBookingId', '==', id).limit(5).get();
    const existing = exSnap.docs.find((d) => d.data().isTemplate !== true) || null;
    const ex = existing ? existing.data() : null;
    const bSnap = await db.collection('talentSchedule').doc(id).get();
    const b = bSnap.exists ? bSnap.data() : null;
    // UNCONFIRMED: a new venue's night, DJ held - it gets its quote too
    const live = b && ['confirmed', 'unconfirmed'].includes(b.status || 'confirmed') && b.templateId && b.customerId;
    /*  Sent, accepted or invoiced but NOT PAID: Max can still update it (he is asked first) -
      the venue's link shows the new version and it keeps its status and kind.
      Only once money has come in does it never change.                       */
    const paid = !!ex && (ex.status === 'paid' || ex.amountPaidCents > 0 || ['bank', 'deposit', 'paid'].includes(ex.paymentStatus));
    const sentOk = !!ex && opts.force === true && !paid && ['sent', 'accepted', 'invoiced'].includes(ex.status);
    if (ex && !['approved', 'cancelled'].includes(ex.status) && !sentOk)
        return { locked: true, paid, id: existing.id, status: ex.status, kind: ex.kind || 'quote' };
    if (!live) {
        if (existing && ex.status === 'approved')
            await existing.ref.update({
                status: 'cancelled',
                cancelledAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp()
            });
        return {
            cancelled: !!existing,
            skipped: !b ? 'gone' : !b.templateId ? 'no template' : !b.customerId ? 'no customer' : 'not confirmed'
        };
    }
    const tSnap = await db.collection('quotes').doc(String(b.templateId)).get();
    if (!tSnap.exists || !tSnap.data().isTemplate) return { needTemplate: true };
    const tpl = tSnap.data();
    const cSnap = await db.collection('customers').doc(String(b.customerId)).get();
    const cust = cSnap.exists ? cSnap.data() : {};

    const t = await db.collection('talent').doc(b.slug).get();
    const slugName = String(b.slug || '')
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    const name = (t.exists && t.data().name) || slugName;
    const r = await db.collection('actRates').doc(b.slug).get();
    const rate = r.exists ? r.data() : {};
    // the DJ's real times, else the booked times, else 9:30pm + 4 hours
    const start = b.actualStart || b.start || '21:30';
    const finish = b.actualFinish || (b.actualStart ? '' : b.finish) || plus4h(start);
    const hours = gigHours(start, finish);
    /*  PRICE ON REQUEST: bigger DJs have no set rate - Max
      asks them each time and types their price on the quote. That typed
      price is kept whenever the quote is rebuilt.                      */
    const onRequest = rate.onRequest === true;
    const exPerf = onRequest && ex ? (ex.lines || []).find((l) => l.perf) : null;
    const perHour = onRequest
        ? Math.max(0, Math.round((exPerf && exPerf.unitCents) || 0))
        : Math.max(0, Math.round(rate.hourlyRateCents || 0));
    const notes = [];
    const askPrice = onRequest && !perHour ? [name] : [];
    if (!perHour && !onRequest) notes.push(name);
    const djLine = {
        type: 'custom',
        name: 'DJ performance - ' + name,
        description:
            'Hourly' +
            (start && finish ? ' · ' + ampm(start) + '-' + ampm(finish) : '') +
            (b.timesConfirmedAt ? ' (confirmed)' : '') +
            (hours ? '' : ' · hours to confirm') +
            (perHour
                ? ''
                : onRequest
                  ? ' · PRICE ON REQUEST - ask the DJ, then type their hourly price here'
                  : ' · NO RATE SET - add it on the DJs tab'),
        qty: hours || 0,
        unitCents: perHour,
        days: 1,
        pubDj: true,
        noPick: true,
        perf: true // qty = hours, amount = hourly rate
    };
    const tr = await djTravel(rate.location, b.venue);
    const travelLine = tr.cents
        ? {
              type: 'custom',
              name: 'Travel Charge - ' + tr.from + ' to ' + tr.to + ' Return',
              description: '',
              qty: 1,
              unitCents: tr.cents,
              days: 1,
              pubDj: true,
              noPick: true
          }
        : null;
    if (tr.missing) notes.push(name + ' (no travel fee set for ' + tr.missing + ')');
    /*  ACCOMMODATION: when the venue provides it, a note on the quote. Max can
      delete it on the quote (DJ driving home) and it stays off.           */
    const place = await gigAccom(b, !!(tr.cents || tr.missing));
    const accomLine =
        place && place.paidBy !== 'us' && !(ex && ex.accomOff)
            ? {
                  type: 'custom',
                  name: 'Accommodation',
                  description: 'Accommodation is required for this booking - provided by the venue',
                  qty: 1,
                  unitCents: 0,
                  days: 1,
                  pubDj: true,
                  noPick: true,
                  accom: true
              }
            : null;
    // THE BOOKING FEE, ex GST - a setting on Entertainment:
    // a fixed $ or a % of the DJ's performance only.
    const fee = await djFeeSetting();
    const perfCents = Math.round((djLine.qty || 0) * djLine.unitCents);
    const feeCents = fee.mode === 'percent' ? Math.round((perfCents * fee.pct) / 100) : fee.cents;
    const feeLine =
        feeCents > 0
            ? {
                  type: 'custom',
                  name: fee.name,
                  description: fee.description,
                  qty: 1,
                  unitCents: feeCents,
                  days: 1,
                  pubDj: true,
                  noPick: true
              }
            : null;

    /*  BUILT FROM THE TEMPLATE: the template's fill-in lines
      are swapped in place - "DJ / Entertainer" becomes this DJ + price, "DJ
      travel" their travel (dropped if local), "Accommodation" the venue's
      place (dropped if local or driving home), the booking fee the setting.
      No fee line in the template = no fee. No travel line = travel goes
      under the DJ. No DJ line (older templates) = DJ + travel at the top.  */
    const tplLines = tpl.lines || [];
    const hasSlot = (k) => tplLines.some((l) => l.djSlot === k);
    let lines = [];
    tplLines.forEach((l) => {
        if (l.type === 'fee') return; // the 2% "Booking & admin" is worked out below
        if (l.djSlot === 'dj') {
            lines.push(djLine);
            if (!hasSlot('travel') && travelLine) lines.push(travelLine);
            return;
        }
        if (l.djSlot === 'travel') {
            if (travelLine) lines.push(travelLine);
            return;
        }
        if (l.djSlot === 'fee') {
            if (feeLine) lines.push(feeLine);
            return;
        }
        if (l.djSlot === 'accom') {
            if (accomLine) lines.push(accomLine);
            return;
        }
        if (l.pubDj || l.superLine) return; // old generated DJ lines / super (added below)
        lines.push(l);
    });
    if (!hasSlot('dj')) lines = [djLine].concat(!hasSlot('travel') && travelLine ? [travelLine] : [], lines);
    if (accomLine && !hasSlot('accom')) {
        const at = lines.indexOf(travelLine);
        lines.splice(at >= 0 ? at + 1 : lines.indexOf(djLine) + 1, 0, accomLine);
    }
    if ((tpl.lines || []).some((l) => l.type === 'fee') && tpl.feeExcluded !== true) {
        const pre = quoteMoney({ hire: { days: 1 }, lines, discountCents: ownDiscount(tpl) });
        const fee = Math.round((pre.netCents * 2) / 100 / 1000) * 1000;
        if (fee > 0) lines.push({ type: 'fee', name: 'Booking & admin', qty: 1, unitCents: fee, days: 1 });
    }
    // PERFORMER SUPER - 12% of the DJ's performance, unless the template has it off
    const superCents = tpl.superExcluded === true ? 0 : Math.round((perfCents * 12) / 100);
    if (superCents > 0) {
        const at = lines.indexOf(djLine);
        lines.splice(at >= 0 ? at + 1 : lines.length, 0, {
            type: 'custom',
            name: 'Performer superannuation (12%)',
            description: "Australian law requires super to be paid for performers. We pay it into your DJ's super fund for you.",
            qty: 1,
            unitCents: superCents,
            days: 1,
            superLine: true,
            pubDj: true,
            noPick: true
        });
    }
    const tc = tpl.customer || {};
    const clean = sanitizeQuote({
        ...tpl,
        discountCents: ownDiscount(tpl),
        isTemplate: false,
        templateName: '',
        posterUrl: '',
        kind: 'quote',
        labourPackDate: '',
        lines,
        accomOff: !!(ex && ex.accomOff),
        customer: {
            name: cust.name || '',
            business: cust.business || '',
            email: cust.email || '',
            ccEmail: cust.ccEmail || '',
            phone: cust.phone || '',
            address: cust.address || '',
            /* ONCE THE QUOTE EXISTS, ITS OWN CONTACT DETAILS STAY: edits made on the
         quote, or by the customer on the details form, are not overwritten from
         the Customers list when it is rebuilt. */
            ...(ex && ex.customer
                ? ['name', 'business', 'email', 'ccEmail', 'phone', 'address', 'dayContact', 'customerNotes', 'gearEmails'].reduce(
                      (o, k) => {
                          if (ex.customer[k] != null) o[k] = ex.customer[k];
                          return o;
                      },
                      {}
                  )
                : {}),
            eventName: tc.eventName || 'DJ - ' + String(b.venue || '').split(',')[0],
            eventType: 'dj', // always DJ / Entertainment
            eventVenue: b.venue || '',
            eventDate: prettyDay(b.date),
            eventStartTime: start
        },
        hire: { startDate: b.date, endDate: b.date, days: 1 }
    });
    const money = quoteMoney(clean);
    // the DJ's own deck goes on the pick list so setup staff bring the right cables
    if (rate.deck) clean.crewNotes = 'DJ deck (' + name + '): ' + String(rate.deck).slice(0, 300);
    // who played - shown on the entertainment-style quote / invoice
    const gigDj = {
        name,
        photo: (t.exists && t.data().photo) || 'data/images/talent/' + b.slug + '.jpg',
        start,
        finish,
        hours,
        confirmed: !!b.timesConfirmedAt,
        venue: b.venue || '',
        bio: String((t.exists && t.data().bio) || '').slice(0, 1200),
        styles: Array.isArray(rate.styles) ? rate.styles.slice(0, 16) : []
    };
    const meta = {
        gigDj,
        payFull: b.payFull === true,
        gigBookingId: id,
        pubNight: true,
        pubKey: 'gig|' + id,
        pubVenue: b.venue || '',
        pubDate: b.date,
        pubBookings: [id],
        pubNoRate: notes,
        gigHours: hours,
        gigTemplateId: String(b.templateId),
        customerId: String(b.customerId) // the Customers record it bills, so saving it never makes a new one
    };
    if (existing) {
        await existing.ref.update({
            ...clean,
            ...money,
            ...meta,
            status: sentOk ? ex.status : 'approved',
            kind: sentOk ? ex.kind || 'quote' : clean.kind,
            updatedAt: FieldValue.serverTimestamp()
        });
        return { updated: true, id: existing.id, totalCents: money.totalCents, hours, noRate: notes, askPrice };
    }
    const counterRef = db.collection('config').doc('counters');
    const seq = await db.runTransaction(async (tx) => {
        const c = await tx.get(counterRef);
        const n = ((c.exists && c.data().quoteSeq) || 0) + 1;
        tx.set(counterRef, { quoteSeq: n }, { merge: true });
        return n;
    });
    const ref = await db.collection('quotes').add({
        number: 'SG-Q-' + String(seq).padStart(4, '0'),
        token: crypto.randomBytes(16).toString('hex'),
        status: 'approved',
        approvedAt: FieldValue.serverTimestamp(),
        ...clean,
        ...money,
        ...meta,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        createdBy: 'gig-auto'
    });
    return { created: true, id: ref.id, totalCents: money.totalCents, hours, noRate: notes, askPrice };
}

exports.adminGigSync = onCall(async (request) => {
    requireAdmin(request);
    return gigSync((request.data || {}).bookingId, { force: (request.data || {}).force === true });
});

/* =========================================================================
   DJ CONFIRMS + DJ EMAILS
   One link per gig (/dj-times?t=). Before the gig the DJ taps "I'm in"
   (djConfirmedAt); after it, they put in their times. Emails go to the DJ's
   email on the roster (actRates):
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
    const stay = kind === 'times' ? '' : accomText(await djAccom(b));
    const msg =
        kind === 'booked'
            ? {
                  subject: "You're booked: " + where + ' ' + prettyDay(b.date),
                  body:
                      'Hi ' +
                      first +
                      ',\n\nYou are booked to play ' +
                      where +
                      ' on ' +
                      when +
                      '.' +
                      stay +
                      '\n\nPlease tap the button to confirm you are in.\n\nThanks,\nMax\nSoundzGood Whitsundays - 0422 393 022',
                  label: "I'm in - confirm"
              }
            : kind === 'tomorrow'
              ? {
                    subject: "Tomorrow: you're on at " + where,
                    body:
                        'Hi ' +
                        first +
                        ',\n\nJust a reminder - you are playing ' +
                        where +
                        ' tomorrow, ' +
                        when +
                        '.' +
                        stay +
                        (b.djConfirmedAt ? '' : '\n\nPlease tap the button to confirm you are in.') +
                        '\n\nThanks,\nMax\nSoundzGood Whitsundays - 0422 393 022',
                    label: b.djConfirmedAt ? 'View the gig' : "I'm in - confirm"
                }
              : {
                    subject: 'Your times for ' + where + ' ' + prettyDay(b.date),
                    body:
                        'Hi ' +
                        first +
                        ',\n\nThanks for playing ' +
                        where +
                        '! Please tap the button and put in when you started and finished.\n\nThanks,\nMax\nSoundzGood Whitsundays - 0422 393 022',
                    label: 'Put in my times'
                };
    return sendMessageEmail(
        { subject: msg.subject, body: msg.body },
        {},
        { to: dj.email, actions: [{ label: msg.label, url: link, primary: true }] }
    );
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
    await sendMessageEmail(
        {
            subject: dj.name + ' is in - ' + String(b.venue || 'gig').split(',')[0] + ' ' + prettyDay(b.date),
            body: dj.name + ' confirmed they are playing ' + (b.venue || 'the gig') + ' on ' + prettyDay(b.date) + '.'
        },
        {},
        { to: process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au' }
    );
    return { ok: true };
});

/*  9:35am every day: tomorrow's reminders, yesterday's "put in your times" */
exports.djReminders = onSchedule(
    { schedule: '35 9 * * *', timeZone: MSG_TZ, secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 },
    async () => {
        const today = brisbaneTodayISO();
        const tomorrow = addDaysISO(today, 1),
            yesterday = addDaysISO(today, -1);
        for (const [day, kind, flag] of [
            [tomorrow, 'tomorrow', 'remindedAt'],
            [yesterday, 'times', 'timesAskedAt']
        ]) {
            const snap = await db.collection('talentSchedule').where('date', '==', day).get();
            for (const d of snap.docs) {
                const b = d.data();
                if ((b.status || 'confirmed') !== 'confirmed' || b[flag]) continue;
                if (kind === 'times' && b.timesConfirmedAt) continue;
                try {
                    const r = await emailDj(d.ref, b, kind);
                    if (r.sent) await d.ref.update({ [flag]: FieldValue.serverTimestamp() });
                } catch (e) {
                    logger.error('djReminders', { id: d.id, err: e && e.message });
                }
            }
        }
    }
);

/*  A DJ's rate / location / deck saved (DJs tab) -> their upcoming gig quotes
    are rebuilt on the server, whatever the browser does.
    Only quotes that already exist and haven't gone out are touched.        */
/*  gigNights/: the public copy of the roster for the Friday Nights cards -
    date, act, venue and status only. Everything else on a booking stays
    private (talentSchedule/ is admin-only).                             */
exports.onGigNightChanged = require('firebase-functions/v2/firestore').onDocumentWritten('talentSchedule/{id}', async (event) => {
    const ref = db.collection('gigNights').doc(event.params.id);
    const after = event.data && event.data.after;
    if (!after || !after.exists) {
        await ref.delete().catch(() => {});
        return;
    }
    const b = after.data();
    await ref.set({ date: b.date || '', slug: b.slug || '', venue: b.venue || '', status: b.status || 'confirmed', time: b.time || '' });
});

exports.onDjRatesChanged = require('firebase-functions/v2/firestore').onDocumentWritten('actRates/{slug}', async (event) => {
    const slug = event.params.slug;
    const today = brisbaneTodayISO();
    const snap = await db.collection('talentSchedule').where('slug', '==', slug).get();
    for (const d of snap.docs) {
        const b = d.data();
        if (b.date < today || !b.templateId || !b.customerId) continue;
        const q = await db.collection('quotes').where('gigBookingId', '==', d.id).limit(1).get();
        if (q.empty || q.docs[0].data().status !== 'approved') continue;
        try {
            await gigSync(d.id);
        } catch (e) {
            logger.error('onDjRatesChanged', { id: d.id, err: e && e.message });
        }
    }
});

/*  UNCONFIRMED -> CONFIRMED: a new venue's gig quote paid
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
        } catch (e) {
            logger.error('onGigQuotePaid', { id: snap.id, err: e && e.message });
        }
    }
);

/* DJ BOOKING FEE SETTING - djSettings/fee, edited on Admin > Entertainment.
   Until it is saved: $80 fixed. */
async function djFeeSetting() {
    const d = await db.collection('djSettings').doc('fee').get();
    const x = d.exists ? d.data() : {};
    return {
        mode: x.mode === 'percent' ? 'percent' : 'fixed',
        cents: Number.isFinite(x.cents) ? Math.max(0, Math.round(x.cents)) : 8000,
        pct: Number.isFinite(x.pct) ? Math.max(0, Math.min(100, x.pct)) : 15,
        name: String(x.name || 'Booking & management').slice(0, 120),
        description: String(x.description == null ? 'Sourcing, scheduling and managing your DJ, with backup cover' : x.description).slice(
            0,
            300
        )
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
        try {
            await gigSync(d.id);
        } catch (e) {
            logger.error('onDjFeeChanged', { id: d.id, err: e && e.message });
        }
    }
});
