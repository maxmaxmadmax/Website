/* ==========================================================================
   QUOTE / INVOICE  -  the public document page (/quote?t=<token>)

   Fetches one quote by its secret token through the getQuote function (the
   collection itself is closed to browsers), renders it as a traditional
   quote or tax invoice, and lets the customer accept a quote, pay it, or
   print/save it as a PDF. Prices are ex-GST; GST is shown at 10%.

   Contents
     1  Setup            imports, seller details, switches
     2  Helpers          money, escaping, dates, times
     3  Firebase         the callable functions
     4  Line maths       line amounts and quote totals
     5  Cost groups      inventory category -> customer-facing group
     6  Wording          crew names, DJ bio
     7  The document     the itemised quote / tax invoice
     8  Proposal top     hero, tiles, investment summary
     9  Payment rules    deposit or pay in full
    10  Proposal bottom  terms, booking and payment options
    11  Forms            gear-list team, customer details
    12  Wiring           buttons, forms, payment
    13  Start            load the quote
   ========================================================================== */

/* ---------- 1  Setup ---------- */

import { TERMS, TERMS_INTRO, termBodyHtml } from './terms-data.js?v=845';
import { DJ_TERMS, DJ_TERMS_INTRO } from './dj-terms-data.js?v=845'; // DJ / entertainment quotes
import { firebaseConfig, functionsRegion, isFirebaseConfigured } from './firebase-config.js?v=845';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

const SELLER = {
    name: 'SoundzGood Whitsundays',
    legal: 'a trading name of Bindi Co Pty Ltd',
    abn: '49 700 595 348',
    email: 'info@soundzgood.com.au',
    phone: '0422 393 022',
    address: '34a Williams St, Bowen QLD 4805',
    site: 'www.soundzgood.com.au',
    bankName: 'SoundzGood Whitsundays',
    bankBsb: '014504',
    bankAcc: '815818305'
};

/*  ON / OFF SWITCH: group the customer's itemised quote into sections -
    AUDIO, LIGHTING, STAGING, BACKLINE ... then LABOUR, TRAVEL & TRANSPORT,
    BOOKING & ADMIN, DISCOUNT. For the plain list (in the order lines were
    added): change true to false below, run node tools/bump-assets.js, push. */
const ITEMISE_BY_SECTION = true;

const QUOTE_VALID_DAYS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------- 2  Helpers ---------- */

function money(cents) {
    return '$' + (Math.round(cents || 0) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/*  A price crossed out, shown before the price after a saving. */
function wasMoney(cents) {
    return '<s class="qp-was">' + money(cents) + '</s> ';
}

function esc(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function token() {
    return new URLSearchParams(location.search).get('t') || '';
}

const SHORT_DAY = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
const LONG_DAY = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };

/*  "2026-10-20" -> a local Date, moved by addDays; null if not a date. */
function isoToDate(iso, addDays = 0) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3] + addDays) : null;
}

function dayLabel(date, opts) {
    return date.toLocaleDateString('en-AU', opts).replace(/,/g, '');
}

/*  "Tue 20 Oct 2026"; anything that isn't a date shows as it is. */
function shortDay(iso) {
    const d = isoToDate(iso);
    return d ? dayLabel(d, SHORT_DAY) : String(iso || '');
}

/*  "Tuesday 20 October 2026", or '' if not a date. */
function longDay(iso) {
    const d = isoToDate(iso);
    return d ? dayLabel(d, LONG_DAY) : '';
}

/*  The hire dates: one day shows once, a range "a – b". */
function hireRange(h) {
    if (!h || !(h.startDate || h.endDate)) return '';
    const a = shortDay(h.startDate || h.endDate);
    const b = shortDay(h.endDate || h.startDate);
    return a === b ? a : a + ' – ' + b;
}

/*  Seconds since 1970 -> "20 October 2026". */
function fmtDate(secs) {
    if (!secs) return '';
    return new Date(secs * 1000).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

/*  "2026-10-01" -> "01/10/2026". */
function dmy(iso) {
    return iso.split('-').reverse().join('/');
}

/*  "18:30" -> "6:30pm"; '' if not a time. */
function ampm(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    if (!m) return '';
    const h = +m[1];
    return (h % 12 || 12) + ':' + m[2] + (h < 12 ? 'am' : 'pm');
}

/* ---------- 3  Firebase ---------- */

let callable = null; // the callable functions, once Firebase is up

async function initFns() {
    if (!isFirebaseConfigured) return;
    const [{ initializeApp }, functions] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-functions.js`)]);
    const app = initializeApp(firebaseConfig);
    const fns = functions.getFunctions(app, functionsRegion);
    callable = {
        get: functions.httpsCallable(fns, 'getQuote'),
        accept: functions.httpsCallable(fns, 'acceptQuote'),
        checkout: functions.httpsCallable(fns, 'quoteCheckout'),
        details: functions.httpsCallable(fns, 'submitQuoteDetails'),
        gearTeam: functions.httpsCallable(fns, 'setGearTeam'),
        gearLink: functions.httpsCallable(fns, 'getGearShareLink')
    };
}

async function fetchQuote() {
    const res = await callable.get({ token: token() });
    return res.data;
}

/* ---------- 4  Line maths ---------- */

/*  DJ / entertainment lines: the entertainment fee, kept apart from the gear. */
function isEntertainment(l) {
    return !!(l.pubDj || l.djSlot || l.superLine || l.perf);
}

function lineDays(l, days) {
    return Math.max(1, Math.round(l.days || days));
}

function lineAmount(l, days) {
    if (l.type === 'discount') return -Math.max(0, Math.round(l.amountCents || 0));
    const qty = Math.max(0, l.perf ? Math.round(Number(l.qty || 0) * 4) / 4 : Math.round(Number(l.qty) || 0)); // DJ hours can be 4.5
    const unit = Math.max(0, Math.round(l.unitCents || 0));
    return Math.round(qty * unit * lineDays(l, days)); // quantity x day rate x number of days
}

function sumLines(lines, days) {
    return lines.reduce((t, l) => t + lineAmount(l, days), 0);
}

/*  Total crew hours, read off each labour line ("2.5 hrs @ $80/hr ..."). */
function labourHours(lines) {
    return lines
        .filter((l) => l.type === 'labour')
        .reduce((t, l) => t + (parseFloat((/^([\d.]+) hrs?\b/.exec(l.description || '') || [])[1]) || 0), 0);
}

/*  What the quote adds up to, by kind of line (cents ex GST). */
function quoteTotals(q, days) {
    const lines = q.lines || [];
    const centsOf = (l) => lineAmount(l, days);
    const categoryOf = (l) => l.category;
    const sumWhere = (test) => sumLines(lines.filter(test), days);
    const labour = lines.filter((l) => l.type === 'labour');
    const delivery = lines.filter((l) => l.type === 'delivery');
    const groups = costBreakdown(lines, centsOf, categoryOf);
    const crewCents = sumWhere((l) => l.resType === 'staff');
    return {
        groups,
        groupCents: groups.map((g) => g.cents),
        hire: groups.reduce((t, g) => t + g.cents, 0),
        labour,
        labourCents: sumLines(labour, days),
        crewCents,
        hasLabour: labour.length > 0 || crewCents > 0, // setup, pack-down and operators show as one
        delivery,
        deliveryCents: sumLines(delivery, days),
        vehicleCents: sumWhere((l) => l.resType === 'vehicle' || l.resType === 'trailer'),
        entCents: sumWhere(isEntertainment),
        fees: lines.filter((l) => l.type === 'fee')
    };
}

function deliveryLabel(totals) {
    return totals.deliveryCents ? 'Travel & transport' : 'Local delivery & pickup';
}

/*  DJ jobs: the production subtotal, the discount off it, and that saving as
    a % of the equipment only (labour, crew, vehicles and travel are never
    discounted) - the same as the printed summary. */
function productionTotals(lines, days) {
    const production = lines.filter((l) => !isEntertainment(l) && l.type !== 'discount' && l.type !== 'fee');
    const gear = production.filter(
        (l) => l.type !== 'labour' && l.type !== 'delivery' && !['staff', 'vehicle', 'trailer'].includes(l.resType)
    );
    const gearCents = sumLines(gear, days);
    const discounts = lines.filter((l) => l.type === 'discount');
    const off = -sumLines(discounts, days);
    return {
        sub: sumLines(production, days),
        off,
        pct: gearCents && off ? Math.round((off / gearCents) * 100) : 0
    };
}

/*  DISCOUNT shared across the equipment groups by their size, so each can be
    shown crossed out at full price then the price after the saving. Same on
    screen and in print. Returns the amount off each, or null if it won't fit. */
function spreadSaving(amounts, disc) {
    const base = amounts.reduce((t, c) => t + Math.max(0, c), 0);
    if (!disc || !base || disc > base) return null;
    let left = disc;
    const last = amounts.map((c) => c > 0).lastIndexOf(true);
    return amounts.map((c, i) => {
        if (c <= 0) return 0;
        const off = i === last ? left : Math.round((disc * c) / base);
        left -= off;
        return off;
    });
}

/* ---------- 5  Cost groups ---------- */

/*  COST BREAKDOWN GROUPS - KEEP IN STEP between
    js/quote-view.js and js/admin-app.js. Inventory category -> group shown
    in the totals ("Audio $180, Staging $180, Lighting $60").            */
const COST_GROUP = {
    audio: 'Audio',
    mixer: 'Audio',
    amp: 'Audio',
    microphone: 'Audio',
    iem: 'Audio',
    di: 'Audio',
    'studio monitor': 'Audio',
    cable: 'Audio',
    stands: 'Audio',
    speaker: 'Audio',
    speakers: 'Audio',
    'mic kit': 'Backline',
    drum: 'Backline',
    drums: 'Backline', // Inventory category names
    lighting: 'Lighting',
    truss: 'Lighting',
    stage: 'Staging',
    furniture: 'Staging',
    backline: 'Backline',
    'dj mixer': 'DJ equipment',
    vision: 'Vision',
    power: 'Audio' // power & cables count as Audio
};
const COST_GROUP_ORDER = ['Audio', 'Backline', 'Lighting', 'Staging', 'DJ equipment', 'Vision', 'Other']; // display order

function costGroupOf(category) {
    // gear in a category we don't know yet counts as Audio, not "Other"
    return (
        COST_GROUP[
            String(category || '')
                .trim()
                .toLowerCase()
        ] || 'Audio'
    );
}

/*  [{ name, cents }] in the order above, only groups with a cost. */
function costBreakdown(lines, centsOf, categoryOf) {
    const sums = {};
    (lines || []).forEach((l) => {
        if (l.type === 'labour' || l.type === 'delivery' || l.type === 'discount' || l.type === 'fee') return;
        if (l.resType) return; // crew & vehicles: their own subtotal
        if (isEntertainment(l)) return; // DJ jobs: the entertainment fee, on its own
        const c = centsOf(l);
        if (!c) return;
        const g = l.itemId ? costGroupOf(categoryOf(l)) : 'Other';
        sums[g] = (sums[g] || 0) + c;
    });
    return COST_GROUP_ORDER.filter((g) => sums[g]).map((g) => ({ name: g, cents: sums[g] }));
}

/* ---------- 6  Wording ---------- */

/*  CUSTOMER WORDING FOR LABOUR. Setup / pack-down are
    "bump-in / bump-out" crew, counted in CREW HOURS (not a number of staff);
    operators are "show crew". Only how it reads here - saved lines unchanged. */
function crewName(l) {
    const n = String(l.name || '');
    if (l.type === 'labour') {
        if (/^setup/i.test(n)) return n.replace(/^setup/i, 'Bump-in (setup)');
        if (/^pack-?down/i.test(n)) return n.replace(/^pack-?down/i, 'Bump-out (pack-down)');
    }
    return n;
}

function operatorRole(name) {
    if (/light/i.test(name)) return 'Runs lighting during your event';
    if (/audio|sound|\bav\b|visual/i.test(name)) return 'Runs sound & AV during your event';
    return 'On site to run your event';
}

function crewDesc(l) {
    const d = String(l.description || '');
    if (l.type === 'labour') {
        const what = /^pack-?down/i.test(String(l.name || '')) ? 'System Pack Down' : 'System Setup';
        // older lines missed the $ ("@ 85/hr")
        return what + ' · ' + d.replace(/^([\d.]+) hrs?\b/, '$1 crew hours').replace(/@ (\d+(?:\.\d+)?)\/hr/, '@ $$$1/hr');
    }
    if (l.resType === 'staff') return operatorRole(String(l.name || '')) + (d ? ' · ' + d : '');
    return d;
}

/*  A DJ bio, paragraph by paragraph. Pasted markdown is tidied: **bold**,
 *italic*, # headings lose their #, and one that just repeats the name goes. */
function bioHtml(bio, name) {
    const me = String(name || '')
        .trim()
        .toLowerCase();
    const unHash = (x) => x.replace(/^\s*#+\s*/, '');
    const text = String(bio)
        .replace(/\r/g, '')
        .split('\n')
        .filter((x) => !(/^\s*#/.test(x) && unHash(x).trim().toLowerCase() === me))
        .map(unHash)
        .join('\n');
    const inline = (t) =>
        esc(t)
            .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
            .replace(/\*(.+?)\*/g, '<i>$1</i>');
    return text
        .split(/\n\s*\n/)
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => '<p>' + inline(x).replace(/\n/g, '<br>') + '</p>')
        .join('');
}

/* ---------- 7  The document ---------- */

const PROD_HEAD =
    '<tr class="qv-colhead"><th>Production</th><th class="qv-num">Qty</th><th class="qv-num">Rate (ex GST)</th><th class="qv-num">Days</th><th class="qv-num">Total (ex GST)</th></tr>';

/*  Included / required items sit inside their item, under small category
    headings (Cable, Stands...), A-Z - the same as the quote builder. */
function kitCategory(l) {
    const c = String(l.category || '').trim();
    return c ? c.charAt(0).toUpperCase() + c.slice(1) : 'Other';
}

function sortKitRuns(lines) {
    const L = lines.slice();
    const order = (l) => (l.sysOrder != null ? l.sysOrder : 1e9);
    for (let i = 0; i < L.length; i++) {
        if (L[i].type !== 'kit') continue;
        let end = i;
        while (end < L.length && L[end].type === 'kit') end++;
        const run = L.slice(i, end).sort(
            (a, b) =>
                order(a) - order(b) ||
                kitCategory(a).localeCompare(kitCategory(b)) ||
                String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true })
        );
        L.splice(i, end - i, ...run);
        i = end - 1;
    }
    return L;
}

/*  SECTIONS, in this order. The DJ (gig invoices) goes first; on DJ jobs the
    discount comes off production, so it sits straight after the gear. */
function sectionOrder(djJob) {
    const tail = djJob
        ? ['Labour', 'Travel & transport', 'Discount', 'Booking & admin']
        : ['Labour', 'Travel & transport', 'Booking & admin', 'Discount'];
    return ['Entertainment'].concat(COST_GROUP_ORDER, tail);
}

function sectionOf(l) {
    if (isEntertainment(l)) return 'Entertainment';
    if (l.type === 'labour' || l.resType === 'staff') return 'Labour';
    if (l.type === 'delivery' || l.resType === 'vehicle' || l.resType === 'trailer') return 'Travel & transport';
    if (l.type === 'fee') return 'Booking & admin';
    if (l.type === 'discount') return 'Discount';
    return l.itemId ? costGroupOf(l.category) : 'Other';
}

/*  A unit is a top line plus the included parts under it; each unit goes
    into one section. Returns the lines in order and where each section
    starts ({ lineIndex: sectionName }). */
function arrangeLines(lines, djJob) {
    const units = [];
    lines.forEach((l) => {
        if (l.type === 'kit' && units.length) units[units.length - 1].push(l);
        else units.push([l]);
    });
    const bySection = {};
    units.forEach((u) => {
        const k = ITEMISE_BY_SECTION ? sectionOf(u[0]) : 'all';
        (bySection[k] = bySection[k] || []).push(u);
    });
    // labour: setup & pack-down first, then operators
    if (ITEMISE_BY_SECTION && bySection.Labour) {
        bySection.Labour.sort((a, b) => (a[0].type === 'labour' ? 0 : 1) - (b[0].type === 'labour' ? 0 : 1));
    }
    const ordered = [];
    const starts = {};
    (ITEMISE_BY_SECTION ? sectionOrder(djJob) : ['all']).forEach((k) => {
        if (!bySection[k]) return;
        starts[ordered.length] = k;
        bySection[k].forEach((u) => ordered.push(...u));
    });
    return { lines: ordered, starts };
}

/*  One table row: the description cell, then the four number cells. */
function tableRow(cls, desc, qty, rate, days, amount) {
    return (
        '<tr class="' +
        cls +
        '"><td class="qv-desc">' +
        desc +
        '</td><td class="qv-num">' +
        qty +
        '</td><td class="qv-num">' +
        rate +
        '</td><td class="qv-num">' +
        days +
        '</td><td class="qv-num">' +
        amount +
        '</td></tr>'
    );
}

function subLine(text) {
    return text ? '<span class="qv-sub">' + esc(text) + '</span>' : '';
}

function prodSumRow(label, cents, cls) {
    return '<tr class="qv-prodsum ' + cls + '"><td colspan="4">' + label + '</td><td class="qv-num">' + money(cents) + '</td></tr>';
}

/*  DJ jobs: the entertainment lines have no hours column. */
function hoursOf(doc, l) {
    return doc.djJob && isEntertainment(l) && !l.perf ? '' : esc(l.qty);
}

function plainRowName(l, djJob) {
    if (l.type === 'fee') return 'Booking & admin';
    if (l.name) return l.name;
    if (l.type !== 'discount') return '';
    return djJob ? 'Production package price adjustment' : 'Discount';
}

/*  The heading(s) above line i: the "Production" column heading on DJ jobs,
    then the section name (or, on DJ jobs, the production subtotal before the
    discount). */
function sectionHead(doc, i) {
    const top = i === doc.firstProd ? PROD_HEAD : '';
    const section = doc.starts[i];
    if (doc.djJob && section === 'Discount') return top + prodSumRow('Production subtotal', doc.prod.sub, 'is-sub');
    return top + (ITEMISE_BY_SECTION && section ? '<tr class="qv-sechead"><td colspan="5">' + esc(section) + '</td></tr>' : '');
}

function lineRow(doc, l, i) {
    const { lines: L, days } = doc;
    const amt = lineAmount(l, days);
    const prev = L[i - 1];
    const next = L[i + 1];

    if (l.type === 'delivery' && !l.unitCents) {
        return tableRow('qv-lab', esc(l.name || '') + subLine(l.description), '', '', '', '<strong>Free</strong>');
    }

    if (l.type === 'labour') {
        // a heading over setup + pack-down with the total hours
        const first = i === 0 || prev.type !== 'labour';
        const head =
            first && doc.labourHours
                ? '<tr class="qv-labhead"><td colspan="5">Bump-in &amp; bump-out crew &middot; ' +
                  doc.labourHours +
                  ' crew hour' +
                  (doc.labourHours === 1 ? '' : 's') +
                  ' total</td></tr>'
                : '';
        return head + tableRow('qv-lab', esc(crewName(l)) + subLine(crewDesc(l)), esc(l.qty), money(l.unitCents), '1', money(amt));
    }

    if (l.type === 'kit') {
        const head =
            prev && prev.type === 'kit' && kitCategory(prev) === kitCategory(l)
                ? ''
                : `<tr class="qv-kithead"><td colspan="5">${esc(kitCategory(l))}</td></tr>`;
        const charged = l.charge !== 'free' && l.unitCents;
        const last = !next || next.type !== 'kit';
        return `${head}
      <tr class="qv-kit${last ? ' qv-kit-last' : ''}">
        <td class="qv-desc"><span class="qv-arrow">&#9492;</span>${esc(String(l.name || '').replace(/ \(included\)$/i, ''))}</td>
        <td class="qv-num">${esc(l.qty)}</td>
        <td class="qv-num">${charged ? money(l.unitCents) : '<span class="qv-incl">Included</span>'}</td>
        <td class="qv-num">${charged ? esc(lineDays(l, days)) : ''}</td>
        <td class="qv-num">${charged ? money(amt) : ''}</td>
      </tr>`;
    }

    if (l.resType === 'staff') {
        const first = i === 0 || prev.resType !== 'staff';
        const head = first ? '<tr class="qv-labhead"><td colspan="5">Show crew (technical operators)</td></tr>' : '';
        return (
            head +
            tableRow('qv-lab', esc(crewName(l)) + subLine(crewDesc(l)), esc(l.qty), money(l.unitCents), esc(lineDays(l, days)), money(amt))
        );
    }

    if (l.accom) {
        return tableRow(
            'qv-lab',
            esc(l.name || 'Accommodation') + subLine(l.description),
            '',
            '',
            '',
            '<span class="qv-incl">Provided</span>'
        );
    }

    if (l.superLine) {
        // PERFORMER SUPER: a "Required by law" tag and the plain-English
        // reason, so it reads as what it is - not a markup
        const desc = esc(l.name || '') + ' <span class="qv-law">Required by law</span>' + subLine(l.description);
        return tableRow('qv-super', desc, hoursOf(doc, l), money(l.unitCents), '1', money(amt));
    }

    const isDisc = l.type === 'discount';
    const row = `
      <tr${isDisc ? ' class="qv-row-disc"' : ''}>
        <td class="qv-desc">${esc(plainRowName(l, doc.djJob))}${l.description ? `<span class="qv-sub">${esc(l.description)}</span>` : ''}${isDisc && doc.prod.pct ? `<span class="qv-sub qv-save">You save ${doc.prod.pct}% on equipment hire</span>` : ''}</td>
        <td class="qv-num">${isDisc ? '' : hoursOf(doc, l)}</td>
        <td class="qv-num">${isDisc ? '' : money(l.unitCents)}</td>
        <td class="qv-num">${isDisc ? '' : esc(lineDays(l, days))}</td>
        <td class="qv-num">${isDisc ? '&minus;' + money(-amt) : money(amt)}</td>
      </tr>`;
    // DJ jobs: what production comes to, after the last discount line
    const lastDiscount = doc.djJob && isDisc && !(next && next.type === 'discount');
    return lastDiscount ? row + prodSumRow('Production total', Math.max(0, doc.prod.sub - doc.prod.off), 'is-total') : row;
}

/*  Everything the table rows need to know about the quote. */
function documentLayout(q, days) {
    const sorted = sortKitRuns(q.lines || []);
    const djJob = sorted.some(isEntertainment);
    const { lines, starts } = arrangeLines(sorted, djJob);
    return {
        lines,
        starts,
        days,
        djJob,
        labourHours: labourHours(lines),
        // DJ jobs: entertainment on top (Hours / Fee), then a "Production"
        // column heading over the gear (Qty / Rate)
        firstProd: djJob
            ? Object.keys(starts)
                  .map(Number)
                  .sort((a, b) => a - b)
                  .find((i) => starts[i] !== 'Entertainment')
            : undefined,
        prod: djJob ? productionTotals(lines, days) : { sub: 0, off: 0, pct: 0 }
    };
}

function sumPart(label, value) {
    return '<div class="qv-sumrow qv-sumpart"><span>' + esc(label) + '</span><span>' + value + '</span></div>';
}

/*  Equipment hire by group + hire subtotal, labour, vehicles, delivery, fees. */
function sumBreakdown(q, days, t) {
    let h = '';
    if (t.entCents) h += sumPart('Entertainment fee', money(t.entCents));
    if (t.groups.length) {
        const offs = spreadSaving(t.groupCents, Math.round(q.discountCents || 0));
        h += '<div class="qv-sumhead">Equipment hire</div>';
        h += t.groups
            .map(
                (g, i) =>
                    '<div class="qv-sumrow qv-sumsub"><span>' +
                    esc(g.name) +
                    '</span><span>' +
                    (offs && offs[i] ? wasMoney(g.cents) + money(g.cents - offs[i]) : money(g.cents)) +
                    '</span></div>'
            )
            .join('');
        h += sumPart('Hire subtotal', offs ? wasMoney(t.hire) + money(t.hire - q.discountCents) : money(t.hire));
    }
    if (t.hasLabour) h += sumPart('Labour', money(t.labourCents + t.crewCents));
    if (t.vehicleCents) h += sumPart('Vehicles', money(t.vehicleCents));
    if (t.delivery.length) h += sumPart(deliveryLabel(t), t.deliveryCents ? money(t.deliveryCents) : 'Free');
    t.fees.forEach((l) => {
        h += sumPart('Booking & admin', money(lineAmount(l, days)));
    });
    return h;
}

/*  The saving above the subtotal: "You save" when it fits the equipment
    groups, else a plain discount line. */
function discountSummary(q, t, prodPct) {
    if (!q.discountCents) return '';
    if (spreadSaving(t.groupCents, q.discountCents)) {
        return `<div class="qv-sumrow qv-save-row"><span>You save ${money(Math.round(q.discountCents * 1.1))} inc GST${prodPct ? ' &middot; ' + prodPct + '% off equipment hire' : ''}</span></div>`;
    }
    return `<div class="qv-sumrow qv-sumpart"><span>${prodPct ? 'Equipment discount (' + prodPct + '% off)' : 'Discount'}</span><span>&minus;${money(q.discountCents)}</span></div>`;
}

function exGstCents(q) {
    return Math.round(q.totalCents || 0) - Math.round(q.gstCents || 0);
}

function lateFeeDate(x) {
    return x.date ? ' &middot; ' + esc(dmy(x.date)) : '';
}

function docTitle(q) {
    if (q.kind === 'invoice') return 'Tax Invoice';
    return q.status === 'draft' ? 'Estimate' : 'Quote';
}

function statusBanner(q, isInvoice) {
    if (q.status === 'paid') return '<div class="qv-banner qv-ok">Paid &mdash; thank you!</div>';
    const accepted = q.status === 'accepted' || q.status === 'invoiced';
    if (!accepted || isInvoice) return '';
    return `<div class="qv-banner qv-ok">Accepted${q.acceptedName ? ' by ' + esc(q.acceptedName) : ''}${q.acceptedAt ? ' on ' + esc(fmtDate(q.acceptedAt)) : ''}</div>`;
}

function render(q) {
    const isInvoice = q.kind === 'invoice';
    const proposal = !isInvoice;
    const ref = isInvoice ? q.invoiceNumber || q.number : q.number;
    const c = q.customer || {};
    const days = Math.max(1, Math.round((q.hire && q.hire.days) || 1));
    const totals = quoteTotals(q, days);
    const doc = documentLayout(q, days);
    const rows = doc.lines.map((l, i) => sectionHead(doc, i) + lineRow(doc, l, i)).join('');
    const range = hireRange(q.hire);

    const accountBox = isInvoice
        ? `
    <div class="qv-pay">
      <h3>Payment &mdash; bank transfer</h3>
      <p><strong>${esc(SELLER.bankName)}</strong><br>
        BSB <strong>${esc(SELLER.bankBsb)}</strong> &nbsp; Account <strong>${esc(SELLER.bankAcc)}</strong><br>
        Reference: <strong>${esc(ref)}</strong></p>
    </div>`
        : '';

    document.getElementById('quote-root').innerHTML =
        (proposal ? proposalTop(q, days, totals) : '') +
        `
    ${proposal ? '<h2 class="qp-h2 qp-h2-doc" id="qp-itemised">Itemised quote</h2>' : ''}
    <div class="qv-doc" id="qv-doc">
      ${statusBanner(q, isInvoice)}
      <div class="qv-top">
        <div class="qv-brand">
          <img src="/images/logo-quote.png" alt="SoundzGood Whitsundays" class="qv-logo">
          <p class="qv-legal">${esc(SELLER.legal)}<br>ABN ${esc(SELLER.abn)}</p>
        </div>
        <div class="qv-meta">
          <h1>${esc(docTitle(q))}</h1>
          <p class="qv-ref">${esc(ref)}</p>
          <p class="qv-date">${esc(fmtDate(q.createdAt))}</p>
        </div>
      </div>

      <div class="qv-parties">
        <div>
          <h3>From</h3>
          <p><strong>${esc(SELLER.name)}</strong><br>${esc(SELLER.address)}<br>${esc(SELLER.phone)}<br>${esc(SELLER.email)}<br>${esc(SELLER.site)}</p>
        </div>
        <div>
          <h3>${isInvoice ? 'Bill to' : 'Prepared for'}</h3>
          <p>${c.name ? '<strong>' + esc(c.name) + '</strong><br>' : ''}${c.business ? esc(c.business) + '<br>' : ''}${c.email ? esc(c.email) + '<br>' : ''}${c.phone ? esc(c.phone) + '<br>' : ''}${c.address ? esc(c.address) : ''}</p>
        </div>
        <div>
          <h3>Job</h3>
          <p>${c.eventName ? '<strong>' + esc(c.eventName) + '</strong><br>' : ''}${c.eventDate ? esc(c.eventDate) + '<br>' : ''}${range && range !== String(c.eventDate || '').trim() ? esc(range) + '<br>' : ''}${days > 1 ? days + ' days charged' : ''}</p>
        </div>
      </div>

      <table class="qv-table">
        <thead>${
            doc.djJob
                ? '<tr><th>Item / Description</th><th class="qv-num">Hours</th><th class="qv-num">Fee (ex GST)</th><th class="qv-num">Days</th><th class="qv-num">Total (ex GST)</th></tr>'
                : '<tr><th>Description</th><th class="qv-num">Qty</th><th class="qv-num">Day rate</th><th class="qv-num">Days</th><th class="qv-num">Amount</th></tr>'
        }</thead>
        <tbody>${rows || '<tr><td colspan="5" class="qv-sub">No items.</td></tr>'}</tbody>
      </table>

      <div class="qv-sumwrap">
      <div class="qv-breakdown">${sumBreakdown(q, days, totals)}</div>
      <div class="qv-summary">
        <!-- adds straight down: discount first, then the subtotal after it -->
        ${discountSummary(q, totals, doc.prod.pct)}
        <div class="qv-sumrow qv-sumtotal"><span>Subtotal (ex GST)</span><span>${money(exGstCents(q))}</span></div>
        <div class="qv-sumrow"><span>GST (10%)</span><span>${money(q.gstCents)}</span></div>
        <div class="qv-sumrow qv-grand"><span>Total (incl GST)</span><span>${money(q.totalCents)}</span></div>
        ${(q.lateFees || []).map((x) => '<div class="qv-sumrow qv-late"><span>Late payment charge (2%)' + lateFeeDate(x) + '</span><span>' + money(x.cents) + '</span></div>').join('')}
        ${q.lateFeeCents ? '<div class="qv-sumrow qv-grand"><span>Total now owing</span><span>' + money(Math.max(0, (q.totalCents || 0) + q.lateFeeCents - (q.amountPaidCents || 0))) + '</span></div>' : ''}
      </div>
      </div>

      ${accountBox}
      ${q.notes ? `<div class="qv-notes"><h3>Notes</h3><p>${esc(q.notes)}</p></div>` : ''}
      ${q.terms ? `<div class="qv-notes"><h3>Terms</h3><p>${esc(q.terms)}</p></div>` : ''}

      <p class="qv-foot">${esc(SELLER.name)} &middot; ${esc(SELLER.legal)} &middot; ABN ${esc(SELLER.abn)}</p>
    </div>

    <div class="qv-actions" id="qv-actions">
      <button type="button" class="qv-btn qv-btn-ghost" id="qv-print">Download / Print PDF</button>
      <p class="qv-msg" id="qv-msg" hidden></p>
    </div>` +
        proposalBottom(q, { terms: proposal });
    wireProposal(q);

    const print = document.getElementById('qv-print');
    if (print) print.addEventListener('click', () => window.print());
    // "Download PDF" from the Sales Pipeline opens this page with &print=1
    if (/[?&]print=1\b/.test(location.search)) setTimeout(() => window.print(), 600);
}

/* ---------- 8  Proposal top ---------- */

/*  One scrolling page for a QUOTE: photo + event, a short intro, what's
    included, the investment summary, the itemised quote (the paper above),
    booking terms, then "Secure your booking" - pay the 50% deposit or in
    full by card (Stripe), or accept and pay by bank transfer. */
const HERO_PHOTO = {
    community: 'community-events.webp',
    corporate: 'corporate-functions.webp',
    festival: 'festivals.webp',
    wedding: 'weddings.webp',
    private: 'private-functions.webp',
    sporting: 'sporting-events.webp',
    touring: 'touring-bands.webp',
    dj: 'dj-entertainment.webp'
};

const ICON = {
    Audio: '<path d="M4 9v6h4l5 4V5L8 9H4zM16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12"/>',
    Lighting: '<path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9V16h7v-2.1A6 6 0 0012 3z"/>',
    Staging: '<path d="M3 15h18v3H3zM5 18v3M19 18v3M7 15V9h10v6"/>',
    Crew: '<path d="M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 11a2.5 2.5 0 100-5M21 20c0-2.8-1.6-5-4-5.6"/>',
    Other: '<path d="M4 7h16v12H4zM9 7V5h6v2"/>',
    Date: '<path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4"/>',
    Pin: '<path d="M12 21s-7-6.5-7-12a7 7 0 0114 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>'
};

const BLURB = {
    Audio: 'Clear sound for every crowd',
    Lighting: 'Atmosphere and impact',
    Staging: 'Safe and reliable stage setup',
    Crew: 'Experienced team from start to finish',
    Backline: 'Instruments and amps',
    'DJ equipment': 'Club-standard DJ gear',
    Vision: 'Screens and projection',
    Power: 'Safe power distribution',
    Other: 'Everything else you need'
};

/*  Investment rows that are never discounted. */
const NO_DISCOUNT = ['Entertainment fee', 'Labour', 'Vehicles', 'Travel & transport', 'Local delivery & pickup', 'Booking & admin'];

const POSTER_RE = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[\w.-]+\/o\/quote-images%2F[\w.%-]+\?[\w=&.-]+$/;

function svgIcon(k) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICON[k] || ICON.Other) + '</svg>';
}

function guessType(name) {
    const n = String(name || '').toLowerCase();
    if (/\bdj\b|entertainment/.test(n)) return 'dj';
    if (/wedding|bride|ceremony|reception/.test(n)) return 'wedding';
    if (/corporate|conference|awards|gala|dinner|launch|expo|ball/.test(n)) return 'corporate';
    if (/festival|concert|music|fest\b/.test(n)) return 'festival';
    if (/race|rodeo|cup|footy|football|rugby|cricket|fishing|sport|triathlon|carnival/.test(n)) return 'sporting';
    if (/birthday|party|engagement|anniversary|wake/.test(n)) return 'private';
    if (/tour|band|gig/.test(n)) return 'touring';
    return 'community';
}

/*  Everything the proposal top needs to know about the quote. */
function proposalFacts(q, days, t) {
    const c = q.customer || {};
    const type = HERO_PHOTO[c.eventType] ? c.eventType : guessType(c.eventName);
    const isDj = type === 'dj' || !!q.gigDj;
    // DJ ONLY: no gear or crew on the quote = no sound, lighting or setup
    // tiles, and the words don't promise them either
    const djGear = (q.lines || []).some((l) => !l.pubDj && (l.itemId || l.type === 'kit'));
    const djCrew = t.hasLabour;
    return {
        q,
        c,
        t,
        days,
        type,
        isDj,
        dj: q.gigDj || null,
        djGear,
        djCrew,
        djOnly: isDj && !djGear && !djCrew,
        // the event's own poster, if one was added, takes the place of the stock photo
        poster: c.eventType === 'custom' && POSTER_RE.test(String(q.posterUrl || '')) ? q.posterUrl : '',
        when: longDay(q.hire && q.hire.startDate) || c.eventDate || '',
        town: String((q.delivery && q.delivery.town) || '').replace(/\s*\(local\)/i, ''),
        event: c.eventName || 'your event',
        venueName: String(c.eventVenue || '').split(',')[0]
    };
}

function tile(icon, title, text) {
    return '<div class="qp-tile">' + svgIcon(icon) + '<b>' + esc(title) + '</b><span>' + esc(text) + '</span></div>';
}

function proposalTiles(p) {
    if (p.djOnly) return '';
    if (!p.isDj) {
        return p.t.groups
            .map((g) => g.name)
            .concat(p.t.hasLabour ? ['Crew'] : [])
            .map((k) => tile(k, k, BLURB[k] || ''))
            .join('');
    }
    const tiles = [['DJ equipment', 'Your DJ', p.dj ? p.dj.name + ' on the decks' : 'Live DJ for the night']];
    if (p.djGear) {
        tiles.push(['Audio', 'Sound', 'Clear sound right across the venue'], ['Lighting', 'Lighting', 'Party lighting & effects']);
    }
    if (p.djGear || p.djCrew) tiles.push(['Crew', 'Setup & pack-down', 'We set up, run and pack down']);
    return tiles.map(([icon, title, text]) => tile(icon, title, text)).join('');
}

/*  THE DJ, under the first paragraph: a big photo with their name, music
    styles and the song-requests promise beside it. */
function djFeatureHtml(dj) {
    if (!dj) return '';
    return (
        '<div class="qp-djf">' +
        (dj.photo ? '<img class="qp-djf-img" src="/' + esc(dj.photo) + '" alt="' + esc(dj.name) + '" onerror="this.remove()">' : '') +
        '<div class="qp-djf-text"><p class="qp-mini">Your DJ</p><h3>' +
        esc(dj.name) +
        '</h3>' +
        '<p class="qp-djf-set">' +
        esc(ampm(dj.start)) +
        ' &ndash; ' +
        esc(ampm(dj.finish)) +
        (dj.hours ? ' &middot; ' + esc(dj.hours) + ' hours' : '') +
        '</p>' +
        (dj.bio ? '<div class="qp-djf-bio">' + bioHtml(dj.bio, dj.name) + '</div>' : '') +
        ((dj.styles || []).length ? '<p class="qp-styles">' + dj.styles.map((x) => '<span>' + esc(x) + '</span>').join('') + '</p>' : '') +
        '<p class="qp-requests">&#127925; Our DJs take song requests from your patrons and work with your staff on any requests through the night.</p>' +
        '</div></div>'
    );
}

function heroIntro(p) {
    if (!p.isDj) {
        return `<p class="qp-intro">Thanks for the opportunity to provide event production for ${esc(p.event)}.
          We&rsquo;ve put together the following production plan based on what we&rsquo;ve discussed.
          Everything below covers the equipment, preparation and crew required to deliver a successful event.</p>`;
    }
    const night = p.djOnly
        ? 'Here&rsquo;s your DJ for the night. The full itemised breakdown is below.'
        : 'Here&rsquo;s your entertainment for the night &mdash; the DJ' +
          (p.djGear ? ', the sound and lighting,' : '') +
          ' and the setup and pack-down, all looked after. The full itemised breakdown is below.';
    return `<p class="qp-intro">Thanks for having SoundzGood Entertainment${p.venueName ? ' at ' + esc(p.venueName) : ''}. ${night}</p>${djFeatureHtml(p.dj)}`;
}

/*  Investment summary rows: [label, cents ex GST]. */
function investmentRows(p) {
    const { t, days } = p;
    const rows = [];
    if (t.entCents) rows.push(['Entertainment fee', t.entCents]);
    t.groups.forEach((g) => rows.push([g.name, g.cents])); // AUDIO, LIGHTING, STAGING... (shown in capitals)
    if (t.hasLabour) rows.push(['Labour', t.labourCents + t.crewCents]);
    if (t.vehicleCents) rows.push(['Vehicles', t.vehicleCents]);
    if (t.delivery.length) rows.push([deliveryLabel(t), t.deliveryCents]);
    t.fees.forEach((l) => rows.push(['Booking & admin', lineAmount(l, days)]));
    return rows;
}

/*  One row: ex GST / GST / inc GST, with the full price crossed out first
    when a saving applies. */
function investmentRow(label, ex, full) {
    const was = (c) => (c ? wasMoney(c) : '');
    return (
        '<tr><td>' +
        esc(label) +
        '</td><td>' +
        was(full) +
        (ex ? money(ex) : 'Free') +
        '</td><td>' +
        (ex ? money(Math.round(ex * 0.1)) : '') +
        '</td><td>' +
        (full ? was(Math.round(full * 1.1)) : '') +
        (ex ? money(Math.round(ex * 1.1)) : 'Free') +
        '</td></tr>'
    );
}

/*  DISCOUNT: crossed out per equipment row (spreadSaving), then a "You save"
    row; a plain discount row when it won't spread. Adds the full price to
    each discounted row: [label, after saving, full price]. */
function applyDiscount(q, rows) {
    if (!q.discountCents) return '';
    const discountable = rows.map((x) => (NO_DISCOUNT.includes(x[0]) ? 0 : x[1]));
    const offs = spreadSaving(discountable, Math.round(q.discountCents || 0));
    const youSave = money(Math.round(q.discountCents * 1.1));
    if (!offs) {
        return (
            '<tr class="qp-disc"><td>Discount</td><td>&minus;' +
            money(q.discountCents) +
            '</td><td></td><td>&minus;' +
            youSave +
            '</td></tr>'
        );
    }
    const base = rows.filter((x) => !NO_DISCOUNT.includes(x[0])).reduce((t, x) => t + Math.max(0, x[1]), 0);
    const pct = base ? Math.round((q.discountCents / base) * 100) : 0;
    rows.forEach((x, i) => {
        if (offs[i]) {
            x.push(x[1]);
            x[1] -= offs[i];
        }
    });
    return (
        '<tr class="qp-disc"><td colspan="4">You save ' +
        youSave +
        ' inc GST' +
        (pct ? ' &middot; ' + pct + '% off equipment hire' : '') +
        '</td></tr>'
    );
}

/*  "a, b & c" */
function joinAnd(list) {
    return list.length > 1 ? list.slice(0, -1).join(', ') + ' & ' + list[list.length - 1] : list[0];
}

/*  WHAT'S INCLUDED, built from what's on the quote (HTML strings). */
function includedList(p) {
    const { dj, t } = p;
    const items = [];
    if (p.isDj) {
        items.push('Professional DJ' + (dj ? ' &mdash; ' + esc(dj.name) + (dj.hours ? ' (' + esc(dj.hours) + ' hrs)' : '') : ''));
        if (p.djGear) items.push('PA system &amp; lighting, set up for the venue', 'DJ equipment &amp; booth');
        if (p.djGear || p.djCrew) items.push('Setup, sound check &amp; pack-down crew');
        if (p.djGear) items.push('Backup gear on site');
        items.push('Song requests from your patrons, and working with your staff on the night', 'GST included in the total');
        return items;
    }
    const gear = t.groups.filter((g) => g.name !== 'Other').map((g) => g.name.toLowerCase());
    if (gear.length) items.push(joinAnd(gear).replace(/^./, (x) => x.toUpperCase()) + ' equipment as itemised');
    items.push('All cables, stands & accessories needed to run it');
    if (t.delivery.length) {
        items.push(t.deliveryCents ? 'Travel &amp; transport' + (p.town ? ' &mdash; ' + esc(p.town) : '') : 'Local delivery &amp; pickup');
    }
    if (t.labour.length) {
        const hours = labourHours(t.labour);
        items.push('Bump-in &amp; bump-out crew' + (hours ? ' (' + hours + ' crew hours)' : ''));
    }
    items.push('GST included in the total');
    return items;
}

/*  What's included + quote details, under the investment table. */
function quoteDetails(p) {
    const q = p.q;
    const pct = q.depositPct || 50;
    const validUntil = q.createdAt ? fmtDate(q.createdAt + QUOTE_VALID_DAYS * 86400) : '';
    const toSecure = fullOnly(q)
        ? 'Payment in full &middot; ' + money(q.totalCents || 0)
        : pct + '% deposit &middot; ' + money(Math.round(((q.totalCents || 0) * pct) / 100));
    return (
        '<div class="qp-inv-extra">' +
        '<div class="qp-incl' +
        (p.isDj ? ' is-premium' : '') +
        '"><p class="qp-mini">What&rsquo;s included</p><ul>' +
        includedList(p)
            .map((t) => '<li>' + t + '</li>')
            .join('') +
        '</ul></div>' +
        '<div class="qp-qd"><p class="qp-mini">Quote details</p><dl>' +
        '<div><dt>Quote</dt><dd>' +
        esc(q.number || '') +
        '</dd></div>' +
        (q.createdAt ? '<div><dt>Issued</dt><dd>' + esc(fmtDate(q.createdAt)) + '</dd></div>' : '') +
        (validUntil ? '<div><dt>Valid until</dt><dd>' + esc(validUntil) + '</dd></div>' : '') +
        '<div><dt>To secure</dt><dd>' +
        toSecure +
        '</dd></div>' +
        '</dl></div></div>'
    );
}

function proposalTop(q, days, totals) {
    const p = proposalFacts(q, days, totals);
    const { c, isDj, dj, poster, when, town, venueName } = p;
    const tiles = proposalTiles(p);
    const rows = investmentRows(p);
    const discountRow = applyDiscount(q, rows);
    const photo = poster ? esc(poster) : '/images/services/' + (isDj && dj && dj.photo ? 'trailer-stage.webp' : HERO_PHOTO[p.type]);

    return `
    <section class="qp-hero">
      <div class="qp-hero-photo${isDj ? ' is-dj is-stage' : ''}${poster ? ' is-custom' : ''}" style="--qp-photo:url('${photo}')">
        ${poster ? '<div class="qp-hero-blur"></div><img class="qp-hero-img" src="' + esc(poster) + '" alt="">' : ''}
        <div class="qp-hero-in">
          <p class="qp-eyebrow">${isDj ? esc(venueName || 'Entertainment booking') : 'Event production proposal'}</p>
          <h1>${isDj ? 'SoundzGood Entertainment' : esc(p.event)}</h1>
          ${isDj && dj ? '<p class="qp-dj-line">Live: <b>' + esc(dj.name) + '</b></p>' : ''}
          <p class="qp-when">${when ? svgIcon('Date') + esc(when) : ''}${town ? '<br>' + svgIcon('Pin') + esc(town) : ''}</p>
        </div>
      </div>
      <div class="qp-hero-body">
        ${heroIntro(p)}
        ${tiles ? '<div class="qp-tiles">' + tiles + '</div>' : ''}
        <p class="qp-ref">Quote ${esc(q.number || '')}${c.name ? ' &middot; Prepared for ' + esc(c.name) : ''}</p>
      </div>
    </section>

    <section class="qp-sec qp-invest">
      <p class="qp-eyebrow">Investment summary</p>
      <h2 class="qp-h2">${isDj ? 'Your entertainment investment' : 'Your production investment'}</h2>
      <p class="qp-sub">Total inclusive of GST for ${esc(isDj && venueName ? 'your night at ' + venueName : p.event)}${when ? ' on ' + esc(when) : ''}, itemised by category below.</p>
      <table class="qp-inv">
        <thead><tr><th>Description</th><th>Ex GST</th><th>GST (10%)</th><th>Inc GST</th></tr></thead>
        <tbody>${rows.map(([label, ex, full]) => investmentRow(label, ex, full)).join('')}${discountRow}</tbody>
        <tfoot><tr><td>Total inc. GST</td><td></td><td></td><td>${money(q.totalCents)}</td></tr></tfoot>
      </table>
      ${quoteDetails(p)}
      <a class="qp-jump" href="#qp-book">Accept &amp; secure your booking &darr;</a>
    </section>`;
}

/* ---------- 9  Payment rules ---------- */

/*  PAY IN FULL WITHIN 7 DAYS. The balance is due 7 days before the event, so
    once that day arrives there is no deposit option - only payment in full.
    The server (quoteCheckout) enforces the same rule. */
function balanceDueDate(q) {
    return isoToDate(q.hire && q.hire.startDate, -7);
}

function fullOnly(q) {
    if (q.payFull === true) return true; // "pay in full up front" - new venues
    const due = balanceDueDate(q);
    if (!due) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return due <= today;
}

/*  The amounts and wording the booking section works from. */
function paymentFacts(q) {
    const isInv = q.kind === 'invoice';
    const total = Math.round(q.totalCents || 0);
    const lateCents = Math.round(q.lateFeeCents || 0); // late payment charges, on top of the total
    const pct = q.depositPct || 50;
    const paid = Math.round(q.amountPaidCents || 0);
    const due = balanceDueDate(q);
    return {
        isInv,
        total,
        pct,
        deposit: Math.round((total * pct) / 100),
        paid,
        owing: Math.max(0, total + lateCents - paid),
        ref: (isInv && q.invoiceNumber) || q.number || '',
        balDue: due ? dayLabel(due, SHORT_DAY) : '7 days before your event'
    };
}

/* ---------- 10  Proposal bottom ---------- */

const CLOCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const WARN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/></svg>';
const LOCK_PATH = '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
const BANK_PATH = '<path d="M3 10h18M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18M12 3l9 5H3z"/>';
const CARD_PATH = '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h4"/>';

function isDjQuote(q) {
    return (q.customer && q.customer.eventType === 'dj') || !!q.gigDj;
}

/*  ONE dropdown with every clause inside - deliberately looks like serious
    small print. DJ / entertainment quotes get the DJ booking terms. */
function termsHtml(djQuote) {
    const clauses = djQuote ? DJ_TERMS : TERMS;
    const intro = djQuote ? DJ_TERMS_INTRO : TERMS_INTRO;
    return (
        '<details class="qp-term qp-legal"><summary><span class="qp-legal-warn">&#9888;</span><span><b>' +
        (djQuote ? 'Entertainment Booking ' : '') +
        'Terms &amp; Conditions &mdash; read before booking</b><em>' +
        clauses.length +
        ' clauses &middot; binding once you accept or pay &middot; tap to read</em></span></summary>' +
        '<div class="qp-legal-body">' +
        intro.map((t) => '<p>' + esc(t) + '</p>').join('') +
        clauses
            .map(
                ([h, lines], i) =>
                    '<div class="qp-legal-clause"><h4>' + (i + 1) + '. ' + esc(h) + '</h4>' + termBodyHtml(lines, esc) + '</div>'
            )
            .join('') +
        '</div></details>'
    );
}

/*  1 Accept quote -> 2 Get your invoice -> 3 Pay */
function stepsHtml(at) {
    const step = (text, i) => {
        const n = i + 1;
        let cls = '';
        if (n < at) cls = 'is-done';
        else if (n === at) cls = 'is-on';
        return '<li class="' + cls + '"><span>' + (n < at ? '&#10003;' : n) + '</span>' + text + '</li>';
    };
    return '<ol class="pg-steps">' + ['Accept quote', 'Get your invoice', 'Pay'].map(step).join('') + '</ol>';
}

/*  Once accepted: "Your tax invoice SG-I-0012" + Download invoice. */
function invoiceHead(q) {
    if (!q.invoiceNumber) return '';
    return (
        '<div class="pg-invhead"><div><span>Your tax invoice</span><b>' +
        esc(q.invoiceNumber) +
        '</b></div><button type="button" class="qv-btn qv-btn-ghost pg-print" data-print>Download invoice</button></div>'
    );
}

/*  LATE PAYMENT CHARGES shown plainly. */
function lateFeesBox(q, owing) {
    if (!(q.lateFees || []).length) return '';
    return (
        '<div class="pg-late"><b>Late payment charges added</b>' +
        q.lateFees
            .map((x) => '<div><span>2% late payment charge' + lateFeeDate(x) + '</span><span>' + money(x.cents) + '</span></div>')
            .join('') +
        '<p>Your invoice was unpaid more than 28 days after its due date, so a 2% charge applies (see Terms &amp; Conditions &ldquo;Overdue payments&rdquo;). Another 2% is added for each further month unpaid. Amount now owing: <strong>' +
        money(owing) +
        '</strong>.</p></div>'
    );
}

function bankDetails(ref) {
    return (
        '<p class="qp-bank"><strong>Bank transfer</strong><br>' +
        esc(SELLER.bankName) +
        '<br>BSB <strong>' +
        esc(SELLER.bankBsb) +
        '</strong> &nbsp; Account <strong>' +
        esc(SELLER.bankAcc) +
        '</strong><br>Reference: <strong>' +
        esc(ref) +
        '</strong></p>'
    );
}

/*  A card payment button, only when card payments are on. */
function cardButton(q, pay, label, style) {
    if (!q.cardOn) return '';
    return '<button type="button" class="qv-btn qv-btn-' + style + ' qp-go" data-pay="' + pay + '">' + label + '</button>';
}

/*  What the main button says: bank -> invoice, card -> pay the amount. */
function ctaLabel(option, amount) {
    if (option.startsWith('bank')) return 'Accept quote &amp; get invoice';
    if (option === 'deposit') return 'Accept quote &amp; pay ' + amount + ' deposit';
    return 'Accept quote &amp; pay ' + amount;
}

/*  One payment option (a radio card). */
function payOption(option, title, sub, amount, checked, extra, disabled) {
    return (
        '<label class="pg-opt' +
        (disabled ? ' is-off' : '') +
        '">' +
        '<input type="radio" name="qp-opt" value="' +
        option +
        '" data-cta="' +
        ctaLabel(option, amount) +
        '"' +
        (checked ? ' checked' : '') +
        (disabled ? ' disabled' : '') +
        '>' +
        '<span class="pg-ic" aria-hidden="true"><svg viewBox="0 0 24 24">' +
        (option.startsWith('bank') ? BANK_PATH : CARD_PATH) +
        '</svg></span>' +
        '<span class="pg-opt-body"><b>' +
        title +
        '</b><em>' +
        sub +
        '</em><strong>' +
        amount +
        '</strong>' +
        (extra || '') +
        '</span>' +
        (disabled ? '<span class="pg-badge">Not available</span>' : '') +
        '</label>'
    );
}

function alertBox(cls, icon, title, text, small) {
    return (
        '<div class="pg-alert ' + cls + '">' + icon + '<div><b>' + title + '</b><p>' + text + '</p><small>' + small + '</small></div></div>'
    );
}

/*  The alert on top: pay in full up front, "Payment due now" inside 7 days,
    otherwise "deposit secures your date". */
function paymentAlert(q, m, full) {
    if (q.payFull === true) {
        return alertBox(
            'pg-alert-amber',
            CLOCK_SVG,
            'Payment in full to confirm',
            'Your booking is confirmed once the full amount is received.',
            'Pay by bank transfer or card below.'
        );
    }
    if (full) {
        return alertBox(
            'pg-alert-red',
            WARN_SVG,
            'Payment due now',
            'Your event is less than 7 days away, so the full amount is due now.',
            'Please pay today to secure your booking.'
        );
    }
    return alertBox(
        'pg-alert-amber',
        CLOCK_SVG,
        'Secure your date',
        'Your date is held once the ' + m.pct + '% deposit is received.',
        'The balance is due ' + esc(m.balDue) + '.'
    );
}

function trustRow(path, title, text) {
    return (
        '<div class="pg-trust-row"><span class="pg-trust-ic" aria-hidden="true"><svg viewBox="0 0 24 24">' +
        path +
        '</svg></span><div><b>' +
        title +
        '</b><span>' +
        text +
        '</span></div></div>'
    );
}

/*  THE PAYMENT GATEWAY: bank transfer first, then card in full, then card
    deposit (greyed out within 7 days). Summary card on the right with what
    is due now. */
function paymentGateway(q, m) {
    const full = fullOnly(q);
    const { total, deposit, pct } = m;
    const refChip =
        '<span class="pg-ref"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/></svg>Use reference: <b>' +
        esc(m.ref) +
        '</b></span>';

    let options = full
        ? payOption('bank', 'Bank transfer (Pay in full)', 'Pay the full amount now via bank transfer.', money(total), true, refChip)
        : payOption(
              'bank',
              'Bank transfer (' + pct + '% deposit)',
              'Pay the deposit now via bank transfer.',
              money(deposit),
              true,
              refChip
          ) +
          payOption(
              'bankfull',
              'Bank transfer (Pay in full)',
              'Pay the full amount now via bank transfer. Nothing more to pay later.',
              money(total),
              false,
              refChip
          );
    if (q.cardOn) {
        options += payOption(
            'full',
            'Credit or debit card (Pay in full)',
            'Fast, secure payment with Visa, Mastercard or Amex.',
            money(total),
            false
        );
    }
    if (q.cardOn && q.payFull !== true) {
        const title = 'Credit or debit card (' + pct + '% deposit)';
        options += full
            ? payOption(
                  'deposit',
                  title,
                  'A ' + pct + '% deposit is not available as your event is less than 7 days away.',
                  money(deposit),
                  false,
                  '',
                  true
              )
            : payOption('deposit', title, 'Secure your date by card. Balance due ' + esc(m.balDue) + '.', money(deposit), false);
    }

    const dueNow = full
        ? '<div class="pg-due pg-due-red"><span>Amount due now</span><span>' + money(total) + '</span></div>'
        : '<div class="pg-due pg-due-amber" data-due="deposit"><span>Deposit due now</span><span>' +
          money(deposit) +
          '</span></div>' +
          '<div class="qv-sumrow" data-due="deposit"><span>Balance due ' +
          esc(m.balDue) +
          '</span><span>' +
          money(total - deposit) +
          '</span></div>' +
          // shown instead when a pay-in-full option is picked
          '<div class="pg-due pg-due-amber" data-due="full" hidden><span>Amount due now</span><span>' +
          money(total) +
          '</span></div>';

    return (
        '<p class="pg-lead">Your booking is confirmed once payment is received.</p>' +
        stepsHtml(1) +
        '<div class="qp-book-grid pg-grid"><div>' +
        paymentAlert(q, m, full) +
        options +
        '<label class="qp-name">Your name / Business<input type="text" id="qp-name" autocomplete="name" value="' +
        esc((q.customer && q.customer.name) || '') +
        '"></label>' +
        '<label class="qp-agree"><input type="checkbox" id="qp-agree"> <span>I have read and accept the <b>Terms &amp; Conditions</b> and this quote.</span></label>' +
        '<button type="button" class="qv-btn qv-btn-primary qp-go pg-go" id="qp-go" disabled><svg viewBox="0 0 24 24" aria-hidden="true">' +
        LOCK_PATH +
        '</svg><span id="qp-go-label">' +
        ctaLabel('bank') +
        '</span></button>' +
        '<p class="pg-note">Accepting turns this quote into your tax invoice.</p>' +
        '</div><aside class="qp-side pg-side">' +
        '<div class="pg-total"><span class="pg-total-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3h10v18H7z"/><path d="M10 8h4M10 12h4M10 16h2"/></svg></span><div><p class="qp-eyebrow">Quote summary</p><strong>' +
        money(total) +
        '</strong><span>Total (inc. GST)</span></div></div>' +
        // after any discount, so subtotal + GST = total
        '<div class="qv-sumrow"><span>Subtotal (ex GST)</span><span>' +
        money(exGstCents(q)) +
        '</span></div>' +
        '<div class="qv-sumrow"><span>GST (10%)</span><span>' +
        money(q.gstCents) +
        '</span></div>' +
        '<div class="qv-sumrow qv-grand"><span>Total (inc. GST)</span><span>' +
        money(total) +
        '</span></div>' +
        dueNow +
        '<div class="pg-trust">' +
        trustRow(LOCK_PATH, 'Secure payments', 'Card payments are processed securely by Stripe.') +
        trustRow(
            '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
            'Your booking is protected',
            'Once payment is received, your booking is confirmed.'
        ) +
        trustRow(
            '<path d="M7 3h10v18l-2-1.5L13 21l-2-1.5L9 21l-2-1.5z"/><path d="M10 8h4M10 12h4"/>',
            'Tax invoice provided',
            'Your tax invoice is on this page once you&rsquo;ve paid.'
        ) +
        '</div></aside></div>'
    );
}

/*  Accepted, paying by bank transfer: what to pay and by when. */
function bankTransferDue(q, m) {
    const accepted = '<div class="qp-done">&#10003; Quote accepted' + (q.acceptedName ? ' by ' + esc(q.acceptedName) : '') + '.</div>';
    const bank = bankDetails(m.ref);
    if (fullOnly(q)) {
        return (
            accepted +
            '<p class="qp-full-note qp-overdue"><b>Payment due now.</b> Your event is less than 7 days away. Please transfer the full <strong>' +
            money(m.owing) +
            '</strong> today to keep your booking.</p>' +
            bank +
            cardButton(q, 'full', 'Or pay in full by card', 'ghost')
        );
    }
    if (q.bankPlan === 'full') {
        // they chose bank transfer IN FULL
        return (
            accepted +
            '<p class="qp-full-note">You chose to pay in full. Please transfer <strong>' +
            money(m.owing) +
            '</strong> by ' +
            esc(m.balDue) +
            '. Your date is held once the payment lands.</p>' +
            bank +
            cardButton(q, 'full', 'Or pay in full by card', 'ghost')
        );
    }
    return (
        accepted +
        '<p class="qp-full-note">Your date is not held until the deposit lands. Please transfer the ' +
        m.pct +
        '% deposit of <strong>' +
        money(m.deposit) +
        '</strong> today.</p>' +
        bank +
        cardButton(q, 'deposit', 'Or pay the deposit by card', 'ghost')
    );
}

/*  The booking section's body, by where the quote is up to. */
function bookingHtml(q, m) {
    const lateBox = lateFeesBox(q, m.owing);
    const bank = bankDetails(m.ref);

    if (q.status === 'draft') {
        // an ESTIMATE (not yet approved by SoundzGood): nothing to accept or pay yet
        return '<div class="qp-done">This is an estimate. Once we&rsquo;ve checked the details we&rsquo;ll send your formal quote to accept.</div>';
    }
    if (q.paymentStatus === 'paid') {
        return (
            stepsHtml(4) + invoiceHead(q) + '<div class="qp-done">&#10003; Paid in full &mdash; thank you! Your booking is locked in.</div>'
        );
    }
    if (q.paymentStatus === 'deposit') {
        const balance = fullOnly(q)
            ? '<p class="qp-full-note qp-overdue"><b>Payment overdue.</b> The balance of <strong>' +
              money(m.owing) +
              '</strong> was due 7 days before your event. Please pay it today.</p>'
            : '<p class="qp-sub">Balance of <strong>' + money(m.owing) + '</strong> due ' + esc(m.balDue) + '.</p>';
        return (
            stepsHtml(3) +
            invoiceHead(q) +
            lateBox +
            '<div class="qp-done">&#10003; Deposit of ' +
            money(m.paid) +
            ' received &mdash; your date is secured.</div>' +
            balance +
            cardButton(q, 'balance', 'Pay the balance by card', 'primary') +
            bank
        );
    }
    if (q.paymentStatus === 'bank') {
        return stepsHtml(3) + invoiceHead(q) + lateBox + bankTransferDue(q, m);
    }
    if (/[?&]paid=1/.test(location.search)) {
        // back from Stripe before the payment has landed
        return '<div class="qp-done">&#10003; Payment received &mdash; thank you! Confirming your booking&hellip;</div>';
    }
    if (m.isInv) {
        // an invoice made in admin (not accepted online): pay it in full
        let due = '';
        if (balanceDueDate(q)) due = fullOnly(q) ? ', <strong>due now</strong>' : ', due ' + esc(m.balDue);
        return (
            stepsHtml(3) +
            invoiceHead(q) +
            lateBox +
            '<div class="qp-done">Invoice ' +
            esc(m.ref) +
            ' &mdash; ' +
            money(m.owing) +
            ' to pay' +
            due +
            '.</div>' +
            cardButton(q, 'full', 'Pay by card', 'primary') +
            bank
        );
    }
    if (q.status === 'accepted') {
        return '<div class="qp-done">&#10003; Quote accepted. We&rsquo;ll be in touch about payment.</div>';
    }
    return paymentGateway(q, m);
}

function bookingTitle(q) {
    if (q.status === 'draft') return 'Estimate only';
    return q.paymentStatus ? 'Your booking' : 'Choose a payment option';
}

/*  Gear-list team, terms and the booking / payment section.
    opts.terms === false leaves out the team and terms (tax invoices). */
function proposalBottom(q, opts = {}) {
    const m = paymentFacts(q);
    const djQuote = isDjQuote(q);
    const showTerms = opts.terms !== false;
    const book = bookingHtml(q, m);

    const termsSec = showTerms
        ? `
    <section class="qp-sec qp-terms">
      ${termsHtml(djQuote)}
      <p class="qp-terms-link">Also at <a href="/${djQuote ? 'dj-terms' : 'terms'}" target="_blank" rel="noopener">soundzgood.com.au/${djQuote ? 'dj-terms' : 'terms'}</a></p>
    </section>`
        : '';
    const teamSec = showTerms && !djQuote && q.status !== 'draft' ? gearTeamSec(q) : '';
    const locked = q.needsDetails && q.status !== 'draft' && !q.paymentStatus;
    return (
        teamSec +
        termsSec +
        `
    <section class="qp-sec qp-book" id="qp-book">
      <p class="qp-eyebrow">${m.isInv ? 'Payment' : 'Secure your booking'}</p>
      <h2 class="qp-h2">${bookingTitle(q)}</h2>
      ${locked ? detailsLock(q, book) : book}
      <p class="qv-msg" id="qp-msg" hidden></p>
    </section>`
    );
}

/* ---------- 11  Forms ---------- */

function gearEmailList(q) {
    return String((q.customer || {}).gearEmails || '')
        .split(/[,;\s]+/)
        .filter(Boolean);
}

/*  "Share the gear list with your team": the customer adds their band,
    tour manager or tech. They get the gear list (no prices) automatically. */
function gearTeamSec(q) {
    const list = gearEmailList(q);
    return `<section class="qp-sec qp-team" id="qp-team">
      <p class="qp-eyebrow">Your team</p>
      <h2 class="qp-h2">Share the gear list</h2>
      <p class="qp-sub">Add your band, tour manager or tech. They&rsquo;ll get the gear list when your booking is confirmed, 3 days before and on the day.</p>
      <ul class="qp-team-list">${list.map((e) => `<li><span>${esc(e)}</span><button type="button" data-team-rm="${esc(e)}" aria-label="Remove ${esc(e)}">&times;</button></li>`).join('')}</ul>
      ${list.length < 10 ? `<form class="qp-team-add" id="qp-team-add" novalidate><input type="email" id="qp-team-in" placeholder="Team member&rsquo;s email" autocomplete="off"><button type="submit">Add</button></form>` : ''}
      <div class="qp-team-share">
        <span>Or send them the link yourself:</span>
        <button type="button" id="qp-team-share">Share link</button>
      </div>
      <p class="qp-dmsg" id="qp-team-msg" hidden></p>
    </section>`;
}

/*  Event start times, every half hour from 6am to 11:30pm. */
function startTimeOptions(current) {
    const pad = (n) => String(n).padStart(2, '0');
    let out = '<option value="">Choose a time</option>';
    for (let m = 6 * 60; m < 24 * 60; m += 30) {
        const hhmm = pad(Math.floor(m / 60)) + ':' + pad(m % 60);
        out += '<option value="' + hhmm + '"' + (hhmm === current ? ' selected' : '') + '>' + ampm(hhmm) + '</option>';
    }
    return out;
}

function detailField(name, label, val, type, required, wide, placeholder) {
    return `<label class="qp-df${wide ? ' is-wide' : ''}"><span>${label}${required ? ' <b>*</b>' : ' <i>(optional)</i>'}</span><input name="${name}" type="${type || 'text'}" value="${esc(val || '')}"${placeholder ? ' placeholder="' + esc(placeholder) + '"' : ''}></label>`;
}

/*  No name / email / phone on the quote yet: the payment options sit greyed
    out, and "Add your details" pops up the same form as the /details link.
    Once it's saved, they unlock. */
function detailsLock(q, book) {
    const c = q.customer || {};
    const f = detailField;
    const parts = String(c.name || '')
        .trim()
        .split(/\s+/);
    return `<div class="qp-lock">
    <div class="qp-lock-under" aria-hidden="true" inert>${book}</div>
    <div class="qp-lock-card">
      <h3>Add your details to pay</h3>
      <p>We just need a few details for your booking and tax invoice.</p>
      <button type="button" class="qp-dgo" id="qp-dopen">Add your details</button>
    </div>
  </div>
  <div class="qp-dpop" id="qp-dpop" hidden>
    <form class="qp-dform" id="qp-dform" novalidate>
      <button type="button" class="qp-dx" id="qp-dx" aria-label="Close">&times;</button>
      <p class="qp-eyebrow">SoundzGood Whitsundays</p>
      <h3>Your details</h3>
      <p class="qp-dnote"><b>*</b> Required</p>
      <div class="qp-dgrid">
        ${f('firstName', 'First name', parts[0], 'text', true)}
        ${f('lastName', 'Last name', parts.slice(1).join(' '), 'text', true)}
        ${f('business', 'Business / organisation', c.business, 'text', false, true, 'Who the invoice is made out to - leave blank for your own name')}
        ${f('email', 'Email', c.email, 'email', true, false, 'Your email')}
        ${f('phone', 'Phone', c.phone, 'tel', true, false, 'Your phone')}
        ${f('dayContact', 'Event day contact', c.dayContact, 'text', false, true, 'Name and phone of who we deal with on the day')}
        ${f('ccEmail', 'Accounts / billing email', c.ccEmail, 'text', false, true, 'Gets a copy of the quote and invoice')}
        ${f('address', 'Your address', c.address, 'text', false, true, 'For the invoice')}
        ${q.gigDj ? '' : f('gearEmails', 'Share the gear list with your team', c.gearEmails, 'text', false, true, 'Band, tour manager or tech emails - they get the gear list')}
        <label class="qp-df"><span>Event start time <b>*</b></span><select name="eventStartTime">${startTimeOptions(c.eventStartTime)}</select></label>
        ${f('eventVenue', 'Venue name &amp; address', c.eventVenue, 'text', true)}
        <label class="qp-df is-wide"><span>Anything we should know? <i>(optional)</i></span><textarea name="customerNotes" rows="3" placeholder="Access, parking, power, timings, special requests&hellip;">${esc(c.customerNotes || '')}</textarea></label>
      </div>
      <button type="submit" class="qp-dgo" id="qp-dgo">Continue to payment</button>
      <p class="qp-dmsg" id="qp-dmsg" hidden></p>
    </form>
  </div>`;
}

/* ---------- 12  Wiring ---------- */

let escapeKeyWired = false; // the Escape key closes the details popup; wired once

function showText(el, text) {
    el.hidden = false;
    el.textContent = text;
}

function scrollToBooking() {
    const b = document.getElementById('qp-book');
    if (b) b.scrollIntoView();
}

/*  Gear-list team: add / remove emails, share the read-only link. */
function wireGearTeam(q) {
    const team = document.getElementById('qp-team');
    if (!team) return;
    const msg = document.getElementById('qp-team-msg');
    const save = async (list) => {
        msg.hidden = true;
        try {
            const res = await callable.gearTeam({ token: token(), emails: list.join(', ') });
            q.customer = { ...(q.customer || {}), gearEmails: res.data.gearEmails };
            const y = window.scrollY;
            render(q);
            window.scrollTo(0, y);
        } catch (err) {
            showText(msg, (err && err.message) || 'Could not save. Please try again.');
        }
    };
    team.querySelectorAll('[data-team-rm]').forEach((b) =>
        b.addEventListener('click', () => save(gearEmailList(q).filter((e) => e !== b.getAttribute('data-team-rm'))))
    );

    // the read-only gear list link - share sheet where the device has one, else it copies
    let gearUrl = '';
    const link = async () => gearUrl || (gearUrl = (await callable.gearLink({ token: token() })).data.url);
    const copy = async (btn) => {
        const u = await link();
        try {
            await navigator.clipboard.writeText(u);
            const was = btn.textContent;
            btn.textContent = 'Link copied ✓';
            setTimeout(() => {
                btn.textContent = was;
            }, 2500);
        } catch (e) {
            window.prompt('Copy this link:', u);
        }
    };
    const shareBtn = document.getElementById('qp-team-share');
    shareBtn.addEventListener('click', async () => {
        try {
            const u = await link();
            if (!navigator.share) return copy(shareBtn);
            await navigator.share({
                title: 'Gear list - ' + ((q.customer || {}).eventName || 'SoundzGood'),
                text: 'Here’s the gear SoundzGood is supplying:',
                url: u
            });
        } catch (err) {
            if (err && err.name !== 'AbortError') showText(msg, err.message || 'Could not share.');
        }
    });

    const add = document.getElementById('qp-team-add');
    if (!add) return;
    add.addEventListener('submit', (e) => {
        e.preventDefault();
        const email = String(document.getElementById('qp-team-in').value || '')
            .trim()
            .toLowerCase();
        if (!EMAIL_RE.test(email)) {
            showText(msg, 'Please enter a valid email address.');
            return;
        }
        const list = gearEmailList(q);
        if (list.map((x) => x.toLowerCase()).includes(email)) return;
        save([...list, email]);
    });
}

/*  The "Add your details" popup and its form. */
function wireDetailsForm() {
    const dpop = document.getElementById('qp-dpop');
    if (!dpop) return;
    const dform = document.getElementById('qp-dform');
    const open = (on) => {
        dpop.hidden = !on;
        document.body.style.overflow = on ? 'hidden' : '';
        if (on) {
            const i = dform.querySelector('input');
            if (i) i.focus();
        }
    };
    document.getElementById('qp-dopen').addEventListener('click', () => open(true));
    document.getElementById('qp-dx').addEventListener('click', () => open(false));
    dpop.addEventListener('click', (e) => {
        if (e.target === dpop) open(false);
    });
    if (!escapeKeyWired) {
        escapeKeyWired = true;
        document.addEventListener('keydown', (e) => {
            const p = document.getElementById('qp-dpop');
            if (e.key === 'Escape' && p && !p.hidden) {
                p.hidden = true;
                document.body.style.overflow = '';
            }
        });
    }
    dform.addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = (n) => String((dform.querySelector('[name="' + n + '"]') || {}).value || '').trim();
        const msg = document.getElementById('qp-dmsg');
        const missing = [];
        if (!v('firstName')) missing.push('your first name');
        if (!v('lastName')) missing.push('your last name');
        if (!EMAIL_RE.test(v('email'))) missing.push('your email');
        if (v('phone').replace(/[^0-9]/g, '').length < 8) missing.push('your phone number');
        if (!v('eventStartTime')) missing.push('the event start time');
        if (!v('eventVenue')) missing.push('the venue');
        if (missing.length) {
            showText(msg, 'Please add ' + missing.join(', ') + '.');
            return;
        }
        const btn = document.getElementById('qp-dgo');
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
            await callable.details({
                token: token(),
                name: v('firstName') + ' ' + v('lastName'),
                business: v('business'),
                email: v('email'),
                phone: v('phone'),
                ccEmail: v('ccEmail'),
                gearEmails: v('gearEmails'),
                address: v('address'),
                dayContact: v('dayContact'),
                eventStartTime: v('eventStartTime'),
                eventVenue: v('eventVenue'),
                customerNotes: v('customerNotes')
            });
            const fresh = await fetchQuote();
            document.body.style.overflow = '';
            render(fresh);
            scrollToBooking();
        } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Continue to payment';
            showText(msg, (err && err.message) || 'Could not save. Please try again.');
        }
    });
}

/*  Accepting and paying: card buttons, the payment options and the main button. */
function wirePayment(q) {
    const msg = document.getElementById('qp-msg');
    const say = (text, bad) => {
        if (!msg) return;
        showText(msg, text);
        msg.className = 'qv-msg' + (bad ? ' qv-bad' : '');
    };
    const openCheckout = async (name, option) => {
        say('Opening secure payment…');
        const res = await callable.checkout({ token: token(), name, option, agreed: true });
        location.href = res.data.url;
    };

    // back from Stripe before the webhook has landed: check again a few times
    if (/[?&]paid=1/.test(location.search) && !q.paymentStatus) {
        let tries = 0;
        const timer = setInterval(async () => {
            tries++;
            try {
                const fresh = await fetchQuote();
                if (fresh.paymentStatus || tries > 8) {
                    clearInterval(timer);
                    render(fresh);
                }
            } catch (e) {
                if (tries > 8) clearInterval(timer);
            }
        }, 2500);
    }

    // pay balance / deposit by card after accepting
    document.querySelectorAll('[data-pay]').forEach((b) =>
        b.addEventListener('click', async () => {
            b.disabled = true;
            try {
                const name = q.acceptedName || (q.customer && q.customer.name) || 'Customer';
                await openCheckout(name, b.getAttribute('data-pay') === 'deposit' ? 'deposit' : 'full');
            } catch (err) {
                b.disabled = false;
                say((err && err.message) || 'Could not open payment. Please try again.', true);
            }
        })
    );

    const go = document.getElementById('qp-go');
    if (!go) return;
    const goLabel = document.getElementById('qp-go-label');
    document.querySelectorAll('input[name="qp-opt"]').forEach((r) =>
        r.addEventListener('change', () => {
            if (!r.checked) return;
            if (goLabel) goLabel.innerHTML = r.getAttribute('data-cta') || 'Accept &amp; continue';
            // the summary follows the choice: deposit + balance, or the whole amount now
            const whole = r.value === 'full' || r.value === 'bankfull';
            document.querySelectorAll('[data-due="deposit"]').forEach((el) => {
                el.hidden = whole;
            });
            document.querySelectorAll('[data-due="full"]').forEach((el) => {
                el.hidden = !whole;
            });
        })
    );
    // no paying or confirming until the terms box is ticked
    const agreeBox = document.getElementById('qp-agree');
    if (agreeBox) {
        agreeBox.addEventListener('change', () => {
            go.disabled = !agreeBox.checked;
        });
    }
    go.addEventListener('click', async () => {
        const pick = (document.querySelector('input[name="qp-opt"]:checked') || {}).value || 'bank';
        const name = String((document.getElementById('qp-name') || {}).value || '').trim();
        const agreed = !!(document.getElementById('qp-agree') || {}).checked;
        if (!name) return say('Please type your name.', true);
        if (!agreed) return say('Please tick the box to accept the Terms & Conditions.', true);
        go.disabled = true;
        try {
            if (pick === 'bank' || pick === 'bankfull') {
                say('Accepting…');
                await callable.accept({ token: token(), name, method: 'bank', plan: pick === 'bankfull' ? 'full' : 'deposit' });
                render(await fetchQuote());
                scrollToBooking();
            } else {
                await openCheckout(name, pick);
            }
        } catch (err) {
            go.disabled = false;
            say((err && err.message) || 'Something went wrong. Please try again.', true);
        }
    });
}

function wireProposal(q) {
    wireGearTeam(q);
    wireDetailsForm();
    // Download invoice (on the accepted / invoice view)
    document.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => window.print()));
    // printing / PDF: show every booking term, not just the open one
    window.addEventListener('beforeprint', () =>
        document.querySelectorAll('.qp-term').forEach((d) => {
            d.open = true;
        })
    );
    wirePayment(q);
}

/* ---------- 13  Start ---------- */

function fail(text) {
    document.getElementById('quote-root').innerHTML =
        `<div class="qv-empty"><h1>${esc(text)}</h1><p>If you think this is a mistake, please <a href="/contact">get in touch</a>.</p></div>`;
}

async function load() {
    if (!token()) return fail('No quote in this link.');
    if (!isFirebaseConfigured) return fail('This link cannot be opened right now.');
    try {
        await initFns();
        render(await fetchQuote());
        // from the email's "Add your team" link
        const to = location.hash === '#qp-team' && document.getElementById('qp-team');
        if (to) to.scrollIntoView();
    } catch (err) {
        fail('This link is not valid or has expired.');
    }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
else load();
