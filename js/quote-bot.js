/* ==========================================================================
   ESTIMATE BOT  -  the quote assistant on the services page

   A guided, button-led chat: the visitor taps their way through event type,
   location, size, what they need and how long, sees a live price RANGE, and
   leaves their details. Nothing is typed except the contact fields, so there
   is no free-text to misread - Max chose a fixed guided flow first, with a
   mix to come later.

   HOW THE PRICE STAYS HONEST
   The bot shows a range from the price table at config/quotePricing (public
   read). On submit the submitQuoteLead function recomputes the same range
   from the same table server-side, so a fiddled page cannot email itself a
   made-up figure. The number here is a preview; the server's is the record.

   NO FIREBASE, NO PROBLEM
   If the config placeholders are unfilled or the SDK fails to load, the bot
   still runs on the built-in default prices and simply cannot send - it says
   so and points at the contact page, rather than throwing at a visitor.
   ========================================================================== */

import {
  firebaseConfig, functionsRegion, isFirebaseConfigured,
} from './firebase-config.js?v=154';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

/*  The bot no longer prices in the browser: all matching and pricing runs in
    the submitBotQuote function, so the page ships only the little UI below.  */
const dollars = (cents) => '$' + Math.round((cents || 0) / 100).toLocaleString('en-AU');

/*  The date input hands back yyyy-mm-dd; store it as a friendly string so it
    reads well on the quote (e.g. "Sat 4 Apr 2027"). */
function formatEventDate(s) {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d)) return s;
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function rangeLabel(est) {
  const lo = dollars(est.lowCents);
  const hi = dollars(est.highCents);
  return lo === hi ? lo : lo + ' – ' + hi;
}

/* -------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */
const answers = { eventType: '', guests: 0, days: 1, town: '', support: '', name: '', email: '', phone: '', eventDate: '' };
let packages = [];      // {name, eventType, maxGuests} summaries, for the event-type menu
let fb = null;          // { submit } once the SDK is up
let stream;             // the messages column
let dock;              // where the current choices sit

const GUEST_OPTS = [
  { label: 'Up to 50', guests: 50 }, { label: '50–100', guests: 100 }, { label: '100–150', guests: 150 },
  { label: '150–250', guests: 250 }, { label: '250+', guests: 400 },
];
const DAY_OPTS = [{ label: 'Just the day', days: 1 }, { label: '2 days', days: 2 }, { label: '3 days', days: 3 }];
const TOWN_OPTS = ['Bowen (local)', 'Proserpine', 'Airlie Beach', 'Cannonvale', 'Collinsville', 'Ayr', 'Home Hill', 'Mackay', 'Townsville'];
const SUPPORT_OPTS = [
  { label: 'Full service — delivered, set up + on-site tech', value: 'full' },
  { label: 'Delivery & setup only', value: 'delivery' },
  { label: 'I’ll collect from Bowen', value: 'pickup' },
];

/* -------------------------------------------------------------------------
   Firebase - loaded lazily, only what the bot needs
   ------------------------------------------------------------------------- */
async function initFirebase() {
  if (!isFirebaseConfigured) return;
  try {
    const [{ initializeApp }, firestore, functions] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-firestore.js`),
      import(`${SDK}/firebase-functions.js`),
    ]);

    const app = initializeApp(firebaseConfig);
    const db = firestore.getFirestore(app);
    const fns = functions.getFunctions(app, functionsRegion);

    fb = {
      submit: functions.httpsCallable(fns, 'submitBotQuote'),
    };

    // Just the package summaries for the event-type menu - the gear, prices
    // and matching all live server-side, so nothing bulky ships to the page.
    try {
      const snap = await firestore.getDocs(firestore.collection(db, 'packages'));
      const rows = [];
      snap.forEach((d) => {
        const x = d.data() || {};
        if (x.active !== false) rows.push({ name: x.name || '', eventType: x.eventType || '', maxGuests: x.maxGuests || 0 });
      });
      if (rows.length) packages = rows;
    } catch (err) {
      /* keep the fallback event-type list */
    }
  } catch (err) {
    fb = null;   // the bot still runs, it just cannot send
  }
}

/*  The event types offered, taken from the active packages (falls back to a
    sensible default before any package is read). */
function eventTypeOptions() {
  const seen = new Set();
  const out = [];
  packages.forEach((p) => {
    const t = (p.eventType || '').trim();
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  });
  return out.length ? out : ['Wedding', 'Party', 'Corporate', 'Live Music'];
}

/* -------------------------------------------------------------------------
   Rendering helpers
   ------------------------------------------------------------------------- */
function esc(value) {
  const d = document.createElement('div');
  d.textContent = String(value == null ? '' : value);
  return d.innerHTML;
}

function scrollDown() {
  if (stream) stream.scrollTop = stream.scrollHeight;
}

/*  A message from the bot. Appears after a short "typing" beat so it feels
    like a reply and not a page dump.                                      */
function botSay(html, delay = 350) {
  return new Promise((resolve) => {
    const typing = document.createElement('div');
    typing.className = 'sgq-row sgq-row-bot';
    typing.innerHTML = `
      <span class="sgq-avatar" aria-hidden="true">SG</span>
      <span class="sgq-typing"><i></i><i></i><i></i></span>`;
    stream.appendChild(typing);
    scrollDown();

    setTimeout(() => {
      typing.querySelector('.sgq-typing').outerHTML =
        `<div class="sgq-bubble">${html}</div>`;
      scrollDown();
      resolve();
    }, delay);
  });
}

/*  A choice the visitor made, shown on the right as their reply.          */
function meSay(text) {
  const row = document.createElement('div');
  row.className = 'sgq-row sgq-row-me';
  row.innerHTML = `<div class="sgq-bubble sgq-bubble-me">${esc(text)}</div>`;
  stream.appendChild(row);
  scrollDown();
}

/*  Clear the choice dock and fill it with buttons. `onPick` gets the option.
    Returns nothing - each button wires itself.                            */
function offerChips(options, onPick) {
  dock.innerHTML = '';
  dock.className = 'sgq-dock';
  options.forEach((opt) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sgq-chip';
    b.textContent = opt.label;
    b.addEventListener('click', () => onPick(opt));
    dock.appendChild(b);
  });
  scrollDown();
}

function clearDock() {
  dock.innerHTML = '';
}

/* -------------------------------------------------------------------------
   The flow
   ------------------------------------------------------------------------- */
async function start() {
  await botSay('Hi! I’m the SoundzGood estimate assistant. A few quick questions and '
    + 'I’ll get you a ballpark — then our team follows up with a formal quote.', 200);
  askEventType();
}

async function askEventType() {
  await botSay('What type of event is it?');
  offerChips(eventTypeOptions().map((t) => ({ label: t, value: t })), (o) => {
    answers.eventType = o.value;
    meSay(o.label);
    askGuests();
  });
}

async function askGuests() {
  clearDock();
  await botSay('Roughly how many guests?');
  offerChips(GUEST_OPTS.map((g) => ({ label: g.label, value: g.guests })), (o) => {
    answers.guests = o.value;
    meSay(o.label);
    askDays();
  });
}

async function askDays() {
  clearDock();
  await botSay('How many days do you need us for?');
  offerChips(DAY_OPTS.map((d) => ({ label: d.label, value: d.days })), (o) => {
    answers.days = o.value;
    meSay(o.label);
    askTown();
  });
}

async function askTown() {
  clearDock();
  await botSay('Where’s the venue?');
  const opts = TOWN_OPTS.map((t) => ({ label: t, value: t })).concat([{ label: 'Somewhere else', value: '' }]);
  offerChips(opts, (o) => {
    answers.town = o.value;
    meSay(o.label || 'Somewhere else');
    askSupport();
  });
}

async function askSupport() {
  clearDock();
  await botSay('How much hands-on support do you need on the day?');
  offerChips(SUPPORT_OPTS, (o) => {
    answers.support = o.value;
    meSay(o.label);
    askContact();
  });
}

/*  The contact form goes INSIDE the scrollable conversation, not in the
    fixed dock at the foot: as a dock it was tall enough to cover the chat,
    so you could not scroll back up to read your estimate. In the stream it
    scrolls with everything else.                                          */
async function askContact() {
  clearDock();
  await botSay('Great — last step. Pop your details in and I’ll work out your estimate.');

  const card = document.createElement('div');
  card.className = 'sgq-formwrap';
  card.innerHTML = `
    <form class="sgq-form" novalidate>
      <label class="sgq-field">
        <span>Your name</span>
        <input type="text" name="name" autocomplete="name" required>
      </label>
      <label class="sgq-field">
        <span>Email</span>
        <input type="email" name="email" autocomplete="email" required>
      </label>
      <label class="sgq-field">
        <span>Phone <em>(optional)</em></span>
        <input type="tel" name="phone" autocomplete="tel">
      </label>
      <label class="sgq-field">
        <span>Event date <em>(optional)</em></span>
        <input type="date" name="eventDate">
      </label>
      <label class="sgq-field">
        <span>Anything else? <em>(optional)</em></span>
        <textarea name="message" rows="2"></textarea>
      </label>

      <!-- Honeypot: hidden from people, catnip for bots. Left blank by a
           human, filled by a script; the server drops any lead that has it. -->
      <div class="sgq-hp" aria-hidden="true">
        <label>Company website<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
      </div>

      <p class="sgq-err" hidden></p>
      <button type="submit" class="sgq-submit">Get my estimate</button>
    </form>`;

  stream.appendChild(card);

  const form = card.querySelector('.sgq-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(form);
  });
  scrollDown();
}

async function submit(form) {
  const err = form.querySelector('.sgq-err');
  const btn = form.querySelector('.sgq-submit');
  const val = (n) => (form.elements[n] ? form.elements[n].value.trim() : '');

  const name = val('name');
  const email = val('email');
  if (!name) return showErr(err, 'Please add your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return showErr(err, 'That email doesn’t look right.');
  }

  answers.name = name;
  answers.email = email;
  answers.phone = val('phone');
  answers.eventDate = formatEventDate(val('eventDate'));

  btn.disabled = true;
  btn.textContent = 'Working it out…';
  err.hidden = true;

  const card = form.closest('.sgq-formwrap');

  /*  No Firebase (preview or a load failure): the bot cannot price, so it
      says so plainly and hands the visitor the contact page.              */
  if (!fb) {
    if (card) card.remove();
    meSay(`${name} — ${email}`);
    await botSay('Thanks! We can’t price from this preview, but reach the team on the '
      + '<a href="/contact">contact page</a> and we’ll sort your quote.');
    return;
  }

  try {
    const res = await fb.submit({ answers, website: val('website') });
    const d = (res && res.data) || {};
    if (card) card.remove();
    meSay(`${name} — ${email}`);
    if (d.lowCents != null) {
      await botSay(`Thanks ${esc(name)}! For a ${esc(answers.eventType)} like yours, we’re looking at roughly:`);
      await botSay(`<span class="sgq-range">${rangeLabel({ lowCents: d.lowCents, highCents: d.highCents })}</span>
        <span class="sgq-range-note">Estimate only — our team will confirm the details and email your formal quote${d.packageName ? ` (based on our ${esc(d.packageName)})` : ''}. Nothing’s booked until a deposit is paid.</span>`, 250);
      await botSay('We’ll be in touch shortly. 🎧', 250);
    } else {
      await botSay('Thanks! Our team will review the details and be in touch with your quote.');
    }
  } catch (ex) {
    btn.disabled = false;
    btn.textContent = 'Get my estimate';
    showErr(err, (ex && ex.message) || 'Something went wrong. Please try again.');
  }
}

function showErr(el, msg) {
  el.textContent = msg;
  el.hidden = false;
  scrollDown();
}

/* -------------------------------------------------------------------------
   Mount  -  a floating launcher, bottom right, that opens the chat panel
   ------------------------------------------------------------------------- */
let started = false;   // the chat flow only kicks off the first time it opens

/*  Build the launcher bubble and the panel, appended to <body> so nothing on
    the page can clip them. The panel is hidden until the bubble is tapped. */
function mount() {
  const wrap = document.createElement('div');
  wrap.className = 'sgq-fab-wrap';
  wrap.innerHTML = `
    <div class="sgq-panel" id="sgq-panel" hidden>
      <div class="sgq" role="dialog" aria-label="Event estimate assistant" aria-modal="false">
        <header class="sgq-head">
          <span class="sgq-avatar sgq-avatar-lg" aria-hidden="true">SG</span>
          <div class="sgq-head-text">
            <p class="sgq-head-name">SoundzGood Estimate Bot</p>
            <p class="sgq-head-status"><span class="sgq-dot"></span> Online now</p>
          </div>
          <button type="button" class="sgq-close" id="sgq-close" aria-label="Close">&times;</button>
        </header>
        <div class="sgq-stream" id="sgq-stream" aria-live="polite"></div>
        <div class="sgq-dock" id="sgq-dock"></div>
      </div>
    </div>

    <button type="button" class="sgq-fab" id="sgq-fab" aria-expanded="false"
            aria-controls="sgq-panel" aria-label="Get an instant estimate">
      <svg class="sgq-fab-open" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.6-.8L3 21l1.8-5.4a8.5 8.5 0 0 1-.8-3.6A8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/>
      </svg>
      <svg class="sgq-fab-close" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M18 6 6 18M6 6l12 12"/>
      </svg>
      <span class="sgq-fab-label">Instant estimate</span>
    </button>`;

  document.body.appendChild(wrap);

  stream = wrap.querySelector('#sgq-stream');
  dock = wrap.querySelector('#sgq-dock');

  const panel = wrap.querySelector('#sgq-panel');
  const fab = wrap.querySelector('#sgq-fab');
  const close = wrap.querySelector('#sgq-close');

  const setOpen = (open) => {
    panel.hidden = !open;
    wrap.classList.toggle('is-open', open);
    fab.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Start the conversation the first time it is opened, so the greeting
    // types out live rather than sitting there answered.
    if (open && !started) { started = true; start(); }
    if (open) scrollDown();
  };

  fab.addEventListener('click', () => setOpen(panel.hidden));
  close.addEventListener('click', () => setOpen(false));

  // Any in-page button can open it - delegated on the document, so buttons
  // rendered later (e.g. the hire catalogue's Enquire buttons) work too.
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-quote-bot]')) { e.preventDefault(); setOpen(true); }
  });

  // Esc closes it.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) setOpen(false);
  });
}

function init() {
  if (document.getElementById('sgq-fab')) return;   // guard against double-mount
  mount();
  // Prices and inventory load quietly in the background, ready well before
  // the visitor opens the bubble and reaches a priced choice.
  initFirebase();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
