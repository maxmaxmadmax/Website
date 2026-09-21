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
} from './firebase-config.js?v=133';

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

  /*  Which DJ is on which Friday, keyed by date. Filled in when the
      settings view is opened - it is four lines of data and nothing
      else on the desk needs it.                                     */
  /*  The roster and the schedule, for the Entertainment view. Loaded on
      arrival there rather than kept in sync everywhere.             */
  talent: [],
  schedule: [],

  /*  The bookings desk: which month the calendar is on, which booking the
      panel is showing, whether it is being edited, and the filters under
      the table.                                                       */
  bookMonth: new Date(),
  bookingOpen: null,
  bookEditing: false,
  bookDraft: {},
  bookFilter: { text: '', tab: 'upcoming' },
  showRoster: false,
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

  /*  The estimate bot. Leads stream in from the whole site (not one event),
      and the price table is loaded once and edited in the Quote Pricing
      view. quotePricing is null until loaded, so the editor shows the
      built-in default until Max has saved his own.                        */
  quoteLeads: [],
  quotePricing: null,
  quoteFilter: { search: '', status: 'all' },
  openLeadId: null,

  /*  The equipment inventory / price list. Loaded live so the Inventory
      page and the bot never disagree. null until first load.            */
  inventory: null,
  openInvId: null,                                  // which item's detail is open
  invFilter: { search: '', category: 'all', location: 'all', status: 'all' },
  invPage: 1,
  invSort: { key: '', dir: 'asc' },                 // '' = default (category, then name)
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
    subscribeToQuoteLeads();
    subscribeToInventory();
    loadQuotePricing();
    routeFromHash();
  });
}

async function loadFirebase() {
  const [{ initializeApp }, auth, firestore, functions, storage] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
    import(`${SDK}/firebase-functions.js`),
    import(`${SDK}/firebase-storage.js`),
  ]);

  const app = initializeApp(firebaseConfig);
  return {
    auth: auth.getAuth(app),
    db: firestore.getFirestore(app),
    fns: functions.getFunctions(app, functionsRegion),
    storage: storage.getStorage(app),
    a: auth,
    f: firestore,
    fn: functions,
    st: storage,
  };
}

/*  The act types, in the order they are offered. Same keys the
    entertainment page uses.                                            */
const ACT_LABELS = {
  dj: 'DJ',
  solo: 'Solo Artist',
  band: 'Band',
  mc: 'MC / Host',
  kids: 'Kids Entertainment',
};

function prettyDate(iso) {
  const p = String(iso || '').split('-');
  if (p.length !== 3) return iso || '';
  return new Date(+p[0], +p[1] - 1, +p[2])
    .toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/*  The roster as the site sees it: the built-in list in js/roster.js with
    whatever is saved in Firestore merged over it. Read through roster.js
    rather than queried here, so the desk and the site can never disagree
    about who is on the books.                                          */
async function loadTalent() {
  try {
    /*  SG_ROSTER_READY is a promise that has already resolved by now on a
        second visit, so it is re-fetched rather than reused - an act
        added a minute ago has to appear.                              */
    const { collection, getDocs } = fb.f;
    const snap = await getDocs(collection(fb.db, 'talent'));

    const saved = {};
    snap.forEach((doc) => { saved[doc.id] = doc.data(); });

    const bySlug = {};
    (window.SG_ROSTER_BUILT_IN || []).forEach((t) => { bySlug[t.slug] = { ...t }; });

    Object.keys(saved).forEach((slug) => {
      const t = saved[slug];
      if (t.hidden) { delete bySlug[slug]; return; }
      bySlug[slug] = {
        slug,
        name: t.name || slug,
        act: t.act || (bySlug[slug] || {}).act || 'dj',
        photo: t.photo || (bySlug[slug] || {}).photo || '',
      };
    });

    state.talent = Object.keys(bySlug).map((k) => bySlug[k]);
  } catch (err) {
    state.talent = (window.SG_ROSTER_BUILT_IN || []).slice();
  }
}

async function loadSchedule() {
  try {
    const { collection, getDocs } = fb.f;
    const snap = await getDocs(collection(fb.db, 'talentSchedule'));

    const rows = [];
    snap.forEach((doc) => rows.push({ id: doc.id, ...doc.data() }));

    /*  Everything, past included - the table can show past bookings and
        the calendar can be paged back into them. The filters decide what
        is on screen, not the loader.                                   */
    state.schedule = rows
      .filter((r) => r.date)
      .sort((x, y) => x.date.localeCompare(y.date));
  } catch (err) {
    state.schedule = [];
  }
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

  /*  The Vendors group opens and shuts. It is a button rather than a
      link because it goes nowhere - the items inside it do.        */
  document.querySelectorAll('[data-group-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.ad-nav-group');
      if (!group) return;
      const open = group.classList.toggle('is-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });

  const toggle = document.getElementById('ad-rail-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      document.getElementById('ad-rail').classList.toggle('is-open');
    });
  }

  window.addEventListener('hashchange', routeFromHash);
}

/* -------------------------------------------------------------------------
   Routing
   ------------------------------------------------------------------------- */
const BUILT = ['events', 'vendors', 'applications', 'map', 'entertainment',
               'settings', 'vendorEmail', 'quotes', 'inventory', 'botSettings'];

/*  Vendors is where the work is, so it is what you land on. */
const HOME = 'vendors';

function routeFromHash() {
  const want = (location.hash.replace('#/', '') || HOME).split('?')[0];
  state.view = want;
  state.openBookingId = null;

  document.querySelectorAll('[data-view]').forEach((b) =>
    b.classList.toggle('is-active', b.getAttribute('data-view') === want));

  render();

  /*  Settings is the only view that needs the Friday line up, so it is
      fetched on arrival rather than kept in sync all the time. Drawn
      again once it lands - the panel is already on screen by then, with
      its dropdowns unset for the half second it takes.                */
  if (want === 'entertainment') {
    Promise.all([loadTalent(), loadSchedule()])
      .then(() => { if (state.view === 'entertainment') render(); });
  }
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

/*  ESTIMATE-BOT LEADS

    Not tied to an event - a quote can come in for anything - so this is its
    own subscription, set up once at sign-in and left running. Newest first,
    the way the table wants them.                                          */
function subscribeToQuoteLeads() {
  const { collection, onSnapshot, query, orderBy } = fb.f;
  unsubscribes.push(onSnapshot(
    query(collection(fb.db, 'quoteLeads'), orderBy('createdAt', 'desc')),
    (snap) => {
      state.quoteLeads = [];
      snap.forEach((d) => state.quoteLeads.push({ id: d.id, ...d.data() }));
      if (state.view === 'quotes') render();
    },
    (err) => console.error('quoteLeads', err)
  ));
}

/*  The saved price table, loaded once for the editor. Null stays null on a
    miss, and the editor falls back to the built-in default, so a fresh site
    with no saved table still shows something to edit.                     */
async function loadQuotePricing() {
  try {
    const { doc, getDoc } = fb.f;
    const snap = await getDoc(doc(fb.db, 'config', 'quotePricing'));
    if (snap.exists()) state.quotePricing = snap.data();
  } catch (err) {
    console.error('quotePricing', err);
  }
  if (state.view === 'botSettings') render();
}

/*  The equipment inventory, live. Feeds both the Equipment page and, once
    saved, the bot. Ordered by category then name so the page reads tidily. */
function subscribeToInventory() {
  const { collection, onSnapshot } = fb.f;
  unsubscribes.push(onSnapshot(
    collection(fb.db, 'inventory'),
    (snap) => {
      const items = [];
      snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
      items.sort((a, b) =>
        (a.category || '').localeCompare(b.category || '')
        || (a.order || 0) - (b.order || 0)
        || (a.name || '').localeCompare(b.name || ''));
      state.inventory = items;
      /*  Never rebuild the whole view while a detail panel is open - that
          would wipe whatever the user is part-way through typing. Refresh
          only the table; the open panel is left exactly as it is.        */
      if (state.view === 'inventory') {
        if (state.openInvId) renderInvRows();
        else render();
      }
    },
    (err) => console.error('inventory', err)
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

  /*  The bookings view lays itself out to the height of the desk rather
      than to its content, so the desk has to know it is showing it. */
  desk.classList.toggle('is-bookings', state.view === 'entertainment');
  desk.classList.toggle('show-roster',
    state.view === 'entertainment' && state.showRoster);

  /*  The page can only be one screen tall if the shell is, and that is
      three boxes above the desk - see the note in admin.css.         */
  document.body.classList.toggle('ad-fit',
    state.view === 'entertainment' && !state.showRoster);

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
/*  An event id turned into its name, for anywhere an application is read
    on its own. Falls back to the id, which is readable enough.        */
function eventNameOf(id) {
  if (!id) return 'No event';
  const ev = state.events.find((e) => e.id === id);
  return (ev && ev.name) || id;
}

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

          <!--  Which event this application is for. The list is already
                filtered to one event by the picker at the top of the
                page, but an application is a thing somebody reads on its
                own - in a drawer, or over a shoulder - and it should say
                what it belongs to without relying on what is selected
                three feet away.                                     -->
          <p class="ad-drawer-event">${esc(eventNameOf(b.eventId))}</p>
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
          ${row('FAQs read', (setup.readFaqs ?? setup.selfSufficient) ? 'Yes' : 'No')}
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

/*  What the desk calls each status. The vendor signup page has its own
    wording for the four it shows - EVENT_STATUS in js/vendor-signup.js.

    draft and archived never appear on the signup page at all. They are
    how an event is worked on before it opens, or put away afterwards. */
const EVENT_WORD = {
  draft:    ['ad-pill-grey',  'Draft (hidden)'],
  soon:     ['ad-pill-blue',  'Coming soon'],
  open:     ['ad-pill-green', 'Accepting vendors'],
  limited:  ['ad-pill-amber', 'Limited spots'],
  closed:   ['ad-pill-amber', 'Applications closed'],
  archived: ['ad-pill-grey',  'Archived (hidden)'],
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

          <!--  Shown on the event card on the vendor signup page. A path
                to a file in the site, like images/events/eatz-beatz.jpg.
                Left blank, the card shows its gradient.            -->
          <label for="ad-ev-image">Card image</label>
          <input id="ad-ev-image" maxlength="200"
                 placeholder="images/events/name.jpg"
                 value="${attr(ev.image || '')}">

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
          image: val('ad-ev-image'),
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
/* -------------------------------------------------------------------------
   ENTERTAINMENT - DJ BOOKINGS

   Who is playing where, on a month at a glance, with the roster underneath
   it.

   WHAT IS REAL HERE
   Every control on this page does something. There is no Send Details
   button, because the mail path is still not working and a button that
   silently does nothing is worse than no button; no Create Poster, because
   there is nothing behind it. When either becomes true they go in.

   WHERE IT IS KEPT
     talent/{slug}                  an act. See the note on the roster
                                    panel below for how it merges with the
                                    built-in list in js/roster.js.
     talentSchedule/{date__slug}    one booking. The id is made from the
                                    two, so booking the same act on the
                                    same night twice edits rather than
                                    duplicates, while two different acts on
                                    one night are still two bookings.

   The events page reads the same schedule for its Friday Nights cards, so
   a booking made here is on the site within the minute.
   ------------------------------------------------------------------------- */
VIEWS.entertainment = {
  html() {
    const acts = state.talent;
    const all = state.schedule;

    const today = isoDay(new Date());
    const upcoming = all.filter((b) => b.date >= today);
    const confirmed = upcoming.filter((b) => (b.status || 'confirmed') === 'confirmed');
    const pending = upcoming.filter((b) => b.status === 'pending');

    /*  What the right hand panel is showing. Defaults to the next booking
        there is, so the page opens on something rather than on a prompt. */
    const picked = state.bookingOpen
      ? all.find((b) => b.id === state.bookingOpen)
      : upcoming[0];

    const shown = filteredBookings();

    return `
      <div class="ad-page-head">
        <div>
          <h1>DJ Bookings</h1>
          <p>Who is playing at the Grand View Hotel and everywhere else.</p>
        </div>

        <div class="ad-page-actions">
          <!--  The roster is reference rather than the day's work, and it
                is the thing that stops this page fitting on a screen. So
                it is folded away, and this opens it.                 -->
          <button type="button" class="ad-btn" id="ad-roster-toggle">
            ${state.showRoster ? 'Hide the roster' : 'The roster'}
          </button>

          <button type="button" class="ad-btn ad-btn-orange" id="ad-book-new">
            + New booking
          </button>
        </div>
      </div>

      <div class="ad-bstats">
        ${statTile('Upcoming Shows', upcoming.length, '', 'blue')}
        ${statTile('Confirmed', confirmed.length, '', 'green')}
        ${statTile('Pending', pending.length, '', 'amber')}
        ${statTile('Acts on Roster', acts.length, '', 'grey')}
      </div>

      ${importBanner()}

      <div class="ad-book-split">
        ${calendarHtml()}
        ${bookingPanel(picked)}
      </div>

      <section class="ad-card ad-book-list">

        <div class="ad-book-tabs">
          <div class="ad-tabs" role="group" aria-label="Which bookings">
            ${BOOK_TABS.map((t) => `
              <button type="button" class="ad-tab${state.bookFilter.tab === t.key ? ' is-on' : ''}"
                      data-book-tab="${attr(t.key)}">${esc(t.label)}</button>`).join('')}
          </div>

          <input type="search" id="ad-book-search" class="ad-book-search"
                 placeholder="Search bookings…" value="${attr(state.bookFilter.text)}"
                 aria-label="Search bookings">
        </div>
        ${shown.length ? `
          <div class="ad-table-wrap">
            <table class="ad-table">
              <thead><tr>
                <th>Date</th><th>Act</th><th>Venue</th><th>Time</th><th>Status</th><th></th>
              </tr></thead>
              <tbody>
                ${shown.map((b) => {
                  const act = state.talent.find((t) => t.slug === b.slug) || {};
                  const status = b.status || 'confirmed';
                  return `
                    <tr data-book-open="${attr(b.id)}">
                      <td class="ad-cell-strong">${esc(prettyDate(b.date))}</td>
                      <td>
                        <span class="ad-act">
                          <span class="ad-act-face"
                                style="${act.photo ? `background-image:url('/${attr(act.photo)}')` : ''}"></span>
                          ${esc(act.name || b.slug)}
                        </span>
                      </td>
                      <td class="ad-cell-muted">${esc(b.venue || '—')}</td>
                      <td class="ad-cell-muted">${esc(b.time || '—')}</td>
                      <td>
                        <span class="ad-pill ${status === 'pending' ? 'ad-pill-amber' : 'ad-pill-green'}">
                          ${status === 'pending' ? 'Pending' : 'Confirmed'}
                        </span>
                      </td>
                      <td>
                        <button type="button" class="ad-btn ad-btn-danger"
                                data-book-remove="${attr(b.id)}">Remove</button>
                      </td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>` : `
          <p class="ad-empty">Nothing matches that.</p>`}
      </section>

      ${rosterPanel(acts)}`;
  },

  wire() { wireEntertainment(); },
};


/*  The month grid. Monday first, because that is how a week is read here,
    and every day carries a dot for each booking on it so the shape of the
    month is legible without reading a word.                             */
function calendarHtml() {
  const cursor = state.bookMonth;
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();

  /*  getDay() is Sunday-first; this shifts it so Monday starts the row. */
  const lead = (first.getDay() + 6) % 7;
  const today = isoDay(new Date());

  const cells = [];
  /*  The days before the first, drawn greyed rather than left as holes -
      a row with a gap in it does not read as a week.                  */
  const before = new Date(cursor.getFullYear(), cursor.getMonth(), 0).getDate();
  for (let i = lead; i > 0; i--) {
    cells.push('<div class="ad-cal-day is-empty"><span class="ad-cal-num">' +
               (before - i + 1) + '</span></div>');
  }

  for (let d = 1; d <= days; d++) {
    const iso = isoDay(new Date(cursor.getFullYear(), cursor.getMonth(), d));
    const on = state.schedule.filter((b) => b.date === iso);

    cells.push(`
      <div class="ad-cal-day${iso === today ? ' is-today' : ''}${on.length ? ' has-booking' : ''}"
           ${on.length ? `data-book-open="${attr(on[0].id)}"` : ''}>
        <span class="ad-cal-num">${d}</span>
        ${on.map((b) => {
          const act = state.talent.find((t) => t.slug === b.slug) || {};
          return `<span class="ad-cal-act ${(b.status || 'confirmed') === 'pending' ? 'is-pending' : ''}">${esc(act.name || b.slug)}</span>`;
        }).join('')}
      </div>`);
  }

  return `
    <section class="ad-card ad-cal">
      <header class="ad-cal-head">
        <h2>${esc(cursor.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }))}</h2>
        <div class="ad-cal-nav">
          <button type="button" class="ad-btn" data-cal="-1" aria-label="Previous month">‹</button>
          <button type="button" class="ad-btn" data-cal="0">Today</button>
          <button type="button" class="ad-btn" data-cal="1" aria-label="Next month">›</button>
        </div>
      </header>

      <div class="ad-cal-grid">
        ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
          .map((d) => `<div class="ad-cal-name">${d}</div>`).join('')}
        ${cells.join('')}
      </div>
    </section>`;
}

/*  The one booking being looked at. Doubles as the editor: the same panel
    fills in for a new booking, so there is one form on the page rather
    than one to add and another to change.                               */
function bookingPanel(b) {
  const acts = state.talent;
  const editing = state.bookEditing;

  if (!b && !editing) {
    return `
      <section class="ad-card ad-book-panel">
        <div class="ad-book-photo" aria-hidden="true"
             style="background-image:url('/images/venues/grand-view-hotel.jpg')"></div>
        <div class="ad-book-inner">
          <h3>Nothing booked yet</h3>
          <p class="ad-cell-muted">
            New booking puts one in, or pick a night on the calendar.
          </p>
        </div>
      </section>`;
  }

  if (editing) {
    const draft = state.bookDraft;
    return `
      <section class="ad-card ad-book-panel">
        <h3>${draft.id ? 'Edit booking' : 'New booking'}</h3>

        <label class="ad-field">Date
          <input type="date" id="ad-f-date" value="${attr(draft.date || '')}">
        </label>

        <label class="ad-field">Act
          <select id="ad-f-act">
            ${acts.map((t) => `
              <option value="${attr(t.slug)}"${draft.slug === t.slug ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}
          </select>
        </label>

        <label class="ad-field">Venue
          <input type="text" id="ad-f-venue" value="${attr(draft.venue || 'Grand View Hotel, Bowen')}">
        </label>

        <label class="ad-field">Time
          <input type="text" id="ad-f-time" value="${attr(draft.time || '9:30 PM – Late')}">
        </label>

        <label class="ad-field">Status
          <select id="ad-f-status">
            <option value="confirmed"${draft.status !== 'pending' ? ' selected' : ''}>Confirmed</option>
            <option value="pending"${draft.status === 'pending' ? ' selected' : ''}>Pending</option>
          </select>
        </label>

        <!--  A residency is the same act on the same night for weeks at a
              time, which is most of this diary. Booking it a week at a
              time is the same eight clicks over and over.            -->
        <label class="ad-field">Repeat
          <select id="ad-f-repeat">
            ${REPEATS.map((r) => `
              <option value="${r.weeks}">${esc(r.label)}</option>`).join('')}
          </select>
        </label>

        <label class="ad-field">Notes
          <textarea id="ad-f-notes" rows="2">${esc(draft.notes || '')}</textarea>
        </label>

        <div class="ad-actions-row" style="margin-top:12px">
          <button type="button" class="ad-btn ad-btn-primary" id="ad-f-save">Save booking</button>
          <button type="button" class="ad-btn" id="ad-f-cancel">Cancel</button>
        </div>

        <p class="ad-action-msg" id="ad-book-msg" hidden></p>
      </section>`;
  }

  const act = acts.find((t) => t.slug === b.slug) || {};
  const status = b.status || 'confirmed';
  const photo = venuePhoto(b.venue);

  return `
    <section class="ad-card ad-book-panel">
      ${photo ? `<div class="ad-book-photo" aria-hidden="true"
                      style="background-image:url('/${attr(photo)}')"></div>` : ''}

      <div class="ad-book-inner">
        <div class="ad-book-head">
          <div>
            <h3>${esc(prettyDate(b.date))}</h3>
            <span class="ad-pill ${status === 'pending' ? 'ad-pill-amber' : 'ad-pill-green'}">
              ${status === 'pending' ? 'Pending' : 'Confirmed'}
            </span>
          </div>

          <button type="button" class="ad-btn" data-book-edit="${attr(b.id)}">Edit</button>
        </div>

        <div class="ad-book-split-2">
          <dl class="ad-book-facts">
            <dt>${ICON.act}Act</dt>
            <dd>
              <span class="ad-act">
                <span class="ad-act-face"
                      style="${act.photo ? `background-image:url('/${attr(act.photo)}')` : ''}"></span>
                ${esc(act.name || b.slug)}
              </span>
            </dd>

            <dt>${ICON.time}Time</dt><dd>${esc(b.time || '—')}</dd>
            <dt>${ICON.place}Venue</dt><dd>${esc(b.venue || '—')}</dd>
            ${b.notes ? `<dt>${ICON.note}Notes</dt><dd>${esc(b.notes)}</dd>` : ''}
          </dl>

          <div class="ad-book-actions">
            <!--  Opens the mail app with the booking already written out.
                  A real thing that works today - the site cannot send mail
                  itself yet, and a button that silently sends nothing would
                  be worse than this.                                    -->
            <a class="ad-btn ad-btn-primary" href="${attr(mailtoFor(b, act))}">
              Send details
            </a>

            <!--  Puts the same act on the same night next week, which is
                  what a residency is and most of this diary.          -->
            <button type="button" class="ad-btn" data-book-repeat="${attr(b.id)}">
              Repeat next week
            </button>

            <button type="button" class="ad-btn ad-btn-danger" data-book-remove="${attr(b.id)}">
              Remove
            </button>
          </div>
        </div>

        <p class="ad-action-msg" id="ad-book-msg" hidden></p>
      </div>
    </section>`;
}

/*  Small icons for the facts list. Inline rather than a font or a sprite:
    there are four of them and they never change.                      */
const ICON = {
  act: '<svg viewBox="0 0 24 24"><circle cx="6.5" cy="17" r="3"/><circle cx="16.5" cy="15" r="3"/><path d="M9 17V6l10.5-2v11"/></svg>',
  time: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/></svg>',
  place: '<svg viewBox="0 0 24 24"><path d="M12 21s7-7 7-11a7 7 0 10-14 0c0 4 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  note: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>',
};

/*  The booking, written out for whoever is playing it. mailto rather than
    a send, because the mail path is not working yet - this opens their own
    mail app with it all filled in, which needs nothing from us.        */
function mailtoFor(b, act) {
  const lines = [
    `Act: ${act.name || b.slug}`,
    `Date: ${prettyDate(b.date)}`,
    `Time: ${b.time || 'TBC'}`,
    `Venue: ${b.venue || 'TBC'}`,
    b.notes ? `Notes: ${b.notes}` : '',
    '',
    'SoundzGood Events & Production',
  ].filter(Boolean).join('\n');

  return 'mailto:?subject=' +
    encodeURIComponent(`Booking - ${act.name || b.slug}, ${prettyDate(b.date)}`) +
    '&body=' + encodeURIComponent(lines);
}
function rosterPanel(acts) {
  return `
    <section class="ad-card ad-panel ad-roster">
      <header class="ad-panel-head">
        <h2>The roster</h2>
      </header>

      <div class="ad-panel-intro">
        <p>
          Everyone bookable. An act added here shows on the entertainment
          page and in the booking form straight away.
        </p>
        <p class="ad-cell-muted">
          The photograph is a path to a file in the site, like
          images/talent/maxzi.jpg. Leave it blank and the card shows its
          gradient.
        </p>
      </div>

      ${acts.length ? `
        <div class="ad-table-wrap">
          <table class="ad-table">
            <thead><tr><th>Name</th><th>Act</th><th>Photo</th><th></th></tr></thead>
            <tbody>
              ${acts.map((t) => `
                <tr>
                  <td class="ad-cell-strong">
                    <span class="ad-act">
                      <span class="ad-act-face"
                            style="${t.photo ? `background-image:url('/${attr(t.photo)}')` : ''}"></span>
                      ${esc(t.name)}
                    </span>
                  </td>
                  <td>${esc(ACT_LABELS[t.act] || t.act || '')}</td>
                  <td class="ad-cell-muted">${t.photo ? esc(t.photo) : '—'}</td>
                  <td>
                    <button type="button" class="ad-btn ad-btn-danger"
                            data-act-remove="${attr(t.slug)}">Remove</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<p class="ad-empty">No acts yet.</p>'}

      <div class="ad-panel-intro" style="border-top:1px solid var(--ad-line)">
        <p><strong>Add an act</strong></p>

        <div class="ad-actions-row" style="flex-wrap:wrap;gap:10px;margin-top:10px">
          <input type="text" id="ad-act-name" placeholder="Name" aria-label="Act name">
          <select id="ad-act-type" aria-label="Act type">
            ${Object.keys(ACT_LABELS).map((k) => `
              <option value="${attr(k)}">${esc(ACT_LABELS[k])}</option>`).join('')}
          </select>
          <input type="text" id="ad-act-photo" style="min-width:230px"
                 placeholder="images/talent/name.jpg (optional)" aria-label="Photo path">
          <button type="button" class="ad-btn ad-btn-primary" id="ad-act-add">Add act</button>
        </div>

        <p class="ad-action-msg" id="ad-act-msg" hidden></p>
      </div>
    </section>`;
}

/*  The four counts. An icon in a tinted square, the number, then what it
    counts - read in that order at a glance, which is the only way a row of
    numbers like this is ever read.                                      */
function statTile(label, value, note, tone) {
  return `
    <div class="ad-bstat">
      <span class="ad-bstat-icon is-${tone}" aria-hidden="true">${STAT_ICONS[tone] || ''}</span>
      <span class="ad-bstat-text">
        <span class="ad-bstat-value">${value}</span>
        <span class="ad-bstat-label">${esc(label)}</span>
      </span>
    </div>`;
}

const STAT_ICONS = {
  blue: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  green: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>',
  amber: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/></svg>',
  grey: '<svg viewBox="0 0 24 24"><circle cx="9" cy="9" r="3.2"/><path d="M3.5 19c0-3 2.4-4.8 5.5-4.8s5.5 1.8 5.5 4.8"/><circle cx="17" cy="10" r="2.6"/><path d="M15 19c0-2.2 1.3-3.6 3.2-3.6S21.4 16.8 21.4 19"/></svg>',
};

/*  A photograph of the venue, where we have one. The pub is the whole
    point of most of this diary, so the panel leads with it rather than
    with a line of text saying where it is.                              */
const VENUE_PHOTOS = {
  'grand view': 'images/venues/grand-view-hotel.jpg',
};

function venuePhoto(venue) {
  const key = Object.keys(VENUE_PHOTOS)
    .find((k) => String(venue || '').toLowerCase().includes(k));
  return key ? VENUE_PHOTOS[key] : '';
}

/*  The four ways of looking at the diary, as the tabs across the top of
    the table. Venue tabs match loosely, so "Grand View Hotel, Bowen" and
    "Grand View" are the same pub.                                     */
/*  How many weeks a booking can be laid down in one go. Twenty-six is
    half a year, which is longer than any pub has ever committed to a
    residency - and everything laid down is editable one night at a time
    afterwards, so a long run costs nothing if it changes.             */
const REPEATS = [
  { weeks: 1, label: 'Just this night' },
  { weeks: 4, label: 'Weekly, 4 weeks' },
  { weeks: 8, label: 'Weekly, 8 weeks' },
  { weeks: 13, label: 'Weekly, 3 months' },
  { weeks: 26, label: 'Weekly, 6 months' },
];

const BOOK_TABS = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'all', label: 'All Bookings' },
  { key: 'grand-view', label: 'Grand View Hotel' },
  { key: 'other', label: 'Other Venues' },
];


function importable() {
  const inFile = window.SG_FRIDAY_SEED || {};
  const have = {};
  state.schedule.forEach((b) => { have[b.date] = true; });

  return Object.keys(inFile)
    .filter((date) => !have[date])
    .map((date) => ({ date, slug: inFile[date] }));
}

function importBanner() {
  const waiting = importable();
  if (!waiting.length) return '';

  return `
    <div class="ad-import">
      <p>
        <strong>${waiting.length} booking${waiting.length === 1 ? '' : 's'}
        set in the site file</strong> —
        ${waiting.map((w) => {
          const act = state.talent.find((t) => t.slug === w.slug) || {};
          return esc((act.name || w.slug) + ' on ' + prettyDate(w.date));
        }).join(', ')}.
        They show on the site but this page cannot edit or count them.
      </p>

      <button type="button" class="ad-btn ad-btn-primary" id="ad-import">
        Move into the diary
      </button>
    </div>`;
}
function venuesKnown() {
  const seen = {};
  state.schedule.forEach((b) => { if (b.venue) seen[b.venue] = true; });
  return Object.keys(seen).sort();
}

function filteredBookings() {
  const today = isoDay(new Date());
  const f = state.bookFilter;
  const text = (f.text || '').trim().toLowerCase();

  return state.schedule.filter((b) => {
    const atPub = /grand view/i.test(b.venue || '');

    if (f.tab === 'upcoming' && b.date < today) return false;
    if (f.tab === 'grand-view' && !atPub) return false;
    if (f.tab === 'other' && atPub) return false;

    if (text) {
      const act = state.talent.find((t) => t.slug === b.slug) || {};
      const hay = ((act.name || b.slug) + ' ' + (b.venue || '')).toLowerCase();
      if (hay.indexOf(text) < 0) return false;
    }
    return true;
  });
}
function isoDay(d) {
  return d.getFullYear() + '-' +
         String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
}

function bookingId(date, slug) {
  return date + '__' + slug;
}

/* ---- wiring ---------------------------------------------------------- */
function wireEntertainment() {
  const say = (id, text, ok) => {
    const bar = document.getElementById(id);
    if (!bar) return;
    bar.hidden = false;
    bar.className = 'ad-action-msg ' + (ok ? 'is-ok' : 'is-bad');
    bar.textContent = text;
  };

  /* the month */
  document.querySelectorAll('[data-cal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const step = parseInt(btn.getAttribute('data-cal'), 10);
      state.bookMonth = step === 0
        ? new Date()
        : new Date(state.bookMonth.getFullYear(), state.bookMonth.getMonth() + step, 1);
      render();
    });
  });

  /* opening one */
  document.querySelectorAll('[data-book-open]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-book-remove]')) return;
      state.bookingOpen = el.getAttribute('data-book-open');
      state.bookEditing = false;
      render();
    });
  });

  /* new / edit / cancel */
  const fresh = document.getElementById('ad-book-new');
  if (fresh) {
    fresh.addEventListener('click', () => {
      state.bookDraft = { date: '', slug: (state.talent[0] || {}).slug || '', status: 'confirmed' };
      state.bookEditing = true;
      render();
    });
  }

  document.querySelectorAll('[data-book-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const b = state.schedule.find((x) => x.id === btn.getAttribute('data-book-edit'));
      if (!b) return;
      state.bookDraft = { ...b };
      state.bookEditing = true;
      render();
    });
  });

  const cancel = document.getElementById('ad-f-cancel');
  if (cancel) {
    cancel.addEventListener('click', () => {
      state.bookEditing = false;
      render();
    });
  }

  const save = document.getElementById('ad-f-save');
  if (save) {
    save.addEventListener('click', async () => {
      const date = document.getElementById('ad-f-date').value;
      const slug = document.getElementById('ad-f-act').value;

      if (!date) { say('ad-book-msg', 'Pick a date.', false); return; }
      if (!slug) { say('ad-book-msg', 'Pick an act.', false); return; }

      const base = {
        slug,
        venue: document.getElementById('ad-f-venue').value.trim(),
        time: document.getElementById('ad-f-time').value.trim(),
        status: document.getElementById('ad-f-status').value,
        notes: document.getElementById('ad-f-notes').value.trim(),
      };

      const weeks = parseInt(document.getElementById('ad-f-repeat').value, 10) || 1;

      save.disabled = true;

      try {
        const old = state.bookDraft.id;
        const made = [];

        /*  One write per night. A batch would be tidier, but this is at
            most twenty-six of them once in a while, and doing them one at
            a time means a failure halfway leaves the nights already
            written standing rather than rolling the lot back.        */
        const p = date.split('-');
        for (let i = 0; i < weeks; i++) {
          const night = isoDay(new Date(+p[0], +p[1] - 1, +p[2] + (i * 7)));
          const id = bookingId(night, slug);

          await fb.f.setDoc(fb.f.doc(fb.db, 'talentSchedule', id), {
            ...base,
            date: night,
            updatedAt: fb.f.serverTimestamp(),
          });

          made.push({ id, date: night });
        }

        /*  Moving a booking to another night or another act changes its
            id, so the one it used to be has to go or there would be two. */
        if (old && !made.some((m) => m.id === old)) {
          await fb.f.deleteDoc(fb.f.doc(fb.db, 'talentSchedule', old));
        }
        await loadSchedule();
        state.bookEditing = false;
        state.bookingOpen = made[0].id;
        render();

        say('ad-book-msg', made.length === 1
          ? 'Saved.'
          : `${made.length} nights booked, through ${prettyDate(made[made.length - 1].date)}.`,
          true);
      } catch (err) {
        say('ad-book-msg', friendly(err), false);
        save.disabled = false;
      }
    });
  }

  document.querySelectorAll('[data-book-repeat]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const b = state.schedule.find((x) => x.id === btn.getAttribute('data-book-repeat'));
      if (!b) return;

      const p = b.date.split('-');
      const next = new Date(+p[0], +p[1] - 1, +p[2] + 7);
      const date = isoDay(next);

      btn.disabled = true;

      try {
        await fb.f.setDoc(fb.f.doc(fb.db, 'talentSchedule', bookingId(date, b.slug)), {
          date, slug: b.slug, venue: b.venue || '', time: b.time || '',
          status: b.status || 'confirmed', notes: b.notes || '',
          updatedAt: fb.f.serverTimestamp(),
        });

        await loadSchedule();
        state.bookingOpen = bookingId(date, b.slug);
        render();
        say('ad-book-msg', 'Booked for ' + prettyDate(date) + '.', true);
      } catch (err) {
        say('ad-book-msg', friendly(err), false);
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-book-remove]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = btn.getAttribute('data-book-remove');
      if (!window.confirm('Remove this booking?')) return;

      btn.disabled = true;

      try {
        await fb.f.deleteDoc(fb.f.doc(fb.db, 'talentSchedule', id));
        if (state.bookingOpen === id) state.bookingOpen = null;
        await loadSchedule();
        render();
      } catch (err) {
        say('ad-book-msg', friendly(err), false);
        btn.disabled = false;
      }
    });
  });

  /* filters */
  const search = document.getElementById('ad-book-search');
  if (search) {
    search.addEventListener('input', () => {
      state.bookFilter.text = search.value;
      render();
      const again = document.getElementById('ad-book-search');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    });
  }

  document.querySelectorAll('[data-book-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.bookFilter.tab = btn.getAttribute('data-book-tab');
      render();
    });
  });
  const imp = document.getElementById('ad-import');
  if (imp) {
    imp.addEventListener('click', async () => {
      const waiting = importable();
      imp.disabled = true;

      try {
        for (const w of waiting) {
          await fb.f.setDoc(fb.f.doc(fb.db, 'talentSchedule', w.date + '__' + w.slug), {
            date: w.date,
            slug: w.slug,
            venue: 'Grand View Hotel, Bowen',
            time: '9:30 PM – Late',
            status: 'confirmed',
            notes: '',
            updatedAt: fb.f.serverTimestamp(),
          });
        }

        await loadSchedule();
        render();
      } catch (err) {
        window.alert(friendly(err));
        imp.disabled = false;
      }
    });
  }

  /* the roster */
  const rosterBtn = document.getElementById('ad-roster-toggle');
  if (rosterBtn) {
    rosterBtn.addEventListener('click', () => {
      state.showRoster = !state.showRoster;
      render();
    });
  }

  const add = document.getElementById('ad-act-add');
  if (add) {
    add.addEventListener('click', async () => {
      const name = document.getElementById('ad-act-name').value.trim();
      const act = document.getElementById('ad-act-type').value;
      const photo = document.getElementById('ad-act-photo').value.trim();

      if (!name) { say('ad-act-msg', 'Give the act a name.', false); return; }

      /*  The slug is made from the name rather than asked for. It is the
          id of the row and nobody should have to think about it.       */
      const slug = name.toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);

      if (!slug) { say('ad-act-msg', 'That name has no letters or numbers in it.', false); return; }

      add.disabled = true;

      try {
        await fb.f.setDoc(fb.f.doc(fb.db, 'talent', slug), {
          name, act, photo, hidden: false, updatedAt: fb.f.serverTimestamp(),
        });
        await loadTalent();
        render();
        say('ad-act-msg', name + ' added.', true);
      } catch (err) {
        say('ad-act-msg', friendly(err), false);
        add.disabled = false;
      }
    });
  }

  document.querySelectorAll('[data-act-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slug = btn.getAttribute('data-act-remove');
      const act = state.talent.find((t) => t.slug === slug) || {};

      if (!window.confirm('Remove ' + (act.name || slug) + ' from the roster?')) return;

      btn.disabled = true;

      try {
        /*  An act that exists only in js/roster.js has no row to delete,
            so it is marked hidden and the merge there drops it.        */
        await fb.f.setDoc(fb.f.doc(fb.db, 'talent', slug), {
          name: act.name || slug, hidden: true, updatedAt: fb.f.serverTimestamp(),
        }, { merge: true });

        await loadTalent();
        render();
        say('ad-act-msg', (act.name || slug) + ' removed.', true);
      } catch (err) {
        say('ad-act-msg', friendly(err), false);
        btn.disabled = false;
      }
    });
  });
}


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
      </section>

      <section class="ad-card ad-panel" style="margin-top:16px">
        <header class="ad-panel-head">
          <h2>Gig guide</h2>
        </header>

        <div class="ad-panel-intro">
          <p>
            The gig guide finds what is on around Bowen and the Whitsundays
            by itself, at four every morning, by reading the event data other
            listing sites publish for machines. This button does that run now
            rather than waiting for the morning - worth pressing after adding
            a source, or when something has just been announced.
          </p>
          <p class="ad-cell-muted">
            It reads only the pages that have changed since the last run, so
            it usually takes a few seconds. The very first run has nothing to
            compare against and takes about five minutes.
          </p>

          <div class="ad-actions-row" style="margin-top:12px">
            <button type="button" class="ad-btn ad-btn-primary" id="ad-sync-gigs">
              Refresh the gig guide
            </button>
          </div>

          <p class="ad-action-msg" id="ad-gig-msg" hidden></p>
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

    /*  The gig guide run. Slow enough that the button has to say so - a
        cold run is five minutes, and a button that looks stuck for five
        minutes gets pressed again.                                      */
    const sync = document.getElementById('ad-sync-gigs');
    if (sync) {
      sync.addEventListener('click', async () => {
        const bar = document.getElementById('ad-gig-msg');
        sync.disabled = true;
        bar.hidden = false;
        bar.className = 'ad-action-msg';
        bar.textContent = 'Looking… this can take a few minutes the first time.';

        try {
          const d = await call('syncGigGuideNow', {});
          bar.className = 'ad-action-msg is-ok';
          bar.textContent =
            `${d.events} event${d.events === 1 ? '' : 's'} listed` +
            ` (${d.pagesRead} page${d.pagesRead === 1 ? '' : 's'} read,` +
            ` ${d.fromCache} unchanged` +
            `${d.removed ? `, ${d.removed} removed` : ''}).` +
            `${d.errors && d.errors.length ? ` ${d.errors.length} source problem${d.errors.length === 1 ? '' : 's'}: ${d.errors[0]}` : ''}`;
        } catch (err) {
          bar.className = 'ad-action-msg is-bad';
          bar.textContent = friendly(err);
        }

        sync.disabled = false;
      });
    }

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

/* =========================================================================
   VENDOR EMAILS

   The email a vendor gets after paying. It used to live as HTML inside a
   Cloud Function, which meant changing "Cheers" to "Thanks" was a code
   change and a deploy.

   It is stored on the event rather than globally, so a Halloween market and
   a school fete can sound like themselves. An event with nothing saved
   sends the built-in invoice, which is what the badge at the top reports.

   The body is a contenteditable box rather than a textarea full of HTML:
   this is writing a letter, not markup. The placeholder list drops {{tags}}
   in at the cursor, and the preview fills them with sample details so what
   is on screen is what arrives.
   ========================================================================= */

/*  Must match placeholders() in functions/lib/email.js. A tag added there
    belongs here too, or it will work and nobody will know it exists.   */
const EMAIL_TAGS = [
  ['vendor_name',   'Vendor contact name'],
  ['business_name', 'Business name'],
  ['event_name',    'Event name'],
  ['event_date',    'Event date'],
  ['event_venue',   'Where it is'],
  ['site_type',     'Food Vendor or Market Stall'],
  ['site_number',   'Site number'],
  ['amount_paid',   'Total paid, including GST'],
  ['vendor_email',  'Vendor email address'],
  ['reference',     'Booking reference'],
];

/*  What the preview pretends a booking looks like. */
const EMAIL_SAMPLE = {
  vendor_name: 'Jess',
  business_name: 'Test Kitchen Co',
  site_type: 'Food Vendor',
  site_number: 'F12',
  amount_paid: '$115.49',
  vendor_email: 'jess@example.com',
  reference: 'TEST-0001',
};

/*  The wording an event starts with - the one that was in the Cloud
    Function - so opening this screen and pressing Save changes nothing. */
function defaultVendorEmail() {
  return {
    subject: 'Your vendor site is confirmed - {{event_name}}',
    body: [
      '<p>Hi {{vendor_name}},</p>',
      '<p>Great news! Your vendor site for <strong>{{event_name}}</strong> has been confirmed and payment has been received.</p>',
      '<ul>',
      '<li><strong>Event:</strong> {{event_name}}</li>',
      '<li><strong>Date:</strong> {{event_date}}</li>',
      '<li><strong>Site number:</strong> {{site_number}}</li>',
      '<li><strong>Site type:</strong> {{site_type}}</li>',
      '<li><strong>Amount paid:</strong> {{amount_paid}}</li>',
      '</ul>',
      "<p>We're excited to have you on board and can't wait to see what you bring to the event.</p>",
      '<p>Further event information, bump in times and site details will be sent closer to the date. If you have any questions in the meantime, just reply to this email.</p>',
      '<p>Cheers,<br><strong>The SoundzGood Team</strong></p>',
    ].join(''),
  };
}

function savedVendorEmail() {
  const ev = state.events.find((e) => e.id === state.activeEventId) || {};
  const saved = ev.vendorEmail || {};
  const custom = Boolean(String(saved.subject || '').trim() && String(saved.body || '').trim());
  return { ev: ev, saved: saved, custom: custom, tpl: custom ? saved : defaultVendorEmail() };
}

VIEWS.vendorEmail = {
  html() {
    const s = savedVendorEmail();
    const when = vendorEmailWhen(s.saved);

    return `
      <div class="ad-mail-head-row">
        <span class="ad-mail-icon" aria-hidden="true">&#9993;</span>
        <div class="ad-mail-title">
          <h1>Vendor Email Template</h1>
          <p>Edit the confirmation email sent to vendors after successful payment via Stripe.</p>
        </div>
        <div class="ad-mail-status">
          <span class="ad-pill ${s.custom ? 'ad-pill-green' : 'ad-pill-blue'}">
            ${s.custom ? 'Active' : 'Built-in email'}
          </span>
          ${when ? `<p class="ad-mail-when">Last updated ${esc(when)}</p>` : ''}
        </div>
      </div>

      <div class="ad-mail-grid">
        <section class="ad-card ad-panel">
          <div class="ad-field">
            <label for="ad-mail-subject">Email Subject</label>
            <input type="text" id="ad-mail-subject" value="${attr(s.tpl.subject)}">
          </div>

          <div class="ad-field">
            <label for="ad-mail-body">Email Body</label>

            <div class="ad-mail-tools" role="toolbar" aria-label="Formatting">
              <select id="ad-mail-block" aria-label="Text style">
                <option value="p">Paragraph</option>
                <option value="h2">Heading</option>
              </select>
              <span class="ad-mail-tools-sep" aria-hidden="true"></span>
              <button type="button" data-cmd="bold" title="Bold"><b>B</b></button>
              <button type="button" data-cmd="italic" title="Italic"><i>I</i></button>
              <button type="button" data-link title="Add a link">&#128279;</button>
              <button type="button" data-cmd="insertUnorderedList" title="Bulleted list">&bull;</button>
              <button type="button" data-cmd="insertOrderedList" title="Numbered list">1.</button>
              <button type="button" data-cmd="outdent" title="Less indent">&#8676;</button>
              <button type="button" data-cmd="indent" title="More indent">&#8677;</button>
              <span class="ad-mail-tools-sep" aria-hidden="true"></span>
              <button type="button" data-html title="Edit the HTML">&lt;&gt;</button>
            </div>

            <div class="ad-mail-body" id="ad-mail-body" contenteditable="true"></div>
          </div>

          <!--  The placeholders sit under the body rather than in a column
                of their own: they belong to the thing being written, and
                as a side panel they pushed the preview off the screen. -->
          <div class="ad-tagbar">
            <p class="ad-tagbar-head">Available Placeholders</p>
            <p class="ad-tagbar-sub">Click to insert into your email.</p>
            <div class="ad-tagbar-chips">
              ${EMAIL_TAGS.map(function (pair) {
                return `<button type="button" data-tag="${attr(pair[0])}"
                                title="${attr(pair[1])}">{{${esc(pair[0])}}}</button>`;
              }).join('')}
            </div>
          </div>

          <div class="ad-actions-row">
            <button type="button" class="ad-btn ad-btn-primary" id="ad-mail-save">
              Save Template
            </button>
            <button type="button" class="ad-btn" id="ad-mail-preview-btn">Preview Email</button>
            <button type="button" class="ad-btn" id="ad-mail-test">Send Test Email</button>
            ${s.custom
              ? '<button type="button" class="ad-btn" id="ad-mail-reset">Use the built-in one</button>'
              : ''}
          </div>

          <p class="ad-action-msg" id="ad-mail-msg" hidden></p>
        </section>

        <aside class="ad-card ad-panel ad-mail-side">
          <header class="ad-panel-head">
            <h2>Preview Email</h2>
          </header>
          <div class="ad-panel-intro">
            <p>This is an example of how the email will look to the vendor.</p>
          </div>


          <div class="ad-mail-preview" id="ad-mail-preview"></div>
        </aside>
      </div>

      <!--  WHO GOT ONE

            Every paid booking for this event and whether their
            confirmation went out. It is the answer to "did Jess get her
            email", which until now meant reading the Cloud Function logs.
            -->
      <section class="ad-card ad-panel ad-mail-vendors">
        <header class="ad-panel-head">
          <div>
            <h2>Vendors</h2>
            <p class="ad-panel-sub">View payment and email status.</p>
          </div>
          <input type="search" id="ad-mail-search" class="ad-search"
                 placeholder="Search vendors..." aria-label="Search vendors">
        </header>

        <div class="ad-table-wrap">
          <table class="ad-table ad-mail-table">
            <thead>
              <tr>
                <th>Name</th><th>Business</th><th>Site</th><th>Amount</th>
                <th>Payment status</th><th>Email status</th><th></th>
              </tr>
            </thead>
            <tbody id="ad-mail-rows"></tbody>
          </table>
        </div>
      </section>
    `;
  },

  wire() { wireVendorEmail(); },
};

/*  When the template was last saved, in words. The stamp comes back from
    Firestore as a Timestamp, or as nothing at all on an event nobody has
    touched.                                                           */
function vendorEmailWhen(saved) {
  const at = saved && saved.updatedAt;
  if (!at) return '';

  const d = typeof at.toDate === 'function' ? at.toDate() : new Date(at);
  if (isNaN(d)) return '';

  return d.toLocaleString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/*  THE VENDOR ROWS

    Paid bookings for this event, with what we know about their email.
    emailStatus is written by the server when it sends one; a booking from
    before that existed has none, which reads as "not sent" - true as far
    as this page can tell, and the Send button is there either way.    */
function vendorEmailRows() {
  const paid = (state.bookings || []).filter(function (b) {
    return b.eventId === state.activeEventId
        && (b.status === 'confirmed' || b.paymentStatus === 'paid'
            || b.paymentStatus === 'free');
  });

  const term = (document.getElementById('ad-mail-search') || {}).value || '';
  const needle = term.trim().toLowerCase();

  return paid.filter(function (b) {
    if (!needle) return true;
    const biz = b.business || {};
    return [biz.name, biz.contactName, biz.email, b.siteLabel]
      .filter(Boolean).join(' ').toLowerCase().includes(needle);
  });
}

function emailStatusCell(b) {
  const at = b.emailAt || b.confirmationEmailAt;
  const when = at ? vendorEmailWhen({ updatedAt: at }) : '';

  if (b.emailStatus === 'sent' || (!b.emailStatus && at)) {
    return '<span class="ad-dot ad-dot-green"></span> Sent'
      + (when ? ' <span class="ad-cell-muted">' + esc(when) + '</span>' : '');
  }

  if (b.emailStatus === 'failed') {
    return '<span class="ad-dot ad-dot-red"></span> Failed'
      + (when ? ' <span class="ad-cell-muted">' + esc(when) + '</span>' : '');
  }

  return '<span class="ad-dot"></span> <span class="ad-cell-muted">Not sent</span>';
}

function renderVendorEmailRows() {
  const host = document.getElementById('ad-mail-rows');
  if (!host) return;

  const rows = vendorEmailRows();

  if (!rows.length) {
    host.innerHTML = '<tr><td colspan="7" class="ad-cell-muted">'
      + 'No paid vendors for this event yet.</td></tr>';
    return;
  }

  host.innerHTML = rows.map(function (b) {
    const biz = b.business || {};
    const everSent = b.emailStatus === 'sent' || b.emailStatus === 'failed'
      || b.emailAt || b.confirmationEmailAt;

    return `
      <tr>
        <td class="ad-cell-strong">${esc(biz.contactName || '')}</td>
        <td>${esc(biz.name || '')}</td>
        <td>${esc(b.siteLabel || '')}</td>
        <td>${esc(money(b.totalCents != null ? b.totalCents : b.amountCents))}</td>
        <td><span class="ad-dot ad-dot-green"></span> Paid</td>
        <td>${emailStatusCell(b)}</td>
        <td class="ad-cell-right">
          <button type="button" class="ad-btn ad-btn-small" data-resend="${attr(b.id)}">
            ${everSent ? 'Resend Email' : 'Send Email'}
          </button>
        </td>
      </tr>`;
  }).join('');

  host.querySelectorAll('[data-resend]').forEach(function (btn) {
    btn.addEventListener('click', function () { resendVendorEmail(btn); });
  });
}

async function resendVendorEmail(btn) {
  const id = btn.getAttribute('data-resend');
  const was = btn.textContent;

  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    const res = await call('adminResendVendorEmail', { bookingId: id });

    if (res && res.vendor) {
      btn.textContent = 'Sent';
    } else {
      const why = (res && res.errors && res.errors.length)
        ? res.errors.join(' | ')
        : ((res && res.reason) || 'no reason given');
      btn.textContent = was;
      btn.disabled = false;
      window.alert('It did not send.\n\n' + why);
      return;
    }

    /*  Nothing to reload: bookings are a live listener, so the row
        redraws itself the moment the server writes the status.     */
  } catch (err) {
    btn.textContent = was;
    btn.disabled = false;
    window.alert(err.message || 'Could not send that.');
  }
}


/*  WHAT IS IN THE BOXES RIGHT NOW

    Bookings are a live listener that calls render(), and render() rebuilds
    this whole screen - so a vendor paying while Max is halfway through a
    sentence used to wipe the sentence. Every keystroke is kept here, and
    the screen reads from it, so a redraw puts back what was there.

    Cleared when the template is saved, or when the event changes, because
    at that point it is no longer unsaved work.                        */
let mailDraft = null;

function mailDraftFor(eventId) {
  return mailDraft && mailDraft.eventId === eventId ? mailDraft : null;
}

function wireVendorEmail() {
  const subject = document.getElementById('ad-mail-subject');
  const body = document.getElementById('ad-mail-body');
  const preview = document.getElementById('ad-mail-preview');
  const msg = document.getElementById('ad-mail-msg');
  if (!subject || !body) return;

  const s = savedVendorEmail();
  const kept = mailDraftFor(state.activeEventId);

  if (kept) subject.value = kept.subject;
  body.innerHTML = kept ? kept.body : s.tpl.body;

  const say = function (text, bad) {
    if (!msg) return;
    msg.textContent = text || '';
    msg.hidden = !text;
    msg.classList.toggle('is-bad', Boolean(bad));
  };

  const remember = function () {
    mailDraft = {
      eventId: state.activeEventId,
      subject: subject.value,
      body: body.innerHTML,
    };
  };

  /* ---- the preview ------------------------------------------------------ */
  const paint = function () {
    if (!preview) return;

    const values = Object.assign({}, EMAIL_SAMPLE, {
      event_name: s.ev.name || 'Your event',
      event_date: s.ev.dateLabel || s.ev.dateISO || 'The date',
      event_venue: [s.ev.venue, s.ev.location].filter(Boolean).join(', '),
    });

    const swap = function (html) {
      return String(html || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, function (whole, key) {
        const v = values[key.toLowerCase()];
        return v === undefined ? whole : esc(v);
      });
    };

    preview.innerHTML =
      '<div class="ad-mail-shell">' +
        '<div class="ad-mail-brand">' +
          '<span class="ad-mail-brand-name">SoundzGood</span>' +
          '<span class="ad-mail-brand-sub">Events &middot; Production &middot; Hire</span>' +
        '</div>' +
        '<div class="ad-mail-inner">' + swap(body.innerHTML) + '</div>' +
      '</div>';
  };

  const onEdit = function () { remember(); paint(); };

  paint();
  subject.addEventListener('input', onEdit);
  body.addEventListener('input', onEdit);

  /* ---- formatting -------------------------------------------------------- */
  /*  mousedown, not click: pressing a button takes focus, and taking focus
      collapses the selection the command was meant to act on.          */
  const keepSelection = function (el) {
    el.addEventListener('mousedown', function (e) { e.preventDefault(); });
  };

  const cmds = document.querySelectorAll('.ad-mail-tools [data-cmd]');
  for (let i = 0; i < cmds.length; i++) {
    (function (btn) {
      keepSelection(btn);
      btn.addEventListener('click', function () {
        document.execCommand(btn.getAttribute('data-cmd'), false, null);
        body.focus();
        onEdit();
      });
    }(cmds[i]));
  }

  const block = document.getElementById('ad-mail-block');
  if (block) {
    keepSelection(block);
    block.addEventListener('change', function () {
      document.execCommand('formatBlock', false, block.value);
      body.focus();
      onEdit();
    });
  }

  const linkBtn = document.querySelector('.ad-mail-tools [data-link]');
  if (linkBtn) {
    keepSelection(linkBtn);
    linkBtn.addEventListener('click', function () {
      const url = window.prompt('Link to where?', 'https://');
      if (!url) return;
      document.execCommand('createLink', false, url);
      body.focus();
      onEdit();
    });
  }

  /*  The HTML view. Some things - a table, a coloured button - are easier
      to paste in than to build with four toolbar buttons, so the markup is
      one click away rather than unreachable.                          */
  const htmlBtn = document.querySelector('.ad-mail-tools [data-html]');
  if (htmlBtn) {
    keepSelection(htmlBtn);
    htmlBtn.addEventListener('click', function () {
      const edited = window.prompt('The HTML behind this email:', body.innerHTML);
      if (edited === null) return;
      body.innerHTML = edited;
      onEdit();
    });
  }

  /* ---- dropping a placeholder in ----------------------------------------- */
  const tags = document.querySelectorAll('.ad-tagbar [data-tag]');
  for (let i = 0; i < tags.length; i++) {
    (function (btn) {
      keepSelection(btn);
      btn.addEventListener('click', function () {
        const tag = '{{' + btn.getAttribute('data-tag') + '}}';

        if (document.activeElement === subject) {
          const at = subject.selectionStart == null ? subject.value.length : subject.selectionStart;
          subject.value = subject.value.slice(0, at) + tag + subject.value.slice(at);
          subject.focus();
          subject.selectionStart = at + tag.length;
          subject.selectionEnd = at + tag.length;
        } else {
          body.focus();
          document.execCommand('insertText', false, tag);
        }
        onEdit();
      });
    }(tags[i]));
  }

  /* ---- the vendor list ---------------------------------------------------- */
  renderVendorEmailRows();

  const search = document.getElementById('ad-mail-search');
  if (search) search.addEventListener('input', renderVendorEmailRows);

  /* ---- saving -------------------------------------------------------------- */
  const current = function () {
    return { subject: subject.value, body: body.innerHTML };
  };

  const saveBtn = document.getElementById('ad-mail-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', async function () {
      if (!state.activeEventId) { say('Choose an event first.', true); return; }

      saveBtn.disabled = true;
      say('Saving...');
      try {
        await call('adminSaveEvent', {
          eventId: state.activeEventId,
          fields: { vendorEmail: current() },
        });
        mailDraft = null;          // saved, so no longer unsaved work
        await loadEvents();
        render();
      } catch (err) {
        say(err.message || 'Could not save that.', true);
        saveBtn.disabled = false;
      }
    });
  }

  /*  Preview Email scrolls the preview into view. On a wide screen it is
      already beside the editor; on a narrow one it is underneath.     */
  const previewBtn = document.getElementById('ad-mail-preview-btn');
  if (previewBtn && preview) {
    previewBtn.addEventListener('click', function () {
      preview.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  const resetBtn = document.getElementById('ad-mail-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', async function () {
      if (!window.confirm('Go back to the built-in email? Your wording is cleared.')) return;

      resetBtn.disabled = true;
      try {
        await call('adminSaveEvent', {
          eventId: state.activeEventId,
          fields: { vendorEmail: { subject: '', body: '' } },
        });
        mailDraft = null;
        await loadEvents();
        render();
      } catch (err) {
        say(err.message || 'Could not do that.', true);
        resetBtn.disabled = false;
      }
    });
  }

  /* ---- send one to yourself ------------------------------------------------- */
  const testBtn = document.getElementById('ad-mail-test');
  if (testBtn) {
    testBtn.addEventListener('click', async function () {
      if (!state.activeEventId) { say('Choose an event first.', true); return; }

      testBtn.disabled = true;
      say('Sending...');
      try {
        /*  Saved first: a test of what is on screen is only a test if what
            is on screen is what the server has.                        */
        await call('adminSaveEvent', {
          eventId: state.activeEventId,
          fields: { vendorEmail: current() },
        });
        mailDraft = null;

        const res = await call('adminSendTestVendorEmail', { eventId: state.activeEventId });

        if (res && res.vendor) {
          say('Sent. Have a look in your inbox.');
        } else {
          /*  The reason, not just "it failed". Nine times out of ten it is
              the mail password, and this puts Google's own words on screen
              rather than sending somebody to the logs.                 */
          const why = (res && res.errors && res.errors.length)
            ? res.errors.join(' | ')
            : ((res && res.reason) || 'no reason given');
          say('Did not send: ' + why, true);
        }
      } catch (err) {
        say(err.message || 'Could not send that.', true);
      } finally {
        testBtn.disabled = false;
      }
    });
  }
}


/* =========================================================================
   ESTIMATE BOT  -  admin views

   Two panels, both under the "Leads" group in the rail:

     quotes         who asked, what they asked for, and the range they saw
     quotePricing   the price table the bot runs on - Max's numbers

   Leads are read-only here (a lead is a record of what happened) apart from
   a status and a note; the price table is fully editable and saved through
   the adminSaveQuotePricing function.
   ========================================================================= */

/*  DEFAULT PRICES - a mirror of functions/lib/quote-pricing.js, used by the
    editor before Max has saved a table of his own. Keep the SHAPE in step
    with the server file.                                                  */
const DEFAULT_QUOTE_PRICING = {
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
  services: [
    { key: 'dj', label: 'DJ', addCents: 60000 },
    { key: 'pa', label: 'Live Sound / PA', addCents: 45000 },
    { key: 'lighting', label: 'Lighting', addCents: 40000 },
    { key: 'mc', label: 'MC / Host', addCents: 35000 },
    { key: 'staging', label: 'Staging', addCents: 50000 },
    { key: 'dryhire', label: 'Dry Hire Gear', addCents: 25000 },
    { key: 'setup', label: 'Setup & Pack-down', addCents: 30000 },
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

const QUOTE_STATUS = {
  new:       ['ad-pill-blue',  'New'],
  contacted: ['ad-pill-amber', 'Contacted'],
  quoted:    ['ad-pill-amber', 'Quoted'],
  won:       ['ad-pill-green', 'Won'],
  lost:      ['ad-pill-grey',  'Lost'],
};
const QUOTE_STATUS_ORDER = ['new', 'contacted', 'quoted', 'won', 'lost'];

function quoteRange(lead) {
  const lo = money(lead.estimateLowCents);
  const hi = money(lead.estimateHighCents);
  return lo === hi ? lo : lo + ' \u2013 ' + hi;
}

function quoteStatusPill(status) {
  const [cls, label] = QUOTE_STATUS[status] || QUOTE_STATUS.new;
  return `<span class="ad-pill ${cls}">${esc(label)}</span>`;
}

/* -------------------------------------------------------------------------
   Quote Leads
   ------------------------------------------------------------------------- */
VIEWS.quotes = {
  html() {
    const leads = state.quoteLeads || [];
    const open = leads.filter((l) => (l.status || 'new') === 'new').length;

    return `
      <div class="ad-mail-head-row">
        <span class="ad-mail-icon" aria-hidden="true">&#128172;</span>
        <div class="ad-mail-title">
          <h1>Quote Leads</h1>
          <p>Estimates people worked out with the bot on the services page.</p>
        </div>
        <div class="ad-mail-status">
          <span class="ad-pill ad-pill-blue">${open} new</span>
          <p class="ad-mail-when">${leads.length} total</p>
        </div>
      </div>

      <section class="ad-card ad-panel">
        <header class="ad-panel-head">
          <div>
            <h2>Enquiries</h2>
            <p class="ad-panel-sub">Newest first. Click a row to see the full answers.</p>
          </div>
          <div class="ad-quote-tools">
            <select id="ad-quote-status" class="ad-select" aria-label="Filter by status">
              <option value="all">All statuses</option>
              ${QUOTE_STATUS_ORDER.map((s) =>
                `<option value="${s}">${esc(QUOTE_STATUS[s][1])}</option>`).join('')}
            </select>
            <input type="search" id="ad-quote-search" class="ad-search"
                   placeholder="Search leads..." aria-label="Search leads">
          </div>
        </header>

        <div class="ad-table-wrap">
          <table class="ad-table ad-quote-table">
            <thead>
              <tr>
                <th>When</th><th>Name</th><th>Event</th><th>Where</th>
                <th>Estimate</th><th>Status</th><th>Email</th><th></th>
              </tr>
            </thead>
            <tbody id="ad-quote-rows"></tbody>
          </table>
        </div>
      </section>
    `;
  },

  wire() { wireQuotes(); },
};

function quoteLeadsFiltered() {
  const leads = state.quoteLeads || [];
  const f = state.quoteFilter;
  const needle = (f.search || '').trim().toLowerCase();

  return leads.filter((l) => {
    if (f.status !== 'all' && (l.status || 'new') !== f.status) return false;
    if (!needle) return true;
    return [l.name, l.email, l.phone, l.eventTypeLabel, l.locationLabel,
            (l.serviceLabels || []).join(' '), l.message]
      .filter(Boolean).join(' ').toLowerCase().includes(needle);
  });
}

function quoteEmailCell(l) {
  if (l.emailStatus === 'sent') {
    return '<span class="ad-dot ad-dot-green"></span> Sent';
  }
  if (l.emailStatus === 'failed') {
    return '<span class="ad-dot ad-dot-red"></span> Failed';
  }
  return '<span class="ad-dot"></span> <span class="ad-cell-muted">\u2014</span>';
}

function leadDetailRow(l) {
  const line = (k, v) => v
    ? `<div class="ad-quote-dl"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>` : '';

  return `
    <tr class="ad-quote-detail-row">
      <td colspan="8">
        <div class="ad-quote-detail">
          <div class="ad-quote-cols">
            <div>
              <h3>Their event</h3>
              ${line('Event type', l.eventTypeLabel)}
              ${line('Where', l.locationLabel)}
              ${line('Guests', l.sizeLabel)}
              ${line('Length', l.durationLabel)}
              ${line('Looking for', (l.serviceLabels || []).join(', '))}
              ${line('Their date', l.eventDate)}
              ${line('Estimate shown', quoteRange(l))}
            </div>
            <div>
              <h3>Contact</h3>
              ${line('Name', l.name)}
              <div class="ad-quote-dl"><dt>Email</dt>
                <dd><a href="mailto:${attr(l.email)}">${esc(l.email)}</a></dd></div>
              ${l.phone ? `<div class="ad-quote-dl"><dt>Phone</dt>
                <dd><a href="tel:${attr(l.phone)}">${esc(l.phone)}</a></dd></div>` : ''}
              ${l.message ? `<div class="ad-quote-note-box">
                <dt>Message</dt><p>${esc(l.message)}</p></div>` : ''}
            </div>
          </div>

          <div class="ad-quote-actions">
            <div class="ad-quote-statusrow">
              <span class="ad-quote-actions-label">Status</span>
              ${QUOTE_STATUS_ORDER.map((s) => {
                const on = (l.status || 'new') === s;
                return `<button type="button" class="ad-btn ad-btn-small ad-quote-status-btn${
                  on ? ' is-on' : ''}" data-set-status="${attr(l.id)}" data-status="${s}">
                  ${esc(QUOTE_STATUS[s][1])}</button>`;
              }).join('')}
            </div>

            <div class="ad-quote-noterow">
              <label class="ad-quote-actions-label" for="ad-quote-note-${attr(l.id)}">
                Private note</label>
              <div class="ad-quote-noteline">
                <input type="text" id="ad-quote-note-${attr(l.id)}"
                       class="ad-input ad-quote-noteinput"
                       value="${attr(l.note || '')}" placeholder="Just for the team...">
                <button type="button" class="ad-btn ad-btn-small"
                        data-save-note="${attr(l.id)}">Save</button>
              </div>
            </div>

            <div class="ad-quote-mailrow">
              <button type="button" class="ad-btn ad-btn-small" data-resend-quote="${attr(l.id)}">
                ${l.emailStatus === 'sent' ? 'Resend estimate email' : 'Send estimate email'}
              </button>
              <span class="ad-quote-msg" data-quote-msg="${attr(l.id)}"></span>
            </div>
          </div>
        </div>
      </td>
    </tr>`;
}

function renderQuoteRows() {
  const host = document.getElementById('ad-quote-rows');
  if (!host) return;

  const rows = quoteLeadsFiltered();
  if (!rows.length) {
    host.innerHTML = '<tr><td colspan="8" class="ad-cell-muted">'
      + 'No leads yet. They will appear here the moment somebody finishes the bot.</td></tr>';
    return;
  }

  host.innerHTML = rows.map((l) => {
    const open = state.openLeadId === l.id;
    return `
      <tr class="ad-quote-row${open ? ' is-open' : ''}" data-open-lead="${attr(l.id)}">
        <td class="ad-cell-muted">${esc(dateShort(l.createdAt))}</td>
        <td class="ad-cell-strong">${esc(l.name || '')}</td>
        <td>${esc(l.eventTypeLabel || '\u2014')}</td>
        <td>${esc(l.locationLabel || '\u2014')}</td>
        <td>${esc(quoteRange(l))}</td>
        <td>${quoteStatusPill(l.status || 'new')}</td>
        <td>${quoteEmailCell(l)}</td>
        <td class="ad-cell-right"><span class="ad-quote-caret">${open ? '\u25be' : '\u25b8'}</span></td>
      </tr>
      ${open ? leadDetailRow(l) : ''}`;
  }).join('');
}

function wireQuotes() {
  renderQuoteRows();

  const search = document.getElementById('ad-quote-search');
  const status = document.getElementById('ad-quote-status');
  if (search) {
    search.value = state.quoteFilter.search;
    search.addEventListener('input', () => {
      state.quoteFilter.search = search.value;
      renderQuoteRows();
    });
  }
  if (status) {
    status.value = state.quoteFilter.status;
    status.addEventListener('change', () => {
      state.quoteFilter.status = status.value;
      renderQuoteRows();
    });
  }

  const host = document.getElementById('ad-quote-rows');
  if (!host) return;

  host.addEventListener('click', async (e) => {
    const openBtn = e.target.closest('[data-open-lead]');
    const setStatus = e.target.closest('[data-set-status]');
    const saveNote = e.target.closest('[data-save-note]');
    const resend = e.target.closest('[data-resend-quote]');

    if (setStatus) {
      const id = setStatus.getAttribute('data-set-status');
      const to = setStatus.getAttribute('data-status');
      try {
        await call('adminUpdateQuoteLead', { leadId: id, status: to });
        const lead = (state.quoteLeads || []).find((x) => x.id === id);
        if (lead) lead.status = to;      // optimistic; the snapshot confirms
        renderQuoteRows();
      } catch (err) { alert(err.message || 'Could not update.'); }
      return;
    }

    if (saveNote) {
      const id = saveNote.getAttribute('data-save-note');
      const input = document.getElementById('ad-quote-note-' + id);
      const msg = host.querySelector(`[data-quote-msg="${cssEsc(id)}"]`);
      try {
        await call('adminUpdateQuoteLead', { leadId: id, note: input ? input.value : '' });
        if (msg) { msg.textContent = 'Note saved.'; msg.className = 'ad-quote-msg is-ok'; }
      } catch (err) {
        if (msg) { msg.textContent = err.message || 'Could not save.'; msg.className = 'ad-quote-msg is-bad'; }
      }
      return;
    }

    if (resend) {
      const id = resend.getAttribute('data-resend-quote');
      const msg = host.querySelector(`[data-quote-msg="${cssEsc(id)}"]`);
      resend.disabled = true;
      if (msg) { msg.textContent = 'Sending\u2026'; msg.className = 'ad-quote-msg'; }
      try {
        const res = await call('adminResendQuoteEmail', { leadId: id });
        if (res && res.sent) {
          if (msg) { msg.textContent = 'Sent.'; msg.className = 'ad-quote-msg is-ok'; }
        } else {
          const why = (res && (res.error || res.reason)) || 'no reason given';
          if (msg) { msg.textContent = 'Did not send: ' + why; msg.className = 'ad-quote-msg is-bad'; }
        }
      } catch (err) {
        if (msg) { msg.textContent = err.message || 'Could not send.'; msg.className = 'ad-quote-msg is-bad'; }
      } finally {
        resend.disabled = false;
      }
      return;
    }

    if (openBtn) {
      const id = openBtn.getAttribute('data-open-lead');
      state.openLeadId = state.openLeadId === id ? null : id;
      renderQuoteRows();
    }
  });
}

/*  A value safe to drop inside a CSS attribute selector. Ids are Firestore's
    own, so this is belt and braces rather than a real threat.             */
function cssEsc(v) {
  return String(v == null ? '' : v).replace(/["\\]/g, '\\$&');
}

/* -------------------------------------------------------------------------
   Quote Pricing  -  the editable price table
   ------------------------------------------------------------------------- */
function quotePricingModel() {
  const p = state.quotePricing;
  if (p && Array.isArray(p.eventTypes) && p.eventTypes.length) return p;
  return DEFAULT_QUOTE_PRICING;
}

const centsToDollars = (c) => (Number(c || 0) / 100);

/*  One editable row. `fields` is [{name, value, type, step}], rendered as
    inputs carrying data-field so the saver can read them back.            */
function priceRow(kind, fields) {
  const cells = fields.map((f) => `
    <input class="ad-input ad-price-input" data-field="${attr(f.name)}"
           type="${f.type || 'text'}" ${f.step ? `step="${f.step}"` : ''}
           ${f.min != null ? `min="${f.min}"` : ''}
           value="${attr(f.value)}" placeholder="${attr(f.placeholder || '')}">`).join('');
  return `<div class="ad-price-row" data-kind="${attr(kind)}">
    ${cells}
    <button type="button" class="ad-price-del" data-del-row title="Remove">\u2715</button>
  </div>`;
}

function priceList(kind, title, hint, rows, cols) {
  return `
    <section class="ad-card ad-panel ad-price-card" data-list="${attr(kind)}">
      <header class="ad-panel-head">
        <div><h2>${esc(title)}</h2><p class="ad-panel-sub">${esc(hint)}</p></div>
      </header>
      <div class="ad-price-cols" aria-hidden="true">
        ${cols.map((c) => `<span>${esc(c)}</span>`).join('')}<span></span>
      </div>
      <div class="ad-price-rows" data-rows="${attr(kind)}">${rows.join('')}</div>
      <button type="button" class="ad-btn ad-btn-small ad-price-add" data-add-row="${attr(kind)}">
        + Add
      </button>
    </section>`;
}

VIEWS.botSettings = {
  html() {
    const p = quotePricingModel();

    const eventRows = (p.eventTypes || []).map((x) => priceRow('eventTypes', [
      { name: 'label', value: x.label, placeholder: 'Wedding' },
      { name: 'baseCents', value: centsToDollars(x.baseCents), type: 'number', step: '1', min: 0 },
    ]));
    const sizeRows = (p.sizes || []).map((x) => priceRow('sizes', [
      { name: 'label', value: x.label, placeholder: 'Up to 50 guests' },
      { name: 'multiplier', value: x.multiplier, type: 'number', step: '0.05', min: 0 },
    ]));
    const locationRows = (p.locations || []).map((x) => priceRow('locations', [
      { name: 'label', value: x.label, placeholder: 'Bowen' },
      { name: 'travelCents', value: centsToDollars(x.travelCents), type: 'number', step: '1', min: 0 },
    ]));
    const durationRows = (p.durations || []).map((x) => priceRow('durations', [
      { name: 'label', value: x.label, placeholder: 'A few hours' },
      { name: 'hours', value: x.hours, type: 'number', step: '1', min: 0 },
    ]));

    return `
      <div class="ad-mail-head-row">
        <span class="ad-mail-icon" aria-hidden="true">&#9881;</span>
        <div class="ad-mail-title">
          <h1>Bot Settings</h1>
          <p>The bot-specific knobs the estimate runs on &mdash; the gear a visitor
             picks lives in <strong>Equipment</strong>. Dollar amounts are GST-inclusive.</p>
        </div>
        <div class="ad-mail-status">
          <span class="ad-pill ${state.quotePricing ? 'ad-pill-green' : 'ad-pill-blue'}">
            ${state.quotePricing ? 'Your settings' : 'Starter settings'}
          </span>
        </div>
      </div>

      <div class="ad-price-grid">
        ${priceList('eventTypes', 'Event types', 'The base price each kind of event starts at, before gear.',
          eventRows, ['Label', 'Base price $'])}
        ${priceList('sizes', 'Guest sizes', 'Scales the whole estimate. 1 = no change, 1.5 = half again.',
          sizeRows, ['Label', 'Multiplier'])}
        ${priceList('locations', 'Locations', 'A flat travel amount added for where it is.',
          locationRows, ['Label', 'Travel $'])}
        ${priceList('durations', 'Durations', 'How long they need us. Only bills beyond the free hours below.',
          durationRows, ['Label', 'Hours'])}

        <section class="ad-card ad-panel ad-price-card">
          <header class="ad-panel-head">
            <div><h2>Settings</h2><p class="ad-panel-sub">How the range is worked out.</p></div>
          </header>
          <div class="ad-price-settings">
            <label class="ad-field">
              <span>Range spread %</span>
              <input class="ad-input" id="ad-price-spread" type="number" step="1" min="0" max="90"
                     value="${attr(p.spreadPct != null ? p.spreadPct : 15)}">
              <em>How wide the low\u2013high band is around the estimate.</em>
            </label>
            <label class="ad-field">
              <span>Round to nearest $</span>
              <input class="ad-input" id="ad-price-round" type="number" step="5" min="1"
                     value="${attr(centsToDollars(p.roundToCents || 5000))}">
              <em>Keeps the numbers tidy, e.g. $2,600 not $2,617.</em>
            </label>
            <label class="ad-field">
              <span>Free hours</span>
              <input class="ad-input" id="ad-price-freehours" type="number" step="1" min="0" max="48"
                     value="${attr(p.freeHours != null ? p.freeHours : 4)}">
              <em>Hours included before the hourly rate kicks in.</em>
            </label>
            <label class="ad-field">
              <span>Hourly rate $ (over the free hours)</span>
              <input class="ad-input" id="ad-price-hourly" type="number" step="1" min="0"
                     value="${attr(centsToDollars(p.hourlyCents || 0))}">
              <em>Leave at 0 to not charge by the hour.</em>
            </label>
          </div>
        </section>
      </div>

      <div class="ad-actions-row ad-price-save-row">
        <button type="button" class="ad-btn ad-btn-primary" id="ad-price-save">Save prices</button>
        <p class="ad-action-msg" id="ad-price-msg" hidden></p>
      </div>
    `;
  },

  wire() { wireQuotePricing(); },
};

/*  A fresh blank row for the "+ Add" button, matching each list's columns. */
function blankPriceRow(kind) {
  const map = {
    eventTypes: [{ name: 'label', placeholder: 'New event' },
                 { name: 'baseCents', value: 0, type: 'number', step: '1', min: 0 }],
    sizes:      [{ name: 'label', placeholder: 'New size' },
                 { name: 'multiplier', value: 1, type: 'number', step: '0.05', min: 0 }],
    locations:  [{ name: 'label', placeholder: 'New place' },
                 { name: 'travelCents', value: 0, type: 'number', step: '1', min: 0 }],
    durations:  [{ name: 'label', placeholder: 'New length' },
                 { name: 'hours', value: 1, type: 'number', step: '1', min: 0 }],
  };
  return priceRow(kind, (map[kind] || []).map((f) => ({ value: '', ...f })));
}

function wireQuotePricing() {
  const desk = document.getElementById('ad-desk');
  if (!desk) return;

  desk.querySelectorAll('[data-add-row]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.getAttribute('data-add-row');
      const rows = desk.querySelector(`[data-rows="${cssEsc(kind)}"]`);
      if (rows) rows.insertAdjacentHTML('beforeend', blankPriceRow(kind));
    });
  });

  desk.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-row]');
    if (del) { const row = del.closest('.ad-price-row'); if (row) row.remove(); }
  });

  const save = document.getElementById('ad-price-save');
  if (save) save.addEventListener('click', () => saveQuotePricing());
}

/*  Read the DOM back into the pricing shape and send it. Dollars in the
    inputs become cents on the way out - the store is always cents.        */
function saveQuotePricing() {
  const desk = document.getElementById('ad-desk');
  const msg = document.getElementById('ad-price-msg');
  const dollarsToCents = (v) => Math.round(Number(v || 0) * 100);

  const readList = (kind, map) => {
    const rows = desk.querySelectorAll(`[data-rows="${cssEsc(kind)}"] .ad-price-row`);
    return Array.from(rows).map((row) => {
      const get = (n) => {
        const el = row.querySelector(`[data-field="${cssEsc(n)}"]`);
        return el ? el.value : '';
      };
      return map(get);
    }).filter((x) => x.label);
  };

  const pricing = {
    spreadPct: Number((document.getElementById('ad-price-spread') || {}).value || 0),
    roundToCents: dollarsToCents((document.getElementById('ad-price-round') || {}).value || 50),
    freeHours: Number((document.getElementById('ad-price-freehours') || {}).value || 0),
    hourlyCents: dollarsToCents((document.getElementById('ad-price-hourly') || {}).value || 0),

    eventTypes: readList('eventTypes', (g) => ({
      label: g('label').trim(), baseCents: dollarsToCents(g('baseCents')) })),
    sizes: readList('sizes', (g) => ({
      label: g('label').trim(), multiplier: Number(g('multiplier') || 1) })),
    locations: readList('locations', (g) => ({
      label: g('label').trim(), travelCents: dollarsToCents(g('travelCents')) })),
    durations: readList('durations', (g) => ({
      label: g('label').trim(), hours: Number(g('hours') || 0) })),
  };

  if (msg) { msg.hidden = false; msg.className = 'ad-action-msg'; msg.textContent = 'Saving\u2026'; }

  call('adminSaveQuotePricing', { pricing })
    .then(() => {
      state.quotePricing = pricing;
      if (msg) { msg.className = 'ad-action-msg is-ok'; msg.textContent = 'Saved. The bot is using these now.'; }
    })
    .catch((err) => {
      if (msg) { msg.className = 'ad-action-msg is-bad'; msg.textContent = err.message || 'Could not save.'; }
    });
}


/* =========================================================================
   INVENTORY  -  the equipment manager

   Max's gear as a proper inventory: a table with thumbnails, category and
   status pills, quantities and hire pricing, plus a detail panel on the
   right for editing one item at a time. It is the source of truth - the
   bot's extras and their prices come from the items flagged "Available for
   quotes" here.

   CORE FIRST: photos, a per-item history and booking-driven availability are
   deliberately left out for now; quantities and status are set by hand.

   Items live in the `inventory` collection (rules allow admin writes), one
   document each, saved on their own when you press Save Changes.
   ========================================================================= */

/*  DEFAULT INVENTORY - a mirror of functions/lib/quote-pricing.js, shown as
    a starter list until real gear is saved. Only the fields the bot needs
    (id, name, category, priceCents, inBot) have to match the server; the
    rest are the richer admin fields, filled in here.                      */
const DEFAULT_INVENTORY = [
  { id: 'dj', name: 'DJ Package', subtitle: 'Decks, mixer & booth', category: 'DJ', priceCents: 60000, extraDayCents: 30000, quantityTotal: 2, quantityAvailable: 2, location: 'Bowen', status: 'available', inBot: true },
  { id: 'mc', name: 'MC / Host', subtitle: 'Mic & host for the night', category: 'DJ', priceCents: 35000, extraDayCents: 0, quantityTotal: 1, quantityAvailable: 1, location: 'Bowen', status: 'available', inBot: true },
  { id: 'pa', name: 'Live Sound / PA System', subtitle: 'Tops, subs & desk', category: 'Audio', priceCents: 45000, extraDayCents: 22000, quantityTotal: 3, quantityAvailable: 3, location: 'Bowen', status: 'available', inBot: true },
  { id: 'lighting', name: 'Lighting Package', subtitle: 'Stage & dance-floor wash', category: 'Lighting', priceCents: 40000, extraDayCents: 20000, quantityTotal: 4, quantityAvailable: 4, location: 'Bowen', status: 'available', inBot: true },
  { id: 'staging', name: 'Staging', subtitle: 'Modular deck, per section', category: 'Staging', priceCents: 50000, extraDayCents: 25000, quantityTotal: 1, quantityAvailable: 1, location: 'Bowen', status: 'available', inBot: true },
  { id: 'dryhire', name: 'Dry Hire Gear', subtitle: 'Self-collect equipment', category: 'Dry Hire', priceCents: 25000, extraDayCents: 12000, quantityTotal: 10, quantityAvailable: 10, location: 'Bowen', status: 'available', inBot: true },
  { id: 'setup', name: 'Setup & Pack-down', subtitle: 'Crew on the day', category: 'Crew', priceCents: 30000, extraDayCents: 0, quantityTotal: 1, quantityAvailable: 1, location: 'Bowen', status: 'available', inBot: true },
];

function invModelRaw() {
  if (Array.isArray(state.inventory) && state.inventory.length) return state.inventory;
  return DEFAULT_INVENTORY;
}

const invNum = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/*  Normalise a stored item to every field the page expects, coping with
    older documents (quantity -> quantityTotal, and no availability yet). */
function invItem(raw) {
  const r = raw || {};
  const qt = invNum(r.quantityTotal != null ? r.quantityTotal : r.quantity, 0);
  const qaRaw = r.quantityAvailable != null ? r.quantityAvailable : qt;
  return {
    id: r.id || '',
    name: r.name || '',
    subtitle: r.subtitle || '',
    category: r.category || '',
    status: r.status || 'available',
    quantityTotal: qt,
    quantityAvailable: Math.max(0, Math.min(invNum(qaRaw, 0), qt)),
    quantityRepair: Math.max(0, Math.min(invNum(r.quantityRepair, 0), qt)),
    location: r.location || '',
    pricingType: r.pricingType || 'per-day',
    priceCents: invNum(r.priceCents, 0),
    extraDayCents: invNum(r.extraDayCents, 0),
    replacementCents: invNum(r.replacementCents, 0),
    internalNotes: r.internalNotes || '',
    specs: r.specs || '',
    weight: r.weight || '',
    powerDraw: r.powerDraw || '',
    included: r.included || '',
    inBot: r.inBot !== false,
    photoUrl: r.photoUrl || '',
    photoPath: r.photoPath || '',
    repairFault: r.repairFault || '',
    repairWith: r.repairWith || '',
    repairDue: r.repairDue || '',
    order: invNum(r.order, 0),
  };
}

function invItems() { return invModelRaw().map(invItem); }

/*  Category pills get a stable colour from the category name, so "Audio" is
    always the same blue without a hard-coded list.                        */
const INV_CAT_CLASSES = ['inv-c1', 'inv-c2', 'inv-c3', 'inv-c4', 'inv-c5', 'inv-c6'];
function invCatClass(cat) {
  if (!cat) return 'inv-c0';
  let h = 0;
  for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
  return INV_CAT_CLASSES[h % INV_CAT_CLASSES.length];
}

const INV_STATUS = {
  'available': ['inv-st-green', 'Available'],
  'on-hire':   ['inv-st-blue',  'On Hire'],
  'in-repair': ['inv-st-red',   'In Repair'],
};
function invStatusPill(status) {
  const [cls, label] = INV_STATUS[status] || INV_STATUS.available;
  return `<span class="inv-pill ${cls}">${esc(label)}</span>`;
}

/*  A little thumbnail stand-in until real photos land: a tinted tile with
    the category's first letter.                                           */
function invThumb(it) {
  if (it.photoUrl) {
    return `<span class="inv-thumb inv-thumb-img"><img src="${attr(it.photoUrl)}" alt="" loading="lazy"></span>`;
  }
  const letter = (it.category || it.name || '?').trim().charAt(0).toUpperCase();
  return `<span class="inv-thumb ${invCatClass(it.category)}">${esc(letter)}</span>`;
}

/*  The units, split so available + on-hire + in-repair == total, counted
    from the quantities on each item rather than a single status - so one
    item can have some units on hire and some in for repair at once.

    owned  = available + in repair + on hire.
    Anything not available and not in repair is taken to be out on hire.    */
function invStats() {
  const items = invItems();
  let total = 0, available = 0, onHire = 0, inRepair = 0;
  items.forEach((it) => {
    const repair = Math.min(it.quantityRepair, it.quantityTotal);
    const avail = Math.min(it.quantityAvailable, it.quantityTotal - repair);
    total += it.quantityTotal;
    available += avail;
    inRepair += repair;
    onHire += Math.max(0, it.quantityTotal - avail - repair);
  });
  return { total, available, onHire, inRepair };
}

function invDistinct(key) {
  const set = [];
  invItems().forEach((it) => {
    const v = (it[key] || '').trim();
    if (v && !set.includes(v)) set.push(v);
  });
  return set.sort((a, b) => a.localeCompare(b));
}

function invFiltered() {
  const f = state.invFilter;
  const needle = (f.search || '').trim().toLowerCase();
  return invItems().filter((it) => {
    if (f.category !== 'all' && it.category !== f.category) return false;
    if (f.location !== 'all' && it.location !== f.location) return false;
    if (f.status !== 'all' && it.status !== f.status) return false;
    if (!needle) return true;
    return [it.name, it.subtitle, it.category, it.location]
      .filter(Boolean).join(' ').toLowerCase().includes(needle);
  });
}

const INV_PER_PAGE = 12;

/* -------------------------------------------------------------------------
   The view
   ------------------------------------------------------------------------- */
VIEWS.inventory = {
  html() {
    const s = invStats();
    const starter = !(state.inventory && state.inventory.length);
    const pct = (n) => (s.total ? Math.round((n / s.total) * 100) : 0);
    const cats = invDistinct('category');
    const locs = invDistinct('location');
    const f = state.invFilter;

    const opt = (val, label, cur) =>
      `<option value="${attr(val)}"${cur === val ? ' selected' : ''}>${esc(label)}</option>`;

    const open = state.openInvId != null;

    return `
      <div class="inv-wrap${open ? ' has-detail' : ''}">
        <div class="inv-main">
          <div class="inv-head">
            <div class="inv-head-title">
              <span class="ad-mail-icon" aria-hidden="true">&#128230;</span>
              <div>
                <h1>Inventory</h1>
                <p>Manage your equipment, availability and hire pricing.</p>
              </div>
            </div>
            <div class="inv-head-actions">
              ${starter ? '<span class="inv-pill inv-st-blue">Starter list</span>' : ''}
              <button type="button" class="ad-btn ad-btn-primary" id="inv-add">+ Add Item</button>
            </div>
          </div>

          <div class="inv-tiles">
            ${invTile('&#128230;', 'inv-t-slate', s.total, 'Total Items', '')}
            ${invTile('&#10003;', 'inv-t-green', s.available, 'Available', pct(s.available) + '%')}
            ${invTile('&#128666;', 'inv-t-blue', s.onHire, 'On Hire', pct(s.onHire) + '%')}
            ${invTile('&#128295;', 'inv-t-amber', s.inRepair, 'In Repair', pct(s.inRepair) + '%')}
          </div>

          <div class="inv-toolbar">
            <input type="search" id="inv-search" class="ad-search" placeholder="Search items..."
                   value="${attr(f.search)}" aria-label="Search inventory">
            <select id="inv-f-category" class="ad-select" aria-label="Filter by category">
              ${opt('all', 'All categories', f.category)}
              ${cats.map((c) => opt(c, c, f.category)).join('')}
            </select>
            <select id="inv-f-location" class="ad-select" aria-label="Filter by location">
              ${opt('all', 'All locations', f.location)}
              ${locs.map((c) => opt(c, c, f.location)).join('')}
            </select>
            <select id="inv-f-status" class="ad-select" aria-label="Filter by status">
              ${opt('all', 'All status', f.status)}
              ${opt('available', 'Available', f.status)}
              ${opt('on-hire', 'On Hire', f.status)}
              ${opt('in-repair', 'In Repair', f.status)}
            </select>
          </div>

          <div class="ad-table-wrap inv-table-wrap">
            <table class="ad-table inv-table">
              <thead>
                <tr>
                  ${invTh('name', 'Item')}
                  ${invTh('category', 'Category')}
                  ${invTh('quantityTotal', 'Total', true)}
                  ${invTh('quantityAvailable', 'Avail.', true)}
                  ${invTh('location', 'Location')}
                  ${invTh('priceCents', 'Hire / day', true)}
                  ${invTh('extraDayCents', 'Extra day', true)}
                  ${invTh('status', 'Status')}
                  <th></th>
                </tr>
              </thead>
              <tbody id="inv-rows"></tbody>
            </table>
          </div>

          <div class="inv-foot" id="inv-foot"></div>
        </div>

        ${open ? invDetail() : ''}
      </div>
    `;
  },

  wire() { wireInventory(); },
};

/*  A sortable column header. Clicking it sorts by that field; clicking the
    active one flips the direction.                                         */
function invTh(key, label, num) {
  const on = state.invSort.key === key;
  //  An idle up/down arrow on every column so it reads as sortable; the
  //  active column shows a solid up or down caret instead.
  const glyph = on ? (state.invSort.dir === 'asc' ? '▲' : '▼') : '⇅';
  return `<th class="${num ? 'inv-num ' : ''}inv-th-sort${on ? ' is-sorted' : ''}"
              data-sort="${attr(key)}">${esc(label)}<span class="inv-caret${on ? '' : ' inv-caret-idle'}">${glyph}</span></th>`;
}

const INV_NUM_KEYS = ['quantityTotal', 'quantityAvailable', 'priceCents', 'extraDayCents'];

/*  Apply the chosen column sort. No sort chosen -> leave the default order
    (category, then name) the list already comes in.                        */
function invSorted(list) {
  const { key, dir } = state.invSort;
  if (!key) return list;
  const mul = dir === 'desc' ? -1 : 1;

  //  Names that start with a letter come first (A-Z); anything starting with
  //  a number or symbol sorts after Z, rather than jumping to the top.
  const rank = (s) => (/^\s*[a-z]/i.test(s) ? 0 : 1);

  return list.slice().sort((a, b) => {
    if (INV_NUM_KEYS.includes(key)) return ((a[key] || 0) - (b[key] || 0)) * mul;
    const av = String(a[key] || '');
    const bv = String(b[key] || '');
    const ra = rank(av);
    const rb = rank(bv);
    if (ra !== rb) return (ra - rb) * mul;
    return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' }) * mul;
  });
}

/*  Refresh the carets / highlight on the header row in place, so sorting
    does not need a full re-render (which would disturb an open panel).    */
function updateInvSortHeaders() {
  document.querySelectorAll('.inv-table thead [data-sort]').forEach((th) => {
    const on = state.invSort.key === th.getAttribute('data-sort');
    th.classList.toggle('is-sorted', on);
    const caret = th.querySelector('.inv-caret');
    if (caret) caret.textContent = on ? (state.invSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  });
}

function invTile(icon, cls, value, label, pct) {
  return `
    <div class="inv-tile">
      <span class="inv-tile-ico ${cls}" aria-hidden="true">${icon}</span>
      <div class="inv-tile-body">
        <p class="inv-tile-value">${esc(value)}</p>
        <p class="inv-tile-label">${esc(label)}</p>
      </div>
      ${pct ? `<span class="inv-tile-pct">${esc(pct)}</span>` : ''}
    </div>`;
}

function invRowsHtml() {
  const rows = invSorted(invFiltered());
  const pages = Math.max(1, Math.ceil(rows.length / INV_PER_PAGE));
  if (state.invPage > pages) state.invPage = pages;
  const start = (state.invPage - 1) * INV_PER_PAGE;
  const pageRows = rows.slice(start, start + INV_PER_PAGE);

  const body = pageRows.length ? pageRows.map((it) => `
    <tr class="inv-row${state.openInvId === it.id ? ' is-open' : ''}" data-inv="${attr(it.id)}">
      <td class="inv-item-cell">
        ${invThumb(it)}
        <span class="inv-item-text">
          <span class="inv-item-name">${esc(it.name || 'Untitled')}</span>
          ${it.subtitle ? `<span class="inv-item-sub">${esc(it.subtitle)}</span>` : ''}
        </span>
      </td>
      <td>${it.category ? `<span class="inv-pill ${invCatClass(it.category)}">${esc(it.category)}</span>` : '<span class="ad-cell-muted">—</span>'}</td>
      <td class="inv-num">${esc(it.quantityTotal)}</td>
      <td class="inv-num">${esc(it.quantityAvailable)}</td>
      <td>${it.location ? esc(it.location) : '<span class="ad-cell-muted">—</span>'}</td>
      <td class="inv-num">${esc(money(it.priceCents))}</td>
      <td class="inv-num">${it.extraDayCents ? esc(money(it.extraDayCents)) : '<span class="ad-cell-muted">—</span>'}</td>
      <td>${invStatusPill(it.status)}</td>
      <td class="ad-cell-right"><button type="button" class="inv-open-btn" data-inv-open="${attr(it.id)}" aria-label="Edit">&#8250;</button></td>
    </tr>`).join('')
    : `<tr><td colspan="9" class="ad-cell-muted">No items match. Try clearing the filters, or add one.</td></tr>`;

  return { body, total: rows.length, pages, start, shown: pageRows.length };
}

function renderInvRows() {
  const host = document.getElementById('inv-rows');
  const foot = document.getElementById('inv-foot');
  if (!host) return;

  const r = invRowsHtml();
  host.innerHTML = r.body;

  if (foot) {
    const from = r.total ? r.start + 1 : 0;
    const to = r.start + r.shown;
    let nums = '';
    for (let p = 1; p <= r.pages; p++) {
      nums += `<button type="button" class="inv-pagebtn${p === state.invPage ? ' is-on' : ''}"
                 data-inv-page="${p}">${p}</button>`;
    }
    foot.innerHTML = `
      <p class="inv-foot-count">Showing ${from}–${to} of ${r.total} items</p>
      <div class="inv-pages">
        <button type="button" class="inv-pagebtn" data-inv-page="${Math.max(1, state.invPage - 1)}"
                ${state.invPage === 1 ? 'disabled' : ''}>‹</button>
        ${nums}
        <button type="button" class="inv-pagebtn" data-inv-page="${Math.min(r.pages, state.invPage + 1)}"
                ${state.invPage === r.pages ? 'disabled' : ''}>›</button>
      </div>`;
  }
}

/* -------------------------------------------------------------------------
   Detail panel  -  edit one item
   ------------------------------------------------------------------------- */
function invEditingItem() {
  if (state.openInvId === '__new__') {
    return invItem({ status: 'available', quantityTotal: 1, quantityAvailable: 1,
      pricingType: 'per-day', inBot: true, location: '' });
  }
  const found = (state.inventory || []).find((x) => x.id === state.openInvId);
  return invItem(found || {});
}

function invDetail() {
  const it = invEditingItem();
  const isNew = state.openInvId === '__new__';
  const dollars = (c) => (c ? (c / 100) : '');

  const statusOpt = (v, l) =>
    `<option value="${v}"${it.status === v ? ' selected' : ''}>${l}</option>`;

  return `
    <aside class="inv-detail" aria-label="Item details">
      <header class="inv-detail-head">
        <div>
          <h2>${isNew ? 'New item' : esc(it.name || 'Item')}</h2>
          ${!isNew && it.subtitle ? `<p class="inv-detail-sub">${esc(it.subtitle)}</p>` : ''}
        </div>
        <button type="button" class="inv-detail-close" id="inv-close" aria-label="Close">&times;</button>
      </header>

      <div class="inv-detail-body">
        <div class="inv-photo">
          <div class="inv-photo-preview" id="inv-photo-drop" title="Drag, paste or click to add a photo">
            ${it.photoUrl
              ? `<img src="${attr(it.photoUrl)}" alt="">`
              : `<span class="inv-photo-ph ${invCatClass(it.category)}">${esc((it.category || it.name || '?').trim().charAt(0).toUpperCase())}</span>`}
          </div>
          <div class="inv-photo-actions">
            <label class="ad-btn ad-btn-small inv-photo-btn">
              ${it.photoUrl ? 'Replace photo' : 'Upload photo'}
              <input type="file" accept="image/*" id="inv-photo-input" hidden></label>
            ${it.photoUrl ? '<button type="button" class="ad-btn ad-btn-small" id="inv-photo-remove">Remove</button>' : ''}
            <p class="inv-photo-hint">Drag an image in, or paste a screenshot (Ctrl / Cmd + V)</p>
            <span class="ad-quote-msg" id="inv-photo-msg"></span>
          </div>
        </div>

        <div class="inv-fgrid">
          <label class="ad-field inv-span2"><span>Item name</span>
            <input class="ad-input" data-f="name" value="${attr(it.name)}" placeholder="Electro-Voice ICOA 12"></label>
          <label class="ad-field inv-span2"><span>Subtitle</span>
            <input class="ad-input" data-f="subtitle" value="${attr(it.subtitle)}" placeholder="Active Speaker"></label>

          <label class="ad-field"><span>Category</span>
            <input class="ad-input" data-f="category" value="${attr(it.category)}" placeholder="Audio"></label>
          <label class="ad-field"><span>Status</span>
            <select class="ad-select" data-f="status">
              ${statusOpt('available', 'Available')}
              ${statusOpt('on-hire', 'On Hire')}
              ${statusOpt('in-repair', 'In Repair')}
            </select></label>

          <label class="ad-field"><span>Quantity owned</span>
            <input class="ad-input" type="number" min="0" step="1" data-f="quantityTotal" value="${attr(it.quantityTotal)}"></label>
          <label class="ad-field"><span>Quantity available</span>
            <input class="ad-input" type="number" min="0" step="1" data-f="quantityAvailable" value="${attr(it.quantityAvailable)}"></label>

          <label class="ad-field"><span>Quantity in repair</span>
            <input class="ad-input" type="number" min="0" step="1" data-f="quantityRepair" value="${attr(it.quantityRepair)}"></label>
          <div class="ad-field"><span>On hire (worked out)</span>
            <p class="inv-onhire" id="inv-onhire">${attr(Math.max(0, it.quantityTotal - it.quantityAvailable - it.quantityRepair))}</p></div>

          <label class="ad-field inv-span2"><span>Default location</span>
            <input class="ad-input" data-f="location" value="${attr(it.location)}" placeholder="Bowen"></label>

          <label class="ad-field"><span>Hire price (1 day) $</span>
            <input class="ad-input" type="number" min="0" step="1" data-f="priceCents" value="${attr(dollars(it.priceCents))}"></label>
          <label class="ad-field"><span>Extra day price $</span>
            <input class="ad-input" type="number" min="0" step="1" data-f="extraDayCents" value="${attr(dollars(it.extraDayCents))}"></label>

          <label class="ad-field inv-span2"><span>Replacement value $</span>
            <input class="ad-input" type="number" min="0" step="1" data-f="replacementCents" value="${attr(dollars(it.replacementCents))}"></label>

          <label class="ad-field inv-span2"><span>Internal notes</span>
            <textarea class="ad-input" rows="2" data-f="internalNotes" placeholder="Just for the team...">${esc(it.internalNotes)}</textarea></label>
        </div>

        <div class="inv-detail-section">
          <h3>Repair &amp; maintenance</h3>
          <div class="inv-fgrid">
            <label class="ad-field inv-span2"><span>What&rsquo;s wrong / being done</span>
              <textarea class="ad-input" rows="2" data-f="repairFault" placeholder="e.g. blown driver, sent for reconing">${esc(it.repairFault)}</textarea></label>
            <label class="ad-field"><span>With / who&rsquo;s fixing it</span>
              <input class="ad-input" data-f="repairWith" value="${attr(it.repairWith)}" placeholder="e.g. JD Audio Repairs"></label>
            <label class="ad-field"><span>Expected back</span>
              <input class="ad-input" data-f="repairDue" value="${attr(it.repairDue)}" placeholder="e.g. Fri 3 Oct"></label>
          </div>
        </div>

        <div class="inv-detail-section">
          <h3>Extra equipment details</h3>
          <div class="inv-fgrid">
            <label class="ad-field inv-span2"><span>Specs</span>
              <textarea class="ad-input" rows="2" data-f="specs" placeholder="12&quot; two-way powered loudspeaker...">${esc(it.specs)}</textarea></label>
            <label class="ad-field"><span>Weight</span>
              <input class="ad-input" data-f="weight" value="${attr(it.weight)}" placeholder="17.4 kg"></label>
            <label class="ad-field"><span>Power draw</span>
              <input class="ad-input" data-f="powerDraw" value="${attr(it.powerDraw)}" placeholder="300 W (max)"></label>
            <label class="ad-field inv-span2"><span>What's included</span>
              <textarea class="ad-input" rows="2" data-f="included" placeholder="1x speaker, 1x power cable...">${esc(it.included)}</textarea></label>
          </div>
        </div>

        <label class="inv-toggle">
          <span>
            <strong>Available for quotes</strong>
            <em>Offer this item as an extra in the estimate bot.</em>
          </span>
          <input type="checkbox" data-f="inBot"${it.inBot ? ' checked' : ''}>
          <span class="inv-switch" aria-hidden="true"></span>
        </label>
      </div>

      <footer class="inv-detail-foot">
        ${isNew ? '' : '<button type="button" class="ad-btn inv-del" id="inv-delete">Delete</button>'}
        <button type="button" class="ad-btn ad-btn-primary" id="inv-save">
          ${isNew ? 'Add item' : 'Save changes'}</button>
        <span class="ad-quote-msg" id="inv-msg"></span>
      </footer>
    </aside>`;
}

/* -------------------------------------------------------------------------
   Wiring
   ------------------------------------------------------------------------- */
function wireInventory() {
  renderInvRows();

  /*  Delegate on the wrapper, which render() recreates each time, rather
      than on the persistent #ad-desk - a listener on the desk would stack
      up a duplicate on every re-render.                                  */
  const wrap = document.querySelector('.inv-wrap');
  if (!wrap) return;

  const add = document.getElementById('inv-add');
  if (add) add.addEventListener('click', () => { clearPendingPhoto(); state.openInvId = '__new__'; render(); });

  const search = document.getElementById('inv-search');
  if (search) {
    search.addEventListener('input', () => {
      state.invFilter.search = search.value;
      state.invPage = 1;
      renderInvRows();
    });
  }
  [['inv-f-category', 'category'], ['inv-f-location', 'location'], ['inv-f-status', 'status']]
    .forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => {
        state.invFilter[key] = el.value;
        state.invPage = 1;
        renderInvRows();
      });
    });

  // table: open a row, or page
  wrap.addEventListener('click', (e) => {
    const sortTh = e.target.closest('[data-sort]');
    if (sortTh) {
      const k = sortTh.getAttribute('data-sort');
      if (state.invSort.key === k) {
        state.invSort.dir = state.invSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.invSort.key = k; state.invSort.dir = 'asc';
      }
      state.invPage = 1;
      updateInvSortHeaders();
      renderInvRows();
      return;
    }
    const page = e.target.closest('[data-inv-page]');
    if (page) {
      state.invPage = Number(page.getAttribute('data-inv-page')) || 1;
      renderInvRows();
      return;
    }
    const row = e.target.closest('[data-inv]');
    const openBtn = e.target.closest('[data-inv-open]');
    const id = openBtn ? openBtn.getAttribute('data-inv-open')
      : (row ? row.getAttribute('data-inv') : null);
    if (id) { clearPendingPhoto(); state.openInvId = id; render(); }
  });

  wireInvDetail();
}

/*  A photo waiting to go up for a brand-new item that has not been saved
    yet - it is uploaded the moment the item is created, so you can add the
    picture and the details together.                                      */
let pendingPhoto = null;
let pendingPhotoUrl = '';

function clearPendingPhoto() {
  pendingPhoto = null;
  if (pendingPhotoUrl) { try { URL.revokeObjectURL(pendingPhotoUrl); } catch (e) { /* noop */ } }
  pendingPhotoUrl = '';
}

function wireInvDetail() {
  const close = document.getElementById('inv-close');
  if (close) close.addEventListener('click', () => { clearPendingPhoto(); state.openInvId = null; render(); });

  const save = document.getElementById('inv-save');
  if (save) save.addEventListener('click', () => saveInvItem(save));

  const del = document.getElementById('inv-delete');
  if (del) del.addEventListener('click', () => deleteInvItem(del));

  /*  Keep the "On hire (worked out)" number live as the quantities change,
      so the split is obvious before saving: on hire = owned - available -
      in repair.                                                            */
  const panel = document.querySelector('.inv-detail');
  const onhire = document.getElementById('inv-onhire');
  if (panel && onhire) {
    const num = (f) => {
      const el = panel.querySelector(`[data-f="${cssEsc(f)}"]`);
      return Math.max(0, Math.round(Number((el && el.value) || 0)));
    };
    const recalc = () => {
      const owned = num('quantityTotal');
      const v = Math.max(0, owned - num('quantityAvailable') - num('quantityRepair'));
      onhire.textContent = String(v);
    };
    ['quantityTotal', 'quantityAvailable', 'quantityRepair'].forEach((f) => {
      const el = panel.querySelector(`[data-f="${cssEsc(f)}"]`);
      if (el) el.addEventListener('input', recalc);
    });
  }

  const photoInput = document.getElementById('inv-photo-input');
  if (photoInput) {
    photoInput.addEventListener('change', () => {
      const file = photoInput.files && photoInput.files[0];
      if (file) handlePhotoFile(file);
      photoInput.value = '';   // let the same file be picked again after a remove
    });
  }
  const photoRemove = document.getElementById('inv-photo-remove');
  if (photoRemove) photoRemove.addEventListener('click', onRemovePhoto);

  // Drag-and-drop onto the photo box.
  const drop = document.getElementById('inv-photo-drop');
  if (drop) {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    drop.addEventListener('dragover', (e) => { stop(e); drop.classList.add('is-drop'); });
    drop.addEventListener('dragleave', (e) => { stop(e); drop.classList.remove('is-drop'); });
    drop.addEventListener('drop', (e) => {
      stop(e); drop.classList.remove('is-drop');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handlePhotoFile(file);
    });
    // Click the box itself to open the file picker.
    drop.addEventListener('click', () => { if (photoInput) photoInput.click(); });
  }

  // Paste a screenshot (Ctrl/Cmd+V) while a detail panel is open. Wired once,
  // on the document, and guarded by whether an item is open.
  if (!window.__invPasteWired) {
    window.__invPasteWired = true;
    document.addEventListener('paste', (e) => {
      if (state.view !== 'inventory' || state.openInvId == null) return;
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) { e.preventDefault(); handlePhotoFile(f); }
          break;
        }
      }
    });
  }
}

/*  A photo arrived (picked, dropped or pasted). For a saved item it uploads
    straight away; for a new one it is held and uploaded on save.          */
function handlePhotoFile(file) {
  const msg = document.getElementById('inv-photo-msg');
  const bad = (t) => { if (msg) { msg.textContent = t; msg.className = 'ad-quote-msg is-bad'; } };

  if (!file || !/^image\//.test(file.type)) return bad('That’s not an image.');
  if (file.size > 8 * 1024 * 1024) return bad('Image is over 8 MB — try a smaller one.');

  if (state.openInvId === '__new__') {
    clearPendingPhoto();
    pendingPhoto = file;
    pendingPhotoUrl = URL.createObjectURL(file);
    setInvPhotoPreview(pendingPhotoUrl);
    if (msg) { msg.textContent = 'Photo ready — it’ll save with the item.'; msg.className = 'ad-quote-msg is-ok'; }
    return;
  }
  uploadInvPhoto(state.openInvId, file);
}

/*  Remove clears a pending (unsaved) photo locally, or deletes a saved one. */
function onRemovePhoto() {
  if (pendingPhoto) {
    clearPendingPhoto();
    setInvPhotoPreview('');
    const msg = document.getElementById('inv-photo-msg');
    if (msg) { msg.textContent = ''; msg.className = 'ad-quote-msg'; }
    return;
  }
  removeInvPhoto(state.openInvId);
}

/*  Push one image to Storage under inventory/<id> and record its URL on the
    doc. Shared by the immediate upload (saved item) and the save-time upload
    of a photo added to a brand-new item.                                   */
async function doUploadPhoto(id, file) {
  const { ref, uploadBytes, getDownloadURL } = fb.st;
  const { doc, setDoc } = fb.f;
  const path = `inventory/${id}`;                    // one photo per item, overwritten
  await uploadBytes(ref(fb.storage, path), file, { contentType: file.type });
  const url = await getDownloadURL(ref(fb.storage, path));
  await setDoc(doc(fb.db, 'inventory', id), { photoUrl: url, photoPath: path }, { merge: true });
  const item = (state.inventory || []).find((x) => x.id === id);
  if (item) { item.photoUrl = url; item.photoPath = path; }
  return { url, path };
}

/*  Upload a photo for a saved item straight away, updating only the preview
    (not a full render, which would wipe anything typed but not yet saved).
    The table thumbnail refreshes on its own through the inventory snapshot. */
async function uploadInvPhoto(id, file) {
  if (!id || id === '__new__') return;
  const msg = document.getElementById('inv-photo-msg');
  if (msg) { msg.textContent = 'Uploading…'; msg.className = 'ad-quote-msg'; }

  try {
    const { url } = await doUploadPhoto(id, file);
    setInvPhotoPreview(url);
    if (msg) { msg.textContent = 'Photo saved.'; msg.className = 'ad-quote-msg is-ok'; }
  } catch (err) {
    if (msg) { msg.textContent = err.message || 'Upload failed.'; msg.className = 'ad-quote-msg is-bad'; }
  }
}

async function removeInvPhoto(id) {
  if (!id || id === '__new__') return;
  const item = (state.inventory || []).find((x) => x.id === id) || {};
  const msg = document.getElementById('inv-photo-msg');
  try {
    const { ref, deleteObject } = fb.st;
    const { doc, setDoc } = fb.f;
    if (item.photoPath) {
      try { await deleteObject(ref(fb.storage, item.photoPath)); } catch (e) { /* already gone */ }
    }
    await setDoc(doc(fb.db, 'inventory', id), { photoUrl: '', photoPath: '' }, { merge: true });
    item.photoUrl = ''; item.photoPath = '';
    setInvPhotoPreview('');                           // in place, keep the form
    if (msg) { msg.textContent = 'Photo removed.'; msg.className = 'ad-quote-msg is-ok'; }
  } catch (err) {
    if (msg) { msg.textContent = err.message || 'Could not remove.'; msg.className = 'ad-quote-msg is-bad'; }
  }
}

/*  Swap the photo preview and its buttons without touching the rest of the
    detail panel, so a photo change never disturbs the fields being edited. */
function setInvPhotoPreview(url) {
  const panel = document.querySelector('.inv-detail');
  if (!panel) return;

  const preview = panel.querySelector('.inv-photo-preview');
  const cat = (panel.querySelector('[data-f="category"]') || {}).value || '';
  const name = (panel.querySelector('[data-f="name"]') || {}).value || '';
  if (preview) {
    preview.innerHTML = url
      ? `<img src="${attr(url)}" alt="">`
      : `<span class="inv-photo-ph ${invCatClass(cat)}">${esc((cat || name || '?').trim().charAt(0).toUpperCase())}</span>`;
  }

  const actions = panel.querySelector('.inv-photo-actions');
  if (actions) {
    const label = actions.querySelector('.inv-photo-btn');
    if (label) label.childNodes[0].nodeValue = url ? 'Replace photo ' : 'Upload photo ';
    let remove = actions.querySelector('#inv-photo-remove');
    if (url && !remove) {
      remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'ad-btn ad-btn-small'; remove.id = 'inv-photo-remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', onRemovePhoto);
      if (label) label.insertAdjacentElement('afterend', remove);
    } else if (!url && remove) {
      remove.remove();
    }
  }
}

async function saveInvItem(btn) {
  const panel = document.querySelector('.inv-detail');
  const msg = document.getElementById('inv-msg');
  if (!panel) return;

  const get = (f) => {
    const el = panel.querySelector(`[data-f="${cssEsc(f)}"]`);
    if (!el) return '';
    return el.type === 'checkbox' ? el.checked : el.value;
  };
  const dollarsToCents = (v) => Math.round(Number(v || 0) * 100);
  const int = (v) => Math.max(0, Math.round(Number(v || 0)));

  const name = String(get('name') || '').trim();
  if (!name) {
    if (msg) { msg.textContent = 'Give it a name first.'; msg.className = 'ad-quote-msg is-bad'; }
    return;
  }

  const qt = int(get('quantityTotal'));
  const data = {
    name,
    subtitle: String(get('subtitle') || '').trim(),
    category: String(get('category') || '').trim(),
    status: get('status') || 'available',
    quantityTotal: qt,
    quantityRepair: Math.min(int(get('quantityRepair')), qt),
    quantityAvailable: Math.min(int(get('quantityAvailable')), qt),
    location: String(get('location') || '').trim(),
    pricingType: 'per-day',
    priceCents: dollarsToCents(get('priceCents')),
    extraDayCents: dollarsToCents(get('extraDayCents')),
    replacementCents: dollarsToCents(get('replacementCents')),
    internalNotes: String(get('internalNotes') || '').trim().slice(0, 2000),
    repairFault: String(get('repairFault') || '').trim().slice(0, 1000),
    repairWith: String(get('repairWith') || '').trim().slice(0, 200),
    repairDue: String(get('repairDue') || '').trim().slice(0, 100),
    specs: String(get('specs') || '').trim().slice(0, 2000),
    weight: String(get('weight') || '').trim().slice(0, 100),
    powerDraw: String(get('powerDraw') || '').trim().slice(0, 100),
    included: String(get('included') || '').trim().slice(0, 2000),
    inBot: !!get('inBot'),
  };

  if (msg) { msg.textContent = 'Saving…'; msg.className = 'ad-quote-msg'; }
  if (btn) btn.disabled = true;

  try {
    const { collection, doc, setDoc, addDoc } = fb.f;
    state.inventory = state.inventory || [];

    if (state.openInvId === '__new__') {
      data.order = state.inventory.length;
      const ref = await addDoc(collection(fb.db, 'inventory'), data);
      state.openInvId = ref.id;   // stay open on the new item
      // Seed state now so the re-render shows the saved item without waiting
      // on the snapshot round-trip.
      state.inventory.push({ id: ref.id, ...data });
      // A photo added before saving goes up now that the item has an id.
      if (pendingPhoto) {
        try { await doUploadPhoto(ref.id, pendingPhoto); } catch (e) { /* item saved; photo can be retried */ }
        clearPendingPhoto();
      }
    } else {
      const id = state.openInvId;
      await setDoc(doc(fb.db, 'inventory', id), data, { merge: true });
      // Merge onto what we already hold (keeps photoUrl), so the re-render
      // below shows exactly what was saved rather than pre-save state.
      const cur = state.inventory.find((x) => x.id === id);
      if (cur) Object.assign(cur, data); else state.inventory.push({ id, ...data });
    }
    // A deliberate save may repaint the panel (header/name, photo controls);
    // state is already updated above, so nothing typed is lost.
    render();
    const m2 = document.getElementById('inv-msg');   // the repaint made a fresh one
    if (m2) { m2.textContent = 'Saved.'; m2.className = 'ad-quote-msg is-ok'; }
  } catch (err) {
    if (btn) btn.disabled = false;
    if (msg) { msg.textContent = err.message || 'Could not save.'; msg.className = 'ad-quote-msg is-bad'; }
  }
}

async function deleteInvItem(btn) {
  if (!state.openInvId || state.openInvId === '__new__') return;
  const item = (state.inventory || []).find((x) => x.id === state.openInvId);
  const name = item ? (item.name || 'this item') : 'this item';
  if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;

  if (btn) btn.disabled = true;
  try {
    const { doc, deleteDoc } = fb.f;
    await deleteDoc(doc(fb.db, 'inventory', state.openInvId));
    state.openInvId = null;
    render();
  } catch (err) {
    if (btn) btn.disabled = false;
    const msg = document.getElementById('inv-msg');
    if (msg) { msg.textContent = err.message || 'Could not delete.'; msg.className = 'ad-quote-msg is-bad'; }
  }
}
