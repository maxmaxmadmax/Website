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
} from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

/* -------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */
const state = {
  user: null,
  view: 'dashboard',

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
    state.activeEventId = ev.target.value;
    subscribeToEvent();
    render();
  });

  window.addEventListener('hashchange', routeFromHash);
}

/* -------------------------------------------------------------------------
   Routing
   ------------------------------------------------------------------------- */
const BUILT = ['dashboard', 'events', 'vendors', 'applications', 'map'];

function routeFromHash() {
  const want = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
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
   DASHBOARD
   ========================================================================= */
VIEWS.dashboard = {
  html() {
    const apps = realApplications();
    const ev = state.events.find((e) => e.id === state.activeEventId);

    /*  Out of the running: turned away, or gone of their own accord. They
        still show in the lists, but they are not pending anything and they
        do not owe anybody money, so they are kept out of those counts. */
    const isOut = (b) => b.reviewStatus === 'declined' || b.status === 'cancelled';
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

    const cards = [
      ['Total applications', apps.length, 'all vendor types', ''],
      ['Confirmed', confirmed, 'locked in', 'is-green'],
      ['Pending review', pending, 'awaiting a decision', 'is-amber'],
      ['Declined', declined, 'turned away or cancelled', 'is-red'],
      ['Paid', paid, 'money received', 'is-green'],
      ['Unpaid', unpaid, 'still owing', 'is-amber'],
      ['Sites filled', filled, pct(filled, state.sites.length) + ' of the ground', 'is-blue'],
      ['Sites available', available, 'still to sell', ''],
    ];

    const recent = apps.slice(0, 8);

    return `
      <div class="ad-page-head">
        <div>
          <h1>Dashboard</h1>
          <p>${ev ? esc(ev.name || ev.id) : 'No event selected'}${
            ev && ev.dateLabel ? ' &middot; ' + esc(ev.dateLabel) : ''}</p>
        </div>
      </div>

      <div class="ad-stats">
        ${cards.map(([label, value, note, mod]) => `
          <div class="ad-stat ${mod}">
            <p class="ad-stat-label">${esc(label)}</p>
            <p class="ad-stat-value">${value}</p>
            <p class="ad-stat-note">${esc(note)}</p>
          </div>`).join('')}
      </div>

      <section class="ad-card ad-panel">
        <header class="ad-panel-head">
          <h2>Recent applications</h2>
          <button type="button" class="ad-btn" data-goto="vendors">View all</button>
        </header>
        ${recent.length ? `
        <div class="ad-table-wrap">
          <table class="ad-table">
            <thead><tr>
              <th>Vendor</th><th>Type</th><th>Site</th>
              <th>Status</th><th>Payment</th><th>Date</th>
            </tr></thead>
            <tbody>
              ${recent.map((b) => `
                <tr data-open="${attr(b.id)}">
                  <td>
                    <span class="ad-cell-strong">${esc(vendorName(b))}</span>
                    <span class="ad-cell-sub">${esc((b.business && b.business.email) || '')}</span>
                  </td>
                  <td>${typePill(b.vendorType)}</td>
                  <td>${esc(b.siteLabel || '—')}</td>
                  <td>${statusPill(b)}</td>
                  <td>${paymentPill(b)}</td>
                  <td class="ad-cell-muted">${esc(dateShort(b.createdAt))}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : `<p class="ad-empty">No applications yet.</p>`}
      </section>`;
  },

  wire() {
    const all = document.querySelector('[data-goto="vendors"]');
    if (all) all.addEventListener('click', () => { location.hash = '#/vendors'; });

    document.querySelectorAll('[data-open]').forEach((row) => {
      row.addEventListener('click', () => {
        state.openBookingId = row.getAttribute('data-open');
        location.hash = '#/vendors';
      });
    });
  },
};

function pct(part, whole) {
  if (!whole) return '0%';
  return Math.round((part / whole) * 100) + '%';
}

/*  Handy when something looks wrong in here: __sgAdmin.state shows exactly
    what the page thinks it has, and render() redraws from it. Everything it
    touches is already on screen for a signed in admin, so it gives away
    nothing that was not visible anyway. */
window.__sgAdmin = { state, VIEWS, call, render };
