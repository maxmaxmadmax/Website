/* SOUNDZGOOD SERVER - messages
   Messages, late payment charges and payment reminders.
   Helpers shared with other features come from ../shared.js. */
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { FieldValue } = require('firebase-admin/firestore');
const {
    MSG_TZ,
    QUOTE_DEPOSIT_PCT,
    SITE_URL,
    SMTP_PASS,
    SMTP_USER,
    SPONSOR_NOTE,
    addDaysISO,
    bookingIsPaid,
    brisbaneMinutesNow,
    brisbaneToday,
    db,
    prettyDay,
    quoteGrandTotal,
    recordSend,
    refreshMessageCounts,
    requireAdmin,
    sendMessageTo,
    sendVendorInvoice,
    sponsorLink,
    sponsorValues
} = require('../shared');

/* =========================================================================
   MESSAGES  -  step 1: vendors

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
const { sendMessageEmail } = require('../lib/message-email');
const MSG_SEND_AT = '9:35 am';
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

/* The invoice email's starter wording. */
const INVOICE_SUBJECT = 'Your tax invoice & event guide - {{event_name}}';
const INVOICE_BODY =
    'Hi {{vendor_name}}, thank you for being part of {{event_name}} on {{event_date}}. Your tax invoice, event details and vendor instructions are all in one place.\n\nHelp us promote the event! A bigger crowd means more sales for every stall. Your guide includes the event poster, the A4 program and share links - please post them on your socials, share them with your customers, pop the poster up and help us advertise.';

/*  The starter messages: Max checks the wording and approves. */
function starterMessages(eventId) {
    const base = { eventId, audience: 'vendors', who: 'all', promo: false };
    return [
        {
            ...base,
            system: 'invoice',
            name: 'Booking confirmed + invoice & guide',
            status: 'approved',
            subject: INVOICE_SUBJECT,
            trigger: { type: 'payment' },
            body: INVOICE_BODY,
            approvedSubject: INVOICE_SUBJECT,
            approvedBody: INVOICE_BODY
        },
        {
            ...base,
            name: 'One week to go',
            status: 'review',
            subject: 'One week to go - {{event_name}}',
            trigger: { type: 'daysBefore', days: 7 },
            body: "Hi {{vendor_name}},\n\n{{event_name}} is only a week away and we can't wait to have {{business_name}} with us at site {{site_number}}.\n\nA few reminders:\n- Set up and vehicle parked by 4:15 pm\n- No vehicles moving on site between 4:15 pm and 9:40 pm\n- Marquee secured, pegs 300 mm deep max\n- Take all your waste home\n\nYour site map, invoice, poster and program are all in your event guide below. Please help us spread the word!\n\nSee you soon,\nThe SoundzGood team"
        },
        {
            ...base,
            name: 'Day before',
            status: 'review',
            subject: 'See you tomorrow - {{event_name}}',
            trigger: { type: 'daysBefore', days: 1 },
            body: "Hi {{vendor_name}},\n\nTomorrow's the big night! Your quick checklist:\n- You're at site {{site_number}}\n- Set up and vehicle parked by 4:15 pm\n- Doors open 4:30 pm\n- No vehicles moving on site until 9:40 pm\n\nOn the night, please follow directions from our event staff.\n\nSee you tomorrow,\nThe SoundzGood team"
        },
        {
            ...base,
            name: 'Thank you',
            status: 'review',
            subject: 'Thank you for being part of {{event_name}}',
            trigger: { type: 'daysAfter', days: 1 },
            body: "Hi {{vendor_name}},\n\nThank you for joining us at {{event_name}} - we hope it was a great night for {{business_name}}.\n\nWe'd love your feedback. Just reply to this email and tell us what worked and what we can do better.\n\nFollow us on Instagram @soundzgood_events for our next events.\n\nThanks again,\nThe SoundzGood team"
        },
        // SITE CHANGED: sent the moment an admin moves a paid vendor to a different site
        {
            ...base,
            system: 'site-moved',
            name: 'Site changed',
            status: 'review',
            trigger: { type: 'siteMoved' },
            subject: 'Your site has changed - {{event_name}}',
            body: "Hi {{vendor_name}},\n\nA quick heads-up: we've moved {{business_name}} to site {{site_number}} for {{event_name}} on {{event_date}}.\n\nYour event guide below has the updated site map. Nothing else changes.\n\nThanks,\nThe SoundzGood team"
        },
        // WAITLIST OFFER: sent by the waitlist the moment a spot opens
        {
            ...base,
            system: 'waitlist',
            name: 'Waitlist - a spot opened',
            status: 'review',
            trigger: { type: 'waitlist' },
            subject: 'A spot just opened at {{event_name}} - claim it now',
            body: "Hi {{vendor_name}},\n\nGood news - a spot has just opened at {{event_name}} on {{event_date}}, and you're next on the waitlist.\n\nWe've reserved site {{site_number}} for {{business_name}} until {{expires_at}}. Press Accept below to book and pay - the spot is only yours once payment is received.\n\nCan't make it? Press Decline and we'll offer it to the next vendor.\n\nThanks,\nThe SoundzGood team"
        },
        // SPONSORSHIP: the ask (sent when Max presses Send) and a follow-up 7 days later
        {
            ...base,
            audience: 'sponsors',
            system: 'sponsor-ask',
            name: 'Sponsorship - the ask',
            status: 'review',
            trigger: { type: 'manual' },
            subject: 'Partnering with {{event_name}} - keeping it free for local families',
            body: "Hi {{vendor_name}},\n\nI'm Max from SoundzGood - we run Eatz & Beatz, the free community night in Bowen with local food, markets and live music.\n\nWe're planning our next event and we'd love {{business_name}} to be part of it. Keeping the night free for families takes local businesses who believe in it, and in return we put your business in front of the whole community - on the posters, our socials, the event page and from the stage on the night.\n\nThere are a few ways to get involved, from a small supporter right up to presenting partner. Everything is on the page below - have a look and let me know if anything suits.\n\nThanks for considering it,\nMax\nSoundzGood Whitsundays - 0422 393 022"
        },
        {
            ...base,
            audience: 'sponsors',
            system: 'sponsor-followup',
            name: 'Sponsorship - follow-up',
            status: 'review',
            trigger: { type: 'sponsorFollowup', days: 7 },
            subject: 'Following up - {{event_name}}',
            body: "Hi {{vendor_name}},\n\nJust following up on my note last week about supporting {{event_name}}. No pressure at all - if it's not the right time, a quick reply is perfect and I won't chase again.\n\nIf you'd like to have a chat about it, I'm on 0422 393 022.\n\nThanks,\nMax"
        },
        // GOOGLE REVIEW: 3 days after - the Tuesday after a Saturday event
        {
            ...base,
            name: 'Google review',
            status: 'review',
            subject: 'Could you leave us a quick review? - {{event_name}}',
            trigger: { type: 'daysAfter', days: 3 },
            body: 'Hi {{vendor_name}},\n\nThanks again for being part of {{event_name}}. We hope it was a great night for {{business_name}}.\n\nCould you take 30 seconds to leave us a Google review? It really helps us grow community events like this one:\nhttps://g.page/r/CSUgRhfqGvdnEAI/review\n\nThank you!\nThe SoundzGood team'
        }
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
            await sys.ref.update({
                subject: INVOICE_SUBJECT,
                body: INVOICE_BODY,
                approvedSubject: INVOICE_SUBJECT,
                approvedBody: INVOICE_BODY
            });
        }
        // a starter added later (e.g. Google review) appears on events that already have messages
        const names = new Set(have.docs.map((d) => d.data().name));
        const missing = starterMessages(eventId).filter((m) => m.system !== 'invoice' && !names.has(m.name));
        for (const m of missing) {
            await db
                .collection('messages')
                .add({ ...m, sentCount: 0, failed: [], createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
        }
        return { ok: true, added: missing.length };
    }
    const batch = db.batch();
    starterMessages(eventId).forEach((m) =>
        batch.set(db.collection('messages').doc(), {
            ...m,
            sentCount: 0,
            failed: [],
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
        })
    );
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
        name: clean(d.name, 120),
        subject: clean(d.subject, 200),
        body: clean(d.body, 20000),
        who: ['all', 'food', 'market'].includes(d.who) ? d.who : 'all',
        promo: d.promo === true,
        trigger,
        updatedAt: FieldValue.serverTimestamp()
    };
    fields.status = messageComplete(fields) ? 'review' : 'draft';

    if (d.id) {
        const ref = db.collection('messages').doc(String(d.id));
        const snap = await ref.get();
        if (!snap.exists) throw new HttpsError('not-found', 'No such message.');
        const m = snap.data();
        if (m.system) {
            // invoice email: wording only; vendors keep getting the approved copy until Max approves this
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
        ...fields,
        eventId,
        audience: 'vendors',
        sentCount: 0,
        failed: [],
        createdAt: FieldValue.serverTimestamp()
    });
    return { ok: true, id: ref.id, status: fields.status };
});

/*  approve | pause | resume | cancel | delete */
exports.adminMessageAction = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    requireAdmin(request);
    const { id, action } = request.data || {};
    const ref = db.collection('messages').doc(String(id || ''));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'No such message.');
    const m = snap.data();
    const by = (request.auth.token && request.auth.token.email) || request.auth.uid;

    if (m.system) {
        // the invoice email: only pause / resume
        if (action === 'pause') {
            await ref.update({ status: 'paused', updatedAt: FieldValue.serverTimestamp() });
            return { ok: true };
        }
        if (action === 'resume') {
            await ref.update({ status: 'approved', updatedAt: FieldValue.serverTimestamp() });
            return { ok: true };
        }
        if (action === 'approve') {
            if (!String(m.subject || '').trim() || !String(m.body || '').trim())
                throw new HttpsError('failed-precondition', 'Fill in the subject and the message first.');
            await ref.update({
                status: 'approved',
                approvedSubject: m.subject,
                approvedBody: m.body,
                approvedAt: FieldValue.serverTimestamp(),
                approvedBy: by,
                updatedAt: FieldValue.serverTimestamp()
            });
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
            throw new HttpsError(
                'failed-precondition',
                'That send day (' + day + ', ' + MSG_SEND_AT + ') has already passed - pick a later day.'
            );
        }
        await ref.update({
            status: 'approved',
            approvedAt: FieldValue.serverTimestamp(),
            approvedBy: by,
            updatedAt: FieldValue.serverTimestamp()
        });
        return { ok: true, sendDate: day };
    }
    // SEND NOW: straight to everyone it's for, no waiting for 9:35 am
    if (action === 'sendNow') {
        if (m.system) throw new HttpsError('failed-precondition', 'That one sends itself.');
        if (!String(m.subject || '').trim() || !String(m.body || '').trim())
            throw new HttpsError('failed-precondition', 'Fill in the subject and the message first.');
        if (m.status === 'sent') throw new HttpsError('failed-precondition', 'Already sent.');
        const evSnap = await db.collection('events').doc(m.eventId).get();
        const ev = evSnap.exists ? evSnap.data() : {};
        const list = await messageRecipients(m);
        if (!list.length) throw new HttpsError('failed-precondition', 'Nobody to send it to.');
        for (const b of list) {
            const already = await ref.collection('sends').doc(b.id).get();
            if (already.exists && already.data().ok) continue;
            const r = await sendMessageTo(m, ev, b, {});
            await recordSend(ref, b, r);
        }
        await refreshMessageCounts(ref);
        await ref.update({ status: 'sent', sentAt: FieldValue.serverTimestamp(), sentBy: by, updatedAt: FieldValue.serverTimestamp() });
        const fresh = (await ref.get()).data();
        logger.info('message sent now', { id: ref.id, name: m.name, count: list.length, by });
        return { ok: true, sent: fresh.sentCount || 0, failed: (fresh.failed || []).length, total: list.length };
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
        if ((m.sentCount || 0) > 0)
            throw new HttpsError('failed-precondition', 'That message has been sent to people - cancel it instead.');
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
        const r = await sendMessageEmail(
            { subject: m.subject, body: m.body },
            sponsorValues({ business: 'Sample Business', contactName: 'Sam' }, ev),
            {
                to,
                test: true,
                actions: [{ label: 'See the sponsor options', url: sponsorLink(m.eventId, ''), primary: true }],
                note: SPONSOR_NOTE
            }
        );
        return { ...r, to };
    }
    if (m.system === 'waitlist') {
        const r = await sendMessageEmail(
            { subject: m.subject, body: m.body },
            {
                vendor_name: 'Sam',
                business_name: 'Sample Food Co',
                site_number: 'F4',
                event_name: ev.name || '',
                event_date: ev.dateLabel || '',
                event_venue: [ev.venue, ev.location].filter(Boolean).join(', '),
                expires_at: 'Sat 24 Oct, 1:35 pm',
                guide_link: ''
            },
            {
                to,
                test: true,
                actions: [
                    { label: 'Accept & book my spot', url: SITE_URL + '/vendor-signup', primary: true },
                    { label: 'No thanks - decline', url: SITE_URL }
                ],
                note: 'This spot is held for you until Sat 24 Oct, 1:35 pm. It is only yours once payment is received.'
            }
        );
        return { ...r, to };
    }
    const r = await sendMessageTo(m, ev, list[0], { test: true, to, extra: m.system === 'site-moved' ? { old_site: 'F2' } : {} });
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
    const bSnap = await db
        .collection('bookings')
        .doc(String(bookingId || ''))
        .get();
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
    }
);

/*  Unsubscribe from promotional emails (link at the bottom of them). */
exports.vendorUnsubscribe = onRequest(async (req, res) => {
    const token = String(req.query.t || '').trim();
    const page = (msg) =>
        res
            .status(200)
            .send(
                '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial;padding:40px;text-align:center;background:#f4f4f5"><div style="max-width:480px;margin:auto;background:#fff;padding:30px;border-radius:12px"><p style="color:#ff6b00;letter-spacing:2px;font-size:12px">SOUNDZGOOD WHITSUNDAYS</p><h2>' +
                    msg +
                    '</h2><p style="color:#666">You will still get emails about bookings you make.</p></div></body>'
            );
    if (!/^[a-f0-9]{20,40}$/.test(token)) return page('That link is not valid.');
    const snap = await db.collection('bookings').where('invoiceToken', '==', token).limit(1).get();
    if (snap.empty) return page('That link is not valid.');
    // email scanners open links by themselves -
    // opening the link only shows a button; pressing it does the unsubscribe.
    if (req.method !== 'POST')
        return page(
            'Unsubscribe from event news?<form method="post" style="margin-top:18px"><button style="background:#ff6b00;color:#fff;border:0;padding:12px 22px;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer">Yes, unsubscribe me</button></form>'
        );
    await snap.docs[0].ref.update({ promoOptOut: true, promoOptOutAt: FieldValue.serverTimestamp() });
    return page('You have been unsubscribed from event news.');
});
function lateFeeState(q) {
    const owing = quoteGrandTotal(q) - Math.round(q.amountPaidCents || 0);
    if (owing <= 0 || q.status === 'cancelled' || q.status === 'declined' || q.paymentStatus === 'paid') return { allowed: 0, owing };
    if (!(q.kind === 'invoice' || ['accepted', 'invoiced'].includes(q.status))) return { allowed: 0, owing };
    const due = addDaysISO(q.hire && q.hire.startDate, -7);
    if (!due) return { allowed: 0, owing };
    const first = addDaysISO(due, 29); // more than 28 days after the due date
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
        updatedAt: FieldValue.serverTimestamp()
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
    await ref.update({
        lateFees: fees,
        lateFeeCents: fees.reduce((t, x) => t + (x.cents || 0), 0),
        updatedAt: FieldValue.serverTimestamp()
    });
    return { ok: true };
});

/* PREVIEW A CLIENT EMAIL (Messages > Clients). Shows the real layout:
   quote / invoice use your most recent one, the bot estimate and lead
   email use sample words. Sends nothing. */
exports.adminPreviewClientEmail = onCall(async (request) => {
    requireAdmin(request);
    const kind = String((request.data || {}).kind || '');
    if (kind === 'estimate') {
        const { __test } = require('../lib/quote-email');
        const lead = {
            name: 'Sam',
            eventTypeLabel: 'Wedding',
            locationLabel: 'Airlie Beach',
            sizeLabel: '80-150 guests',
            durationLabel: '5 hours',
            serviceLabels: ['Sound', 'Lighting'],
            estimateLowCents: 180000,
            estimateHighCents: 240000
        };
        return {
            subject: 'Your SoundzGood estimate - Wedding',
            html: __test.leadHtml(lead),
            note: 'Sample details - each person sees their own answers and price range.'
        };
    }
    if (kind === 'lead') {
        const { leadHtml } = require('../lib/lead-email');
        return {
            subject: '(you write the subject)',
            html: leadHtml(
                'Hi there,\n\nThis is where your own message goes - you write it each time in the Lead Generator.\n\nCheers,\nMax'
            ),
            note: 'You write these each time - this shows the letterhead it goes out in.'
        };
    }
    if (kind === 'reminder') {
        // payment reminder
        const { renderPaymentReminder } = require('../lib/quote-doc-email');
        const snap = await db.collection('quotes').orderBy('createdAt', 'desc').limit(60).get();
        const doc = snap.docs.find((d) => owesMoney(d.data()));
        const q = doc
            ? doc.data()
            : {
                  kind: 'invoice',
                  number: 'SG-Q-0000',
                  invoiceNumber: 'SG-I-0000',
                  customer: { name: 'Sam', eventName: 'Your event' },
                  totalCents: 100000,
                  token: 'x'
              };
        const out = renderPaymentReminder(q, SITE_URL + '/quote?t=' + (q.token || ''), reminderInfo(q));
        return {
            ...out,
            note: doc
                ? 'As ' + ((q.customer && q.customer.name) || 'this client') + ' would get it (' + (q.invoiceNumber || q.number) + ').'
                : 'Sample details.'
        };
    }
    if (kind === 'quote' || kind === 'invoice') {
        const { renderQuoteLinkEmail } = require('../lib/quote-doc-email');
        // one quote ("See the email" beside Send Quote), else the most recent one
        const quoteId = String((request.data || {}).quoteId || '');
        if (quoteId) {
            const one = await db.collection('quotes').doc(quoteId.slice(0, 200)).get();
            if (!one.exists) throw new HttpsError('not-found', 'That quote was not found.');
            const d = one.data();
            const out = renderQuoteLinkEmail(d, SITE_URL + '/quote?t=' + (d.token || ''));
            const c = d.customer || {};
            return {
                ...out,
                note: 'To ' + (c.email || '(no email yet)') + (c.ccEmail ? ', cc ' + c.ccEmail : '') + '. Nothing has been sent.'
            };
        }
        const snap = await db.collection('quotes').orderBy('createdAt', 'desc').limit(40).get();
        const doc = snap.docs.find((d) =>
            kind === 'invoice' ? d.data().kind === 'invoice' : d.data().kind !== 'invoice' && d.data().status !== 'draft'
        );
        const q = doc
            ? doc.data()
            : {
                  kind,
                  number: 'SG-Q-0000',
                  invoiceNumber: 'SG-I-0000',
                  customer: { name: 'Sam', eventName: 'Your event' },
                  totalCents: 100000,
                  token: 'x'
              };
        const out = renderQuoteLinkEmail(q, SITE_URL + '/quote?t=' + (q.token || ''));
        return {
            ...out,
            note: doc ? 'Your most recent ' + kind + ' (' + ((q.customer && q.customer.name) || '') + ').' : 'Sample ' + kind + '.'
        };
    }
    throw new HttpsError('invalid-argument', 'Unknown email.');
});

/* =========================================================================
   PAYMENT REMINDERS - sent only when Max presses Send.
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
        return {
            dueCents: Math.round((total * pct) / 100),
            dueLabel: pct + '% deposit due now',
            isDeposit: true,
            balanceDue: dueDay ? prettyDay(dueDay) : ''
        };
    }
    return { dueCents: owing, dueLabel: paid ? 'Balance owing' : 'Amount due', isDeposit: false, balanceDue: '' };
}
exports.adminSendPaymentReminder = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    requireAdmin(request);
    const { sendPaymentReminderEmail } = require('../lib/quote-doc-email');
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
