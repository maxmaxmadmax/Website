/* SOUNDZGOOD SERVER - customer-details
   Customers filling in their own details.
   Helpers shared with other features come from ../shared.js. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { FieldValue } = require('firebase-admin/firestore');
const { sendQuoteLinkEmail } = require('../lib/quote-doc-email');
const { sendMessageEmail } = require('../lib/message-email');
const {
    DETAIL_EMAIL_RE,
    SITE_URL,
    SMTP_PASS,
    SMTP_USER,
    db,
    emailList,
    gearLinkToken,
    hasPayDetails,
    limitIp,
    listOpen
} = require('../shared');

async function quoteByDetailsToken(token) {
    const t = String(token || '').trim();
    if (!/^[a-f0-9]{20,40}$/.test(t)) throw new HttpsError('invalid-argument', 'That link is not valid.');
    const snap = await db.collection('quotes').where('detailsToken', '==', t).limit(1).get();
    if (snap.empty) throw new HttpsError('not-found', 'That link is not valid.');
    return snap.docs[0];
}

/*  PUBLIC: the form, pre-filled with what we already have. */
exports.getDetailsForm = onCall(async (request) => {
    await limitIp(request, 'tok', 120, 60);
    const doc = await quoteByDetailsToken((request.data || {}).token);
    const q = doc.data();
    const c = q.customer || {};
    const ready = ['approved', 'sent', 'accepted', 'invoiced', 'paid'].includes(q.status) && q.token;
    return {
        customer: {
            name: c.name || '',
            business: c.business || '',
            email: c.email || '',
            ccEmail: c.ccEmail || '',
            phone: c.phone || '',
            address: c.address || '',
            eventName: c.eventName || '',
            eventDate: c.eventDate || '',
            eventVenue: c.eventVenue || '',
            eventStartTime: c.eventStartTime || '',
            customerNotes: c.customerNotes || '',
            dayContact: c.dayContact || ''
        },
        startDate: (q.hire && q.hire.startDate) || '',
        received: !!q.detailsReceivedAt,
        autoSend: !!(q.autoSendOnDetails && ready && !q.autoSentOnDetailsAt), // quote goes out the moment they submit
        quoteLink: ready ? SITE_URL + '/quote?t=' + q.token : ''
    };
});

/*  Puts the customer's details on the quote, adds or updates them in
    Customers, and emails the office. Shared by the details link and the
    form on the quote page. Returns the merged customer.                  */
async function saveCustomerDetails(doc, q, f, opts = {}) {
    const customer = { ...(q.customer || {}) };
    Object.keys(f).forEach((k) => {
        if (f[k]) customer[k] = f[k];
    });
    await doc.ref.update({ customer, detailsReceivedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });

    // the customer list: update the one with this email, or add them
    try {
        const cs = await db.collection('customers').where('email', '==', f.email).limit(1).get();
        const rec = {
            name: f.name,
            business: f.business,
            email: f.email,
            ccEmail: f.ccEmail,
            phone: f.phone,
            address: f.address,
            updatedAt: Date.now()
        };
        Object.keys(rec).forEach((k) => {
            if (rec[k] === '') delete rec[k];
        });
        if (cs.empty)
            await db.collection('customers').add({ type: f.business ? 'business' : 'private', notes: '', ...rec, createdAt: Date.now() });
        else if (!opts.addOnly && String((q.customer || {}).email || '').toLowerCase() === f.email.toLowerCase())
            await cs.docs[0].ref.set(rec, { merge: true }); // only the customer already on this quote
    } catch (err) {
        logger.warn('details: customer list', err && err.message);
    }

    await sendMessageEmail(
        {
            subject: (f.name || 'A customer') + ' filled in their details - ' + (q.number || ''),
            body:
                (f.name || 'A customer') +
                ' filled in their details for quote ' +
                (q.number || '') +
                ':\n\n' +
                [
                    'Name: ' + f.name,
                    f.business && 'Business: ' + f.business,
                    'Email: ' + f.email,
                    f.ccEmail && 'Billing CC: ' + f.ccEmail,
                    'Phone: ' + f.phone,
                    f.address && 'Address: ' + f.address,
                    f.eventName && 'Event: ' + f.eventName,
                    f.eventDate && 'Date: ' + f.eventDate,
                    f.eventVenue && 'Venue: ' + f.eventVenue,
                    f.eventStartTime && 'Event starts: ' + f.eventStartTime,
                    f.dayContact && 'Event day contact: ' + f.dayContact,
                    f.customerNotes && 'Notes: ' + f.customerNotes
                ]
                    .filter(Boolean)
                    .map((x) => '- ' + x)
                    .join('\n') +
                '\n\nThey are already on the quote - open it in the Sales Pipeline.'
        },
        {},
        { to: process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au' }
    );
    return customer;
}

/*  PUBLIC: the quote page asks for details before paying (when the quote
    went out without them). Name, email and phone are required.           */
exports.submitQuoteDetails = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    await limitIp(request, 'details', 20, 60);
    const d = request.data || {};
    const token = String(d.token || '').trim();
    if (!/^[a-f0-9]{20,40}$/.test(token)) throw new HttpsError('invalid-argument', 'That link is not valid.');
    const snap = await db.collection('quotes').where('token', '==', token).limit(1).get();
    if (snap.empty) throw new HttpsError('not-found', 'That link is not valid.');
    const doc = snap.docs[0];
    const q = doc.data();
    if (!['approved', 'sent', 'accepted', 'invoiced'].includes(q.status) || q.paymentStatus === 'paid') {
        throw new HttpsError('failed-precondition', 'This quote can no longer be changed.');
    }
    // only while details are missing - once in, changes go through the office
    if (hasPayDetails(q.customer))
        throw new HttpsError('failed-precondition', 'We already have your details. To change them, call us on 0422 393 022.');
    const clean = (v, n) =>
        String(v == null ? '' : v)
            .trim()
            .slice(0, n);
    const f = {
        name: clean(d.name, 120),
        business: clean(d.business, 120),
        email: clean(d.email, 200).toLowerCase(),
        ccEmail: emailList(d.ccEmail),
        phone: clean(d.phone, 40),
        address: clean(d.address, 300),
        eventVenue: clean(d.eventVenue, 200),
        eventStartTime: clean(d.eventStartTime, 20),
        customerNotes: clean(d.customerNotes, 2000),
        dayContact: clean(d.dayContact, 200),
        gearEmails: emailList(d.gearEmails)
    };
    if (!f.name) throw new HttpsError('invalid-argument', 'Please enter your name.');
    if (!DETAIL_EMAIL_RE.test(f.email)) throw new HttpsError('invalid-argument', 'Please enter a valid email address.');
    if (!f.phone) throw new HttpsError('invalid-argument', 'Please enter a phone number.');
    await saveCustomerDetails(doc, q, f, { addOnly: true });
    return { ok: true };
});

/*  PUBLIC: the read-only gear list link (no prices) for the customer to
    share with their band, tour manager or tech. */
exports.getGearShareLink = onCall(async (request) => {
    await limitIp(request, 'gearlink', 30, 60);
    const token = String((request.data || {}).token || '').trim();
    if (!/^[a-f0-9]{20,40}$/.test(token)) throw new HttpsError('invalid-argument', 'That link is not valid.');
    const snap = await db.collection('quotes').where('token', '==', token).limit(1).get();
    if (snap.empty) throw new HttpsError('not-found', 'That link is not valid.');
    const doc = snap.docs[0];
    const q = doc.data();
    if (!listOpen(q)) throw new HttpsError('failed-precondition', 'The gear list is not available.');
    return { url: SITE_URL + '/picklist?t=' + (await gearLinkToken(doc.ref, q)) + '&v=gear' };
});

/*  PUBLIC: "Share the gear list with your team" on the quote page. The
    customer keeps their own list of band / tour manager / tech emails
    (customer.gearEmails, max 10). They get the gear list with NO prices
    when the deposit is in, 3 days before and on the day. The office is told. */
exports.setGearTeam = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    await limitIp(request, 'gearteam', 20, 60);
    const d = request.data || {};
    const token = String(d.token || '').trim();
    if (!/^[a-f0-9]{20,40}$/.test(token)) throw new HttpsError('invalid-argument', 'That link is not valid.');
    const snap = await db.collection('quotes').where('token', '==', token).limit(1).get();
    if (snap.empty) throw new HttpsError('not-found', 'That link is not valid.');
    const doc = snap.docs[0];
    const q = doc.data();
    if (!['approved', 'sent', 'accepted', 'invoiced', 'paid'].includes(q.status))
        throw new HttpsError('failed-precondition', 'This quote can no longer be changed.');
    const gearEmails = emailList(d.emails);
    const before = emailList((q.customer || {}).gearEmails);
    if (gearEmails === before) return { gearEmails };
    await doc.ref.update({ 'customer.gearEmails': gearEmails, updatedAt: FieldValue.serverTimestamp() });
    try {
        await sendMessageEmail(
            {
                subject: 'Gear list team updated - ' + (q.number || ''),
                body:
                    ((q.customer || {}).name || 'The customer') +
                    ' updated who gets the gear list for ' +
                    (q.number || '') +
                    ':\n\n' +
                    (gearEmails
                        ? gearEmails
                              .split(', ')
                              .map((e) => '- ' + e)
                              .join('\n')
                        : '(nobody)') +
                    (before ? '\n\nBefore: ' + before : '')
            },
            {},
            { to: process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au' }
        );
    } catch (err) {
        logger.warn('gear team: office email', err && err.message);
    }
    return { gearEmails };
});

/*  PUBLIC: they press Submit. */
exports.submitDetails = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    await limitIp(request, 'details', 20, 60);
    const d = request.data || {};
    const doc = await quoteByDetailsToken(d.token);
    const q = doc.data();
    const clean = (v, n) =>
        String(v == null ? '' : v)
            .trim()
            .slice(0, n);
    const f = {
        name: clean(d.name, 120),
        business: clean(d.business, 120),
        email: clean(d.email, 200).toLowerCase(),
        ccEmail: emailList(d.ccEmail),
        phone: clean(d.phone, 40),
        address: clean(d.address, 300),
        eventName: clean(d.eventName, 160),
        eventDate: clean(d.eventDate, 60),
        eventVenue: clean(d.eventVenue, 200),
        eventStartTime: clean(d.eventStartTime, 20),
        customerNotes: clean(d.customerNotes, 2000),
        dayContact: clean(d.dayContact, 200)
    };
    if (!f.name) throw new HttpsError('invalid-argument', 'Please enter your name.');
    if (!DETAIL_EMAIL_RE.test(f.email)) throw new HttpsError('invalid-argument', 'Please enter a valid email address.');
    if (!f.phone) throw new HttpsError('invalid-argument', 'Please enter a phone number.');
    if (!f.eventName) throw new HttpsError('invalid-argument', 'Please enter the event name.');
    if (!f.eventStartTime) throw new HttpsError('invalid-argument', 'Please enter the event start time.');
    if (!f.eventVenue) throw new HttpsError('invalid-argument', 'Please enter the venue.');
    if (['cancelled', 'declined'].includes(q.status)) throw new HttpsError('failed-precondition', 'This quote is no longer open.');
    if (hasPayDetails(q.customer))
        throw new HttpsError('failed-precondition', 'Your details are already on this quote - call us on 0422 393 022 to change them.');

    const customer = await saveCustomerDetails(doc, q, f);

    /*  PRE-APPROVED: "Send them the quote automatically when
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
                emailCount: FieldValue.increment(1)
            });
        }
    }

    const ready = ['approved', 'sent', 'accepted', 'invoiced', 'paid'].includes(q.status) && q.token;
    return { ok: true, autoSent, quoteLink: ready ? SITE_URL + '/quote?t=' + q.token : '' };
});
