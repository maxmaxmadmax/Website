/* ==========================================================================
   YOUR DETAILS  -  /details?t=<detailsToken>   (Max, 20 Oct 2026)

   Max texts a customer this link from their quote. They fill in their own
   details; it lands straight on the quote and in Customers, and Max gets an
   email. If the quote is already out, they get a "View your quote" button.
   Data: getDetailsForm / submitDetails (functions/index.js).
   Uses the sponsor page styles (sponsor.css).
   ========================================================================== */

import { firebaseConfig, functionsRegion, isFirebaseConfigured } from './firebase-config.js?v=602';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const TOKEN = new URLSearchParams(location.search).get('t') || '';
let fns = null;

/*  "Tue 20 Oct 2026" <-> "2026-10-20" (the quote keeps the friendly form). */
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function isoFromPretty(text) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(text || ''))) return text;
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(String(text || ''));
  if (!m || MON.indexOf(m[2].toLowerCase()) < 0) return '';
  return m[3] + '-' + String(MON.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
}
function prettyFromIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(/,/g, '');
}

function done(quoteLink) {
  document.getElementById('dt-root').innerHTML = `<section class="spn-sec spn-thanks-big">
    <h2>Thank you!</h2>
    ${quoteLink
      ? `<p>Your details are in. Your quote is ready to look at:</p><p><a class="spn-btn" href="${esc(quoteLink)}">View your quote &rarr;</a></p>`
      : '<p>Your details are in &mdash; Max will send your quote shortly.</p>'}
    <p class="spn-sub">Questions? Call Max on 0422 393 022.</p></section>`;
}

function render(d) {
  const c = d.customer || {};
  const date = isoFromPretty(c.eventDate) || d.startDate || '';
  const f = (name, label, val, type, req, wide, ph) => `<label class="${wide ? 'spn-wide' : ''}">${label}${req ? '' : ' <span>(optional)</span>'}
    <input name="${name}" type="${type || 'text'}" value="${esc(val || '')}"${req ? ' required' : ''}${ph ? ' placeholder="' + esc(ph) + '"' : ''}></label>`;
  document.getElementById('dt-root').innerHTML = `
  <section class="spn-sec">
    <p class="spn-eyebrow" style="color:#ff6b00">SoundzGood Whitsundays</p>
    <h2>Your details</h2>
    <p class="spn-sub">${d.received ? 'Thanks &mdash; we have your details. Change anything below and press Save.' : 'Takes a minute. Pop your details in and we&rsquo;ll send your quote.'}</p>
    <form class="spn-form" id="dt-form">
      ${f('name', 'Your name', c.name, 'text', true)}
      ${f('business', 'Business / organisation', c.business, 'text', false)}
      ${f('email', 'Email', c.email, 'email', true)}
      ${f('phone', 'Phone', c.phone, 'tel', true)}
      ${f('ccEmail', 'Accounts / billing email', c.ccEmail, 'text', false, true, 'Gets a copy of the quote and invoice')}
      ${f('address', 'Address', c.address, 'text', false, true)}
      ${f('eventName', 'Event name', c.eventName, 'text', false)}
      <label>Event date <span>(optional)</span><input name="eventDate" type="date" value="${esc(date)}"></label>
      ${f('eventVenue', 'Venue', c.eventVenue, 'text', false, true, 'Where is it on?')}
      <button type="submit" class="spn-btn">${d.received ? 'Save my details' : 'Send my details'}</button>
      <p class="spn-msg" id="dt-msg" hidden></p>
    </form>
  </section>`;
  document.getElementById('dt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const v = (n) => (form.querySelector('[name="' + n + '"]') || {}).value || '';
    const btn = form.querySelector('button[type="submit"]');
    const msg = document.getElementById('dt-msg');
    btn.disabled = true;
    try {
      const res = await fns.httpsCallable(fns.fns, 'submitDetails')({
        token: TOKEN, name: v('name'), business: v('business'), email: v('email'), phone: v('phone'),
        ccEmail: v('ccEmail'), address: v('address'), eventName: v('eventName'),
        eventDate: prettyFromIso(v('eventDate')), eventVenue: v('eventVenue'),
      });
      done(res.data && res.data.quoteLink);
    } catch (err) {
      btn.disabled = false;
      msg.hidden = false;
      msg.textContent = (err && err.message) || 'Could not send. Please try again.';
    }
  });
}

async function load() {
  const root = document.getElementById('dt-root');
  if (!TOKEN || !isFirebaseConfigured) { root.innerHTML = '<p class="spn-loading">That link is not valid.</p>'; return; }
  try {
    const [{ initializeApp }, functions] = await Promise.all([
      import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-functions.js`),
    ]);
    fns = { fns: functions.getFunctions(initializeApp(firebaseConfig), functionsRegion), httpsCallable: functions.httpsCallable };
    const res = await fns.httpsCallable(fns.fns, 'getDetailsForm')({ token: TOKEN });
    render(res.data);
  } catch (err) {
    root.innerHTML = '<p class="spn-loading">Sorry - that link is not valid. Please call Max on 0422 393 022.</p>';
  }
}

load();
