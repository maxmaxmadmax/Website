/* --------------------------------------------------------------------------
   SOUNDZGOOD ADMIN

   The backend for the site. Vendors and their applications live here now;
   quoting, leads and the rest will join them.

   WHAT PROTECTS THIS
   Not the address. Every account can sign in, but only one carrying the
   admin custom claim gets past the gate - and, more to the point, the
   Firestore rules and the Cloud Functions check the same claim server
   side. Someone who found this page and signed in as a vendor would be
   shown the door here and refused by the database anyway.

   HOW IT IS PUT TOGETHER
   One page, one script, no framework. Views are plain functions that
   return markup and then wire up their own listeners. The rail switches
   between them and the address bar hash remembers where you were.

   It reads the same collections the public signup page writes:

       events/{eventId}                    the event
       events/{eventId}/sites/{siteId}     the 50 sites
       events/{eventId}/categories/{id}    limits and live counts
       bookings/{bookingId}                one per vendor application

   Nothing here writes to those directly except through the admin Cloud
   Functions, for the same reason the public page does not: allocation and
   money have to be decided server side.
   -------------------------------------------------------------------------- */

import {
  firebaseConfig,
  functionsRegion,
  eventId as defaultEventId,
  isFirebaseConfigured,
} from './firebase-config.js?v=27';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

/* -------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */
const state = {
  user: null,
  view: 'vendors',

  activeEventId: defaultEventId,

  events: [],
  bookings: [],
  sites: [],
  categories: [],

  /* per-view scratch, kept here so switching away and back remembers it */
  filters: {
    search: '',
    status: 'all',
    vendorType: 'all',
    payment: 'all',
  },

  openBookingId: null,
  openSiteId: null,
  editingEvent: null,
  noteDraft: '',
  addingVendor: false,
  ready: false,
};

let fb = null;
const unsubscribes = [];

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', init);

async function init() {
  if (!isFirebaseConfigured) {
    showLoginError('Firebase is not connected. Fill in js/firebase-config.js.');
    return;
  }

  fb = await loadFirebase();
  wireChrome();

  fb.a.onAuthStateChanged(fb.auth, async (user) => {
    if (!user) return showGate();

    const token = await user.getIdTokenResult(true);
    if (token.claims.admin !== true) {
      showLoginError('That account is not an admin.');
      await fb.a.signOut(fb.auth);
      return;
    }

    state.user = user;
    showApp(user);
    await loadEvents();
    subscribeToEvent();
    routeFromHash();
  });
}

async function loadFirebase() {
  const [{ initializeApp }, auth, firestore, functions] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
    import(`${SDK}/firebase-functions.js`),
  ]);

  const app = initializeApp(firebaseConfig);
  return {
    auth: auth.getAuth(app),
    db: firestore.getFirestore(app),
    fns: functions.getFunctions(app, functionsRegion),
    a: auth,
    f: firestore,
    fn: functions,
  };
}

/* Call an admin Cloud Function. */
async function call(name, data) {
  const res = await fb.fn.httpsCallable(fb.fns, name)(data || {});
  return res.data;
}

/* -------------------------------------------------------------------------
   Gate
   ------------------------------------------------------------------------- */
function showGate() {
  state.user = null;
  document.getElementById('ad-gate').hidden = false;
  document.getElementById('ad-shell').hidden = true;
}

function showApp(user) {
  document.getElementById('ad-gate').hidden = true;
  document.getElementById('ad-shell').hidden = false;

  const name = user.email || 'Admin';
  document.getElementById('ad-who-name').textContent = name;
  document.getElementById('ad-avatar').textContent =
    (name[0] || 'A').toUpperCase();
}

function showLoginError(message) {
  const el = document.getElementById('ad-login-error');
  el.textContent = message;
  el.hidden = !message;
}

/* -------------------------------------------------------------------------
   Chrome - login form, rail, event picker
   ------------------------------------------------------------------------- */
function wireChrome() {
  document.getElementById('ad-login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showLoginError('');

    const btn = document.getElementById('ad-login-submit');
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    try {
      await fb.a.signInWithEmailAndPassword(
        fb.auth,
        document.getElementById('ad-email').value.trim(),
        document.getElementById('ad-password').value
      );
    } catch (err) {
      showLoginError(friendly(err));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });

  document.getElementById('ad-signout').addEventListener('click', () => {
    fb.a.signOut(fb.auth);
  });

  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      location.hash = '#/' + btn.getAttribute('data-view');
      document.getElementById('ad-rail').classList.remove('is-open');
    });
  });

  const toggle = document.getElementById('ad-rail-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      document.getElementById('ad-rail').classList.toggle('is-open');
    });
  }

  document.getElementById('ad-event-select').addEventListener('change', (ev) => {
    setActiveEvent(ev.target.value);
  });

  window.addEventListener('hashchange', routeFromHash);
}

/* -------------------------------------------------------------------------
   Routing
   ------------------------------------------------------------------------- */
const BUILT = ['events', 'vendors', 'applications', 'map', 'settings'];

/*  Vendors is where the work is, so it is what you land on. */
const HOME = 'vendors';

function routeFromHash() {
  const want = (location.hash.replace('#/', '') || HOME).split('?')[0];
  state.view = want;
  state.openBookingId = null;

  document.querySelectorAll('[data-view]').forEach((b) =>
    b.classList.toggle('is-active', b.getAttribute('data-view') === want));

  render();
}

/* -------------------------------------------------------------------------
   Data
   ------------------------------------------------------------------------- */
async function loadEvents() {
  const { collection, getDocs } = fb.f;
  const snap = await getDocs(collection(fb.db, 'events'));

  state.events = [];
  snap.forEach((d) => state.events.push({ id: d.id, ...d.data() }));
  state.events.sort((a, b) => (a.dateISO || '').localeCompare(b.dateISO || ''));

  if (!state.events.some((e) => e.id === state.activeEventId)) {
    state.activeEventId = state.events[0] ? state.events[0].id : null;
  }

  const select = document.getElementById('ad-event-select');
  select.innerHTML = state.events
    .map((e) => `<option value="${attr(e.id)}"${e.id === state.activeEventId ? ' selected' : ''}>
        ${esc(e.name || e.id)}${e.dateLabel ? ' — ' + esc(e.dateLabel) : ''}
      </option>`)
    .join('') || '<option value="">No events yet</option>';
}

/*  Live subscriptions for the active event. Everything on the page reads
    from these, so a change made here or by a vendor on the public page
    shows up without a refresh. */
function subscribeToEvent() {
  while (unsubscribes.length) unsubscribes.pop()();

  if (!state.activeEventId) {
    state.bookings = [];
    state.sites = [];
    state.categories = [];
    return;
  }

  const { collection, onSnapshot, query, where } = fb.f;
  const evId = state.activeEventId;

  unsubscribes.push(onSnapshot(
    query(collection(fb.db, 'bookings'), where('eventId', '==', evId)),
    (snap) => {
      state.bookings = [];
      snap.forEach((d) => state.bookings.push({ id: d.id, ...d.data() }));
      state.bookings.sort((a, b) => secs(b.createdAt) - secs(a.createdAt));
      state.ready = true;
      render();
    },
    (err) => console.error('bookings', err)
  ));

  unsubscribes.push(onSnapshot(
    collection(fb.db, 'events', evId, 'sites'),
    (snap) => {
      state.sites = [];
      snap.forEach((d) => state.sites.push({ id: d.id, ...d.data() }));
      state.sites.sort((a, b) =>
        String(a.label).localeCompare(String(b.label), undefined, { numeric: true }));
      render();
    },
    (err) => console.error('sites', err)
  ));

  unsubscribes.push(onSnapshot(
    collection(fb.db, 'events', evId, 'categories'),
    (snap) => {
      state.categories = [];
      snap.forEach((d) => state.categories.push({ id: d.id, ...d.data() }));
      state.categories.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      render();
    },
    (err) => console.error('categories', err)
  ));
}

/* -------------------------------------------------------------------------
   Render
   ------------------------------------------------------------------------- */
function render() {
  const desk = document.getElementById('ad-desk');
  if (!desk || !state.user) return;

  if (!BUILT.includes(state.view)) {
    desk.innerHTML = comingSoon(state.view);
    return;
  }

  const view = VIEWS[state.view];
  if (!view) {
    desk.innerHTML = comingSoon(state.view);
    return;
  }

  desk.innerHTML = view.html();
  if (view.wire) view.wire();
}

function comingSoon(name) {
  const pretty = (name || '').replace(/(^|\s)\w/g, (m) => m.toUpperCase());
  return `
    <div class="ad-soon">
      <div class="ad-soon-inner">
        <div class="ad-soon-mark" aria-hidden="true">◷</div>
        <h1>${esc(pretty)}</h1>
        <p>Feature coming soon.</p>
      </div>
    </div>`;
}

/*  Views are registered here. Each is { html(), wire?() } - html returns
    the markup, wire hooks up whatever needs listeners afterwards. Adding
    a section means adding an entry and a rail button. */
const VIEWS = {};

/* -------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------- */
function esc(value) {
  const d = document.createElement('div');
  d.textContent = String(value == null ? '' : value);
  return d.innerHTML;
}

/*  A URL that came out of the database, checked before it is allowed to
    become a link.

    A vendor writes their own documents[] when they upload, so the url on
    a document is theirs to choose. Dropping that straight into an href
    lets them store javascript: and have it run in this page - which is
    the one page in the site whose session carries the admin claim. One
    click on an innocent looking "Public liability.pdf" and their code is
    calling admin functions as you.

    Only https to the project's own storage bucket gets to be a link.
    Anything else is not a link at all, and says so. */
const DOC_HOSTS = [
  'firebasestorage.googleapis.com',
  'storage.googleapis.com',
  'soundzgood-8c86f.firebasestorage.app',
];

function safeUrl(value) {
  if (!value) return null;
  let u;
  try {
    u = new URL(String(value), location.origin);
  } catch (err) {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (!DOC_HOSTS.includes(u.hostname)) return null;
  return u.href;
}

function attr(value) {
  return String(value == null ? '' : value).replace(/"/g, '&quot;');
}

function secs(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts / 1000;
  if (ts.seconds != null) return ts.seconds;
  if (typeof ts.toMillis === 'function') return ts.toMillis() / 1000;
  return 0;
}

function friendly(err) {
  const code = (err && err.code) || '';
  if (code.includes('wrong-password') || code.includes('invalid-credential')) {
    return 'Wrong email or password.';
  }
  if (code.includes('user-not-found')) return 'No account with that email.';
  if (code.includes('too-many-requests')) return 'Too many attempts. Wait a minute.';
  return (err && err.message) || String(err);
}

function money(cents) {
  if (cents == null) return '—';
  return '$' + (cents / 100).toFixed(cents % 100 ? 2 : 0);
}

function dateShort(ts) {
  const s = secs(ts);
  if (!s) return '—';
  return new Date(s * 1000).toLocaleDateString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

/*  The vendor's own name for themselves, falling back through the fields
    most likely to be filled in on a half finished application. */
function vendorName(b) {
  return (b.business && (b.business.name || b.business.contactName))
    || b.reference
    || 'Unnamed application';
}

function typePill(type) {
  const map = {
    food: ['ad-pill-red', 'Food'],
    market: ['ad-pill-blue', 'Market'],
    community: ['ad-pill-green', 'Community'],
  };
  const [cls, label] = map[type] || ['ad-pill-grey', type || '—'];
  return `<span class="ad-pill ${cls}">${esc(label)}</span>`;
}

/*  Where an application is up to. reviewStatus is the admin's decision and
    takes precedence when set; otherwise it falls back to where the booking
    itself has got to, so applications made before review existed still read
    sensibly. */
function statusPill(b) {
  const review = b.reviewStatus;
  if (review === 'declined')  return `<span class="ad-pill ad-pill-red">Declined</span>`;
  if (review === 'waitlisted')return `<span class="ad-pill ad-pill-amber">Waitlisted</span>`;
  if (review === 'approved')  return `<span class="ad-pill ad-pill-green">Approved</span>`;

  const map = {
    confirmed:       ['ad-pill-green', 'Confirmed'],
    pending_payment: ['ad-pill-amber', 'Pending'],
    draft:           ['ad-pill-grey',  'Draft'],
    cancelled:       ['ad-pill-red',   'Cancelled'],
    needs_attention: ['ad-pill-red',   'Needs attention'],
  };
  const [cls, label] = map[b.status] || ['ad-pill-grey', b.status || '—'];
  return `<span class="ad-pill ${cls}">${esc(label)}</span>`;
}

function paymentPill(b) {
  const map = {
    paid:   ['ad-pill-green', 'Paid'],
    free:   ['ad-pill-blue',  'Free'],
    unpaid: ['ad-pill-amber', 'Unpaid'],
    none:   ['ad-pill-grey',  'Not started'],
  };
  const [cls, label] = map[b.paymentStatus] || ['ad-pill-grey', b.paymentStatus || '—'];
  return `<span class="ad-pill ${cls}">${esc(label)}</span>`;
}

/*  Applications worth counting. A draft is someone who opened the form and
    wandered off - it is not an application until they have at least chosen
    a site, so drafts are kept out of the totals and the lists by default. */
function realApplications() {
  return state.bookings.filter((b) => b.status !== 'draft' || b.siteId);
}


/* =========================================================================
   THE NUMBERS

   Where the event stands: how many have applied, how many are in, who has
   paid, how much ground is left. It sits above the vendor list rather than
   on a page of its own, because every one of these numbers is a count of
   the rows underneath it - reading them apart from the list they describe
   meant holding two screens in your head.
   ========================================================================= */
function statsStrip() {
  const apps = realApplications();

  /*  Out of the running: turned away, or gone of their own accord. They
      still show in the list, but they are not pending anything and they do
      not owe anybody money, so they are kept out of those counts. */
  const isOut = (b) => bucket(b) === 'declined';
  const live = apps.filter((b) => !isOut(b));

  const confirmed = live.filter((b) => b.status === 'confirmed').length;
  const pending = live.filter((b) =>
    !b.reviewStatus && b.status !== 'confirmed').length;
  const declined = apps.filter(isOut).length;

  const paid = live.filter((b) =>
    b.paymentStatus === 'paid' || b.paymentStatus === 'free').length;
  const unpaid = live.length - paid;

  const filled = state.sites.filter((s) =>
    s.status === 'booked' || s.status === 'held').length;
  const available = state.sites.filter((s) => s.status === 'available').length;

  /*  Each card filters the list below it to the rows it counts, so a number
      that looks wrong is one click from the vendors behind it. The two site
      cards count sites rather than vendors, so they do not filter. */
  const cards = [
    ['Total applications', apps.length, 'all vendor types', '', { status: 'all', payment: 'all' }],
    ['Confirmed', confirmed, 'locked in', 'is-green', { status: 'confirmed' }],
    ['Pending review', pending, 'awaiting a decision', 'is-amber', { status: 'pending' }],
    ['Declined', declined, 'turned away or cancelled', 'is-red', { status: 'declined' }],
    ['Paid', paid, 'money received', 'is-green', { payment: 'paid' }],
    ['Unpaid', unpaid, 'still owing', 'is-amber', { payment: 'unpaid' }],
    ['Sites filled', filled, pct(filled, state.sites.length) + ' of the ground', 'is-blue', null],
    ['Sites available', available, 'still to sell', '', null],
  ];

  return `
    <div class="ad-stats">
      ${cards.map(([label, value, note, mod, filter]) => {
        const inner = `
          <p class="ad-stat-label">${esc(label)}</p>
          <p class="ad-stat-value">${value}</p>
          <p class="ad-stat-note">${esc(note)}</p>`;

        return filter
          ? `<button type="button" class="ad-stat ${mod} is-clickable"
                     data-stat="${attr(JSON.stringify(filter))}">${inner}</button>`
          : `<div class="ad-stat ${mod}">${inner}</div>`;
      }).join('')}
    </div>`;
}

function wireStats() {
  document.querySelectorAll('[data-stat]').forEach((card) => {
    card.addEventListener('click', () => {
      const want = JSON.parse(card.getAttribute('data-stat'));
      // A card sets only what it counts by and clears the rest.
      state.filters = {
        search: '',
        vendorType: 'all',
        status: want.status || 'all',
        payment: want.payment || 'all',
      };
      render();
    });
  });
}

function pct(part, whole) {
  if (!whole) return '0%';
  return Math.round((part / whole) * 100) + '%';
}

/* =========================================================================
   VENDOR AND APPLICATION LISTS

   Two rail entries, one list. Applications is the working queue - everyone
   still waiting on a decision or a payment. Vendors is the roster - who is
   actually coming. They differ only in which rows they start with, so the
   searching, filtering and detail panel below are shared.
   ========================================================================= */

/*  The bucket a row belongs in, worked out once so the filter, the pill and
    the two lists all agree on what a booking is. */
function bucket(b) {
  if (b.reviewStatus === 'declined' || b.status === 'cancelled') return 'declined';
  if (b.reviewStatus === 'waitlisted') return 'waitlisted';
  if (b.status === 'confirmed') return 'confirmed';
  if (b.reviewStatus === 'approved') return 'approved';
  return 'pending';
}

/*  Filtering to Unpaid is somebody building a chase list, so a vendor who
    was declined or has cancelled is neither paid nor unpaid - they drop out
    of both. Same rule the dashboard counts by. */
function paymentBucket(b) {
  if (b.paymentStatus === 'paid' || b.paymentStatus === 'free') return 'paid';
  if (bucket(b) === 'declined') return 'moot';
  return 'unpaid';
}

/*  Everything a person might reasonably type into the search box, flattened
    into one string per booking. */
function haystack(b) {
  const biz = b.business || {};
  return [
    biz.name, biz.contactName, biz.email, biz.phone,
    b.reference, b.categoryName, b.siteLabel, b.vendorType,
    (b.siteIds || []).join(' '),
  ].filter(Boolean).join(' ').toLowerCase();
}

function applyFilters(rows) {
  const f = state.filters;
  const term = f.search.trim().toLowerCase();

  return rows.filter((b) => {
    if (f.status !== 'all' && bucket(b) !== f.status) return false;
    if (f.vendorType !== 'all' && b.vendorType !== f.vendorType) return false;
    if (f.payment !== 'all' && paymentBucket(b) !== f.payment) return false;
    if (term && !haystack(b).includes(term)) return false;
    return true;
  });
}

const STATUS_CHOICES = [
  ['all', 'Any status'],
  ['pending', 'Pending review'],
  ['approved', 'Approved'],
  ['confirmed', 'Confirmed'],
  ['waitlisted', 'Waitlisted'],
  ['declined', 'Declined'],
];

const TYPE_CHOICES = [['all', 'Any type'], ['food', 'Food'], ['market', 'Market']];

const PAYMENT_CHOICES = [['all', 'Any payment'], ['paid', 'Paid'], ['unpaid', 'Unpaid']];

function selectField(id, choices, current) {
  return `<select id="${id}">${choices.map(([v, label]) =>
    `<option value="${attr(v)}"${v === current ? ' selected' : ''}>${esc(label)}</option>`
  ).join('')}</select>`;
}

function filterBar() {
  const f = state.filters;
  return `
    <div class="ad-filters">
      <input type="search" id="ad-search" class="ad-search"
             placeholder="Search name, email, phone, site…"
             value="${attr(f.search)}">
      ${selectField('ad-f-status', STATUS_CHOICES, f.status)}
      ${selectField('ad-f-type', TYPE_CHOICES, f.vendorType)}
      ${selectField('ad-f-payment', PAYMENT_CHOICES, f.payment)}
      <button type="button" class="ad-btn" id="ad-f-clear">Clear</button>
    </div>`;
}

function wireFilters() {
  const on = (id, key, evt) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener(evt, () => {
      state.filters[key] = el.value;
      render();
      /*  render() rebuilds the box, so put the caret back where it was or
          typing a second character would jump to the front. */
      if (evt === 'input') {
        const again = document.getElementById(id);
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      }
    });
  };

  on('ad-search', 'search', 'input');
  on('ad-f-status', 'status', 'change');
  on('ad-f-type', 'vendorType', 'change');
  on('ad-f-payment', 'payment', 'change');

  const clear = document.getElementById('ad-f-clear');
  if (clear) clear.addEventListener('click', () => {
    state.filters = { search: '', status: 'all', vendorType: 'all', payment: 'all' };
    render();
  });
}

function listTable(rows) {
  if (!rows.length) {
    return `<p class="ad-empty">Nothing matches those filters.</p>`;
  }

  return `
    <div class="ad-table-wrap">
      <table class="ad-table">
        <thead><tr>
          <th>Vendor</th><th>Type</th><th>Category</th><th>Site</th>
          <th>Status</th><th>Payment</th><th>Applied</th>
        </tr></thead>
        <tbody>
          ${rows.map((b) => `
            <tr data-open="${attr(b.id)}">
              <td>
                <span class="ad-cell-strong">${esc(vendorName(b))}</span>
                <span class="ad-cell-sub">${esc((b.business && b.business.email) || '')}</span>
              </td>
              <td>${typePill(b.vendorType)}</td>
              <td class="ad-cell-muted">${esc(b.categoryName || '—')}</td>
              <td>${esc(b.siteLabel || '—')}</td>
              <td>${statusPill(b)}</td>
              <td>${paymentPill(b)}</td>
              <td class="ad-cell-muted">${esc(dateShort(b.createdAt))}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function wireRows() {
  document.querySelectorAll('[data-open]').forEach((row) => {
    row.addEventListener('click', () => {
      state.openBookingId = row.getAttribute('data-open');
      render();
    });
  });
}

/*  Both list views are the same page with a different starting set, and
    only the one that shows everybody carries the numbers. */
function listView(title, blurb, pick, opts = {}) {
  return {
    html() {
      const rows = applyFilters(realApplications().filter(pick));
      const total = realApplications().filter(pick).length;
      const ev = state.events.find((e) => e.id === state.activeEventId);

      return `
        <div class="ad-page-head">
          <div>
            <h1>${esc(title)}</h1>
            <p>${esc(blurb)}${ev && opts.stats
              ? ' &middot; ' + esc(ev.name || ev.id) : ''}</p>
          </div>
          <div class="ad-page-actions">
            <span class="ad-count">${rows.length}${
              rows.length === total ? '' : ' of ' + total}</span>
            <button type="button" class="ad-btn ad-btn-orange" id="ad-add-open">
              Add vendor
            </button>
          </div>
        </div>

        ${opts.stats ? statsStrip() : ''}

        ${filterBar()}

        <section class="ad-card ad-panel">
          ${listTable(rows)}
        </section>

        ${addVendorForm()}
        ${detailPanel()}`;
    },

    wire() {
      if (opts.stats) wireStats();
      wireFilters();
      wireRows();
      wireAddVendor();
      wireDetail();
    },
  };
}

/* -------------------------------------------------------------------------
   Adding a vendor by hand.

   For the ones who ring up or get caught at a market rather than filling
   in the form. It asks for the least that makes a usable record - who they
   are and what kind of stall - and leaves seating and payment to the same
   drawer everyone else goes through, so there is only one way to do those.
   ------------------------------------------------------------------------- */
function addVendorForm() {
  if (!state.addingVendor) return '';

  return `
    <div class="ad-scrim" id="ad-add-scrim"></div>
    <div class="ad-modal" role="dialog" aria-label="Add a vendor">
      <form id="ad-add-form">
        <header class="ad-modal-head">
          <h2>Add a vendor</h2>
          <button type="button" class="ad-drawer-close" id="ad-add-close"
                  aria-label="Close">&times;</button>
        </header>

        <div class="ad-modal-body">
          <label for="ad-add-name">Business name</label>
          <input id="ad-add-name" required maxlength="120">

          <label for="ad-add-type">Vendor type</label>
          <select id="ad-add-type">
            <option value="food">Food</option>
            <option value="market">Market</option>
          </select>

          <label for="ad-add-contact">Contact name</label>
          <input id="ad-add-contact" maxlength="120">

          <label for="ad-add-email">Email</label>
          <input id="ad-add-email" type="email" maxlength="160">

          <label for="ad-add-phone">Phone</label>
          <input id="ad-add-phone" type="tel" maxlength="40">

          <label for="ad-add-bays">Bays</label>
          <input id="ad-add-bays" type="number" min="1" max="8" value="1">

          <label for="ad-add-desc">What they do</label>
          <textarea id="ad-add-desc" rows="3" maxlength="2000"></textarea>

          <p class="ad-action-msg" id="ad-add-msg" hidden></p>
        </div>

        <footer class="ad-modal-foot">
          <button type="button" class="ad-btn" id="ad-add-cancel">Cancel</button>
          <button type="submit" class="ad-btn ad-btn-orange">Add vendor</button>
        </footer>
      </form>
    </div>`;
}

function wireAddVendor() {
  const open = document.getElementById('ad-add-open');
  if (open) open.addEventListener('click', () => {
    state.addingVendor = true;
    render();
  });

  const close = () => { state.addingVendor = false; render(); };
  ['ad-add-close', 'ad-add-cancel', 'ad-add-scrim'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', close);
  });

  const form = document.getElementById('ad-add-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const val = (id) => (document.getElementById(id).value || '').trim();
    const msg = document.getElementById('ad-add-msg');
    const submit = form.querySelector('[type="submit"]');

    submit.disabled = true;
    msg.hidden = false;
    msg.className = 'ad-action-msg';
    msg.textContent = 'Adding…';

    try {
      const res = await call('adminCreateBooking', {
        eventId: state.activeEventId,
        vendorType: val('ad-add-type'),
        bayCount: Number(val('ad-add-bays')) || 1,
        business: {
          name: val('ad-add-name'),
          contactName: val('ad-add-contact'),
          email: val('ad-add-email'),
          phone: val('ad-add-phone'),
          description: val('ad-add-desc'),
        },
      });

      /*  Straight into their drawer - whoever added them almost always
          wants to seat them next. */
      state.addingVendor = false;
      state.openBookingId = res.bookingId;
      render();
    } catch (err) {
      msg.className = 'ad-action-msg is-bad';
      msg.textContent = friendly(err);
      submit.disabled = false;
    }
  });
}

/*  Vendors is the whole picture - everybody, with the event's numbers above
    them. Applications is the short list of people still waiting on a
    decision, so it is somewhere to work through rather than somewhere to
    look things up. Anyone already decided on is found in Vendors. */
VIEWS.vendors = listView(
  'Vendors',
  'Everyone who has applied, newest first.',
  () => true,
  { stats: true }
);

VIEWS.applications = listView(
  'Applications',
  'Still waiting on a decision.',
  (b) => ['pending', 'waitlisted'].includes(bucket(b))
);


/* =========================================================================
   DETAIL PANEL
   Slides in over the list, so the list keeps its filters and its place.

   Nothing in here writes to Firestore directly. Every button calls an
   admin Cloud Function, for the same reason the public page does: a
   decision that frees a site or takes money has to happen in one server
   side transaction, or two people clicking at once can leave the sites and
   the bookings disagreeing about who is where.
   ========================================================================= */
function row(label, value) {
  return `<div class="ad-kv"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
}

/*  Runs an admin function and shows what happened in the drawer. The live
    subscription redraws the page on its own once Firestore comes back, so
    there is nothing to refresh by hand. */
async function runAction(button, name, data) {
  const bar = document.getElementById('ad-action-msg');
  const buttons = [...document.querySelectorAll(
    '.ad-actions button, .ad-actions-row button, .ad-note-form button')];

  buttons.forEach((b) => { b.disabled = true; });
  if (button) button.classList.add('is-working');
  if (bar) { bar.hidden = false; bar.className = 'ad-action-msg'; bar.textContent = 'Working…'; }

  try {
    await call(name, data);
    if (bar) { bar.className = 'ad-action-msg is-ok'; bar.textContent = 'Saved.'; }
  } catch (err) {
    if (bar) { bar.className = 'ad-action-msg is-bad'; bar.textContent = friendly(err); }
    buttons.forEach((b) => { b.disabled = false; });
  }

  if (button) button.classList.remove('is-working');
}

function detailPanel() {
  if (!state.openBookingId) return '';

  const b = state.bookings.find((x) => x.id === state.openBookingId);
  if (!b) return '';

  const biz = b.business || {};
  const setup = b.setup || {};
  const docs = b.documents || [];
  const sites = b.siteIds && b.siteIds.length ? b.siteIds.join(', ') : (b.siteId || '');

  return `
    <div class="ad-scrim" id="ad-scrim"></div>
    <aside class="ad-drawer" id="ad-drawer" role="dialog" aria-label="Application detail">

      <header class="ad-drawer-head">
        <div>
          <h2>${esc(vendorName(b))}</h2>
          <p>${statusPill(b)} ${paymentPill(b)} ${typePill(b.vendorType)}</p>
        </div>
        <button type="button" class="ad-drawer-close" id="ad-drawer-close"
                aria-label="Close">&times;</button>
      </header>

      <div class="ad-drawer-body">

        ${actionBar(b)}

        <h3 class="ad-drawer-h">Contact</h3>
        <dl class="ad-kvs">
          ${row('Business', esc(biz.name || '—'))}
          ${row('Contact name', esc(biz.contactName || '—'))}
          ${row('Email', biz.email
            ? `<a href="mailto:${attr(biz.email)}">${esc(biz.email)}</a>` : '—')}
          ${row('Phone', biz.phone
            ? `<a href="tel:${attr(biz.phone)}">${esc(biz.phone)}</a>` : '—')}
          ${row('Socials', esc(biz.socials || '—'))}
        </dl>

        ${biz.description ? `
          <h3 class="ad-drawer-h">What they do</h3>
          <p class="ad-drawer-text">${esc(biz.description)}</p>` : ''}

        <h3 class="ad-drawer-h">Site</h3>
        ${sitePicker(b)}
        <dl class="ad-kvs">
          ${row('Category', esc(b.categoryName || '—'))}
          ${row('Assigned site', esc(b.siteLabel || 'Not assigned'))}
          ${row('Site IDs', esc(sites || '—'))}
          ${row('Bays', esc(b.bayCount || 1))}
          ${row('Frontage', esc(setup.frontage ? setup.frontage + ' m' : '—'))}
          ${row('Depth', esc(setup.depth ? setup.depth + ' m' : '—'))}
          ${row('Own power', setup.ownPower ? 'Yes' : 'No')}
          ${row('Self sufficient', setup.selfSufficient ? 'Yes' : 'No')}
          ${row('Vehicle on site', setup.vehicleOnSite ? 'Yes' : 'No')}
          ${setup.notes ? row('Notes', esc(setup.notes)) : ''}
        </dl>

        <h3 class="ad-drawer-h">Money</h3>
        <dl class="ad-kvs">
          ${row('Site fee', esc(money(b.amountCents)))}
          ${b.bookingFeeCents != null ? row('Booking fee', esc(money(b.bookingFeeCents))) : ''}
          ${b.gstCents != null ? row('GST', esc(money(b.gstCents))) : ''}
          ${row('Total', `<strong>${esc(money(
            b.totalCents != null ? b.totalCents : b.amountCents))}</strong>`)}
          ${row('Paid', esc(money(b.amountPaidCents)))}
          ${row('Reference', esc(b.reference || '—'))}
        </dl>

        <h3 class="ad-drawer-h">Documents</h3>
        ${docs.length ? `
          <ul class="ad-docs">
            ${docs.map((d) => {
              const href = safeUrl(d.url);
              const label = esc(d.name || d.type || 'Document');
              return `
              <li>
                ${href
                  ? `<a href="${attr(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
                  : `<span class="ad-doc-bad">${label}</span>
                     <span class="ad-cell-sub">Not a file we uploaded - link withheld</span>`}
                <span class="ad-cell-sub">${esc(d.type || '')}</span>
              </li>`;
            }).join('')}
          </ul>` : `<p class="ad-drawer-text ad-cell-muted">None uploaded.</p>`}

        <h3 class="ad-drawer-h">Internal notes</h3>
        ${notesBlock(b)}

        <h3 class="ad-drawer-h">History</h3>
        <dl class="ad-kvs">
          ${row('Applied', esc(dateShort(b.createdAt)))}
          ${row('Confirmed', esc(dateShort(b.confirmedAt)))}
          ${row('Last change', esc(dateShort(b.updatedAt)))}
          ${b.reviewedBy ? row('Reviewed by', esc(b.reviewedBy)) : ''}
          ${b.addedByAdmin ? row('Added by', esc(b.addedBy || 'staff')) : ''}
        </dl>

      </div>
    </aside>`;
}

/* -------------------------------------------------------------------------
   The decision and payment buttons.

   The current state is not offered back as a button - approving somebody
   who is already approved does nothing, and a row of buttons where one is
   pointless is a row you have to read twice.
   ------------------------------------------------------------------------- */
function actionBar(b) {
  const now = bucket(b);
  const paid = paymentBucket(b) === 'paid';

  const decide = [
    ['approved', 'Approve', 'ad-btn-orange'],
    ['waitlisted', 'Waitlist', ''],
    ['declined', 'Decline', 'ad-btn-danger'],
  ].filter(([value]) => value !== now);

  /*  Declining hands the site back and drops the category count, which is
      not obvious from a button called Decline, so it says so first. */
  return `
    <div class="ad-actions">
      <p class="ad-actions-h">Decision</p>
      <div class="ad-actions-row">
        ${decide.map(([value, label, cls]) => `
          <button type="button" class="ad-btn ${cls}"
                  data-decide="${attr(value)}"
                  ${value === 'declined' ? 'data-confirm="Decline this vendor? Their site goes back on the market."' : ''}>
            ${esc(label)}
          </button>`).join('')}
        ${b.reviewStatus && now !== 'confirmed' ? `
          <button type="button" class="ad-btn" data-decide="pending">Back to pending</button>` : ''}
      </div>

      <p class="ad-actions-h">Payment</p>
      <div class="ad-actions-row">
        ${!paid ? `
          <button type="button" class="ad-btn ad-btn-primary" data-pay="paid"
                  data-confirm="Mark as paid? If they are on a site this confirms their booking.">
            Mark paid
          </button>
          <button type="button" class="ad-btn" data-pay="free"
                  data-confirm="Let them in for free? If they are on a site this confirms their booking.">
            Free entry
          </button>` : `
          <button type="button" class="ad-btn" data-pay="unpaid">Mark unpaid</button>`}
      </div>

      <p class="ad-action-msg" id="ad-action-msg" hidden></p>
    </div>`;
}

/* -------------------------------------------------------------------------
   Seating. Lists the sites this vendor could actually go on: the free ones
   of the right kind, plus whatever they are already holding.
   ------------------------------------------------------------------------- */
function sitePicker(b) {
  const wantType = b.vendorType === 'food' ? 'food' : 'market';
  const theirs = new Set(b.siteIds && b.siteIds.length ? b.siteIds : (b.siteId ? [b.siteId] : []));

  const options = state.sites.filter((s) =>
    theirs.has(s.id) || (s.type === wantType && s.status === 'available'));

  if (!options.length && !theirs.size) {
    return `<p class="ad-drawer-text ad-cell-muted">No free ${esc(wantType)} sites left.</p>`;
  }

  return `
    <div class="ad-seat">
      <select id="ad-seat-pick" multiple size="${Math.min(8, Math.max(4, options.length))}"
              aria-label="Sites for this vendor">
        ${options.map((s) => `
          <option value="${attr(s.id)}"${theirs.has(s.id) ? ' selected' : ''}>
            ${esc(s.label)}${theirs.has(s.id) ? ' — theirs' : ''}
          </option>`).join('')}
      </select>
      <p class="ad-seat-hint">Ctrl or Cmd click for more than one bay.</p>
      <div class="ad-actions-row">
        <button type="button" class="ad-btn ad-btn-primary" id="ad-seat-save">Save sites</button>
        ${theirs.size ? `
          <button type="button" class="ad-btn" id="ad-seat-free"
                  data-confirm="Take their site away and leave them unseated?">
            Free their site
          </button>` : ''}
      </div>
    </div>`;
}

function notesBlock(b) {
  const notes = Array.isArray(b.notes) ? [...b.notes] : [];
  notes.sort((x, y) => secs(y.at) - secs(x.at));

  return `
    ${notes.length ? `
      <ul class="ad-notes">
        ${notes.map((n) => `
          <li>
            <p class="ad-note-text">${esc(n.text)}</p>
            <p class="ad-note-by">${esc(n.by || 'staff')} &middot; ${esc(dateShort(n.at))}</p>
          </li>`).join('')}
      </ul>` : `<p class="ad-drawer-text ad-cell-muted">No notes yet.</p>`}

    <form class="ad-note-form" id="ad-note-form">
      <textarea id="ad-note-text" rows="2"
                placeholder="Add a note - staff only, the vendor never sees this"
      >${esc(state.noteDraft)}</textarea>
      <button type="submit" class="ad-btn">Add note</button>
    </form>`;
}

function wireDetail() {
  const close = () => { state.openBookingId = null; render(); };

  const btn = document.getElementById('ad-drawer-close');
  if (btn) btn.addEventListener('click', close);

  const scrim = document.getElementById('ad-scrim');
  if (scrim) scrim.addEventListener('click', close);

  const id = state.openBookingId;
  if (!id) return;

  /*  data-confirm on a button means it does something a person would want
      to be asked about first - freeing a site, taking money. */
  const guarded = (el, run) => {
    el.addEventListener('click', () => {
      const ask = el.getAttribute('data-confirm');
      if (ask && !window.confirm(ask)) return;
      run();
    });
  };

  document.querySelectorAll('[data-decide]').forEach((el) => {
    guarded(el, () => runAction(el, 'adminReviewBooking', {
      bookingId: id, decision: el.getAttribute('data-decide'),
    }));
  });

  document.querySelectorAll('[data-pay]').forEach((el) => {
    guarded(el, () => runAction(el, 'adminSetPayment', {
      bookingId: id, paymentStatus: el.getAttribute('data-pay'),
    }));
  });

  const save = document.getElementById('ad-seat-save');
  if (save) save.addEventListener('click', () => {
    const pick = document.getElementById('ad-seat-pick');
    const chosen = [...pick.selectedOptions].map((o) => o.value);
    if (!chosen.length) {
      window.alert('Pick at least one site, or use Free their site.');
      return;
    }
    runAction(save, 'adminAssignSite', { bookingId: id, siteIds: chosen });
  });

  const free = document.getElementById('ad-seat-free');
  if (free) guarded(free, () =>
    runAction(free, 'adminAssignSite', { bookingId: id, siteIds: [] }));

  const noteForm = document.getElementById('ad-note-form');
  const noteBox = document.getElementById('ad-note-text');

  /*  A vendor saving their own page redraws this one, so a half typed note
      is kept in state and put back rather than vanishing mid-sentence. */
  if (noteBox) {
    noteBox.addEventListener('input', () => { state.noteDraft = noteBox.value; });
  }

  if (noteForm) noteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = noteBox.value.trim();
    if (!text) return;
    state.noteDraft = '';
    await runAction(noteForm.querySelector('button'), 'adminAddNote', { bookingId: id, text });
    const again = document.getElementById('ad-note-text');
    if (again) again.value = '';
  });
}

/*  Escape closes the drawer from anywhere. Registered once, not per render,
    or every redraw would stack another listener. */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.openBookingId) {
    state.openBookingId = null;
    render();
  }
});


/* =========================================================================
   MAP AND SITES

   The ground, drawn from the same x/y/w/h the public map uses, coloured by
   what is happening on each site. Clicking one opens it: who is on it, and
   the three things you can do to it - free it, block it off, or put an
   unseated vendor on it.

   This draws its own SVG rather than borrowing js/vendor-map.js. That one
   is built for a vendor choosing a stall and knows nothing about who is
   booked where; keeping them apart means a change made for the public map
   cannot quietly break this one, and the other way round.
   ========================================================================= */

const SITE_FILL = {
  available: '#e7f6ee',
  held:      '#fdf0dc',
  booked:    '#ffe3d2',
  blocked:   '#e4e6eb',
};

const SITE_EDGE = {
  available: '#0f9d58',
  held:      '#b26a00',
  booked:    '#ff6b00',
  blocked:   '#9aa1ac',
};

/*  Site status is about the ground; the words admins use are about people.
    Held by a vendor mid-checkout and held because staff seated them look
    identical on the site document, so the booking decides the wording. */
function siteWord(status) {
  return { available: 'Available', held: 'Reserved',
    booked: 'Confirmed', blocked: 'Blocked off' }[status] || status;
}

function bookingOnSite(site) {
  if (!site.bookingId) return null;
  return state.bookings.find((b) => b.id === site.bookingId) || null;
}

VIEWS.map = {
  html() {
    const ev = state.events.find((e) => e.id === state.activeEventId) || {};
    const size = ev.map || { width: 760, height: 1420 };
    const marks = ev.landmarks || [];

    const tally = { available: 0, held: 0, booked: 0, blocked: 0 };
    state.sites.forEach((s) => { tally[s.status] = (tally[s.status] || 0) + 1; });

    const selected = state.sites.find((s) => s.id === state.openSiteId);

    return `
      <div class="ad-page-head">
        <div>
          <h1>Map &amp; Sites</h1>
          <p>Click a site to see who is on it and move them.</p>
        </div>
      </div>

      <div class="ad-legend">
        ${['available', 'held', 'booked', 'blocked'].map((k) => `
          <span class="ad-legend-item">
            <span class="ad-swatch" style="background:${SITE_FILL[k]};border-color:${SITE_EDGE[k]}"></span>
            ${esc(siteWord(k))} <strong>${tally[k] || 0}</strong>
          </span>`).join('')}
      </div>

      <div class="ad-map-split">
        <div class="ad-card ad-map-wrap">
          <svg viewBox="0 0 ${size.width} ${size.height}" class="ad-map"
               role="img" aria-label="Site map">
            ${marks.map((m) => `
              <g>
                <rect x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}"
                      rx="4" class="ad-mark ad-mark-${attr(m.kind)}"></rect>
                ${m.label ? `<text x="${m.x + m.w / 2}" y="${m.y + m.h / 2 + 6}"
                      class="ad-mark-label">${esc(m.label)}</text>` : ''}
              </g>`).join('')}

            ${state.sites.map((s) => {
              const on = state.openSiteId === s.id;
              const spin = s.rotate ? ` transform="rotate(${s.rotate} ${s.x + s.w / 2} ${s.y + s.h / 2})"` : '';
              return `
                <g class="ad-site${on ? ' is-on' : ''}" data-site="${attr(s.id)}"${spin}>
                  <rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="3"
                        fill="${SITE_FILL[s.status] || '#fff'}"
                        stroke="${SITE_EDGE[s.status] || '#ccc'}"
                        stroke-width="${on ? 4 : 1.5}"></rect>
                  <text x="${s.x + s.w / 2}" y="${s.y + s.h / 2 + 5}"
                        class="ad-site-label">${esc(s.label)}</text>
                </g>`;
            }).join('')}
          </svg>
        </div>

        <aside class="ad-card ad-site-panel">
          ${selected ? sitePanel(selected) : `
            <p class="ad-empty">Pick a site on the map.</p>`}
        </aside>
      </div>`;
  },

  wire() {
    document.querySelectorAll('[data-site]').forEach((g) => {
      g.addEventListener('click', () => {
        const id = g.getAttribute('data-site');
        state.openSiteId = state.openSiteId === id ? null : id;
        render();
      });
    });

    wireSitePanel();
  },
};

function sitePanel(site) {
  const on = bookingOnSite(site);

  /*  Who could go here: anyone of the right kind who is not already seated
      somewhere. Somebody already on another site is moved from their own
      drawer instead, so a move is one action rather than a free and a
      seat that could half fail. */
  const candidates = realApplications().filter((b) =>
    bucket(b) !== 'declined' &&
    (b.vendorType === 'food' ? 'food' : 'market') === site.type &&
    !(b.siteIds && b.siteIds.length) && !b.siteId);

  return `
    <header class="ad-site-panel-head">
      <h2>${esc(site.label)}</h2>
      <span class="ad-pill ${
        site.status === 'available' ? 'ad-pill-green'
        : site.status === 'held' ? 'ad-pill-amber'
        : site.status === 'booked' ? 'ad-pill-red' : 'ad-pill-grey'
      }">${esc(siteWord(site.status))}</span>
    </header>

    <dl class="ad-kvs">
      ${row('Type', typePill(site.type))}
      ${row('Column', esc(site.column || '—'))}
      ${site.notes ? row('Notes', esc(site.notes)) : ''}
    </dl>

    ${on ? `
      <h3 class="ad-drawer-h">Who is here</h3>
      <p class="ad-site-who">
        <button type="button" class="ad-linkish" data-open-booking="${attr(on.id)}">
          ${esc(vendorName(on))}
        </button>
      </p>
      <dl class="ad-kvs">
        ${row('Contact', esc((on.business && on.business.email) || '—'))}
        ${row('Status', statusPill(on))}
        ${row('Payment', paymentPill(on))}
      </dl>
      <div class="ad-actions-row" style="margin-top:14px">
        <button type="button" class="ad-btn ad-btn-danger" id="ad-site-unseat"
                data-confirm="Take ${attr(vendorName(on))} off ${attr(site.label)}? They stay in the list, just without a site.">
          Free this site
        </button>
      </div>`
    : `
      <h3 class="ad-drawer-h">Put someone here</h3>
      ${candidates.length ? `
        <select id="ad-site-who-pick">
          <option value="">Choose a vendor…</option>
          ${candidates.map((b) => `
            <option value="${attr(b.id)}">${esc(vendorName(b))}</option>`).join('')}
        </select>
        <div class="ad-actions-row" style="margin-top:10px">
          <button type="button" class="ad-btn ad-btn-primary" id="ad-site-seat">Assign</button>
        </div>`
      : `<p class="ad-drawer-text ad-cell-muted">
           Nobody is waiting for a ${esc(site.type)} site.
         </p>`}

      <h3 class="ad-drawer-h">The site itself</h3>
      <div class="ad-actions-row">
        ${site.status === 'blocked'
          ? `<button type="button" class="ad-btn" id="ad-site-open">Put back on the market</button>`
          : `<button type="button" class="ad-btn" id="ad-site-block"
                     data-confirm="Block ${attr(site.label)} off so nobody can book it?">
               Block off
             </button>`}
      </div>`}

    <p class="ad-action-msg" id="ad-action-msg" hidden></p>`;
}

function wireSitePanel() {
  const site = state.sites.find((s) => s.id === state.openSiteId);
  if (!site) return;

  const guarded = (el, run) => el && el.addEventListener('click', () => {
    const ask = el.getAttribute('data-confirm');
    if (ask && !window.confirm(ask)) return;
    run();
  });

  const jump = document.querySelector('[data-open-booking]');
  if (jump) jump.addEventListener('click', () => {
    state.openBookingId = jump.getAttribute('data-open-booking');
    location.hash = '#/applications';
  });

  const unseat = document.getElementById('ad-site-unseat');
  guarded(unseat, () => runAction(unseat, 'adminAssignSite', {
    bookingId: site.bookingId, siteIds: [],
  }));

  const seat = document.getElementById('ad-site-seat');
  if (seat) seat.addEventListener('click', () => {
    const pick = document.getElementById('ad-site-who-pick');
    if (!pick.value) { window.alert('Choose a vendor first.'); return; }
    runAction(seat, 'adminAssignSite', { bookingId: pick.value, siteIds: [site.id] });
  });

  const block = document.getElementById('ad-site-block');
  guarded(block, () => runAction(block, 'adminSetSiteStatus', {
    eventId: state.activeEventId, siteId: site.id, status: 'blocked',
  }));

  const unblock = document.getElementById('ad-site-open');
  guarded(unblock, () => runAction(unblock, 'adminSetSiteStatus', {
    eventId: state.activeEventId, siteId: site.id, status: 'available',
  }));
}


/* =========================================================================
   EVENTS

   Every event the site has run or is about to. One of them is the active
   one, and everything else in here - the dashboard, the lists, the map -
   is about whichever that is.

   Opening and closing vendor signup lives here too, because it is a
   property of the event. Closing one stops new bookings at the point that
   matters: holdSite refuses to give out a site unless the event is open,
   so it is not just a hidden button.
   ========================================================================= */

const EVENT_WORD = {
  draft:    ['ad-pill-grey',  'Draft'],
  open:     ['ad-pill-green', 'Signup open'],
  closed:   ['ad-pill-amber', 'Signup closed'],
  archived: ['ad-pill-grey',  'Archived'],
};

function eventPill(status) {
  const [cls, label] = EVENT_WORD[status] || ['ad-pill-grey', status || '—'];
  return `<span class="ad-pill ${cls}">${esc(label)}</span>`;
}

VIEWS.events = {
  html() {
    /*  Fill counts are only known for the active event - it is the one
        whose sites and bookings are subscribed. The rest show a dash
        rather than a wrong number. */
    const activeFill = (() => {
      const filled = state.sites.filter((s) =>
        s.status === 'booked' || s.status === 'held').length;
      return { filled, total: state.sites.length };
    })();

    return `
      <div class="ad-page-head">
        <div>
          <h1>Events</h1>
          <p>Pick which event the rest of the admin is about.</p>
        </div>
        <div class="ad-page-actions">
          <button type="button" class="ad-btn ad-btn-orange" id="ad-ev-new">New event</button>
        </div>
      </div>

      ${state.events.length ? `
      <div class="ad-ev-list">
        ${state.events.map((ev) => {
          const active = ev.id === state.activeEventId;
          const fill = active
            ? `${activeFill.filled} of ${activeFill.total} sites`
            : 'Select to see';

          return `
            <article class="ad-card ad-ev${active ? ' is-active' : ''}">
              <header class="ad-ev-head">
                <div>
                  <h2>${esc(ev.name || ev.id)}</h2>
                  <p class="ad-ev-when">
                    ${esc(ev.dateLabel || ev.dateISO || 'No date set')}${
                      ev.venue ? ' &middot; ' + esc(ev.venue) : ''}
                  </p>
                </div>
                ${eventPill(ev.status)}
              </header>

              <dl class="ad-kvs">
                ${row('Id', `<code>${esc(ev.id)}</code>`)}
                ${row('Sites filled', esc(fill))}
                ${row('Food stall', esc(money(ev.pricing && ev.pricing.food)))}
                ${row('Market bay', esc(money(ev.pricing && ev.pricing.marketPerBay)))}
              </dl>

              <div class="ad-actions-row">
                ${active
                  ? `<span class="ad-pill ad-pill-blue">Active</span>`
                  : `<button type="button" class="ad-btn" data-activate="${attr(ev.id)}">
                       Make active
                     </button>`}

                <button type="button" class="ad-btn" data-edit-ev="${attr(ev.id)}">Edit</button>

                ${ev.status === 'open'
                  ? `<button type="button" class="ad-btn" data-close-ev="${attr(ev.id)}"
                             data-confirm="Close vendor signup for ${attr(ev.name || ev.id)}? Nobody new can take a site.">
                       Close signup
                     </button>`
                  : `<button type="button" class="ad-btn" data-open-ev="${attr(ev.id)}"
                             data-confirm="Open vendor signup for ${attr(ev.name || ev.id)}?">
                       Open signup
                     </button>`}
              </div>
            </article>`;
        }).join('')}
      </div>` : `<p class="ad-empty">No events yet.</p>`}

      <p class="ad-action-msg" id="ad-action-msg" hidden></p>

      ${eventForm()}`;
  },

  wire() {
    const guarded = (el, run) => el.addEventListener('click', () => {
      const ask = el.getAttribute('data-confirm');
      if (ask && !window.confirm(ask)) return;
      run();
    });

    document.querySelectorAll('[data-activate]').forEach((el) => {
      el.addEventListener('click', () => {
        setActiveEvent(el.getAttribute('data-activate'));
      });
    });

    document.querySelectorAll('[data-open-ev]').forEach((el) => guarded(el, () =>
      runAction(el, 'adminSaveEvent', {
        eventId: el.getAttribute('data-open-ev'), fields: { status: 'open' },
      })));

    document.querySelectorAll('[data-close-ev]').forEach((el) => guarded(el, () =>
      runAction(el, 'adminSaveEvent', {
        eventId: el.getAttribute('data-close-ev'), fields: { status: 'closed' },
      })));

    const newBtn = document.getElementById('ad-ev-new');
    if (newBtn) newBtn.addEventListener('click', () => {
      state.editingEvent = { creating: true };
      render();
    });

    document.querySelectorAll('[data-edit-ev]').forEach((el) => {
      el.addEventListener('click', () => {
        state.editingEvent = { id: el.getAttribute('data-edit-ev') };
        render();
      });
    });

    wireEventForm();
  },
};

/*  Switching event means new subscriptions and none of the old view's
    scratch state, which was about a different event's vendors. */
function setActiveEvent(id) {
  state.activeEventId = id;
  state.openBookingId = null;
  state.openSiteId = null;

  /*  Drop the old event's vendors and sites now rather than leaving them on
      screen until the new subscription's first snapshot lands - a moment of
      the wrong event's numbers is worse than a moment of none. */
  state.bookings = [];
  state.sites = [];
  state.categories = [];

  const picker = document.getElementById('ad-event-select');
  if (picker) picker.value = id;

  render();
  subscribeToEvent();
}

function eventForm() {
  const edit = state.editingEvent;
  if (!edit) return '';

  const ev = edit.creating
    ? {}
    : (state.events.find((e) => e.id === edit.id) || {});

  const price = ev.pricing || {};
  const dollars = (c) => (c == null ? '' : (c / 100).toFixed(2));

  return `
    <div class="ad-scrim" id="ad-ev-scrim"></div>
    <div class="ad-modal" role="dialog" aria-label="Event details">
      <form id="ad-ev-form">
        <header class="ad-modal-head">
          <h2>${edit.creating ? 'New event' : 'Edit event'}</h2>
          <button type="button" class="ad-drawer-close" id="ad-ev-close"
                  aria-label="Close">&times;</button>
        </header>

        <div class="ad-modal-body">
          ${edit.creating ? `
            <label for="ad-ev-id">Id</label>
            <input id="ad-ev-id" required maxlength="60"
                   placeholder="eatz-beatz-halloween-2027"
                   pattern="[a-z0-9][a-z0-9-]{1,60}">
            <p class="ad-seat-hint">
              Lower case, numbers and dashes. It never changes, so make it one
              you will still recognise in two years.
            </p>` : ''}

          <label for="ad-ev-name">Name</label>
          <input id="ad-ev-name" required maxlength="120" value="${attr(ev.name || '')}">

          <label for="ad-ev-subtitle">Subtitle</label>
          <input id="ad-ev-subtitle" maxlength="200" value="${attr(ev.subtitle || '')}">

          <label for="ad-ev-dateiso">Date</label>
          <input id="ad-ev-dateiso" type="date" value="${attr((ev.dateISO || '').slice(0, 10))}">

          <label for="ad-ev-datelabel">Date as written on the site</label>
          <input id="ad-ev-datelabel" maxlength="120"
                 placeholder="Saturday 31 October 2026"
                 value="${attr(ev.dateLabel || '')}">

          <label for="ad-ev-venue">Venue</label>
          <input id="ad-ev-venue" maxlength="120" value="${attr(ev.venue || '')}">

          <label for="ad-ev-location">Location</label>
          <input id="ad-ev-location" maxlength="200" value="${attr(ev.location || '')}">

          <label for="ad-ev-status">Vendor signup</label>
          <select id="ad-ev-status">
            ${Object.keys(EVENT_WORD).map((k) => `
              <option value="${attr(k)}"${
                (ev.status || 'draft') === k ? ' selected' : ''}>${esc(EVENT_WORD[k][1])}</option>`
            ).join('')}
          </select>

          <label for="ad-ev-food">Food stall price</label>
          <input id="ad-ev-food" type="number" min="0" step="0.01"
                 value="${attr(dollars(price.food))}">

          <label for="ad-ev-market">Market bay price</label>
          <input id="ad-ev-market" type="number" min="0" step="0.01"
                 value="${attr(dollars(price.marketPerBay))}">

          <label for="ad-ev-bays">Most bays one market vendor may take</label>
          <input id="ad-ev-bays" type="number" min="1" max="20"
                 value="${attr(ev.maxMarketBays == null ? 8 : ev.maxMarketBays)}">

          <label for="ad-ev-hold">Minutes a site is held during checkout</label>
          <input id="ad-ev-hold" type="number" min="1" max="240"
                 value="${attr(ev.holdMinutes == null ? 10 : ev.holdMinutes)}">

          ${edit.creating ? `
            <p class="ad-seat-hint" style="margin-top:14px">
              This creates the event only. Laying out its sites is a separate
              step - a new event usually wants a different map, and stamping
              the Bowen layout on it would be a guess.
            </p>` : ''}

          <p class="ad-action-msg" id="ad-ev-msg" hidden></p>
        </div>

        <footer class="ad-modal-foot">
          <button type="button" class="ad-btn" id="ad-ev-cancel">Cancel</button>
          <button type="submit" class="ad-btn ad-btn-orange">
            ${edit.creating ? 'Create event' : 'Save changes'}
          </button>
        </footer>
      </form>
    </div>`;
}

function wireEventForm() {
  const edit = state.editingEvent;
  if (!edit) return;

  const close = () => { state.editingEvent = null; render(); };
  ['ad-ev-close', 'ad-ev-cancel', 'ad-ev-scrim'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', close);
  });

  const form = document.getElementById('ad-ev-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const val = (id) => {
      const el = document.getElementById(id);
      return el ? el.value.trim() : '';
    };
    // Money is entered in dollars and stored in cents, as everywhere else.
    const cents = (id) => Math.round(Number(val(id) || 0) * 100);

    const msg = document.getElementById('ad-ev-msg');
    const submit = form.querySelector('[type="submit"]');

    submit.disabled = true;
    msg.hidden = false;
    msg.className = 'ad-action-msg';
    msg.textContent = 'Saving…';

    const id = edit.creating ? val('ad-ev-id') : edit.id;

    try {
      await call('adminSaveEvent', {
        eventId: id,
        create: !!edit.creating,
        fields: {
          name: val('ad-ev-name'),
          subtitle: val('ad-ev-subtitle'),
          dateISO: val('ad-ev-dateiso'),
          dateLabel: val('ad-ev-datelabel'),
          venue: val('ad-ev-venue'),
          location: val('ad-ev-location'),
          status: val('ad-ev-status'),
          maxMarketBays: Number(val('ad-ev-bays')) || 8,
          holdMinutes: Number(val('ad-ev-hold')) || 10,
          pricing: { food: cents('ad-ev-food'), marketPerBay: cents('ad-ev-market') },
        },
      });

      state.editingEvent = null;
      await loadEvents();
      if (edit.creating) setActiveEvent(id);
      else render();
    } catch (err) {
      msg.className = 'ad-action-msg is-bad';
      msg.textContent = friendly(err);
      submit.disabled = false;
    }
  });
}


/* =========================================================================
   SETTINGS

   The two things the old /soundzgoodadminlogin page could do that nothing
   else in here could: category limits, and laying out an event's ground.
   Both are per-event and both are rare - you set them up once and mostly
   leave them - so they live together away from the daily work.
   ========================================================================= */
VIEWS.settings = {
  html() {
    const ev = state.events.find((e) => e.id === state.activeEventId) || {};

    /*  Food and market categories share one table, so the list says which
        is which rather than leaving you to guess from the name. */
    const ordered = [...state.categories].sort((a, b) =>
      (a.appliesTo || '').localeCompare(b.appliesTo || '') ||
      (a.name || '').localeCompare(b.name || ''));

    return `
      <div class="ad-page-head">
        <div>
          <h1>Settings</h1>
          <p>${esc(ev.name || state.activeEventId || 'No event selected')}</p>
        </div>
      </div>

      <section class="ad-card ad-panel" style="margin-bottom:16px">
        <header class="ad-panel-head">
          <h2>Vendor categories</h2>
        </header>

        <div class="ad-panel-intro">
          <p>
            How many of each kind of vendor may come. Raise a limit and the
            category reopens on its own - the signup page compares the live
            count against the limit, so there is nothing else to switch back on.
          </p>
        </div>

        ${ordered.length ? `
          <div class="ad-table-wrap">
            <table class="ad-table">
              <thead><tr>
                <th>Category</th><th>For</th><th>Booked</th><th>Limit</th><th></th>
              </tr></thead>
              <tbody>
                ${ordered.map((c) => {
                  const count = c.count || 0;
                  const full = c.limit != null && count >= c.limit;
                  return `
                    <tr>
                      <td class="ad-cell-strong">${esc(c.name)}</td>
                      <td>${typePill(c.appliesTo)}</td>
                      <td class="ad-cell-muted">${count}</td>
                      <td>
                        <input type="number" min="0" class="ad-limit"
                               value="${attr(c.limit == null ? '' : c.limit)}"
                               data-limit="${attr(c.id)}"
                               aria-label="Limit for ${attr(c.name)}">
                      </td>
                      <td>
                        <span class="ad-pill ${full ? 'ad-pill-red' : 'ad-pill-green'}">
                          ${full ? 'Full' : 'Open'}
                        </span>
                      </td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>` : `
          <p class="ad-empty">
            No categories yet. Lay out the event below and they come with it.
          </p>`}
      </section>

      <section class="ad-card ad-panel">
        <header class="ad-panel-head">
          <h2>Event layout</h2>
        </header>

        <div class="ad-panel-intro">
          <p>
            Creates this event's sites and food categories from the default
            Bowen Sports Complex layout. Safe to run more than once - it adds
            what is missing and never overwrites what is there, so it cannot
            wipe a site somebody is already booked on.
          </p>
          <p class="ad-cell-muted">
            Currently ${state.sites.length} site${state.sites.length === 1 ? '' : 's'}
            and ${state.categories.length}
            categor${state.categories.length === 1 ? 'y' : 'ies'}.
          </p>

          <div class="ad-actions-row" style="margin-top:12px">
            <button type="button" class="ad-btn ad-btn-primary" id="ad-seed">
              Lay out this event
            </button>
          </div>

          <p class="ad-action-msg" id="ad-action-msg" hidden></p>
        </div>
      </section>`;
  },

  wire() {
    /*  A limit is saved on change rather than behind a Save button - there
        is one number per row and no way to get it half right. */
    document.querySelectorAll('[data-limit]').forEach((input) => {
      input.addEventListener('change', async () => {
        const bar = document.getElementById('ad-action-msg');
        input.disabled = true;

        try {
          await call('adminSetCategoryLimit', {
            eventId: state.activeEventId,
            categoryId: input.getAttribute('data-limit'),
            limit: Number(input.value),
          });
          if (bar) { bar.hidden = false; bar.className = 'ad-action-msg is-ok'; bar.textContent = 'Limit saved.'; }
        } catch (err) {
          if (bar) { bar.hidden = false; bar.className = 'ad-action-msg is-bad'; bar.textContent = friendly(err); }
        }

        input.disabled = false;
      });
    });

    const seed = document.getElementById('ad-seed');
    if (!seed) return;

    seed.addEventListener('click', async () => {
      if (!window.confirm('Lay out this event from the default layout? Nothing already there is overwritten.')) return;

      const bar = document.getElementById('ad-action-msg');
      seed.disabled = true;
      bar.hidden = false;
      bar.className = 'ad-action-msg';
      bar.textContent = 'Working…';

      try {
        const d = await call('seedEvent', { eventId: state.activeEventId });
        bar.className = 'ad-action-msg is-ok';
        bar.textContent =
          `${d.eventCreated ? 'Event created. ' : 'Event already existed. '}` +
          `Added ${d.addedSites} site${d.addedSites === 1 ? '' : 's'} and ` +
          `${d.addedCats} categor${d.addedCats === 1 ? 'y' : 'ies'}.`;
      } catch (err) {
        bar.className = 'ad-action-msg is-bad';
        bar.textContent = friendly(err);
      }

      seed.disabled = false;
    });
  },
};


/*  Handy when something looks wrong in here: __sgAdmin.state shows exactly
    what the page thinks it has, and render() redraws from it. Everything it
    touches is already on screen for a signed in admin, so it gives away
    nothing that was not visible anyway. */
window.__sgAdmin = { state, VIEWS, call, render };
