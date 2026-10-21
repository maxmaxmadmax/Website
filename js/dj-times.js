/* ==========================================================================
   DJ SET TIMES  -  /dj-times?t=<timesToken>   (Max, 21 Oct 2026)

   After a pub night Max texts the DJ this link. They pick when they started
   and finished and press Confirm. That updates their booking and the pub's
   invoice (hours x their rate), which then waits for Max to send it.
   Data: getPubTimes / submitPubTimes (functions/index.js).
   Uses the sponsor page styles (sponsor.css), like the details form.
   ========================================================================== */

import { firebaseConfig, functionsRegion, isFirebaseConfigured } from './firebase-config.js?v=645';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const TOKEN = new URLSearchParams(location.search).get('t') || '';
let fns = null;

const ampm = (t) => { const r = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); if (!r) return ''; const h = +r[1]; return (h % 12 || 12) + ':' + r[2] + (h < 12 ? 'am' : 'pm'); };
const niceDay = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' }) : ''; };

/*  Every 15 minutes from midday round to 4am - DJs finish late */
function timeOptions(current) {
  let out = '<option value="">Choose a time</option>';
  for (let m = 12 * 60; m < 28 * 60; m += 15) {
    const hh = String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    out += '<option value="' + hh + '"' + (hh === current ? ' selected' : '') + '>' + ampm(hh) + '</option>';
  }
  return out;
}
function hoursOf(a, b) {
  const m = (t) => { const r = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return r ? +r[1] * 60 + +r[2] : null; };
  const x = m(a), y = m(b);
  if (x == null || y == null) return 0;
  let mins = y - x;
  if (mins <= 0) mins += 24 * 60;
  return Math.round(mins / 15) / 4;
}

function done(hours) {
  document.getElementById('dj-root').innerHTML = `<section class="spn-sec spn-thanks-big">
    <h2>Thanks!</h2>
    <p>Got it &mdash; <b>${esc(hours)} hours</b>. That&rsquo;s all we need.</p>
    <p class="spn-sub">Something wrong? Call Max on 0422 393 022.</p></section>`;
}

function render(d) {
  document.getElementById('dj-root').innerHTML = `
  <section class="spn-sec">
    <p class="spn-eyebrow" style="color:#ff6b00">SoundzGood Whitsundays</p>
    <h2>Your set times</h2>
    <p class="spn-sub"><b>${esc(d.act)}</b> &middot; ${esc(String(d.venue || '').split(',')[0])} &middot; ${esc(niceDay(d.date))}<br>
      ${d.confirmed ? 'You&rsquo;ve already sent your times &mdash; change them below if they were wrong.' : 'When did you start and finish playing?'}</p>
    <form class="spn-form" id="dj-form">
      <label>Started <b class="dt-req">*</b><select name="start" required>${timeOptions(d.start)}</select></label>
      <label>Finished <b class="dt-req">*</b><select name="finish" required>${timeOptions(d.finish)}</select></label>
      <p class="dj-hours spn-wide" id="dj-hours"></p>
      <button type="submit" class="spn-btn">Confirm my times</button>
      <p class="spn-msg" id="dj-msg" hidden></p>
    </form>
  </section>`;
  const form = document.getElementById('dj-form');
  const v = (n) => form.querySelector('[name="' + n + '"]').value;
  const show = () => {
    const h = hoursOf(v('start'), v('finish'));
    document.getElementById('dj-hours').textContent = h ? 'That’s ' + h + ' hours.' : '';
    form.querySelector('button').disabled = !h;
  };
  form.addEventListener('change', show);
  show();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    const msg = document.getElementById('dj-msg');
    btn.disabled = true;
    try {
      const res = await fns.httpsCallable(fns.fns, 'submitPubTimes')({ token: TOKEN, start: v('start'), finish: v('finish') });
      done(res.data && res.data.hours);
    } catch (err) {
      btn.disabled = false;
      msg.hidden = false;
      msg.textContent = (err && err.message) || 'Could not send. Please try again.';
    }
  });
}

async function load() {
  const root = document.getElementById('dj-root');
  if (!TOKEN || !isFirebaseConfigured) { root.innerHTML = '<p class="spn-loading">That link is not valid.</p>'; return; }
  try {
    const [{ initializeApp }, functions] = await Promise.all([
      import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-functions.js`),
    ]);
    fns = { fns: functions.getFunctions(initializeApp(firebaseConfig), functionsRegion), httpsCallable: functions.httpsCallable };
    const res = await fns.httpsCallable(fns.fns, 'getPubTimes')({ token: TOKEN });
    render(res.data);
  } catch (err) {
    root.innerHTML = '<p class="spn-loading">Sorry - that link is not valid. Please call Max on 0422 393 022.</p>';
  }
}

load();
