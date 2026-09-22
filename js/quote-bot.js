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
} from './firebase-config.js?v=146';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

/*  DEFAULT PRICES - a mirror of functions/lib/quote-pricing.js. The bot
    reads the live table from Firestore; this is only what it shows before
    Max has saved one, and the fallback if the read fails. Keep the SHAPE in
    step with the server file; the numbers are Max's to change in admin.   */
const DEFAULT_PRICING = {
  spreadPct: 15,
  roundToCents: 5000,
  freeHours: 4,
  hourlyCents: 0,
  eventTypes: [
    { key: 'wedding', label: 'Wedding', baseCents: 120000 },
    { key: 'corporate', label: 'Corporate', baseCents: 150000 },
    { key: 'private', label: 'Private Function', baseCents: 80000 },
    { key: 'festival', label: 'Festival', baseCents: 250000 },
  ],
  sizes: [
    { key: 's', label: 'Up to 50 guests', multiplier: 1 },
    { key: 'm', label: '50 to 150 guests', multiplier: 1.25 },
    { key: 'l', label: '150 to 400 guests', multiplier: 1.6 },
    { key: 'xl', label: '400+ guests', multiplier: 2.2 },
  ],
  locations: [
    { key: 'bowen', label: 'Bowen', travelCents: 0 },
    { key: 'airlie', label: 'Airlie Beach', travelCents: 15000 },
    { key: 'whitsundays', label: 'Whitsundays', travelCents: 20000 },
    { key: 'other', label: 'Somewhere else', travelCents: 25000 },
  ],
  durations: [
    { key: '3', label: 'A few hours', hours: 3 },
    { key: '5', label: 'Half a day', hours: 5 },
    { key: '7', label: 'A full evening', hours: 7 },
    { key: '10', label: 'All day', hours: 10 },
  ],
};

/*  DEFAULT INVENTORY - a mirror of functions/lib/quote-pricing.js. The bot
    reads the live `inventory` collection; this is the fallback so it still
    offers something before Max has saved his gear. Only inBot items are
    offered. Keep the SHAPE in step with the server file.                  */
const DEFAULT_INVENTORY = [
  { id: 'dj', name: 'DJ Package', category: 'DJ / MC', priceCents: 60000, period: 'event', quantity: 2, inBot: true },
  { id: 'mc', name: 'MC / Host', category: 'DJ / MC', priceCents: 35000, period: 'event', quantity: 1, inBot: true },
  { id: 'pa', name: 'Live Sound / PA System', category: 'Audio', priceCents: 45000, period: 'event', quantity: 3, inBot: true },
  { id: 'lighting', name: 'Lighting Package', category: 'Lighting', priceCents: 40000, period: 'event', quantity: 4, inBot: true },
  { id: 'staging', name: 'Staging', category: 'Staging', priceCents: 50000, period: 'event', quantity: 1, inBot: true },
  { id: 'dryhire', name: 'Dry Hire Gear', category: 'Dry Hire', priceCents: 25000, period: 'day', quantity: 10, inBot: true },
  { id: 'setup', name: 'Setup & Pack-down', category: 'Crew', priceCents: 30000, period: 'event', quantity: 1, inBot: true },
];

/* -------------------------------------------------------------------------
   Estimator - the same formula as functions/lib/quote-pricing.js
   ------------------------------------------------------------------------- */
function roundCents(cents, step) {
  const s = step && step > 0 ? step : 1;
  const r = Math.round(cents / s) * s;
  return r < 0 ? 0 : r;
}

function find(list, key) {
  return (Array.isArray(list) ? list : []).find((x) => x && x.key === key) || null;
}

function estimate(pricing, inv, answers) {
  const p = pricing || DEFAULT_PRICING;
  const items = (Array.isArray(inv) && inv.length) ? inv : DEFAULT_INVENTORY;
  const a = answers || {};

  const evt = find(p.eventTypes, a.eventType);
  const loc = find(p.locations, a.location);
  const size = find(p.sizes, a.size);
  const dur = find(p.durations, a.hours);

  const byId = {};
  items.forEach((it) => { if (it && it.id) byId[it.id] = it; });
  const picked = (a.services || [])
    .map((id) => byId[id])
    .filter((it) => it && it.inBot);

  const base = evt ? evt.baseCents || 0 : 0;
  const addons = picked.reduce((s, x) => s + (x.priceCents || 0), 0);
  const travel = loc ? loc.travelCents || 0 : 0;
  const overage = Math.max(0, (dur ? dur.hours || 0 : 0) - (p.freeHours || 0));
  const duration = overage * (p.hourlyCents || 0);

  const subtotal = base + addons + travel + duration;
  const mult = size ? size.multiplier || 1 : 1;
  const step = p.roundToCents || 5000;
  const point = roundCents(subtotal * mult, step);
  const spread = (p.spreadPct || 0) / 100;

  return {
    lowCents: roundCents(point * (1 - spread), step),
    highCents: roundCents(point * (1 + spread), step),
  };
}

const dollars = (cents) => '$' + Math.round((cents || 0) / 100).toLocaleString('en-AU');

function rangeLabel(est) {
  const lo = dollars(est.lowCents);
  const hi = dollars(est.highCents);
  return lo === hi ? lo : lo + ' – ' + hi;
}

/* -------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */
const answers = { eventType: '', location: '', size: '', hours: '', services: [] };
let pricing = DEFAULT_PRICING;
let inventory = DEFAULT_INVENTORY;
let fb = null;          // { functions, callable } once the SDK is up
let stream;             // the messages column
let dock;              // where the current choices sit

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
      submit: functions.httpsCallable(fns, 'submitQuoteLead'),
    };

    // Live prices and the live inventory, if Max has saved them. A missing
    // or empty one leaves the default in place rather than emptying the menus.
    try {
      const snap = await firestore.getDoc(
        firestore.doc(db, 'config', 'quotePricing'));
      if (snap.exists()) {
        const data = snap.data() || {};
        if (Array.isArray(data.eventTypes) && data.eventTypes.length) {
          pricing = data;
        }
      }
    } catch (err) {
      /* keep the default */
    }

    try {
      const invSnap = await firestore.getDocs(
        firestore.collection(db, 'inventory'));
      const items = [];
      invSnap.forEach((d) => items.push({ id: d.id, ...d.data() }));
      if (items.length) inventory = items;
    } catch (err) {
      /* keep the default */
    }
  } catch (err) {
    fb = null;   // the bot still runs, it just cannot send
  }
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
  await botSay('Hey! 👋 I’m the SoundzGood estimate assistant. Answer a few quick '
    + 'questions and I’ll give you a ballpark on the spot.', 200);
  await botSay('What type of event are you planning?');
  askEventType();
}

function askEventType() {
  offerChips(pricing.eventTypes, (opt) => {
    answers.eventType = opt.key;
    meSay(opt.label);
    askLocation();
  });
}

async function askLocation() {
  clearDock();
  await botSay('Nice one. Where will it be held?');
  offerChips(pricing.locations, (opt) => {
    answers.location = opt.key;
    meSay(opt.label);
    askSize();
  });
}

async function askSize() {
  clearDock();
  await botSay('Roughly how many guests are you expecting?');
  offerChips(pricing.sizes, (opt) => {
    answers.size = opt.key;
    meSay(opt.label);
    askServices();
  });
}

/*  Services is the one multi-select step: tap as many as you like, then a
    Done button moves on. The dock rebuilds after each tap so the chosen
    ones show as filled.                                                   */
async function askServices() {
  clearDock();
  await botSay('What are you after? Tap everything that applies.');
  renderServiceChips();
}

/*  The extras the bot offers: inventory items flagged inBot, in the order
    they were saved, grouped under their category.                         */
function botItems() {
  return (inventory || []).filter((it) => it && it.inBot && it.name);
}

function renderServiceChips() {
  dock.innerHTML = '';
  dock.className = 'sgq-dock sgq-dock-multi';

  const items = botItems();

  //  Grouped by category, each group under a small heading. A single flat
  //  list if nothing has a category, so it never looks broken.
  let lastCat = null;
  items.forEach((item) => {
    const cat = item.category || '';
    if (cat && cat !== lastCat) {
      const h = document.createElement('span');
      h.className = 'sgq-cat';
      h.textContent = cat;
      dock.appendChild(h);
      lastCat = cat;
    }

    const on = answers.services.includes(item.id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sgq-chip sgq-chip-toggle' + (on ? ' is-on' : '');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.innerHTML = (on ? '✓ ' : '') + esc(item.name);
    b.addEventListener('click', () => {
      const i = answers.services.indexOf(item.id);
      if (i >= 0) answers.services.splice(i, 1);
      else answers.services.push(item.id);
      renderServiceChips();
    });
    dock.appendChild(b);
  });

  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'sgq-chip sgq-chip-go';
  done.textContent = answers.services.length ? "That's everything →" : 'Skip →';
  done.addEventListener('click', () => {
    const chosen = items
      .filter((s) => answers.services.includes(s.id))
      .map((s) => s.name);
    meSay(chosen.length ? chosen.join(', ') : 'Not sure yet');
    askDuration();
  });
  dock.appendChild(done);
  scrollDown();
}

async function askDuration() {
  clearDock();
  await botSay('About how long do you need us for?');
  offerChips(pricing.durations, (opt) => {
    answers.hours = opt.key;
    meSay(opt.label);
    showEstimate();
  });
}

async function showEstimate() {
  clearDock();
  const est = estimate(pricing, inventory, answers);
  answers._est = est;

  await botSay('Thanks! Based on that, an event like yours usually lands around:');
  await botSay(`<span class="sgq-range">${rangeLabel(est)}</span>
    <span class="sgq-range-note">Ballpark only — every event’s different, so the
    final price depends on the details.</span>`, 250);
  await botSay('Want us to lock in an exact quote? Pop your details in and the team '
    + 'will be in touch — you’ll get this estimate by email too.', 250);
  askContact();
}

/*  The contact form goes INSIDE the scrollable conversation, not in the
    fixed dock at the foot: as a dock it was tall enough to cover the chat,
    so you could not scroll back up to read your estimate. In the stream it
    scrolls with everything else.                                          */
function askContact() {
  clearDock();

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
        <input type="text" name="eventDate" placeholder="e.g. Sat 14 Mar 2026">
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
      <button type="submit" class="sgq-submit">Send me my estimate</button>
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

  const payload = {
    name,
    email,
    phone: val('phone'),
    eventDate: val('eventDate'),
    message: val('message'),
    website: val('website'),   // honeypot
    eventType: answers.eventType,
    location: answers.location,
    size: answers.size,
    hours: answers.hours,
    services: answers.services.slice(),
  };

  btn.disabled = true;
  btn.textContent = 'Sending…';
  err.hidden = true;

  /*  No Firebase (preview or a load failure): the bot cannot send, so it
      says so plainly and hands the visitor the contact page rather than
      pretending it worked.                                                */
  const card = form.closest('.sgq-formwrap');

  if (!fb) {
    if (card) card.remove();
    meSay(`${name} — ${email}`);
    await botSay('Thanks! We can’t send from this preview, but you can reach the '
      + 'team on the <a href="/contact">contact page</a> and quote your estimate of '
      + `<strong>${rangeLabel(answers._est)}</strong>.`);
    return;
  }

  try {
    await fb.submit(payload);
    if (card) card.remove();
    meSay(`${name} — ${email}`);
    await botSay(`Perfect, thanks ${esc(name)}! 🎉 Your estimate of `
      + `<strong>${rangeLabel(answers._est)}</strong> is on its way to your inbox, `
      + 'and the team will follow up shortly.');
    await botSay('Planning more than one event? <a href="/contact">Get in touch</a> '
      + 'any time.', 250);
  } catch (ex) {
    btn.disabled = false;
    btn.textContent = 'Send me my estimate';
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
