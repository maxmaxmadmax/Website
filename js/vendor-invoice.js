/* ==========================================================================
   VENDOR INVOICE & EVENT GUIDE  -  /vendor-invoice?t=<token>   (Max, 19 Oct 2026)

   Flows exactly like the customer quote page (quote.html / quote-view.js) and
   reuses its look (quote-view.css: qp-hero, qp-sec, qv-doc ...):
     1  Hero      photo, event, thank-you, the key times as tiles
     2  Summary   "Your booking investment" table + what's included + invoice details
     3  Guide     what to bring / please remember
     4  Paper     the tax invoice (GST shown on its own)
     5  Terms     the full Vendor Terms & Conditions in one dropdown
     6  Paid      "Paid in full - thank you"
   Print / Save PDF uses the same A4 print rules as the quote.

   The key times and checklists are for Eatz & Beatz. For another event,
   change KEY_TIMES / BRING / NOT_ALLOWED below.
   Data comes from getVendorInvoice (the bookings collection stays closed).
   ========================================================================== */

import { termBodyHtml } from './terms-data.js?v=596';
import { VENDOR_TERMS, VENDOR_TERMS_INTRO } from './vendor-terms-data.js?v=596';
import { firebaseConfig, functionsRegion, isFirebaseConfigured } from './firebase-config.js?v=596';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

const money = (c) => '$' + (Math.round(c || 0) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtDate = (secs) => secs
  ? new Date(secs * 1000).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

const ICON = {
  Clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  Setup: '<path d="M3 15h18v3H3zM5 18v3M19 18v3M7 15V9h10v6"/>',
  Music: '<path d="M9 18V6l10-2v12M9 18a3 3 0 11-3-3 3 3 0 013 3zM19 16a3 3 0 11-3-3 3 3 0 013 3z"/>',
  Car: '<path d="M4 16V12l2-5h12l2 5v4M4 16h16M4 16v3M20 16v3M7 13h.01M17 13h.01"/>',
  Date: '<path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4"/>',
  Pin: '<path d="M12 21s-7-6.5-7-12a7 7 0 0114 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
};
const svgIcon = (k) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICON[k] || ICON.Clock) + '</svg>';

/*  The night in four tiles: [icon, label, note]. */
const KEY_TIMES = [
  ['Setup', 'Set up by 4:15 pm', 'Vehicles parked or removed'],
  ['Clock', 'Doors open 4:30 pm', 'Be trading and ready'],
  ['Music', 'Night wraps 9:30 pm', 'Live music until close'],
  ['Car', 'Vehicles move after 9:40 pm', 'Only when staff say the route is clear'],
];

/*  THE EVENT GUIDE, from the Vendor Terms (Max, 19 Oct 2026): six cards of
    [icon path, title, lines], then the hard rules for the night.        */
/*  WHAT TO BRING - Max's list, 19 Oct 2026 */
const BRING = [
  'Set up and vehicle parked by 4:15 pm',
  'Stay inside your own site',
  'Marquee must be secured',
  'Pegs 300 mm deep max',
  "Take all your waste home - please don't use our bins for commercial waste",
  'Help us promote the event',
  'Please follow instructions given by our event staff',
];

/*  ON THE NIGHT - the hard rules. */
const RULES = [
  ['No vehicles moving on site between 4:15 pm and 9:40 pm.', 'This keeps patrons safe - after 9:40 pm, move only when event staff say the route is clear.'],
  ['No music or speakers.', 'We are bringing the vibes.'],
  ['No alcohol sales or BYO.', 'Please support our licensed event bar.'],
  ['Nothing in public bins or drains.', 'Leave it better than when we started.'],
];

/*  THE SITE MAP: every site in light grey, the landmarks (stage, bar ...) for
    orientation, and this vendor's own site(s) in orange with "YOUR SITE".
    Plain SVG with inline colours so it prints and needs no extra CSS.     */
function siteMap(d) {
  const m = d.map;
  if (!m || !m.sites || !m.sites.length || !m.mine || !m.mine.length) return '';
  const w = (m.mapSize && m.mapSize.width) || 760, h = (m.mapSize && m.mapSize.height) || 1420;
  const mine = new Set(m.mine);
  const lm = (m.landmarks || []).filter((k) => k.kind !== 'entry').map((k) =>
    '<g><rect x="' + k.x + '" y="' + k.y + '" width="' + k.w + '" height="' + k.h + '" rx="' + (k.kind === 'barrier' ? 2 : 8) + '" fill="#e9e9ec" stroke="#cfcfd4"/>'
    + (k.label ? '<text x="' + (k.x + k.w / 2) + '" y="' + (k.y + k.h / 2 + 6) + '" text-anchor="middle" font-size="18" font-weight="700" fill="#777" font-family="Arial">' + esc(k.label) + '</text>' : '') + '</g>').join('');
  const sites = m.sites.map((s) => {
    const own = mine.has(s.id);
    const tf = s.rotate ? ' transform="rotate(' + s.rotate + ' ' + (s.x + s.w / 2) + ' ' + (s.y + s.h / 2) + ')"' : '';
    return '<g' + tf + '><rect x="' + s.x + '" y="' + s.y + '" width="' + s.w + '" height="' + s.h + '" rx="6" fill="' + (own ? '#ff6b00' : '#f4f4f5') + '" stroke="' + (own ? '#b24a00' : '#cfcfd4') + '" stroke-width="' + (own ? 3 : 1.5) + '"/>'
      + '<text x="' + (s.x + s.w / 2) + '" y="' + (s.y + s.h / 2 + 5) + '" text-anchor="middle" font-size="' + (own ? 22 : 17) + '" font-weight="' + (own ? 800 : 600) + '" fill="' + (own ? '#fff' : '#9a9aa2') + '" font-family="Arial">' + esc(s.label) + '</text></g>';
  }).join('');
  const names = m.sites.filter((s) => mine.has(s.id)).map((s) => s.label).join(' + ');
  return '<div class="qp-map"><p class="qp-mini">Where you are</p>'
    + '<p class="qp-sub" style="margin:0 0 10px">Your site: <strong>' + esc(names) + '</strong> &mdash; highlighted in orange on the plan.</p>'
    + '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Site map, your site ' + esc(names) + ' highlighted" style="display:block;width:100%;max-width:280px;height:auto;margin:0 auto;border:1px solid #e3e3e6;border-radius:10px;background:#fff">'
    + lm + sites + '</svg></div>';
}

/*  The event's own poster: the picture set on the event in admin, else the
    poster we hold for it (same list as the vendor page).                  */
const EVENT_POSTERS = [
  { match: (ev) => /eatz/i.test(ev.name || '') && String(ev.dateISO || '').startsWith('2026-10-31'),
    url: '/images/events/eatz-beatz-halloween-2026-v3.webp' },
];
function posterOf(ev) {
  if (ev.image) return ev.image;
  const p = EVENT_POSTERS.find((x) => x.match(ev));
  return p ? p.url : '';
}

/*  What this vendor uploaded when they booked (insurance, licences ...). */
function documentsHtml(d) {
  const docs = d.documents || [];
  if (!docs.length) return '';
  const row = (x) => '<a href="' + esc(x.url) + '" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid #e3e3e6;border-radius:8px;background:#fff;text-decoration:none;color:#1a1a1a">'
    + '<span aria-hidden="true" style="font-size:20px">&#128196;</span>'
    + '<span style="flex:1;min-width:0"><b style="display:block;word-break:break-word">' + esc(x.name) + '</b>'
    + (x.type ? '<span style="font-size:12.5px;color:#777">' + esc(x.type) + '</span>' : '') + '</span>'
    + '<span style="color:#ff6b00;font-weight:700;font-size:13px">Open &rarr;</span></a>';
  return '<div class="qp-docs" style="margin-top:22px;padding:16px 18px;border:1px solid #ddd;border-radius:12px;background:#fafafa">'
    + '<p class="qp-mini" style="margin-top:0">Your documents on file</p>'
    + '<div style="display:grid;gap:8px">' + docs.map(row).join('') + '</div></div>';
}

/*  HELP US SPREAD THE WORD: the event page for their own followers and the
    vendor page for other vendors. Change these for another event.        */
const SHARE_EVENT = {
  url: 'https://www.soundzgood.com.au/eatz-beatz-halloween-2026',
  // {biz} and {site} are filled in, so the post says where to find them
  text: 'Come and find {biz}{site} at Eatz & Beatz Halloween Edition! Sat 31 Oct, 4:30-9:30pm at Bowen Sports Complex. Free entry - food, markets, live music and a licensed bar.',
};
const SHARE_VENDORS = {
  url: 'https://www.soundzgood.com.au/vendor-signup',
  text: "We're trading at Eatz & Beatz Halloween Edition in Bowen on Sat 31 Oct - you should grab a stall too! Book your site here:",
};
/*  Printables for their stall: the poster and the A4 program. */
const POSTER_URL = '/images/events/eatz-beatz-halloween-2026-v3.webp';
const PROGRAM_URL = '/eatz-beatz-halloween-2026?print=1';

const INSTAGRAM_URL = 'https://www.instagram.com/soundzgood_events/';

const shortUrl = (u) => u.replace('https://', '').replace('www.', '');
function shareText(s, d) {
  return s.text.replace('{biz}', (d && d.business.name) || 'us')
    .replace('{site}', d && d.siteLabel ? ' (site ' + d.siteLabel + ')' : '');
}

function shareHtml(d) {
  // simple: a title, one short line, the button(s). The link prints instead of the buttons.
  const card = (title, note, link, btns) => '<div class="vi-share-card"><p class="qp-mini">' + title + '</p>'
    + '<p class="vi-share-note">' + note + '</p>'
    + '<p class="vi-share-link">' + esc(link) + '</p>'
    + '<div class="vi-share-btns">' + btns + '</div></div>';
  const btn = (key, label) => '<button type="button" class="qv-btn qv-btn-primary" data-share="' + key + '">' + label + '</button>';
  const site = d && d.siteLabel ? ' at site ' + esc(d.siteLabel) : '';
  return '<section class="qp-sec qp-share"><p class="qp-eyebrow">Help us fill the grounds</p>'
    + '<h2 class="qp-h2">Bring your crowd</h2>'
    + '<p class="qp-sub">A bigger crowd means more sales for every stall.</p>'
    + '<div class="vi-share-grid">'
    + card('Tell your customers', 'Share the event so they can find you' + site + '.', shortUrl(SHARE_EVENT.url), btn('event', 'Share the event'))
    + card('Share the promo', 'Post the poster and program, or print them for your stall.', 'Poster &middot; A4 program',
      '<a class="qv-btn qv-btn-primary" href="' + POSTER_URL + '" download="Eatz-and-Beatz-poster.webp" target="_blank" rel="noopener">Poster</a>'
      + '<a class="qv-btn qv-btn-ghost" style="color:#111;border-color:#111;background:#fff" href="' + PROGRAM_URL + '" target="_blank" rel="noopener">A4 program</a>')
    + card('Invite a vendor', 'Know a business that would love a spot? Send them the link.', shortUrl(SHARE_VENDORS.url), btn('vendors', 'Share with a vendor'))
    + '</div>'
    + '<div class="vi-ig"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1"/></svg>'
      + '<p><b>@soundzgood_events</b> &mdash; follow for event updates and what&rsquo;s coming up.</p>'
      + '<a class="qv-btn qv-btn-primary" href="' + INSTAGRAM_URL + '" target="_blank" rel="noopener">Follow us</a></div>'
    + '<p class="qv-msg" id="vi-share-msg" hidden></p></section>';
}

function wireShare(d) {
  document.querySelectorAll('[data-share]').forEach((btn) => btn.addEventListener('click', async () => {
    const s = btn.getAttribute('data-share') === 'vendors' ? SHARE_VENDORS : SHARE_EVENT;
    const text = shareText(s, d);
    const msg = document.getElementById('vi-share-msg');
    try {
      if (navigator.share) { await navigator.share({ title: 'Eatz & Beatz', text, url: s.url }); return; }
      await navigator.clipboard.writeText(text + ' ' + s.url);
      if (msg) { msg.hidden = false; msg.textContent = 'Copied - paste it into a post or message.'; }
    } catch (e) { if (e && e.name !== 'AbortError') window.prompt('Copy this to share:', text + ' ' + s.url); }
  }));
}

function top(d) {
  const ev = d.event;
  const where = [ev.venue, ev.location].filter(Boolean).join(', ');
  const b = d.business;
  const tiles = KEY_TIMES.map(([ic, t, n]) =>
    '<div class="qp-tile">' + svgIcon(ic) + '<b>' + esc(t) + '</b><span>' + esc(n) + '</span></div>').join('');

  const sub = d.siteCents, fee = d.feeCents;
  const r = (label, ex) => '<tr><td>' + esc(label) + '</td><td>' + money(ex) + '</td><td>' + money(Math.round(ex * 0.1)) + '</td><td>' + money(Math.round(ex * 1.1)) + '</td></tr>';
  const siteLabel = d.vendorType === 'food' ? 'Food vendor site' : 'Market stall site' + (d.bayCount > 1 ? ' (' + d.bayCount + ' bays)' : '');

  const included = [
    esc(siteLabel) + (d.siteLabel ? ' &mdash; site ' + esc(d.siteLabel) : '') + (d.categoryName ? ' &middot; ' + esc(d.categoryName) : ''),
    esc(ev.venue || 'The event venue') + (ev.dateLabel ? ' &middot; ' + esc(ev.dateLabel) : ''),
  ];

  return `
    <section class="qp-hero">
      <div class="qp-hero-photo" style="--qp-photo:none;background:linear-gradient(180deg,#ff6b00 0%,#d95a00 55%,#0b0b0b 100%)">
        <div class="qp-hero-in" style="max-width:none;width:100%;display:flex;flex-wrap:wrap;gap:30px;align-items:center">
          ${posterOf(ev) ? '<img src="' + esc(posterOf(ev)) + '" alt="' + esc(ev.name) + ' poster" style="flex:0 0 auto;width:min(100%,270px);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5)">' : ''}
          <div style="flex:1 1 300px;max-width:680px">
            <p class="qp-eyebrow" style="color:#fff">Vendor invoice &amp; event guide</p>
            <h1>${esc(ev.name || 'Eatz & Beatz')}</h1>
            <p class="qp-when">${ev.dateLabel ? svgIcon('Date') + esc(ev.dateLabel) : ''}${where ? '<br>' + svgIcon('Pin') + esc(where) : ''}</p>
          </div>
        </div>
      </div>
      <div class="qp-hero-body">
        <p class="qp-intro">Thank you for being part of ${esc(ev.name || 'Eatz & Beatz')}. We&rsquo;re a small team passionate about
          bringing great food, live entertainment and local businesses together &mdash; and we&rsquo;re really glad to have
          ${esc(b.name)} on board. Everything below is your tax invoice and what you need to know for the night.</p>
        <div class="qp-tiles">${tiles}</div>
        <p class="qp-ref">Invoice ${esc(d.invoiceNumber)} &middot; Prepared for ${esc(b.name)}</p>
      </div>
    </section>

    <section class="qp-sec qp-invest">
      <p class="qp-eyebrow">Investment summary</p>
      <h2 class="qp-h2">Your booking investment</h2>
      <p class="qp-sub">Total inclusive of GST for ${esc(ev.name || 'the event')}${ev.dateLabel ? ' on ' + esc(ev.dateLabel) : ''}.</p>
      <table class="qp-inv">
        <thead><tr><th>Description</th><th>Ex GST</th><th>GST (10%)</th><th>Inc GST</th></tr></thead>
        <tbody>${r(siteLabel, sub)}${r('Booking fee', fee)}</tbody>
        <tfoot><tr><td>Total ${d.free ? '' : 'paid '}inc. GST</td><td></td><td></td><td>${money(d.totalCents)}</td></tr></tfoot>
      </table>
      <div class="qp-inv-extra">
        <div class="qp-incl"><p class="qp-mini">What&rsquo;s included</p><ul>${included.map((t) => '<li>' + t + '</li>').join('')}</ul></div>
        <div class="qp-qd"><p class="qp-mini">Invoice details</p><dl>
          <div><dt>Invoice</dt><dd>${esc(d.invoiceNumber)}</dd></div>
          ${d.issuedAt ? '<div><dt>Issued</dt><dd>' + esc(fmtDate(d.issuedAt)) + '</dd></div>' : ''}
          <div><dt>Booking ref.</dt><dd>${esc(d.reference)}</dd></div>
          <div><dt>Status</dt><dd>${d.free ? 'Confirmed' : 'Paid in full'}</dd></div>
        </dl></div>
      </div>
    </section>
`;
}

function guide(d) {
  const bring = BRING.map((t) => '<li>' + esc(t) + '</li>').join('');
  const rules = RULES.map(([t, n]) => '<li><span class="vi-x" aria-hidden="true">&#10005;</span><span><b>' + esc(t) + '</b> ' + esc(n) + '</span></li>').join('');
  return `
    <section class="qp-sec qp-guide">
      <p class="qp-eyebrow">Event guide</p>
      <h2 class="qp-h2">What you need to know</h2>
      <div class="vi-guide-grid">
        <div>
          <p class="qp-mini">What to bring</p>
          <div class="qp-incl"><ul>${bring}</ul></div>
          <p class="qp-mini" style="margin-top:24px">On the night</p>
          <ul class="vi-rules">${rules}</ul>
          <div class="vi-dress"><span aria-hidden="true">&#127875;</span><p><b>Win your vendor fee back!</b> Dress up and deck out your stall for Halloween - the best dressed stall gets their fee refunded.</p></div>
          ${documentsHtml(d)}
        </div>
        <div>${siteMap(d)}</div>
      </div>
      <p class="qp-sub vi-guide-foot" style="margin-top:22px">Follow directions from event staff for access, setup and departure. Questions? ${esc(d.seller.email)} &middot; ${esc(d.seller.phone)}</p>
    </section>`;
}

function paper(d) {
  const s = d.seller;
  const b = d.business;
  const ev = d.event;
  const subtotal = d.siteCents + d.feeCents;
  const siteLine = d.vendorType === 'food' ? 'Food vendor site' : 'Market stall site' + (d.bayCount > 1 ? ' - ' + d.bayCount + ' bays' : '');
  return `
    <h2 class="qp-h2 qp-h2-doc">Tax invoice</h2>
    <div class="qv-doc" id="qv-doc">
      <div class="qv-banner qv-ok">${d.free ? 'Confirmed &mdash; thank you!' : 'Paid in full &mdash; thank you!'}</div>
      <div class="qv-top">
        <div class="qv-brand">
          <img src="/images/logo-quote.png" alt="SoundzGood Whitsundays" class="qv-logo">
          <p class="qv-legal">${esc(s.legal)}${s.legal ? '<br>' : ''}${s.abn ? 'ABN ' + esc(s.abn) : ''}</p>
        </div>
        <div class="qv-meta">
          <h1>Tax invoice</h1>
          <p class="qv-ref">${esc(d.invoiceNumber)}</p>
          <p class="qv-date">${esc(fmtDate(d.issuedAt))}</p>
        </div>
      </div>

      <div class="qv-parties">
        <div><h3>From</h3><p><strong>${esc(s.name)}</strong><br>${esc(s.address)}<br>${esc(s.phone)}<br>${esc(s.email)}<br>${esc(s.site)}</p></div>
        <div><h3>Bill to</h3><p><strong>${esc(b.name)}</strong><br>${b.contactName ? esc(b.contactName) + '<br>' : ''}${b.email ? esc(b.email) + '<br>' : ''}${b.phone ? esc(b.phone) : ''}</p></div>
        <div><h3>Event</h3><p><strong>${esc(ev.name)}</strong><br>${esc(ev.dateLabel)}<br>${esc(ev.venue)}${d.siteLabel ? '<br>Site ' + esc(d.siteLabel) : ''}<br>Ref ${esc(d.reference)}</p></div>
      </div>

      <table class="qv-table">
        <thead><tr><th>Description</th><th class="qv-num">Qty</th><th class="qv-num">Amount</th></tr></thead>
        <tbody>
          <tr><td class="qv-desc">${esc(siteLine)}<span class="qv-sub">${esc(ev.name)}${d.siteLabel ? ' &middot; site ' + esc(d.siteLabel) : ''}${d.categoryName ? ' &middot; ' + esc(d.categoryName) : ''}</span></td><td class="qv-num">1</td><td class="qv-num">${money(d.siteCents)}</td></tr>
          <tr><td class="qv-desc">Booking fee<span class="qv-sub">4% + $0.99</span></td><td class="qv-num">1</td><td class="qv-num">${money(d.feeCents)}</td></tr>
        </tbody>
      </table>

      <div class="qv-sumwrap">
        <div class="qv-breakdown"></div>
        <div class="qv-summary">
          <div class="qv-sumrow qv-sumtotal"><span>Subtotal (ex GST)</span><span>${money(subtotal)}</span></div>
          <div class="qv-sumrow"><span>GST (10%)</span><span>${money(d.gstCents)}</span></div>
          <div class="qv-sumrow qv-grand"><span>Total ${d.free ? '' : 'paid '}(incl GST)</span><span>${money(d.totalCents)}</span></div>
        </div>
      </div>

      <p class="qv-foot">${esc(s.name)}${s.legal ? ' &middot; ' + esc(s.legal) : ''}${s.abn ? ' &middot; ABN ' + esc(s.abn) : ''}</p>
    </div>

    <div class="qv-actions" id="qv-actions">
      <button type="button" class="qv-btn qv-btn-ghost" id="qv-print">Download / Print PDF</button>
    </div>`;
}

function bottom(d) {
  const terms = '<details class="qp-term qp-legal"><summary><span class="qp-legal-warn">&#9888;</span><span><b>Vendor Terms &amp; Conditions</b><em>'
    + VENDOR_TERMS.length + ' clauses &middot; you agreed to these when you booked &middot; tap to read</em></span></summary>'
    + '<div class="qp-legal-body">' + VENDOR_TERMS_INTRO.map((t) => '<p>' + esc(t) + '</p>').join('')
    + VENDOR_TERMS.map(([h, lines], i) => '<div class="qp-legal-clause"><h4>' + (i + 1) + '. ' + esc(h) + '</h4>' + termBodyHtml(lines, esc) + '</div>').join('')
    + '</div></details>';
  return `
    <section class="qp-sec qp-terms">${terms}</section>`;
}

function render(d) {
  document.title = 'Invoice ' + d.invoiceNumber + ' | SoundzGood Whitsundays';
  document.getElementById('quote-root').innerHTML = top(d) + paper(d) + guide(d) + shareHtml(d) + bottom(d);
  // printing / PDF: show the whole terms, not just the open one
  window.addEventListener('beforeprint', () => document.querySelectorAll('.qp-term').forEach((x) => { x.open = true; }));
  wireShare(d);
  const print = document.getElementById('qv-print');
  if (print) print.addEventListener('click', () => window.print());
}

function fail(text) {
  document.getElementById('quote-root').innerHTML =
    `<div class="qv-empty"><h1>${esc(text)}</h1><p>If you think this is a mistake, please <a href="/contact">get in touch</a>.</p></div>`;
}

async function load() {
  const t = new URLSearchParams(location.search).get('t') || '';
  if (!t) return fail('No invoice in this link.');
  if (!isFirebaseConfigured) return fail('This link cannot be opened right now.');
  try {
    const [{ initializeApp }, functions] = await Promise.all([
      import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-functions.js`),
    ]);
    const fns = functions.getFunctions(initializeApp(firebaseConfig), functionsRegion);
    const res = await functions.httpsCallable(fns, 'getVendorInvoice')({ token: t });
    render(res.data);
  } catch (err) {
    fail('This link is not valid or has expired.');
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
else load();
