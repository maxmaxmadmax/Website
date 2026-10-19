/* ==========================================================================
   VENDOR INVOICE & EVENT GUIDE  -  /vendor-invoice?t=<token>   (Max, 19 Oct 2026)

   Fetches one vendor booking by its secret token (getVendorInvoice - the
   bookings collection stays closed to browsers) and lays it out as A4 pages:
     1  Tax invoice + thank-you
     2  Event details, key times, your site, what to bring
     3+ The full Vendor Terms & Conditions (js/vendor-terms-data.js)
   Print / Save PDF uses the browser's print, set to A4 in vendor-invoice.css.

   The key times and checklist on page 2 are for Eatz & Beatz. If this is
   used for another event, change KEY_TIMES / BRING below.
   ========================================================================== */

import { termBodyHtml } from './terms-data.js?v=545';
import { VENDOR_TERMS, VENDOR_TERMS_INTRO } from './vendor-terms-data.js?v=545';
import { firebaseConfig, functionsRegion, isFirebaseConfigured } from './firebase-config.js?v=545';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

const money = (c) => '$' + (Math.round(c || 0) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtDate = (secs) => secs
  ? new Date(secs * 1000).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

/*  The night in four boxes. */
const KEY_TIMES = [
  ['Set up by', '4:15 pm', 'Vehicles parked or removed'],
  ['Doors open', '4:30 pm', 'Be trading and ready'],
  ['Night wraps', '9:30 pm', 'Live music until close'],
  ['Vehicles move', 'after 9:40 pm', 'Only when staff say the route is clear'],
];

const BRING = [
  'Marquee, tables, chairs and weights',
  'Your own power - quiet or silenced generators only',
  'Your own water',
  'Test-and-tagged leads; secured gas bottles',
  'Fire safety equipment for what you do',
  'Certificate of Currency (public liability, $20 million)',
  'Licences and permits that apply to your stall',
  'Bags and bins for your own commercial waste',
  'Pegs no deeper than 300 mm - irrigation underneath!',
  'Safe, visible guy ropes',
];

const NOT_ALLOWED = [
  'No vehicle movement between 4:15 pm and 9:40 pm',
  'No own music or speakers',
  'No alcohol sales (licensed event bar only)',
  'No commercial waste in public bins or drains',
];

function letterhead(d, title) {
  const s = d.seller;
  return `<header class="vi-head">
    <div class="vi-brand"><b>${esc(s.name)}</b>
      ${s.legal ? `<span>${esc(s.legal)}</span>` : ''}
      <span>${s.abn ? 'ABN ' + esc(s.abn) + ' &middot; ' : ''}${esc(s.address)}</span>
      <span>${esc(s.email)} &middot; ${esc(s.phone)} &middot; ${esc(s.site)}</span></div>
    <div class="vi-title">${esc(title)}</div>
  </header>`;
}

function pageInvoice(d) {
  const b = d.business;
  const ev = d.event;
  const subtotal = d.siteCents + d.feeCents;
  const siteLine = d.vendorType === 'market' && d.bayCount > 1
    ? `Market stall site - ${d.bayCount} bays` : (d.vendorType === 'food' ? 'Food vendor site' : 'Market stall site');
  return `<section class="vi-page">
    ${letterhead(d, 'Tax invoice')}
    <div class="vi-meta">
      <div><h4>Billed to</h4><p><b>${esc(b.name)}</b><br>${b.contactName ? esc(b.contactName) + '<br>' : ''}${esc(b.email)}${b.phone ? '<br>' + esc(b.phone) : ''}</p></div>
      <div><h4>Invoice</h4><dl>
        <dt>Invoice no.</dt><dd>${esc(d.invoiceNumber)}</dd>
        <dt>Date</dt><dd>${esc(fmtDate(d.issuedAt) || '')}</dd>
        <dt>Booking ref.</dt><dd>${esc(d.reference)}</dd></dl></div>
    </div>
    <table class="vi-lines">
      <thead><tr><th>Description</th><th>Amount</th></tr></thead>
      <tbody>
        <tr><td><b>${esc(siteLine)}</b><span>${esc(ev.name)}${ev.dateLabel ? ' &middot; ' + esc(ev.dateLabel) : ''}${d.siteLabel ? ' &middot; Site ' + esc(d.siteLabel) : ''}${d.categoryName ? ' &middot; ' + esc(d.categoryName) : ''}</span></td><td>${money(d.siteCents)}</td></tr>
        <tr><td><b>Booking fee</b><span>4% + $0.99</span></td><td>${money(d.feeCents)}</td></tr>
      </tbody>
      <tfoot>
        <tr><td>Subtotal (ex GST)</td><td>${money(subtotal)}</td></tr>
        <tr><td>GST (10%)</td><td>${money(d.gstCents)}</td></tr>
        <tr class="vi-grand"><td>Total ${d.free ? '' : 'paid '}(incl GST)</td><td>${money(d.totalCents)}</td></tr>
      </tfoot>
    </table>
    <div class="vi-paid">${d.free ? 'CONFIRMED' : 'PAID IN FULL'}</div>
    <div class="vi-thanks">
      <h2>Thank you!</h2>
      <p>Thank you for being part of <b>${esc(ev.name || 'Eatz & Beatz')}</b>. We&rsquo;re a small team passionate about bringing great food, live entertainment and local businesses together &mdash; and we&rsquo;re really glad to have <b>${esc(b.name)}</b> on board.</p>
      <p>The next page has everything you need for the night. Please read it, and the Vendor Terms &amp; Conditions that follow, before you arrive.</p>
      <p class="vi-sign">The SoundzGood team</p>
    </div>
  </section>`;
}

function pageEvent(d) {
  const ev = d.event;
  const where = [ev.venue, ev.location].filter(Boolean).join(', ');
  return `<section class="vi-page">
    ${letterhead(d, 'Event guide')}
    <h1 class="vi-h1">${esc(ev.name || 'Eatz & Beatz')}</h1>
    <p class="vi-sub">${esc(ev.dateLabel)}${where ? ' &middot; ' + esc(where) : ''}</p>
    <div class="vi-cards">
      ${KEY_TIMES.map(([k, t, n]) => `<div class="vi-card"><small>${esc(k)}</small><b>${esc(t)}</b><span>${esc(n)}</span></div>`).join('')}
    </div>
    <div class="vi-two">
      <div class="vi-box"><h3>Your booking</h3><dl>
        <dt>Business</dt><dd>${esc(d.business.name)}</dd>
        ${d.siteLabel ? `<dt>Site</dt><dd>${esc(d.siteLabel)}</dd>` : ''}
        ${d.categoryName ? `<dt>Category</dt><dd>${esc(d.categoryName)}</dd>` : ''}
        <dt>Reference</dt><dd>${esc(d.reference)}</dd></dl></div>
      <div class="vi-box"><h3>Where</h3><p><b>${esc(ev.venue || '')}</b><br>${esc(ev.location || '')}</p>
        <p class="vi-note">Follow directions from event staff for access, setup and departure.</p></div>
    </div>
    <div class="vi-two">
      <div class="vi-box"><h3>What to bring</h3><ul>${BRING.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
      <div class="vi-box vi-no"><h3>Please remember</h3><ul>${NOT_ALLOWED.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <p class="vi-note">Halloween dress-up is optional, but encouraged &mdash; best dressed stalls can win their vendor fee back!</p></div>
    </div>
    <p class="vi-foot">Questions? ${esc(d.seller.email)} &middot; ${esc(d.seller.phone)}</p>
  </section>`;
}

function pagesTerms(d) {
  const half = 10;   // clauses on the first terms page; the rest go on the next
  const clause = ([h, lines], i) =>
    `<div class="vi-clause"><h4>${i + 1}. ${esc(h)}</h4>${termBodyHtml(lines, esc)}</div>`;
  const a = VENDOR_TERMS.slice(0, half).map((c, i) => clause(c, i)).join('');
  const b = VENDOR_TERMS.slice(half).map((c, i) => clause(c, i + half)).join('');
  return `<section class="vi-page">
      ${letterhead(d, 'Vendor Terms & Conditions')}
      <div class="vi-intro">${VENDOR_TERMS_INTRO.map((t) => `<p>${esc(t)}</p>`).join('')}</div>
      <div class="vi-cols">${a}</div></section>
    <section class="vi-page">
      ${letterhead(d, 'Vendor Terms & Conditions')}
      <div class="vi-cols">${b}</div>
      <p class="vi-foot">Thank you for supporting Eatz &amp; Beatz &mdash; SoundzGood | Eatz &amp; Beatz Events</p></section>`;
}

function render(d) {
  document.title = 'Invoice ' + d.invoiceNumber + ' | SoundzGood Whitsundays';
  document.getElementById('vi-root').innerHTML = pageInvoice(d) + pageEvent(d) + pagesTerms(d);
}

async function load() {
  const root = document.getElementById('vi-root');
  const t = new URLSearchParams(location.search).get('t') || '';
  if (!t || !isFirebaseConfigured) { root.innerHTML = '<p class="vi-msg">That link is not valid.</p>'; return; }
  try {
    const [{ initializeApp }, functions] = await Promise.all([
      import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-functions.js`),
    ]);
    const fns = functions.getFunctions(initializeApp(firebaseConfig), functionsRegion);
    const res = await functions.httpsCallable(fns, 'getVendorInvoice')({ token: t });
    render(res.data);
  } catch (err) {
    root.innerHTML = '<p class="vi-msg">' + esc((err && err.message) || 'That link is not valid.') + '</p>';
  }
}

document.getElementById('vi-print').addEventListener('click', () => window.print());
load();
