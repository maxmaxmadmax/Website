/* ==========================================================================
   QUOTE / INVOICE  -  the public document page (/quote?t=<token>)

   Fetches one quote by its secret token through the getQuote function (the
   collection itself is closed to browsers), renders it as a traditional
   quote or tax invoice, and lets the customer Accept a quote or print/save
   it as a PDF. Prices are ex-GST; GST is shown at 10%.
   ========================================================================== */

import { firebaseConfig, functionsRegion, isFirebaseConfigured } from './firebase-config.js?v=407';

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
  lighting: 'Lighting', truss: 'Lighting',
  stage: 'Staging', furniture: 'Staging',
  backline: 'Backline', 'dj mixer': 'DJ equipment', vision: 'Vision', power: 'Power',
};
const COST_GROUP_ORDER = ['Audio', 'Lighting', 'Staging', 'Backline', 'DJ equipment', 'Vision', 'Power', 'Other'];
function costGroupOf(category) {
  return COST_GROUP[String(category || '').trim().toLowerCase()] || 'Other';
}
/*  [{ name, cents }] in the order above, only groups with a cost. */
function costBreakdown(lines, centsOf, categoryOf) {
  const sums = {};
  (lines || []).forEach((l) => {
    if (l.type === 'labour' || l.type === 'delivery' || l.type === 'discount' || l.type === 'fee') return;
    const c = centsOf(l);
    if (!c) return;
    const g = l.itemId ? costGroupOf(categoryOf(l)) : 'Other';
    sums[g] = (sums[g] || 0) + c;
  });
  return COST_GROUP_ORDER.filter((g) => sums[g]).map((g) => ({ name: g, cents: sums[g] }));
}

function labourRow(l, amt) {
  return '<tr class="qv-lab"><td class="qv-desc">' + esc(l.name || '')
    + (l.description ? '<span class="qv-sub">' + esc(l.description) + '</span>' : '')
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
  const labHrs = lab.reduce((t, l) => t + (parseFloat((/^([\d.]+) hrs?\b/.exec(l.description || '') || [])[1]) || 0), 0);
  const del = lines.filter((l) => l.type === 'delivery');
  const delCents = del.reduce((t, l) => t + lineAmount(l, days), 0);
  let h = '';
  if (groups.length) {
    h += '<div class="qv-sumhead">Equipment hire</div>';
    h += groups.map((g) => '<div class="qv-sumrow qv-sumsub"><span>' + esc(g.name) + '</span><span>' + money(g.cents) + '</span></div>').join('');
    h += '<div class="qv-sumrow qv-sumpart"><span>Hire subtotal</span><span>' + money(hire) + '</span></div>';
  }
  if (lab.length) {
    h += '<div class="qv-sumrow qv-sumpart"><span>Labour &ndash; setup &amp; pack-down' + (labHrs ? ' (' + labHrs + ' hr' + (labHrs === 1 ? '' : 's') + ')' : '') + '</span><span>' + money(labCents) + '</span></div>';
  }
  if (del.length) {
    h += '<div class="qv-sumrow qv-sumpart"><span>Delivery &amp; pickup</span><span>' + (delCents ? money(delCents) : 'Free') + '</span></div>';
  }
  lines.filter((l) => l.type === 'fee').forEach((l) => {
    h += '<div class="qv-sumrow qv-sumpart"><span>' + esc(l.name || 'Booking & admin fee') + '</span><span>' + money(lineAmount(l, days)) + '</span></div>';
  });
  return h;
}

function render(q) {
  const isInvoice = q.kind === 'invoice';
  const docTitle = isInvoice ? 'Tax Invoice' : 'Quote';
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
    const g = L.slice(i, end).sort((a, b) => catOf(a).localeCompare(catOf(b)) || String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true }));
    L.splice(i, end - i, ...g);
    i = end - 1;
  }

  // total labour hours, read from each line ("2.5 hrs @ $85/hr ...")
  const labHrs = L.filter((l) => l.type === 'labour')
    .reduce((t, l) => t + (parseFloat((/^([\d.]+) hrs?\b/.exec(l.description || '') || [])[1]) || 0), 0);

  const rows = L.map((l, i) => {
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
        ? '<tr class="qv-labhead"><td colspan="5">Setup &amp; pack-down &middot; ' + labHrs + ' hr' + (labHrs === 1 ? '' : 's') + ' total</td></tr>'
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
    const isDisc = l.type === 'discount';
    const lineDays = Math.max(1, Math.round(l.days || days));
    const free = l.type === 'kit' && (l.charge === 'free' || !l.unitCents);
    return `
      <tr${isDisc ? ' class="qv-row-disc"' : ''}>
        <td class="qv-desc">${esc(l.name || '')}${l.description ? `<span class="qv-sub">${esc(l.description)}</span>` : ''}</td>
        <td class="qv-num">${isDisc ? '' : esc(l.qty)}</td>
        <td class="qv-num">${isDisc ? '' : (free ? '<span class="qv-incl">Included</span>' : money(l.unitCents))}</td>
        <td class="qv-num">${isDisc || free ? '' : esc(lineDays)}</td>
        <td class="qv-num">${free ? '' : money(amt)}</td>
      </tr>`;
  }).join('');

  const accepted = q.status === 'accepted' || q.status === 'invoiced' || q.status === 'paid';
  const canAccept = !isInvoice && (q.status === 'draft' || q.status === 'sent');

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
        <div class="qv-sumrow qv-sumtotal"><span>Subtotal (ex GST)</span><span>${money(q.subtotalCents)}</span></div>
        ${q.discountCents ? `<div class="qv-sumrow"><span>Discount</span><span>&minus;${money(q.discountCents)}</span></div>` : ''}
        <div class="qv-sumrow"><span>GST (10%)</span><span>${money(q.gstCents)}</span></div>
        <div class="qv-sumrow qv-grand"><span>Total (incl GST)</span><span>${money(q.totalCents)}</span></div>
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
    </div>` + (proposal ? proposalBottom(q) : '');
  if (proposal) wireProposal(q);

  const print = document.getElementById('qv-print');
  if (print) print.addEventListener('click', () => window.print());

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

  const tiles = groups.map((g) => g.name).concat(lab.length ? ['Crew'] : [])
    .map((k) => '<div class="qp-tile">' + svgIcon(k) + '<b>' + esc(k) + '</b><span>' + esc(BLURB[k] || '') + '</span></div>').join('');

  // investment summary: each group ex GST / GST / inc GST
  const rows = groups.map((g) => [g.name + (g.name === 'Other' ? '' : ' production'), g.cents])
    .concat(lab.length ? [['Setup & pack-down', labCents]] : [])
    .concat(del.length ? [['Delivery & pickup', delCents]] : [])
    .concat(lines.filter((l) => l.type === 'fee').map((l) => [l.name || 'Booking & admin fee', lineAmount(l, days)]));
  const r = (label, ex) => '<tr><td>' + esc(label) + '</td><td>' + (ex ? money(ex) : 'Free') + '</td><td>' + (ex ? money(Math.round(ex * 0.1)) : '') + '</td><td>' + (ex ? money(Math.round(ex * 1.1)) : 'Free') + '</td></tr>';
  const disc = q.discountCents ? '<tr class="qp-disc"><td>Discount</td><td>&minus;' + money(q.discountCents) + '</td><td></td><td>&minus;' + money(Math.round(q.discountCents * 1.1)) + '</td></tr>' : '';

  return `
    <section class="qp-hero" style="--qp-photo:url('/images/services/${HERO_PHOTO[type]}')">
      <div class="qp-hero-in">
        <img class="qp-hero-logo" src="/images/logowhite.png" alt="SoundzGood Whitsundays">
        <p class="qp-eyebrow">Event production proposal</p>
        <h1>${esc(event)}</h1>
        <p class="qp-when">${when ? '&#128197; ' + esc(when) : ''}${town ? '<br>&#128205; ' + esc(town) : ''}</p>
        <p class="qp-ref">Quote ${esc(q.number || '')}${c.name ? ' &middot; Prepared for ' + esc(c.name) : ''}</p>
      </div>
    </section>

    <section class="qp-sec qp-intro">
      <p>Thanks for the opportunity to provide event production for <strong>${esc(event)}</strong>.
        We&rsquo;ve put together the following production plan based on what we&rsquo;ve discussed.
        Everything below covers the equipment, preparation and crew required to deliver a successful event.</p>
      ${tiles ? '<div class="qp-tiles">' + tiles + '</div>' : ''}
    </section>

    <section class="qp-sec">
      <p class="qp-eyebrow">Investment summary</p>
      <h2 class="qp-h2">Your production investment</h2>
      <p class="qp-sub">Total inclusive of GST for ${esc(event)}${when ? ' on ' + esc(when) : ''}, itemised by category below.</p>
      <table class="qp-inv">
        <thead><tr><th>Description</th><th>Ex GST</th><th>GST (10%)</th><th>Inc GST</th></tr></thead>
        <tbody>${rows.map(([l, c2]) => r(l, c2)).join('')}${disc}</tbody>
        <tfoot><tr><td colspan="3">Total inc. GST</td><td>${money(q.totalCents)}</td></tr></tfoot>
      </table>
      <a class="qp-jump" href="#qp-book">Accept &amp; secure your booking &darr;</a>
    </section>`;
}

const TERMS = [
  ['Booking & payment', 'A 50% deposit secures your date. The balance is due 7 days before your event. Your booking is confirmed once the deposit is received. All prices are in AUD and include GST where shown.'],
  ['Changes & cancellations', 'Changes to equipment, times or the venue can be made up to 7 days before your event - we\'ll send an updated quote. If you cancel more than 30 days before the event, your deposit is refunded less any costs already incurred. Within 30 days the deposit is non-refundable, and within 7 days the full amount is payable.'],
  ['Production & delivery', 'Delivery, setup and pack-down are included as listed. We need safe vehicle access, a suitable power supply (or a generator as quoted) and a clear setup area at the agreed times. Delays outside our control may add labour at the quoted hourly rate.'],
  ['Equipment & safety', 'All equipment remains the property of SoundzGood Whitsundays. You\'re responsible for loss or damage caused by guests or misuse during the hire. Outdoor equipment may be paused or packed down in unsafe weather to protect people and gear.'],
];

function proposalBottom(q) {
  const total = Math.round(q.totalCents || 0);
  const pct = q.depositPct || 50;
  const deposit = Math.round(total * pct / 100);
  const paid = Math.round(q.amountPaidCents || 0);
  const owing = Math.max(0, total - paid);
  const balDue = (() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String((q.hire && q.hire.startDate) || ''));
    if (!m) return '7 days before your event';
    const d = new Date(+m[1], +m[2] - 1, +m[3] - 7);
    return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(/,/g, '');
  })();
  const ref = q.number || '';
  const bank = '<p class="qp-bank"><strong>Bank transfer</strong><br>' + esc(SELLER.bankName) + '<br>BSB <strong>' + esc(SELLER.bankBsb) + '</strong> &nbsp; Account <strong>' + esc(SELLER.bankAcc) + '</strong><br>Reference: <strong>' + esc(ref) + '</strong></p>';
  const justPaid = /[?&]paid=1/.test(location.search);

  const terms = TERMS.map(([h, t], i) => '<details class="qp-term"' + (i === 0 ? ' open' : '') + '><summary>' + esc(h) + '</summary><p>' + esc(t) + '</p></details>').join('');

  let book;
  if (q.paymentStatus === 'paid') {
    book = '<div class="qp-done">&#10003; Paid in full &mdash; thank you! Your booking is locked in.</div>';
  } else if (q.paymentStatus === 'deposit') {
    book = '<div class="qp-done">&#10003; Deposit of ' + money(paid) + ' received &mdash; your date is secured.</div>'
      + '<p class="qp-sub">Balance of <strong>' + money(owing) + '</strong> due ' + esc(balDue) + '.</p>'
      + (q.cardOn ? '<button type="button" class="qv-btn qv-btn-primary qp-go" data-pay="balance">Pay the balance by card</button>' : '')
      + bank;
  } else if (q.paymentStatus === 'bank') {
    book = '<div class="qp-done">&#10003; Quote accepted' + (q.acceptedName ? ' by ' + esc(q.acceptedName) : '') + '. Please pay the ' + pct + '% deposit of <strong>' + money(deposit) + '</strong> by bank transfer to secure your date.</div>' + bank
      + (q.cardOn ? '<button type="button" class="qv-btn qv-btn-ghost qp-go" data-pay="deposit">Or pay the deposit by card</button>' : '');
  } else if (justPaid) {
    book = '<div class="qp-done">&#10003; Payment received &mdash; thank you! Confirming your booking&hellip;</div>';
  } else if (q.status === 'accepted') {
    book = '<div class="qp-done">&#10003; Quote accepted. We&rsquo;ll be in touch about payment.</div>';
  } else {
    const opt = (v, title, amt, note, on) => '<label class="qp-opt"><input type="radio" name="qp-opt" value="' + v + '"' + (on ? ' checked' : '') + '><span><b>' + title + '</b><strong>' + amt + '</strong><em>' + note + '</em></span></label>';
    book = '<div class="qp-book-grid"><div>'
      + (q.cardOn ? opt('deposit', 'Pay ' + pct + '% deposit', money(deposit), 'Secure your date now. Balance due ' + esc(balDue) + '.', true)
        + opt('full', 'Pay in full', money(total), 'Pay the total now and you&rsquo;re all done.', false) : '')
      + opt('bank', 'Bank transfer', money(deposit) + ' deposit', 'Accept now, pay the deposit by bank transfer. No fees.', !q.cardOn)
      + '<label class="qp-name">Your name<input type="text" id="qp-name" autocomplete="name" value="' + esc((q.customer && q.customer.name) || '') + '"></label>'
      + '<label class="qp-agree"><input type="checkbox" id="qp-agree"> I accept this quote and the booking terms above.</label>'
      + '<button type="button" class="qv-btn qv-btn-primary qp-go" id="qp-go">Accept &amp; continue</button>'
      + '<p class="qp-secure">&#128274; Card payments are processed securely by Stripe.</p>'
      + '</div><aside class="qp-side"><p class="qp-eyebrow">Quote summary</p>'
      + '<div class="qv-sumrow"><span>Production subtotal (ex GST)</span><span>' + money(q.subtotalCents) + '</span></div>'
      + '<div class="qv-sumrow"><span>GST (10%)</span><span>' + money(q.gstCents) + '</span></div>'
      + '<div class="qv-sumrow qv-grand"><span>Total inc. GST</span><span>' + money(total) + '</span></div>'
      + '<div class="qv-sumrow"><span>Deposit (' + pct + '%)</span><span>' + money(deposit) + '</span></div>'
      + '<div class="qv-sumrow"><span>Balance due ' + esc(balDue) + '</span><span>' + money(total - deposit) + '</span></div>'
      + '</aside></div>';
  }

  return `
    <section class="qp-sec">
      <p class="qp-eyebrow">Terms &amp; conditions</p>
      <h2 class="qp-h2">Booking terms</h2>
      ${terms}
    </section>
    <section class="qp-sec qp-book" id="qp-book">
      <p class="qp-eyebrow">Secure your booking</p>
      <h2 class="qp-h2">${q.paymentStatus ? 'Your booking' : 'Choose a payment option'}</h2>
      ${book}
      <p class="qv-msg" id="qp-msg" hidden></p>
    </section>`;
}

function wireProposal(q) {
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
  go.addEventListener('click', async () => {
    const pick = (document.querySelector('input[name="qp-opt"]:checked') || {}).value || 'bank';
    const name = String((document.getElementById('qp-name') || {}).value || '').trim();
    const agreed = !!(document.getElementById('qp-agree') || {}).checked;
    if (!name) return say('Please type your name.', true);
    if (!agreed) return say('Please tick to accept the quote and booking terms.', true);
    go.disabled = true;
    try {
      if (pick === 'bank') {
        say('Accepting…');
        await callable.accept({ token: token(), name, method: 'bank' });
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
