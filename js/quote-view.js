/* ==========================================================================
   QUOTE / INVOICE  -  the public document page (/quote?t=<token>)

   Fetches one quote by its secret token through the getQuote function (the
   collection itself is closed to browsers), renders it as a traditional
   quote or tax invoice, and lets the customer Accept a quote or print/save
   it as a PDF. Prices are ex-GST; GST is shown at 10%.
   ========================================================================== */

import { firebaseConfig, functionsRegion, isFirebaseConfigured } from './firebase-config.js?v=136';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

const SELLER = {
  name: 'SoundzGood Whitsundays',
  legal: 'a trading name of Bindi Co Pty Ltd',
  abn: '49 700 595 348',
  email: 'info@soundzgood.com.au',
  phone: '0422 393 022',
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
  };
}

function lineAmount(l, days) {
  if (l.type === 'discount') return -Math.max(0, Math.round(l.amountCents || 0));
  const qty = Math.max(0, Math.round(l.qty || 0));
  const unit = Math.max(0, Math.round(l.unitCents || 0));
  const multi = (l.type === 'item' || l.type === 'kit');
  const per = multi ? unit + Math.max(0, Math.round(l.extraDayCents || 0)) * Math.max(0, Math.round(l.days || days) - 1) : unit;
  return qty * per;
}

function fmtDate(secs) {
  if (!secs) return '';
  return new Date(secs * 1000).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function render(q) {
  const isInvoice = q.kind === 'invoice';
  const docTitle = isInvoice ? 'Tax Invoice' : 'Quote';
  const ref = isInvoice ? (q.invoiceNumber || q.number) : q.number;
  const c = q.customer || {};
  const days = Math.max(1, Math.round((q.hire && q.hire.days) || 1));
  const multiDay = days > 1;

  const rows = (q.lines || []).map((l) => {
    const amt = lineAmount(l, days);
    const isDisc = l.type === 'discount';
    const perNote = (l.type === 'item' || l.type === 'kit') && multiDay
      ? `<span class="qv-perday">${money(l.unitCents)}/day${l.extraDayCents ? ' + ' + money(l.extraDayCents) + ' extra day' : ''}</span>` : '';
    return `
      <tr${isDisc ? ' class="qv-row-disc"' : ''}>
        <td class="qv-desc">${esc(l.name || '')}${l.description ? `<span class="qv-sub">${esc(l.description)}</span>` : ''}${perNote}</td>
        <td class="qv-num">${isDisc ? '' : esc(l.qty)}</td>
        <td class="qv-num">${isDisc ? '' : money(l.unitCents)}</td>
        <td class="qv-num">${money(amt)}</td>
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

  document.getElementById('quote-root').innerHTML = `
    <div class="qv-doc" id="qv-doc">
      ${banner}
      <div class="qv-top">
        <div class="qv-brand">
          <img src="/images/logowhite.png" alt="SoundzGood" class="qv-logo">
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
          <p><strong>${esc(SELLER.name)}</strong><br>${esc(SELLER.phone)}<br>${esc(SELLER.email)}<br>${esc(SELLER.site)}</p>
        </div>
        <div>
          <h3>${isInvoice ? 'Bill to' : 'Prepared for'}</h3>
          <p>${c.name ? '<strong>' + esc(c.name) + '</strong><br>' : ''}${c.business ? esc(c.business) + '<br>' : ''}${c.email ? esc(c.email) + '<br>' : ''}${c.phone ? esc(c.phone) + '<br>' : ''}${c.address ? esc(c.address) : ''}</p>
        </div>
        <div>
          <h3>Job</h3>
          <p>${c.eventName ? '<strong>' + esc(c.eventName) + '</strong><br>' : ''}${c.eventDate ? esc(c.eventDate) + '<br>' : ''}${(q.hire && (q.hire.startDate || q.hire.endDate)) ? esc([q.hire.startDate, q.hire.endDate].filter(Boolean).join(' &ndash; ')) + '<br>' : ''}${days > 1 ? days + ' days charged' : ''}</p>
        </div>
      </div>

      <table class="qv-table">
        <thead><tr><th>Description</th><th class="qv-num">Qty</th><th class="qv-num">Unit</th><th class="qv-num">Amount</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="qv-sub">No items.</td></tr>'}</tbody>
      </table>

      <div class="qv-summary">
        <div class="qv-sumrow"><span>Subtotal (ex GST)</span><span>${money(q.subtotalCents)}</span></div>
        ${q.discountCents ? `<div class="qv-sumrow"><span>Discount</span><span>&minus;${money(q.discountCents)}</span></div>` : ''}
        <div class="qv-sumrow"><span>GST (10%)</span><span>${money(q.gstCents)}</span></div>
        <div class="qv-sumrow qv-grand"><span>Total (incl GST)</span><span>${money(q.totalCents)}</span></div>
      </div>

      ${accountBox}
      ${q.notes ? `<div class="qv-notes"><h3>Notes</h3><p>${esc(q.notes)}</p></div>` : ''}
      ${q.terms ? `<div class="qv-notes"><h3>Terms</h3><p>${esc(q.terms)}</p></div>` : ''}

      <p class="qv-foot">${esc(SELLER.name)} &middot; ${esc(SELLER.legal)} &middot; ABN ${esc(SELLER.abn)}</p>
    </div>

    <div class="qv-actions" id="qv-actions">
      <button type="button" class="qv-btn qv-btn-ghost" id="qv-print">Download / Print PDF</button>
      ${canAccept ? '<button type="button" class="qv-btn qv-btn-primary" id="qv-accept">Accept this quote</button>' : ''}
      <p class="qv-msg" id="qv-msg" hidden></p>
    </div>`;

  const print = document.getElementById('qv-print');
  if (print) print.addEventListener('click', () => window.print());

  const accept = document.getElementById('qv-accept');
  if (accept) accept.addEventListener('click', () => acceptFlow(accept));
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
