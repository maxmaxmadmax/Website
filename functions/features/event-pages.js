/* SOUNDZGOOD SERVER - event-pages
   Public event pages: the lineup, volunteers, RSVPs.
   Helpers shared with other features come from ../shared.js. */
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { FieldValue } = require('firebase-admin/firestore');
const { sendMessageEmail } = require('../lib/message-email');
const { DETAIL_EMAIL_RE, SMTP_PASS, SMTP_USER, callerIp, db, limitIp } = require('../shared');

/* =========================================================================
   eventLineup - who's coming, for the punters' About page

   GET ?event=<eventId>  ->  { food: [{ name, category, categoryId, link }], market: [...] }

   Bookings are private (they hold contact details and money), so the page
   cannot read them itself. This hands out the business name and its
   category ONLY, and only for vendors who are confirmed AND paid (or
   marked free). Nothing else ever leaves here.
   ========================================================================= */
/*  The vendor's own link, from the "Social media links" box they filled in
    (free text). Only a real web address is used - the first one found,
    https added if they left it off. A bare @handle is skipped: it could
    be Instagram or Facebook, and a wrong guess sends people nowhere.    */
const LINK_ENDINGS = [
    'com',
    'au',
    'net',
    'org',
    'nz',
    'co',
    'io',
    'me',
    'info',
    'biz',
    'shop',
    'store',
    'online',
    'site',
    'page',
    'link',
    'app'
];

/*  One short line about the vendor, in their own words: the first sentence
    of the description they wrote when they booked, cut to fit a card.  */
function lineupBlurb(text) {
    const t = String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!t) return '';
    let first = (t.match(/^.*?[.!?](\s|$)/) || [t])[0].trim();
    if (first.length > 80) first = first.slice(0, 77).replace(/\s+\S*$/, '') + '...';
    return first;
}

function lineupLink(text) {
    // word by word, so an email address (bob@gmail.com) is never taken for a website
    for (const word of String(text || '').split(/[\s,;|]+/)) {
        if (!word || word.includes('@')) continue;
        if (!/^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#]\S*)?$/i.test(word)) continue;
        let url = word.replace(/[).]+$/, '');
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        try {
            const u = new URL(url);
            // a real web ending only - "re.weaved" is an Instagram name, not a site
            const end = u.hostname.split('.').pop();
            if (/^https?:$/.test(u.protocol) && LINK_ENDINGS.includes(end)) return u.href.slice(0, 300);
        } catch (e) {
            /* not a real address - try the next word */
        }
    }
    return '';
}

/*  PUBLIC - "I'm coming" on a free event's page. One tap, how many of you.
    Kept in events/{id}/rsvps (staff only) and counted on the event.      */
exports.rsvpEvent = onCall(async (request) => {
    await limitIp(request, 'rsvp', 5, 60);
    const d = request.data || {};
    const eventId = String(d.eventId || '');
    if (!/^[a-z0-9-]{3,80}$/.test(eventId)) throw new HttpsError('invalid-argument', 'Bad event.');
    const people = Math.min(10, Math.max(1, Math.round(Number(d.people) || 1)));
    const ref = db.collection('events').doc(eventId);
    const snap = await ref.get();
    if (!snap.exists || ['draft', 'archived'].includes(snap.data().status)) throw new HttpsError('not-found', 'That event is not open.');
    await ref.collection('rsvps').add({ people, at: FieldValue.serverTimestamp(), ip: callerIp(request).slice(0, 60) });
    await ref.update({ goingCount: FieldValue.increment(people), goingParties: FieldValue.increment(1) });
    return { ok: true, going: (snap.data().goingCount || 0) + people };
});

/* =========================================================================
   VOLUNTEERS - "Volunteer with us" on the event page. Kept in
   events/{id}/volunteers (staff only); the office gets an email.
   ========================================================================= */
const VOL_ROLES = ['setup', 'packdown', 'gate', 'bar', 'runner', 'kids', 'anything'];
exports.volunteerApply = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    await limitIp(request, 'volunteer', 5, 60);
    const d = request.data || {};
    const clean = (v, n) =>
        String(v == null ? '' : v)
            .trim()
            .slice(0, n);
    const eventId = clean(d.eventId, 80);
    if (!/^[a-z0-9-]{3,80}$/.test(eventId)) throw new HttpsError('invalid-argument', 'Bad event.');
    const f = {
        name: clean(d.name, 120),
        email: clean(d.email, 200).toLowerCase(),
        phone: clean(d.phone, 40),
        roles: (Array.isArray(d.roles) ? d.roles : [])
            .map((r) => String(r))
            .filter((r) => VOL_ROLES.includes(r))
            .slice(0, 7),
        availability: clean(d.availability, 200),
        message: clean(d.message, 1000)
    };
    if (!f.name) throw new HttpsError('invalid-argument', 'Please tell us your name.');
    if (!DETAIL_EMAIL_RE.test(f.email)) throw new HttpsError('invalid-argument', 'Please enter a valid email address.');
    if (!f.phone) throw new HttpsError('invalid-argument', 'Please leave a phone number.');
    const evSnap = await db.collection('events').doc(eventId).get();
    if (!evSnap.exists || ['draft', 'archived'].includes(evSnap.data().status))
        throw new HttpsError('not-found', 'That event is not open.');
    const ev = evSnap.data();
    const dup = await db.collection('events').doc(eventId).collection('volunteers').where('email', '==', f.email).limit(1).get();
    if (!dup.empty) return { ok: true, already: true };
    await db
        .collection('events')
        .doc(eventId)
        .collection('volunteers')
        .add({ ...f, status: 'new', createdAt: FieldValue.serverTimestamp() });
    await sendMessageEmail(
        {
            subject: 'Volunteer: ' + f.name + ' - ' + (ev.name || eventId),
            body:
                f.name +
                ' wants to volunteer at ' +
                (ev.name || eventId) +
                ':\n\n' +
                [
                    'Email: ' + f.email,
                    'Phone: ' + f.phone,
                    f.roles.length && 'Happy to help with: ' + f.roles.join(', '),
                    f.availability && 'Available: ' + f.availability,
                    f.message && 'Message: ' + f.message
                ]
                    .filter(Boolean)
                    .map((x) => '- ' + x)
                    .join('\n') +
                '\n\nSee them in the admin under the event > Volunteers.'
        },
        {},
        { to: process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au' }
    );
    return { ok: true };
});

exports.eventLineup = onRequest({ cors: true }, async (req, res) => {
    const eventId = String(req.query.event || '');
    if (!/^[a-z0-9-]{3,80}$/.test(eventId)) {
        res.status(400).json({ error: 'bad event' });
        return;
    }
    try {
        const [snap, cats, evSnap, progSnap, spSnap] = await Promise.all([
            db.collection('bookings').where('eventId', '==', eventId).where('status', '==', 'confirmed').get(),
            db.collection('events').doc(eventId).collection('categories').get(),
            db.collection('events').doc(eventId).get(),
            db.collection('events').doc(eventId).collection('programme').get(),
            db.collection('sponsors').where('eventId', '==', eventId).get()
        ]);
        if (!evSnap.exists || ['draft', 'archived'].includes(evSnap.data().status)) {
            res.status(404).json({ error: 'no such event' });
            return;
        }
        const catName = {};
        cats.forEach((d) => {
            catName[d.id] = d.data().name || '';
        });
        const out = { food: [], market: [] };
        const seen = new Set();
        snap.forEach((d) => {
            const b = d.data();
            if (!['paid', 'free'].includes(b.paymentStatus)) return;
            const name = String((b.business && b.business.name) || '')
                .trim()
                .slice(0, 60);
            if (!name || seen.has(name.toLowerCase())) return; // one line per business
            seen.add(name.toLowerCase());
            const list = b.vendorType === 'food' ? out.food : out.market;
            list.push({
                name,
                site: String(b.siteLabel || '').slice(0, 10),
                category: String(catName[b.categoryId] || '').slice(0, 40),
                categoryId: String(b.categoryId || '').slice(0, 40),
                blurb: lineupBlurb(b.business && b.business.description),
                link: lineupLink(b.business && b.business.socials)
            });
        });
        // in site order (F1, F2 ... M1, M2 ...), the ones with no site last
        const siteKey = (v) => {
            const m = /^([A-Za-z]+)\s*(\d+)/.exec(v.site);
            return m ? [0, m[1].toUpperCase(), +m[2]] : [1, '', 0];
        };
        const bySite = (a, b) => {
            const x = siteKey(a),
                y = siteKey(b);
            return x[0] - y[0] || x[1].localeCompare(y[1]) || x[2] - y[2] || a.name.localeCompare(b.name);
        };
        out.food.sort(bySite);
        out.market.sort(bySite);

        // THE EVENT: only what a punter may see
        const ev = evSnap.data();
        const n = ev.notice || {};
        out.event = {
            name: ev.name || '',
            subtitle: ev.subtitle || '',
            intro: ev.intro || '',
            entryText: ev.entryText || '',
            dateLabel: ev.dateLabel || '',
            dateISO: ev.dateISO || '',
            venue: ev.venue || '',
            location: ev.location || '',
            startTime: ev.startTime || '',
            finishTime: ev.finishTime || '',
            image: ev.image || '',
            status: ev.status || '',
            going: ev.goingCount || 0,
            faq: (Array.isArray(ev.faq) ? ev.faq : [])
                .slice(0, 12)
                .map((x) => ({ q: String(x.q || '').slice(0, 120), a: String(x.a || '').slice(0, 400) })),
            notice: n.kind ? { kind: n.kind, title: n.title || '', text: n.text || '', was: n.was || '' } : null
        };
        // THE PROGRAMME: times and names, never costs or notes; behind-the-scenes lines stay behind
        const mins = (t) => {
            const r = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
            return r ? (+r[1] < 4 ? +r[1] + 24 : +r[1]) * 60 + +r[2] : 9999;
        };
        out.programme = progSnap.docs
            .map((d) => d.data())
            .filter((p) => p.kind !== 'ops' && String(p.title || '').trim())
            .sort((a, b) => mins(a.start) - mins(b.start) || (a.order || 0) - (b.order || 0))
            .map((p) => {
                const photo = String(p.photo || '');
                const ours =
                    /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[\w.-]+\/o\/event-images%2F[\w.%-]+\?[\w=&.-]+$/.test(photo) ||
                    /^\/images\/[\w./-]+$/.test(photo);
                const link = String(p.link || '');
                return {
                    start: String(p.start || '').slice(0, 5),
                    finish: String(p.finish || '').slice(0, 5),
                    title: String(p.title).slice(0, 120),
                    who: String(p.who || '').slice(0, 120),
                    kind: String(p.kind || 'activity').slice(0, 20),
                    featured: !!p.featured,
                    headline: !!p.headline,
                    blurb: String(p.blurb || '').slice(0, 400),
                    photo: ours ? photo : '',
                    link: /^https:\/\/[^\s'"()<>]+$/.test(link) ? link.slice(0, 300) : ''
                };
            });
        // THE SPONSORS who said yes
        out.sponsors = spSnap.docs
            .map((d) => d.data())
            .filter((p) => p.status === 'yes' && p.business)
            .map((p) => {
                const logo = String(p.logo || '');
                const ok =
                    /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[\w.-]+\/o\/sponsor-logos%2F[\w.%-]+\?[\w=&.-]+$/.test(logo) ||
                    /^https:\/\/www\.google\.com\/s2\/favicons\?domain=[\w.%-]+&sz=\d+$/.test(logo) ||
                    /^\/images\/[\w./-]+$/.test(logo);
                return {
                    business: String(p.business).slice(0, 80),
                    level: String(p.level || '').slice(0, 30),
                    logo: ok ? logo : '',
                    website: /^https?:\/\/[^\s'"()<>]+$/.test(String(p.website || '')) ? String(p.website).slice(0, 200) : ''
                };
            });

        res.set('Cache-Control', 'public, max-age=60'); // a minute, so a last-minute notice shows quickly
        res.json(out);
    } catch (e) {
        logger.error('eventLineup', e);
        res.status(500).json({ error: 'failed' });
    }
});
