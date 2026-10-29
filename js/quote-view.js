/* ==========================================================================
   QUOTE / INVOICE  -  the public document page (/quote?t=<token>)

   Fetches one quote by its secret token through the getQuote function (the
   collection itself is closed to browsers), renders it as a traditional
   quote or tax invoice, and lets the customer Accept a quote or print/save
   it as a PDF. Prices are ex-GST; GST is shown at 10%.
   ========================================================================== */

import { TERMS, TERMS_INTRO, termBodyHtml } from './terms-data.js?v=750';
import { DJ_TERMS, DJ_TERMS_INTRO } from './dj-terms-data.js?v=750';   // DJ / entertainment quotes
import { firebaseConfig, functionsRegion, isFirebaseConfigured } from './firebase-config.js?v=750';

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
  bankAcc: '815818305',
};

/*  ON / OFF SWITCH: group the customer's itemised quote into sections -
    AUDIO, LIGHTING, STAGING, BACKLINE ... then LABOUR, TRAVEL & TRANSPORT,
    BOOKING & ADMIN, DISCOUNT. For the plain list (in the order lines were
    added): change true to false below, run node tools/bump-assets.js, push. */
const ITEMISE_BY_SECTION = true;

const money = (c) => '$' + (Math.round(c || 0) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function token() {
  return new URLSearchParams(location.search).get('t') || '';
}

let callable = null;   // { get, accept } once Firebase is up

async function initFns() {
  if (!isFirebaseConfigured) return;
  const [{ initializeApp }, functions] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-functions.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const fns = functions.getFunctions(app, functionsRegion);
  callable = {
    get: functions.httpsCallable(fns, 'getQuote'),
    accept: functions.httpsCallable(fns, 'acceptQuote'),
    checkout: functions.httpsCallable(fns, 'quoteCheckout'),
    details: functions.httpsCallable(fns, 'submitQuoteDetails'),
  };
}

function lineAmount(l, days) {
  if (l.type === 'discount') return -Math.max(0, Math.round(l.amountCents || 0));
  const qty = Math.max(0, (l.perf ? Math.round(Number(l.qty || 0) * 4) / 4 : Math.round(Number(l.qty) || 0)));   // DJ hours can be 4.5
  const unit = Math.max(0, Math.round(l.unitCents || 0));
  const d = Math.max(1, Math.round(l.days || days));
  return Math.round(qty * unit * d);   // quantity x day rate x number of days
}

/*  "2026-10-20" -> "Tue 20 Oct 2026"; one day shows once, a range "a – b". */
function niceDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(/,/g, '');
}
function hireRange(h) {
  if (!h || !(h.startDate || h.endDate)) return '';
  const a = niceDay(h.startDate || h.endDate), b = niceDay(h.endDate || h.startDate);
  return a === b ? a : a + ' \u2013 ' + b;
}

function fmtDate(secs) {
  if (!secs) return '';
  return new Date(secs * 1000).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}


/*  COST BREAKDOWN GROUPS - KEEP IN STEP between
    js/quote-view.js and js/admin-app.js. Inventory category -> group shown
    in the totals ("Audio $180, Staging $180, Lighting $60").            */
const COST_GROUP = {
  audio: 'Audio', mixer: 'Audio', amp: 'Audio', microphone: 'Audio', iem: 'Audio', di: 'Audio',
  'studio monitor': 'Audio', cable: 'Audio', stands: 'Audio',
  speaker: 'Audio', speakers: 'Audio', 'mic kit': 'Backline', drum: 'Backline', drums: 'Backline',   // Inventory category names
  lighting: 'Lighting', truss: 'Lighting',
  stage: 'Staging', furniture: 'Staging',
  backline: 'Backline', 'dj mixer': 'DJ equipment', vision: 'Vision', power: 'Audio',   // power & cables count as Audio
};
const COST_GROUP_ORDER = ['Audio', 'Backline', 'Lighting', 'Staging', 'DJ equipment', 'Vision', 'Other'];   // display order
function costGroupOf(category) {
  // gear in a category we don't know yet counts as Audio, not "Other"
  return COST_GROUP[String(category || '').trim().toLowerCase()] || 'Audio';
}
/*  [{ name, cents }] in the order above, only groups with a cost. */
function costBreakdown(lines, centsOf, categoryOf) {
  const sums = {};
  (lines || []).forEach((l) => {
    if (l.type === 'labour' || l.type === 'delivery' || l.type === 'discount' || l.type === 'fee') return;
    if (l.resType) return;   // crew & vehicles: their own subtotal
    if (l.pubDj || l.djSlot || l.superLine || l.perf) return;   // DJ jobs: the entertainment fee, on its own
    const c = centsOf(l);
    if (!c) return;
    const g = l.itemId ? costGroupOf(categoryOf(l)) : 'Other';
    sums[g] = (sums[g] || 0) + c;
  });
  return COST_GROUP_ORDER.filter((g) => sums[g]).map((g) => ({ name: g, cents: sums[g] }));
}

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
function crewDesc(l) {
  const d = String(l.description || '');
  if (l.type === 'labour') {
    const what = /^pack-?down/i.test(String(l.name || '')) ? 'System Pack Down' : 'System Setup';
    // older lines missed the $ ("@ 85/hr")
    return what + ' · ' + d.replace(/^([\d.]+) hrs?\b/, '$1 crew hours').replace(/@ (\d+(?:\.\d+)?)\/hr/, '@ $$$1/hr');
  }
  if (l.resType === 'staff') {
    const n = String(l.name || '');
    const what = /light/i.test(n) ? 'Runs lighting during your event'
      : (/audio|sound|\bav\b|visual/i.test(n) ? 'Runs sound & AV during your event' : 'On site to run your event');
    return what + (d ? ' · ' + d : '');
  }
  return d;
}

/*  A DJ bio, paragraph by paragraph. Pasted markdown is tidied: **bold**,
    *italic*, # headings lose their #, and one that just repeats the name goes. */
function bioHtml(bio, name) {
  const me = String(name || '').trim().toLowerCase();
  const text = String(bio).replace(/\r/g, '').split('\n')
    .filter((x) => !(/^\s*#/.test(x) && x.replace(/^\s*#+\s*/, '').trim().toLowerCase() === me))
    .map((x) => x.replace(/^\s*#+\s*/, '')).join('\n');
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
  return text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)
    .map((x) => '<p>' + inline(x).replace(/\n/g, '<br>') + '</p>').join('');
}

function labourRow(l, amt) {
  return '<tr class="qv-lab"><td class="qv-desc">' + esc(crewName(l))
    + (crewDesc(l) ? '<span class="qv-sub">' + esc(crewDesc(l)) + '</span>' : '')
    + '</td><td class="qv-num">' + esc(l.qty) + '</td><td class="qv-num">' + money(l.unitCents)
    + '</td><td class="qv-num">1</td><td class="qv-num">' + money(amt) + '</td></tr>';
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
    const off = i === last ? left : Math.round(disc * c / base);
    left -= off;
    return off;
  });
}
const wasMoney = (c) => '<s class="qp-was">' + money(c) + '</s> ';

/*  Equipment hire by group + hire subtotal, labour, delivery. */
function sumBreakdown(q, days) {
  const lines = q.lines || [];
  const groups = costBreakdown(lines, (l) => lineAmount(l, days), (l) => l.category);
  const hire = groups.reduce((t, g) => t + g.cents, 0);
  const lab = lines.filter((l) => l.type === 'labour');
  const labCents = lab.reduce((t, l) => t + lineAmount(l, days), 0);
  const del = lines.filter((l) => l.type === 'delivery');
  const delCents = del.reduce((t, l) => t + lineAmount(l, days), 0);
  let h = '';
  const entCents = lines.filter((l) => l.pubDj || l.djSlot || l.superLine || l.perf).reduce((t, l) => t + lineAmount(l, days), 0);
  if (entCents) h += '<div class="qv-sumrow qv-sumpart"><span>Entertainment fee</span><span>' + money(entCents) + '</span></div>';
  if (groups.length) {
    h += '<div class="qv-sumhead">Equipment hire</div>';
    const offs = spreadSaving(groups.map((g) => g.cents), Math.round(q.discountCents || 0));
    h += groups.map((g, i) => '<div class="qv-sumrow qv-sumsub"><span>' + esc(g.name) + '</span><span>' + (offs && offs[i] ? wasMoney(g.cents) + money(g.cents - offs[i]) : money(g.cents)) + '</span></div>').join('');
    h += '<div class="qv-sumrow qv-sumpart"><span>Hire subtotal</span><span>' + (offs ? wasMoney(hire) + money(hire - q.discountCents) : money(hire)) + '</span></div>';
  }
  // ONE labour total for the customer: setup, pack-down and operators together
  const crewC = lines.filter((l) => l.resType === 'staff').reduce((t, l) => t + lineAmount(l, days), 0);
  const vehC = lines.filter((l) => l.resType === 'vehicle' || l.resType === 'trailer').reduce((t, l) => t + lineAmount(l, days), 0);
  if (lab.length || crewC) {
    h += '<div class="qv-sumrow qv-sumpart"><span>Labour</span><span>' + money(labCents + crewC) + '</span></div>';
  }
  if (vehC) h += '<div class="qv-sumrow qv-sumpart"><span>Vehicles</span><span>' + money(vehC) + '</span></div>';
  if (del.length) {
    h += '<div class="qv-sumrow qv-sumpart"><span>' + (delCents ? 'Travel &amp; transport' : 'Local delivery &amp; pickup') + '</span><span>' + (delCents ? money(delCents) : 'Free') + '</span></div>';
  }
  lines.filter((l) => l.type === 'fee').forEach((l) => {
    h += '<div class="qv-sumrow qv-sumpart"><span>' + esc('Booking & admin') + '</span><span>' + money(lineAmount(l, days)) + '</span></div>';
  });
  return h;
}

function render(q) {
  const isInvoice = q.kind === 'invoice';
  const docTitle = isInvoice ? 'Tax Invoice' : (q.status === 'draft' ? 'Estimate' : 'Quote');
  const ref = isInvoice ? (q.invoiceNumber || q.number) : q.number;
  const c = q.customer || {};
  const days = Math.max(1, Math.round((q.hire && q.hire.days) || 1));
  const multiDay = days > 1;

  /*  Included / required items sit inside their item, under small category
      headings (Cable, Stands...), A-Z - the same as the quote builder. */
  const catOf = (l) => { const c = String(l.category || '').trim(); return c ? c.charAt(0).toUpperCase() + c.slice(1) : 'Other'; };
  const L = (q.lines || []).slice();
  for (let i = 0; i < L.length; i++) {
    if (L[i].type !== 'kit') continue;
    let end = i;
    while (end < L.length && L[end].type === 'kit') end++;
    const g = L.slice(i, end).sort((a, b) => ((a.sysOrder != null ? a.sysOrder : 1e9) - (b.sysOrder != null ? b.sysOrder : 1e9)) || catOf(a).localeCompare(catOf(b)) || String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true }));
    L.splice(i, end - i, ...g);
    i = end - 1;
  }

  /*  SECTIONS. A unit is a top line plus the included parts under it; each
      unit goes into one section, in this order.                          */
  // the DJ (gig invoices) goes first, in its own section
  const isEnt = (l) => !!(l.pubDj || l.djSlot || l.superLine || l.perf);
  const djJob = L.some(isEnt);
  // DJ jobs: the discount comes off production, so it sits straight after the gear
  const SECTION_ORDER = ['Entertainment'].concat(COST_GROUP_ORDER, djJob ? ['Labour', 'Travel & transport', 'Discount', 'Booking & admin'] : ['Labour', 'Travel & transport', 'Booking & admin', 'Discount']);
  const sectionOf = (l) => {
    if (isEnt(l)) return 'Entertainment';
    if (l.type === 'labour' || l.resType === 'staff') return 'Labour';
    if (l.type === 'delivery' || l.resType === 'vehicle' || l.resType === 'trailer') return 'Travel & transport';
    if (l.type === 'fee') return 'Booking & admin';
    if (l.type === 'discount') return 'Discount';
    return l.itemId ? costGroupOf(l.category) : 'Other';
  };
  const units = [];
  L.forEach((l) => { if (l.type === 'kit' && units.length) units[units.length - 1].push(l); else units.push([l]); });
  const bySec = {};
  units.forEach((u) => { const k = ITEMISE_BY_SECTION ? sectionOf(u[0]) : 'all'; (bySec[k] = bySec[k] || []).push(u); });
  // labour: setup & pack-down first, then operators
  if (ITEMISE_BY_SECTION && bySec.Labour) bySec.Labour.sort((a, b) => (a[0].type === 'labour' ? 0 : 1) - (b[0].type === 'labour' ? 0 : 1));
  L.length = 0;
  const secStart = {};
  (ITEMISE_BY_SECTION ? SECTION_ORDER : ['all']).forEach((k) => {
    if (!bySec[k]) return;
    secStart[L.length] = k;
    bySec[k].forEach((u) => L.push(...u));
  });

  // total labour hours, read from each line ("2.5 hrs @ $80/hr ...")
  const labHrs = L.filter((l) => l.type === 'labour')
    .reduce((t, l) => t + (parseFloat((/^([\d.]+) hrs?\b/.exec(l.description || '') || [])[1]) || 0), 0);

  /*  DJ jobs: entertainment on top (Hours / Fee), then a "Production"
      column heading over the gear (Qty / Rate).                        */
  const firstProd = djJob ? Object.keys(secStart).map(Number).sort((a, b) => a - b).find((i) => secStart[i] !== 'Entertainment') : undefined;
  const prodHead = '<tr class="qv-colhead"><th>Production</th><th class="qv-num">Qty</th><th class="qv-num">Rate (ex GST)</th><th class="qv-num">Days</th><th class="qv-num">Total (ex GST)</th></tr>';
  // the production subtotal, the discount off it, then what production comes to
  const prodSub = djJob ? L.filter((l) => !isEnt(l) && l.type !== 'discount' && l.type !== 'fee').reduce((n, l) => n + lineAmount(l, days), 0) : 0;
  const prodOff = djJob ? L.filter((l) => l.type === 'discount').reduce((n, l) => n - lineAmount(l, days), 0) : 0;
  // the saving as a % of the equipment only (labour, crew, vehicles and travel
  // are never discounted) - same as the printed summary
  const gearSub = djJob ? L.filter((l) => !isEnt(l) && !['discount', 'fee', 'labour', 'delivery'].includes(l.type) && !['staff', 'vehicle', 'trailer'].includes(l.resType)).reduce((n, l) => n + lineAmount(l, days), 0) : 0;
  const prodPct = djJob && gearSub && prodOff ? Math.round(prodOff / gearSub * 100) : 0;
  const sumRow = (label, cents, cls) => '<tr class="qv-prodsum ' + cls + '"><td colspan="4">' + label + '</td><td class="qv-num">' + money(cents) + '</td></tr>';
  const hoursOf = (l) => (djJob && isEnt(l) && !l.perf ? '' : esc(l.qty));
  const rows = L.map((l, i) => secHead(i) + rowFor(l, i)).join('');
  function secHead(i) {
    const top = i === firstProd ? prodHead : '';
    if (djJob && secStart[i] === 'Discount') return top + sumRow('Production subtotal', prodSub, 'is-sub');
    return top + (ITEMISE_BY_SECTION && secStart[i] ? '<tr class="qv-sechead"><td colspan="5">' + esc(secStart[i]) + '</td></tr>' : '');
  }
  function rowFor(l, i) {
    const amt = lineAmount(l, days);
    if (l.type === 'delivery' && !l.unitCents) {
      return '<tr class="qv-lab"><td class="qv-desc">' + esc(l.name || '')
        + (l.description ? '<span class="qv-sub">' + esc(l.description) + '</span>' : '')
        + '</td><td class="qv-num"></td><td class="qv-num"></td><td class="qv-num"></td><td class="qv-num"><strong>Free</strong></td></tr>';
    }
    if (l.type === 'labour') {
      // a heading over setup + pack-down with the total hours
      const first = i === 0 || L[i - 1].type !== 'labour';
      const head = first && labHrs
        ? '<tr class="qv-labhead"><td colspan="5">Bump-in &amp; bump-out crew &middot; ' + labHrs + ' crew hour' + (labHrs === 1 ? '' : 's') + ' total</td></tr>'
        : '';
      return head + labourRow(l, amt);
    }
    if (l.type === 'kit') {
      const prev = L[i - 1];
      const head = prev && prev.type === 'kit' && catOf(prev) === catOf(l) ? ''
        : `<tr class="qv-kithead"><td colspan="5">${esc(catOf(l))}</td></tr>`;
      const charged = !(l.charge === 'free' || !l.unitCents);
      const next = L[i + 1];
      const last = !next || next.type !== 'kit';
      return `${head}
      <tr class="qv-kit${last ? ' qv-kit-last' : ''}">
        <td class="qv-desc"><span class="qv-arrow">&#9492;</span>${esc(String(l.name || '').replace(/ \(included\)$/i, ''))}</td>
        <td class="qv-num">${esc(l.qty)}</td>
        <td class="qv-num">${charged ? money(l.unitCents) : '<span class="qv-incl">Included</span>'}</td>
        <td class="qv-num">${charged ? esc(Math.max(1, Math.round(l.days || days))) : ''}</td>
        <td class="qv-num">${charged ? money(amt) : ''}</td>
      </tr>`;
    }
    if (l.resType === 'staff') {
      const first = i === 0 || L[i - 1].resType !== 'staff';
      const head = first ? '<tr class="qv-labhead"><td colspan="5">Show crew (technical operators)</td></tr>' : '';
      const lineDays = Math.max(1, Math.round(l.days || days));
      return head + '<tr class="qv-lab"><td class="qv-desc">' + esc(crewName(l))
        + '<span class="qv-sub">' + esc(crewDesc(l)) + '</span></td><td class="qv-num">' + esc(l.qty)
        + '</td><td class="qv-num">' + money(l.unitCents) + '</td><td class="qv-num">' + esc(lineDays)
        + '</td><td class="qv-num">' + money(amt) + '</td></tr>';
    }
    if (l.accom) {
      return '<tr class="qv-lab"><td class="qv-desc">' + esc(l.name || 'Accommodation')
        + (l.description ? '<span class="qv-sub">' + esc(l.description) + '</span>' : '')
        + '</td><td class="qv-num"></td><td class="qv-num"></td><td class="qv-num"></td><td class="qv-num"><span class="qv-incl">Provided</span></td></tr>';
    }
    if (l.superLine) {
      /*  PERFORMER SUPER: a "Required by law" tag and the
          plain-English reason, so it reads as what it is - not a markup. */
      return '<tr class="qv-super"><td class="qv-desc">' + esc(l.name || '') + ' <span class="qv-law">Required by law</span>'
        + (l.description ? '<span class="qv-sub">' + esc(l.description) + '</span>' : '')
        + '</td><td class="qv-num">' + hoursOf(l) + '</td><td class="qv-num">' + money(l.unitCents)
        + '</td><td class="qv-num">1</td><td class="qv-num">' + money(amt) + '</td></tr>';
    }
    const isDisc = l.type === 'discount';
    const lineDays = Math.max(1, Math.round(l.days || days));
    const free = l.type === 'kit' && (l.charge === 'free' || !l.unitCents);
    const after = djJob && isDisc && !(L[i + 1] && L[i + 1].type === 'discount') ? sumRow('Production total', Math.max(0, prodSub - prodOff), 'is-total') : '';
    return after ? rowHtml() + after : rowHtml();
    function rowHtml() { return `
      <tr${isDisc ? ' class="qv-row-disc"' : ''}>
        <td class="qv-desc">${esc(l.type === 'fee' ? 'Booking & admin' : (l.name || (isDisc ? (djJob ? 'Production package price adjustment' : 'Discount') : '')))}${l.description ? `<span class="qv-sub">${esc(l.description)}</span>` : ''}${isDisc && prodPct ? `<span class="qv-sub qv-save">You save ${prodPct}% on equipment hire</span>` : ''}</td>
        <td class="qv-num">${isDisc ? '' : hoursOf(l)}</td>
        <td class="qv-num">${isDisc ? '' : (free ? '<span class="qv-incl">Included</span>' : money(l.unitCents))}</td>
        <td class="qv-num">${isDisc || free ? '' : esc(lineDays)}</td>
        <td class="qv-num">${free ? '' : isDisc ? '&minus;' + money(-amt) : money(amt)}</td>
      </tr>`; }
  }

  const accepted = q.status === 'accepted' || q.status === 'invoiced' || q.status === 'paid';
  const canAccept = !isInvoice && (q.status === 'approved' || q.status === 'sent');

  const banner = q.status === 'paid'
    ? '<div class="qv-banner qv-ok">Paid &mdash; thank you!</div>'
    : (accepted && !isInvoice
      ? `<div class="qv-banner qv-ok">Accepted${q.acceptedName ? ' by ' + esc(q.acceptedName) : ''}${q.acceptedAt ? ' on ' + esc(fmtDate(q.acceptedAt)) : ''}</div>`
      : '');

  const accountBox = isInvoice ? `
    <div class="qv-pay">
      <h3>Payment &mdash; bank transfer</h3>
      <p><strong>${esc(SELLER.bankName)}</strong><br>
        BSB <strong>${esc(SELLER.bankBsb)}</strong> &nbsp; Account <strong>${esc(SELLER.bankAcc)}</strong><br>
        Reference: <strong>${esc(ref)}</strong></p>
    </div>` : '';

  const proposal = !isInvoice;
  document.getElementById('quote-root').innerHTML = (proposal ? proposalTop(q, days) : '') + `
    ${proposal ? '<h2 class="qp-h2 qp-h2-doc" id="qp-itemised">Itemised quote</h2>' : ''}
    <div class="qv-doc" id="qv-doc">
      ${banner}
      <div class="qv-top">
        <div class="qv-brand">
          <img src="/images/logo-quote.png" alt="SoundzGood Whitsundays" class="qv-logo">
          <p class="qv-legal">${esc(SELLER.legal)}<br>ABN ${esc(SELLER.abn)}</p>
        </div>
        <div class="qv-meta">
          <h1>${esc(docTitle)}</h1>
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
          <p>${c.eventName ? '<strong>' + esc(c.eventName) + '</strong><br>' : ''}${c.eventDate ? esc(c.eventDate) + '<br>' : ''}${hireRange(q.hire) && hireRange(q.hire) !== String(c.eventDate || '').trim() ? esc(hireRange(q.hire)) + '<br>' : ''}${days > 1 ? days + ' days charged' : ''}</p>
        </div>
      </div>

      <table class="qv-table">
        <thead>${djJob
          ? '<tr><th>Item / Description</th><th class="qv-num">Hours</th><th class="qv-num">Fee (ex GST)</th><th class="qv-num">Days</th><th class="qv-num">Total (ex GST)</th></tr>'
          : '<tr><th>Description</th><th class="qv-num">Qty</th><th class="qv-num">Day rate</th><th class="qv-num">Days</th><th class="qv-num">Amount</th></tr>'}</thead>
        <tbody>${rows || '<tr><td colspan="5" class="qv-sub">No items.</td></tr>'}</tbody>
      </table>

      <div class="qv-sumwrap">
      <div class="qv-breakdown">${sumBreakdown(q, days)}</div>
      <div class="qv-summary">
        <!-- adds straight down: discount first, then the subtotal after it (Max, 17 Oct 2026) -->
        ${!q.discountCents ? '' : spreadSaving(costBreakdown(q.lines || [], (l) => lineAmount(l, days), (l) => l.category).map((g) => g.cents), q.discountCents)
          ? `<div class="qv-sumrow qv-save-row"><span>You save ${money(Math.round(q.discountCents * 1.1))} inc GST${prodPct ? ' &middot; ' + prodPct + '% off equipment hire' : ''}</span></div>`
          : `<div class="qv-sumrow qv-sumpart"><span>${prodPct ? 'Equipment discount (' + prodPct + '% off)' : 'Discount'}</span><span>&minus;${money(q.discountCents)}</span></div>`}
        <div class="qv-sumrow qv-sumtotal"><span>Subtotal (ex GST)</span><span>${money(Math.round(q.totalCents || 0) - Math.round(q.gstCents || 0))}</span></div>
        <div class="qv-sumrow"><span>GST (10%)</span><span>${money(q.gstCents)}</span></div>
        <div class="qv-sumrow qv-grand"><span>Total (incl GST)</span><span>${money(q.totalCents)}</span></div>
        ${(q.lateFees || []).map((x) => '<div class="qv-sumrow qv-late"><span>Late payment charge (2%)' + (x.date ? ' &middot; ' + esc(x.date.split('-').reverse().join('/')) : '') + '</span><span>' + money(x.cents) + '</span></div>').join('')}
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
    </div>` + (proposal ? proposalBottom(q) : proposalBottom(q, { terms: false }));
  wireProposal(q);

  const print = document.getElementById('qv-print');
  if (print) print.addEventListener('click', () => window.print());
  // "Download PDF" from the Sales Pipeline opens this page with &print=1
  if (/[?&]print=1/.test(location.search)) setTimeout(() => window.print(), 600);

}

async function acceptFlow(btn) {
  const msg = document.getElementById('qv-msg');
  const name = window.prompt('Please type your name to accept this quote:', '');
  if (name === null) return;
  btn.disabled = true;
  if (msg) { msg.hidden = false; msg.textContent = 'Accepting…'; msg.className = 'qv-msg'; }
  try {
    await callable.accept({ token: token(), name: String(name || '').trim() });
    // reload the quote to show the accepted state
    const res = await callable.get({ token: token() });
    render(res.data);
  } catch (err) {
    btn.disabled = false;
    if (msg) { msg.hidden = false; msg.textContent = (err && err.message) || 'Could not accept. Please try again.'; msg.className = 'qv-msg qv-bad'; }
  }
}

/* =========================================================================
   THE PROPOSAL
   One scrolling page for a QUOTE: photo + event, a short intro, what's
   included, the investment summary, the itemised quote (the paper above),
   booking terms, then "Secure your booking" - pay the 50% deposit or in
   full by card (Stripe), or accept and pay by bank transfer.
   ========================================================================= */
const HERO_PHOTO = {
  community: 'community-events.webp', corporate: 'corporate-functions.webp', festival: 'festivals.webp',
  wedding: 'weddings.webp', private: 'private-functions.webp', sporting: 'sporting-events.webp',
  touring: 'touring-bands.webp', dj: 'dj-entertainment.webp',
};
function guessType(name) {
  const n = String(name || '').toLowerCase();
  if (/dj|entertainment/.test(n)) return 'dj';
  if (/wedding|bride|ceremony|reception/.test(n)) return 'wedding';
  if (/corporate|conference|awards|gala|dinner|launch|expo|ball/.test(n)) return 'corporate';
  if (/festival|concert|music|fest\b/.test(n)) return 'festival';
  if (/race|rodeo|cup|footy|football|rugby|cricket|fishing|sport|triathlon|carnival/.test(n)) return 'sporting';
  if (/birthday|party|engagement|anniversary|wake/.test(n)) return 'private';
  if (/tour|band|gig/.test(n)) return 'touring';
  return 'community';
}

const ICON = {
  Audio: '<path d="M4 9v6h4l5 4V5L8 9H4zM16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12"/>',
  Lighting: '<path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9V16h7v-2.1A6 6 0 0012 3z"/>',
  Staging: '<path d="M3 15h18v3H3zM5 18v3M19 18v3M7 15V9h10v6"/>',
  Crew: '<path d="M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 11a2.5 2.5 0 100-5M21 20c0-2.8-1.6-5-4-5.6"/>',
  Other: '<path d="M4 7h16v12H4zM9 7V5h6v2"/>',
  Date: '<path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4"/>',
  Pin: '<path d="M12 21s-7-6.5-7-12a7 7 0 0114 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
};
const BLURB = {
  Audio: 'Clear sound for every crowd', Lighting: 'Atmosphere and impact', Staging: 'Safe and reliable stage setup',
  Crew: 'Experienced team from start to finish', Backline: 'Instruments and amps', 'DJ equipment': 'Club-standard DJ gear',
  Vision: 'Screens and projection', Power: 'Safe power distribution', Other: 'Everything else you need',
};
const svgIcon = (k) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICON[k] || ICON.Other) + '</svg>';

function isoNice(iso, opts) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-AU', opts || { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).replace(/,/g, '');
}

function proposalTop(q, days) {
  const c = q.customer || {};
  const type = HERO_PHOTO[c.eventType] ? c.eventType : guessType(c.eventName);
  // the event's own poster, if one was added, takes the place of the stock photo
  const poster = c.eventType === 'custom' && /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[\w.-]+\/o\/quote-images%2F[\w.%-]+\?[\w=&.-]+$/.test(String(q.posterUrl || '')) ? q.posterUrl : '';
  const lines = q.lines || [];
  const groups = costBreakdown(lines, (l) => lineAmount(l, days), (l) => l.category);
  const lab = lines.filter((l) => l.type === 'labour');
  const labCents = lab.reduce((t, l) => t + lineAmount(l, days), 0);
  const del = lines.filter((l) => l.type === 'delivery');
  const delCents = del.reduce((t, l) => t + lineAmount(l, days), 0);
  const when = isoNice(q.hire && q.hire.startDate) || c.eventDate || '';
  const town = String((q.delivery && q.delivery.town) || '').replace(/\s*\(local\)/i, '');
  const event = c.eventName || 'your event';

  const crewC = lines.filter((l) => l.resType === 'staff').reduce((t, l) => t + lineAmount(l, days), 0);
  const vehC = lines.filter((l) => l.resType === 'vehicle' || l.resType === 'trailer').reduce((t, l) => t + lineAmount(l, days), 0);
  /*  DJ / ENTERTAINMENT quotes: the night, the DJ who
      played and their set up top - the itemised quote stays below.        */
  const isDj = type === 'dj' || !!q.gigDj;
  const dj = q.gigDj || null;
  const venueName = String(c.eventVenue || '').split(',')[0];
  /*  DJ ONLY: no gear or crew on the quote = no sound,
      lighting or setup tiles, and the words don't promise them either.  */
  const djGear = lines.some((l) => !l.pubDj && (l.itemId || l.type === 'kit'));
  const djCrew = lab.length > 0 || crewC > 0;
  const djOnly = isDj && !djGear && !djCrew;
  const tiles = djOnly ? ''
    : isDj
    ? [['DJ equipment', 'Your DJ', dj ? dj.name + ' on the decks' : 'Live DJ for the night']]
      .concat(djGear ? [['Audio', 'Sound', 'Clear sound right across the venue'], ['Lighting', 'Lighting', 'Party lighting & effects']] : [])
      .concat(djGear || djCrew ? [['Crew', 'Setup & pack-down', 'We set up, run and pack down']] : [])
      .map(([ic, k, t]) => '<div class="qp-tile">' + svgIcon(ic) + '<b>' + esc(k) + '</b><span>' + esc(t) + '</span></div>').join('')
    : groups.map((g) => g.name).concat(lab.length || crewC ? ['Crew'] : [])
      .map((k) => '<div class="qp-tile">' + svgIcon(k) + '<b>' + esc(k) + '</b><span>' + esc(BLURB[k] || '') + '</span></div>').join('');
  const ampm = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); if (!m) return ''; const h = +m[1]; return (h % 12 || 12) + ':' + m[2] + (h < 12 ? 'am' : 'pm'); };
  /*  THE DJ, under the first paragraph: a big photo with
      their name, music styles and the song-requests promise beside it.   */
  const djFeature = dj ? '<div class="qp-djf">'
    + (dj.photo ? '<img class="qp-djf-img" src="/' + esc(dj.photo) + '" alt="' + esc(dj.name) + '" onerror="this.remove()">' : '')
    + '<div class="qp-djf-text"><p class="qp-mini">Your DJ</p><h3>' + esc(dj.name) + '</h3>'
    + '<p class="qp-djf-set">' + esc(ampm(dj.start)) + ' &ndash; ' + esc(ampm(dj.finish)) + (dj.hours ? ' &middot; ' + esc(dj.hours) + ' hours' : '') + '</p>'
    // their bio, paragraph by paragraph
    + (dj.bio ? '<div class="qp-djf-bio">' + bioHtml(dj.bio, dj.name) + '</div>' : '')
    + ((dj.styles || []).length ? '<p class="qp-styles">' + dj.styles.map((x) => '<span>' + esc(x) + '</span>').join('') + '</p>' : '')
    + '<p class="qp-requests">&#127925; Our DJs take song requests from your patrons and work with your staff on any requests through the night.</p>'
    + '</div></div>' : '';

  // investment summary: each group ex GST / GST / inc GST
  const entC = lines.filter((l) => l.pubDj || l.djSlot || l.superLine || l.perf).reduce((t, l) => t + lineAmount(l, days), 0);
  const rows = (entC ? [['Entertainment fee', entC]] : []).concat(groups.map((g) => [g.name, g.cents]))   // AUDIO, LIGHTING, STAGING... (shown in capitals)
    .concat(lab.length || crewC ? [['Labour', labCents + crewC]] : [])   // setup, pack-down & operators as one
    .concat(vehC ? [['Vehicles', vehC]] : [])
    .concat(del.length ? [[delCents ? 'Travel & transport' : 'Local delivery & pickup', delCents]] : [])
    .concat(lines.filter((l) => l.type === 'fee').map((l) => ['Booking & admin', lineAmount(l, days)]));
  const was = (c) => (c ? wasMoney(c) : '');
  const r = (label, ex, full) => '<tr><td>' + esc(label) + '</td><td>' + was(full) + (ex ? money(ex) : 'Free') + '</td><td>' + (ex ? money(Math.round(ex * 0.1)) : '') + '</td><td>' + (full ? was(Math.round(full * 1.1)) : '') + (ex ? money(Math.round(ex * 1.1)) : 'Free') + '</td></tr>';
  // QUOTE DETAILS + WHAT'S INCLUDED under the table.
  // Valid for 30 days from the quote date; the list is built from what's on the quote.
  const VALID_DAYS = 30;
  const validUntil = q.createdAt ? fmtDate(q.createdAt + VALID_DAYS * 86400) : '';
  // total crew hours, read off each labour line ("2.5 hrs @ $80/hr ...")
  const labHrs = lab.reduce((t, l) => t + (parseFloat((/^([\d.]+) hrs?\b/.exec(l.description || '') || [])[1]) || 0), 0);
  const incl = groups.filter((g) => g.name !== 'Other').map((g) => g.name.toLowerCase());
  const included = isDj ? [
    'Professional DJ' + (dj ? ' &mdash; ' + esc(dj.name) + (dj.hours ? ' (' + esc(dj.hours) + ' hrs)' : '') : ''),
  ].concat(djGear ? ['PA system &amp; lighting, set up for the venue', 'DJ equipment &amp; booth'] : [])
    .concat(djGear || djCrew ? ['Setup, sound check &amp; pack-down crew'] : [])
    .concat(djGear ? ['Backup gear on site'] : [])
    .concat(['Song requests from your patrons, and working with your staff on the night', 'GST included in the total'])
  : []
    .concat(dj ? ['Your DJ: ' + esc(dj.name) + (dj.hours ? ' (' + esc(dj.hours) + ' hrs)' : '')] : [])
    .concat(incl.length ? [(incl.length > 1 ? incl.slice(0, -1).join(', ') + ' & ' + incl[incl.length - 1] : incl[0]).replace(/^./, (x) => x.toUpperCase()) + ' equipment as itemised'] : [])
    .concat(['All cables, stands & accessories needed to run it'])
    .concat(del.length ? [delCents ? 'Travel &amp; transport' + (town ? ' &mdash; ' + esc(town) : '') : 'Local delivery &amp; pickup'] : [])
    .concat(lab.length ? ['Bump-in &amp; bump-out crew' + (labHrs ? ' (' + labHrs + ' crew hours)' : '')] : [])
    .concat(['GST included in the total']);
  const pct = q.depositPct || 50;
  const details = '<div class="qp-inv-extra">'
    + '<div class="qp-incl' + (isDj ? ' is-premium' : '') + '"><p class="qp-mini">What&rsquo;s included</p><ul>' + included.map((t) => '<li>' + t + '</li>').join('') + '</ul></div>'
    + '<div class="qp-qd"><p class="qp-mini">Quote details</p><dl>'
    + '<div><dt>Quote</dt><dd>' + esc(q.number || '') + '</dd></div>'
    + (q.createdAt ? '<div><dt>Issued</dt><dd>' + esc(fmtDate(q.createdAt)) + '</dd></div>' : '')
    + (validUntil ? '<div><dt>Valid until</dt><dd>' + esc(validUntil) + '</dd></div>' : '')
    + (fullOnly(q)
      ? '<div><dt>To secure</dt><dd>Payment in full &middot; ' + money(q.totalCents || 0) + '</dd></div>'
      : '<div><dt>To secure</dt><dd>' + pct + '% deposit &middot; ' + money(Math.round((q.totalCents || 0) * pct / 100)) + '</dd></div>')
    + '</dl></div></div>';
  // DISCOUNT: crossed out per equipment row (spreadSaving). Entertainment,
  // labour, vehicles, travel and the booking fee are never discounted.
  const NO_DISC = ['Entertainment fee', 'Labour', 'Vehicles', 'Travel & transport', 'Local delivery & pickup', 'Booking & admin'];
  const discOffs = spreadSaving(rows.map((x) => (NO_DISC.includes(x[0]) ? 0 : x[1])), Math.round(q.discountCents || 0));
  const discBase = rows.filter((x) => !NO_DISC.includes(x[0])).reduce((t, x) => t + Math.max(0, x[1]), 0);
  const discPct = q.discountCents && discBase ? Math.round(q.discountCents / discBase * 100) : 0;
  if (discOffs) rows.forEach((x, i) => { if (discOffs[i]) { x.push(x[1]); x[1] -= discOffs[i]; } });   // [label, after saving, full price]
  const disc = !q.discountCents ? '' : !discOffs
    ? '<tr class="qp-disc"><td>Discount</td><td>&minus;' + money(q.discountCents) + '</td><td></td><td>&minus;' + money(Math.round(q.discountCents * 1.1)) + '</td></tr>'
    : '<tr class="qp-disc"><td colspan="4">You save ' + money(Math.round(q.discountCents * 1.1)) + ' inc GST' + (discPct ? ' &middot; ' + discPct + '% off equipment hire' : '') + '</td></tr>';

  return `
    <section class="qp-hero">
      <div class="qp-hero-photo${isDj ? ' is-dj is-stage' : ''}${poster ? ' is-custom' : ''}" style="--qp-photo:url('${poster ? esc(poster) : '/images/services/' + (isDj && dj && dj.photo ? 'trailer-stage.webp' : HERO_PHOTO[type])}')">
        ${poster ? '<div class="qp-hero-blur"></div><img class="qp-hero-img" src="' + esc(poster) + '" alt="">' : ''}
        <div class="qp-hero-in">
          <p class="qp-eyebrow">${isDj ? esc(venueName || 'Entertainment booking') : 'Event production proposal'}</p>
          <h1>${isDj ? 'SoundzGood Entertainment' : esc(event)}</h1>
          ${isDj && dj ? '<p class="qp-dj-line">Live: <b>' + esc(dj.name) + '</b></p>' : ''}
          <p class="qp-when">${when ? svgIcon('Date') + esc(when) : ''}${town ? '<br>' + svgIcon('Pin') + esc(town) : ''}</p>
        </div>
      </div>
      <div class="qp-hero-body">
        ${isDj
          ? `<p class="qp-intro">Thanks for having SoundzGood Entertainment${venueName ? ' at ' + esc(venueName) : ''}. ${djOnly
            ? 'Here&rsquo;s your DJ for the night. The full itemised breakdown is below.'
            : 'Here&rsquo;s your entertainment for the night &mdash; the DJ' + (djGear ? ', the sound and lighting,' : '') + ' and the setup and pack-down, all looked after. The full itemised breakdown is below.'}</p>${djFeature}`
          : `<p class="qp-intro">Thanks for the opportunity to provide event production for ${esc(event)}.
          We&rsquo;ve put together the following production plan based on what we&rsquo;ve discussed.
          Everything below covers the equipment, preparation and crew required to deliver a successful event.</p>`}
        ${tiles ? '<div class="qp-tiles">' + tiles + '</div>' : ''}
        <p class="qp-ref">Quote ${esc(q.number || '')}${c.name ? ' &middot; Prepared for ' + esc(c.name) : ''}</p>
      </div>
    </section>

    <section class="qp-sec qp-invest">
      <p class="qp-eyebrow">Investment summary</p>
      <h2 class="qp-h2">${isDj ? 'Your entertainment investment' : 'Your production investment'}</h2>
      <p class="qp-sub">Total inclusive of GST for ${esc(isDj && venueName ? 'your night at ' + venueName : event)}${when ? ' on ' + esc(when) : ''}, itemised by category below.</p>
      <table class="qp-inv">
        <thead><tr><th>Description</th><th>Ex GST</th><th>GST (10%)</th><th>Inc GST</th></tr></thead>
        <tbody>${rows.map(([l, c2, full]) => r(l, c2, full)).join('')}${disc}</tbody>
        <tfoot><tr><td>Total inc. GST</td><td></td><td></td><td>${money(q.totalCents)}</td></tr></tfoot>
      </table>
      ${details}
      <a class="qp-jump" href="#qp-book">Accept &amp; secure your booking &darr;</a>
    </section>`;
}

// booking terms live in js/terms-data.js (also used by the /terms page)

/*  PAY IN FULL WITHIN 7 DAYS. The balance is due 7 days
    before the event, so once that day arrives there is no deposit option -
    only payment in full. The server (quoteCheckout) enforces the same rule. */
function balanceDueDate(q) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String((q.hire && q.hire.startDate) || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3] - 7) : null;
}
function fullOnly(q) {
  if (q.payFull === true) return true;   // "pay in full up front" - new venues
  const due = balanceDueDate(q);
  if (!due) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return due <= today;
}

function proposalBottom(q, opts = {}) {
  const isInv = q.kind === 'invoice';
  const total = Math.round(q.totalCents || 0);
  const lateCents = Math.round(q.lateFeeCents || 0);   // late payment charges, on top of the total
  const pct = q.depositPct || 50;
  const deposit = Math.round(total * pct / 100);
  const paid = Math.round(q.amountPaidCents || 0);
  const owing = Math.max(0, total + lateCents - paid);
  /*  LATE PAYMENT CHARGES shown plainly */
  const lateBox = (q.lateFees || []).length
    ? '<div class="pg-late"><b>Late payment charges added</b>'
      + q.lateFees.map((x) => '<div><span>2% late payment charge' + (x.date ? ' &middot; ' + esc(x.date.split('-').reverse().join('/')) : '') + '</span><span>' + money(x.cents) + '</span></div>').join('')
      + '<p>Your invoice was unpaid more than 28 days after its due date, so a 2% charge applies (see Terms &amp; Conditions &ldquo;Overdue payments&rdquo;). Another 2% is added for each further month unpaid. Amount now owing: <strong>' + money(owing) + '</strong>.</p></div>'
    : '';
  const balDue = (() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String((q.hire && q.hire.startDate) || ''));
    if (!m) return '7 days before your event';
    const d = new Date(+m[1], +m[2] - 1, +m[3] - 7);
    return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(/,/g, '');
  })();
  const ref = (isInv && q.invoiceNumber) || q.number || '';
  const bank = '<p class="qp-bank"><strong>Bank transfer</strong><br>' + esc(SELLER.bankName) + '<br>BSB <strong>' + esc(SELLER.bankBsb) + '</strong> &nbsp; Account <strong>' + esc(SELLER.bankAcc) + '</strong><br>Reference: <strong>' + esc(ref) + '</strong></p>';
  const justPaid = /[?&]paid=1/.test(location.search);

  // ONE dropdown with every clause inside - deliberately looks like serious small print
  // DJ / entertainment quotes get the DJ booking terms
  const djQuote = (q.customer && q.customer.eventType === 'dj') || !!q.gigDj;
  const T = djQuote ? DJ_TERMS : TERMS, TI = djQuote ? DJ_TERMS_INTRO : TERMS_INTRO;
  const terms = '<details class="qp-term qp-legal"><summary><span class="qp-legal-warn">&#9888;</span><span><b>' + (djQuote ? 'Entertainment Booking ' : '') + 'Terms &amp; Conditions &mdash; read before booking</b><em>' + T.length + ' clauses &middot; binding once you accept or pay &middot; tap to read</em></span></summary>'
    + '<div class="qp-legal-body">' + TI.map((t) => '<p>' + esc(t) + '</p>').join('')
    + T.map(([h, lines], i) => '<div class="qp-legal-clause"><h4>' + (i + 1) + '. ' + esc(h) + '</h4>' + termBodyHtml(lines, esc) + '</div>').join('')
    + '</div></details>';

  /*  1 Accept quote -> 2 Get your invoice -> 3 Pay */
  const steps = (at) => '<ol class="pg-steps">'
    + ['Accept quote', 'Get your invoice', 'Pay'].map((t, i) => '<li class="' + (i + 1 < at ? 'is-done' : (i + 1 === at ? 'is-on' : '')) + '"><span>' + (i + 1 < at ? '&#10003;' : i + 1) + '</span>' + t + '</li>').join('')
    + '</ol>';
  /*  once accepted: "Your invoice SG-I-0012" + Download invoice */
  const invHead = () => q.invoiceNumber
    ? '<div class="pg-invhead"><div><span>Your tax invoice</span><b>' + esc(q.invoiceNumber) + '</b></div><button type="button" class="qv-btn qv-btn-ghost pg-print" data-print>Download invoice</button></div>'
    : '';

  let book;
  if (q.status === 'draft') {
    // an ESTIMATE (not yet approved by SoundzGood): nothing to accept or pay yet
    book = '<div class="qp-done">This is an estimate. Once we&rsquo;ve checked the details we&rsquo;ll send your formal quote to accept.</div>';
  } else if (q.paymentStatus === 'paid') {
    book = steps(4) + invHead() + '<div class="qp-done">&#10003; Paid in full &mdash; thank you! Your booking is locked in.</div>';
  } else if (q.paymentStatus === 'deposit') {
    book = steps(3) + invHead() + lateBox + '<div class="qp-done">&#10003; Deposit of ' + money(paid) + ' received &mdash; your date is secured.</div>'
      + (fullOnly(q)
        ? '<p class="qp-full-note qp-overdue"><b>Payment overdue.</b> The balance of <strong>' + money(owing) + '</strong> was due 7 days before your event. Please pay it today.</p>'
        : '<p class="qp-sub">Balance of <strong>' + money(owing) + '</strong> due ' + esc(balDue) + '.</p>')
      + (q.cardOn ? '<button type="button" class="qv-btn qv-btn-primary qp-go" data-pay="balance">Pay the balance by card</button>' : '')
      + bank;
  } else if (q.paymentStatus === 'bank') {
    const accepted = '<div class="qp-done">&#10003; Quote accepted' + (q.acceptedName ? ' by ' + esc(q.acceptedName) : '') + '.</div>';
    book = steps(3) + invHead() + lateBox + (fullOnly(q)
      ? '<div class="qp-done">&#10003; Quote accepted' + (q.acceptedName ? ' by ' + esc(q.acceptedName) : '') + '.</div><p class="qp-full-note qp-overdue"><b>Payment due now.</b> Your event is less than 7 days away. Please transfer the full <strong>' + money(owing) + '</strong> today to keep your booking.</p>' + bank
        + (q.cardOn ? '<button type="button" class="qv-btn qv-btn-ghost qp-go" data-pay="full">Or pay in full by card</button>' : '')
      : q.bankPlan === 'full'
        // they chose bank transfer IN FULL
        ? accepted + '<p class="qp-full-note">You chose to pay in full. Please transfer <strong>' + money(owing) + '</strong> by ' + esc(balDue) + '. Your date is held once the payment lands.</p>' + bank
          + (q.cardOn ? '<button type="button" class="qv-btn qv-btn-ghost qp-go" data-pay="full">Or pay in full by card</button>' : '')
        : '<div class="qp-done">&#10003; Quote accepted' + (q.acceptedName ? ' by ' + esc(q.acceptedName) : '') + '.</div><p class="qp-full-note">Your date is not held until the deposit lands. Please transfer the ' + pct + '% deposit of <strong>' + money(deposit) + '</strong> today.</p>' + bank
        + (q.cardOn ? '<button type="button" class="qv-btn qv-btn-ghost qp-go" data-pay="deposit">Or pay the deposit by card</button>' : ''));
  } else if (justPaid) {
    book = '<div class="qp-done">&#10003; Payment received &mdash; thank you! Confirming your booking&hellip;</div>';
  } else if (isInv) {
    // an invoice made in admin (not accepted online): pay it in full
    book = steps(3) + invHead() + lateBox + '<div class="qp-done">Invoice ' + esc(ref) + ' &mdash; ' + money(owing) + ' to pay' + (balanceDueDate(q) ? (fullOnly(q) ? ', <strong>due now</strong>' : ', due ' + esc(balDue)) : '') + '.</div>'
      + (q.cardOn ? '<button type="button" class="qv-btn qv-btn-primary qp-go" data-pay="full">Pay by card</button>' : '')
      + bank;
  } else if (q.status === 'accepted') {
    book = '<div class="qp-done">&#10003; Quote accepted. We&rsquo;ll be in touch about payment.</div>';
  } else {
    /*  THE PAYMENT GATEWAY: bank transfer first,
        then card in full, then card deposit (greyed out within 7 days). An alert
        on top - "Payment due now" inside 7 days ("overdue" only once a balance is late), otherwise "deposit secures
        your date". Summary card on the right with what is due now.        */
    const full = fullOnly(q);
    const ic = (p) => '<span class="pg-ic" aria-hidden="true"><svg viewBox="0 0 24 24">' + p + '</svg></span>';
    const BANK = '<path d="M3 10h18M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18M12 3l9 5H3z"/>';
    const CARD = '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h4"/>';
    // the button says what happens: bank -> invoice, card -> pay the amount
    const cta = (v, amt) => v.indexOf('bank') === 0 ? 'Accept quote &amp; get invoice' : (v === 'deposit' ? 'Accept quote &amp; pay ' + amt + ' deposit' : 'Accept quote &amp; pay ' + amt);
    const opt = (v, title, sub, amt, on, extra, off) => '<label class="pg-opt' + (off ? ' is-off' : '') + '">'
      + '<input type="radio" name="qp-opt" value="' + v + '" data-cta="' + cta(v, amt) + '"' + (on ? ' checked' : '') + (off ? ' disabled' : '') + '>'
      + ic(v.indexOf('bank') === 0 ? BANK : CARD)
      + '<span class="pg-opt-body"><b>' + title + '</b><em>' + sub + '</em><strong>' + amt + '</strong>' + (extra || '') + '</span>'
      + (off ? '<span class="pg-badge">Not available</span>' : '') + '</label>';
    const refChip = '<span class="pg-ref"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/></svg>Use reference: <b>' + esc(ref) + '</b></span>';
    const alert = q.payFull === true
      ? '<div class="pg-alert pg-alert-amber"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><div><b>Payment in full to confirm</b><p>Your booking is confirmed once the full amount is received.</p><small>Pay by bank transfer or card below.</small></div></div>'
      : full
      ? '<div class="pg-alert pg-alert-red"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/></svg><div><b>Payment due now</b><p>Your event is less than 7 days away, so the full amount is due now.</p><small>Please pay today to secure your booking.</small></div></div>'
      : '<div class="pg-alert pg-alert-amber"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><div><b>Secure your date</b><p>Your date is held once the ' + pct + '% deposit is received.</p><small>The balance is due ' + esc(balDue) + '.</small></div></div>';
    const trust = (p, t, d) => '<div class="pg-trust-row"><span class="pg-trust-ic" aria-hidden="true"><svg viewBox="0 0 24 24">' + p + '</svg></span><div><b>' + t + '</b><span>' + d + '</span></div></div>';
    book = '<p class="pg-lead">Your booking is confirmed once payment is received.</p>'
      + steps(1)
      + '<div class="qp-book-grid pg-grid"><div>'
      + alert
      + (full
        ? opt('bank', 'Bank transfer (Pay in full)', 'Pay the full amount now via bank transfer.', money(total), true, refChip)
        : opt('bank', 'Bank transfer (' + pct + '% deposit)', 'Pay the deposit now via bank transfer.', money(deposit), true, refChip)
          // pay it all up front by bank
          + opt('bankfull', 'Bank transfer (Pay in full)', 'Pay the full amount now via bank transfer. Nothing more to pay later.', money(total), false, refChip))
      + (q.cardOn ? opt('full', 'Credit or debit card (Pay in full)', 'Fast, secure payment with Visa, Mastercard or Amex.', money(total), false) : '')
      + (q.cardOn && q.payFull !== true ? (full
        ? opt('deposit', 'Credit or debit card (' + pct + '% deposit)', 'A ' + pct + '% deposit is not available as your event is less than 7 days away.', money(deposit), false, '', true)
        : opt('deposit', 'Credit or debit card (' + pct + '% deposit)', 'Secure your date by card. Balance due ' + esc(balDue) + '.', money(deposit), false)) : '')
      + '<label class="qp-name">Your name / Business<input type="text" id="qp-name" autocomplete="name" value="' + esc((q.customer && q.customer.name) || '') + '"></label>'
      + '<label class="qp-agree"><input type="checkbox" id="qp-agree"> <span>I have read and accept the <b>Terms &amp; Conditions</b> and this quote.</span></label>'
      + '<button type="button" class="qv-btn qv-btn-primary qp-go pg-go" id="qp-go" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><span id="qp-go-label">' + cta(full ? 'bank' : 'bank', full ? money(total) : money(deposit)) + '</span></button>'
      + '<p class="pg-note">Accepting turns this quote into your tax invoice.</p>'
      + '</div><aside class="qp-side pg-side">'
      + '<div class="pg-total"><span class="pg-total-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3h10v18H7z"/><path d="M10 8h4M10 12h4M10 16h2"/></svg></span><div><p class="qp-eyebrow">Quote summary</p><strong>' + money(total) + '</strong><span>Total (inc. GST)</span></div></div>'
      // after any discount, so subtotal + GST = total
      + '<div class="qv-sumrow"><span>Subtotal (ex GST)</span><span>' + money(Math.round(q.totalCents || 0) - Math.round(q.gstCents || 0)) + '</span></div>'
      + '<div class="qv-sumrow"><span>GST (10%)</span><span>' + money(q.gstCents) + '</span></div>'
      + '<div class="qv-sumrow qv-grand"><span>Total (inc. GST)</span><span>' + money(total) + '</span></div>'
      + (full
        ? '<div class="pg-due pg-due-red"><span>Amount due now</span><span>' + money(total) + '</span></div>'
        : '<div class="pg-due pg-due-amber" data-due="deposit"><span>Deposit due now</span><span>' + money(deposit) + '</span></div>'
          + '<div class="qv-sumrow" data-due="deposit"><span>Balance due ' + esc(balDue) + '</span><span>' + money(total - deposit) + '</span></div>'
          // shown instead when a pay-in-full option is picked
          + '<div class="pg-due pg-due-amber" data-due="full" hidden><span>Amount due now</span><span>' + money(total) + '</span></div>')
      + '<div class="pg-trust">'
      + trust('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 'Secure payments', 'Card payments are processed securely by Stripe.')
      + trust('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>', 'Your booking is protected', 'Once payment is received, your booking is confirmed.')
      + trust('<path d="M7 3h10v18l-2-1.5L13 21l-2-1.5L9 21l-2-1.5z"/><path d="M10 8h4M10 12h4"/>', 'Tax invoice provided', 'Your tax invoice is on this page once you&rsquo;ve paid.')
      + '</div></aside></div>';
  }

  const termsSec = opts.terms === false ? '' : `
    <section class="qp-sec qp-terms">
      ${terms}
      <p class="qp-terms-link">Also at <a href="/${djQuote ? 'dj-terms' : 'terms'}" target="_blank" rel="noopener">soundzgood.com.au/${djQuote ? 'dj-terms' : 'terms'}</a></p>
    </section>`;
  return termsSec + `
    <section class="qp-sec qp-book" id="qp-book">
      <p class="qp-eyebrow">${isInv ? 'Payment' : 'Secure your booking'}</p>
      <h2 class="qp-h2">${q.status === 'draft' ? 'Estimate only' : (q.paymentStatus ? 'Your booking' : 'Choose a payment option')}</h2>
      ${q.needsDetails && q.status !== 'draft' && !q.paymentStatus ? detailsLock(q, book) : book}
      <p class="qv-msg" id="qp-msg" hidden></p>
    </section>`;
}

/*  No name / email / phone on the quote yet: the payment options sit greyed
    out, and "Add your details" pops up the same form as the /details link.
    Once it's saved, they unlock.                                          */
function startTimes(cur) {
  let out = '<option value="">Choose a time</option>';
  for (let m = 6 * 60; m < 24 * 60; m += 30) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    const h = Math.floor(m / 60);
    out += '<option value="' + hh + '"' + (hh === cur ? ' selected' : '') + '>' + ((h % 12) || 12) + ':' + String(m % 60).padStart(2, '0') + (h < 12 ? 'am' : 'pm') + '</option>';
  }
  return out;
}
function detailsLock(q, book) {
  const c = q.customer || {};
  const parts = String(c.name || '').trim().split(/\s+/);
  const f = (name, label, val, type, req, wide, ph) => `<label class="qp-df${wide ? ' is-wide' : ''}"><span>${label}${req ? ' <b>*</b>' : ' <i>(optional)</i>'}</span><input name="${name}" type="${type || 'text'}" value="${esc(val || '')}"${ph ? ' placeholder="' + esc(ph) + '"' : ''}></label>`;
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
        <label class="qp-df"><span>Event start time <b>*</b></span><select name="eventStartTime">${startTimes(c.eventStartTime)}</select></label>
        ${f('eventVenue', 'Venue name &amp; address', c.eventVenue, 'text', true)}
        <label class="qp-df is-wide"><span>Anything we should know? <i>(optional)</i></span><textarea name="customerNotes" rows="3" placeholder="Access, parking, power, timings, special requests&hellip;">${esc(c.customerNotes || '')}</textarea></label>
      </div>
      <button type="submit" class="qp-dgo" id="qp-dgo">Continue to payment</button>
      <p class="qp-dmsg" id="qp-dmsg" hidden></p>
    </form>
  </div>`;
}

function wireProposal(q) {
  const dpop = document.getElementById('qp-dpop');
  const dform = document.getElementById('qp-dform');
  if (dpop) {
    const open = (on) => { dpop.hidden = !on; document.body.style.overflow = on ? 'hidden' : ''; if (on) { const i = dform.querySelector('input'); if (i) i.focus(); } };
    document.getElementById('qp-dopen').addEventListener('click', () => open(true));
    document.getElementById('qp-dx').addEventListener('click', () => open(false));
    dpop.addEventListener('click', (e) => { if (e.target === dpop) open(false); });
    if (!window.__dpopKeys) { window.__dpopKeys = true; document.addEventListener('keydown', (e) => { const p = document.getElementById('qp-dpop'); if (e.key === 'Escape' && p && !p.hidden) { p.hidden = true; document.body.style.overflow = ''; } }); }
    dform.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = (n) => String((dform.querySelector('[name="' + n + '"]') || {}).value || '').trim();
      const m = document.getElementById('qp-dmsg');
      const miss = [];
      if (!v('firstName')) miss.push('your first name');
      if (!v('lastName')) miss.push('your last name');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('email'))) miss.push('your email');
      if (v('phone').replace(/[^0-9]/g, '').length < 8) miss.push('your phone number');
      if (!v('eventStartTime')) miss.push('the event start time');
      if (!v('eventVenue')) miss.push('the venue');
      if (miss.length) { m.hidden = false; m.textContent = 'Please add ' + miss.join(', ') + '.'; return; }
      const btn = document.getElementById('qp-dgo');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await callable.details({ token: token(), name: v('firstName') + ' ' + v('lastName'), business: v('business'), email: v('email'), phone: v('phone'),
          ccEmail: v('ccEmail'), address: v('address'), dayContact: v('dayContact'), eventStartTime: v('eventStartTime'), eventVenue: v('eventVenue'), customerNotes: v('customerNotes') });
        const res = await callable.get({ token: token() });
        document.body.style.overflow = '';
        render(res.data);
        const b = document.getElementById('qp-book'); if (b) b.scrollIntoView();
      } catch (err) { btn.disabled = false; btn.textContent = 'Continue to payment'; m.hidden = false; m.textContent = (err && err.message) || 'Could not save. Please try again.'; }
    });
  }

  // Download invoice (on the accepted / invoice view)
  document.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => window.print()));
  // printing / PDF: show every booking term, not just the open one
  window.addEventListener('beforeprint', () => document.querySelectorAll('.qp-term').forEach((d) => { d.open = true; }));
  const msg = document.getElementById('qp-msg');
  const say = (t, bad) => { if (msg) { msg.hidden = false; msg.textContent = t; msg.className = 'qv-msg' + (bad ? ' qv-bad' : ''); } };

  // back from Stripe before the webhook has landed: check again a few times
  if (/[?&]paid=1/.test(location.search) && !q.paymentStatus) {
    let n = 0;
    const t = setInterval(async () => {
      n++;
      try { const res = await callable.get({ token: token() }); if (res.data.paymentStatus || n > 8) { clearInterval(t); render(res.data); } }
      catch (e) { if (n > 8) clearInterval(t); }
    }, 2500);
  }

  // pay balance / deposit by card after accepting
  document.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; say('Opening secure payment…');
    try {
      const res = await callable.checkout({ token: token(), name: q.acceptedName || (q.customer && q.customer.name) || 'Customer', option: b.getAttribute('data-pay') === 'deposit' ? 'deposit' : 'full', agreed: true });
      location.href = res.data.url;
    } catch (err) { b.disabled = false; say((err && err.message) || 'Could not open payment. Please try again.', true); }
  }));

  const go = document.getElementById('qp-go');
  if (!go) return;
  // no paying or confirming until the terms box is ticked
  const goLabel = document.getElementById('qp-go-label');
  document.querySelectorAll('input[name="qp-opt"]').forEach((r) => r.addEventListener('change', () => {
    if (r.checked && goLabel) goLabel.innerHTML = r.getAttribute('data-cta') || 'Accept &amp; continue';
    // the summary follows the choice: deposit + balance, or the whole amount now
    if (r.checked) {
      const whole = r.value === 'full' || r.value === 'bankfull';
      document.querySelectorAll('[data-due="deposit"]').forEach((el) => { el.hidden = whole; });
      document.querySelectorAll('[data-due="full"]').forEach((el) => { el.hidden = !whole; });
    }
  }));
  const agreeBox = document.getElementById('qp-agree');
  if (agreeBox) agreeBox.addEventListener('change', () => { go.disabled = !agreeBox.checked; });
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
        const res = await callable.get({ token: token() });
        render(res.data);
        const b = document.getElementById('qp-book'); if (b) b.scrollIntoView();
      } else {
        say('Opening secure payment…');
        const res = await callable.checkout({ token: token(), name, option: pick, agreed: true });
        location.href = res.data.url;
      }
    } catch (err) {
      go.disabled = false;
      say((err && err.message) || 'Something went wrong. Please try again.', true);
    }
  });
}

function fail(text) {
  document.getElementById('quote-root').innerHTML =
    `<div class="qv-empty"><h1>${esc(text)}</h1><p>If you think this is a mistake, please <a href="/contact">get in touch</a>.</p></div>`;
}

async function load() {
  if (!token()) return fail('No quote in this link.');
  if (!isFirebaseConfigured) return fail('This link cannot be opened right now.');
  try {
    await initFns();
    const res = await callable.get({ token: token() });
    render(res.data);
  } catch (err) {
    fail('This link is not valid or has expired.');
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
else load();
