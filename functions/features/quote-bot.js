/* SOUNDZGOOD SERVER - quote-bot
   The public estimate bot.
   Helpers shared with other features come from ../shared.js. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { sendQuoteEmail } = require('../lib/quote-email');
const crypto = require('crypto');
const {
    DETAIL_EMAIL_RE,
    SMTP_PASS,
    SMTP_USER,
    db,
    limitIp,
    loadQuoteInventory,
    quoteMoney,
    rateLimit,
    sanitizeQuote
} = require('../shared');

/* =========================================================================
   BOT QUOTE  -  the public estimate bot (Phase 2)

   A visitor answers a few questions; the server matches the best package,
   prices it (gear + kit-required gear + labour + delivery + optional tech),
   creates a DRAFT quote for staff to review and send, and returns only an
   on-screen price range. Nothing bulky ships to the browser; the inventory
   and packages are read here, not in the page.
   ========================================================================= */
const { expandKit: botExpandKit } = require('../lib/kit');

const BOT_KM_RATE_CENTS = 80; // $0.80/km travelled
const { labourParts, labourDayRate } = require('../lib/labour'); // crew rate + weekend / holiday loadings
const BOT_ZONES = [
    ['Bowen (local)', 0],
    ['Merinda', 12],
    ['Guthalungra', 38],
    ['Proserpine', 64],
    ['Home Hill', 79],
    ['Cannonvale', 84],
    ['Cape Gloucester Resort', 85],
    ['Collinsville', 86],
    ['Scottville', 88],
    ['Airlie Beach', 88],
    ['Jubilee Pocket', 90],
    ['Ayr', 91],
    ['Bloomsbury', 95],
    ['Shute Harbour', 98],
    ['Brandon', 98],
    ['Giru', 130],
    ['Glenden', 150],
    ['Mackay', 189],
    ['Townsville', 200],
    ['Charters Towers', 245],
    ['Moranbah', 300],
    ['Clermont', 400],
    ['Hughenden', 450],
    ['Emerald', 500],
    ['Richmond', 560],
    ['Winton', 660],
    ['Julia Creek', 670],
    ['Cloncurry', 780],
    ['Longreach', 810],
    ['Mount Isa', 900],
    ['Barcaldine', 900]
];
function botZoneKm(town) {
    const t = String(town || '')
        .trim()
        .toLowerCase();
    const z = BOT_ZONES.find((z) => z[0].toLowerCase() === t);
    return z ? z[1] : null;
}

function botPickPackage(packages, eventType, guests) {
    const et = String(eventType || '').toLowerCase();
    const active = packages.filter((p) => p.active !== false && Array.isArray(p.items) && p.items.length);
    let typed = active.filter((p) => String(p.eventType || '').toLowerCase() === et);
    if (!typed.length)
        typed = active.filter((p) => {
            const pe = String(p.eventType || '').toLowerCase();
            return pe && (pe.includes(et) || et.includes(pe));
        });
    if (!typed.length) typed = active;
    if (!typed.length) return null;
    const fits = typed.filter((p) => !p.maxGuests || guests <= p.maxGuests).sort((a, b) => (a.maxGuests || 1e9) - (b.maxGuests || 1e9));
    if (fits.length) return fits[0];
    return typed.slice().sort((a, b) => (b.maxGuests || 0) - (a.maxGuests || 0))[0];
}

const BOT_GENERATOR_CENTS = 25000; // $250/day estimate when there's no mains power
const BOT_EXTRA_MAP = {
    mic: { label: 'Extra mic (speeches / MC)', kw: ['glxd', 'wireless'], qty: 1 },
    dancefloor: { label: 'Dance floor', kw: ['dance floor'], qty: 1 },
    staging: { label: 'Stage / riser', kw: ['stage 6m x 2m', 'stage 6m'], qty: 1 },
    lighting: { label: 'Extra lighting', kw: ['moving head', 'm1s80w'], qty: 2 },
    projector: { label: 'Projector & screen', kw: ['projector'], qty: 1 },
    haze: { label: 'Haze / smoke machine', kw: ['haze'], qty: 1 }
};
function botFindItem(inv, kws) {
    const low = (s) => String(s || '').toLowerCase();
    return inv.find((it) => it && it.name && kws.some((k) => low(it.name).includes(k))) || null;
}

exports.submitBotQuote = onCall({ secrets: [SMTP_USER, SMTP_PASS] }, async (request) => {
    await limitIp(request, 'bot', 10, 60); // 10 estimates an hour per visitor
    await rateLimit('bot|all', 300, 1440); // and 300 a day across the whole site, so the mail account cannot be flooded
    const d = request.data || {};
    if (String(d.website || d.company_url || '').trim()) return { ok: true }; // honeypot

    const a = d.answers || {};
    const eventType = String(a.eventType || '')
        .trim()
        .slice(0, 80);
    const guests = Math.max(0, Math.round(Number(a.guests) || 0));
    const days = Math.max(1, Math.round(Number(a.days) || 1));
    const town = String(a.town || '')
        .trim()
        .slice(0, 80);
    const support = ['full', 'delivery', 'pickup'].includes(a.support) ? a.support : 'delivery';
    const delivered = support !== 'pickup';
    const km = delivered ? (a.km != null ? Math.max(0, Math.round(Number(a.km) || 0)) : botZoneKm(town) || 0) : 0;
    const indoor = ['indoor', 'outdoor', 'mixed'].includes(a.indoor) ? a.indoor : '';
    const power = ['yes', 'no', 'unsure'].includes(a.power) ? a.power : '';
    const startTime = String(a.startTime || '')
        .trim()
        .slice(0, 40);
    const finishTime = String(a.finishTime || '')
        .trim()
        .slice(0, 40);
    const access = ['easy', 'stairs', 'tricky'].includes(a.access) ? a.access : 'easy';
    const extras = Array.isArray(a.extras) ? a.extras.filter((k) => typeof k === 'string').slice(0, 12) : [];
    const name = String(a.name || '')
        .trim()
        .slice(0, 120);
    const email = String(a.email || '')
        .trim()
        .slice(0, 200);
    const phone = String(a.phone || '')
        .trim()
        .slice(0, 40);
    const eventDate = String(a.eventDate || '')
        .trim()
        .slice(0, 60);
    const message = String(a.message || '')
        .trim()
        .slice(0, 2000);

    if (!eventType) throw new HttpsError('invalid-argument', 'Please choose an event type.');
    if (!name || !(email || phone)) throw new HttpsError('invalid-argument', 'Please leave your name and a contact.');
    if (email && !DETAIL_EMAIL_RE.test(email)) throw new HttpsError('invalid-argument', 'Please enter a valid email address.');
    if (email) await rateLimit('bot|to|' + email.toLowerCase(), 3, 24 * 60); // at most 3 estimate emails a day to one address

    const inv = await loadQuoteInventory();
    const byId = {};
    inv.forEach((it) => {
        byId[it.id] = it;
    });

    // PACKAGES: packages built in Inventory (kits + items)
    // that are ticked for the bot, plus any old-style ones not yet moved over.
    const pkgSnap = await db.collection('packages').get();
    const packages = [];
    pkgSnap.forEach((x) => {
        const p = x.data() || {};
        if (!p.migratedTo) packages.push({ id: x.id, ...p });
    });
    inv.filter((it) => it.isSystem && it.bundleType === 'package' && it.botOffer === true).forEach((it) =>
        packages.push({
            id: it.id,
            name: it.name || 'Package',
            eventType: it.eventType || '',
            maxGuests: it.maxGuests || 0,
            active: true,
            items: [{ itemId: it.id, qty: 1 }],
            overrideCents: it.priceCents || 0,
            invPackage: it // built in Inventory: quoted ITEMISED (kit prices + package discount)
        })
    );

    const isOther = /^other/i.test(eventType);
    const pkg = isOther ? null : botPickPackage(packages, eventType, guests);

    // Build itemised lines from the matched package (if any) via the kit engine.
    // "Other" / no match still creates a draft from the extras + services below and
    // returns no instant range - staff build a custom quote from the intake.
    const lines = [];
    let discountCents = 0;
    if (pkg && pkg.invPackage) {
        // ITEMISED: each kit / item priced, parts Included, then the package discount
        const P = pkg.invPackage;
        const eff = {};
        (P.requirements || []).forEach((r) => {
            if (r && r.itemId) eff[r.itemId] = (eff[r.itemId] || 0) + Math.max(0, Math.round(r.qty || 0));
        });
        const order = [];
        (P.systemParts && P.systemParts.length ? P.systemParts : P.requirements || []).forEach((p) => {
            if (p && eff[p.itemId] && !order.includes(p.itemId)) order.push(p.itemId);
        });
        Object.keys(eff).forEach((id) => {
            if (!order.includes(id)) order.push(id);
        });
        let full = 0;
        order.forEach((id) => {
            const it = byId[id];
            if (!it) return;
            lines.push({
                type: 'item',
                itemId: id,
                name: it.name || id,
                description: it.subtitle || '',
                qty: eff[id],
                unitCents: it.priceCents || 0,
                days,
                pkgId: P.id
            });
            full += (it.priceCents || 0) * eff[id] * days;
            botExpandKit({ [id]: eff[id] }, byId).required.forEach((r) => {
                const charged = r.charge === 'normal';
                lines.push({
                    type: 'kit',
                    itemId: r.itemId,
                    name: r.name,
                    qty: r.qty,
                    unitCents: charged ? r.unitCents : 0,
                    charge: r.charge,
                    days: charged ? days : 1
                });
                if (charged) full += r.unitCents * r.qty * days;
            });
        });
        // crew in the package (Audio Operator...)
        (Array.isArray(P.crewParts) ? P.crewParts : []).forEach((c) => {
            const q2 = Math.max(1, Math.round(c.qty || 1));
            lines.push({
                type: 'custom',
                name: c.name || 'Crew',
                qty: q2,
                unitCents: Math.max(0, Math.round(c.dayRateCents || 0)),
                days,
                resType: ['staff', 'vehicle', 'trailer'].includes(c.type) ? c.type : 'staff',
                pkgId: P.id
            });
            full += Math.max(0, Math.round(c.dayRateCents || 0)) * q2 * days;
        });
        const target = Math.max(0, Math.round(P.priceCents || 0)) * days;
        if (target > 0 && full > target)
            lines.push({ type: 'discount', name: (P.name || 'Package') + ' - package discount', amountCents: full - target, pkgId: P.id });
    } else if (pkg) {
        const cart = {};
        (pkg.items || []).forEach((i) => {
            if (i.itemId) cart[i.itemId] = (cart[i.itemId] || 0) + Math.max(0, Math.round(i.qty || 0));
        });
        const kit = botExpandKit(cart, byId);
        kit.base.forEach((b) => {
            const it = byId[b.itemId] || {};
            lines.push({
                type: 'item',
                itemId: b.itemId,
                name: it.name || b.itemId,
                description: it.subtitle || '',
                qty: b.qty,
                unitCents: it.priceCents || 0,
                days
            });
        });
        kit.required.forEach((r) => {
            const charged = r.charge === 'normal';
            lines.push({
                type: 'kit',
                itemId: r.itemId,
                name: r.name /* no "(included)" - the Included column says it */,
                qty: r.qty,
                unitCents: charged ? r.unitCents : 0,
                charge: r.charge,
                days: charged ? days : 1
            });
        });
        const gearValue = kit.base.reduce((s, b) => s + b.lineCents, 0) + kit.addCents;
        const afterDisc = Math.max(0, gearValue - Math.max(0, Math.round(pkg.discountCents || 0)));
        const target = pkg.overrideCents > 0 ? pkg.overrideCents : Math.max(Math.max(0, Math.round(pkg.minCents || 0)), afterDisc);
        const adjust = target - gearValue;
        if (adjust < 0)
            discountCents = -adjust; // discount down to target
        else if (adjust > 0)
            lines.push({ type: 'custom', name: (pkg.name || 'Package') + ' — package price', qty: 1, unitCents: adjust, days: 1 }); // top up to the floor/override
    }

    // Customer-picked extras, each mapped to a real inventory item (full price).
    const chosenExtras = [];
    extras.forEach((key) => {
        const spec = BOT_EXTRA_MAP[key];
        if (!spec) return;
        const it = botFindItem(inv, spec.kw);
        if (!it) return;
        lines.push({
            type: 'item',
            itemId: it.id,
            name: it.name,
            description: it.subtitle || '',
            qty: spec.qty,
            unitCents: it.priceCents || 0,
            days
        });
        chosenExtras.push(spec.label);
    });

    const needsGenerator = (indoor === 'outdoor' || indoor === 'mixed') && power === 'no';
    if (needsGenerator) {
        lines.push({
            type: 'custom',
            name: 'Generator (no mains power)',
            description: 'Estimate — confirmed on review',
            qty: 1,
            unitCents: BOT_GENERATOR_CENTS,
            days
        });
    }

    if (delivered) {
        let mins = 0;
        lines.forEach((l) => {
            if (l.itemId && byId[l.itemId])
                mins += Math.max(0, Math.round(byId[l.itemId].setupMins || 0)) * Math.max(0, Math.round(l.qty || 0));
        });
        // Harder access = more crew time on site.
        const accessMins = access === 'tricky' ? 120 : access === 'stairs' ? 60 : 0;
        const setupTotal = mins + accessMins;
        if (setupTotal > 0) {
            // same rates as the admin quote builder (lib/labour.js): crew rate + weekend / public holiday loadings
            const iso = /^\d{4}-\d{2}-\d{2}$/.test(String(a.eventDateISO || '')) ? a.eventDateISO : '';
            const note = accessMins ? ` (incl. ${access} access)` : '';
            labourParts(setupTotal, { startDate: iso, endDate: iso, town }).forEach((p) =>
                lines.push({
                    type: 'labour',
                    name: p.lineName,
                    description: p.lineDesc + note + (iso ? '' : ' – weekend & public holiday surcharges may apply'),
                    qty: 1,
                    unitCents: p.cents,
                    days: 1
                })
            );
        }
        const del = km * 2 * BOT_KM_RATE_CENTS;
        if (del > 0)
            lines.push({
                type: 'delivery',
                name: 'Travel & transport' + (town ? ' — ' + town : ''),
                description: 'Fuel and vehicle running costs · ' + km + ' km each way (' + km * 2 + ' km return) @ $0.80/km',
                qty: 1,
                unitCents: del,
                days: 1
            });
    }

    if (support === 'full') {
        let techRate = 60000; // $600 default; use the highest active staff rate if set
        try {
            const rs = await db.collection('resources').where('type', '==', 'staff').limit(10).get();
            rs.forEach((x) => {
                const r = x.data();
                if (r.active !== false && r.dayRateCents) techRate = Math.max(techRate, r.dayRateCents);
            });
        } catch (e) {
            /* default */
        }
        // same day loadings as labour (Sat +25%, Sun +50%, public holiday +50%), day by day
        const iso = /^\d{4}-\d{2}-\d{2}$/.test(String(a.eventDateISO || '')) ? a.eventDateISO : '';
        let techTotal = 0;
        for (let d = 0; d < days; d++) {
            let day = '';
            if (iso) {
                const [y, m, dd] = iso.split('-').map(Number);
                day = new Date(Date.UTC(y, m - 1, dd + d)).toISOString().slice(0, 10);
            }
            techTotal += Math.round(techRate * labourDayRate(day, town, false).mult);
        }
        lines.push({
            type: 'custom',
            name: 'On-site AV technician',
            qty: 1,
            unitCents: Math.round(techTotal / days),
            baseCents: techRate,
            days,
            resType: 'staff'
        });
    }

    // BOOKING & ADMIN FEE: 2% of everything before GST, rounded to the nearest
    // $10 - same as the admin quote builder
    const feeCents = Math.round((quoteMoney({ hire: { days }, lines, discountCents }).netCents * 2) / 100 / 1000) * 1000;
    if (feeCents > 0) lines.push({ type: 'fee', name: 'Booking & admin', qty: 1, unitCents: feeCents, days: 1 });

    const quote = {
        kind: 'quote',
        customer: { name, email, phone, business: '', address: '', eventName: eventType, eventDate },
        hire: { startDate: '', endDate: '', days },
        lines,
        discountCents,
        labourExcluded: false,
        delivery: { town: delivered ? town : '', km: delivered ? km : 0 },
        notes: '',
        terms: ''
    };
    const clean = sanitizeQuote(quote);
    const money = quoteMoney(clean);

    const counterRef = db.collection('config').doc('counters');
    const seq = await db.runTransaction(async (tx) => {
        const c = await tx.get(counterRef);
        const n = ((c.exists && c.data().quoteSeq) || 0) + 1;
        tx.set(counterRef, { quoteSeq: n }, { merge: true });
        return n;
    });
    const number = 'SG-Q-' + String(seq).padStart(4, '0');
    const token = crypto.randomBytes(16).toString('hex');

    const draftRef = await db.collection('quotes').add({
        number,
        token,
        status: 'draft',
        ...clean,
        ...money,
        source: 'bot',
        packageId: pkg ? pkg.id : '',
        packageName: pkg ? pkg.name || '' : '',
        guests,
        botSupport: support,
        botMessage: message,
        botTown: town,
        botIndoor: indoor,
        botPower: power,
        botStart: startTime,
        botFinish: finishTime,
        botAccess: access,
        botExtras: chosenExtras,
        botGenerator: needsGenerator,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        createdBy: 'bot'
    });

    // On-screen range (+/- 10%, rounded to $10) only when a package matched.
    // "Other" enquiries return no range - the team builds a custom quote.
    const resp = { ok: true, packageName: pkg ? pkg.name || '' : '' };
    let lowCents = null;
    let highCents = null;
    if (pkg) {
        const total = money.totalCents;
        lowCents = Math.max(0, Math.floor((total * 0.9) / 1000) * 1000);
        highCents = Math.ceil((total * 1.1) / 1000) * 1000;
        resp.lowCents = lowCents;
        resp.highCents = highCents;
    } else {
        resp.custom = true;
    }

    /* Instant price-guide email to the visitor. Never throws - the draft is
     already saved; the send result is logged and saved onto the draft. */
    if (email) {
        const extraLabels = chosenExtras.slice();
        if (needsGenerator) extraLabels.push('Generator');
        if (support === 'full') extraLabels.push('On-site technician');
        const lead = {
            name,
            email,
            eventTypeLabel: eventType,
            locationLabel: town,
            sizeLabel: guests ? guests + ' guests' : '',
            durationLabel: days > 1 ? days + ' days' : '',
            serviceLabels: extraLabels,
            eventDate,
            estimateLowCents: lowCents,
            estimateHighCents: highCents
        };
        const mail = await sendQuoteEmail(lead);
        try {
            await draftRef.update({
                emailStatus: mail.sent ? 'sent' : 'failed',
                emailAt: FieldValue.serverTimestamp(),
                emailError: mail.sent ? FieldValue.delete() : String(mail.error || mail.reason || '').slice(0, 500)
            });
        } catch (e) {
            /* logged inside sendQuoteEmail; don't fail the enquiry */
        }
    }

    return resp;
});
