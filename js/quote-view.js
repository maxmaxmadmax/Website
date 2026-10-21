/* ==========================================================================
   QUOTE / INVOICE  -  the public document page (/quote?t=<token>)

   Fetches one quote by its secret token through the getQuote function (the
   collection itself is closed to browsers), renders it as a traditional
   quote or tax invoice, and lets the customer Accept a quote or print/save
   it as a PDF. Prices are ex-GST; GST is shown at 10%.
   ========================================================================== */

import { TERMS, TERMS_INTRO, termBodyHtml } from './terms-data.js?v=652';
import { firebaseConfig, functionsRegion, isFirebaseConfigured } from './firebase-config.js?v=652';

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

/*  ON / OFF SWITCH (Max, 17 Oct 2026): the customer's itemised quote grouped
    into sections - AUDIO, LIGHTING, STAGING, BACKLINE ... then LABOUR, TRAVEL
    & TRANSPORT, BOOKING & ADMIN, DISCOUNT. To go back to the plain list in the
    order the lines were added: change true to false below, run
    node tools/bump-assets.js, then push.                                    */
const ITEMISE_BY_SECTION = true;

const money = (c) => '$' + (Math.round(c || 0) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function esc(v) {
  const d = document.createElement('div');
  d.textContent = String(v == null ? '' : v);
  return d.innerHTML;
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
  };
}

function lineAmount(l, days) {
  if (l.type === 'discount') return -Math.max(0, Math.round(l.amountCents || 0));
  const qty = Math.max(0, Math.round(l.qty || 0));
  const unit = Math.max(0, Math.round(l.unitCents || 0));
  const d = Math.max(1, Math.round(l.days || days));
  return qty * unit * d;   // quantity x day rate x number of days
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


/*  COST BREAKDOWN GROUPS (Max, 15 Oct 2026) - KEEP IN STEP between
    js/quote-view.js and js/admin-app.js. Inventory category -> group shown
    in the totals ("Audio $180, Staging $180, Lighting $60").            */
const COST_GROUP = {
  audio: 'Audio', mixer: 'Audio', amp: 'Audio', microphone: 'Audio', iem: 'Audio', di: 'Audio',
  'studio monitor': 'Audio', cable: 'Audio', stands: 'Audio',
  speaker: 'Audio', speakers: 'Audio', 'mic kit': 'Backline', drum: 'Backline', drums: 'Backline',   // Max's Inventory names (17 Oct 2026)
  lighting: 'Lighting', truss: 'Lighting',
  stage: 'Staging', furniture: 'Staging',
  backline: 'Backline', 'dj mixer': 'DJ equipment', vision: 'Vision', power: 'Audio',   // power & cables count as Audio (Max, 17 Oct 2026)
};
const COST_GROUP_ORDER = ['Audio', 'Backline', 'Lighting', 'Staging', 'DJ equipment', 'Vision', 'Other'];   // Max's order, 17 Oct 2026
function costGroupOf(category) {
  // gear in a category we don't know yet counts as Audio, not "Other" (Max, 17 Oct 2026)
  return COST_GROUP[String(category || '').trim().toLowerCase()] || 'Audio';
}
/*  [{ name, cents }] in the order above, only groups with a cost. */
function costBreakdown(lines, centsOf, categoryOf) {
  const sums = {};
  (lines || []).forEach((l) => {
    if (l.type === 'labour' || l.type === 'delivery' || l.type === 'discount' || l.type === 'fee') return;
    if (l.resType) return;   // crew & vehicles: their own subtotal
    const c = centsOf(l);
    if (!c) return;
    const g = l.itemId ? costGroupOf(categoryOf(l)) : 'Other';
    sums[g] = (sums[g] || 0) + c;
  });
  return COST_GROUP_ORDER.filter((g) => sums[g]).map((g) => ({ name: g, cents: sums[g] }));
}

/*  CUSTOMER WORDING FOR LABOUR (Max, 17 Oct 2026). Setup / pack-down are
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
    const what = /^pack-?down/i.test(String(l.name || '')) ? 'Pack-down, load-out & return' : 'Delivery, rigging & system setup';
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

function labourRow(l, amt) {
  return '<tr class="qv-lab"><td class="qv-desc">' + esc(crewName(l))
    + (crewDesc(l) ? '<span class="qv-sub">' + esc(crewDesc(l)) + '</span>' : '')
    + '</td><td class="qv-num">' + esc(l.qty) + '</td><td class="qv-num">' + money(l.unitCents)
    + '</td><td class="qv-num">1</td><td class="qv-num">' + money(amt) + '</td></tr>';
}

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
  if (groups.length) {
    h += '<div class="qv-sumhead">Equipment hire</div>';
    h += groups.map((g) => '<div class="qv-sumrow qv-sumsub"><span>' + esc(g.name) + '</span><span>' + money(g.cents) + '</span></div>').join('');
    h += '<div class="qv-sumrow qv-sumpart"><span>Hire subtotal</span><span>' + money(hire) + '</span></div>';
  }
  // ONE labour total for the customer: setup, pack-down and operators together (Max, 17 Oct 2026)
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
      headings (Cable, Stands...), A-Z - the same as the quote builder
      (Max, 15 Oct 2026).                                                  */
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
  const SECTION_ORDER = COST_GROUP_ORDER.concat(['Labour', 'Travel & transport', 'Booking & admin', 'Discount']);
  const sectionOf = (l) => {
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

  const rows = L.map((l, i) => secHead(i) + rowFor(l, i)).join('');
  function secHead(i) {
    return ITEMISE_BY_SECTION && secStart[i] ? '<tr class="qv-sechead"><td colspan="5">' + esc(secStart[i]) + '</td></tr>' : '';
  }
  function rowFor(l, i) {
    const amt = lineAmount(l, days);
    if (l.type === 'delivery' && !l.unitCents) {
      return '<tr class="qv-lab"><td class="qv-desc">' + esc(l.name || '')
        + (l.description ? '<span class="qv-sub">' + esc(l.description) + '</span>' : '')
        + '</td><td class="qv-num"></td><td class="qv-num"></td><td class="qv-num"></td><td class="qv-num"><strong>Free</strong></td></tr>';
    }
    if (l.type === 'labour') {
      // a heading over setup + pack-down with the total hours (Max, 15 Oct 2026)
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
    const isDisc = l.type === 'discount';
    const lineDays = Math.max(1, Math.round(l.days || days));
    const free = l.type === 'kit' && (l.charge === 'free' || !l.unitCents);
    return `
      <tr${isDisc ? ' class="qv-row-disc"' : ''}>
        <td class="qv-desc">${esc(l.type === 'fee' ? 'Booking & admin' : (l.name || ''))}${l.description ? `<span class="qv-sub">${esc(l.description)}</span>` : ''}</td>
        <td class="qv-num">${isDisc ? '' : esc(l.qty)}</td>
        <td class="qv-num">${isDisc ? '' : (free ? '<span class="qv-incl">Included</span>' : money(l.unitCents))}</td>
        <td class="qv-num">${isDisc || free ? '' : esc(lineDays)}</td>
        <td class="qv-num">${free ? '' : money(amt)}</td>
      </tr>`;
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
        <thead><tr><th>Description</th><th class="qv-num">Qty</th><th class="qv-num">Day rate</th><th class="qv-num">Days</th><th class="qv-num">Amount</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="qv-sub">No items.</td></tr>'}</tbody>
      </table>

      <div class="qv-sumwrap">
      <div class="qv-breakdown">${sumBreakdown(q, days)}</div>
      <div class="qv-summary">
        <!-- adds straight down: discount first, then the subtotal after it (Max, 17 Oct 2026) -->
        ${q.discountCents ? `<div class="qv-sumrow qv-sumpart"><span>Discount</span><span>&minus;${money(q.discountCents)}</span></div>` : ''}
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
   THE PROPOSAL (Max, 16 Oct 2026, from his mock-up)
   One scrolling page for a QUOTE: photo + event, a short intro, what's
   included, the investment summary, the itemised quote (the paper above),
   booking terms, then "Secure your booking" - pay the 50% deposit or in
   full by card (Stripe), or accept and pay by bank transfer.
   ========================================================================= */
const HERO_PHOTO = {
  community: 'community-events.webp', corporate: 'corporate-functions.webp', festival: 'festivals.webp',
  wedding: 'weddings.webp', private: 'private-functions.webp', sporting: 'sporting-events.webp',
  touring: 'touring-bands.webp',
};
function guessType(name) {
  const n = String(name || '').toLowerCase();
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
  const tiles = groups.map((g) => g.name).concat(lab.length || crewC ? ['Crew'] : [])
    .map((k) => '<div class="qp-tile">' + svgIcon(k) + '<b>' + esc(k) + '</b><span>' + esc(BLURB[k] || '') + '</span></div>').join('');

  // investment summary: each group ex GST / GST / inc GST
  const rows = groups.map((g) => [g.name, g.cents])   // AUDIO, LIGHTING, STAGING... (shown in capitals)
    .concat(lab.length || crewC ? [['Labour', labCents + crewC]] : [])   // setup, pack-down & operators as one
    .concat(vehC ? [['Vehicles', vehC]] : [])
    .concat(del.length ? [[delCents ? 'Travel & transport' : 'Local delivery & pickup', delCents]] : [])
    .concat(lines.filter((l) => l.type === 'fee').map((l) => ['Booking & admin', lineAmount(l, days)]));
  const r = (label, ex) => '<tr><td>' + esc(label) + '</td><td>' + (ex ? money(ex) : 'Free') + '</td><td>' + (ex ? money(Math.round(ex * 0.1)) : '') + '</td><td>' + (ex ? money(Math.round(ex * 1.1)) : 'Free') + '</td></tr>';
  // QUOTE DETAILS + WHAT'S INCLUDED under the table (Max, 16 Oct 2026).
  // Valid for 30 days from the quote date; the list is built from what's on the quote.
  const VALID_DAYS = 30;
  const validUntil = q.createdAt ? fmtDate(q.createdAt + VALID_DAYS * 86400) : '';
  // total crew hours, read off each labour line ("2.5 hrs @ $80/hr ...")
  const labHrs = lab.reduce((t, l) => t + (parseFloat((/^([\d.]+) hrs?\b/.exec(l.description || '') || [])[1]) || 0), 0);
  const incl = groups.filter((g) => g.name !== 'Other').map((g) => g.name.toLowerCase());
  const included = []
    .concat(incl.length ? [(incl.length > 1 ? incl.slice(0, -1).join(', ') + ' & ' + incl[incl.length - 1] : incl[0]).replace(/^./, (x) => x.toUpperCase()) + ' equipment as itemised'] : [])
    .concat(['All cables, stands & accessories needed to run it'])
    .concat(del.length ? [delCents ? 'Travel &amp; transport' + (town ? ' &mdash; ' + esc(town) : '') : 'Local delivery &amp; pickup'] : [])
    .concat(lab.length ? ['Bump-in &amp; bump-out crew' + (labHrs ? ' (' + labHrs + ' crew hours)' : '')] : [])
    .concat(['GST included in the total']);
  const pct = q.depositPct || 50;
  const details = '<div class="qp-inv-extra">'
    + '<div class="qp-incl"><p class="qp-mini">What&rsquo;s included</p><ul>' + included.map((t) => '<li>' + t + '</li>').join('') + '</ul></div>'
    + '<div class="qp-qd"><p class="qp-mini">Quote details</p><dl>'
    + '<div><dt>Quote</dt><dd>' + esc(q.number || '') + '</dd></div>'
    + (q.createdAt ? '<div><dt>Issued</dt><dd>' + esc(fmtDate(q.createdAt)) + '</dd></div>' : '')
    + (validUntil ? '<div><dt>Valid until</dt><dd>' + esc(validUntil) + '</dd></div>' : '')
    + (fullOnly(q)
      ? '<div><dt>To secure</dt><dd>Payment in full &middot; ' + money(q.totalCents || 0) + '</dd></div>'
      : '<div><dt>To secure</dt><dd>' + pct + '% deposit &middot; ' + money(Math.round((q.totalCents || 0) * pct / 100)) + '</dd></div>')
    + '</dl></div></div>';
  const disc = q.discountCents ? '<tr class="qp-disc"><td>Discount</td><td>&minus;' + money(q.discountCents) + '</td><td></td><td>&minus;' + money(Math.round(q.discountCents * 1.1)) + '</td></tr>' : '';

  return `
    <section class="qp-hero">
      <div class="qp-hero-photo" style="--qp-photo:url('/images/services/${HERO_PHOTO[type]}')">
        <div class="qp-hero-in">
          <p class="qp-eyebrow">Event production proposal</p>
          <h1>${esc(event)}</h1>
          <p class="qp-when">${when ? svgIcon('Date') + esc(when) : ''}${town ? '<br>' + svgIcon('Pin') + esc(town) : ''}</p>
        </div>
      </div>
      <div class="qp-hero-body">
        <p class="qp-intro">Thanks for the opportunity to provide event production for ${esc(event)}.
          We&rsquo;ve put together the following production plan based on what we&rsquo;ve discussed.
          Everything below covers the equipment, preparation and crew required to deliver a successful event.</p>
        ${tiles ? '<div class="qp-tiles">' + tiles + '</div>' : ''}
        <p class="qp-ref">Quote ${esc(q.number || '')}${c.name ? ' &middot; Prepared for ' + esc(c.name) : ''}</p>
      </div>
    </section>

    <section class="qp-sec qp-invest">
      <p class="qp-eyebrow">Investment summary</p>
      <h2 class="qp-h2">Your production investment</h2>
      <p class="qp-sub">Total inclusive of GST for ${esc(event)}${when ? ' on ' + esc(when) : ''}, itemised by category below.</p>
      <table class="qp-inv">
        <thead><tr><th>Description</th><th>Ex GST</th><th>GST (10%)</th><th>Inc GST</th></tr></thead>
        <tbody>${rows.map(([l, c2]) => r(l, c2)).join('')}${disc}</tbody>
        <tfoot><tr><td>Total inc. GST</td><td></td><td></td><td>${money(q.totalCents)}</td></tr></tfoot>
      </table>
      ${details}
      <a class="qp-jump" href="#qp-book">Accept &amp; secure your booking &darr;</a>
    </section>`;
}

// booking terms live in js/terms-data.js (also used by the /terms page)

/*  PAY IN FULL WITHIN 7 DAYS (Max, 20 Oct 2026). The balance is due 7 days
    before the event, so once that day arrives there is no deposit option -
    only payment in full. The server (quoteCheckout) enforces the same rule. */
function balanceDueDate(q) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String((q.hire && q.hire.startDate) || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3] - 7) : null;
}
function fullOnly(q) {
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
  /*  LATE PAYMENT CHARGES shown plainly (Max, 20 Oct 2026) */
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

  // ONE dropdown with every clause inside - deliberately looks like serious small print (Max, 16 Oct 2026)
  const terms = '<details class="qp-term qp-legal"><summary><span class="qp-legal-warn">&#9888;</span><span><b>Terms &amp; Conditions &mdash; read before booking</b><em>' + TERMS.length + ' clauses &middot; binding once you accept or pay &middot; tap to read</em></span></summary>'
    + '<div class="qp-legal-body">' + TERMS_INTRO.map((t) => '<p>' + esc(t) + '</p>').join('')
    + TERMS.map(([h, lines], i) => '<div class="qp-legal-clause"><h4>' + (i + 1) + '. ' + esc(h) + '</h4>' + termBodyHtml(lines, esc) + '</div>').join('')
    + '</div></details>';

  /*  1 Accept quote -> 2 Get your invoice -> 3 Pay   (Max, 20 Oct 2026) */
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
        // they chose bank transfer IN FULL (Max, 20 Oct 2026)
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
    /*  THE PAYMENT GATEWAY (Max's mock-up, 20 Oct 2026): bank transfer first,
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
    const alert = full
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
          // pay it all up front by bank (Max, 20 Oct 2026)
          + opt('bankfull', 'Bank transfer (Pay in full)', 'Pay the full amount now via bank transfer. Nothing more to pay later.', money(total), false, refChip))
      + (q.cardOn ? opt('full', 'Credit or debit card (Pay in full)', 'Fast, secure payment with Visa, Mastercard or Amex.', money(total), false) : '')
      + (q.cardOn ? (full
        ? opt('deposit', 'Credit or debit card (' + pct + '% deposit)', 'A ' + pct + '% deposit is not available as your event is less than 7 days away.', money(deposit), false, '', true)
        : opt('deposit', 'Credit or debit card (' + pct + '% deposit)', 'Secure your date by card. Balance due ' + esc(balDue) + '.', money(deposit), false)) : '')
      + '<label class="qp-name">Your name / Business<input type="text" id="qp-name" autocomplete="name" value="' + esc((q.customer && q.customer.name) || '') + '"></label>'
      + '<label class="qp-agree"><input type="checkbox" id="qp-agree"> <span>I have read and accept the <b>Terms &amp; Conditions</b> and this quote.</span></label>'
      + '<button type="button" class="qv-btn qv-btn-primary qp-go pg-go" id="qp-go" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><span id="qp-go-label">' + cta(full ? 'bank' : 'bank', full ? money(total) : money(deposit)) + '</span></button>'
      + '<p class="pg-note">Accepting turns this quote into your tax invoice.</p>'
      + '</div><aside class="qp-side pg-side">'
      + '<div class="pg-total"><span class="pg-total-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3h10v18H7z"/><path d="M10 8h4M10 12h4M10 16h2"/></svg></span><div><p class="qp-eyebrow">Quote summary</p><strong>' + money(total) + '</strong><span>Total (inc. GST)</span></div></div>'
      // after any discount, so subtotal + GST = total (Max, 17 Oct 2026)
      + '<div class="qv-sumrow"><span>Subtotal (ex GST)</span><span>' + money(Math.round(q.totalCents || 0) - Math.round(q.gstCents || 0)) + '</span></div>'
      + '<div class="qv-sumrow"><span>GST (10%)</span><span>' + money(q.gstCents) + '</span></div>'
      + '<div class="qv-sumrow qv-grand"><span>Total (inc. GST)</span><span>' + money(total) + '</span></div>'
      + (full
        ? '<div class="pg-due pg-due-red"><span>Amount due now</span><span>' + money(total) + '</span></div>'
        : '<div class="pg-due pg-due-amber" data-due="deposit"><span>Deposit due now</span><span>' + money(deposit) + '</span></div>'
          + '<div class="qv-sumrow" data-due="deposit"><span>Balance due ' + esc(balDue) + '</span><span>' + money(total - deposit) + '</span></div>'
          // shown instead when a pay-in-full option is picked (Max, 20 Oct 2026)
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
      <p class="qp-terms-link">Also at <a href="/terms" target="_blank" rel="noopener">soundzgood.com.au/terms</a></p>
    </section>`;
  return termsSec + `
    <section class="qp-sec qp-book" id="qp-book">
      <p class="qp-eyebrow">${isInv ? 'Payment' : 'Secure your booking'}</p>
      <h2 class="qp-h2">${q.status === 'draft' ? 'Estimate only' : (q.paymentStatus ? 'Your booking' : 'Choose a payment option')}</h2>
      ${book}
      <p class="qv-msg" id="qp-msg" hidden></p>
    </section>`;
}

function wireProposal(q) {
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
