/* ==========================================================================
   YOUR DETAILS  -  /details?t=<detailsToken>

   A customer fills in their own details from a link on their quote. It
   saves to the quote and Customers, and Max gets an email. If the quote is
   already out, they get a "View your quote" button.
   Data: getDetailsForm / submitDetails (functions/index.js).
   Uses the sponsor page styles (sponsor.css).
   ========================================================================== */

import { firebaseConfig, functionsRegion, isFirebaseConfigured } from './firebase-config.js?v=745';

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

function done(quoteLink, autoSent) {
  document.getElementById('dt-root').innerHTML = `<section class="spn-sec spn-thanks-big">
    <h2>Thank you!</h2>
    ${autoSent ? '<p>Your quote has been emailed to you. You can also view it now:</p>' : ''}
    ${quoteLink
      ? (autoSent ? '' : '<p>Your details are in. Your quote is ready to look at:</p>') + `<p><a class="spn-btn" href="${esc(quoteLink)}">View your quote &rarr;</a></p>`
      : '<p>We&rsquo;ve received your details. Your quote will be emailed to you shortly.</p>'}
    <p class="spn-sub">Questions? Call Max on 0422 393 022.</p></section>`;
}

/*  Start-time choices every 30 minutes, 6:00am to 11:30pm. */
function timeOptions(current) {
  let out = '<option value="">Choose a time</option>';
  for (let m = 6 * 60; m < 24 * 60; m += 30) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    const h = Math.floor(m / 60);
    const label = (h % 12 || 12) + ':' + String(m % 60).padStart(2, '0') + (h < 12 ? 'am' : 'pm');
    out += '<option value="' + hh + '"' + (hh === current ? ' selected' : '') + '>' + label + '</option>';
  }
  return out;
}

function render(d) {
  const c = d.customer || {};
  const date = isoFromPretty(c.eventDate) || d.startDate || '';
  // first / last name boxes - the quote still keeps one "name"
  const nameParts = String(c.name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ');
  const f = (name, label, val, type, req, wide, ph) => `<label class="${wide ? 'spn-wide' : ''}">${label}${req ? ' <b class="dt-req">*</b>' : ' <span>(optional)</span>'}
    <input name="${name}" type="${type || 'text'}" value="${esc(val || '')}"${req ? ' required' : ''}${ph ? ' placeholder="' + esc(ph) + '"' : ''}></label>`;
  document.getElementById('dt-root').innerHTML = `
  <section class="spn-sec">
    <p class="spn-eyebrow" style="color:#ff6b00">SoundzGood Whitsundays</p>
    <h2>Your quote is ready for review</h2>
    <p class="spn-sub">${d.received ? 'Thank you &mdash; we have your details. If anything has changed, update it below and press Save.' : 'Add your details below to view your quote.'}</p>
    <p class="dt-note"><b class="dt-req">*</b> Required</p>
    <form class="spn-form" id="dt-form">
      ${f('firstName', 'First name', firstName, 'text', true)}
      ${f('lastName', 'Last name', lastName, 'text', true)}
      <label class="spn-wide">Business / organisation <span>(optional)</span>
        <button type="button" class="dt-info" id="dt-info-biz" aria-label="What is this?" aria-expanded="false">i</button>
        <small class="dt-info-text" id="dt-info-biz-text" hidden>This is who the quote and invoice will be made out to. Leave it blank to have them in your own name.</small>
        <input name="business" type="text" value="${esc(c.business || '')}"></label>
      ${f('email', 'Email', c.email, 'email', true, false, 'Your email')}
      ${f('phone', 'Phone', c.phone, 'tel', true, false, 'Your phone')}
      ${f('dayContact', 'Event day contact', c.dayContact, 'text', false, true, 'Name and phone of who we deal with on the day')}
      ${f('ccEmail', 'Accounts / billing email', c.ccEmail, 'text', false, true, 'Gets a copy of the quote and invoice')}
      ${f('address', 'Your address', c.address, 'text', false, true, 'For the invoice')}
      ${f('eventName', 'Event name', c.eventName, 'text', true)}
      <label>Event date <span>(optional)</span><input name="eventDate" type="date" value="${esc(date)}"></label>
      <label>Event start time <b class="dt-req">*</b><select name="eventStartTime" required>${timeOptions(c.eventStartTime)}</select>
        <small class="dt-help">We&rsquo;ll schedule our arrival and set-up around this.</small></label>
      ${f('eventVenue', 'Venue name &amp; address', c.eventVenue, 'text', true, false)}
      <label class="spn-wide">Anything we should know? <span>(optional)</span>
        <textarea name="customerNotes" rows="4" placeholder="Access, parking, power, timings, special requests&hellip;">${esc(c.customerNotes || '')}</textarea></label>
      <button type="submit" class="spn-btn">${d.received ? 'Save my details' : (d.quoteLink || d.autoSend ? 'View my quote' : 'Send my details')}</button>
      <p class="spn-msg" id="dt-msg" hidden></p>
    </form>
  </section>`;
  /*  The button stays greyed out until full name, email, phone and event
      name are filled in. */
  const dtForm = document.getElementById('dt-form');
  const dtBtn = dtForm.querySelector('button[type="submit"]');
  // what is still missing, in plain words (empty list = good to go)
  const missing = () => {
    const val = (n) => String((dtForm.querySelector('[name="' + n + '"]') || {}).value || '').trim();
    const out = [];
    if (!val('firstName')) out.push('your first name');
    if (!val('lastName')) out.push('your last name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val('email'))) out.push('your email');
    if (val('phone').replace(/[^0-9]/g, '').length < 8) out.push('your phone number');
    if (!val('eventName')) out.push('the event name');
    if (!val('eventStartTime')) out.push('the event start time');
    if (!val('eventVenue')) out.push('the venue');
    return out;
  };
  const filled = () => missing().length === 0;
  const infoBtn = document.getElementById('dt-info-biz');
  infoBtn.addEventListener('click', (e) => {
    e.preventDefault();   // inside a label - don't jump into the box
    const note = document.getElementById('dt-info-biz-text');
    note.hidden = !note.hidden;
    infoBtn.setAttribute('aria-expanded', String(!note.hidden));
  });
  const check = () => {
    const m = missing();
    dtBtn.disabled = m.length > 0;
  };
  dtForm.addEventListener('input', check);
  dtForm.addEventListener('change', check);   // autofill sometimes only fires "change"
  check();
  dtForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const v = (n) => (form.querySelector('[name="' + n + '"]') || {}).value || '';
    const btn = form.querySelector('button[type="submit"]');
    const msg = document.getElementById('dt-msg');
    if (!filled()) return;
    btn.disabled = true;
    try {
      const res = await fns.httpsCallable(fns.fns, 'submitDetails')({
        token: TOKEN, name: (v('firstName').trim() + ' ' + v('lastName').trim()).trim(), business: v('business'), email: v('email'), phone: v('phone'),
        ccEmail: v('ccEmail'), address: v('address'), eventName: v('eventName'),
        eventDate: prettyFromIso(v('eventDate')), eventVenue: v('eventVenue'),
        eventStartTime: v('eventStartTime'), customerNotes: v('customerNotes'), dayContact: v('dayContact'),
      });
      done(res.data && res.data.quoteLink, res.data && res.data.autoSent);
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
