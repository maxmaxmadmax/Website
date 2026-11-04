/* ==========================================================================
   DJ SET TIMES  -  /dj-times?t=<timesToken>

   Before the gig the link asks the DJ "are you in?". From 5pm on the night
   it switches to a times form: the DJ picks start and finish and presses
   Confirm. That updates their booking and the pub's invoice (hours x their
   rate), which then waits for Max to send it.
   Data: getPubTimes / submitDjConfirm / submitPubTimes (functions/index.js).
   Uses the sponsor page styles (sponsor.css).

   CONTENTS
     SETUP        Firebase, the link token
     TIMES        12-hour labels, the day, the time choices, hours played
     CONFIRM      "are you in?" before the gig
     SET TIMES    the times form after the gig, and the thank-you
     START        load the booking
   ========================================================================== */

import { firebaseConfig, functionsRegion, isFirebaseConfigured } from './firebase-config.js?v=851';

/* ---- SETUP ---- */
const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
const esc = window.SG.esc;
const TOKEN = new URLSearchParams(location.search).get('t') || '';
let fns = null;

const call = (name, payload) => fns.httpsCallable(fns.fns, name)(payload);

/* ---- TIMES ---- */
/* "18:30" -> "6:30pm"; anything else -> "" */
function ampm(t) {
    const r = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    if (!r) return '';
    const h = +r[1];
    return (h % 12 || 12) + ':' + r[2] + (h < 12 ? 'am' : 'pm');
}

/* "2026-10-20" -> "Tuesday 20 October" */
function niceDay(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
}

/*  Trading hours only: every 15 minutes from 5pm to 2:30am.
    KEEP IN STEP with TRADE_FROM / TRADE_TO in functions/index.js. */
function timeOptions(current) {
    let out = '<option value="">Choose a time</option>';
    for (let m = 17 * 60; m <= 26 * 60 + 30; m += 15) {
        const hh = String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
        out += '<option value="' + hh + '"' + (hh === current ? ' selected' : '') + '>' + ampm(hh) + '</option>';
    }
    return out;
}

/* minutes into the night: before 5pm counts as after midnight (the next day) */
function nightMinutes(t) {
    const r = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    if (!r) return null;
    const v = +r[1] * 60 + +r[2];
    return v < 17 * 60 ? v + 1440 : v;
}

/*  Hours played, to the quarter hour. Same time, or finishing before
    starting, is 0 (never "24 hours"). */
function hoursOf(a, b) {
    const x = nightMinutes(a);
    const y = nightMinutes(b);
    if (x == null || y == null || y <= x) return 0;
    return Math.round((y - x) / 15) / 4;
}

/* the line under the times: blank until both are picked, then the hours or what's wrong */
function hoursNote(both, h) {
    if (!both) return '';
    if (!h) return 'The finish time has to be after the start time.';
    if (h > 8) return 'That’s more than 8 hours - please check with Max.';
    return 'That’s ' + h + ' hours.';
}

/* ---- CONFIRM ---- */
function accomHtml(a) {
    if (!a) return '';
    return `<div class="dj-accom"><b>Your accommodation</b><br>${esc(a.name)}${a.address ? ', ' + esc(a.address) : ''}
      ${a.checkIn ? '<br>Check-in: ' + esc(a.checkIn) : ''}${a.contact ? '<br>Contact: ' + esc(a.contact) : ''}${a.notes ? '<br>' + esc(a.notes) : ''}</div>`;
}

function renderConfirm(d) {
    const planned = d.plannedStart ? ', ' + ampm(d.plannedStart) + (d.plannedFinish ? ' to ' + ampm(d.plannedFinish) : '') : '';
    const when = niceDay(d.date) + planned;
    const answer = d.djConfirmed
        ? '<p class="dj-ok">&#10003; Thanks &mdash; you&rsquo;re locked in. After the gig, open this same link to put in your times.</p>'
        : '<button type="button" class="spn-btn" id="dj-in">I&rsquo;m in &#10003;</button><p class="spn-msg" id="dj-msg" hidden></p>';
    document.getElementById('dj-root').innerHTML = `
  <section class="spn-sec">
    <p class="spn-eyebrow" style="color:#ff6b00">SoundzGood Whitsundays</p>
    <h2>${d.djConfirmed ? 'You&rsquo;re confirmed' : 'You&rsquo;re booked'}</h2>
    <p class="spn-sub"><b>${esc(d.act)}</b> &middot; ${esc(String(d.venue || '').split(',')[0])}<br>${esc(when)}</p>
    ${accomHtml(d.accom)}
    ${answer}
    <p class="spn-sub" style="margin-top:14px">Can&rsquo;t make it? Call Max on 0422 393 022.</p>
  </section>`;

    const btn = document.getElementById('dj-in');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
            await call('submitDjConfirm', { token: TOKEN });
            renderConfirm({ ...d, djConfirmed: true });
        } catch (err) {
            btn.disabled = false;
            const m = document.getElementById('dj-msg');
            m.hidden = false;
            m.textContent = (err && err.message) || 'Could not confirm. Please try again.';
        }
    });
}

/* ---- SET TIMES ---- */
function done(hours, waiting) {
    document.getElementById('dj-root').innerHTML = `<section class="spn-sec spn-thanks-big">
    <h2>Thanks!</h2>
    <p>Got it &mdash; <b>${esc(hours)} hours</b>. That&rsquo;s all we need.${waiting ? ' Max will check it over.' : ''}</p>
    <p class="spn-sub">Something wrong? Call Max on 0422 393 022.</p></section>`;
}

function render(d) {
    if (d.mode === 'confirm') {
        renderConfirm(d);
        return;
    }
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

    // the hours line, and the button only works for 0-8 hours
    const show = () => {
        const h = hoursOf(v('start'), v('finish'));
        const out = document.getElementById('dj-hours');
        const both = v('start') && v('finish');
        out.className = 'dj-hours spn-wide' + (both && (!h || h > 8) ? ' is-bad' : '');
        out.textContent = hoursNote(both, h);
        form.querySelector('button').disabled = !h || h > 8;
    };
    form.addEventListener('change', show);
    show();

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const h = hoursOf(v('start'), v('finish'));
        // say it back before it counts
        if (!window.confirm('You played ' + h + ' hours (' + ampm(v('start')) + ' to ' + ampm(v('finish')) + '). Is that right?')) return;
        const btn = form.querySelector('button');
        const msg = document.getElementById('dj-msg');
        btn.disabled = true;
        try {
            const res = await call('submitPubTimes', { token: TOKEN, start: v('start'), finish: v('finish') });
            done(res.data && res.data.hours, res.data && res.data.waiting);
        } catch (err) {
            btn.disabled = false;
            msg.hidden = false;
            msg.textContent = (err && err.message) || 'Could not send. Please try again.';
        }
    });
}

/* ---- START ---- */
async function load() {
    const root = document.getElementById('dj-root');
    if (!TOKEN || !isFirebaseConfigured) {
        root.innerHTML = '<p class="spn-loading">That link is not valid.</p>';
        return;
    }
    try {
        const [{ initializeApp }, functions] = await Promise.all([
            import(`${SDK}/firebase-app.js`),
            import(`${SDK}/firebase-functions.js`)
        ]);
        fns = { fns: functions.getFunctions(initializeApp(firebaseConfig), functionsRegion), httpsCallable: functions.httpsCallable };
        const res = await call('getPubTimes', { token: TOKEN });
        render(res.data);
    } catch (err) {
        root.innerHTML = '<p class="spn-loading">Sorry - that link is not valid. Please call Max on 0422 393 022.</p>';
    }
}

load();
