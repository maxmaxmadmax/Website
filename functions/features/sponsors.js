/* SOUNDZGOOD SERVER - sponsors
   Sponsorship outreach and the sponsor directory.
   Helpers shared with other features come from ../shared.js. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');
const { sendMessageEmail } = require('../lib/message-email');
const { MSG_TZ, SMTP_PASS, SMTP_USER, SPONSOR_NOTE, db, limitIp, requireAdmin, sponsorLink, sponsorValues } = require('../shared');

/* =========================================================================
   SPONSORSHIP OUTREACH

   Messages > Sponsors: Max adds businesses (Lead Generator, typed in, past
   sponsors), ticks who to ask and presses Send. Each gets the approved
   "Sponsorship - the ask" email with a personal link to /sponsor. Anyone
   still "Asked" 7 days later gets the approved follow-up at 9:35 am. The
   sponsor page's "I'm interested" form lands back here and emails the office.

   sponsors/{id}: eventId, business, contactName, email, phone, source,
     status todo | asked | interested | yes | no, level, amountCents, notes,
     message, token, askedAt, followedUpAt, interestedAt
   KEEP IN STEP: SPONSOR_LEVELS in js/site/sponsor-data.js (same keys / spots).
   ========================================================================= */
const SPONSOR_LEVELS = {
    platinum: { name: 'Platinum - Presenting Partner', priceCents: 500000, spots: 1 },
    gold: { name: 'Gold', priceCents: 200000, spots: 2 },
    silver: { name: 'Silver', priceCents: 100000, spots: 3 },
    bronze: { name: 'Bronze', priceCents: 50000, spots: 5 },
    supporter: { name: 'Supporter', priceCents: 0, spots: 0 }
};

/*  PUBLIC: the sponsor page - event, spots left per level, and (personal link) who they are. */
exports.getSponsorInfo = onCall(async (request) => {
    await limitIp(request, 'tok', 120, 60);
    const { eventId, token } = request.data || {};
    const id = String(eventId || '').trim();
    if (!id) throw new HttpsError('invalid-argument', 'Missing event.');
    const evSnap = await db.collection('events').doc(id).get();
    if (!evSnap.exists) throw new HttpsError('not-found', 'That event does not exist.');
    const ev = evSnap.data();
    const snap = await db.collection('sponsors').where('eventId', '==', id).get();
    const taken = {};
    let prospect = null;
    snap.forEach((d) => {
        const x = d.data();
        if (x.status === 'yes' && x.level) taken[x.level] = (taken[x.level] || 0) + 1;
        if (token && /^[a-f0-9]{20,40}$/.test(String(token)) && x.token === token) {
            const ownLogo =
                /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[\w.-]+\/o\/sponsor-logos%2F[\w.%-]+\?[\w=&.-]+$/.test(
                    String(x.logo || '')
                ) || /^https:\/\/www\.google\.com\/s2\/favicons\?domain=[\w.%-]+&sz=\d+$/.test(String(x.logo || ''));
            prospect = {
                business: x.business || '',
                contactName: x.contactName || '',
                email: x.email || '',
                phone: x.phone || '',
                logo: ownLogo ? x.logo : '',
                color: /^#[0-9a-f]{6}$/i.test(String(x.color || '')) ? x.color : '',
                website: String(x.website || '').slice(0, 200)
            };
        }
    });
    const left = {};
    Object.keys(SPONSOR_LEVELS).forEach((k) => {
        left[k] = Math.max(0, SPONSOR_LEVELS[k].spots - (taken[k] || 0));
    });
    return {
        event: {
            name: ev.name || '',
            dateLabel: ev.dateLabel || '',
            dateISO: ev.dateISO || '',
            venue: ev.venue || '',
            location: ev.location || '',
            image: ev.image || ''
        },
        left,
        prospect
    };
});

/*  PUBLIC: "I'm interested" from the sponsor page. */
exports.sponsorInterest = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    await limitIp(request, 'sponsor', 10, 60);
    const d = request.data || {};
    const clean = (v, n) =>
        String(v == null ? '' : v)
            .trim()
            .slice(0, n);
    const eventId = clean(d.eventId, 100);
    const email = clean(d.email, 200).toLowerCase();
    const level = SPONSOR_LEVELS[d.level] ? d.level : 'supporter';
    const fields = {
        business: clean(d.business, 160),
        contactName: clean(d.contactName, 120),
        email,
        phone: clean(d.phone, 40),
        level,
        message: clean(d.message, 2000)
    };
    if (!eventId) throw new HttpsError('invalid-argument', 'Missing event.');
    if (!fields.business || !fields.contactName) throw new HttpsError('invalid-argument', 'Please fill in your business and your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError('invalid-argument', 'Please enter a valid email address.');
    const evSnap = await db.collection('events').doc(eventId).get();
    if (!evSnap.exists) throw new HttpsError('not-found', 'That event does not exist.');
    const ev = evSnap.data();

    const snap = await db.collection('sponsors').where('eventId', '==', eventId).get();
    const token = String(d.token || '');
    const match = token ? snap.docs.find((x) => x.data().token === token) : null;
    const update = { ...fields, interestedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    if (match) {
        if (match.data().status !== 'yes') update.status = 'interested';
        await match.ref.update(update);
    } else {
        await db
            .collection('sponsors')
            .add({ ...update, eventId, source: 'website', status: 'interested', createdAt: FieldValue.serverTimestamp() });
    }

    // tell the office straight away
    const lv = SPONSOR_LEVELS[level];
    await sendMessageEmail(
        {
            subject: 'Sponsor interest: ' + fields.business + ' - ' + lv.name,
            body:
                'New sponsor interest for ' +
                (ev.name || eventId) +
                ':\n\n' +
                '- Business: ' +
                fields.business +
                '\n- Contact: ' +
                fields.contactName +
                '\n- Email: ' +
                email +
                (fields.phone ? '\n- Phone: ' + fields.phone : '') +
                '\n- Level: ' +
                lv.name +
                (lv.priceCents ? ' ($' + (lv.priceCents / 100).toLocaleString('en-AU') + ' + GST)' : '') +
                (fields.message ? '\n\nTheir message:\n' + fields.message : '') +
                '\n\nSee it in the admin under Messages > Sponsors.'
        },
        {},
        { to: process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au' }
    );
    return { ok: true };
});

/*  Send "the ask" to the ticked businesses (admin). */
exports.adminSponsorSend = onCall({ secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 }, async (request) => {
    requireAdmin(request);
    const { eventId, ids } = request.data || {};
    const evId = String(eventId || '');
    const ms = await db.collection('messages').where('eventId', '==', evId).get();
    const msgDoc = ms.docs.find((x) => x.data().system === 'sponsor-ask');
    const msg = msgDoc && msgDoc.data();
    if (!msg || msg.status !== 'approved') throw new HttpsError('failed-precondition', 'Approve the "Sponsorship - the ask" email first.');
    const evSnap = await db.collection('events').doc(evId).get();
    const ev = evSnap.exists ? evSnap.data() : {};
    const out = { sent: 0, skipped: 0, failed: [] };
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 200)) {
        const ref = db.collection('sponsors').doc(String(id));
        const snap = await ref.get();
        if (!snap.exists) {
            out.skipped++;
            continue;
        }
        const p = snap.data();
        if (p.eventId !== evId || !p.email || p.status !== 'todo') {
            out.skipped++;
            continue;
        }
        const token = p.token || crypto.randomBytes(16).toString('hex');
        const r = await sendMessageEmail(
            { subject: msg.approvedSubject || msg.subject, body: msg.approvedBody || msg.body },
            sponsorValues(p, ev),
            {
                to: p.email,
                actions: [{ label: 'See the sponsor options', url: sponsorLink(evId, token), primary: true }],
                note: SPONSOR_NOTE
            }
        );
        if (r.sent) {
            out.sent++;
            await ref.update({ status: 'asked', token, askedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
        } else out.failed.push((p.business || id) + ': ' + (r.error || r.reason || 'not sent'));
    }
    if (out.sent && msgDoc) await msgDoc.ref.update({ sentCount: FieldValue.increment(out.sent) });
    return out;
});

/*  Every morning at 9:35 am: a polite follow-up 7 days after the ask (approved email only). */
exports.sponsorFollowups = onSchedule(
    { schedule: '35 9 * * *', timeZone: MSG_TZ, secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 },
    async () => {
        const msgs = await db.collection('messages').where('status', '==', 'approved').get();
        for (const md of msgs.docs) {
            const msg = md.data();
            if (msg.system !== 'sponsor-followup') continue;
            try {
                const evSnap = await db.collection('events').doc(msg.eventId).get();
                const ev = evSnap.exists ? evSnap.data() : {};
                const days = Math.max(1, Number((msg.trigger || {}).days) || 7);
                const cutoff = Date.now() - days * 86400000;
                const snap = await db.collection('sponsors').where('eventId', '==', msg.eventId).get();
                let sent = 0;
                for (const d of snap.docs) {
                    const p = d.data();
                    const asked = p.askedAt && p.askedAt.toMillis ? p.askedAt.toMillis() : 0;
                    if (p.status !== 'asked' || !asked || asked > cutoff || p.followedUpAt || !p.email) continue;
                    const r = await sendMessageEmail(
                        { subject: msg.approvedSubject || msg.subject, body: msg.approvedBody || msg.body },
                        sponsorValues(p, ev),
                        {
                            to: p.email,
                            actions: [{ label: 'See the sponsor options', url: sponsorLink(msg.eventId, p.token), primary: true }],
                            note: SPONSOR_NOTE
                        }
                    );
                    if (r.sent) {
                        sent++;
                        await d.ref.update({ followedUpAt: FieldValue.serverTimestamp() });
                    }
                }
                if (sent) await md.ref.update({ sentCount: FieldValue.increment(sent) });
            } catch (err) {
                logger.error('sponsor follow-ups failed', { id: md.id, message: err && err.message });
            }
        }
    }
);

/* =========================================================================
   SPONSOR DIRECTORY - finding and sizing up businesses (admin only)

   findBusinesses: "car dealers" / "cafes" / a name -> businesses around
   Bowen from OpenStreetMap (free, no key): name, website, phone, address.
   lookupBusiness: their website -> logo, blurb, Facebook, Instagram.
   ========================================================================= */
const BOWEN = { lat: -20.0137, lon: 148.2476 };
const OSM_KINDS = {
    car: 'shop=car',
    'car dealer': 'shop=car',
    mechanic: 'shop=car_repair',
    tyre: 'shop=tyres',
    auto: 'shop=car_repair',
    cafe: 'amenity=cafe',
    coffee: 'amenity=cafe',
    restaurant: 'amenity=restaurant',
    takeaway: 'amenity=fast_food',
    pub: 'amenity=pub',
    hotel: 'tourism=hotel',
    motel: 'tourism=motel',
    bar: 'amenity=bar',
    caravan: 'tourism=caravan_site',
    accommodation: 'tourism=hotel',
    resort: 'tourism=hotel',
    supermarket: 'shop=supermarket',
    bakery: 'shop=bakery',
    butcher: 'shop=butcher',
    bottle: 'shop=alcohol',
    liquor: 'shop=alcohol',
    newsagent: 'shop=newsagent',
    chemist: 'amenity=pharmacy',
    pharmacy: 'amenity=pharmacy',
    hardware: 'shop=hardware',
    electrical: 'shop=electronics',
    furniture: 'shop=furniture',
    clothing: 'shop=clothes',
    florist: 'shop=florist',
    jewel: 'shop=jewelry',
    gift: 'shop=gift',
    print: 'shop=copyshop',
    hair: 'shop=hairdresser',
    beauty: 'shop=beauty',
    gym: 'leisure=fitness_centre',
    fitness: 'leisure=fitness_centre',
    'real estate': 'office=estate_agent',
    estate: 'office=estate_agent',
    accountant: 'office=accountant',
    lawyer: 'office=lawyer',
    solicitor: 'office=lawyer',
    insurance: 'office=insurance',
    bank: 'amenity=bank',
    dentist: 'amenity=dentist',
    doctor: 'amenity=doctors',
    medical: 'amenity=doctors',
    vet: 'amenity=veterinary',
    physio: 'healthcare=physiotherapist',
    fuel: 'amenity=fuel',
    servo: 'amenity=fuel',
    boat: 'shop=boat',
    marine: 'shop=boat',
    fishing: 'shop=fishing',
    bike: 'shop=bicycle',
    builder: 'craft=builder',
    electrician: 'craft=electrician',
    plumber: 'craft=plumber',
    school: 'amenity=school',
    club: 'club',
    sports: 'leisure=sports_centre',
    farm: 'landuse=farmland'
};
const UA = 'SoundzGood admin (info@soundzgood.com.au)';
const BOX = '147.90,-19.80,148.60,-20.30'; // the Bowen area: west,north,east,south
const osmKind = (q) => {
    const s = q.toLowerCase().trim();
    const hit = Object.keys(OSM_KINDS)
        .sort((x, y) => y.length - x.length)
        .find((k) => s.includes(k));
    return hit ? OSM_KINDS[hit] : '';
};
const tidy = (t) => {
    const name = String(t.name || '').trim();
    const kind = t.shop || t.amenity || t.tourism || t.office || t.craft || t.leisure || t.healthcare || t.club || '';
    const addr = [t['addr:housenumber'], t['addr:street'], t['addr:city'] || t['addr:suburb']].filter(Boolean).join(' ');
    let website = String(t.website || t['contact:website'] || t.url || '').trim();
    if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
    return {
        business: name.slice(0, 120),
        kind: String(kind).replace(/_/g, ' ').slice(0, 40),
        address: addr.slice(0, 160),
        website: website.slice(0, 200),
        phone: String(t.phone || t['contact:phone'] || '').slice(0, 40),
        email: String(t.email || t['contact:email'] || '').slice(0, 120),
        facebook: String(t['contact:facebook'] || '').slice(0, 200),
        instagram: String(t['contact:instagram'] || '').slice(0, 200)
    };
};
/* Overpass, with a second server when the main one is busy */
async function overpass(q, ms) {
    for (const host of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
        try {
            const r = await fetch(host, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
                body: 'data=' + encodeURIComponent(q),
                signal: AbortSignal.timeout(ms)
            });
            if (!r.ok) continue;
            const j = await r.json().catch(() => null);
            if (j && Array.isArray(j.elements)) return j.elements;
        } catch (e) {
            /* next server */
        }
    }
    throw new HttpsError('unavailable', 'The map service is busy - try again in a minute.');
}
const REGIONS = { bowen: '-20.30,147.90,-19.80,148.60', whitsundays: '-20.60,147.90,-19.80,149.05' };
/* which industry a map tag belongs to, for one-sponsor-per-industry */
const INDUSTRY_OF = [
    [/^shop=(car|car_repair|car_parts|tyres|motorcycle)$/, 'Automotive'],
    [/^amenity=(fuel|car_wash|car_rental)$/, 'Automotive'],
    [/^office=estate_agent$/, 'Real estate'],
    [/^(craft=|shop=(hardware|doityourself|trade|paint|electrical|glaziery))/, 'Building & trades'],
    [/^office=(accountant|financial|tax_advisor)$|^amenity=bank$/, 'Finance & accounting'],
    [/^office=lawyer$/, 'Legal'],
    [/^office=insurance$/, 'Insurance'],
    [
        /^(amenity=(pharmacy|dentist|doctors|clinic|hospital|veterinary)|healthcare=|shop=(chemist|optician|medical_supply))/,
        'Health & medical'
    ],
    [/^shop=(hairdresser|beauty|massage|tattoo|cosmetics)$/, 'Beauty & hair'],
    [/^(leisure=(fitness_centre|sports_centre|golf_course|swimming_pool)|club=sport)/, 'Fitness & sport'],
    [/^amenity=(pub|bar|nightclub)$|^club=/, 'Hospitality - pubs & clubs'],
    [/^amenity=(cafe|restaurant|fast_food|ice_cream|food_court)$|^shop=(coffee|tea)$/, 'Hospitality - cafes & restaurants'],
    [
        /^(tourism=(hotel|motel|caravan_site|guest_house|apartment|chalet|camp_site|hostel|resort|attraction|museum|zoo|theme_park)|leisure=(resort|marina|water_park)|shop=travel_agency|amenity=(cinema|boat_rental))/,
        'Accommodation & tourism'
    ],
    [
        /^shop=(supermarket|convenience|bakery|butcher|greengrocer|seafood|deli|alcohol|beverages|general|frozen_food|health_food)$/,
        'Retail - groceries'
    ],
    [
        /^shop=(furniture|bed|kitchen|houseware|interior_decoration|curtain|carpet|appliance|electronics|hifi|computer|mobile_phone|garden_centre|florist|pet|storage_rental|department_store|mall|variety_store|second_hand|charity)$/,
        'Retail - hardware & home'
    ],
    [
        /^shop=(clothes|shoes|fashion|jewelry|gift|toys|books|stationery|sports|outdoor|bag|boutique|fabric|craft|art|music|video_games|newsagent|photo|tobacco|e-cigarette|surf)$/,
        'Retail - fashion & gifts'
    ],
    [/^shop=(copyshop|printing|frame)$|^craft=(signmaker|printer)$/, 'Printing & signage'],
    [/^office=(advertising_agency|it|newspaper|telecommunication)$|^shop=(radiotechnics)$/, 'Media & marketing'],
    [/^shop=(agrarian|farm|fishing|garden)$|^landuse=/, 'Agriculture & fishing'],
    [/^shop=(boat|scuba_diving)$|^leisure=slipway$/, 'Marine & boating'],
    [
        /^(office=(logistics|moving_company)|shop=(trailer|caravan|truck)|amenity=(taxi|bus_station|ferry_terminal))/,
        'Transport & logistics'
    ],
    [
        /^amenity=(school|kindergarten|childcare|college|university|library|dancing_school|music_school|driving_school|language_school)$/,
        'Education & childcare'
    ],
    [/^amenity=(townhall|courthouse|police|post_office|fire_station)$|^office=government$/, 'Government & council'],
    [
        /^(amenity=(community_centre|social_facility|place_of_worship|social_centre)|office=(association|charity|ngo)|club=)/,
        'Community & not-for-profit'
    ]
];
const industryOf = (kv) => {
    const hit = INDUSTRY_OF.find(([re]) => re.test(kv));
    return hit ? hit[1] : 'Other';
};
// map things that are not businesses to sponsor
const NOT_BIZ =
    /^(leisure=(park|nature_reserve|pitch|playground|picnic_table|beach_resort|track|dog_park|garden|common)|tourism=(viewpoint|information|artwork|picnic_site)|amenity=(parking|toilets|bench|shelter|drinking_water|waste_transfer_station|charging_station|recycling|grave_yard|bbq|atm|fountain|telephone|post_box|vending_machine|boat_ramp|shower)|club=)/;

exports.importMapBusinesses = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    requireAdmin(request);
    const region = String((request.data || {}).region || 'bowen');
    const bbox = REGIONS[region];
    if (!bbox) throw new HttpsError('invalid-argument', 'Unknown region.');
    const q = `[out:json][timeout:60][bbox:${bbox}];(nwr["name"]["shop"];nwr["name"]["amenity"];nwr["name"]["office"];nwr["name"]["craft"];nwr["name"]["tourism"];nwr["name"]["leisure"];nwr["name"]["healthcare"];nwr["name"]["club"];);out center tags 3000;`;
    const els = await overpass(q, 90000);
    const seen = new Set();
    const out = [];
    els.forEach((el) => {
        const t = el.tags || {};
        const kv = t.shop
            ? 'shop=' + t.shop
            : t.amenity
              ? 'amenity=' + t.amenity
              : t.office
                ? 'office=' + t.office
                : t.craft
                  ? 'craft=' + t.craft
                  : t.tourism
                    ? 'tourism=' + t.tourism
                    : t.leisure
                      ? 'leisure=' + t.leisure
                      : t.healthcare
                        ? 'healthcare=' + t.healthcare
                        : t.club
                          ? 'club=' + t.club
                          : '';
        if (!kv || NOT_BIZ.test(kv)) return;
        const b = tidy(t);
        const k = b.business.toLowerCase();
        if (!b.business || seen.has(k)) return;
        seen.add(k);
        b.industry = industryOf(kv);
        b.local = region === 'bowen' || /bowen|queens beach|merinda|gumlu|guthalungra/i.test(b.address) ? 'bowen' : 'whitsundays';
        out.push(b);
    });
    out.sort((x, y) => x.business.localeCompare(y.business));
    return { results: out };
});

/* by category: Overpass, tags only (a name regex is far too slow there) */
async function findByKind(kv) {
    const [k, v] = kv.split('=');
    const q = `[out:json][timeout:20];(nwr["${k}"${v ? '="' + v + '"' : ''}](around:20000,${BOWEN.lat},${BOWEN.lon}););out center tags 80;`;
    const els = await overpass(q, 40000);
    return els.map((el) => tidy(el.tags || {}));
}
/* by name or words: Nominatim, boxed to the Bowen area */
async function findByName(q) {
    const u =
        'https://nominatim.openstreetmap.org/search?format=jsonv2&extratags=1&limit=30&bounded=1&viewbox=' +
        BOX +
        '&q=' +
        encodeURIComponent(q);
    const r = await fetch(u, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return [];
    const j = await r.json().catch(() => []);
    return (Array.isArray(j) ? j : [])
        .filter((x) => x.name)
        .map((x) =>
            tidy({
                name: x.name,
                [x.category || 'shop']: x.type,
                'addr:street': (x.address || {}).road,
                'addr:city': (x.address || {}).town || (x.address || {}).city || (x.address || {}).village,
                ...(x.extratags || {})
            })
        );
}
exports.findBusinesses = onCall({ timeoutSeconds: 60 }, async (request) => {
    requireAdmin(request);
    const q = String((request.data || {}).query || '')
        .trim()
        .slice(0, 60);
    if (q.length < 2) throw new HttpsError('invalid-argument', 'Type what to look for.');
    const kind = osmKind(q);
    const [byName, byKind] = await Promise.all([findByName(q).catch(() => []), kind ? findByKind(kind).catch(() => []) : []]);
    const seen = new Set();
    const out = [];
    byName.concat(byKind).forEach((x) => {
        const k = x.business.toLowerCase();
        if (!x.business || seen.has(k)) return;
        seen.add(k);
        out.push(x);
    });
    if (!out.length && !kind)
        throw new HttpsError(
            'not-found',
            'Nothing by that name on the map. Try a type of business (cafes, hotels, car dealers) or add it by hand.'
        );
    out.sort((x, y) => (y.website ? 1 : 0) - (x.website ? 1 : 0) || x.business.localeCompare(y.business));
    return { results: out.slice(0, 50) };
});

exports.lookupBusiness = onCall({ timeoutSeconds: 30 }, async (request) => {
    requireAdmin(request);
    let site = String((request.data || {}).website || '')
        .trim()
        .slice(0, 200);
    if (!/^https?:\/\//i.test(site)) site = 'https://' + site;
    let u;
    try {
        u = new URL(site);
    } catch (e) {
        throw new HttpsError('invalid-argument', 'That is not a web address.');
    }
    if (!/^[\w.-]+\.[a-z]{2,}$/i.test(u.hostname) || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname))
        throw new HttpsError('invalid-argument', 'That is not a public website.');
    let html = '';
    try {
        const r = await fetch(u.origin + '/', {
            headers: { 'user-agent': 'Mozilla/5.0 (compatible; SoundzGood admin)' },
            redirect: 'follow',
            signal: AbortSignal.timeout(10000)
        });
        const buf = Buffer.from(await r.arrayBuffer());
        const cs =
            (/charset=([\w-]+)/i.exec(r.headers.get('content-type') || '') ||
                /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.toString('latin1').slice(0, 4000)) ||
                [])[1] || 'utf-8';
        try {
            html = new TextDecoder(cs).decode(buf).slice(0, 400000);
        } catch (e) {
            html = buf.toString('utf8').slice(0, 400000);
        }
    } catch (e) {
        throw new HttpsError('unavailable', 'Could not reach their website.');
    }
    const meta = (names) => {
        for (const n of names) {
            const m =
                new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]+content=["']([^"']+)["']`, 'i').exec(html) ||
                new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${n}["']`, 'i').exec(html);
            if (m) return m[1];
        }
        return '';
    };
    const abs = (href) => {
        try {
            return new URL(href, u.origin).href;
        } catch (e) {
            return '';
        }
    };
    // entities, then the usual mis-read UTF-8 (a site that says latin1 but isn't)
    const unent = (s) =>
        String(s || '')
            .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
            .replace(/&amp;/g, '&')
            .replace(/&apos;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&nbsp;/g, ' ')
            .replace(/â€™/g, '’')
            .replace(/â€˜/g, '‘')
            .replace(/â€œ/g, '“')
            .replace(/â€\u009d|â€/g, '”')
            .replace(/â€“/g, '–')
            .replace(/â€”/g, '—')
            .replace(/Ã©/g, 'é')
            .replace(/Â/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    const title = unent((/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1] || '').split(/\s[|\-–]\s/)[0];
    const blurb = unent(meta(['og:description', 'description', 'twitter:description'])).slice(0, 300);
    const ogImage = meta(['og:image', 'twitter:image']);
    const icon = (/<link[^>]+rel=["'][^"']*(?:apple-touch-icon|icon)[^"']*["'][^>]+href=["']([^"']+)["']/i.exec(html) ||
        /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*(?:apple-touch-icon|icon)[^"']*["']/i.exec(html) ||
        [])[1];
    const social = (host) => {
        const m = new RegExp(`https?://(?:www\\.)?${host}/([A-Za-z0-9_.-]+)/?`, 'i').exec(html);
        return m && !/^(sharer|share|plugins|dialog|intent|hashtag|explore|p|reel|tr|login)$/i.test(m[1])
            ? `https://www.${host}/${m[1]}`
            : '';
    };
    const phone =
        (/(?:\(0\d\)\s?\d{4}\s?\d{4}|04\d{2}\s?\d{3}\s?\d{3}|1[38]00\s?\d{3}\s?\d{3}|\b0\d\s?\d{4}\s?\d{4}\b)/.exec(
            html.replace(/<[^>]+>/g, ' ')
        ) || [])[0] || '';
    const email =
        (/[\w.+-]+@[\w-]+\.[\w.-]+/.exec(html.replace(/<[^>]+>/g, ' ').replace(/\.(png|jpe?g|svg|webp|gif)/gi, ' ')) || [])[0] || '';
    return {
        business: title.slice(0, 120),
        blurb,
        website: u.origin,
        logo: ogImage
            ? abs(ogImage)
            : icon
              ? abs(icon)
              : 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(u.hostname) + '&sz=256',
        facebook: social('facebook.com'),
        instagram: social('instagram.com'),
        phone: phone.replace(/\s+/g, ' ').trim(),
        email: /unsubscribe|example|sentry|wixpress/i.test(email) ? '' : email
    };
});
