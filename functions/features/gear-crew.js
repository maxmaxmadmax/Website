/* SOUNDZGOOD SERVER - gear-crew
   Gear lists and crew for a job.
   Helpers shared with other features come from ../shared.js. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');
const { sendMessageEmail } = require('../lib/message-email');
const {
    DETAIL_EMAIL_RE,
    MSG_TZ,
    SITE_URL,
    SMTP_PASS,
    SMTP_USER,
    addDaysISO,
    brisbaneTodayISO,
    db,
    emailList,
    listOpen,
    pickReady,
    requireAdmin,
    sendGearListEmail
} = require('../shared');

/* =========================================================================
   EMAIL THE GEAR LIST (no prices) to the band / crew
   Goes to the quote's "Gear list to" emails (customer.gearEmails) - never
   the billing CC. Links to the pick list in read-only gear view.
   ========================================================================= */
exports.adminSendGearList = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    requireAdmin(request);
    const ref = db.collection('quotes').doc(String((request.data || {}).id || ''));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'No such quote.');
    const q = snap.data();
    if (!listOpen(q)) throw new HttpsError('failed-precondition', 'This quote is cancelled.');
    // TEST: the gear list + the pick list email, both to the signed-in admin only
    if ((request.data || {}).test === true) {
        const me = String(request.auth.token.email || '');
        if (!me) throw new HttpsError('failed-precondition', 'Your admin login has no email address.');
        const r = await sendGearListEmail(ref, q, 'deposit', me);
        return { ...r, to: me, test: true };
    }
    const to = emailList((q.customer || {}).gearEmails);
    if (!to) throw new HttpsError('failed-precondition', 'Add the band / crew emails in "Gear list to" on the quote first.');
    const r = await sendGearListEmail(ref, q, 'manual');
    return { ...r, to };
});

/* =========================================================================
   GEAR LIST - AUTOMATIC
   Sent when the deposit is paid, 3 days before the event and on the day.
   The band / crew in "Gear list to" get the gear list (no prices); the
   office gets the pick list link (with ticks) for staff. Nothing goes
   before the deposit is in. If the event date moves, the reminders follow.
   ========================================================================= */

/*  "Tue 20 Oct 2026" or "2026-10-20" -> "2026-10-20"; falls back to the hire start. */
function quoteEventISO(q) {
    const raw = String((q.customer || {}).eventDate || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(raw);
    if (m && MON.indexOf(m[2].toLowerCase()) >= 0) {
        return m[3] + '-' + String(MON.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
    }
    return (q.hire && q.hire.startDate) || '';
}

/* GEAR + PICK LIST REMINDERS for jobs 3 days out and jobs on today: staff get the pick list at 6am
   (booked jobs, 3 days out and on the day); the customer's team gets the gear list at 9:35am 3 days out
   only - accepted jobs too, not just booked ones (Max, 18 Nov 2026). Each part is marked once sent
   ("staff_" / "gear_" + reason + date), and the 9:35 run also sends any
   staff list the 6am run missed. Older jobs with one shared key count as
   done. */
async function runGearReminders(which) {
    const today = brisbaneTodayISO();
    const snap = await db.collection('quotes').where('status', 'in', ['invoiced', 'paid']).get();
    for (const doc of snap.docs) {
        const q = doc.data();
        const booked = pickReady(q);
        if (!(booked || q.acceptedAt) || q.archived) continue;
        const ev = quoteEventISO(q);
        if (!ev) continue;
        const reason = addDaysISO(ev, -3) === today ? '3days' : ev === today ? 'today' : '';
        if (!reason) continue;
        const key = reason + '_' + ev; // a new date = new reminders
        const done = q.gearReminders || {};
        const old = !!done[key];
        const needStaff = booked && !old && !done['staff_' + key];
        // the team's copy: 3 days out only, and not twice in a day (accepted today = already sent)
        const sentToday =
            q.gearAutoAcceptAt && new Intl.DateTimeFormat('en-CA', { timeZone: MSG_TZ }).format(q.gearAutoAcceptAt.toDate()) === today;
        const needGear = which === 'customers' && reason === '3days' && !sentToday && !old && !done['gear_' + key];
        if (!needStaff && !needGear) continue;
        try {
            await doc.ref.update({
                ...(needStaff ? { ['gearReminders.staff_' + key]: FieldValue.serverTimestamp() } : {}),
                ...(needGear ? { ['gearReminders.gear_' + key]: FieldValue.serverTimestamp() } : {})
            });
            await sendGearListEmail(doc.ref, q, reason, undefined, { staff: needStaff, gear: needGear });
        } catch (err) {
            logger.error('gear list reminder', { id: doc.id, which, err: err && err.message });
        }
    }
}
// 6am: the staff pick lists (office + the crew on the job)
exports.staffPickLists = onSchedule(
    { schedule: '0 6 * * *', timeZone: MSG_TZ, secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 },
    async () => runGearReminders('staff')
);
// 9:35am: the customer / band gear lists, plus any staff list not sent yet
exports.gearListReminders = onSchedule(
    { schedule: '35 9 * * *', timeZone: MSG_TZ, secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 },
    async () => runGearReminders('customers')
);

/* =========================================================================
   ASSIGN CREW TO A JOB
   From the dashboard: tick the staff (Crew & Vehicles) working a job. The
   names go on the quote (crewAssigned) and anyone NEWLY added with an email
   gets the job details + their pick list link. The admin confirms before
   it sends.
   A gig night (bookingId) keeps its crew in gigCrew/ - the booking itself
   is public. Its pick list is the night's pub invoice, once there is one.
   ========================================================================= */
async function gigAsJob(bookingId) {
    const b = await db.collection('talentSchedule').doc(bookingId).get();
    if (!b.exists) throw new HttpsError('not-found', 'No such gig.');
    const g = b.data();
    const t = await db
        .collection('talent')
        .doc(String(g.slug || '_'))
        .get();
    const act = (t.exists && t.data().name) || g.slug || 'DJ';
    const inv = await db.collection('quotes').where('pubBookings', 'array-contains', bookingId).limit(1).get();
    const q = inv.empty ? null : inv.docs[0];
    return {
        ref: db.collection('gigCrew').doc(bookingId),
        pick: q && q.data().status !== 'cancelled' ? q : null,
        customer: {
            eventName: 'Setup - ' + String(g.venue || '').split(',')[0] + ' (' + act + ')',
            eventStartTime: g.time || '',
            eventVenue: g.venue || ''
        },
        date: g.date || ''
    };
}
exports.adminAssignCrew = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    requireAdmin(request);
    const d = request.data || {};
    let ref, q;
    if (d.bookingId) {
        const g = await gigAsJob(String(d.bookingId));
        ref = g.ref;
        const had = await ref.get();
        q = {
            ...(had.exists ? had.data() : {}),
            customer: g.customer,
            hire: { startDate: g.date },
            crewToken: g.pick ? g.pick.data().crewToken : null
        };
        q.pickRef = g.pick ? g.pick.ref : null;
    } else {
        ref = db.collection('quotes').doc(String(d.id || ''));
        const snap = await ref.get();
        if (!snap.exists) throw new HttpsError('not-found', 'No such job.');
        q = snap.data();
    }
    const ids = (Array.isArray(d.staffIds) ? d.staffIds : []).map(String).slice(0, 20);
    const staff = [];
    for (const sid of ids) {
        const r = await db.collection('resources').doc(sid).get();
        if (r.exists && (r.data().type || 'staff') === 'staff') {
            const x = r.data();
            staff.push({ id: sid, name: String(x.name || ''), email: String(x.email || '').trim(), phone: String(x.phone || '') });
        }
    }
    let token = q.crewToken;
    const update = { crewAssigned: staff, crewAssignedAt: FieldValue.serverTimestamp() };
    if (d.bookingId) {
        await ref.set(update, { merge: true });
        if (!token && q.pickRef) {
            token = crypto.randomBytes(16).toString('hex');
            await q.pickRef.update({ crewToken: token });
        }
    } else {
        if (!token) {
            token = crypto.randomBytes(16).toString('hex');
            update.crewToken = token;
        }
        await ref.update(update);
    }

    // email the people who are new on this job
    const before = new Set((q.crewAssigned || []).map((x) => x.id));
    const fresh = staff.filter((x) => !before.has(x.id));
    const c = q.customer || {};
    const ev = c.eventName || c.business || c.name || 'a job';
    const when = c.eventDate || (q.hire && q.hire.startDate) || '';
    const link = token ? SITE_URL + '/picklist?t=' + token : ''; // staff always get the pick list, not the gear list
    const sent = [],
        noEmail = [],
        failed = [];
    for (const x of fresh) {
        if (!DETAIL_EMAIL_RE.test(x.email)) {
            noEmail.push(x.name);
            continue;
        }
        const r = await sendMessageEmail(
            {
                subject: "You're on: " + ev + (when ? ' (' + when + ')' : ''),
                body:
                    'Hi ' +
                    (x.name.split(' ')[0] || 'there') +
                    ',\n\nYou are on this job:\n\n' +
                    [
                        'Job: ' + ev,
                        when && 'Date: ' + when,
                        c.soundcheckTime && 'Soundcheck: ' + c.soundcheckTime,
                        c.eventStartTime && 'Starts: ' + c.eventStartTime,
                        c.eventEndTime && 'Finishes: ' + c.eventEndTime,
                        c.eventVenue && 'Venue: ' + c.eventVenue,
                        c.dayContact && 'On the day: ' + c.dayContact,
                        'Crew: ' + staff.map((s) => s.name).join(', ')
                    ]
                        .filter(Boolean)
                        .map((t) => '- ' + t)
                        .join('\n') +
                    (link ? '\n\nThe pick list is below - tick things off as you pack and when they come back.' : '') +
                    '\n\nThanks,\nMax\nSoundzGood Whitsundays - 0422 393 022'
            },
            {},
            { to: x.email, actions: link ? [{ label: 'Open the pick list', url: link, primary: true }] : [] }
        );
        (r.sent ? sent : failed).push(x.name);
    }
    return { ok: true, assigned: staff.map((x) => x.name), sent, noEmail, failed };
});
