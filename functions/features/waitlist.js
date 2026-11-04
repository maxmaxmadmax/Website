/* SOUNDZGOOD SERVER - waitlist
   The vendor waitlist.
   Helpers shared with other features come from ../shared.js. */
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const crypto = require('crypto');
const { sendMessageEmail } = require('../lib/message-email');
const { MSG_TZ, SITE_URL, SMTP_PASS, SMTP_USER, db, limitIp, requireAuth, siteRef } = require('../shared');

/* =========================================================================
   VENDOR WAITLIST

   When a vendor type sells out, the vendor page offers "Join the waitlist".
   When a spot opens, the FIRST person waiting is emailed and that spot is
   reserved for them for 4 HOURS (the site is held with waitlistHold, so it
   still reads as sold out to everyone else). From the email they can:
     Accept  -> the vendor page, signed in, their site already held for them.
                The spot is NOT theirs until they pay - same checkout as
                everyone else.
     Decline -> the next person is offered it straight away.
   No answer in 4 hours -> the next person. A claimed spot not paid for by the
   end of the 4 hours -> the next person.
   The offer email is the "Waitlist - a spot opened" message in Messages and
   only goes once Max has approved its wording.

   waitlist/{id}: eventId, vendorType, name, contactName, email, phone,
     description, status waiting | offered | claimed | booked | declined |
     expired, siteId, siteLabel, token, offeredAt, offerExpiresAt, claimedUid
   ========================================================================= */
const WAITLIST_HOURS = 4;
const WAITLIST_URL = process.env.WAITLIST_URL || 'https://waitlistrespond-4smug72szq-ts.a.run.app';

/*  The vendor page: join. No account needed; one entry per email per type. */
exports.joinWaitlist = onCall(async (request) => {
    await limitIp(request, 'waitlist', 10, 60);
    const d = request.data || {};
    const clean = (v, n) =>
        String(v == null ? '' : v)
            .trim()
            .slice(0, n);
    const eventId = clean(d.eventId, 100);
    const vendorType = d.vendorType === 'food' ? 'food' : d.vendorType === 'market' ? 'market' : '';
    const email = clean(d.email, 200).toLowerCase();
    const entry = {
        eventId,
        vendorType,
        email,
        name: clean(d.name, 120),
        contactName: clean(d.contactName, 120),
        phone: clean(d.phone, 40),
        description: clean(d.description, 300)
    };
    if (!eventId || !vendorType) throw new HttpsError('invalid-argument', 'Missing event or vendor type.');
    if (!entry.name || !entry.contactName) throw new HttpsError('invalid-argument', 'Please fill in your business and your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError('invalid-argument', 'Please enter a valid email address.');
    const evSnap = await db.collection('events').doc(eventId).get();
    if (!evSnap.exists) throw new HttpsError('not-found', 'That event does not exist.');

    const same = await db.collection('waitlist').where('eventId', '==', eventId).get();
    const mine = same.docs.find(
        (x) => x.data().email === email && x.data().vendorType === vendorType && ['waiting', 'offered', 'claimed'].includes(x.data().status)
    );
    const waiting = same.docs.filter((x) => x.data().vendorType === vendorType && x.data().status === 'waiting');
    if (mine) {
        return { ok: true, already: true, position: Math.max(1, waiting.findIndex((x) => x.id === mine.id) + 1) };
    }
    await db.collection('waitlist').add({ ...entry, status: 'waiting', createdAt: FieldValue.serverTimestamp() });
    return { ok: true, position: waiting.length + 1 };
});

/*  Release a waitlist hold on a site (if it is still ours). */
async function releaseWaitlistSite(eventId, siteId, entryId, claimedUid) {
    if (!eventId || !siteId) return;
    const ref = siteRef(eventId, siteId);
    await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists) return;
        const x = s.data();
        if (x.status !== 'held') return;
        const ours = x.heldBy === 'waitlist:' + entryId || (claimedUid && x.heldBy === claimedUid && x.waitlistHold);
        if (!ours) return;
        tx.update(ref, {
            status: 'available',
            heldBy: FieldValue.delete(),
            holdExpiresAt: FieldValue.delete(),
            waitlistHold: FieldValue.delete(),
            bookingId: FieldValue.delete()
        });
    });
}

/*  The offer email, from the approved "Waitlist - a spot opened" message. */
async function sendWaitlistOffer(entryRef, entry, ev, msg, siteLabel, token, expires) {
    const when = expires.toLocaleString('en-AU', {
        timeZone: MSG_TZ,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit'
    });
    const values = {
        vendor_name: entry.contactName || entry.name || 'there',
        business_name: entry.name || '',
        site_number: siteLabel || '',
        event_name: ev.name || '',
        event_date: ev.dateLabel || ev.dateISO || '',
        event_venue: [ev.venue, ev.location].filter(Boolean).join(', '),
        expires_at: when,
        guide_link: ''
    };
    return sendMessageEmail({ subject: msg.approvedSubject || msg.subject, body: msg.approvedBody || msg.body }, values, {
        to: entry.email,
        actions: [
            { label: 'Accept & book my spot', url: SITE_URL + '/vendor-signup?claim=' + token, primary: true },
            { label: 'No thanks - decline', url: WAITLIST_URL + '?t=' + token + '&a=decline' }
        ],
        note: 'This spot is held for you until ' + when + '. It is only yours once payment is received.'
    });
}

/*  The work, every 2 minutes: expire old offers, mark bookings, offer spots. */
async function waitlistTick() {
    const now = Date.now();
    const snap = await db.collection('waitlist').where('status', 'in', ['waiting', 'offered', 'claimed']).get();
    if (snap.empty) return;
    const byEvent = {};
    snap.docs.forEach((d) => {
        (byEvent[d.data().eventId] = byEvent[d.data().eventId] || []).push(d);
    });

    for (const eventId of Object.keys(byEvent)) {
        try {
            const evSnap = await db.collection('events').doc(eventId).get();
            if (!evSnap.exists) continue;
            const ev = evSnap.data();
            const entries = byEvent[eventId];

            // 1. offers / claims: booked, or out of time
            for (const d of entries) {
                const w = d.data();
                if (w.status !== 'offered' && w.status !== 'claimed') continue;
                if (w.status === 'claimed' && w.claimedUid) {
                    const bk = await db.collection('bookings').where('uid', '==', w.claimedUid).get();
                    if (bk.docs.some((b) => b.data().eventId === eventId && b.data().status === 'confirmed')) {
                        await d.ref.update({ status: 'booked', bookedAt: FieldValue.serverTimestamp() });
                        continue;
                    }
                }
                const exp = w.offerExpiresAt && w.offerExpiresAt.toMillis ? w.offerExpiresAt.toMillis() : 0;
                if (exp && exp <= now) {
                    await d.ref.update({ status: 'expired', expiredAt: FieldValue.serverTimestamp() });
                    await releaseWaitlistSite(eventId, w.siteId, d.id, w.claimedUid);
                }
            }

            // 2. offer free spots to the next people - only once Max approved the email
            const ms = await db.collection('messages').where('eventId', '==', eventId).get();
            const msgDoc = ms.docs.find((x) => x.data().system === 'waitlist');
            const msg = msgDoc && msgDoc.data();
            if (!msg || msg.status !== 'approved' || ev.status !== 'open') continue;

            const fresh = await db.collection('waitlist').where('eventId', '==', eventId).get();
            const waiting = fresh.docs
                .filter((x) => x.data().status === 'waiting')
                .sort(
                    (a, b) =>
                        ((a.data().createdAt && a.data().createdAt.toMillis()) || 0) -
                        ((b.data().createdAt && b.data().createdAt.toMillis()) || 0)
                );
            if (!waiting.length) continue;

            const sitesSnap = await db.collection('events').doc(eventId).collection('sites').get();
            for (const type of ['food', 'market']) {
                const queue = waiting.filter((x) => x.data().vendorType === type);
                if (!queue.length) continue;
                const free = sitesSnap.docs.filter((s) => {
                    const x = s.data();
                    if (x.type !== type) return false;
                    if (x.status === 'available' || !x.status) return true;
                    return x.status === 'held' && x.holdExpiresAt && x.holdExpiresAt.toMillis() <= now;
                });
                for (const site of free) {
                    const next = queue.shift();
                    if (!next) break;
                    const token = crypto.randomBytes(16).toString('hex');
                    const expires = new Date(now + WAITLIST_HOURS * 3600 * 1000);
                    const got = await db.runTransaction(async (tx) => {
                        const s = await tx.get(site.ref);
                        const x = s.data();
                        const isFree =
                            x.status === 'available' ||
                            !x.status ||
                            (x.status === 'held' && x.holdExpiresAt && x.holdExpiresAt.toMillis() <= Date.now());
                        if (!isFree) return false;
                        tx.update(site.ref, {
                            status: 'held',
                            heldBy: 'waitlist:' + next.id,
                            waitlistHold: true,
                            holdExpiresAt: Timestamp.fromDate(expires),
                            bookingId: FieldValue.delete()
                        });
                        tx.update(next.ref, {
                            status: 'offered',
                            siteId: site.id,
                            siteLabel: x.label || site.id,
                            token,
                            offeredAt: FieldValue.serverTimestamp(),
                            offerExpiresAt: Timestamp.fromDate(expires)
                        });
                        return true;
                    });
                    if (!got) {
                        queue.unshift(next);
                        continue;
                    }
                    const mail = await sendWaitlistOffer(next.ref, next.data(), ev, msg, site.data().label || site.id, token, expires);
                    await next.ref.update({
                        offerEmailOk: !!mail.sent,
                        offerEmailError: mail.sent ? '' : String(mail.error || mail.reason || '')
                    });
                    if (mail.sent && msgDoc) await msgDoc.ref.update({ sentCount: FieldValue.increment(1) });
                    logger.info('waitlist offer', { eventId, entry: next.id, site: site.id, sent: !!mail.sent });
                }
            }
        } catch (err) {
            logger.error('waitlist tick failed', { eventId, message: err && err.message });
        }
    }
}

exports.waitlistTick = onSchedule({ schedule: 'every 2 minutes', secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 }, async () => {
    await waitlistTick();
});

/*  Accept (from the vendor page, signed in): the held site moves to them. */
exports.claimWaitlist = onCall(async (request) => {
    const uid = requireAuth(request);
    const token = String((request.data || {}).token || '').trim();
    if (!/^[a-f0-9]{20,40}$/.test(token)) throw new HttpsError('invalid-argument', 'That link is not valid.');
    const snap = await db.collection('waitlist').where('token', '==', token).limit(1).get();
    if (snap.empty) throw new HttpsError('not-found', 'That link is not valid.');
    const ref = snap.docs[0].ref;
    return db.runTransaction(async (tx) => {
        const w = (await tx.get(ref)).data();
        const exp = w.offerExpiresAt && w.offerExpiresAt.toMillis ? w.offerExpiresAt.toMillis() : 0;
        if (w.status === 'booked') throw new HttpsError('failed-precondition', 'You have already booked this spot - thank you!');
        if (!['offered', 'claimed'].includes(w.status) || exp <= Date.now()) {
            throw new HttpsError('failed-precondition', 'Sorry - this offer has run out and has been passed to the next person.');
        }
        const sRef = siteRef(w.eventId, w.siteId);
        const s = (await tx.get(sRef)).data() || {};
        const ours = s.status === 'held' && (s.heldBy === 'waitlist:' + ref.id || s.heldBy === uid || s.heldBy === w.claimedUid);
        if (!ours) throw new HttpsError('failed-precondition', 'Sorry - this spot is no longer available.');
        tx.update(sRef, { heldBy: uid, waitlistHold: true, holdExpiresAt: w.offerExpiresAt });
        tx.update(ref, { status: 'claimed', claimedUid: uid, claimedAt: FieldValue.serverTimestamp() });
        return {
            ok: true,
            eventId: w.eventId,
            vendorType: w.vendorType,
            siteId: w.siteId,
            siteLabel: w.siteLabel,
            expiresAt: exp,
            name: w.name,
            contactName: w.contactName,
            email: w.email,
            phone: w.phone,
            description: w.description
        };
    });
});

/*  Decline (link in the email) - the next person is offered it. */
exports.waitlistRespond = onRequest(async (req, res) => {
    const token = String(req.query.t || '').trim();
    const page = (title, msg) =>
        res
            .status(200)
            .send(
                '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial;padding:40px;text-align:center;background:#f4f4f5"><div style="max-width:480px;margin:auto;background:#fff;padding:30px;border-radius:12px"><p style="color:#ff6b00;letter-spacing:2px;font-size:12px">SOUNDZGOOD WHITSUNDAYS</p><h2>' +
                    title +
                    '</h2><p style="color:#666">' +
                    msg +
                    '</p></div></body>'
            );
    if (!/^[a-f0-9]{20,40}$/.test(token)) return page('That link is not valid.', '');
    const snap = await db.collection('waitlist').where('token', '==', token).limit(1).get();
    if (snap.empty) return page('That link is not valid.', '');
    const d = snap.docs[0];
    const w = d.data();
    if (!['offered', 'claimed'].includes(w.status)) return page('All sorted.', 'This offer has already been answered.');
    // email scanners open links by themselves -
    // opening the link only asks; pressing the button gives the spot up.
    if (req.method !== 'POST')
        return page(
            'Give up this spot?',
            'If you can&rsquo;t make it, press the button and we&rsquo;ll offer the spot to the next vendor.<form method="post" style="margin-top:18px"><button style="background:#111;color:#fff;border:0;padding:12px 22px;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer">Yes, decline the spot</button></form>'
        );
    await d.ref.update({ status: 'declined', declinedAt: FieldValue.serverTimestamp() });
    await releaseWaitlistSite(w.eventId, w.siteId, d.id, w.claimedUid);
    return page(
        'No worries - thanks for letting us know.',
        'We have passed the spot on to the next vendor. We hope to see you at a future event!'
    );
});
