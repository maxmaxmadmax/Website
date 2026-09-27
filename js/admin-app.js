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
} from './firebase-config.js?v=187';

import { expandKit } from './kit.js?v=187';

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

  /*  Quotes / invoices. quoteDocs streams in live; openQuoteId is null on
      the list, an id (or '__new__') when the builder is open.            */
  quoteDocs: [],
  openQuoteId: null,
  quoteDocFilter: 'all',

  /*  Packages - reusable bundles the bot will draw on. null until first
      load; openPackageId is null on the list, an id (or '__new__') in the
      editor.                                                              */
  packages: null,
  openPackageId: null,
  pkgFilter: 'all',
  pkgSearch: '',
  pkgTab: 'details',
  pkgTierSel: 0,

  /*  Crew & vehicles - staff / vehicle / trailer records, billable onto a
      quote. null until first load.                                        */
  resources: null,
  openResourceId: null,
  resFilter: 'all',
  resSearch: '',

  /*  Leads - the gig lead generator. null until first load; openLeadId is
      null on the list, an id (or '__new__') in the editor. leadCompose holds
      the email draft while the composer is open.                          */
  leads: null,
  openLeadId: null,
  leadFilter: 'all',
  leadTypeFilter: 'all',
  leadCatFilter: 'all',
  leadGrokFilter: 'all',
  leadContactFilter: 'all',
  leadRegionFilter: 'all',
  leadSizeFilter: 'all',
  leadFitFilter: 'all',
  leadMonth: '',           // 'YYYY-MM' picked on the calendar strip, '' = any
  leadWeek: '',            // ISO week picked on the strip, e.g. '2026-W39', '' = any
  leadCalOffset: 0,        // months the strip is scrolled from this month
  leadSearch: '',
  leadCompose: null,
  leadTab: 'overview',     // side-panel tab: overview / details / contacts / outreach / notes
  leadChip: 'all',         // quick-filter chip: all / high / medium / low / inplay / won / lost / needs
  leadRange: 'all',        // Showing: all / next12 / next3 / month / nodate / past
  leadSort: 'date',        // Sort column: date / priority / value / name / location / category / stage / last / updated
  leadSortDir: '',         // 'asc' / 'desc'; '' = that column's natural direction
  leadPage: 1,
  leadPerPage: 10,
  quoteFromLeadId: '',     // set while a quote started from a lead is unsaved
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
    subscribeToQuoteDocs();
    subscribeToPackages();
    subscribeToResources();
    subscribeToLeads();
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
               'settings', 'vendorEmail', 'quotes', 'inventory', 'botSettings',
               'quoteDocs', 'packages', 'resources', 'leads', 'leadRate'];

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
      //  Category first, then A-Z by name within it. Names starting with a
      //  letter come before ones starting with a number/symbol (so "A…"
      //  beats "18…"), matching the column-sort behaviour.
      const nameRank = (s) => (/^\s*[a-z]/i.test(s || '') ? 0 : 1);
      items.sort((a, b) =>
        (a.category || '').localeCompare(b.category || '')
        || nameRank(a.name) - nameRank(b.name)
        || (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' }));
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

/*  A count badge on the Quotes & Invoices rail item for quotes the bot
    created and nobody has actioned yet (still draft). */
function updateBotBadge() {
  const n = (state.quoteDocs || []).filter((q) => q.source === 'bot' && q.status === 'draft').length;
  const btn = document.querySelector('.ad-nav-item[data-view="quoteDocs"]');
  if (!btn) return;
  let b = btn.querySelector('.ad-nav-badge');
  if (n > 0) {
    if (!b) { b = document.createElement('span'); b.className = 'ad-nav-badge'; btn.appendChild(b); }
    b.textContent = String(n);
  } else if (b) {
    b.remove();
  }
}

/*  Quotes / invoices, live. Only re-render the list when it is on screen;
    while the builder is open the draft is edited off to the side, so a
    snapshot must not repaint over it.                                     */
function subscribeToQuoteDocs() {
  const { collection, onSnapshot, query, orderBy } = fb.f;
  unsubscribes.push(onSnapshot(
    query(collection(fb.db, 'quotes'), orderBy('createdAt', 'desc')),
    (snap) => {
      state.quoteDocs = [];
      snap.forEach((d) => state.quoteDocs.push({ id: d.id, ...d.data() }));
      updateBotBadge();
      if (state.view === 'quoteDocs' && !state.openQuoteId) render();
    },
    (err) => console.error('quotes', err)
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

  /*  Leads works like an app: one screen tall, the top fixed, only the
      list scrolls (see "LEADS: one-screen app layout" in admin.css).  */
  desk.classList.toggle('is-leads', state.view === 'leads');
  document.body.classList.toggle('ad-fit-leads', state.view === 'leads');

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
    setupMins: Math.max(0, invNum(r.setupMins, 0)),   // man-minutes to set up one unit; feeds labour
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
    requirements: (Array.isArray(r.requirements) ? r.requirements : []).map(normalizeReq),
    order: invNum(r.order, 0),
  };
}

function invItems() { return invModelRaw().map(invItem); }

/* -------------------------------------------------------------------------
   Item requirements  -  the gear an item needs (see js/kit.js for the maths)
   ------------------------------------------------------------------------- */
function normalizeReq(r) {
  r = r || {};
  const rule = r.rule === 'shared' ? 'shared' : 'per-item';
  const charge = ['normal', 'discounted', 'free'].includes(r.charge) ? r.charge : 'normal';
  return {
    itemId: String(r.itemId || ''),
    rule,
    qty: Math.max(rule === 'shared' ? 1 : 0, Math.round(invNum(r.qty, 1))),
    coversN: Math.max(1, Math.round(invNum(r.coversN, 1))),
    charge,
    discountCents: Math.max(0, Math.round(invNum(r.discountCents, 0))),
  };
}

/*  The working copy of the open item's requirements, edited in the panel and
    written back on save. Kept off the item so a live snapshot cannot wipe an
    edit in progress (same reason as the pending photo).                    */
let invReqDraft = [];
function initInvReqDraft(item) {
  invReqDraft = (item && Array.isArray(item.requirements) ? item.requirements : [])
    .map(normalizeReq);
}

/*  Every OTHER item, for the "required item" dropdown - an item cannot
    require itself.                                                         */
function invReqOptions(excludeId) {
  return invItems()
    .filter((it) => it.id && it.id !== excludeId && it.name)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/*  itemsById for the kit engine, with the item being edited overlaid with
    the in-progress draft (and given a temp id when it is brand new).      */
function invKitIndex(editId, editName) {
  const byId = {};
  invItems().forEach((it) => { byId[it.id] = it; });
  const id = editId && editId !== '__new__' ? editId : '__preview__';
  byId[id] = {
    id,
    name: editName || (byId[editId] && byId[editId].name) || 'This item',
    priceCents: (byId[editId] && byId[editId].priceCents) || 0,
    quantityAvailable: byId[editId] ? byId[editId].quantityAvailable : Infinity,
    quantityTotal: byId[editId] ? byId[editId].quantityTotal : Infinity,
    requirements: invReqDraft,
  };
  return { byId, id };
}

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

          <label class="ad-field inv-span2"><span>Setup time (min per unit)</span>
            <input class="ad-input" type="number" min="0" step="1" data-f="setupMins" value="${attr(it.setupMins || '')}"
                   placeholder="e.g. 10"><em class="inv-field-hint">Man-minutes to set one up. Feeds the labour charge on delivered quotes.</em></label>

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

        <div class="inv-detail-section inv-reqs">
          <div class="inv-reqs-head">
            <h3>Item requirements</h3>
            <button type="button" class="ad-btn ad-btn-small inv-reqs-add" id="inv-req-add">+ Add requirement</button>
          </div>
          <p class="inv-reqs-intro">Gear this item needs to work. When it&rsquo;s hired,
             these come too &mdash; and their own requirements follow automatically.</p>
          <div class="inv-reqs-list" id="inv-reqs-list"></div>
          <div class="inv-reqs-preview" id="inv-reqs-preview"></div>
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
  if (add) add.addEventListener('click', () => {
    clearPendingPhoto(); initInvReqDraft(null); state.openInvId = '__new__'; render();
  });

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
    if (id) {
      clearPendingPhoto();
      initInvReqDraft((state.inventory || []).find((x) => x.id === id));
      state.openInvId = id;
      render();
    }
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

  wireInvReqs();

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
    setupMins: int(get('setupMins')),
    internalNotes: String(get('internalNotes') || '').trim().slice(0, 2000),
    repairFault: String(get('repairFault') || '').trim().slice(0, 1000),
    repairWith: String(get('repairWith') || '').trim().slice(0, 200),
    repairDue: String(get('repairDue') || '').trim().slice(0, 100),
    specs: String(get('specs') || '').trim().slice(0, 2000),
    weight: String(get('weight') || '').trim().slice(0, 100),
    powerDraw: String(get('powerDraw') || '').trim().slice(0, 100),
    included: String(get('included') || '').trim().slice(0, 2000),
    inBot: !!get('inBot'),
    // Requirements come from their own draft, not the field grid. Drop any
    // half-added row that never got an item chosen.
    requirements: invReqDraft.map(normalizeReq).filter((r) => r.itemId).slice(0, 40),
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


/* -------------------------------------------------------------------------
   Item requirements  -  the detail-panel editor + live kit preview
   ------------------------------------------------------------------------- */
let invReqPreviewQty = 1;

const invMoney = (c) => {
  const n = Math.round(c || 0);
  return '$' + (n / 100).toFixed(n % 100 ? 2 : 0);
};

function reqRowHtml(r, i, options) {
  const itemOpts = options.map((o) =>
    `<option value="${attr(o.id)}"${r.itemId === o.id ? ' selected' : ''}>${esc(o.name)}</option>`).join('');
  const chargeOpts = [['normal', 'Normal price'], ['discounted', 'Discounted'], ['free', 'Included free']]
    .map((c) => `<option value="${c[0]}"${r.charge === c[0] ? ' selected' : ''}>${c[1]}</option>`).join('');

  const qtyFields = r.rule === 'shared'
    ? `<label class="inv-req-f"><span>Qty</span>
         <input class="ad-input" type="number" min="1" step="1" data-rf="qty" value="${attr(r.qty)}"></label>
       <label class="inv-req-f"><span>Covers (units)</span>
         <input class="ad-input" type="number" min="1" step="1" data-rf="coversN" value="${attr(r.coversN)}"></label>`
    : `<label class="inv-req-f"><span>Qty per unit</span>
         <input class="ad-input" type="number" min="0" step="1" data-rf="qty" value="${attr(r.qty)}"></label>`;

  const discField = r.charge === 'discounted'
    ? `<label class="inv-req-f"><span>Price $</span>
         <input class="ad-input" type="number" min="0" step="1" data-rf="discountCents" value="${attr(r.discountCents ? r.discountCents / 100 : '')}"></label>`
    : '';

  return `
    <div class="inv-req" data-i="${i}">
      <button type="button" class="inv-req-del" data-req-del title="Remove">&times;</button>
      <div class="inv-req-grid">
        <label class="inv-req-f inv-req-item"><span>Required item</span>
          <select class="ad-select" data-rf="itemId">
            <option value="">Choose item&hellip;</option>${itemOpts}
          </select></label>
        <label class="inv-req-f"><span>How</span>
          <select class="ad-select" data-rf="rule">
            <option value="per-item"${r.rule === 'per-item' ? ' selected' : ''}>Per item</option>
            <option value="shared"${r.rule === 'shared' ? ' selected' : ''}>Shared capacity</option>
          </select></label>
        ${qtyFields}
        <label class="inv-req-f"><span>Charge</span>
          <select class="ad-select" data-rf="charge">${chargeOpts}</select></label>
        ${discField}
      </div>
    </div>`;
}

function renderInvReqs() {
  const list = document.getElementById('inv-reqs-list');
  if (!list) return;
  const options = invReqOptions(state.openInvId);
  list.innerHTML = invReqDraft.length
    ? invReqDraft.map((r, i) => reqRowHtml(r, i, options)).join('')
    : '<p class="inv-reqs-empty">No requirements yet &mdash; add the gear this item needs to work.</p>';
  renderInvReqPreview();
}

/*  Live "what comes with it" preview, run through the same kit engine the
    quotes and pick list will use.                                          */
function renderInvReqPreview() {
  const host = document.getElementById('inv-reqs-preview');
  if (!host) return;

  const nameEl = document.querySelector('.inv-detail [data-f="name"]');
  const editName = nameEl ? nameEl.value : '';
  const { byId, id } = invKitIndex(state.openInvId, editName);
  const qty = Math.max(1, Math.round(invReqPreviewQty || 1));

  const kit = expandKit({ [id]: qty }, byId);

  const chargeLabel = (r) => r.charge === 'free' ? 'included free'
    : (r.charge === 'discounted' ? invMoney(r.unitCents) + ' ea' : invMoney(r.unitCents) + ' ea');

  const lines = kit.required.length
    ? kit.required.map((r) =>
        `<li><span class="inv-req-pv-qty">${esc(r.qty)}&times;</span> ${esc(r.name)}
           <span class="inv-req-pv-charge">${chargeLabel(r)}</span></li>`).join('')
    : '<li class="inv-reqs-empty">Nothing else needed.</li>';

  const shorts = kit.shortages.length
    ? `<p class="inv-reqs-short">&#9888; Short: ${kit.shortages.map((s) =>
        `${esc(s.name)} needs ${s.needed}, ${s.available === Infinity ? '—' : s.available} available`)
        .join('; ')}</p>`
    : '';

  host.innerHTML = `
    <div class="inv-reqs-pv">
      <p class="inv-reqs-pv-head">If you hire
        <input class="ad-input inv-req-pv-num" type="number" id="inv-req-qty" min="1" step="1" value="${attr(qty)}">
        of this, the kit adds:</p>
      <ul class="inv-reqs-pv-list">${lines}</ul>
      <p class="inv-reqs-pv-total">${kit.addCents ? 'Adds ' + invMoney(kit.addCents) : 'No extra charge'}</p>
      ${shorts}
    </div>`;
}

function applyReqField(r, f, val) {
  if (f === 'discountCents') r.discountCents = Math.max(0, Math.round(Number(val || 0) * 100));
  else if (f === 'qty') r.qty = Math.max(0, Math.round(Number(val || 0)));
  else if (f === 'coversN') r.coversN = Math.max(1, Math.round(Number(val || 0)));
  else r[f] = val;   // itemId, rule, charge
}

function wireInvReqs() {
  const addBtn = document.getElementById('inv-req-add');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      invReqDraft.push(normalizeReq({ itemId: '', rule: 'per-item', qty: 1, coversN: 1, charge: 'normal' }));
      renderInvReqs();
    });
  }

  const list = document.getElementById('inv-reqs-list');
  if (list) {
    list.addEventListener('change', (e) => {
      const el = e.target.closest('[data-rf]');
      const row = el && el.closest('.inv-req');
      if (!row) return;
      const i = Number(row.getAttribute('data-i'));
      const r = invReqDraft[i];
      if (!r) return;
      const f = el.getAttribute('data-rf');
      applyReqField(r, f, el.value);
      if (f === 'rule' || f === 'charge') { invReqDraft[i] = normalizeReq(r); renderInvReqs(); }
      else renderInvReqPreview();
    });
    list.addEventListener('input', (e) => {
      const el = e.target.closest('[data-rf]');
      const row = el && el.closest('.inv-req');
      if (!row) return;
      const f = el.getAttribute('data-rf');
      if (f === 'rule' || f === 'charge' || f === 'itemId') return;   // selects handled on change
      const i = Number(row.getAttribute('data-i'));
      const r = invReqDraft[i];
      if (!r) return;
      applyReqField(r, f, el.value);
      renderInvReqPreview();
    });
    list.addEventListener('click', (e) => {
      const del = e.target.closest('[data-req-del]');
      if (!del) return;
      const row = del.closest('.inv-req');
      invReqDraft.splice(Number(row.getAttribute('data-i')), 1);
      renderInvReqs();
    });
  }

  const preview = document.getElementById('inv-reqs-preview');
  if (preview) {
    preview.addEventListener('input', (e) => {
      if (e.target.id === 'inv-req-qty') {
        invReqPreviewQty = Math.max(1, Math.round(Number(e.target.value || 1)));
        renderInvReqPreview();
      }
    });
  }

  invReqPreviewQty = 1;
  renderInvReqs();
}


/* =========================================================================
   QUOTES & INVOICES  -  the admin builder

   List of quotes, and a builder for one: customer, hire dates, line items
   (from inventory with the kit engine auto-adding required gear, plus custom
   lines and discounts), live totals (ex-GST, +10% GST), and the actions to
   save, email the link, accept, invoice and mark paid.
   ========================================================================= */

function blankQuote() {
  return {
    kind: 'quote',
    customer: { name: '', business: '', email: '', phone: '', address: '', eventName: '', eventDate: '' },
    hire: { startDate: '', endDate: '', days: 1 },
    lines: [],
    discountCents: 0,
    labourExcluded: false,     // setup & pack-down labour is on by default (delivered jobs)
    deliveryTown: '',          // '' = pickup / no delivery
    deliveryKm: 0,             // one-way road km from Bowen
    notes: '',
    terms: '',
  };
}

/*  Delivery: a town -> one-way km lookup from the Bowen base. The charge is
    $0.80/km RETURN, so delivery = km x 2 x $0.80. No base fee. "Other" lets
    staff type a km for anywhere not listed. Edit distances here for now.    */
const DELIVERY_RATE_PER_KM_CENTS = 80;   // $0.80 per km travelled
const DELIVERY_ZONES = [
  { town: 'Bowen (local)', km: 0 },
  { town: 'Merinda', km: 12 },
  { town: 'Guthalungra', km: 38 },
  { town: 'Proserpine', km: 64 },
  { town: 'Home Hill', km: 79 },
  { town: 'Cannonvale', km: 84 },
  { town: 'Collinsville', km: 86 },
  { town: 'Scottville', km: 88 },
  { town: 'Airlie Beach', km: 88 },
  { town: 'Jubilee Pocket', km: 90 },
  { town: 'Ayr', km: 91 },
  { town: 'Bloomsbury', km: 95 },
  { town: 'Shute Harbour', km: 98 },
  { town: 'Brandon', km: 98 },
  { town: 'Giru', km: 130 },
  { town: 'Glenden', km: 150 },
  { town: 'Mackay', km: 189 },
  { town: 'Townsville', km: 200 },
  { town: 'Charters Towers', km: 245 },
  { town: 'Moranbah', km: 300 },
  { town: 'Clermont', km: 400 },
  { town: 'Hughenden', km: 450 },
  { town: 'Emerald', km: 500 },
  { town: 'Richmond', km: 560 },
  { town: 'Winton', km: 660 },
  { town: 'Julia Creek', km: 670 },
  { town: 'Cloncurry', km: 780 },
  { town: 'Longreach', km: 810 },
  { town: 'Mount Isa', km: 900 },
  { town: 'Barcaldine', km: 900 },
];

function quoteDeliveryCents(d) {
  const km = Math.max(0, Math.round(d.deliveryKm || 0));
  return km * 2 * DELIVERY_RATE_PER_KM_CENTS;   // return trip
}

/*  Labour: setup time is a man-minute figure on each inventory item. Total
    setup across the (already kit-expanded) cart, plus pack-down at 75%, is
    billed at $60/hr, rounded UP to a whole hour, minimum one hour. Setup
    times default to 0, so until they're entered this simply comes to $0.   */
const LABOUR_RATE_CENTS = 6000;   // $60 / hour
const PACKDOWN_PCT = 0.75;

function quoteSetupMins(d) {
  const byId = (typeof invByIdMap === 'function') ? invByIdMap() : {};
  let mins = 0;
  (d.lines || []).forEach((l) => {
    if (!l.itemId) return;                         // custom / crew / discount: no setup
    const inv = byId[l.itemId];
    if (!inv) return;
    mins += Math.max(0, Math.round(inv.setupMins || 0)) * Math.max(0, Math.round(l.qty || 0));
  });
  return mins;
}

function quoteLabour(d) {
  const setup = quoteSetupMins(d);
  if (!setup) return { setupMins: 0, totalMins: 0, hours: 0, cents: 0 };
  const total = setup + Math.round(setup * PACKDOWN_PCT);
  const hours = Math.max(1, Math.ceil(total / 60));
  return { setupMins: setup, totalMins: total, hours, cents: hours * LABOUR_RATE_CENTS };
}

let quoteDraft = blankQuote();

const QDOC_STATUS = {
  draft:     ['ad-pill-grey',  'Draft'],
  sent:      ['ad-pill-blue',  'Sent'],
  accepted:  ['ad-pill-green', 'Accepted'],
  declined:  ['ad-pill-red',   'Declined'],
  invoiced:  ['ad-pill-amber', 'Invoiced'],
  paid:      ['ad-pill-green', 'Paid'],
  cancelled: ['ad-pill-grey',  'Cancelled'],
};
function qdocPill(s) { const [c, l] = QDOC_STATUS[s] || QDOC_STATUS.draft; return `<span class="ad-pill ${c}">${esc(l)}</span>`; }

/*  Totals - mirror of quoteMoney() in functions/index.js. Prices ex-GST,
    discounts off the net, GST 10% on top.                                 */
function quoteDraftMoney(d) {
  const docDays = Math.max(1, Math.round((d.hire && d.hire.days) || 1));
  let subtotal = 0;
  let discount = Math.max(0, Math.round(d.discountCents || 0));   // discount off the whole total
  (d.lines || []).forEach((l) => {
    if (l.type === 'discount') { discount += Math.max(0, Math.round(l.amountCents || 0)); return; }
    subtotal += quoteLineCents(l, docDays);
  });
  const labourCents = d.labourExcluded === true ? 0 : quoteLabour(d).cents;
  const deliveryCents = quoteDeliveryCents(d);
  const net = Math.max(0, subtotal + labourCents + deliveryCents - discount);
  const gst = Math.round(net * 0.10);
  return { subtotalCents: subtotal, labourCents, deliveryCents, discountCents: discount, netCents: net, gstCents: gst, totalCents: net + gst };
}

/*  A line's own total: quantity x day rate x number of days.
    Custom lines default to 1 day unless the staffer sets more.
    Discounts are handled once against the whole total, not per line.     */
function quoteLineCents(l, docDays) {
  if (l.type === 'discount') return -Math.max(0, Math.round(l.amountCents || 0));
  const qty = Math.max(0, Math.round(l.qty || 0));
  const unit = Math.max(0, Math.round(l.unitCents || 0));
  const days = Math.max(1, Math.round(l.days || docDays || 1));
  return qty * unit * days;
}

VIEWS.quoteDocs = {
  html() { return state.openQuoteId ? quoteBuilderHtml() : quoteListHtml(); },
  wire() { if (state.openQuoteId) wireQuoteBuilder(); else wireQuoteList(); },
};

/* -------------------------------------------------------------------------
   List
   ------------------------------------------------------------------------- */
function quoteListHtml() {
  const f = state.quoteDocFilter;
  const opt = (v, l) => `<option value="${v}"${f === v ? ' selected' : ''}>${l}</option>`;
  return `
    <div class="ad-mail-head-row">
      <span class="ad-mail-icon" aria-hidden="true">&#128196;</span>
      <div class="ad-mail-title">
        <h1>Quotes &amp; Invoices</h1>
        <p>Build a quote, send it for the customer to accept, then turn it into an invoice.</p>
      </div>
      <div class="ad-mail-status">
        <button type="button" class="ad-btn ad-btn-primary" id="q-new">+ New quote</button>
      </div>
    </div>

    <section class="ad-card ad-panel">
      <header class="ad-panel-head">
        <div><h2>All quotes</h2><p class="ad-panel-sub">Newest first.</p></div>
        <select id="q-filter" class="ad-select" aria-label="Filter by status">
          ${opt('all', 'All statuses')}${opt('draft', 'Draft')}${opt('sent', 'Sent')}
          ${opt('accepted', 'Accepted')}${opt('invoiced', 'Invoiced')}${opt('paid', 'Paid')}
        </select>
      </header>
      <div class="ad-table-wrap">
        <table class="ad-table">
          <thead><tr><th>Number</th><th>Customer</th><th>Event</th>
            <th class="inv-num">Total</th><th>Status</th><th>Date</th><th></th></tr></thead>
          <tbody id="q-rows"></tbody>
        </table>
      </div>
    </section>`;
}

function quoteDocsFiltered() {
  const f = state.quoteDocFilter;
  return (state.quoteDocs || []).filter((q) => f === 'all' || q.status === f);
}

function renderQuoteDocRows() {
  const host = document.getElementById('q-rows');
  if (!host) return;
  const rows = quoteDocsFiltered();
  if (!rows.length) {
    host.innerHTML = '<tr><td colspan="7" class="ad-cell-muted">No quotes yet. Hit &ldquo;New quote&rdquo; to start one.</td></tr>';
    return;
  }
  host.innerHTML = rows.map((q) => {
    const num = q.kind === 'invoice' && q.invoiceNumber ? q.invoiceNumber : q.number;
    const c = q.customer || {};
    return `
      <tr class="ad-quote-row" data-open-q="${attr(q.id)}">
        <td class="ad-cell-strong">${esc(num || '')}${q.source === 'bot' ? '<span class="ad-bot-tag">Bot</span>' : ''}</td>
        <td>${esc(c.name || c.business || '')}</td>
        <td>${esc(c.eventName || '—')}</td>
        <td class="inv-num">${esc(money(q.totalCents))}</td>
        <td>${qdocPill(q.status)}</td>
        <td class="ad-cell-muted">${esc(dateShort(q.createdAt))}</td>
        <td class="ad-cell-right"><span class="ad-quote-caret">&#8250;</span></td>
      </tr>`;
  }).join('');
}

function wireQuoteList() {
  renderQuoteDocRows();
  const nw = document.getElementById('q-new');
  if (nw) nw.addEventListener('click', () => { quoteDraft = blankQuote(); state.quoteFromLeadId = ''; state.openQuoteId = '__new__'; render(); });
  const filter = document.getElementById('q-filter');
  if (filter) filter.addEventListener('change', () => { state.quoteDocFilter = filter.value; renderQuoteDocRows(); });
  const rows = document.getElementById('q-rows');
  if (rows) rows.addEventListener('click', (e) => {
    const r = e.target.closest('[data-open-q]');
    if (!r) return;
    const id = r.getAttribute('data-open-q');
    const doc = (state.quoteDocs || []).find((x) => x.id === id);
    quoteDraft = doc ? quoteFromDoc(doc) : blankQuote();
    state.openQuoteId = id;
    render();
  });
}

function quoteFromDoc(doc) {
  return {
    kind: doc.kind || 'quote',
    customer: { ...blankQuote().customer, ...(doc.customer || {}) },
    hire: { ...blankQuote().hire, ...(doc.hire || {}) },
    // Labour and delivery lines are recomputed live, so drop stored ones here.
    lines: (doc.lines || []).filter((l) => l.type !== 'labour' && l.type !== 'delivery').map((l) => ({ ...l })),
    discountCents: Math.max(0, Math.round(doc.discountCents || 0)),
    labourExcluded: doc.labourExcluded === true,
    deliveryTown: (doc.delivery && doc.delivery.town) || '',
    deliveryKm: Math.max(0, Math.round((doc.delivery && doc.delivery.km) || 0)),
    notes: doc.notes || '',
    terms: doc.terms || '',
  };
}

/* -------------------------------------------------------------------------
   Builder
   ------------------------------------------------------------------------- */
function currentQuoteDoc() {
  return (state.quoteDocs || []).find((x) => x.id === state.openQuoteId) || null;
}

function quoteBuilderHtml() {
  const isNew = state.openQuoteId === '__new__';
  const doc = currentQuoteDoc();
  const status = doc ? doc.status : 'draft';
  const isInvoice = doc && doc.kind === 'invoice';
  const docWord = isInvoice ? 'Tax Invoice' : 'Quote';
  const num = doc ? (isInvoice && doc.invoiceNumber ? doc.invoiceNumber : doc.number) : 'New';
  const created = doc && doc.createdAt ? dateShort(doc.createdAt) : dateShort(Math.floor(Date.now() / 1000));
  const c = quoteDraft.customer;
  const h = quoteDraft.hire;

  const invOpts = (typeof invItems === 'function' ? invItems() : [])
    .filter((it) => it.id && it.name)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .map((it) => `<option value="${attr(it.id)}">${esc(it.name)} &middot; ${esc(money(it.priceCents))}/day</option>`).join('');

  const link = doc && doc.token ? (window.location.origin + '/quote?t=' + doc.token) : '';

  const metaRow = (label, value) => `<div class="qb-mrow"><span class="qb-mlabel">${label}</span><span class="qb-mval">${value}</span></div>`;
  const hirePeriod = (h.startDate || h.endDate)
    ? `${esc(h.startDate || '…')} &rarr; ${esc(h.endDate || '…')}`
    : '<span class="qb-faint">Set below</span>';

  const botCard = (doc && doc.source === 'bot') ? (() => {
    const chip = (label, value) => value ? `<div class="qb-botcell"><span>${label}</span><strong>${esc(value)}</strong></div>` : '';
    const support = { full: 'Full service (deliver, set up + on-site tech)', delivery: 'Delivery & setup only', pickup: 'Self-collect from Bowen' }[doc.botSupport] || '—';
    const venueSetting = { indoor: 'Indoors', outdoor: 'Outdoors', mixed: 'Indoor & outdoor' }[doc.botIndoor] || '';
    const powerLbl = { yes: 'Mains power', no: 'No power', unsure: 'Power unsure' }[doc.botPower] || '';
    const accessLbl = { easy: 'Easy', stairs: 'Some stairs / carry', tricky: 'Tricky — upstairs / long carry' }[doc.botAccess] || '';
    const timing = [doc.botStart, doc.botFinish].filter(Boolean).join(' → ');
    const extrasLbl = Array.isArray(doc.botExtras) && doc.botExtras.length ? doc.botExtras.join(', ') : '';
    return `
      <section class="qb-botcard">
        <div class="qb-botcard-h">&#128233; From the estimate bot &mdash; what the customer told us</div>
        <div class="qb-botgrid">
          ${chip('Package matched', doc.packageName)}
          ${chip('Guests', doc.guests)}
          ${chip('Venue', (doc.delivery && doc.delivery.town) || doc.botTown)}
          ${chip('Setting', venueSetting + (powerLbl ? ' · ' + powerLbl : ''))}
          ${chip('Timing', timing)}
          ${chip('Access', accessLbl)}
          ${chip('Days', (doc.hire && doc.hire.days) || 1)}
          ${chip('Event date', c.eventDate)}
          ${chip('Support', support)}
        </div>
        ${extrasLbl ? `<p class="qb-botmsg"><span>Extras chosen:</span> ${esc(extrasLbl)}</p>` : ''}
        ${doc.botGenerator ? '<p class="qb-botflag">⚠ Outdoors with no mains power — a generator estimate is in the lines; confirm the right size.</p>' : ''}
        ${doc.botMessage ? `<p class="qb-botmsg"><span>Their message:</span> ${esc(doc.botMessage)}</p>` : ''}
        <p class="qb-botnote">Review the gear &amp; price against this, adjust anything, then Send.</p>
      </section>`;
  })() : '';

  return `
    <div class="q-build qb">

      <!-- toolbar (not part of the printed paper) -->
      <div class="qb-bar">
        <button type="button" class="qb-back" id="q-back">&larr; All quotes</button>
        <div class="qb-bar-title"><h1>${esc(docWord)} #${esc(num)}</h1>${doc ? qdocPill(status) : '<span class="ad-pill ad-pill-grey">New</span>'}</div>
        <div class="qb-bar-spacer"></div>
        ${link ? `<a class="ad-btn ad-btn-ghost" href="${attr(link)}" target="_blank" rel="noopener">Preview</a>` : ''}
        <button type="button" class="ad-btn${doc ? '' : ' ad-btn-primary'}" id="q-save">Save</button>
        ${doc ? `<button type="button" class="ad-btn ad-btn-primary" id="q-send">${status === 'draft' ? '&#9993; Send Quote' : '&#9993; Resend'}</button>` : ''}
      </div>

      ${botCard}

      <!-- the paper -->
      <div class="qb-paper">

        <div class="qb-lh">
          <div class="qb-brand">
            <img src="/images/logo.png" alt="SoundzGood" class="qb-logo">
            <div class="qb-seller">
              ABN 49 700 595 348<br>
              Bowen, QLD 4805<br>
              info@soundzgood.com.au<br>
              www.soundzgood.com.au
            </div>
          </div>
          <div class="qb-meta">
            <p class="qb-tagline">Good People<br>Great Events</p>
            <div class="qb-mgrid">
              ${metaRow(docWord + ' number', `<strong>${esc(num)}</strong>`)}
              ${metaRow('Status', doc ? qdocPill(status) : '<span class="ad-pill ad-pill-grey">Draft</span>')}
              ${metaRow('Created', esc(created))}
              ${metaRow('Event / Job', `<input class="qb-min" data-qc="eventName" value="${attr(c.eventName)}" placeholder="Event name">`)}
              ${metaRow('Event date', `<input class="qb-min" data-qc="eventDate" value="${attr(c.eventDate)}" placeholder="e.g. Sat 14 Mar">`)}
              ${metaRow('Hire period', `<span class="qb-hp">${hirePeriod}</span>`)}
              ${metaRow('Days charged', `<input class="qb-min qb-min-num" type="number" min="1" step="1" data-qh="days" value="${attr(h.days)}">`)}
            </div>
          </div>
        </div>

        <div class="qb-parties">
          <div class="qb-to">
            <p class="qb-block-h">${isInvoice ? 'Bill to' : 'Quote to'}</p>
            <input class="qb-cin qb-cin-strong" data-qc="name" value="${attr(c.name)}" placeholder="Customer name">
            <input class="qb-cin" data-qc="business" value="${attr(c.business)}" placeholder="Business (optional)">
            <input class="qb-cin" data-qc="address" value="${attr(c.address)}" placeholder="Address">
            <input class="qb-cin" data-qc="phone" value="${attr(c.phone)}" placeholder="Phone">
            <input class="qb-cin" type="email" data-qc="email" value="${attr(c.email)}" placeholder="Email">
          </div>
          <div class="qb-hire">
            <p class="qb-block-h">Hire period</p>
            <label class="qb-dfield"><span>From</span><input class="qb-date" type="date" data-qh="startDate" value="${attr(h.startDate)}"></label>
            <label class="qb-dfield"><span>To</span><input class="qb-date" type="date" data-qh="endDate" value="${attr(h.endDate)}"></label>

            <p class="qb-block-h" style="margin-top:14px">Delivery</p>
            <label class="qb-dfield"><span>To</span>
              <select class="qb-date qb-delsel" data-qdel-town>
                <option value="__pickup__"${!quoteDraft.deliveryTown ? ' selected' : ''}>Pickup / no delivery</option>
                ${DELIVERY_ZONES.map((z) => `<option value="${z.km}" data-town="${attr(z.town)}"${quoteDraft.deliveryTown === z.town ? ' selected' : ''}>${esc(z.town)}${z.km ? ` — ${z.km}km` : ''}</option>`).join('')}
                <option value="__other__"${quoteDraft.deliveryTown === 'Other' ? ' selected' : ''}>Other (enter km)…</option>
              </select></label>
            ${quoteDraft.deliveryTown === 'Other' ? `<label class="qb-dfield"><span>Km ea way</span><input class="qb-date" type="number" min="0" step="1" data-qdel-km value="${attr(quoteDraft.deliveryKm || '')}"></label>` : ''}
          </div>
        </div>

        <div class="qb-lines-head">
          <span class="qb-block-h">Line items</span>
        </div>

        <div class="qb-table">
          <div class="qb-thead">
            <span class="qb-c-grip"></span>
            <span class="qb-c-desc">Item / Description</span>
            <span class="qb-c-qty">Qty</span>
            <span class="qb-c-rate">Day rate (ex GST)</span>
            <span class="qb-c-days">Days</span>
            <span class="qb-c-total">Total (ex GST)</span>
            <span class="qb-c-x"></span>
          </div>
          <div class="qb-lines" id="q-lines"></div>

          <!--  The adder stays pinned as the bottom row: type to search
                inventory (top 3), or add a custom line / discount. It sits
                outside #q-lines so re-rendering the rows never wipes it.   -->
          <div class="qb-addrow">
            <div class="qb-adder">
              <div class="qb-searchwrap">
                <input type="text" id="q-inv-search" class="qb-searchin" autocomplete="off"
                       placeholder="&#128269;  Search inventory, crew or a vehicle&hellip;">
                <div class="qb-results" id="q-inv-results" hidden></div>
              </div>
              <button type="button" class="ad-btn ad-btn-small" id="q-add-custom">+ Custom item</button>
            </div>
          </div>
        </div>

        <div class="qb-foot">
          <div class="qb-foot-notes">
            <div class="qb-note-box">
              <p class="qb-block-h">Notes to customer</p>
              <textarea class="qb-note" rows="3" data-qmeta="notes" placeholder="Thanks for your enquiry. Looking forward to working with you!">${esc(quoteDraft.notes)}</textarea>
            </div>
            <div class="qb-note-box">
              <p class="qb-block-h">Terms &amp; conditions</p>
              <textarea class="qb-note" rows="3" data-qmeta="terms" placeholder="Quote valid for 30 days.&#10;Payment due on acceptance.&#10;All prices are in AUD and exclude GST.">${esc(quoteDraft.terms)}</textarea>
            </div>
          </div>
          <div class="qb-summary" id="q-totals"></div>
        </div>
      </div>

      <!-- lifecycle strip (not part of the paper) -->
      ${doc ? `
      <section class="qb-lifecycle">
        <div class="qb-life-row">
          ${status !== 'accepted' && status !== 'paid' ? '<button type="button" class="ad-btn" id="q-accept">Mark accepted</button>' : ''}
          ${doc.kind !== 'invoice' ? '<button type="button" class="ad-btn" id="q-invoice">Convert to invoice</button>' : ''}
          ${doc.kind === 'invoice' && status !== 'paid' ? '<button type="button" class="ad-btn" id="q-paid">Mark paid</button>' : ''}
          <button type="button" class="ad-btn inv-del" id="q-cancel">Cancel</button>
          <span class="ad-quote-msg" id="q-msg"></span>
        </div>
        ${link ? `<div class="q-link"><span>Customer link</span>
          <input class="ad-input" id="q-link" readonly value="${attr(link)}">
          <button type="button" class="ad-btn ad-btn-small" id="q-copy">Copy</button></div>` : ''}
      </section>` : '<p class="q-savefirst">Save the quote to send it, get its link, or turn it into an invoice. <span id="q-msg" class="ad-quote-msg"></span></p>'}
    </div>`;
}

function renderQuoteLines() {
  const host = document.getElementById('q-lines');
  if (!host) return;
  const days = Math.max(1, Math.round(quoteDraft.hire.days || 1));

  if (!quoteDraft.lines.length) {
    host.innerHTML = '<p class="q-lines-empty">No items yet &mdash; search inventory above, or add a custom item.</p>';
    renderQuoteTotals();
    return;
  }

  host.innerHTML = quoteDraft.lines.map((l, i) => {
    if (l.type === 'discount') {
      const val = l.amountCents ? l.amountCents / 100 : '';
      return `
        <div class="qb-row qb-row-disc" data-ql="${i}" data-top>
          <div class="qb-cell qb-c-grip"><span class="qb-grip" title="Drag to reorder">&#10303;</span></div>
          <div class="qb-cell qb-c-desc">
            <span class="qb-disc-badge">Discount</span>
            <input class="qb-name" data-lf="name" value="${attr(l.name)}" placeholder="Discount">
          </div>
          <div class="qb-cell qb-c-qty">&mdash;</div>
          <div class="qb-cell qb-c-rate">&mdash;</div>
          <div class="qb-cell qb-c-days">&mdash;</div>
          <div class="qb-cell qb-c-total qb-total">&minus;<span class="qb-inline-dollar">$</span><input class="qb-num qb-num-total" type="number" min="0" step="1" data-lf="amountCents" value="${attr(val)}"></div>
          <div class="qb-cell qb-c-x"><button type="button" class="qb-del" data-ql-del title="Remove">&times;</button></div>
        </div>`;
    }

    // Kit / required lines render as a read-only sub-row grouped under the item above.
    if (l.type === 'kit') {
      const prevWasKit = i > 0 && quoteDraft.lines[i - 1].type === 'kit';
      const header = prevWasKit ? '' : '<div class="qb-subhead">Included / required items</div>';
      const free = l.charge === 'free' || !l.unitCents;
      return `${header}
        <div class="qb-row qb-row-sub" data-ql="${i}" data-sub>
          <div class="qb-cell qb-c-grip"></div>
          <div class="qb-cell qb-c-desc"><span class="qb-arrow">&#8627;</span><span class="qb-subname">${esc(l.name)}</span></div>
          <div class="qb-cell qb-c-qty">${esc(l.qty)}</div>
          <div class="qb-cell qb-c-rate">${free ? '<span class="qb-incl">Included</span>' : money(l.unitCents)}</div>
          <div class="qb-cell qb-c-days">${free ? '&mdash;' : esc(Math.max(1, Math.round(l.days || days)))}</div>
          <div class="qb-cell qb-c-total">${free ? '&mdash;' : money(quoteLineCents(l, days))}</div>
          <div class="qb-cell qb-c-x"><button type="button" class="qb-del" data-ql-del title="Remove">&times;</button></div>
        </div>`;
    }

    // Editable item / custom line.
    const rate = l.unitCents ? l.unitCents / 100 : '';
    return `
      <div class="qb-row" data-ql="${i}" data-top>
        <div class="qb-cell qb-c-grip"><span class="qb-grip" title="Drag to reorder">&#10303;</span></div>
        <div class="qb-cell qb-c-desc">
          <input class="qb-name" data-lf="name" value="${attr(l.name)}" placeholder="Item name">
          ${l.description ? `<span class="qb-sub">${esc(l.description)}</span>` : ''}
        </div>
        <div class="qb-cell qb-c-qty"><input class="qb-num" type="number" min="0" step="1" data-lf="qty" value="${attr(l.qty)}"></div>
        <div class="qb-cell qb-c-rate"><span class="qb-inline-dollar">$</span><input class="qb-num" type="number" min="0" step="1" data-lf="unitCents" value="${attr(rate)}"></div>
        <div class="qb-cell qb-c-days"><input class="qb-num" type="number" min="1" step="1" data-lf="days" value="${attr(Math.max(1, Math.round(l.days || days)))}"></div>
        <div class="qb-cell qb-c-total qb-total"><span class="q-line-total">${esc(money(quoteLineCents(l, days)))}</span></div>
        <div class="qb-cell qb-c-x"><button type="button" class="qb-del" data-ql-del title="Remove">&times;</button></div>
      </div>`;
  }).join('');
  renderQuoteTotals();
}

function renderQuoteTotals() {
  const host = document.getElementById('q-totals');
  if (!host) return;
  const m = quoteDraftMoney(quoteDraft);
  const lab = quoteLabour(quoteDraft);
  const discVal = quoteDraft.discountCents ? quoteDraft.discountCents / 100 : '';
  const labourRow = lab.cents ? `
    <div class="qb-sumrow qb-sumlabour">
      <span><label class="qb-labtoggle"><input type="checkbox" data-qlabour${quoteDraft.labourExcluded ? '' : ' checked'}> Setup &amp; pack-down</label>
        <em class="qb-labnote">${lab.hours} hr${lab.hours === 1 ? '' : 's'} @ $60</em></span>
      <span class="${quoteDraft.labourExcluded ? 'qb-laboff' : ''}">${quoteDraft.labourExcluded ? 'excluded' : esc(money(lab.cents))}</span>
    </div>` : '';
  const delCents = quoteDeliveryCents(quoteDraft);
  const deliveryRow = delCents ? `
    <div class="qb-sumrow">
      <span>Delivery &amp; pickup${quoteDraft.deliveryTown ? ' — ' + esc(quoteDraft.deliveryTown) : ''}
        <em class="qb-labnote" style="margin-left:0">${quoteDraft.deliveryKm}km each way · $0.80/km return</em></span>
      <span>${esc(money(delCents))}</span>
    </div>` : '';
  host.innerHTML = `
    <div class="qb-sumrow"><span>Subtotal (ex GST)</span><span id="qsum-sub">${esc(money(m.subtotalCents))}</span></div>
    ${labourRow}
    ${deliveryRow}
    <div class="qb-sumrow qb-sumdisc"><span>Discount</span>
      <span class="qb-discinput">&minus;<span class="qb-inline-dollar">$</span><input class="qb-num qb-num-total" type="number" min="0" step="1" data-qdisc value="${attr(discVal)}" placeholder="0"></span></div>
    <div class="qb-sumrow"><span>GST (10%)</span><span id="qsum-gst">${esc(money(m.gstCents))}</span></div>
    <div class="qb-sumrow qb-sumgrand"><span>Total (incl GST)</span><span id="qsum-total">${esc(money(m.totalCents))}</span></div>`;
}

/*  Update just the computed figures (used while typing in the discount box,
    so the input keeps focus instead of being rebuilt out from under you).  */
function updateQuoteTotalsValues() {
  const m = quoteDraftMoney(quoteDraft);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('qsum-sub', money(m.subtotalCents));
  set('qsum-gst', money(m.gstCents));
  set('qsum-total', money(m.totalCents));
}

function addInvLineToQuote(itemId) {
  const items = typeof invItems === 'function' ? invItems() : [];
  const byId = {};
  items.forEach((it) => { byId[it.id] = it; });
  const it = byId[itemId];
  if (!it) return;
  const days = Math.max(1, Math.round(quoteDraft.hire.days || 1));

  quoteDraft.lines.push({
    type: 'item', itemId: it.id, name: it.name, description: it.subtitle || '',
    qty: 1, unitCents: it.priceCents || 0, days,
  });

  // Auto-add the required kit for one of these.
  const kit = expandKit({ [it.id]: 1 }, byId);
  kit.required.forEach((r) => {
    const charged = r.charge === 'normal';
    quoteDraft.lines.push({
      type: 'kit', itemId: r.itemId, name: r.name + (r.charge === 'free' ? ' (included)' : ''),
      qty: r.qty, unitCents: charged ? r.unitCents : 0, charge: r.charge,
      days: charged ? days : 1,
    });
  });

  renderQuoteLines();
}

/* -------------------------------------------------------------------------
   Inventory typeahead - the pinned bottom "add" row
   ------------------------------------------------------------------------- */
function invSearchList() {
  return (typeof invItems === 'function' ? invItems() : []).filter((it) => it.id && it.name);
}

let invSearchActive = -1;   // keyboard-highlighted result

/*  Matches for the quote add-search: inventory + active crew/vehicles. */
function quoteSearchMatches(term) {
  const t = String(term || '').trim().toLowerCase();
  if (!t) return [];
  return quoteAddSearchList()
    .filter((it) => it.name.toLowerCase().includes(t))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .slice(0, 3);
}

function renderInvResults(term) {
  const box = document.getElementById('q-inv-results');
  if (!box) return [];
  const t = String(term || '').trim().toLowerCase();
  if (!t) { box.hidden = true; box.innerHTML = ''; invSearchActive = -1; return []; }
  const matches = quoteSearchMatches(term);
  if (!matches.length) {
    box.hidden = false;
    box.innerHTML = '<div class="qb-res-empty">No match in inventory or crew</div>';
    invSearchActive = -1;
    return [];
  }
  box.hidden = false;
  box.innerHTML = matches.map((it, i) => `
    <div class="qb-res${i === invSearchActive ? ' is-active' : ''}" data-add="${attr(it.id)}" data-kind="${attr(it.kind)}">
      <span class="qb-res-name">${esc(it.name)}${it.kind === 'resource' ? ` <span class="qb-res-tag">${esc(it.sub)}</span>` : ''}</span>
      <span class="qb-res-price">${esc(money(it.priceCents))}/day</span>
    </div>`).join('');
  return matches;
}

function wireInvTypeahead() {
  const input = document.getElementById('q-inv-search');
  const box = document.getElementById('q-inv-results');
  if (!input || !box) return;

  const add = (id) => {
    if (!id) return;
    const pick = quoteAddSearchList().find((x) => x.id === id);
    if (pick && pick.kind === 'resource') addResourceLineToQuote(pick);
    else addInvLineToQuote(id);
    input.value = '';
    box.hidden = true; box.innerHTML = '';
    invSearchActive = -1;
    input.focus();
  };

  input.addEventListener('input', () => { invSearchActive = -1; renderInvResults(input.value); });
  input.addEventListener('focus', () => { if (input.value.trim()) renderInvResults(input.value); });
  input.addEventListener('keydown', (e) => {
    const matches = quoteSearchMatches(input.value);
    if (e.key === 'ArrowDown') { e.preventDefault(); invSearchActive = Math.min(matches.length - 1, invSearchActive + 1); renderInvResults(input.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); invSearchActive = Math.max(0, invSearchActive - 1); renderInvResults(input.value); }
    else if (e.key === 'Enter') { e.preventDefault(); const pick = matches[invSearchActive] || matches[0]; if (pick) add(pick.id); }
    else if (e.key === 'Escape') { box.hidden = true; invSearchActive = -1; }
  });
  // mousedown (not click) so it fires before the input's blur hides the list
  box.addEventListener('mousedown', (e) => {
    const r = e.target.closest('[data-add]');
    if (!r) return;
    e.preventDefault();
    add(r.getAttribute('data-add'));
  });
  input.addEventListener('blur', () => { setTimeout(() => { box.hidden = true; }, 150); });
}

/* -------------------------------------------------------------------------
   Reordering - each item plus its included/required rows moves as one group
   ------------------------------------------------------------------------- */
function quoteGroups() {
  const groups = [];
  let cur = null;
  quoteDraft.lines.forEach((l, idx) => {
    if (l.type === 'kit' && cur) { cur.lines.push(l); }
    else { cur = { start: idx, lines: [l] }; groups.push(cur); }
  });
  return groups;
}

function groupIndexOfLine(idx) {
  const g = quoteGroups();
  for (let i = 0; i < g.length; i++) {
    const s = g[i].start;
    if (idx >= s && idx < s + g[i].lines.length) return i;
  }
  return -1;
}

function moveLineGroup(fromLine, overLine, after) {
  const groups = quoteGroups();
  const fromG = groupIndexOfLine(fromLine);
  let toG = groupIndexOfLine(overLine);
  if (fromG < 0 || toG < 0 || fromG === toG) return;
  const moved = groups.splice(fromG, 1)[0];
  if (fromG < toG) toG -= 1;                       // indices shift after removal
  let insert = toG + (after ? 1 : 0);
  insert = Math.max(0, Math.min(groups.length, insert));
  groups.splice(insert, 0, moved);
  quoteDraft.lines = groups.reduce((acc, gr) => acc.concat(gr.lines), []);
  renderQuoteLines();
}

function wireQuoteDrag(lines) {
  if (!lines) return;
  let fromLine = null;
  const clearMarks = () => lines.querySelectorAll('.qb-drop-before, .qb-drop-after')
    .forEach((el) => el.classList.remove('qb-drop-before', 'qb-drop-after'));
  const dropInfo = (e) => {
    const row = e.target.closest('[data-ql]');
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { row, line: Number(row.getAttribute('data-ql')), after: (e.clientY - r.top) > r.height / 2 };
  };

  // arm dragging only when the grab starts on a grip
  lines.addEventListener('mousedown', (e) => {
    const g = e.target.closest('.qb-grip');
    if (!g) return;
    const row = g.closest('[data-ql]');
    if (row && row.hasAttribute('data-top')) row.setAttribute('draggable', 'true');
  });
  lines.addEventListener('mouseup', () => {
    lines.querySelectorAll('[draggable="true"]').forEach((el) => el.removeAttribute('draggable'));
  });

  lines.addEventListener('dragstart', (e) => {
    const row = e.target.closest('[data-ql]');
    if (!row || !row.hasAttribute('data-top') || row.getAttribute('draggable') !== 'true') { e.preventDefault(); return; }
    fromLine = Number(row.getAttribute('data-ql'));
    row.classList.add('qb-dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(fromLine)); } catch (_) {}
  });
  lines.addEventListener('dragover', (e) => {
    if (fromLine == null) return;
    e.preventDefault();
    clearMarks();
    const info = dropInfo(e);
    if (info) info.row.classList.add(info.after ? 'qb-drop-after' : 'qb-drop-before');
  });
  lines.addEventListener('drop', (e) => {
    if (fromLine == null) return;
    e.preventDefault();
    const info = dropInfo(e);
    const from = fromLine;
    fromLine = null;
    clearMarks();
    if (info) moveLineGroup(from, info.line, info.after);
  });
  lines.addEventListener('dragend', () => {
    fromLine = null;
    clearMarks();
    lines.querySelectorAll('[draggable="true"]').forEach((el) => el.removeAttribute('draggable'));
    lines.querySelectorAll('.qb-dragging').forEach((el) => el.classList.remove('qb-dragging'));
  });
}

function wireQuoteBuilder() {
  renderQuoteLines();

  const wrap = document.querySelector('.q-build');
  if (!wrap) return;

  const back = document.getElementById('q-back');
  if (back) back.addEventListener('click', () => { state.openQuoteId = null; render(); });

  // customer / hire / meta fields
  wrap.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.qc) { quoteDraft.customer[t.dataset.qc] = t.value; return; }
    if (t.dataset.qmeta) { quoteDraft[t.dataset.qmeta] = t.value; return; }
    if (t.hasAttribute('data-qdisc')) {
      quoteDraft.discountCents = Math.max(0, Math.round(Number(t.value || 0) * 100));
      updateQuoteTotalsValues();
      return;
    }
    if (t.hasAttribute('data-qlabour')) {
      quoteDraft.labourExcluded = !t.checked;
      renderQuoteTotals();   // rebuild so the labour row & total reflect it
      return;
    }
    if (t.hasAttribute('data-qdel-town')) {
      const v = t.value;
      if (v === '__pickup__') { quoteDraft.deliveryTown = ''; quoteDraft.deliveryKm = 0; }
      else if (v === '__other__') { quoteDraft.deliveryTown = 'Other'; }
      else {
        const opt = t.selectedOptions && t.selectedOptions[0];
        quoteDraft.deliveryTown = opt ? (opt.getAttribute('data-town') || '') : '';
        quoteDraft.deliveryKm = Math.max(0, Math.round(Number(v) || 0));
      }
      render();   // toggles the "Other km" field + updates totals
      return;
    }
    if (t.hasAttribute('data-qdel-km')) {
      quoteDraft.deliveryKm = Math.max(0, Math.round(Number(t.value || 0)));
      renderQuoteTotals();
      return;
    }
    if (t.dataset.qh) {
      if (t.dataset.qh === 'days') quoteDraft.hire.days = Math.max(1, Math.round(Number(t.value) || 1));
      else {
        quoteDraft.hire[t.dataset.qh] = t.value;
        const d = daysBetween(quoteDraft.hire.startDate, quoteDraft.hire.endDate);
        if (d) { quoteDraft.hire.days = d; const di = wrap.querySelector('[data-qh="days"]'); if (di) di.value = d; }
      }
      renderQuoteLines();   // days affect multi-day line totals
      return;
    }
    // line fields
    const line = t.closest('[data-ql]');
    if (line && t.dataset.lf) {
      const i = Number(line.getAttribute('data-ql'));
      const l = quoteDraft.lines[i]; if (!l) return;
      const f = t.dataset.lf;
      if (f === 'amountCents' || f === 'unitCents' || f === 'extraDayCents') l[f] = Math.max(0, Math.round(Number(t.value || 0) * 100));
      else if (f === 'qty') l.qty = Math.max(0, Math.round(Number(t.value || 0)));
      else if (f === 'days') l.days = Math.max(1, Math.round(Number(t.value || 1)));
      else l[f] = t.value;
      // update just this line's total + the grand totals, without a full re-render
      const tot = line.querySelector('.q-line-total');
      if (tot) tot.textContent = money(quoteLineCents(l, Math.max(1, Math.round(quoteDraft.hire.days || 1))));
      renderQuoteTotals();
    }
  });

  // add buttons
  const days0 = () => Math.max(1, Math.round(quoteDraft.hire.days || 1));
  const addCustom = document.getElementById('q-add-custom');
  if (addCustom) addCustom.addEventListener('click', () => { quoteDraft.lines.push({ type: 'custom', name: '', qty: 1, unitCents: 0, days: days0() }); renderQuoteLines(); });

  // inventory typeahead (top 3 as you type)
  wireInvTypeahead();

  // remove line
  const lines = document.getElementById('q-lines');
  if (lines) lines.addEventListener('click', (e) => {
    const del = e.target.closest('[data-ql-del]');
    if (!del) return;
    const i = Number(del.closest('[data-ql]').getAttribute('data-ql'));
    quoteDraft.lines.splice(i, 1);
    renderQuoteLines();
  });

  // drag to reorder (grip handle). An item drags together with its
  // included/required sub-rows as one group.
  wireQuoteDrag(lines);

  const save = document.getElementById('q-save');
  if (save) save.addEventListener('click', () => saveQuoteDoc(save));

  wireQuoteActions();
}

function wireQuoteActions() {
  const msg = () => document.getElementById('q-msg');
  const run = async (name, data, ok) => {
    const m = msg(); if (m) { m.textContent = 'Working…'; m.className = 'ad-quote-msg'; }
    try { const res = await call(name, data); if (m) { m.textContent = ok || 'Done.'; m.className = 'ad-quote-msg is-ok'; } return res; }
    catch (err) { if (m) { m.textContent = err.message || 'Failed.'; m.className = 'ad-quote-msg is-bad'; } throw err; }
  };

  const send = document.getElementById('q-send');
  if (send) send.addEventListener('click', async () => {
    await saveQuoteDoc(send, true);
    if (state.openQuoteId === '__new__') return;
    try {
      const res = await run('adminSendQuote', { id: state.openQuoteId }, 'Sent to the customer.');
      if (res && !res.sent) { const m = msg(); if (m) { m.textContent = 'Not sent: ' + (res.error || res.reason || 'unknown'); m.className = 'ad-quote-msg is-bad'; } }
      render();
    } catch (e) { /* message shown */ }
  });

  const accept = document.getElementById('q-accept');
  if (accept) accept.addEventListener('click', async () => { try { await run('adminSetQuoteStatus', { id: state.openQuoteId, status: 'accepted' }, 'Marked accepted.'); render(); } catch (e) {} });

  const invoice = document.getElementById('q-invoice');
  if (invoice) invoice.addEventListener('click', async () => { try { await run('adminSetQuoteStatus', { id: state.openQuoteId, status: 'invoiced' }, 'Converted to invoice.'); render(); } catch (e) {} });

  const paid = document.getElementById('q-paid');
  if (paid) paid.addEventListener('click', async () => { try { await run('adminSetQuoteStatus', { id: state.openQuoteId, status: 'paid' }, 'Marked paid.'); render(); } catch (e) {} });

  const cancel = document.getElementById('q-cancel');
  if (cancel) cancel.addEventListener('click', async () => {
    if (!window.confirm('Cancel this quote? The customer link will stop working.')) return;
    try { await run('adminSetQuoteStatus', { id: state.openQuoteId, status: 'cancelled' }, 'Cancelled.'); state.openQuoteId = null; render(); } catch (e) {}
  });

  const copy = document.getElementById('q-copy');
  if (copy) copy.addEventListener('click', () => {
    const el = document.getElementById('q-link');
    if (el) { el.select(); try { document.execCommand('copy'); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); } catch (e) {} }
  });
}

/*  Materialise the live labour figure as a real line so the server total and
    the customer's copy include it. Stripped again on load (quoteFromDoc).   */
function quoteDraftForSave() {
  const lab = quoteLabour(quoteDraft);
  const del = quoteDeliveryCents(quoteDraft);
  const km = Math.max(0, Math.round(quoteDraft.deliveryKm || 0));
  const lines = quoteDraft.lines.filter((l) => l.type !== 'labour' && l.type !== 'delivery').map((l) => ({ ...l }));
  if (quoteDraft.labourExcluded !== true && lab.cents > 0) {
    lines.push({
      type: 'labour', name: 'Setup & pack-down',
      description: `${lab.hours} hr${lab.hours === 1 ? '' : 's'} @ $60/hr`,
      qty: 1, unitCents: lab.cents, days: 1, hours: lab.hours,
    });
  }
  if (del > 0) {
    lines.push({
      type: 'delivery',
      name: 'Delivery & pickup' + (quoteDraft.deliveryTown ? ' — ' + quoteDraft.deliveryTown : ''),
      description: `${km}km each way`,
      qty: 1, unitCents: del, days: 1,
    });
  }
  return {
    ...quoteDraft, lines,
    labourExcluded: quoteDraft.labourExcluded === true,
    delivery: { town: quoteDraft.deliveryTown || '', km },
  };
}

async function saveQuoteDoc(btn, quiet) {
  const m = document.getElementById('q-msg');
  if (btn) btn.disabled = true;
  try {
    const id = state.openQuoteId === '__new__' ? null : state.openQuoteId;
    const res = await call('adminSaveQuote', { id, quote: quoteDraftForSave() });
    if (res && res.id) state.openQuoteId = res.id;
    if (res && res.id && state.quoteFromLeadId) {
      linkQuoteToLead(state.quoteFromLeadId, res.id, res.number);
      state.quoteFromLeadId = '';
    }
    if (!quiet) {
      if (m) { m.textContent = 'Saved.'; m.className = 'ad-quote-msg is-ok'; }
      render();   // repaint so the number, link and actions appear
      const m2 = document.getElementById('q-msg'); if (m2) { m2.textContent = 'Saved.'; m2.className = 'ad-quote-msg is-ok'; }
    }
    return res;
  } catch (err) {
    if (m) { m.textContent = err.message || 'Could not save.'; m.className = 'ad-quote-msg is-bad'; }
    throw err;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/*  Whole days between two yyyy-mm-dd dates, inclusive (from a <input type=date>).
    Returns 0 when either is missing or the range is backwards.            */
function daysBetween(a, b) {
  if (!a || !b) return 0;
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  if (isNaN(da) || isNaN(db)) return 0;
  const diff = Math.round((db - da) / 86400000) + 1;
  return diff > 0 ? diff : 0;
}

/* =========================================================================
   PACKAGES  -  reusable, self-serve bundles the quote bot draws on

   A package belongs to an event type (Wedding, Party, ...) and holds one or
   more SIZE TIERS (Up to 50, Up to 150, ...), each a list of inventory items.
   On top sit OPTIONAL EXTRAS the customer can tick on. The price is never
   typed - it is the sum of the items' day rates, run through the kit engine
   so required gear (amps, leads) is included automatically. Change a price
   once in Inventory and every package follows. Built here for staff; the bot
   will pick from these in Phase 2.
   ========================================================================= */

function blankPackage() {
  return {
    name: '', eventType: '', description: '', active: true,
    maxGuests: '',                        // '' = any size; the bot picks the smallest that fits
    items: [], extras: [],
    discountCents: 0, minCents: 0, overrideCents: 0,   // overrideCents > 0 replaces the auto price; minCents = price floor
  };
}

/*  Price helpers. Value = the gear day-rate sum (incl. kit-required gear).
    Customer price = a manual override, else value minus the package discount. */
function pkgValueCents(p, byId) {
  return packageItemsPriceCents((p && p.items) || [], byId).dayCents;
}
function pkgCustomerCents(p, byId) {
  if (p && p.overrideCents > 0) return p.overrideCents;
  const val = pkgValueCents(p, byId);
  const afterDisc = Math.max(0, val - Math.max(0, Math.round((p && p.discountCents) || 0)));
  return Math.max(Math.max(0, Math.round((p && p.minCents) || 0)), afterDisc);   // never below the floor
}

let packageDraft = blankPackage();

function subscribeToPackages() {
  const { collection, onSnapshot } = fb.f;
  unsubscribes.push(onSnapshot(
    collection(fb.db, 'packages'),
    (snap) => {
      const rows = [];
      snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
      rows.sort((a, b) =>
        (a.eventType || '').localeCompare(b.eventType || '')
        || (a.order || 0) - (b.order || 0)
        || (a.name || '').localeCompare(b.name || ''));
      state.packages = rows;
      if (state.view === 'packages') {
        if (state.openPackageId) renderPkgRows();   // panel open: refresh list only
        else render();
      }
    },
    (err) => console.error('packages', err)
  ));
}

/*  Every inventory item keyed by id, for the kit engine and lookups. */
function invByIdMap() {
  const items = typeof invItems === 'function' ? invItems() : [];
  const byId = {};
  items.forEach((it) => { byId[it.id] = it; });
  return byId;
}

/*  Day-rate price of a list of {itemId, qty}, including any required gear the
    kit engine pulls in. Returns cents + any stock shortages at that size.   */
function packageItemsPriceCents(items, byId) {
  const cart = {};
  (items || []).forEach((r) => {
    if (!r || !r.itemId) return;
    cart[r.itemId] = (cart[r.itemId] || 0) + Math.max(0, Math.round(r.qty || 0));
  });
  if (!Object.keys(cart).length) return { dayCents: 0, shortages: [] };
  const kit = expandKit(cart, byId);
  const baseCents = kit.base.reduce((s, b) => s + b.lineCents, 0);
  return { dayCents: baseCents + kit.addCents, shortages: kit.shortages };
}

function pkgEventTypes() {
  const set = new Set();
  (state.packages || []).forEach((p) => { if (p.eventType) set.add(p.eventType); });
  return [...set].sort((a, b) => a.localeCompare(b));
}

VIEWS.packages = {
  html() {
    const open = state.openPackageId != null;
    return `<div class="inv-wrap${open ? ' has-detail' : ''}">
      ${packageMainHtml()}
      ${open ? packageDetailHtml() : ''}
    </div>`;
  },
  wire() { wirePackageList(); if (state.openPackageId != null) wirePackageDetail(); },
};

/* ---- list (built to match the Inventory manager) ---- */
function pkgStats() {
  const rows = state.packages || [];
  return {
    total: rows.length,
    active: rows.filter((p) => p.active !== false).length,
    off: rows.filter((p) => p.active === false).length,
    types: pkgEventTypes().length,
  };
}

function pkgFiltered() {
  const rows = state.packages || [];
  const f = state.pkgFilter || 'all';
  const needle = (state.pkgSearch || '').trim().toLowerCase();
  return rows.filter((p) => {
    if (f !== 'all' && (p.eventType || '') !== f) return false;
    if (!needle) return true;
    return [p.name, p.eventType].filter(Boolean).join(' ').toLowerCase().includes(needle);
  });
}

function pkgThumb(p) {
  const letter = (p.name || p.eventType || '?').trim().charAt(0).toUpperCase();
  return `<span class="inv-thumb ${invCatClass(p.eventType || '')}">${esc(letter)}</span>`;
}

function packageMainHtml() {
  const s = pkgStats();
  const f = state.pkgFilter;
  const types = pkgEventTypes();
  const opt = (v, l) => `<option value="${attr(v)}"${f === v ? ' selected' : ''}>${esc(l)}</option>`;

  return `
      <div class="inv-main">
        <div class="inv-head">
          <div class="inv-head-title">
            <span class="ad-mail-icon" aria-hidden="true">&#128230;</span>
            <div>
              <h1>Packages</h1>
              <p>Reusable bundles the quote bot builds from. The price is live from Inventory.</p>
            </div>
          </div>
          <div class="inv-head-actions">
            <button type="button" class="ad-btn ad-btn-primary" id="pkg-new">+ New package</button>
          </div>
        </div>

        <div class="inv-tiles">
          ${invTile('&#128230;', 'inv-t-slate', s.total, 'Packages', '')}
          ${invTile('&#10003;', 'inv-t-green', s.active, 'Active', '')}
          ${invTile('&#9711;', 'inv-t-amber', s.off, 'Off', '')}
          ${invTile('&#9635;', 'inv-t-blue', s.types, 'Event types', '')}
        </div>

        <div class="inv-toolbar">
          <input type="search" id="pkg-search" class="ad-search" placeholder="Search packages..."
                 value="${attr(state.pkgSearch)}" aria-label="Search packages">
          <select id="pkg-f-type" class="ad-select" aria-label="Filter by event type">
            ${opt('all', 'All event types')}${types.map((t) => opt(t, t)).join('')}
          </select>
        </div>

        <div class="ad-table-wrap inv-table-wrap">
          <table class="ad-table inv-table">
            <thead><tr>
              <th>Package</th><th>Event type</th><th>Gear</th><th>Extras</th>
              <th class="inv-num">Price</th><th>Status</th><th></th>
            </tr></thead>
            <tbody id="pkg-rows"></tbody>
          </table>
        </div>

        <div class="inv-foot" id="pkg-foot"></div>
      </div>`;
}

function renderPkgRows() {
  const host = document.getElementById('pkg-rows');
  const foot = document.getElementById('pkg-foot');
  if (!host) return;
  const byId = invByIdMap();
  const rows = pkgFiltered();
  host.innerHTML = rows.length ? rows.map((p) => {
    const draft = packageFromDoc(p);           // handles legacy tier data too
    const gearN = (draft.items || []).length;
    const xtra = (draft.extras || []).length;
    return `
      <tr class="inv-row${state.openPackageId === p.id ? ' is-open' : ''}" data-open-pkg="${attr(p.id)}">
        <td class="inv-item-cell">${pkgThumb(p)}
          <span class="inv-item-text"><span class="inv-item-name">${esc(p.name || 'Untitled')}</span>${p.description ? `<span class="inv-item-sub">${esc(p.description)}</span>` : ''}</span></td>
        <td>${p.eventType ? `<span class="inv-pill ${invCatClass(p.eventType)}">${esc(p.eventType)}</span>` : '<span class="ad-cell-muted">—</span>'}</td>
        <td>${gearN} item${gearN === 1 ? '' : 's'}</td>
        <td>${xtra} extra${xtra === 1 ? '' : 's'}</td>
        <td class="inv-num">${esc(money(pkgCustomerCents(draft, byId)))}<span class="inv-perday">/day</span></td>
        <td>${p.active === false ? '<span class="inv-pill inv-st-slate">Off</span>' : '<span class="inv-pill inv-st-green">Active</span>'}</td>
        <td class="ad-cell-right"><button type="button" class="inv-open-btn" data-open-pkg="${attr(p.id)}" aria-label="Edit">&#8250;</button></td>
      </tr>`;
  }).join('')
    : `<tr><td colspan="7" class="ad-cell-muted">No packages match. Try clearing the search, or hit &ldquo;New package&rdquo;.</td></tr>`;
  if (foot) foot.innerHTML = `<p class="inv-foot-count">${rows.length} package${rows.length === 1 ? '' : 's'}</p>`;
}

function wirePackageList() {
  renderPkgRows();
  const nw = document.getElementById('pkg-new');
  if (nw) nw.addEventListener('click', () => { packageDraft = blankPackage(); state.pkgTab = 'details'; state.openPackageId = '__new__'; render(); });
  const search = document.getElementById('pkg-search');
  if (search) search.addEventListener('input', () => { state.pkgSearch = search.value; renderPkgRows(); });
  const typeSel = document.getElementById('pkg-f-type');
  if (typeSel) typeSel.addEventListener('change', () => { state.pkgFilter = typeSel.value; renderPkgRows(); });
  const host = document.getElementById('pkg-rows');
  if (host) host.addEventListener('click', (e) => {
    const r = e.target.closest('[data-open-pkg]');
    if (!r) return;
    const id = r.getAttribute('data-open-pkg');
    const doc = (state.packages || []).find((x) => x.id === id);
    packageDraft = doc ? packageFromDoc(doc) : blankPackage();
    state.pkgTab = 'details';
    state.openPackageId = id;
    render();
  });
}

function packageFromDoc(doc) {
  // Migrate old tier-based packages: fold the first tier's gear into the flat list.
  let items = Array.isArray(doc.items) ? doc.items : null;
  let discountCents = Math.max(0, Math.round(doc.discountCents || 0));
  if (!items && Array.isArray(doc.tiers) && doc.tiers.length) {
    items = doc.tiers[0].items || [];
    if (!discountCents) discountCents = Math.max(0, Math.round(doc.tiers[0].discountCents || 0));
  }
  let maxGuests = doc.maxGuests;
  if (maxGuests == null && Array.isArray(doc.tiers) && doc.tiers.length) maxGuests = doc.tiers[0].maxGuests;
  return {
    name: doc.name || '',
    eventType: doc.eventType || '',
    description: doc.description || '',
    active: doc.active !== false,
    maxGuests: maxGuests == null || maxGuests === '' ? '' : Math.max(0, Math.round(maxGuests)),
    items: (items || []).map((i) => ({ itemId: i.itemId, qty: Math.max(1, Math.round(i.qty || 1)) })),
    extras: (doc.extras || []).map((i) => ({ itemId: i.itemId, qty: Math.max(1, Math.round(i.qty || 1)) })),
    discountCents,
    minCents: Math.max(0, Math.round(doc.minCents || 0)),
    overrideCents: Math.max(0, Math.round(doc.overrideCents || 0)),
  };
}

/* ---- detail panel (slides in from the right, like Inventory) ---- */
const PKG_TABS = [['details', 'Details'], ['equipment', 'Equipment'], ['extras', 'Extras'], ['pricing', 'Pricing'], ['preview', 'Preview']];

function packageDetailHtml() {
  const isNew = state.openPackageId === '__new__';
  const p = packageDraft;
  const pill = p.active !== false
    ? '<span class="inv-pill inv-st-green pkg-head-pill">Active</span>'
    : '<span class="inv-pill inv-st-slate pkg-head-pill">Off</span>';
  const tabs = PKG_TABS.map(([k, l]) => `<button type="button" class="pkg-tab${state.pkgTab === k ? ' is-on' : ''}" data-pkg-tab="${k}">${l}</button>`).join('');

  return `
    <aside class="inv-detail pkg-detail" aria-label="Package details">
      <header class="inv-detail-head">
        <div>
          <h2>${isNew ? 'New package' : esc(p.name || 'Package')} ${pill}</h2>
          ${p.description ? `<p class="inv-detail-sub">${esc(p.description)}</p>` : ''}
        </div>
        <button type="button" class="inv-detail-close" id="pkg-close" aria-label="Close">&times;</button>
      </header>

      <nav class="pkg-tabs">${tabs}</nav>

      <div class="inv-detail-body" id="pkg-tabbody"></div>

      <footer class="inv-detail-foot">
        ${isNew ? '' : '<button type="button" class="ad-btn inv-del" id="pkg-del">Delete package</button>'}
        <button type="button" class="ad-btn ad-btn-primary" id="pkg-save">${isNew ? 'Add package' : 'Save package'}</button>
        <span class="ad-quote-msg" id="pkg-msg"></span>
      </footer>
    </aside>`;
}

/*  A generic inventory typeahead: wires an input + results box so typing shows
    the top 3 matches; onPick(id) is called when one is chosen.              */
function pkgRenderResults(box, term, activeIdx) {
  const t = String(term || '').trim().toLowerCase();
  if (!t) { box.hidden = true; box.innerHTML = ''; return []; }
  const matches = invSearchList()
    .filter((it) => it.name.toLowerCase().includes(t))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .slice(0, 3);
  if (!matches.length) { box.hidden = false; box.innerHTML = '<div class="qb-res-empty">No matching inventory</div>'; return []; }
  box.hidden = false;
  box.innerHTML = matches.map((it, i) => `
    <div class="qb-res${i === activeIdx ? ' is-active' : ''}" data-add="${attr(it.id)}">
      <span class="qb-res-name">${esc(it.name)}</span>
      <span class="qb-res-price">${esc(money(it.priceCents))}/day</span>
    </div>`).join('');
  return matches;
}

function attachTypeahead(input, box, onPick) {
  if (!input || !box) return;
  let active = -1;
  const matchNow = () => invSearchList().filter((it) => it.name.toLowerCase().includes(input.value.trim().toLowerCase())).slice(0, 3);
  input.addEventListener('input', () => { active = -1; pkgRenderResults(box, input.value, active); });
  input.addEventListener('focus', () => { if (input.value.trim()) pkgRenderResults(box, input.value, active); });
  input.addEventListener('keydown', (e) => {
    const m = matchNow();
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(m.length - 1, active + 1); pkgRenderResults(box, input.value, active); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); pkgRenderResults(box, input.value, active); }
    else if (e.key === 'Enter') { e.preventDefault(); const pick = m[active] || m[0]; if (pick) { onPick(pick.id); input.value = ''; box.hidden = true; active = -1; } }
    else if (e.key === 'Escape') { box.hidden = true; active = -1; }
  });
  box.addEventListener('mousedown', (e) => {
    const r = e.target.closest('[data-add]');
    if (!r) return;
    e.preventDefault();
    onPick(r.getAttribute('data-add'));
    input.value = ''; box.hidden = true; active = -1;
  });
  input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 150));
}

function addPkgItem(list, itemId) {
  const existing = list.find((x) => x.itemId === itemId);
  if (existing) existing.qty = Math.max(1, Math.round(existing.qty || 1) + 1);
  else list.push({ itemId, qty: 1 });
}

/*  A gear thumbnail: the inventory item's photo, or a tinted initial - same
    look as the Inventory list. */
function pkgThumbItem(inv) {
  if (inv && inv.photoUrl) return `<span class="pkg-gthumb inv-thumb-img"><img src="${attr(inv.photoUrl)}" alt="" loading="lazy"></span>`;
  const l = (((inv && (inv.category || inv.name)) || '?')).trim().charAt(0).toUpperCase();
  return `<span class="pkg-gthumb ${invCatClass((inv && inv.category) || '')}">${esc(l)}</span>`;
}

/*  A row of gear (included or extra) with an image, +/- qty stepper, rate and
    total. attrName is 'pi' (included) or 'xi' (extra). */
function pkgGearRow(it, byId, attrName, idx) {
  const inv = byId[it.itemId] || {};
  const qty = Math.max(1, Math.round(it.qty || 1));
  const line = (inv.priceCents || 0) * qty;
  return `
    <div class="pkg-gearrow" data-${attrName}="${idx}">
      <div class="pkg-gear-name">${pkgThumbItem(inv)}<span>${esc(inv.name || it.itemId)}</span></div>
      <div class="pkg-gear-qty">
        <button type="button" class="pkg-step" data-${attrName}-dec title="Less">&minus;</button>
        <span class="pkg-qtyval">${qty}</span>
        <button type="button" class="pkg-step" data-${attrName}-inc title="More">+</button>
      </div>
      <div class="pkg-gear-rate">${esc(money(inv.priceCents || 0))}</div>
      <div class="pkg-gear-total">${esc(money(line))}</div>
      <button type="button" class="qb-del" data-${attrName}-del title="Remove">&times;</button>
    </div>`;
}

function pkgSearchAdder(target) {
  return `
    <div class="qb-searchwrap pkg-searchwrap">
      <input type="text" class="qb-searchin" data-pkg-search="${target}" autocomplete="off" placeholder="&#128269;  Add inventory item&hellip;">
      <div class="qb-results pkg-results" data-pkg-results hidden></div>
    </div>`;
}

/*  Render the active tab into the panel body, and wire its search box(es). */
function renderPkgTab() {
  const host = document.getElementById('pkg-tabbody');
  if (!host) return;
  const tab = state.pkgTab || 'details';
  host.innerHTML = tab === 'details' ? pkgDetailsTab()
    : tab === 'equipment' ? pkgEquipmentTab()
    : tab === 'extras' ? pkgExtrasTab()
    : tab === 'pricing' ? pkgPricingTab()
    : pkgPreviewTab();

  host.querySelectorAll('[data-pkg-search]').forEach((input) => {
    const box = input.parentElement.querySelector('[data-pkg-results]');
    const target = input.getAttribute('data-pkg-search');
    attachTypeahead(input, box, (id) => {
      addPkgItem(target === 'extras' ? packageDraft.extras : packageDraft.items, id);
      renderPkgTab();
    });
  });
}

function pkgDetailsTab() {
  const p = packageDraft;
  const datalist = pkgEventTypes().map((t) => `<option value="${attr(t)}">`).join('');
  return `
    <div class="pkg-sec-h">Package details</div>
    <div class="inv-fgrid">
      <label class="ad-field inv-span2"><span>Package name *</span>
        <input class="ad-input" data-pf="name" value="${attr(p.name)}" placeholder="e.g. DJ Package – Small"></label>
      <label class="ad-field"><span>Event type</span>
        <input class="ad-input" list="pkg-types" data-pf="eventType" value="${attr(p.eventType)}" placeholder="e.g. DJ / Party">
        <datalist id="pkg-types">${datalist}</datalist></label>
      <label class="ad-field"><span>Suits up to N guests</span>
        <input class="ad-input" type="number" min="0" step="1" data-pf="maxGuests" value="${attr(p.maxGuests)}" placeholder="blank = any size"></label>
      <label class="ad-field inv-span2"><span>Short description</span>
        <textarea class="ad-input" rows="2" data-pf="description" placeholder="Shown to the customer, e.g. Perfect for small parties &amp; functions.">${esc(p.description || '')}</textarea></label>
    </div>
    <label class="inv-toggle">
      <span><strong>Active</strong><em>Offered by the quote bot.</em></span>
      <input type="checkbox" data-pf="active"${p.active !== false ? ' checked' : ''}>
      <span class="inv-switch" aria-hidden="true"></span>
    </label>`;
}

function pkgEquipmentTab() {
  const byId = invByIdMap();
  const p = packageDraft;
  const gear = (p.items || []).length
    ? p.items.map((it, i) => pkgGearRow(it, byId, 'pi', i)).join('')
    : '<p class="pkg-empty">No gear yet — search above to add.</p>';

  const cart = {};
  (p.items || []).forEach((it) => { if (it.itemId) cart[it.itemId] = (cart[it.itemId] || 0) + Math.max(0, Math.round(it.qty || 0)); });
  const kit = Object.keys(cart).length ? expandKit(cart, byId) : { required: [] };
  const reqRows = (kit.required || []).map((r) => `
    <div class="pkg-reqrow">
      <div class="pkg-gear-name">${pkgThumbItem(byId[r.itemId] || {})}<span>${esc(r.name)}</span></div>
      <div class="pkg-req-qty">&times;${esc(r.qty)}</div>
      <div class="pkg-req-tag">${r.charge === 'free' || !r.unitCents ? 'Included' : esc(money(r.lineCents))}</div>
    </div>`).join('');

  return `
    <div class="pkg-sec-h">Included gear
      <button type="button" class="ad-btn ad-btn-small pkg-addbtn" data-pkg-focus>+ Add inventory item</button></div>
    ${pkgSearchAdder('items')}
    ${(p.items || []).length ? '<div class="pkg-gearhead"><span>Item</span><span>Qty</span><span>Rate</span><span>Total</span><span></span></div>' : ''}
    <div class="pkg-gearlist">${gear}</div>
    ${reqRows ? `
      <div class="pkg-sec-h pkg-sec-req">Required gear <span class="pkg-auto">AUTO</span></div>
      <p class="inv-reqs-intro">Automatically included from inventory requirements. Duplicates are consolidated.</p>
      <div class="pkg-gearlist">${reqRows}</div>` : ''}`;
}

function pkgExtrasTab() {
  const byId = invByIdMap();
  const rows = (packageDraft.extras || []).length
    ? packageDraft.extras.map((it, i) => pkgGearRow(it, byId, 'xi', i)).join('')
    : '<p class="pkg-empty">No extras yet — search above to offer add-ons.</p>';
  return `
    <div class="pkg-sec-h">Optional extras</div>
    <p class="inv-reqs-intro">Add-ons the customer can tick on top of the package.</p>
    ${pkgSearchAdder('extras')}
    ${(packageDraft.extras || []).length ? '<div class="pkg-gearhead"><span>Item</span><span>Qty</span><span>Rate</span><span>Total</span><span></span></div>' : ''}
    <div class="pkg-gearlist">${rows}</div>`;
}

function pkgPricingTab() {
  const byId = invByIdMap();
  const p = packageDraft;
  const val = pkgValueCents(p, byId);
  const useOverride = p.overrideCents > 0;
  const cust = pkgCustomerCents(p, byId);
  const disc = Math.max(0, Math.round(p.discountCents || 0));
  const pct = val ? Math.round((disc / val) * 100) : 0;
  return `
    <div class="pkg-sec-h">Pricing</div>
    <label class="inv-toggle">
      <span><strong>Use inventory pricing</strong><em>Customer price = gear value minus discount.</em></span>
      <input type="checkbox" data-pf-useinv${useOverride ? '' : ' checked'}>
      <span class="inv-switch" aria-hidden="true"></span>
    </label>
    ${useOverride ? `
      <div class="inv-fgrid"><label class="ad-field inv-span2"><span>Override price $ / day</span>
        <input class="ad-input" type="number" min="0" step="1" data-poverride value="${attr(p.overrideCents ? p.overrideCents / 100 : '')}"></label></div>
      <div class="pkg-pricebox"><div class="pkg-priceline pkg-pricecust"><span>Customer price</span><span>${esc(money(cust))}/day</span></div></div>`
    : `
      <div class="pkg-pricebox">
        <div class="pkg-priceline"><span>Total inventory value</span><span>${esc(money(val))}</span></div>
        <div class="pkg-priceline"><span>Package discount</span>
          <span class="pkg-discinput">&minus;<span class="qb-inline-dollar">$</span><input class="qb-num qb-num-total" type="number" min="0" step="1" data-pdisc value="${attr(disc ? disc / 100 : '')}"></span></div>
        <div class="pkg-priceline"><span>Minimum price <em class="pkg-minhint">(floor)</em></span>
          <span class="pkg-discinput"><span class="qb-inline-dollar">$</span><input class="qb-num qb-num-total" type="number" min="0" step="1" data-pmin value="${attr(p.minCents ? p.minCents / 100 : '')}"></span></div>
        <div class="pkg-priceline pkg-pricecust"><span>Customer price</span><span>${esc(money(cust))}/day</span></div>
      </div>
      ${disc ? `<p class="pkg-savechip">${pct}% off inventory value</p>` : ''}`}`;
}

function pkgPreviewTab() {
  const byId = invByIdMap();
  const p = packageDraft;
  const cust = pkgCustomerCents(p, byId);
  const gear = (p.items || []).map((it) => { const inv = byId[it.itemId] || {}; return `<li>${Math.max(1, Math.round(it.qty || 1))}&times; ${esc(inv.name || it.itemId)}</li>`; }).join('');
  const extras = (p.extras || []).map((it) => { const inv = byId[it.itemId] || {}; return `<li>${esc(inv.name || it.itemId)}${it.qty > 1 ? ' &times;' + it.qty : ''}</li>`; }).join('');
  return `
    <div class="pkg-preview">
      <h3>${esc(p.name || 'Package')}</h3>
      ${p.eventType ? `<p class="pkg-prev-type">${esc(p.eventType)}</p>` : ''}
      ${p.description ? `<p>${esc(p.description)}</p>` : ''}
      <p class="pkg-prev-price">${esc(money(cust))}<span>/day</span></p>
      ${gear ? `<h4>Included</h4><ul>${gear}</ul>` : ''}
      ${extras ? `<h4>Optional extras</h4><ul>${extras}</ul>` : ''}
    </div>`;
}

/*  Live-update the customer price figure while typing in discount/override,
    without rebuilding the input. */
function updatePkgPriceView() {
  const el = document.querySelector('.pkg-pricecust span:last-child');
  if (el) el.textContent = money(pkgCustomerCents(packageDraft, invByIdMap())) + '/day';
}

function wirePackageDetail() {
  renderPkgTab();

  const wrap = document.querySelector('.inv-detail');
  if (!wrap) return;

  const close = document.getElementById('pkg-close');
  if (close) close.addEventListener('click', () => { state.openPackageId = null; render(); });

  // tab switching
  wrap.querySelectorAll('[data-pkg-tab]').forEach((b) => b.addEventListener('click', () => {
    state.pkgTab = b.getAttribute('data-pkg-tab');
    wrap.querySelectorAll('[data-pkg-tab]').forEach((x) => x.classList.toggle('is-on', x === b));
    renderPkgTab();
  }));

  // field edits (delegated, survives tab re-renders)
  wrap.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.pf) {
      const f = t.dataset.pf;
      if (f === 'active') packageDraft.active = t.checked;
      else packageDraft[f] = t.value;
      return;
    }
    if (t.hasAttribute('data-pf-useinv')) {
      if (t.checked) packageDraft.overrideCents = 0;
      else packageDraft.overrideCents = Math.max(1, packageDraft.overrideCents || pkgCustomerCents(packageDraft, invByIdMap()));
      renderPkgTab();
      return;
    }
    if (t.hasAttribute('data-poverride')) { packageDraft.overrideCents = Math.max(0, Math.round(Number(t.value || 0) * 100)); updatePkgPriceView(); return; }
    if (t.hasAttribute('data-pdisc')) { packageDraft.discountCents = Math.max(0, Math.round(Number(t.value || 0) * 100)); updatePkgPriceView(); return; }
    if (t.hasAttribute('data-pmin')) { packageDraft.minCents = Math.max(0, Math.round(Number(t.value || 0) * 100)); updatePkgPriceView(); return; }
  });

  // steppers, deletes, add-item focus (delegated)
  wrap.addEventListener('click', (e) => {
    const focusAdd = e.target.closest('[data-pkg-focus]');
    if (focusAdd) { const s = wrap.querySelector('[data-pkg-search]'); if (s) s.focus(); return; }

    const inc = e.target.closest('[data-pi-inc]'); const dec = e.target.closest('[data-pi-dec]'); const pdel = e.target.closest('[data-pi-del]');
    if (inc || dec || pdel) {
      const row = e.target.closest('[data-pi]'); if (!row) return;
      const i = Number(row.getAttribute('data-pi')); const it = packageDraft.items[i]; if (!it) return;
      if (pdel) packageDraft.items.splice(i, 1);
      else it.qty = Math.max(1, Math.round((it.qty || 1) + (inc ? 1 : -1)));
      renderPkgTab(); return;
    }
    const xinc = e.target.closest('[data-xi-inc]'); const xdec = e.target.closest('[data-xi-dec]'); const xdel = e.target.closest('[data-xi-del]');
    if (xinc || xdec || xdel) {
      const row = e.target.closest('[data-xi]'); if (!row) return;
      const i = Number(row.getAttribute('data-xi')); const it = packageDraft.extras[i]; if (!it) return;
      if (xdel) packageDraft.extras.splice(i, 1);
      else it.qty = Math.max(1, Math.round((it.qty || 1) + (xinc ? 1 : -1)));
      renderPkgTab(); return;
    }
  });

  const save = document.getElementById('pkg-save');
  if (save) save.addEventListener('click', () => savePackage(save));
  const del = document.getElementById('pkg-del');
  if (del) del.addEventListener('click', () => deletePackage(del));
}

async function savePackage(btn) {
  const msg = document.getElementById('pkg-msg');
  const p = packageDraft;
  if (!String(p.name || '').trim()) {
    if (msg) { msg.textContent = 'Give the package a name first.'; msg.className = 'ad-quote-msg is-bad'; }
    return;
  }
  const clean = {
    name: String(p.name).trim().slice(0, 160),
    eventType: String(p.eventType || '').trim().slice(0, 80),
    description: String(p.description || '').trim().slice(0, 600),
    active: p.active !== false,
    maxGuests: p.maxGuests === '' || p.maxGuests == null ? null : Math.max(0, Math.round(Number(p.maxGuests) || 0)),
    items: (p.items || []).filter((i) => i.itemId).map((i) => ({ itemId: i.itemId, qty: Math.max(1, Math.round(i.qty || 1)) })),
    extras: (p.extras || []).filter((i) => i.itemId).map((i) => ({ itemId: i.itemId, qty: Math.max(1, Math.round(i.qty || 1)) })),
    discountCents: Math.max(0, Math.round(p.discountCents || 0)),
    minCents: Math.max(0, Math.round(p.minCents || 0)),
    overrideCents: Math.max(0, Math.round(p.overrideCents || 0)),
    tiers: null,   // clear any legacy tier data now the model is flat
    updatedAt: Date.now(),
  };

  if (msg) { msg.textContent = 'Saving…'; msg.className = 'ad-quote-msg'; }
  if (btn) btn.disabled = true;
  try {
    const { collection, doc, setDoc, addDoc } = fb.f;
    state.packages = state.packages || [];
    if (state.openPackageId === '__new__') {
      clean.order = state.packages.length;
      clean.createdAt = Date.now();
      const ref = await addDoc(collection(fb.db, 'packages'), clean);
      state.openPackageId = ref.id;
      state.packages.push({ id: ref.id, ...clean });
    } else {
      const id = state.openPackageId;
      await setDoc(doc(fb.db, 'packages', id), clean, { merge: true });
      const cur = state.packages.find((x) => x.id === id);
      if (cur) Object.assign(cur, clean); else state.packages.push({ id, ...clean });
    }
    if (msg) { msg.textContent = 'Saved.'; msg.className = 'ad-quote-msg is-ok'; }
    render();
  } catch (err) {
    if (msg) { msg.textContent = err.message || 'Could not save.'; msg.className = 'ad-quote-msg is-bad'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deletePackage(btn) {
  if (!window.confirm('Delete this package? This cannot be undone.')) return;
  const id = state.openPackageId;
  if (id === '__new__') { state.openPackageId = null; render(); return; }
  if (btn) btn.disabled = true;
  try {
    const { doc, deleteDoc } = fb.f;
    await deleteDoc(doc(fb.db, 'packages', id));
    state.packages = (state.packages || []).filter((x) => x.id !== id);
    state.openPackageId = null;
    render();
  } catch (err) {
    const msg = document.getElementById('pkg-msg');
    if (msg) { msg.textContent = err.message || 'Could not delete.'; msg.className = 'ad-quote-msg is-bad'; }
    if (btn) btn.disabled = false;
  }
}

/* =========================================================================
   CREW & VEHICLES  -  staff / vehicle / trailer records, billable to a quote

   Not gear (that's Inventory) and not a roster - just the people and vehicles
   you own, each with a day rate so it can be dropped onto a quote as a line.
   Kept private (admin-only) since they carry phone numbers and pay rates.
   ========================================================================= */

const RES_TYPES = { staff: 'Staff', vehicle: 'Vehicle', trailer: 'Trailer' };
const RES_GROUP = { staff: 'Staff', vehicle: 'Vehicles', trailer: 'Trailers' };

function blankResource(type) {
  return { type: type || 'staff', name: '', role: '', phone: '', rego: '', capacity: '', dayRateCents: 0, active: true, notes: '' };
}

let resourceDraft = blankResource();

function subscribeToResources() {
  const { collection, onSnapshot } = fb.f;
  const rank = { staff: 0, vehicle: 1, trailer: 2 };
  unsubscribes.push(onSnapshot(
    collection(fb.db, 'resources'),
    (snap) => {
      const rows = [];
      snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
      rows.sort((a, b) =>
        (rank[a.type] ?? 9) - (rank[b.type] ?? 9)
        || (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' }));
      state.resources = rows;
      if (state.view === 'resources') {
        if (state.openResourceId) renderResRows();   // panel open: refresh list only
        else render();
      }
    },
    (err) => console.error('resources', err)
  ));
}

VIEWS.resources = {
  html() {
    const open = state.openResourceId != null;
    return `<div class="inv-wrap${open ? ' has-detail' : ''}">
      ${resourceMainHtml()}
      ${open ? resourceDetailHtml() : ''}
    </div>`;
  },
  wire() { wireResourceList(); if (state.openResourceId != null) wireResourceDetail(); },
};

/* ---- list (built to match the Inventory manager) ---- */
function resStats() {
  const rows = state.resources || [];
  const byType = (t) => rows.filter((r) => (r.type || 'staff') === t).length;
  return { total: rows.length, staff: byType('staff'), vehicle: byType('vehicle'), trailer: byType('trailer') };
}

function resFiltered() {
  const rows = state.resources || [];
  const f = state.resFilter || 'all';
  const needle = (state.resSearch || '').trim().toLowerCase();
  return rows.filter((r) => {
    if (f !== 'all' && (r.type || 'staff') !== f) return false;
    if (!needle) return true;
    return [r.name, r.role, r.rego, r.capacity, RES_TYPES[r.type]]
      .filter(Boolean).join(' ').toLowerCase().includes(needle);
  });
}

function resSub(r) {
  if ((r.type || 'staff') === 'staff') return [r.role, r.phone].filter(Boolean).join(' · ');
  return [r.rego, r.capacity].filter(Boolean).join(' · ');
}

function resThumb(r) {
  const letter = (r.name || RES_TYPES[r.type] || '?').trim().charAt(0).toUpperCase();
  return `<span class="inv-thumb ${invCatClass(RES_TYPES[r.type] || '')}">${esc(letter)}</span>`;
}

const RES_TYPE_PILL = { staff: 'inv-st-green', vehicle: 'inv-st-blue', trailer: 'inv-st-amber' };
function resTypePill(type) {
  const t = RES_TYPES[type] ? type : 'staff';
  return `<span class="inv-pill ${RES_TYPE_PILL[t]}">${esc(RES_TYPES[t])}</span>`;
}
function resActivePill(r) {
  return r.active === false
    ? '<span class="inv-pill inv-st-slate">Off</span>'
    : '<span class="inv-pill inv-st-green">Active</span>';
}

function resourceMainHtml() {
  const s = resStats();
  const f = state.resFilter;
  const opt = (v, l) => `<option value="${v}"${f === v ? ' selected' : ''}>${l}</option>`;

  return `
      <div class="inv-main">
        <div class="inv-head">
          <div class="inv-head-title">
            <span class="ad-mail-icon" aria-hidden="true">&#128666;</span>
            <div>
              <h1>Crew &amp; Vehicles</h1>
              <p>Your staff, vehicles and trailers. Each has a day rate, so it can be added to a quote as a billable line.</p>
            </div>
          </div>
          <div class="inv-head-actions res-addbtns">
            <button type="button" class="ad-btn ad-btn-small" data-res-new="staff">+ Staff</button>
            <button type="button" class="ad-btn ad-btn-small" data-res-new="vehicle">+ Vehicle</button>
            <button type="button" class="ad-btn ad-btn-primary" data-res-new="trailer">+ Trailer</button>
          </div>
        </div>

        <div class="inv-tiles">
          ${invTile('&#128100;', 'inv-t-green', s.staff, 'Staff', '')}
          ${invTile('&#128666;', 'inv-t-blue', s.vehicle, 'Vehicles', '')}
          ${invTile('&#128230;', 'inv-t-amber', s.trailer, 'Trailers', '')}
          ${invTile('&#9776;', 'inv-t-slate', s.total, 'Total', '')}
        </div>

        <div class="inv-toolbar">
          <input type="search" id="res-search" class="ad-search" placeholder="Search crew &amp; vehicles..."
                 value="${attr(state.resSearch)}" aria-label="Search crew and vehicles">
          <select id="res-f-type" class="ad-select" aria-label="Filter by type">
            ${opt('all', 'All types')}${opt('staff', 'Staff')}${opt('vehicle', 'Vehicles')}${opt('trailer', 'Trailers')}
          </select>
        </div>

        <div class="ad-table-wrap inv-table-wrap">
          <table class="ad-table inv-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Details</th>
                <th class="inv-num">Day rate</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="res-rows"></tbody>
          </table>
        </div>

        <div class="inv-foot" id="res-foot"></div>
      </div>`;
}

function renderResRows() {
  const host = document.getElementById('res-rows');
  const foot = document.getElementById('res-foot');
  if (!host) return;
  const rows = resFiltered();
  host.innerHTML = rows.length ? rows.map((r) => `
    <tr class="inv-row${state.openResourceId === r.id ? ' is-open' : ''}" data-open-res="${attr(r.id)}">
      <td class="inv-item-cell">
        ${resThumb(r)}
        <span class="inv-item-text"><span class="inv-item-name">${esc(r.name || 'Untitled')}</span></span>
      </td>
      <td>${resTypePill(r.type)}</td>
      <td>${resSub(r) ? esc(resSub(r)) : '<span class="ad-cell-muted">—</span>'}</td>
      <td class="inv-num">${esc(money(r.dayRateCents))}<span class="inv-perday">/day</span></td>
      <td>${resActivePill(r)}</td>
      <td class="ad-cell-right"><button type="button" class="inv-open-btn" data-open-res="${attr(r.id)}" aria-label="Edit">&#8250;</button></td>
    </tr>`).join('')
    : `<tr><td colspan="6" class="ad-cell-muted">No records match. Try clearing the search, or add one above.</td></tr>`;
  if (foot) foot.innerHTML = `<p class="inv-foot-count">${rows.length} record${rows.length === 1 ? '' : 's'}</p>`;
}

function wireResourceList() {
  renderResRows();

  document.querySelectorAll('[data-res-new]').forEach((b) => b.addEventListener('click', () => {
    resourceDraft = blankResource(b.getAttribute('data-res-new'));
    state.openResourceId = '__new__';
    render();
  }));

  const search = document.getElementById('res-search');
  if (search) search.addEventListener('input', () => { state.resSearch = search.value; renderResRows(); });
  const typeSel = document.getElementById('res-f-type');
  if (typeSel) typeSel.addEventListener('change', () => { state.resFilter = typeSel.value; renderResRows(); });

  const host = document.getElementById('res-rows');
  if (host) host.addEventListener('click', (e) => {
    const r = e.target.closest('[data-open-res]');
    if (!r) return;
    const id = r.getAttribute('data-open-res');
    const doc = (state.resources || []).find((x) => x.id === id);
    resourceDraft = doc ? resourceFromDoc(doc) : blankResource();
    state.openResourceId = id;
    render();
  });
}

function resourceFromDoc(doc) {
  const b = blankResource(doc.type);
  return {
    type: RES_TYPES[doc.type] ? doc.type : 'staff',
    name: doc.name || '', role: doc.role || '', phone: doc.phone || '',
    rego: doc.rego || '', capacity: doc.capacity || '',
    dayRateCents: Math.max(0, Math.round(doc.dayRateCents || 0)),
    active: doc.active !== false,
    notes: doc.notes || '',
  };
}

/* ---- detail panel (slides in from the right, like Inventory) ---- */
function resourceDetailHtml() {
  const isNew = state.openResourceId === '__new__';
  const r = resourceDraft;
  const type = RES_TYPES[r.type] ? r.type : 'staff';
  const isStaff = type === 'staff';
  const rate = r.dayRateCents ? r.dayRateCents / 100 : '';
  const typeOpt = (v) => `<option value="${v}"${type === v ? ' selected' : ''}>${RES_TYPES[v]}</option>`;

  return `
    <aside class="inv-detail" aria-label="Record details">
      <header class="inv-detail-head">
        <div>
          <h2>${isNew ? ('New ' + RES_TYPES[type].toLowerCase()) : esc(r.name || 'Record')}</h2>
          ${!isNew ? `<p class="inv-detail-sub">${esc(RES_TYPES[type])}</p>` : ''}
        </div>
        <button type="button" class="inv-detail-close" id="res-close" aria-label="Close">&times;</button>
      </header>

      <div class="inv-detail-body">
        <div class="inv-fgrid">
          <label class="ad-field"><span>Type</span>
            <select class="ad-select" data-rf="type">${typeOpt('staff')}${typeOpt('vehicle')}${typeOpt('trailer')}</select></label>
          <label class="ad-field"><span>Day rate (ex GST) $</span>
            <input class="ad-input" type="number" min="0" step="1" data-rf="dayRateCents" value="${attr(rate)}"></label>

          <label class="ad-field inv-span2"><span>Name</span>
            <input class="ad-input" data-rf="name" value="${attr(r.name)}" placeholder="${isStaff ? 'e.g. Jesse Taylor' : 'e.g. Mercedes Sprinter'}"></label>

          ${isStaff ? `
          <label class="ad-field"><span>Role</span><input class="ad-input" data-rf="role" value="${attr(r.role)}" placeholder="e.g. Sound tech"></label>
          <label class="ad-field"><span>Phone</span><input class="ad-input" data-rf="phone" value="${attr(r.phone)}" placeholder="Mobile"></label>`
          : `
          <label class="ad-field"><span>Rego</span><input class="ad-input" data-rf="rego" value="${attr(r.rego)}" placeholder="e.g. 123 ABC"></label>
          <label class="ad-field"><span>Capacity / size</span><input class="ad-input" data-rf="capacity" value="${attr(r.capacity)}" placeholder="e.g. 1 tonne"></label>`}

          <label class="ad-field inv-span2"><span>Notes</span>
            <textarea class="ad-input" rows="2" data-rf="notes" placeholder="Just for the team...">${esc(r.notes)}</textarea></label>
        </div>

        <label class="inv-toggle">
          <span>
            <strong>Active</strong>
            <em>Available to add to a quote as a billable line.</em>
          </span>
          <input type="checkbox" data-rf="active"${r.active !== false ? ' checked' : ''}>
          <span class="inv-switch" aria-hidden="true"></span>
        </label>
      </div>

      <footer class="inv-detail-foot">
        ${isNew ? '' : '<button type="button" class="ad-btn inv-del" id="res-delete">Delete</button>'}
        <button type="button" class="ad-btn ad-btn-primary" id="res-save">${isNew ? 'Add record' : 'Save changes'}</button>
        <span class="ad-quote-msg" id="res-msg"></span>
      </footer>
    </aside>`;
}

function wireResourceDetail() {
  const panel = document.querySelector('.inv-detail');
  if (!panel) return;

  const close = document.getElementById('res-close');
  if (close) close.addEventListener('click', () => { state.openResourceId = null; render(); });

  panel.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.dataset.rf) return;
    const f = t.dataset.rf;
    if (f === 'active') resourceDraft.active = t.checked;
    else if (f === 'dayRateCents') resourceDraft.dayRateCents = Math.max(0, Math.round(Number(t.value || 0) * 100));
    else resourceDraft[f] = t.value;
  });

  // switching the type swaps the staff / vehicle fields
  const typeSel = panel.querySelector('[data-rf="type"]');
  if (typeSel) typeSel.addEventListener('change', () => { resourceDraft.type = typeSel.value; render(); });

  const save = document.getElementById('res-save');
  if (save) save.addEventListener('click', () => saveResource(save));
  const del = document.getElementById('res-delete');
  if (del) del.addEventListener('click', () => deleteResource(del));
}

async function saveResource(btn) {
  const msg = document.getElementById('res-msg');
  const r = resourceDraft;
  if (!String(r.name || '').trim()) {
    if (msg) { msg.textContent = 'Give it a name first.'; msg.className = 'ad-quote-msg is-bad'; }
    return;
  }
  const type = RES_TYPES[r.type] ? r.type : 'staff';
  const clean = {
    type,
    name: String(r.name).trim().slice(0, 120),
    role: type === 'staff' ? String(r.role || '').trim().slice(0, 80) : '',
    phone: type === 'staff' ? String(r.phone || '').trim().slice(0, 40) : '',
    rego: type !== 'staff' ? String(r.rego || '').trim().slice(0, 40) : '',
    capacity: type !== 'staff' ? String(r.capacity || '').trim().slice(0, 80) : '',
    dayRateCents: Math.max(0, Math.round(r.dayRateCents || 0)),
    active: r.active !== false,
    notes: String(r.notes || '').trim().slice(0, 1000),
    updatedAt: Date.now(),
  };

  if (msg) { msg.textContent = 'Saving…'; msg.className = 'ad-quote-msg'; }
  if (btn) btn.disabled = true;
  try {
    const { collection, doc, setDoc, addDoc } = fb.f;
    state.resources = state.resources || [];
    if (state.openResourceId === '__new__') {
      clean.createdAt = Date.now();
      const ref = await addDoc(collection(fb.db, 'resources'), clean);
      state.openResourceId = ref.id;
      state.resources.push({ id: ref.id, ...clean });
    } else {
      const id = state.openResourceId;
      await setDoc(doc(fb.db, 'resources', id), clean, { merge: true });
      const cur = state.resources.find((x) => x.id === id);
      if (cur) Object.assign(cur, clean); else state.resources.push({ id, ...clean });
    }
    if (msg) { msg.textContent = 'Saved.'; msg.className = 'ad-quote-msg is-ok'; }
    render();
  } catch (err) {
    if (msg) { msg.textContent = err.message || 'Could not save.'; msg.className = 'ad-quote-msg is-bad'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteResource(btn) {
  if (!window.confirm('Delete this record? This cannot be undone.')) return;
  const id = state.openResourceId;
  if (id === '__new__') { state.openResourceId = null; render(); return; }
  if (btn) btn.disabled = true;
  try {
    const { doc, deleteDoc } = fb.f;
    await deleteDoc(doc(fb.db, 'resources', id));
    state.resources = (state.resources || []).filter((x) => x.id !== id);
    state.openResourceId = null;
    render();
  } catch (err) {
    const msg = document.getElementById('res-msg');
    if (msg) { msg.textContent = err.message || 'Could not delete.'; msg.className = 'ad-quote-msg is-bad'; }
    if (btn) btn.disabled = false;
  }
}

/*  The quote builder's add-search draws on inventory PLUS active crew and
    vehicles, so any of them can be dropped onto a quote as a billable line. */
function quoteAddSearchList() {
  const inv = invSearchList().map((it) => ({ id: it.id, name: it.name, priceCents: it.priceCents, kind: 'item', sub: it.category || 'Gear' }));
  const res = (state.resources || [])
    .filter((r) => r.active !== false && r.name)
    .map((r) => ({ id: r.id, name: r.name, priceCents: r.dayRateCents || 0, kind: 'resource', sub: RES_TYPES[r.type] || 'Crew' }));
  return inv.concat(res);
}

function addResourceLineToQuote(res) {
  const days = Math.max(1, Math.round(quoteDraft.hire.days || 1));
  quoteDraft.lines.push({ type: 'custom', name: res.name, qty: 1, unitCents: res.priceCents || 0, days, resourceId: res.id });
  renderQuoteLines();
}

/* =========================================================================
   LEADS — the gig lead generator, built into the admin panel.

   A lead is a prospect for work: production hire, a DJ/performance booking,
   or a venue/regular slot. They arrive from four places (auto-found events,
   manual add, website enquiries, a venue directory), you rate each one
   yourself with 1-5 stars, move it along a pipeline (New -> Contacted ->
   Quoted -> Negotiating -> Won/Lost), link a quote once you build one, and
   email them straight from here (draft + send, never auto-send). Styled to
   match Inventory and Crew & Vehicles.
   ========================================================================= */

const LEAD_TYPES = { production: 'Production hire', dj: 'DJ / Performance', venue: 'Venue / regular' };
const LEAD_SOURCES = { manual: 'Manual', auto: 'Auto-found', website: 'Website', directory: 'Directory' };
const LEAD_STAGE_ORDER = ['new', 'researching', 'contacted', 'quoted', 'negotiating', 'won', 'lost'];
const LEAD_STAGES = { new: 'New', researching: 'Researching', contacted: 'Contacted', quoted: 'Quote Sent', negotiating: 'In Discussion', won: 'Won', lost: 'Lost' };

/*  Heat rating carried over from the research import (Grok's Hot/Warm/...).
    Kept apart from Max's own 5-star rating, which is his call alone.
    Existing = a job SoundzGood already has/won; Locked = someone else is on
    it. Both are flags only - nothing is blocked.                          */
const GROK_ORDER = ['Hot', 'Existing', 'Warm', 'Cool', 'Locked', 'Skip'];
const GROK_PILL = { Hot: 'inv-st-red', Existing: 'inv-st-green', Warm: 'inv-st-amber', Cool: 'inv-st-blue', Locked: 'inv-st-slate', Skip: 'inv-st-slate' };

function blankLead(type) {
  return {
    type: LEAD_TYPES[type] ? type : 'production',
    title: '', contactName: '', phone: '', email: '', website: '', socials: '',
    eventName: '', eventDate: '', dateText: '', venue: '', town: '', crowd: '',
    source: 'manual', sourceUrl: '', ticketUrl: '',
    budget: '', needs: '',
    rating: 0, stage: 'new',
    category: '', grokRating: '', winPct: '', nextAction: '', incumbent: '',
    haul: '', whyFit: '', decisionMaker: '',
    linkedQuoteId: '', linkedQuoteNumber: '',
    lastContacted: '', notes: '', importBatch: '',
    estValueCents: 0,
    followUp: '', target: false, contacts: [], files: [], history: [], km: '',
    organiser: '', startTime: '',
    imageUrl: '', imageBroken: false,
    eoiDate: '', eoiNote: '', recurrence: '', lastEdition: '', venueSetup: '', power: '',
  };
}

/*  No phone and no email = can't be worked yet. Worked out live, so it
    clears itself the moment a contact detail is added.                    */
function leadNeedsContact(r) {
  return !String(r.email || '').trim() && !String(r.phone || '').trim();
}

/*  Which month a lead sits in, as 'YYYY-MM' - from the exact date when
    there is one, else read out of the date as the research listed it
    ("Oct 2026", "~Jun/Jul 2027", "May annual"). A month with no year is
    taken as its next occurrence. '' when there is no month at all
    ("TBC 2027", "Recurring / seasonal").                                  */
const LEAD_MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function leadMonthKey(r) {
  if (r.eventDate && /^\d{4}-\d{2}/.test(r.eventDate)) return r.eventDate.slice(0, 7);
  const s = String(r.dateText || '');
  const m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i);
  if (!m) return '';
  const mon = LEAD_MON.indexOf(m[1].toLowerCase()) + 1;
  const y = s.match(/\b(20\d\d)\b/);
  let year = y ? Number(y[1]) : 0;
  if (!year) {
    const now = new Date();
    year = now.getFullYear() + (mon < now.getMonth() + 1 ? 1 : 0);
  }
  return year + '-' + String(mon).padStart(2, '0');
}

/*  Real week-of-year numbers (ISO: weeks start Monday, week 1 is the one
    holding the year's first Thursday - 52 or 53 a year). A week belongs
    to the month its Thursday is in, so a week that straddles two months
    sits under the one with most of its days, and every week shows once.  */
function isoWeekInfo(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dow = d.getUTCDay() || 7;                       // Mon=1 .. Sun=7
  const thu = new Date(d); thu.setUTCDate(d.getUTCDate() + 4 - dow);
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() + 1 - dow);
  const yearStart = Date.UTC(thu.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thu - yearStart) / 86400000 + 1) / 7);
  return {
    key: thu.getUTCFullYear() + '-W' + String(week).padStart(2, '0'),
    week,
    monthKey: thu.getUTCFullYear() + '-' + String(thu.getUTCMonth() + 1).padStart(2, '0'),
    monday: new Date(mon.getUTCFullYear(), mon.getUTCMonth(), mon.getUTCDate()),
  };
}

/*  The week a lead falls in ('2026-W39'), exact dates only - a lead that
    only knows its month has no week and stays off the week rows.        */
function leadWeekKey(r) {
  if (!r.eventDate || !/^\d{4}-\d{2}-\d{2}/.test(r.eventDate)) return '';
  const [y, m, d] = r.eventDate.slice(0, 10).split('-').map(Number);
  return isoWeekInfo(new Date(y, m - 1, d)).key;
}

/*  "21–27 Sep 2026" for the week starting on the given Monday. */
function weekRangeLabel(monday) {
  const sun = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const mon3 = (dt) => LEAD_MON[dt.getMonth()].charAt(0).toUpperCase() + LEAD_MON[dt.getMonth()].slice(1);
  return monday.getMonth() === sun.getMonth()
    ? `${monday.getDate()}–${sun.getDate()} ${mon3(sun)} ${sun.getFullYear()}`
    : `${monday.getDate()} ${mon3(monday)} – ${sun.getDate()} ${mon3(sun)} ${sun.getFullYear()}`;
}

/*  High / medium / low for the calendar dots. Max's own stars win once he
    has rated a lead; until then the research heat stands in.             */
function leadPriority(r) {
  const n = Math.round(r.rating || 0);
  if (n >= 4) return 'high';
  if (n === 3) return 'medium';
  if (n >= 1) return 'low';
  if (r.grokRating === 'Hot' || r.grokRating === 'Existing') return 'high';
  if (r.grokRating === 'Warm') return 'medium';
  return 'low';
}

let leadDraft = blankLead();

function subscribeToLeads() {
  const { collection, onSnapshot } = fb.f;
  unsubscribes.push(onSnapshot(
    collection(fb.db, 'leads'),
    (snap) => {
      const rows = [];
      snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
      /*  Open leads first (by pipeline order), then Max's stars, then the
          imported heat (Hot first) and win %, then name. Won/Lost fall to
          the bottom - they are done with.                                 */
      const grokRank = (r) => { const i = GROK_ORDER.indexOf(r.grokRating); return i < 0 ? 99 : i; };
      rows.sort((a, b) =>
        (LEAD_STAGE_ORDER.indexOf(a.stage || 'new') - LEAD_STAGE_ORDER.indexOf(b.stage || 'new'))
        || (b.rating || 0) - (a.rating || 0)
        || grokRank(a) - grokRank(b)
        || (Number(b.winPct) || 0) - (Number(a.winPct) || 0)
        || (a.title || '').localeCompare(b.title || '', undefined, { numeric: true, sensitivity: 'base' }));
      state.leads = rows;
      if (state.view === 'leads') {
        if (state.openLeadId) renderLeadListParts(true);
        else render();
      }
      // the rating deck redraws on outside changes, but not mid-save
      if (state.view === 'leadRate' && !(state.rate && state.rate.busy)) render();
    },
    (err) => console.error('leads', err)
  ));
}

VIEWS.leads = {
  html() {
    const open = state.openLeadId != null;
    return `<div class="inv-wrap${open ? ' has-detail' : ''}">
      ${leadMainHtml()}
      ${open ? leadDetailHtml() : ''}
      ${state.leadCompose ? leadComposeHtml() : ''}
    </div>`;
  },
  wire() {
    wireLeadImageErrors();
    wireLeadList();
    if (state.openLeadId != null) wireLeadDetail();
    if (state.leadCompose) wireLeadCompose();
  },
};

/* ---- little star rating: read-only in rows, clickable in the editor ---- */
function leadStars(n, editable) {
  const v = Math.max(0, Math.min(5, Math.round(n || 0)));
  let out = '';
  for (let i = 1; i <= 5; i++) {
    out += `<span class="lead-star${i <= v ? ' is-on' : ''}"${editable ? ` data-star="${i}" role="button" tabindex="0" aria-label="${i} star${i === 1 ? '' : 's'}"` : ''}>&#9733;</span>`;
  }
  return `<span class="lead-stars${editable ? ' is-edit' : ''}">${out}</span>`;
}

/*  The categories actually in use, for the filter - so it grows with the
    data instead of being a hard-coded list.                              */
function leadCategories() {
  const set = new Set();
  (state.leads || []).forEach((r) => { if (r.category) set.add(r.category); });
  return [...set].sort((a, b) => a.localeCompare(b));
}

function leadFiltered(ignoreMonth) {
  const rows = state.leads || [];
  const f = state.leadFilter || 'all';
  const tf = state.leadTypeFilter || 'all';
  const cf = state.leadCatFilter || 'all';
  const gf = state.leadGrokFilter || 'all';
  const kf = state.leadContactFilter || 'all';
  const rf = state.leadRegionFilter || 'all';
  const sf = state.leadSizeFilter || 'all';
  const ff = state.leadFitFilter || 'all';
  const chip = state.leadChip || 'all';
  const needle = (state.leadSearch || '').trim().toLowerCase();
  return rows.filter((r) => {
    if (f !== 'all' && (r.stage || 'new') !== f) return false;
    if (tf !== 'all' && (r.type || 'production') !== tf) return false;
    if (cf !== 'all' && (r.category || '') !== cf) return false;
    if (gf !== 'all' && (r.grokRating || '') !== gf) return false;
    if (kf === 'needs' && !leadNeedsContact(r)) return false;
    if (kf === 'email' && !String(r.email || '').trim()) return false;
    if (kf === 'phone' && !String(r.phone || '').trim()) return false;
    if (rf !== 'all' && leadRegion(r) !== rf) return false;
    if (sf !== 'all' && leadSize(r) !== sf) return false;
    if (ff === 'unrated' && Math.round(r.rating || 0)) return false;
    if (ff !== 'all' && ff !== 'unrated' && Math.round(r.rating || 0) !== Number(ff)) return false;
    if (!leadChipMatch(r, chip)) return false;
    if ((state.leadRange || 'all') !== 'all' && !leadInRange(r, state.leadRange)) return false;
    if (!ignoreMonth && state.leadMonth && leadMonthKey(r) !== state.leadMonth) return false;
    if (!ignoreMonth && state.leadWeek && leadWeekKey(r) !== state.leadWeek) return false;
    if (!needle) return true;
    return [r.title, r.organiser, r.contactName, r.decisionMaker, r.eventName, r.town, r.venue, r.email, r.phone,
      r.category, r.nextAction, r.incumbent, ...(r.contacts || []).map((c) => c.name + ' ' + c.email)]
      .filter(Boolean).join(' ').toLowerCase().includes(needle);
  });
}

/*  The quick-filter chips (and the KPI tiles, which share them). */
function leadChipMatch(r, chip) {
  const st = r.stage || 'new';
  switch (chip) {
    case 'all': return true;
    case 'targets': return !!r.target;
    case 'hot': case 'high': return leadPriority(r) === 'high';
    case 'medium': case 'low': return leadPriority(r) === chip;
    case 'needs': return leadNeedsContact(r);
    case 'stale': return !!r.imageBroken;
    case 'followups': return leadFollowState(r) !== '';
    case 'quotes': return st === 'quoted';
    case 'inplay': return st === 'contacted' || st === 'quoted' || st === 'negotiating';
    default: return st === chip;   // won / lost
  }
}

/*  Follow-ups: 'overdue' (date has passed), 'due' (within the next 7 days),
    or '' - and never for leads already won or lost. Shown on screen only;
    nothing is emailed or notified.                                        */
function leadFollowState(r) {
  const fu = String(r.followUp || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fu)) return '';
  const st = r.stage || 'new';
  if (st === 'won' || st === 'lost') return '';
  if (fu < leadTodayIso()) return 'overdue';
  const wk = new Date(); wk.setDate(wk.getDate() + 7);
  const wkIso = wk.getFullYear() + '-' + String(wk.getMonth() + 1).padStart(2, '0') + '-' + String(wk.getDate()).padStart(2, '0');
  return fu <= wkIso ? 'due' : '';
}

/*  A published supplier deadline (EOI / tender): when it closes and how
    close that is. null when there isn't one.                           */
function leadEoi(r) {
  const d = String(r.eoiDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const days = Math.round((new Date(d + 'T00:00:00') - new Date(leadTodayIso() + 'T00:00:00')) / 86400000);
  return { date: d, days, state: days < 0 ? 'closed' : days <= 30 ? 'soon' : 'later', note: String(r.eoiNote || '').trim() };
}
const LEAD_POWER = { mains: 'Mains power on site', generator: 'Generator needed', unknown: 'Power unknown' };

/*  Region, read from the venue / town / name. North QLD focused.        */
const LEAD_REGIONS = [
  ['whitsundays', 'Whitsundays & Bowen', /bowen|airlie|proserpine|cannonvale|whitsunday|hamilton island|hayman|daydream|collinsville|jubilee pocket|shute harbour|cape gloucester|hydeaway|dingo beach|gumlu|guthalungra|merinda|scottville|ben bolt/i],
  ['mackay', 'Mackay & Isaac', /mackay|sarina|moranbah|nebo|clermont|dysart|middlemount|glenden|eungella|finch hatton|marian|mirani|walkerston|seaforth|st lawrence|calen|farleigh|palmyra|isaac|bucasia|ooralea|harrup/i],
  ['townsville', 'Townsville & Burdekin', /townsville|\bayr\b|home hill|burdekin|giru|brandon|charters towers|ingham|cardwell|hinchinbrook|magnetic island|lucinda|ravenswood|halifax|bluewater|kirwan|the ville|brothers leagues/i],
  ['cairns', 'Cairns & Far North', /cairns|mareeba|atherton|yungaburra|port douglas|innisfail|tully|mission beach|kuranda|malanda|ravenshoe|herberton|cooktown|tablelands|gordonvale|babinda|kerribee|cazaly/i],
  ['central', 'Central QLD', /rockhampton|yeppoon|gladstone|emerald|biloela|blackwater|capricorn|moura|springsure|fitzroy|frenchville|sapphire|rubyvale/i],
  ['outback', 'Outback', /mount isa|mt isa|winton|longreach|barcaldine|richmond|hughenden|cloncurry|julia creek|isisford|blackall|charleville|boulia|birdsville|tambo|aramac|muttaburra|prairie|torrens creek|pentland|ewan|georgetown|croydon|normanton|karumba|camooweal|bedourie|windorah|quilpie|jericho|\balpha\b|ilfracombe|kynuna|mckinlay|outback/i],
];
function leadRegion(r) {
  const t = [r.venue, r.town, r.title, r.eventName].filter(Boolean).join(' ');
  const hit = LEAD_REGIONS.find(([, , re]) => re.test(t));
  return hit ? hit[0] : 'other';
}

/*  Size, from the expected attendance text ("~3,000 expected").         */
const LEAD_SIZES = [['small', 'Under 300'], ['medium', '300–2,000'], ['large', '2,000–10,000'], ['major', '10,000+'], ['unknown', 'Size unknown']];
function leadCrowdNum(r) {
  const m = String(r.crowd || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(k\b)?/i);
  if (!m) return 0;
  return Math.round(parseFloat(m[1]) * (m[2] ? 1000 : 1));
}
function leadSize(r) {
  const n = leadCrowdNum(r);
  if (!n) return 'unknown';
  return n < 300 ? 'small' : n < 2000 ? 'medium' : n < 10000 ? 'large' : 'major';
}

/*  Fit = the lead's priority, shown as Strong / Medium / Possible bars. */
const LEAD_FIT = { high: ['Strong', 'is-strong', 4], medium: ['Medium', 'is-medium', 3], low: ['Possible', 'is-possible', 2] };
function leadFitHtml(r) {
  const [label, cls, n] = LEAD_FIT[leadPriority(r)];
  return `<span class="lead-fitc ${cls}"><strong>${label}</strong><span class="lead-fitbars" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<i${i <= n ? ' class="on"' : ''}></i>`).join('')}</span></span>`;
}

/*  The next thing to do on a lead, worked out from where it's up to.
    Clicking it does that thing.                                          */
function leadNextAct(r) {
  const st = r.stage || 'new';
  if (st === 'won' || st === 'lost') return null;
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(r.email || '').trim());
  const phone = !!String(r.phone || '').trim();
  if (!email && !phone) return { k: 'contact', label: 'Find contact', rank: 2 };
  const reach = (label, rank) => (email ? { k: 'email', label, rank } : { k: 'call', label: label === 'Follow up' ? 'Call to follow up' : 'Call', rank });
  if (leadFollowState(r) === 'overdue') return { ...reach('Follow up', 0), overdue: true };
  if (st === 'researching') return { k: 'research', label: 'Research', rank: 3 };
  if (st === 'quoted') return { k: 'quote', label: r.linkedQuoteId ? 'Send quote' : 'Create quote', rank: 4 };
  if (st === 'contacted' || st === 'negotiating') return reach('Follow up', 5);
  return reach('Prepare outreach', 1);
}
function leadNextActHtml(r) {
  const a = leadNextAct(r);
  if (!a) return '<span class="ad-cell-muted">—</span>';
  const ico = { email: '✉', call: '📞', contact: '🔍', research: '🔎', quote: '▦' }[a.k] || '›';
  const cls = `lead-nact is-${a.k}${a.overdue ? ' is-overdue' : ''}`;
  const q = (s) => encodeURIComponent(s.replace(/\s+/g, ' ').trim());
  if (a.k === 'call') {
    return `<a class="${cls}" href="tel:${attr(String(r.phone).replace(/[^\d+]/g, ''))}" title="Call ${attr(r.phone)}">${ico} ${esc(a.label)}</a>`;
  }
  if (a.k === 'contact' || a.k === 'research') {
    const what = a.k === 'contact'
      ? `${r.contactName || r.title || ''} ${r.venue || ''} contact email phone`
      : `${r.title || r.eventName || ''} ${r.venue || ''}`;
    return `<a class="${cls}" href="https://www.google.com/search?q=${q(what)}" target="_blank" rel="noopener noreferrer" title="Search the web">${ico} ${esc(a.label)}</a>`;
  }
  return `<button type="button" class="${cls}" data-lead-nact="${a.k}" data-id="${attr(r.id)}">${ico} ${esc(a.label)}</button>`;
}

/*  Contacts: the main contact (the lead's own fields) plus any extras. */
function leadContactCount(r) {
  const main = [r.contactName, r.phone, r.email].some((v) => String(v || '').trim()) ? 1 : 0;
  return main + (Array.isArray(r.contacts) ? r.contacts.length : 0);
}

/*  A real date when there is one; otherwise the date as the research listed
    it ("TBC 2027", "Sep annual") rather than inventing a day.            */
function leadWhen(r) {
  return r.eventDate ? fmtLeadDate(r.eventDate) : (r.dateText || '');
}

function grokPill(g) {
  return GROK_PILL[g] ? `<span class="inv-pill ${GROK_PILL[g]}">${esc(g)}</span>` : '';
}

function fmtLeadDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

/* ---- the month strip across the top: a dot per lead, coloured by
        priority. Click a month to filter to it, click again to clear. ---- */
const LEAD_CAL_MONTHS = 12;
const LEAD_CAL_DOTS = 8;       // dots drawn per month before it says +n

/*  Financial-year week numbers, as Max works them: Week 1 is the first week
    of July (the Mon-Sun week holding July's first Thursday), counting on to
    52 or 53 at the end of June. A week belongs to the FY and the month its
    Thursday falls in, so every week appears exactly once.                */
function leadFyWeek(monday) {
  const thu = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3);
  const fyYear = thu.getMonth() >= 6 ? thu.getFullYear() : thu.getFullYear() - 1;   // FY that starts July fyYear
  const jul1 = new Date(fyYear, 6, 1);
  const firstThu = new Date(fyYear, 6, 1 + ((4 - jul1.getDay() + 7) % 7));
  const week = Math.round((thu - firstThu) / (7 * 86400000)) + 1;
  const label = 'FY' + String(fyYear % 100).padStart(2, '0') + '/' + String((fyYear + 1) % 100).padStart(2, '0');
  return { week, fyYear, label };
}

function leadCalendarHtml() {
  const now = new Date();
  const nowKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const today = isoWeekInfo(now);
  const todayFy = leadFyWeek(today.monday);
  const start = new Date(now.getFullYear(), now.getMonth() + (state.leadCalOffset || 0), 1);
  const monthKeys = [];
  for (let i = 0; i < LEAD_CAL_MONTHS; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    monthKeys.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
  }

  // the real weeks in view, filed under the month their Thursday is in
  const weeksByMonth = {};
  monthKeys.forEach((k) => { weeksByMonth[k] = []; });
  const endLimit = new Date(start.getFullYear(), start.getMonth() + LEAD_CAL_MONTHS, 7);
  for (let mon = isoWeekInfo(start).monday; mon < endLimit;
       mon = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7)) {
    const w = isoWeekInfo(mon);
    if (weeksByMonth[w.monthKey]) weeksByMonth[w.monthKey].push(w);
  }

  // leads matching every other filter: by month, and (exact dates) by week
  const byMonth = {};
  const byWeek = {};
  let undated = 0;
  const wonWeek = {};   // won jobs per week - a gold trophy sits above that week's dots
  leadFiltered(true).forEach((r) => {
    const k = leadMonthKey(r);
    if (!k) { undated++; return; }
    const p = leadPriority(r);
    (byMonth[k] = byMonth[k] || []).push(p);
    const wk = leadWeekKey(r);
    if (wk) (byWeek[wk] = byWeek[wk] || []).push(p);
    if (wk && r.stage === 'won') wonWeek[wk] = (wonWeek[wk] || 0) + 1;
  });

  const rank = { high: 0, medium: 1, low: 2 };
  const tally = { high: 0, medium: 0, low: 0 };
  let dated = 0;
  let cells = '';

  monthKeys.forEach((key) => {
    const [y, m] = key.split('-').map(Number);
    const all = byMonth[key] || [];
    all.forEach((p) => { tally[p]++; });
    const monthSel = key === state.leadMonth;
    const cls = ['lead-cal-m', key === nowKey ? 'is-now' : '', monthSel ? 'is-sel' : '', all.length ? '' : 'is-empty']
      .filter(Boolean).join(' ');
    const longName = new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });

    //  One slot per week, spaced across the month; up to three dots stacked
    //  in each (highest priority first), so the year reads as 52 weeks.
    const slots = weeksByMonth[key].map((w) => {
      const list = (byWeek[w.key] || []).slice().sort((a, b) => rank[a] - rank[b]);
      dated += list.length;
      const fy = leadFyWeek(w.monday);
      const range = weekRangeLabel(w.monday);
      const on = state.leadWeek === w.key;
      const isToday = w.key === today.key;
      const cnt = { high: 0, medium: 0, low: 0 };
      list.forEach((p) => { cnt[p]++; });
      // fixed lanes - high on top, medium in the middle, low at the bottom -
      // so each colour lines up across the whole year
      const dots = list.length ? ['high', 'medium', 'low']
        .map((p) => (cnt[p] ? `<i class="lead-cdot is-${p}">${cnt[p]}</i>` : '<i class="lead-cdot is-empty"></i>')).join('') : '';
      const breakdown = ['high', 'medium', 'low'].filter((p) => cnt[p]).map((p) => `${cnt[p]} ${p}`).join(', ');
      return `<button type="button" class="lead-wslot${on ? ' is-sel' : ''}${isToday ? ' is-today' : ''}${list.length ? '' : ' is-empty'}"
                data-lead-week="${w.key}" aria-pressed="${on}"
                title="Week ${fy.week} (${fy.label}) · ${range}${isToday ? ' · this week' : ''}${wonWeek[w.key] ? ' · ' + wonWeek[w.key] + ' won' : ''} · ${list.length} dated lead${list.length === 1 ? '' : 's'}${breakdown ? ' (' + breakdown + ')' : ''}"><span class="lead-wslot-no">${fy.week}</span><span class="lead-wslot-dots">${wonWeek[w.key] ? '<i class="lead-ctrophy" aria-label="Won">🏆</i>' : ''}${dots || '<i class="lead-cdot is-empty"></i><i class="lead-cdot is-empty"></i><i class="lead-cdot is-empty"></i>'}</span></button>`;
    }).join('');

    cells += `
      <div class="${cls}">
        <button type="button" class="lead-cal-head" data-lead-month="${key}" aria-pressed="${monthSel}"
                aria-label="${longName}: ${all.length} lead${all.length === 1 ? '' : 's'}">
          <span class="lead-cal-mon">${LEAD_MON[m - 1].toUpperCase()}</span>
          <span class="lead-cal-yr">${y}</span>
          <strong class="lead-cal-big">${all.length || '—'}</strong>
        </button>
        <div class="lead-wkrow">${slots}</div>
      </div>`;
  });

  let picked = '';
  if (state.leadWeek) {
    const [wy, wn] = state.leadWeek.split('-W').map(Number);
    const w1 = isoWeekInfo(new Date(wy, 0, 4)).monday;
    const monday = new Date(w1.getFullYear(), w1.getMonth(), w1.getDate() + (wn - 1) * 7);
    const fy = leadFyWeek(monday);
    picked = `Week ${fy.week} · ${weekRangeLabel(monday)}`;
  } else if (state.leadMonth) {
    const [y, m] = state.leadMonth.split('-').map(Number);
    picked = new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
  }

  return `
    <div class="lead-cal lead-cal-v3">
      <button type="button" class="lead-cal-arrow" data-lead-cal="-3" aria-label="Earlier months">&#8249;</button>
      <div class="lead-cal-track">${cells}</div>
      <button type="button" class="lead-cal-arrow" data-lead-cal="3" aria-label="Later months">&#8250;</button>
    </div>
    <div class="lead-cal-legend">
      <span class="lead-cal-today">Today: Week ${todayFy.week} · ${todayFy.label}</span>
      <span><i class="lead-dot is-high"></i> High (${tally.high})</span>
      <span><i class="lead-dot is-medium"></i> Medium (${tally.medium})</span>
      <span><i class="lead-dot is-low"></i> Low (${tally.low})</span>
      <span class="lead-cal-undated">Numbers = leads that week (exact dates: ${dated}) · No month yet: ${undated}</span>
      ${state.leadCalOffset ? '<button type="button" class="lead-cal-link" data-lead-cal="today">Back to this month</button>' : ''}
      ${picked ? `<button type="button" class="lead-cal-clear" data-lead-clear="1">Showing ${esc(picked)} &times;</button>` : ''}
    </div>`;
}

/*  The strip and the rows both follow the filters, so any filter change
    redraws both. The strip wires itself by delegation on its host, which
    survives the redraw.                                                  */
function renderLeadListParts(keepPage) {
  if (!keepPage) {
    state.leadPage = 1;
    const wrap = document.querySelector('.lead-table-wrap');
    if (wrap) wrap.scrollTop = 0;
  }
  const cal = document.getElementById('lead-cal');
  if (cal) cal.innerHTML = leadCalendarHtml();
  renderLeadRows();
}

function wireLeadCalendar() {
  const cal = document.getElementById('lead-cal');
  if (!cal) return;
  cal.addEventListener('click', (e) => {
    const clear = e.target.closest('[data-lead-clear]');
    if (clear) { state.leadMonth = ''; state.leadWeek = ''; renderLeadListParts(); return; }
    const wk = e.target.closest('[data-lead-week]');
    if (wk) {
      const key = wk.getAttribute('data-lead-week');
      state.leadWeek = state.leadWeek === key ? '' : key;
      state.leadMonth = '';
      renderLeadListParts();
      return;
    }
    const m = e.target.closest('[data-lead-month]');
    if (m) {
      const key = m.getAttribute('data-lead-month');
      state.leadMonth = state.leadMonth === key ? '' : key;
      state.leadWeek = '';
      renderLeadListParts();
      return;
    }
    const a = e.target.closest('[data-lead-cal]');
    if (a) {
      const v = a.getAttribute('data-lead-cal');
      state.leadCalOffset = v === 'today' ? 0 : (state.leadCalOffset || 0) + Number(v);
      renderLeadListParts();
    }
  });
}

/* ---- look & feel helpers for the Event Opportunities (Leads) screen ---- */

/*  A coloured tile + icon per category stands in for a photo until real
    images arrive. Unknown categories fall back to the lead's type.      */
const LEAD_CAT_STYLE = {
  'Race days': ['🏇', 'lc-race'],
  'Rodeos/campdraft': ['🤠', 'lc-rodeo'],
  'Ag shows': ['🐄', 'lc-ag'],
  'Fishing/sports': ['🎣', 'lc-fish'],
  'Tourism/chamber': ['🌴', 'lc-tour'],
  'Council/civic': ['🏛️', 'lc-civic'],
  'Formal/debutante': ['💃', 'lc-formal'],
  'Corporate/mining': ['⛏️', 'lc-corp'],
  'Sport finals': ['🏆', 'lc-sport'],
};
const LEAD_TYPE_STYLE = { production: ['🎛️', 'lc-prod'], dj: ['🎧', 'lc-dj'], venue: ['🍻', 'lc-venue'] };
function leadCatStyle(r) {
  return LEAD_CAT_STYLE[r.category] || LEAD_TYPE_STYLE[r.type] || LEAD_TYPE_STYLE.production;
}
/*  A lead's photo is a LINK to the image on their own site - nothing is
    stored. If it stops loading, they've changed their site, so the lead is
    flagged "may be out of date" and queued for the research to re-check. */
function leadImageUrl(r) {
  const u = String(r.imageUrl || '').trim();
  if (/^https:\/\//i.test(u)) return u;
  if (/^http:\/\//i.test(u)) return 'https://' + u.slice(7);   // a secure page can't show http images
  return '';
}
function leadCatTile(r, big) {
  const [icon, cls] = leadCatStyle(r);
  const url = r.imageBroken ? '' : leadImageUrl(r);
  const img = url ? `<img src="${attr(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-lead-img="${attr(r.id || '')}">` : '';
  return `<span class="lead-tile ${cls}${big ? ' is-big' : ''}${img ? ' has-img' : ''}${r.imageBroken ? ' is-stale' : ''}" aria-hidden="true">${icon}${img}${r.imageBroken ? '<em class="lead-stale-badge">!</em>' : ''}</span>`;
}

/*  One page-wide listener catches any lead photo that fails to load. */
let leadImgErrWired = false;
function wireLeadImageErrors() {
  if (leadImgErrWired) return;
  leadImgErrWired = true;
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.hasAttribute('data-lead-img')) return;
    const holder = img.parentElement;
    const id = img.getAttribute('data-lead-img');
    img.remove();
    if (holder) {
      holder.classList.remove('has-img');
      holder.classList.add('is-stale');
      if (holder.classList.contains('lead-tile') && !holder.querySelector('.lead-stale-badge')) {
        holder.insertAdjacentHTML('beforeend', '<em class="lead-stale-badge">!</em>');
      }
    }
    if (navigator.onLine !== false) markLeadImageBroken(id);   // offline isn't "out of date"
  }, true);
}

async function markLeadImageBroken(id) {
  if (!id || id === '__new__') return;
  const cur = (state.leads || []).find((x) => x.id === id);
  if (!cur || cur.imageBroken) return;
  cur.imageBroken = true;
  if (state.openLeadId === id) leadDraft.imageBroken = true;
  try {
    const e = { at: Date.now(), text: 'Photo link stopped working — info may be out of date (queued for re-check)' };
    const { doc, setDoc, arrayUnion } = fb.f;
    await setDoc(doc(fb.db, 'leads', id), { imageBroken: true, imageBrokenAt: Date.now(), history: arrayUnion(e) }, { merge: true });
    cur.history = [...(cur.history || []), e];
  } catch (err) {
    console.error('photo flag', err);
  }
}

const LEAD_PRIO_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
function leadHeatPill(r) {
  const p = leadPriority(r);
  return `<span class="lead-heat is-${p}">${LEAD_PRIO_LABEL[p]}</span>`;
}

function leadStagePill2(stage) {
  const s = LEAD_STAGES[stage] ? stage : 'new';
  return `<span class="lead-stage is-${s}">${esc(LEAD_STAGES[s])}</span>`;
}

/*  Value: the linked quote's total when there is one, else Max's estimate. */
function leadValue(r) {
  if (r.linkedQuoteId) {
    const q = (state.quoteDocs || []).find((x) => x.id === r.linkedQuoteId);
    if (q && q.totalCents > 0) return { cents: q.totalCents, src: 'quote', number: q.number || '' };
  }
  const e = Math.round(r.estValueCents || 0);
  return e > 0 ? { cents: e, src: 'est' } : null;
}
function leadDollars(cents) {
  return '$' + Math.round((cents || 0) / 100).toLocaleString('en-AU');
}
/*  Contact details as a row of small clickable icons under the lead name:
    phone (tap to call), email, website and social pages. Hover shows the
    number / address; clicking an icon does its job without opening the lead. */
const LEAD_SVG = {
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  web: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  facebook: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 8h3V4h-3a4 4 0 0 0-4 4v2H8v4h2v8h4v-8h3l1-4h-4V8.5a.5.5 0 0 1 .5-.5z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".8" fill="currentColor"/></svg>',
  tiktok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 3h3a4 4 0 0 0 4 4v3a7 7 0 0 1-4-1.3V15a6 6 0 1 1-6-6h.5v3.2A3 3 0 1 0 14 15z"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 8.2a3 3 0 0 0-2.1-2.1C18 5.6 12 5.6 12 5.6s-6 0-7.9.5A3 3 0 0 0 2 8.2 31 31 0 0 0 1.6 12 31 31 0 0 0 2 15.8a3 3 0 0 0 2.1 2.1c1.9.5 7.9.5 7.9.5s6 0 7.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .4-3.8 31 31 0 0 0-.4-3.8zM10 15V9l5.2 3z"/></svg>',
  person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
};
const LEAD_SOCIAL_HOSTS = [
  ['facebook', /(^|\.)(facebook\.com|fb\.com|fb\.me)$/i],
  ['instagram', /(^|\.)instagram\.com$/i],
  ['tiktok', /(^|\.)tiktok\.com$/i],
  ['youtube', /(^|\.)(youtube\.com|youtu\.be)$/i],
];

/*  A web address as a safe http(s) URL, or null. */
function leadSafeUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  try {
    const x = new URL(u);
    return (x.protocol === 'http:' || x.protocol === 'https:') ? x : null;
  } catch (e) { return null; }
}
function leadSocialKind(x) {
  const host = x.hostname.replace(/^www\./, '');
  const hit = LEAD_SOCIAL_HOSTS.find(([, re]) => re.test(host));
  return hit ? hit[0] : '';
}

/*  Website + social pages, read from the website and Socials fields.
    Socials can be links ("facebook.com/xyz") or an @handle (Instagram). */
function leadLinks(r) {
  const out = [];
  const seen = new Set();
  const add = (kind, x) => { if (seen.has(kind + x.href)) return; seen.add(kind + x.href); out.push({ kind, x }); };
  const web = leadSafeUrl(r.website);
  if (web) add(leadSocialKind(web) || 'web', web);
  String(r.socials || '').split(/[\s,;|]+/).filter(Boolean).forEach((tok) => {
    if (/^@[\w.]{2,}$/.test(tok)) { const x = leadSafeUrl('instagram.com/' + tok.slice(1)); if (x) add('instagram', x); return; }
    if (!/\.[a-z]{2,}/i.test(tok)) return;
    const x = leadSafeUrl(tok);
    if (x) add(leadSocialKind(x) || 'web', x);
  });
  return out;
}

function leadContactIconsHtml(r) {
  const ic = [];
  const phone = String(r.phone || '').trim();
  if (phone) {
    ic.push(`<a class="lead-ic is-phone" href="tel:${attr(phone.replace(/[^\d+]/g, ''))}" title="Call ${attr(phone)}" aria-label="Call ${attr(phone)}">${LEAD_SVG.phone}</a>`);
  }
  const email = String(r.email || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    ic.push(`<a class="lead-ic is-mail" href="mailto:${attr(email)}" title="Email ${attr(email)}" aria-label="Email ${attr(email)}">${LEAD_SVG.mail}</a>`);
  }
  const names = { web: 'Website', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };
  leadLinks(r).forEach(({ kind, x }) => {
    const label = x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname.replace(/\/$/, '') : '');
    ic.push(`<a class="lead-ic is-${kind}" href="${attr(x.href)}" target="_blank" rel="noopener noreferrer" title="${attr(names[kind] + ': ' + label)}" aria-label="${attr(names[kind] + ': ' + label)}">${LEAD_SVG[kind]}</a>`);
  });
  const crowd = r.crowd ? `<span class="lead-ev-crowd" title="Expected attendance">👥 ${esc(r.crowd)}</span>` : '';
  return ic.length || crowd ? `<span class="lead-ev-icons">${ic.join('')}${crowd}</span>` : '';
}

function leadValueHtml(r) {
  const v = leadValue(r);
  if (!v) return '<span class="ad-cell-muted">—</span>';
  return v.src === 'quote'
    ? `<span class="lead-val" title="Linked quote ${attr(v.number)}">${leadDollars(v.cents)}</span>`
    : `<span class="lead-val is-est" title="Your estimate">~${leadDollars(v.cents)}</span>`;
}

function leadTodayIso() {
  const t = new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}

/*  "2 days ago" for the last-contact column. */
function leadRelDay(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return String(iso);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const n = Math.round((t - d) / 86400000);
  if (n < 0) return fmtLeadDate(String(iso).slice(0, 10));
  if (n === 0) return 'Today';
  if (n === 1) return 'Yesterday';
  if (n < 7) return n + ' days ago';
  if (n < 35) { const w = Math.round(n / 7); return w + ' week' + (w === 1 ? '' : 's') + ' ago'; }
  return fmtLeadDate(String(iso).slice(0, 10));
}

function leadHasExactDate(r) {
  return !!(r.eventDate && /^\d{4}-\d{2}-\d{2}/.test(r.eventDate));
}
/*  A month-only lead is taken as mid-month (the 15th) - the same day it
    sorts on - so late in a month, "Sep annual" counts as been and gone.  */
function leadIsPast(r) {
  if (leadHasExactDate(r)) return r.eventDate.slice(0, 10) < leadTodayIso();
  const k = leadMonthKey(r);
  return !!k && (k + '-15') < leadTodayIso();
}

/*  The "Showing:" range. Past events never count as upcoming, even when
    they fall earlier in this month.                                       */
function leadInRange(r, rg) {
  const k = leadMonthKey(r);
  if (rg === 'nodate') return !k;
  if (!k) return false;
  const past = leadIsPast(r);
  if (rg === 'past') return past;
  if (past) return false;
  const now = new Date();
  const span = rg === 'month' ? 1 : rg === 'next3' ? 3 : 12;
  const end = new Date(now.getFullYear(), now.getMonth() + span - 1, 1);
  const endKey = end.getFullYear() + '-' + String(end.getMonth() + 1).padStart(2, '0');
  return k <= endKey;
}

/*  Sort key date: the exact day, else mid-month for a month-only lead. */
function leadSortDate(r) {
  if (leadHasExactDate(r)) return r.eventDate.slice(0, 10);
  const k = leadMonthKey(r);
  return k ? k + '-15' : '';
}

/*  Column sorting, built like the Inventory table: click a header to sort
    by it, click the active one again to flip. Each column starts in its
    natural direction (soonest date, High heat, biggest value, most recent
    contact, else A-Z), and blanks always sit at the bottom.              */
const LEAD_SORT_DIR = {
  date: 'asc', name: 'asc', location: 'asc', category: 'asc', priority: 'asc',
  stage: 'asc', value: 'desc', last: 'desc', updated: 'desc', nextact: 'asc', followup: 'asc', fit: 'desc',
};
const LEAD_SORT_LABEL = {
  date: 'Date (soonest)', nextact: 'Next action', followup: 'Follow-up date', fit: 'Fit (5 first)', value: 'Est. value',
  location: 'Distance from Bowen', name: 'Name (A–Z)', category: 'Category', stage: 'Stage', last: 'Last contact', updated: 'Recently updated',
};

/*  The value a column sorts on; '' or null = blank (always last). */
function leadSortValue(r, key) {
  switch (key) {
    case 'name': return r.title || r.contactName || '';
    case 'date': return leadSortDate(r);
    case 'location': { const k = leadKm(r); return k == null ? null : k; }
    case 'fit': return Math.round(r.rating || 0) || null;
    case 'category': return r.category || LEAD_TYPES[r.type] || '';
    case 'priority': {
      const p = { high: 0, medium: 1, low: 2 }[leadPriority(r)];
      const g = GROK_ORDER.indexOf(r.grokRating);
      return p * 1000 + (5 - Math.round(r.rating || 0)) * 100 + (g < 0 ? 99 : g) * 1 - (Number(r.winPct) || 0) / 1000;
    }
    case 'stage': return LEAD_STAGE_ORDER.indexOf(r.stage || 'new');
    case 'value': { const v = leadValue(r); return v ? v.cents : null; }
    case 'last': return r.lastContacted || '';
    case 'updated': return r.updatedAt || null;
    case 'nextact': { const a = leadNextAct(r); return a ? a.rank : null; }
    case 'followup': return /^\d{4}-\d{2}-\d{2}/.test(String(r.followUp || '')) ? String(r.followUp).slice(0, 10) : '';
    default: return '';
  }
}

function leadSorted(rows) {
  const key = LEAD_SORT_DIR[state.leadSort] ? state.leadSort : 'date';
  const dir = state.leadSortDir === 'asc' || state.leadSortDir === 'desc' ? state.leadSortDir : LEAD_SORT_DIR[key];
  const out = rows.slice();
  const byName = (a, b) => (a.title || '').localeCompare(b.title || '', undefined, { numeric: true, sensitivity: 'base' });

  //  "Date (soonest)": upcoming first, then no-date-yet, then past (most
  //  recent first) - so the top of the list is always what's next.
  if (key === 'date' && dir === 'asc') {
    const grp = (r) => (!leadMonthKey(r) ? 1 : leadIsPast(r) ? 2 : 0);
    return out.sort((a, b) => {
      const g = grp(a) - grp(b);
      if (g) return g;
      const da = leadSortDate(a), db = leadSortDate(b);
      if (grp(a) === 2) return db.localeCompare(da) || byName(a, b);
      return da.localeCompare(db) || leadSortValue(a, 'priority') - leadSortValue(b, 'priority') || byName(a, b);
    });
  }

  const mul = dir === 'desc' ? -1 : 1;
  const blank = (v) => v === null || v === undefined || v === '';
  return out.sort((a, b) => {
    const va = leadSortValue(a, key), vb = leadSortValue(b, key);
    const ea = blank(va), eb = blank(vb);
    if (ea || eb) return ea && eb ? byName(a, b) : ea ? 1 : -1;
    const c = typeof va === 'number' && typeof vb === 'number'
      ? va - vb
      : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
    return c * mul || byName(a, b);
  });
}

/*  A sortable header, same look as Inventory's (inv-th-sort / inv-caret). */
function leadTh(key, label, cls) {
  const on = state.leadSort === key;
  const dir = state.leadSortDir || LEAD_SORT_DIR[key];
  const glyph = on ? (dir === 'asc' ? '▲' : '▼') : '⇅';
  return `<th class="${cls ? cls + ' ' : ''}inv-th-sort${on ? ' is-sorted' : ''}" data-lead-sort="${key}"
              aria-sort="${on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${esc(label)}<span class="inv-caret${on ? '' : ' inv-caret-idle'}">${glyph}</span></th>`;
}

/*  Refresh the carets and the Sort menu in place after a sort change. */
function updateLeadSortHeaders() {
  const dir = state.leadSortDir || LEAD_SORT_DIR[state.leadSort] || 'asc';
  document.querySelectorAll('.lead-table thead [data-lead-sort]').forEach((th) => {
    const on = th.getAttribute('data-lead-sort') === state.leadSort;
    th.classList.toggle('is-sorted', on);
    th.setAttribute('aria-sort', on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
    const caret = th.querySelector('.inv-caret');
    if (caret) {
      caret.textContent = on ? (dir === 'asc' ? '▲' : '▼') : '⇅';
      caret.classList.toggle('inv-caret-idle', !on);
    }
  });
  const sel = document.getElementById('lead-sort');
  if (sel) sel.value = state.leadSort;
  const wrap = document.querySelector('.lead-table-wrap');
  if (wrap) wrap.scrollTop = 0;
}

/*  Quick-filter chip counts, always over every lead so they stay steady. */
/*  Counts for the KPI tiles and the quick-filter chips - always over every
    lead, so they stay steady while you filter.                           */
function leadChipCounts() {
  const rows = state.leads || [];
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const year = now.getFullYear();
  const c = {
    all: rows.length, targets: 0, hot: 0, needs: 0, stale: 0, followups: 0, quotes: 0, inplay: 0, won: 0, lost: 0,
    hotNew: 0, needsHot: 0, overdue: 0, quotesCents: 0, wonYear: 0, wonCents: 0,
  };
  rows.forEach((r) => {
    const st = r.stage || 'new';
    const hot = leadPriority(r) === 'high';
    if (r.target) c.targets++;
    if (r.imageBroken) c.stale++;
    if (hot) { c.hot++; if ((r.createdAt || 0) >= monthStart) c.hotNew++; }
    if (leadNeedsContact(r)) { c.needs++; if (hot) c.needsHot++; }
    const fu = leadFollowState(r);
    if (fu) { c.followups++; if (fu === 'overdue') c.overdue++; }
    if (st === 'quoted') { c.quotes++; const v = leadValue(r); if (v) c.quotesCents += v.cents; }
    if (st === 'contacted' || st === 'quoted' || st === 'negotiating') c.inplay++;
    if (st === 'won') {
      c.won++;
      if (new Date(r.updatedAt || 0).getFullYear() === year) { c.wonYear++; const v = leadValue(r); if (v) c.wonCents += v.cents; }
    }
    if (st === 'lost') c.lost++;
  });
  return c;
}

/* ---- history: a timeline per lead (added, researched, stage changes,
        follow-ups, emails, quotes, files). Entries are appended, never
        edited, so it is a true record.                                ---- */
async function leadLog(id, text) {
  if (!id || id === '__new__') return;
  try {
    const e = { at: Date.now(), text: String(text).slice(0, 300) };
    const { doc, setDoc, arrayUnion } = fb.f;
    await setDoc(doc(fb.db, 'leads', id), { history: arrayUnion(e) }, { merge: true });
    const cur = (state.leads || []).find((x) => x.id === id);
    if (cur) cur.history = [...(cur.history || []), e];
  } catch (err) {
    console.error('lead log', err);
  }
}

/*  The stored log plus the moments we can read off the lead itself
    (when it was added / imported, when it was researched).             */
function leadTimeline(r) {
  const out = (Array.isArray(r.history) ? r.history : []).map((h) => ({ at: Number(h.at) || 0, text: h.text || '' }));
  if (r.createdAt) out.push({ at: r.createdAt, text: r.importBatch ? 'Imported from the Grok research list' : 'Lead added' });
  if (r.enrichedAt) {
    const chk = (LEAD_CHECK[r.contactCheck] || [])[1];
    out.push({ at: new Date(String(r.enrichedAt).slice(0, 10) + 'T12:00:00').getTime(), text: 'Researched online' + (chk ? ' — ' + chk.toLowerCase() : '') });
  }
  return out.filter((h) => h.at).sort((a, b) => b.at - a.at);
}

/* ---- the research log written by the web research pass ---- */
const LEAD_CHECK = {
  verified: ['is-green', 'Contacts verified'],
  added: ['is-blue', 'Contacts added'],
  updated: ['is-amber', 'Contact corrected'],
  partial: ['is-amber', 'Partly verified'],
  unverified: ['is-red', 'Contacts unverified'],
  none: ['is-slate', 'No public contact'],
  skipped: ['is-slate', 'Not researched'],
};
const LEAD_FIELD_LABEL = {
  dateText: 'date', contactName: 'contact', phone: 'phone', email: 'email', website: 'website',
  venue: 'venue', crowd: 'attendance', needs: 'need', whyFit: 'why it fits', ticketUrl: 'ticket link',
};
function leadResearchHtml(doc) {
  if (!doc || !doc.enrichedAt) return '';
  const [cls, label] = LEAD_CHECK[doc.contactCheck] || LEAD_CHECK.partial;
  const prev = doc.enrichPrev && typeof doc.enrichPrev === 'object' ? Object.entries(doc.enrichPrev) : [];
  const sources = (Array.isArray(doc.enrichSources) ? doc.enrichSources : [])
    .filter((u) => /^https?:\/\//i.test(String(u)));
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } };
  return `
        <div class="lead-research">
          <div class="lead-research-head">
            <strong>🔎 Researched ${esc(fmtLeadDate(String(doc.enrichedAt).slice(0, 10)))}</strong>
            <span class="lead-check ${cls}">${esc(label)}</span>
          </div>
          ${doc.enrichNotes ? `<p class="lead-research-notes">${esc(doc.enrichNotes)}</p>` : ''}
          ${prev.length ? `<p class="lead-research-prev">Replaced: ${prev.map(([k, v]) => `${esc(LEAD_FIELD_LABEL[k] || k)} was “${esc(v)}”`).join(' · ')}</p>` : ''}
          ${sources.length ? `<p class="lead-research-src">Sources: ${sources.map((u) => `<a href="${attr(u)}" target="_blank" rel="noopener noreferrer">${esc(host(u))}</a>`).join(' · ')}</p>` : ''}
        </div>`;
}

/* ---- quick actions ---- */

/*  An all-day calendar entry for the event, downloaded as an .ics file. */
function leadIcsDownload(r, id) {
  if (!leadHasExactDate(r)) return;
  const day = r.eventDate.slice(0, 10);
  const start = day.replace(/-/g, '');
  const n = new Date(day + 'T00:00:00'); n.setDate(n.getDate() + 1);
  const end = n.getFullYear() + String(n.getMonth() + 1).padStart(2, '0') + String(n.getDate()).padStart(2, '0');
  const ic = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const desc = [r.dateText, r.contactName, r.phone, r.email, r.needs ? 'Needs: ' + r.needs : ''].filter(Boolean).join('\n');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SoundzGood//Leads//EN', 'BEGIN:VEVENT',
    'UID:lead-' + (id || day) + '@soundzgood.com.au', 'DTSTAMP:' + stamp,
    'DTSTART;VALUE=DATE:' + start, 'DTEND;VALUE=DATE:' + end,
    'SUMMARY:' + ic(r.title || r.eventName || 'Event'), 'LOCATION:' + ic(r.venue || r.town), 'DESCRIPTION:' + ic(desc),
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = (r.title || 'event').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) + '.ics';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/*  Start a new quote already filled in from the lead. When that quote is
    first saved, saveQuoteDoc links it back here (state.quoteFromLeadId). */
function createQuoteFromLead() {
  const r = leadDraft;
  quoteDraft = blankQuote();
  quoteDraft.customer = {
    ...quoteDraft.customer,
    name: r.contactName || r.decisionMaker || '',
    email: r.email || '',
    phone: r.phone || '',
    address: r.venue || r.town || '',
    eventName: r.eventName || r.title || '',
    eventDate: leadHasExactDate(r) ? r.eventDate.slice(0, 10) : '',
  };
  if (leadHasExactDate(r)) {
    quoteDraft.hire.startDate = r.eventDate.slice(0, 10);
    quoteDraft.hire.endDate = r.eventDate.slice(0, 10);
  }
  state.quoteFromLeadId = state.openLeadId;
  state.openLeadId = null;
  state.openQuoteId = '__new__';
  location.hash = '#/quoteDocs';
}

/*  Called once the quote made from a lead is first saved: link it, and move
    a New/Contacted lead on to Quoted.                                      */
async function linkQuoteToLead(leadId, quoteId, number) {
  try {
    const cur = (state.leads || []).find((x) => x.id === leadId);
    const early = !cur || !cur.stage || cur.stage === 'new' || cur.stage === 'researching' || cur.stage === 'contacted';
    const stage = early ? 'quoted' : cur.stage;
    const patchData = { linkedQuoteId: quoteId, linkedQuoteNumber: number || '', stage, updatedAt: Date.now() };
    const { doc, setDoc } = fb.f;
    await setDoc(doc(fb.db, 'leads', leadId), patchData, { merge: true });
    if (cur) Object.assign(cur, patchData);
    await leadLog(leadId, `Quote ${number || ''} created and linked${early ? ' — stage: Quote Sent' : ''}`);
  } catch (err) {
    console.error('link quote to lead', err);
  }
}

function leadMainHtml() {
  const f = state.leadFilter;
  const cf = state.leadCatFilter;
  const rf = state.leadRegionFilter || 'all';
  const sf = state.leadSizeFilter || 'all';
  const ff = state.leadFitFilter || 'all';
  const opt = (cur, v, l) => `<option value="${attr(v)}"${cur === v ? ' selected' : ''}>${esc(l)}</option>`;
  const c = leadChipCounts();
  const ch = state.leadChip || 'all';
  const chip = (k, label, dot) => `
          <button type="button" class="lead-chip${ch === k ? ' is-active' : ''}" data-lead-chip="${k}">
            ${dot ? `<i class="lead-dot is-${dot}"></i>` : ''}${label} <span>(${c[k]})</span>
          </button>`;
  const kpi = (k, icon, tone, value, label, sub, subTone) => `
          <button type="button" class="lead-kpi${ch === k ? ' is-on' : ''}" data-lead-chip="${k}">
            <span class="lead-kpi-ico ${tone}" aria-hidden="true">${icon}</span>
            <span class="lead-kpi-txt"><strong>${value}</strong><span>${label}</span>${sub ? `<em class="${subTone || ''}">${sub}</em>` : ''}</span>
          </button>`;
  const rg = state.leadRange || 'all';
  const so = state.leadSort || 'date';

  return `
      <div class="inv-main lead-page">
        <div class="lead-top">
          <div>
            <h1>Event Opportunities</h1>
            <p class="lead-tagline">Find. Plan. Connect. More Events for a Louder Tomorrow.</p>
          </div>
          <div class="lead-add">
            <button type="button" class="lead-cta" id="lead-add-btn" aria-haspopup="true" aria-expanded="false">＋ Add Lead <span class="lead-cta-caret" aria-hidden="true">▾</span></button>
            <div class="lead-add-menu" id="lead-add-menu" role="menu">
              <button type="button" role="menuitem" data-lead-new="production">🎛️ Production hire</button>
              <button type="button" role="menuitem" data-lead-new="dj">🎧 DJ / performance</button>
              <button type="button" role="menuitem" data-lead-new="venue">🍻 Venue / regular</button>
            </div>
          </div>
        </div>

        <div class="lead-kpis" id="lead-kpis">
          ${kpi('hot', '🔥', 'is-red', c.hot, 'Hot leads', c.hotNew ? `↑ ${c.hotNew} this month` : '', 'is-good')}
          ${kpi('needs', '📨', 'is-green', c.needs, 'Need contact', c.needsHot ? `${c.needsHot} are hot` : '', 'is-warn')}
          ${kpi('followups', '🔁', 'is-blue', c.followups, 'Follow-ups', c.overdue ? `${c.overdue} overdue` : 'due this week', c.overdue ? 'is-bad' : '')}
          ${kpi('quotes', '📄', 'is-green', c.quotes, 'Quotes out', c.quotesCents ? leadDollars(c.quotesCents) + ' value' : '', '')}
          ${kpi('won', '🏆', 'is-amber', c.wonYear, 'Won (' + new Date().getFullYear() + ')', c.wonCents ? leadDollars(c.wonCents) + ' value' : '', '')}
        </div>

        <div id="lead-cal">${leadCalendarHtml()}</div>

        <div class="lead-chipbar">
          <div class="lead-chips" id="lead-chips">
            ${chip('all', 'All Leads')}${chip('targets', '☆ My Targets')}${chip('hot', 'Hot', 'high')}${chip('needs', 'Need contact')}${c.stale ? chip('stale', '⚠ Out of date') : ''}
            ${chip('followups', 'Follow-ups')}${chip('quotes', 'Quotes')}${chip('inplay', 'In Play')}${chip('won', 'Won')}${chip('lost', 'Lost')}
          </div>
          <div class="lead-sorts">
            <label>Showing:
              <select id="lead-range" class="lead-mini-select" aria-label="Date range">
                ${opt(rg, 'all', 'All dates')}${opt(rg, 'next12', 'Next 12 months')}${opt(rg, 'next3', 'Next 3 months')}${opt(rg, 'month', 'This month')}${opt(rg, 'nodate', 'No date yet')}${opt(rg, 'past', 'Past')}
              </select></label>
            <label>Sort:
              <select id="lead-sort" class="lead-mini-select" aria-label="Sort leads">
                ${Object.keys(LEAD_SORT_LABEL).map((k) => opt(so, k, LEAD_SORT_LABEL[k])).join('')}
              </select></label>
          </div>
        </div>

        <div class="inv-toolbar lead-toolbar">
          <input type="search" id="lead-search" class="ad-search" placeholder="Search leads, events, organisers..."
                 value="${attr(state.leadSearch)}" aria-label="Search leads">
          <select id="lead-f-stage" class="ad-select" aria-label="Filter by stage">
            ${opt(f, 'all', 'All stages')}${LEAD_STAGE_ORDER.map((k) => opt(f, k, LEAD_STAGES[k])).join('')}
          </select>
          <select id="lead-f-cat" class="ad-select" aria-label="Filter by category">
            ${opt(cf, 'all', 'All categories')}${leadCategories().map((x) => opt(cf, x, x)).join('')}
          </select>
          <select id="lead-f-region" class="ad-select" aria-label="Filter by location">
            ${opt(rf, 'all', 'Any location')}${LEAD_REGIONS.map(([k, l]) => opt(rf, k, l)).join('')}${opt(rf, 'other', 'Other / unknown')}
          </select>
          <select id="lead-f-size" class="ad-select" aria-label="Filter by size">
            ${opt(sf, 'all', 'Any size')}${LEAD_SIZES.map(([k, l]) => opt(sf, k, l)).join('')}
          </select>
          <select id="lead-f-fit" class="ad-select" aria-label="Filter by fit">
            ${opt(ff, 'all', 'Any fit')}${['5', '4', '3', '2', '1'].map((n) => opt(ff, n, 'Fit ' + n + '/5')).join('')}${opt(ff, 'unrated', 'Not rated yet')}
          </select>
        </div>

        <div class="ad-table-wrap inv-table-wrap lead-table-wrap">
          <table class="ad-table lead-table">
            <thead>
              <tr>
                ${leadTh('name', 'Event', 'lead-evcol')}
                ${leadTh('date', 'Date')}
                ${leadTh('location', 'Location', 'lead-where')}
                ${leadTh('category', 'Category', 'lead-catcol')}
                ${leadTh('fit', 'Fit')}
                ${leadTh('value', 'Est. Value', 'lead-num')}
                ${leadTh('nextact', 'Next Action')}
                <th></th>
              </tr>
            </thead>
            <tbody id="lead-rows"></tbody>
          </table>
        </div>

        <div class="lead-foot" id="lead-foot"></div>
      </div>`;
}

/*  Page numbers: first, last and the current page's neighbours, with …
    where pages are skipped.                                             */
function leadPageList(page, pages) {
  const want = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4, 5].forEach((n) => want.add(n));
  if (page >= pages - 2) [pages - 4, pages - 3, pages - 2].forEach((n) => want.add(n));
  const list = [...want].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out = [];
  list.forEach((n, i) => { if (i && n - list[i - 1] > 1) out.push('…'); out.push(n); });
  return out;
}

/*  Road km from Bowen: Max's own figure if he set one, else the km in the
    research's haul note ("~4 hr / 340 km"), else the delivery-zone distance
    of a town named in the venue / town / title. null = unknown, 0 = local. */
function leadKm(r) {
  const own = Number(r.km);
  if (String(r.km || '').trim() !== '' && own >= 0) return Math.round(own);
  const haul = String(r.haul || '');
  const h = haul.match(/(\d[\d,]*)\s*km/i);
  if (h) return Number(h[1].replace(/,/g, ''));
  if (/\blocal\b/i.test(haul)) return 0;
  const text = [r.town, r.venue, r.title].filter(Boolean).join(' ');
  let best = null;
  DELIVERY_ZONES.forEach((z) => {
    const name = String(z.town || '').replace(/\s*\(.*\)\s*/, '').trim();
    if (!name || !(z.km >= 0)) return;
    const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(text) && (!best || name.length > best.name.length)) best = { name, km: z.km };
  });
  return best ? best.km : null;
}
function leadKmText(r) {
  const km = leadKm(r);
  if (km == null) return '';
  return km === 0 ? 'Local (Bowen)' : km.toLocaleString('en-AU') + ' km from Bowen';
}

/*  Fit, 1-5, set by Max: five bars. Click a bar to set it; click the top
    lit bar again to step down one. Saves straight away.                  */
function leadFitRater(n, editable, id) {
  const v = Math.max(0, Math.min(5, Math.round(n || 0)));
  let bars = '';
  for (let i = 1; i <= 5; i++) {
    bars += `<span class="lead-fr${i <= v ? ' on' : ''}"${editable ? ` data-fit="${i}" role="button" tabindex="0" aria-label="Fit ${i} of 5"` : ''}></span>`;
  }
  return `<span class="lead-fitr${editable ? ' is-edit' : ''}${v ? ' is-' + v : ' is-unset'}"${id ? ` data-fit-id="${attr(id)}"` : ''}
                title="${v ? 'Fit ' + v + ' / 5' : 'Fit not set'}${editable ? ' — click to set' : ''}"><span class="lead-frs">${bars}</span><em>${v ? v + '/5' : 'Set'}</em></span>`;
}

async function setLeadFit(id, n) {
  const cur = (state.leads || []).find((x) => x.id === id);
  if (!cur) return;
  const v = Math.max(0, Math.min(5, Math.round(n)));
  const next = Math.round(cur.rating || 0) === v ? v - 1 : v;
  cur.rating = next;
  if (state.openLeadId === id) leadDraft.rating = next;
  renderLeadListParts(true);
  document.querySelectorAll(`.lead-detail .lead-fitr[data-fit-id="${CSS.escape(id)}"]`).forEach((el) => {
    el.outerHTML = leadFitRater(next, true, id);
  });
  try {
    const e = { at: Date.now(), text: next ? `Fit set to ${next}/5` : 'Fit cleared' };
    const { doc, setDoc, arrayUnion } = fb.f;
    await setDoc(doc(fb.db, 'leads', id), { rating: next, updatedAt: Date.now(), history: arrayUnion(e) }, { merge: true });
    cur.history = [...(cur.history || []), e];
  } catch (err) {
    console.error('fit', err);
  }
}

/*  The organiser (club / committee / company): Max's own field if set,
    else read off the contact - "Helen Daley (Bowen Turf Club)" or
    "Andrew Watts — Longreach Jockey Club" give the organisation; a plain
    name is shown as it is.                                               */
function leadOrganiser(r) {
  const own = String(r.organiser || '').trim();
  if (own) return own;
  const c = String(r.contactName || '').trim();
  if (!c) return '';
  const paren = c.match(/\(([^()]+)\)\s*$/);
  if (paren) {
    // "(Bowen Turf Club)" is the organisation; "(functions/events)", "(Sec)"
    // or "(organiser)" is a role, so the name in front of it is used instead
    const inside = paren[1].trim();
    const role = /^(pres|president|sec|secretary|treasurer|chair|organi[sz]er|manager|owner|office|events?|functions?|admin|ops|contact|booking)/i;
    if (/^[A-Z]/.test(inside) && !role.test(inside)) return inside;
    return c.slice(0, paren.index).trim() || inside;
  }
  const parts = c.split(/\s[—–-]\s/);
  return parts.length > 1 ? parts[parts.length - 1].trim() : c;
}

/*  Start times: Max's own field if set, else the times written into the
    date text ("Sat 31 Oct 2026 — gates 5pm, main event 7pm" -> "gates 5pm,
    main event 7pm"; "Sat 17 Oct 2026, 12–5pm" -> "12–5pm").              */
function leadStartTime(r) {
  const own = String(r.startTime || '').trim();
  if (own) return own;
  const t = String(r.dateText || '');
  const m = t.match(/(?:\b[A-Za-z][A-Za-z-]*\s){0,3}\b\d{1,2}(?::\d{2})?\s*(?:[–-]\s*\d{1,2}(?::\d{2})?\s*)?(?:am|pm)\b/gi);
  return m ? m.map((s) => s.trim()).join(', ') : '';
}

/*  Website + social pages as small clickable icons (no phone / email). */
function leadWebIconsHtml(r) {
  const names = { web: 'Website', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };
  const ic = leadLinks(r).map(({ kind, x }) => {
    const label = x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname.replace(/\/$/, '') : '');
    return `<a class="lead-ic is-${kind}" href="${attr(x.href)}" target="_blank" rel="noopener noreferrer" title="${attr(names[kind] + ': ' + label)}" aria-label="${attr(names[kind] + ': ' + label)}">${LEAD_SVG[kind]}</a>`;
  });
  return ic.length ? `<span class="lead-ev-icons">${ic.join('')}</span>` : '';
}

function renderLeadRows() {
  const host = document.getElementById('lead-rows');
  const foot = document.getElementById('lead-foot');
  if (!host) return;
  const all = leadSorted(leadFiltered());
  const per = state.leadPerPage || 10;
  const pages = Math.max(1, Math.ceil(all.length / per));
  if (state.leadPage > pages) state.leadPage = pages;
  if (!state.leadPage || state.leadPage < 1) state.leadPage = 1;
  const start = (state.leadPage - 1) * per;
  const rows = all.slice(start, start + per);

  host.innerHTML = rows.length ? rows.map((r) => {
    const when = leadWhen(r);
    const where = r.venue || r.town || '';
    const km = leadKmText(r);
    const fu = leadFollowState(r);
    const name = r.title || r.eventName || r.contactName || 'Untitled lead';
    const org = leadOrganiser(r);
    const time = leadStartTime(r);
    return `
    <tr class="lead-row${state.openLeadId === r.id ? ' is-open' : ''}" data-open-lead="${attr(r.id)}">
      <td class="lead-evcol">
        <div class="lead-ev">
          ${leadCatTile(r)}
          <span class="lead-ev-text">
            <span class="lead-ev-name" title="${attr(name)}">${esc(name)}${r.target ? ' <span class="lead-ev-star" title="My target">★</span>' : ''}</span>
            ${org ? `<span class="lead-ev-org" title="${attr(org)}">${esc(org)}</span>` : ''}
            ${leadWebIconsHtml(r)}
          </span>
        </div>
      </td>
      <td class="lead-when">${when ? `<span class="lead-ico" aria-hidden="true">📅</span>${esc(when)}` : '<span class="ad-cell-muted">—</span>'}${time && !String(when).includes(time) ? `<span class="lead-time" title="${attr(time)}">${esc(time)}</span>` : ''}</td>
      <td class="lead-where">
        ${where ? `<span class="lead-loc" title="${attr(where)}"><span class="lead-ico" aria-hidden="true">📍</span>${esc(where)}</span>` : '<span class="ad-cell-muted">—</span>'}
        ${km ? `<span class="lead-km">${esc(km)}</span>` : ''}
      </td>
      <td class="lead-catcol">${r.category ? `<span class="lead-cat">${esc(r.category)}</span>` : `<span class="lead-cat is-type">${esc(LEAD_TYPES[r.type] || 'Lead')}</span>`}${r.verdict ? `<span class="lead-verdict is-${attr(r.verdict)}">${esc(LEAD_VERDICT[r.verdict] || r.verdict)}</span>` : ''}${r.needsResearch ? '<span class="lead-verdict is-info">More info queued</span>' : ''}</td>
      <td>${leadFitRater(r.rating, true, r.id)}</td>
      <td class="lead-num">${leadValueHtml(r)}</td>
      <td>${leadNextActHtml(r)}${fu ? `<span class="lead-fu is-${fu}">${fu === 'overdue' ? 'Overdue ' : 'Due '}${esc(fmtLeadDate(String(r.followUp).slice(0, 10)))}</span>` : ''}${(() => { const e = leadEoi(r); return e && e.state !== 'closed' ? `<span class="lead-eoi is-${e.state}" title="${attr(e.note || 'Supplier deadline')}">EOI closes ${esc(fmtLeadDate(e.date))}</span>` : ''; })()}</td>
      <td class="ad-cell-right"><button type="button" class="lead-more" data-open-lead="${attr(r.id)}" aria-label="${r.id === state.openLeadId ? 'Close' : 'Open'} ${attr(name)}">${r.id === state.openLeadId ? 'Less' : 'More'}</button></td>
    </tr>`;
  }).join('')
    : `<tr><td colspan="8" class="ad-cell-muted">No leads match. Try clearing the filters, or add one with ＋ Add Lead.</td></tr>`;

  if (foot) {
    const from = all.length ? start + 1 : 0;
    const to = Math.min(start + per, all.length);
    const pager = leadPageList(state.leadPage, pages).map((n) => n === '…'
      ? '<span class="lead-pg-gap">…</span>'
      : `<button type="button" class="lead-pg${n === state.leadPage ? ' is-on' : ''}" data-lead-page="${n}"${n === state.leadPage ? ' aria-current="page"' : ''}>${n}</button>`).join('');
    const perOpt = (n) => `<option value="${n}"${per === n ? ' selected' : ''}>${n} per page</option>`;
    foot.innerHTML = `
      <div class="lead-foot-count"><strong>${all.length} lead${all.length === 1 ? '' : 's'}</strong>
        <span>Showing ${from}–${to} of ${all.length}</span></div>
      <div class="lead-pager">
        <button type="button" class="lead-pg" data-lead-page="${state.leadPage - 1}"${state.leadPage <= 1 ? ' disabled' : ''} aria-label="Previous page">&#8249;</button>
        ${pager}
        <button type="button" class="lead-pg" data-lead-page="${state.leadPage + 1}"${state.leadPage >= pages ? ' disabled' : ''} aria-label="Next page">&#8250;</button>
      </div>
      <select class="lead-mini-select lead-per" id="lead-per" aria-label="Leads per page">${[10, 25, 50, 100].map(perOpt).join('')}</select>`;
  }
}

let leadAddMenuWired = false;

/*  Open a lead in the side panel (on a given tab). */
function openLead(id, tab) {
  const doc = (state.leads || []).find((x) => x.id === id);
  if (!doc) return false;
  leadDraft = leadFromDoc(doc);
  state.openLeadId = id;
  state.leadTab = tab || 'overview';
  return true;
}

/*  Up / Down arrow keys step through the leads on screen, opening each
    in the side panel (ignored while typing in a field). */
let leadKeysWired = false;
function wireLeadKeys() {
  if (leadKeysWired) return;
  leadKeysWired = true;
  document.addEventListener('keydown', (e) => {
    if (state.view !== 'leads' || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest('input, select, textarea, [contenteditable]')) return;
    const ids = [...document.querySelectorAll('.lead-table tr.lead-row[data-open-lead]')].map((tr) => tr.getAttribute('data-open-lead'));
    if (!ids.length) return;
    e.preventDefault();
    const at = ids.indexOf(state.openLeadId);
    const next = at < 0 ? ids[0] : ids[Math.max(0, Math.min(ids.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next === state.openLeadId) return;
    if (!openLead(next, state.leadTab || 'overview')) return;
    render();
    const row = document.querySelector('.lead-table tr.lead-row.is-open');
    if (row) row.scrollIntoView({ block: 'nearest' });
  });
}

function wireLeadList() {
  wireLeadKeys();
  renderLeadRows();
  wireLeadCalendar();

  // ＋ Add Lead ▾ - pick the kind of lead
  const addBtn = document.getElementById('lead-add-btn');
  const addMenu = document.getElementById('lead-add-menu');
  if (addBtn && addMenu) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !addMenu.classList.contains('is-open');
      addMenu.classList.toggle('is-open', open);
      addBtn.setAttribute('aria-expanded', String(open));
    });
    if (!leadAddMenuWired) {
      // one page-wide listener: a click anywhere outside closes the menu
      leadAddMenuWired = true;
      document.addEventListener('click', (e) => {
        if (e.target.closest('.lead-add')) return;
        const m = document.getElementById('lead-add-menu');
        const b = document.getElementById('lead-add-btn');
        if (m) m.classList.remove('is-open');
        if (b) b.setAttribute('aria-expanded', 'false');
      });
    }
  }
  document.querySelectorAll('[data-lead-new]').forEach((b) => b.addEventListener('click', () => {
    leadDraft = blankLead(b.getAttribute('data-lead-new'));
    state.openLeadId = '__new__';
    state.leadTab = 'details';
    render();
  }));

  const onSel = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { state[key] = el.value; renderLeadListParts(); });
  };
  onSel('lead-f-stage', 'leadFilter');
  onSel('lead-f-cat', 'leadCatFilter');
  onSel('lead-f-region', 'leadRegionFilter');
  onSel('lead-f-size', 'leadSizeFilter');
  onSel('lead-f-fit', 'leadFitFilter');
  onSel('lead-range', 'leadRange');
  const sortSel = document.getElementById('lead-sort');
  if (sortSel) sortSel.addEventListener('change', () => {
    state.leadSort = sortSel.value;
    state.leadSortDir = '';
    state.leadPage = 1;
    updateLeadSortHeaders();
    renderLeadRows();
  });
  const search = document.getElementById('lead-search');
  if (search) search.addEventListener('input', () => { state.leadSearch = search.value; renderLeadListParts(); });

  const thead = document.querySelector('.lead-table thead');
  if (thead) thead.addEventListener('click', (e) => {
    const th = e.target.closest('[data-lead-sort]');
    if (!th) return;
    const k = th.getAttribute('data-lead-sort');
    if (state.leadSort === k) {
      const cur = state.leadSortDir || LEAD_SORT_DIR[k];
      state.leadSortDir = cur === 'asc' ? 'desc' : 'asc';
    } else {
      state.leadSort = k;
      state.leadSortDir = '';
    }
    state.leadPage = 1;
    updateLeadSortHeaders();
    renderLeadRows();
  });

  // chips and KPI tiles share the same quick filters
  const page = document.querySelector('.lead-page');
  if (page) page.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lead-chip]');
    if (!b) return;
    const k = b.getAttribute('data-lead-chip');
    state.leadChip = (state.leadChip === k && k !== 'all') ? 'all' : k;
    page.querySelectorAll('.lead-chip[data-lead-chip]').forEach((x) =>
      x.classList.toggle('is-active', x.getAttribute('data-lead-chip') === state.leadChip));
    page.querySelectorAll('.lead-kpi[data-lead-chip]').forEach((x) =>
      x.classList.toggle('is-on', x.getAttribute('data-lead-chip') === state.leadChip));
    renderLeadListParts();
  });

  const foot = document.getElementById('lead-foot');
  if (foot) {
    foot.addEventListener('click', (e) => {
      const b = e.target.closest('[data-lead-page]');
      if (!b || b.disabled) return;
      state.leadPage = Number(b.getAttribute('data-lead-page')) || 1;
      renderLeadRows();
      const wrap = document.querySelector('.lead-table-wrap');
      if (wrap) {
        wrap.scrollTop = 0;
        // on a phone the page scrolls, not the list, so bring the list into view
        if (!window.matchMedia('(min-width: 900px)').matches) wrap.scrollIntoView({ block: 'nearest' });
      }
    });
    foot.addEventListener('change', (e) => {
      if (e.target.id !== 'lead-per') return;
      state.leadPerPage = Number(e.target.value) || 10;
      state.leadPage = 1;
      renderLeadRows();
    });
  }

  const host = document.getElementById('lead-rows');
  if (host) host.addEventListener('keydown', (e) => {
    const el = e.target.closest('.lead-fitr.is-edit [data-fit]');
    if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); el.click(); }
  });
  if (host) host.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;   // contact icons / search links open themselves
    const fitBar = e.target.closest('.lead-fitr.is-edit [data-fit]');
    if (fitBar) {
      const id = fitBar.closest('[data-fit-id]').getAttribute('data-fit-id');
      setLeadFit(id, Number(fitBar.getAttribute('data-fit')));
      return;
    }
    const act = e.target.closest('[data-lead-nact]');
    if (act) {
      // the Next Action button: open the lead and do the thing
      if (!openLead(act.getAttribute('data-id'), 'overview')) return;
      const k = act.getAttribute('data-lead-nact');
      if (k === 'email') { openLeadCompose(); return; }
      if (k === 'quote') {
        if (leadDraft.linkedQuoteId) {
          state.openLeadId = null;
          state.openQuoteId = leadDraft.linkedQuoteId;
          location.hash = '#/quoteDocs';
        } else {
          createQuoteFromLead();
        }
        return;
      }
      render();
      return;
    }
    const r = e.target.closest('[data-open-lead]');
    if (!r) return;
    // the row's More button reads Less while its lead is open, and closes the side panel
    if (r.classList.contains('lead-more') && r.getAttribute('data-open-lead') === state.openLeadId) { state.openLeadId = null; render(); return; }
    if (openLead(r.getAttribute('data-open-lead'), 'overview')) render();
  });
}

function leadFromDoc(doc) {
  const b = blankLead(doc.type);
  Object.keys(b).forEach((k) => { if (doc[k] != null) b[k] = doc[k]; });
  b.rating = Math.max(0, Math.min(5, Math.round(doc.rating || 0)));
  b.stage = LEAD_STAGES[doc.stage] ? doc.stage : 'new';
  b.source = LEAD_SOURCES[doc.source] ? doc.source : 'manual';
  b.estValueCents = Math.max(0, Math.round(doc.estValueCents || 0));
  b.target = !!doc.target;
  // copies, so editing the draft never touches the live list until saved
  b.contacts = (Array.isArray(doc.contacts) ? doc.contacts : []).map((c) => ({ name: c.name || '', role: c.role || '', phone: c.phone || '', email: c.email || '' }));
  b.files = Array.isArray(doc.files) ? doc.files.slice() : [];
  b.history = Array.isArray(doc.history) ? doc.history.slice() : [];
  return b;
}

/* ---- the side panel: compact header + tabs, laid out like the mockup ---- */
const LEAD_OV_SVG = {
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14a6.5 6.5 0 0 1 3 6"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg>',
  money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 6.5c-1-1.3-2.8-2-5-2-2.8 0-4.5 1.4-4.5 3.3 0 4.5 10 2.3 10 7 0 2-1.8 3.4-5 3.4-2.4 0-4.3-.8-5.3-2.2"/></svg>',
  road: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  org: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 10h4a1 1 0 0 1 1 1v10M8 8h3M8 12h3M8 16h3M3 21h18"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16.5 9.5"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
};

function leadNeedItems(needs) {
  return String(needs || '')
    .split(/\s*(?:\/|,|\+|&|;|\||\band\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 1)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .slice(0, 8);
}

function leadOvItem(icon, value, label) {
  return `<div class="lead-ov-item"><span class="lead-ov-ico" aria-hidden="true">${icon}</span>
    <span class="lead-ov-txt"><strong>${value}</strong><em>${esc(label)}</em></span></div>`;
}

/*  "About the event": the opening of the research notes (they lead with
    what the event is), else the why-it-fits line.                        */
function leadAbout(r, doc) {
  const notes = String((doc && doc.enrichNotes) || '').trim();
  if (notes) {
    const parts = notes.match(/[^.!?]+[.!?]+/g) || [notes];
    let out = '';
    for (const p of parts) { if ((out + p).length > 230) break; out += p; }
    return (out || notes.slice(0, 230)).trim();
  }
  return '';
}

function leadOverviewHtml(r, doc) {
  const linkedQ = r.linkedQuoteId ? (state.quoteDocs || []).find((x) => x.id === r.linkedQuoteId) : null;
  const v = leadValue(r);
  const links = leadLinks(r);
  const web = links.find((l) => l.kind === 'web');
  const socials = links.filter((l) => l.kind !== 'web');
  const short = (x) => x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname.replace(/\/$/, '') : '');
  const a = (x, text) => `<a href="${attr(x.href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
  const phone = String(r.phone || '').trim();
  const email = String(r.email || '').trim();
  const contactBits = [
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? `<a href="mailto:${attr(email)}">${esc(email)}</a>` : '',
    phone ? `<a href="tel:${attr(phone.replace(/[^\d+]/g, ''))}">${esc(phone)}</a>` : '',
  ].filter(Boolean);
  const needs = leadNeedItems(r.needs);
  const socialNames = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };
  const dash = '<span class="lead-ov-none">—</span>';
  const fu = leadFollowState(r);
  const fuDate = /^\d{4}-\d{2}-\d{2}/.test(String(r.followUp || '')) ? fmtLeadDate(String(r.followUp).slice(0, 10)) : '';
  const about = leadAbout(r, doc);
  const eoi = leadEoi(r);

  return `
    <div class="lead-actions">
      <button type="button" class="lead-act is-primary" data-lead-act="email">✉ Prepare Outreach</button>
      <button type="button" class="lead-act" data-lead-act="quote">${linkedQ ? '▦ Open ' + esc(linkedQ.number || 'Quote') : '＋ Create Quote'}</button>
      <div class="lead-actions-row">
        <button type="button" class="lead-act" data-lead-act="ics"${leadHasExactDate(r) ? '' : ' disabled title="Needs an exact event date"'}>📅 Add to Calendar</button>
        <button type="button" class="lead-act" data-lead-act="won"${r.stage === 'won' ? ' disabled' : ''}>${r.stage === 'won' ? '🎉 Won' : '✓ Mark as Won'}</button>
        <span class="lead-more-wrap">
          <button type="button" class="lead-act lead-act-more" data-lead-act="more" aria-label="More actions" aria-haspopup="true">···</button>
          <span class="lead-more-menu" role="menu">
            <button type="button" role="menuitem" data-lead-act="delete">Delete lead</button>
          </span>
        </span>
      </div>
    </div>

    ${fuDate || r.nextAction || eoi ? `<div class="lead-next${fu === 'overdue' || (eoi && eoi.state === 'soon') ? ' is-overdue' : ''}">
      ${eoi ? `<p title="${attr(eoi.note)}"><strong>Supplier deadline:</strong> ${esc(fmtLeadDate(eoi.date))}${eoi.state === 'closed' ? ' (closed)' : eoi.state === 'soon' ? ` — ${eoi.days} day${eoi.days === 1 ? '' : 's'} left` : ''}${eoi.note ? ' · ' + esc(eoi.note) : ''}</p>` : ''}
      ${fuDate ? `<p><strong>Follow up:</strong> ${esc(fuDate)}${fu === 'overdue' ? ' <span class="lead-fu is-overdue">overdue</span>' : fu === 'due' ? ' <span class="lead-fu is-due">this week</span>' : ''}</p>` : ''}
      ${r.nextAction ? `<p class="lead-next-note" title="${attr(r.nextAction)}"><strong>Next step:</strong> ${esc(r.nextAction)}</p>` : ''}
    </div>` : ''}

    <h3 class="lead-sec">About the Event</h3>
    ${about ? `<p class="lead-about" title="${attr(about)}">${esc(about)}</p>` : ''}
    <div class="lead-ov-grid">
      <div>
        ${leadOvItem(LEAD_OV_SVG.users, r.crowd ? esc(r.crowd) : dash, 'Expected attendance')}
        ${v ? leadOvItem(LEAD_OV_SVG.money, v.src === 'quote' ? leadDollars(v.cents) + ' (quote)' : '~' + leadDollars(v.cents), 'Value') : ''}
        ${leadKmText(r) || r.haul ? leadOvItem(LEAD_OV_SVG.road, esc([leadKmText(r), r.haul].filter(Boolean).join(' · ')), 'From Bowen') : ''}
      </div>
      <div>
        ${leadOvItem(LEAD_OV_SVG.org, leadOrganiser(r) || r.decisionMaker ? esc(leadOrganiser(r) || r.decisionMaker) : dash, 'Organiser')}
        ${web || !socials.length ? leadOvItem(LEAD_SVG.web, web ? a(web.x, short(web.x)) : dash, 'Website') : ''}
        ${socials.length ? leadOvItem(LEAD_SVG[socials[0].kind] || LEAD_SVG.web, socials.map((s) => a(s.x, socialNames[s.kind] || 'Social')).join(' · '), 'Social media') : ''}
        ${leadOvItem(LEAD_SVG.mail, contactBits.length ? contactBits.join('<br>') : dash, 'Contact')}
      </div>
    </div>

    <h3 class="lead-sec">Why It Fits SoundzGood</h3>
    ${needs.length
      ? `<ul class="lead-fit">${needs.map((n) => `<li><span class="lead-fit-ico" aria-hidden="true">${LEAD_OV_SVG.check}</span>${esc(n)}</li>`).join('')}</ul>`
      : '<p class="lead-ov-empty">No requirements yet — add them under Details.</p>'}
    ${r.whyFit ? `<p class="lead-fit-why">${esc(r.whyFit)}</p>` : ''}

    ${[r.venueSetup, LEAD_POWER[r.power], r.recurrence, r.incumbent].some(Boolean) ? `<p class="lead-facts">
      ${r.venueSetup ? `<span title="Venue setup">🏟 ${esc(r.venueSetup)}</span>` : ''}
      ${LEAD_POWER[r.power] ? `<span class="is-power-${r.power}" title="Power">⚡ ${esc(LEAD_POWER[r.power])}</span>` : ''}
      ${r.recurrence ? `<span title="When it runs">🔁 ${esc(r.recurrence)}</span>` : ''}
      ${r.incumbent ? `<span title="${attr(r.incumbent)}">🎤 Supplier: ${esc(r.incumbent)}</span>` : ''}
    </p>` : ''}`;
}

/* ---- contacts: the main contact plus any number of others ---- */
function leadOtherContactsHtml(r) {
  const list = Array.isArray(r.contacts) ? r.contacts : [];
  return list.map((c, i) => `
      <div class="lead-oc">
        <div class="inv-fgrid">
          <label class="ad-field"><span>Name</span><input class="ad-input" data-lc-i="${i}" data-lc-f="name" value="${attr(c.name)}"></label>
          <label class="ad-field"><span>Role</span><input class="ad-input" data-lc-i="${i}" data-lc-f="role" value="${attr(c.role)}" placeholder="e.g. Secretary"></label>
          <label class="ad-field"><span>Phone</span><input class="ad-input" data-lc-i="${i}" data-lc-f="phone" value="${attr(c.phone)}"></label>
          <label class="ad-field"><span>Email</span><input class="ad-input" type="email" data-lc-i="${i}" data-lc-f="email" value="${attr(c.email)}"></label>
        </div>
        <button type="button" class="lead-oc-rm" data-lead-act="rmcontact" data-i="${i}" aria-label="Remove this contact">Remove</button>
      </div>`).join('') || '<p class="lead-ov-empty">No other contacts yet.</p>';
}

/* ---- history: the timeline ---- */
function leadHistoryHtml(r) {
  const items = leadTimeline(r);
  const past = r.lastEdition || r.recurrence
    ? `<div class="lead-lastyr">${r.lastEdition ? `<p><strong>Last edition:</strong> ${esc(r.lastEdition)}</p>` : ''}${r.recurrence ? `<p><strong>Runs:</strong> ${esc(r.recurrence)}</p>` : ''}</div>`
    : '';
  if (!items.length) return past + '<p class="lead-ov-empty">Nothing recorded yet.</p>';
  return past + `<ol class="lead-tl">${items.map((h) => {
    const d = new Date(h.at);
    const when = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
      + ' · ' + d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
    return `<li><span class="lead-tl-dot" aria-hidden="true"></span><div><strong>${esc(h.text)}</strong><em>${esc(when)}</em></div></li>`;
  }).join('')}</ol>`;
}

/* ---- files: briefs, maps, stage plots - private to the admin ---- */
function leadFileSize(n) {
  n = Number(n) || 0;
  return n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
}
function leadFilesHtml(r) {
  const files = Array.isArray(r.files) ? r.files : [];
  return `
      <label class="lead-upload">
        <input type="file" id="lead-file-input" multiple>
        <span>＋ Upload files</span>
      </label>
      <p class="lead-upload-hint">Event maps, briefs, stage plots, run sheets — up to 20 MB each. Only admins can see them.</p>
      <p class="ad-quote-msg" id="lead-file-msg"></p>
      ${files.length ? `<ul class="lead-files">${files.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).map((f) => `
        <li>
          <span class="lead-file-ico" aria-hidden="true">${LEAD_OV_SVG.file}</span>
          <span class="lead-file-txt">
            ${/^https:\/\//.test(String(f.url || '')) ? `<a href="${attr(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.name)}</a>` : esc(f.name)}
            <em>${esc(leadFileSize(f.size))} · ${esc(fmtLeadDate(new Date(f.at || 0).toISOString().slice(0, 10)))}</em>
          </span>
          <button type="button" class="lead-file-rm" data-lead-act="rmfile" data-path="${attr(f.path)}" aria-label="Delete ${attr(f.name)}">✕</button>
        </li>`).join('')}</ul>` : '<p class="lead-ov-empty">No files yet.</p>'}`;
}

async function uploadLeadFiles(fileList) {
  const id = state.openLeadId;
  const msg = document.getElementById('lead-file-msg');
  const say = (t, cls) => { if (msg) { msg.textContent = t; msg.className = 'ad-quote-msg' + (cls ? ' ' + cls : ''); } };
  if (!id || id === '__new__') { say('Save the lead first, then add files.', 'is-bad'); return; }
  const files = [...(fileList || [])];
  if (!files.length) return;
  const tooBig = files.filter((f) => f.size > 20 * 1024 * 1024);
  const ok = files.filter((f) => f.size <= 20 * 1024 * 1024);
  if (!ok.length) { say('Files must be under 20 MB.', 'is-bad'); return; }
  say(`Uploading ${ok.length} file${ok.length === 1 ? '' : 's'}…`);
  try {
    const { ref, uploadBytes, getDownloadURL } = fb.st;
    const added = [];
    for (const file of ok) {
      const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80);
      const path = `lead-files/${id}/${Date.now()}-${safe}`;
      await uploadBytes(ref(fb.storage, path), file, { contentType: file.type || 'application/octet-stream' });
      const url = await getDownloadURL(ref(fb.storage, path));
      added.push({ name: file.name.slice(0, 160), path, url, size: file.size, type: file.type || '', at: Date.now() });
    }
    const cur = (state.leads || []).find((x) => x.id === id);
    const all = [...((cur && cur.files) || []), ...added];
    const log = added.map((f, i) => ({ at: Date.now() + i, text: 'File added: ' + f.name }));
    const { doc, setDoc, arrayUnion } = fb.f;
    await setDoc(doc(fb.db, 'leads', id), { files: all, history: arrayUnion(...log), updatedAt: Date.now() }, { merge: true });
    if (cur) { cur.files = all; cur.history = [...(cur.history || []), ...log]; }
    leadDraft.files = all;
    leadDraft.history = cur ? cur.history : leadDraft.history;
    render();
    if (tooBig.length) say(`${tooBig.length} file${tooBig.length === 1 ? ' was' : 's were'} over 20 MB and skipped.`, 'is-bad');
  } catch (err) {
    say(err.message || 'Upload failed.', 'is-bad');
  }
}

async function deleteLeadFile(path) {
  const id = state.openLeadId;
  const cur = (state.leads || []).find((x) => x.id === id);
  const f = ((cur && cur.files) || []).find((x) => x.path === path);
  if (!f || !window.confirm(`Delete "${f.name}"? This cannot be undone.`)) return;
  try {
    const { ref, deleteObject } = fb.st;
    try { await deleteObject(ref(fb.storage, path)); } catch (e) { /* already gone */ }
    const all = cur.files.filter((x) => x.path !== path);
    const e = { at: Date.now(), text: 'File removed: ' + f.name };
    const { doc, setDoc, arrayUnion } = fb.f;
    await setDoc(doc(fb.db, 'leads', id), { files: all, history: arrayUnion(e), updatedAt: Date.now() }, { merge: true });
    cur.files = all;
    cur.history = [...(cur.history || []), e];
    leadDraft.files = all;
    leadDraft.history = cur.history;
    render();
  } catch (err) {
    const msg = document.getElementById('lead-file-msg');
    if (msg) { msg.textContent = err.message || 'Could not delete.'; msg.className = 'ad-quote-msg is-bad'; }
  }
}

/*  ☆ My Targets - saved straight away, it's a quick toggle. */
async function toggleLeadTarget() {
  leadDraft.target = !leadDraft.target;
  const btn = document.querySelector('.lead-target');
  if (btn) { btn.classList.toggle('is-on', leadDraft.target); btn.textContent = leadDraft.target ? '★' : '☆'; }
  const id = state.openLeadId;
  if (!id || id === '__new__') return;
  try {
    const { doc, setDoc } = fb.f;
    await setDoc(doc(fb.db, 'leads', id), { target: leadDraft.target, updatedAt: Date.now() }, { merge: true });
    const cur = (state.leads || []).find((x) => x.id === id);
    if (cur) cur.target = leadDraft.target;
    await leadLog(id, leadDraft.target ? 'Added to My Targets' : 'Removed from My Targets');
    renderLeadRows();
  } catch (err) {
    console.error('target', err);
  }
}

function leadDetailHtml() {
  const isNew = state.openLeadId === '__new__';
  const r = leadDraft;
  const doc = isNew ? null : (state.leads || []).find((x) => x.id === state.openLeadId);
  const type = LEAD_TYPES[r.type] ? r.type : 'production';
  const typeOpt = (v) => `<option value="${v}"${type === v ? ' selected' : ''}>${LEAD_TYPES[v]}</option>`;
  const srcOpt = (v) => `<option value="${v}"${r.source === v ? ' selected' : ''}>${LEAD_SOURCES[v]}</option>`;
  const stageOpt = (v) => `<option value="${v}"${r.stage === v ? ' selected' : ''}>${LEAD_STAGES[v]}</option>`;
  const quotes = (state.quoteDocs || []).filter((q) => q && q.number);
  const qOpt = (q) => `<option value="${attr(q.id)}"${r.linkedQuoteId === q.id ? ' selected' : ''}>${esc(q.number)}${q.customer && q.customer.name ? ' — ' + esc(q.customer.name) : ''}</option>`;
  const linkedQ = r.linkedQuoteId ? (state.quoteDocs || []).find((x) => x.id === r.linkedQuoteId) : null;
  const prio = leadPriority(r);
  const when = r.dateText || leadWhen(r);
  const where = r.venue || r.town || '';
  const recurring = /annual|recurring|seasonal|every|weekly|monthly/i.test(r.dateText || '');
  const est = r.estValueCents ? r.estValueCents / 100 : '';
  const nContacts = leadContactCount(r);
  const nFiles = (r.files || []).length;
  const tabs = isNew
    ? [['details', 'Details'], ['contacts', 'Contacts'], ['notes', 'Notes']]
    : [['overview', 'Overview'], ['details', 'Details'], ['contacts', `Contacts${nContacts ? ` (${nContacts})` : ''}`],
      ['history', 'History'], ['notes', 'Notes'], ['files', `Files${nFiles ? ` (${nFiles})` : ''}`]];
  const tab = tabs.some(([k]) => k === state.leadTab) ? state.leadTab : tabs[0][0];
  const pane = (k, html) => `<section class="lead-pane${tab === k ? ' is-on' : ''}" data-lead-pane="${k}" role="tabpanel">${html}</section>`;

  const details = `
      <div class="inv-fgrid">
        <label class="ad-field"><span>Type</span>
          <select class="ad-select" data-lf="type">${typeOpt('production')}${typeOpt('dj')}${typeOpt('venue')}</select></label>
        <label class="ad-field"><span>Stage</span>
          <select class="ad-select" data-lf="stage">${LEAD_STAGE_ORDER.map(stageOpt).join('')}</select></label>
        <label class="ad-field inv-span2"><span>Lead name / headline</span>
          <input class="ad-input" data-lf="title" value="${attr(r.title)}" placeholder="e.g. Airlie Beach Festival 2027, or The Reef Hotel"></label>
        <label class="ad-field inv-span2"><span>Event name</span>
          <input class="ad-input" data-lf="eventName" value="${attr(r.eventName)}" placeholder="What's on"></label>
        <label class="ad-field"><span>Date</span>
          <input class="ad-input" type="date" data-lf="eventDate" value="${attr(r.eventDate)}"></label>
        <label class="ad-field"><span>Date as listed</span>
          <input class="ad-input" data-lf="dateText" value="${attr(r.dateText)}" placeholder="e.g. Sat 10 Oct, gates 12pm"></label>
        <label class="ad-field inv-span2"><span>Start time(s)</span>
          <input class="ad-input" data-lf="startTime" value="${attr(r.startTime)}" placeholder="${attr(leadStartTime(r) ? 'auto: ' + leadStartTime(r) : 'e.g. Gates 5pm · main event 7pm')}"></label>
        <label class="ad-field"><span>Follow up on</span>
          <input class="ad-input" type="date" data-lf="followUp" value="${attr(r.followUp)}"></label>
        <label class="ad-field"><span>Last contacted</span>
          <input class="ad-input" type="date" data-lf="lastContacted" value="${attr(r.lastContacted)}"></label>
        <label class="ad-field inv-span2"><span>Next step (your note)</span>
          <input class="ad-input" data-lf="nextAction" value="${attr(r.nextAction)}" placeholder="e.g. Call the secretary about the 2027 season"></label>
        <label class="ad-field"><span>Expected attendance</span>
          <input class="ad-input" data-lf="crowd" value="${attr(r.crowd)}" placeholder="e.g. ~3,000"></label>
        <label class="ad-field"><span>Estimated value $</span>
          <input class="ad-input" type="number" min="0" step="100" data-lf="estValue" value="${attr(est)}" placeholder="e.g. 5000"></label>
        <label class="ad-field inv-span2"><span>Linked quote</span>
          <select class="ad-select" data-lf="linkedQuoteId">
            <option value="">— none —</option>
            ${quotes.map(qOpt).join('')}
          </select></label>
        ${linkedQ ? `<p class="lead-quote-note inv-span2">Quote ${esc(linkedQ.number || '')}: <strong>${leadDollars(linkedQ.totalCents)}</strong> — shown as the value instead of the estimate.</p>` : ''}
        <label class="ad-field"><span>Venue</span>
          <input class="ad-input" data-lf="venue" value="${attr(r.venue)}" placeholder="Where"></label>
        <label class="ad-field"><span>Town</span>
          <input class="ad-input" data-lf="town" value="${attr(r.town)}" placeholder="e.g. Airlie Beach"></label>
        <label class="ad-field inv-span2"><span>Likely requirements</span>
          <input class="ad-input" data-lf="needs" value="${attr(r.needs)}" placeholder="e.g. PA / stage / lighting / MC"></label>
        <label class="ad-field inv-span2"><span>Why it fits</span>
          <input class="ad-input" data-lf="whyFit" value="${attr(r.whyFit)}"></label>
        <label class="ad-field inv-span2"><span>Budget signals</span>
          <input class="ad-input" data-lf="budget" value="${attr(r.budget)}" placeholder="Ticketed? Sponsored? Council-backed?"></label>
        <label class="ad-field"><span>Category</span>
          <input class="ad-input" data-lf="category" value="${attr(r.category)}" list="lead-cat-list" placeholder="e.g. Race days"></label>
        <label class="ad-field"><span>Research heat</span>
          <select class="ad-select" data-lf="grokRating">
            <option value="">—</option>
            ${GROK_ORDER.map((g) => `<option value="${g}"${r.grokRating === g ? ' selected' : ''}>${g}</option>`).join('')}
          </select></label>
        <label class="ad-field"><span>Win chance %</span>
          <input class="ad-input" type="number" min="0" max="100" data-lf="winPct" value="${attr(r.winPct)}"></label>
        <label class="ad-field"><span>Haul from Bowen</span>
          <input class="ad-input" data-lf="haul" value="${attr(r.haul)}" placeholder="e.g. ~4 hr / 340 km"></label>
        <label class="ad-field"><span>Km from Bowen</span>
          <input class="ad-input" type="number" min="0" step="1" data-lf="km" value="${attr(r.km)}" placeholder="${attr(leadKm(r) == null ? 'e.g. 340' : 'auto: ' + leadKm(r))}"></label>
        <label class="ad-field inv-span2"><span>Current / previous supplier</span>
          <input class="ad-input" data-lf="incumbent" value="${attr(r.incumbent)}" placeholder="Who does their AV now, if known"></label>
        <label class="ad-field"><span>Supplier deadline (EOI / tender)</span>
          <input class="ad-input" type="date" data-lf="eoiDate" value="${attr(r.eoiDate)}"></label>
        <label class="ad-field"><span>Deadline note</span>
          <input class="ad-input" data-lf="eoiNote" value="${attr(r.eoiNote)}" placeholder="e.g. Council EOI via VendorPanel"></label>
        <label class="ad-field inv-span2"><span>Runs (recurring pattern)</span>
          <input class="ad-input" data-lf="recurrence" value="${attr(r.recurrence)}" placeholder="e.g. 2nd Saturday of October, every year"></label>
        <label class="ad-field inv-span2"><span>Last year's edition</span>
          <input class="ad-input" data-lf="lastEdition" value="${attr(r.lastEdition)}" placeholder="e.g. Sat 11 Oct 2025 · ~2,800 people · lineup: …"></label>
        <label class="ad-field"><span>Venue setup</span>
          <input class="ad-input" data-lf="venueSetup" value="${attr(r.venueSetup)}" placeholder="e.g. Outdoor showground, marquee"></label>
        <label class="ad-field"><span>Power</span>
          <select class="ad-select" data-lf="power">${[['', '—'], ['mains', 'Mains power on site'], ['generator', 'Generator needed'], ['unknown', 'Unknown']].map(([v, l]) => `<option value="${v}"${(r.power || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="ad-field inv-span2"><span>Ticket / listing link</span>
          <input class="ad-input" data-lf="ticketUrl" value="${attr(r.ticketUrl)}" placeholder="Eventbrite / Humanitix / etc."></label>
        <label class="ad-field inv-span2"><span>Photo link</span>
          <input class="ad-input" data-lf="imageUrl" value="${attr(r.imageUrl)}" placeholder="https://…  (on their site: right-click the photo → Copy image address)"></label>
        ${/fbcdn|cdninstagram|scontent\./i.test(r.imageUrl || '') ? '<p class="lead-quote-note inv-span2">Facebook / Instagram photo links expire within days on their own — use a photo from their website if you can.</p>' : ''}
      </div>
      <datalist id="lead-cat-list">${leadCategories().map((x) => `<option value="${attr(x)}">`).join('')}</datalist>`;

  const contacts = `
      ${isNew ? '' : leadContactIconsHtml(r)}
      <h4 class="lead-sub">Main contact</h4>
      <div class="inv-fgrid">
        <label class="ad-field inv-span2"><span>Organiser (club / committee / company)</span>
          <input class="ad-input" data-lf="organiser" value="${attr(r.organiser)}" placeholder="${attr(leadOrganiser(r) ? 'auto: ' + leadOrganiser(r) : 'e.g. Bowen Turf Club')}"></label>
        <label class="ad-field"><span>Contact person</span>
          <input class="ad-input" data-lf="contactName" value="${attr(r.contactName)}" placeholder="Who you deal with"></label>
        <label class="ad-field"><span>Decision maker</span>
          <input class="ad-input" data-lf="decisionMaker" value="${attr(r.decisionMaker)}"></label>
        <label class="ad-field"><span>Phone</span>
          <input class="ad-input" data-lf="phone" value="${attr(r.phone)}" placeholder="Mobile"></label>
        <label class="ad-field"><span>Email</span>
          <input class="ad-input" type="email" data-lf="email" value="${attr(r.email)}" placeholder="name@example.com"></label>
        <label class="ad-field inv-span2"><span>Website</span>
          <input class="ad-input" data-lf="website" value="${attr(r.website)}" placeholder="https://"></label>
        <label class="ad-field inv-span2"><span>Social media</span>
          <input class="ad-input" data-lf="socials" value="${attr(r.socials)}" placeholder="Facebook / Instagram links, or @handle"></label>
      </div>
      <h4 class="lead-sub">Other contacts</h4>
      <div id="lead-oc-list">${leadOtherContactsHtml(r)}</div>
      <button type="button" class="lead-act lead-act-wide lead-oc-add" data-lead-act="addcontact">＋ Add another contact</button>`;

  const notes = `
      ${leadResearchHtml(doc)}
      <label class="ad-field"><span>Your notes</span>
        <textarea class="ad-input lead-notes" rows="6" data-lf="notes" placeholder="Anything worth remembering...">${esc(r.notes)}</textarea></label>
      <div class="inv-fgrid lead-notes-src">
        <label class="ad-field"><span>Source</span>
          <select class="ad-select" data-lf="source">${srcOpt('manual')}${srcOpt('auto')}${srcOpt('website')}${srcOpt('directory')}</select></label>
        <label class="ad-field"><span>Source link</span>
          <input class="ad-input" data-lf="sourceUrl" value="${attr(r.sourceUrl)}" placeholder="Where you found it"></label>
      </div>`;

  return `
    <aside class="inv-detail lead-detail" aria-label="Lead details">
      <div class="lead-hero ${leadCatStyle(r)[1]}">
        <span class="lead-hero-ico" aria-hidden="true">${leadCatStyle(r)[0]}</span>
        ${!isNew && !r.imageBroken && leadImageUrl(r) ? `<img class="lead-hero-img" src="${attr(leadImageUrl(r))}" alt="" referrerpolicy="no-referrer" data-lead-img="${attr(state.openLeadId)}">` : ''}
        ${isNew ? '' : `<span class="lead-prio is-${prio}">${LEAD_PRIO_LABEL[prio]} priority</span>`}
        <button type="button" class="lead-hero-close" id="lead-close" aria-label="Close">&times;</button>
      </div>

      <div class="lead-dhead">
        <div class="lead-dtitle">
          <h2>${isNew ? 'New lead' : esc(r.title || r.contactName || 'Lead')}</h2>
          <button type="button" class="lead-target${r.target ? ' is-on' : ''}" data-lead-act="target" title="My Targets" aria-pressed="${!!r.target}" aria-label="Add to My Targets">${r.target ? '★' : '☆'}</button>
        </div>
        ${!isNew && (when || where) ? `<p class="lead-dmeta">
          ${when ? `<span><span class="lead-ico" aria-hidden="true">📅</span>${esc(when)}</span>` : ''}
          ${where ? `<span><span class="lead-ico" aria-hidden="true">📍</span>${esc(where)}</span>` : ''}</p>` : ''}
        ${!isNew ? `<div class="lead-dtags">
          ${recurring ? '<span class="lead-cat is-recur">Recurring event</span>' : ''}
          ${r.category ? `<span class="lead-cat">${esc(r.category)}</span>` : `<span class="lead-cat is-type">${esc(LEAD_TYPES[type])}</span>`}
          ${leadStagePill2(r.stage)}
          ${r.grokRating ? `${grokPill(r.grokRating)}${r.winPct ? `<span class="lead-win">${esc(r.winPct)}% win</span>` : ''}` : ''}
          ${leadNeedsContact(r) ? '<span class="lead-flag">Needs contact</span>' : ''}
          ${r.imageBroken ? '<span class="lead-flag is-stale" title="Their photo link stopped working - they have probably updated their site. Queued for the research to re-check.">⚠ Photo gone — may be out of date</span>' : ''}
          ${doc && doc.enrichedAt ? `<button type="button" class="lead-research-pill ${(LEAD_CHECK[doc.contactCheck] || LEAD_CHECK.partial)[0]}" data-lead-tab="notes" title="Researched ${attr(fmtLeadDate(String(doc.enrichedAt).slice(0, 10)))} — open notes &amp; sources">🔎 ${esc((LEAD_CHECK[doc.contactCheck] || LEAD_CHECK.partial)[1])}</button>` : ''}
          <span class="lead-dfit">${leadFitRater(r.rating, true, state.openLeadId)}</span>
        </div>` : `<div class="lead-drate"><span>Fit</span>${leadFitRater(r.rating, true, '')}</div>`}
      </div>

      <nav class="lead-tabs" role="tablist" aria-label="Lead sections">
        ${tabs.map(([k, label]) => `<button type="button" role="tab" class="lead-tab${tab === k ? ' is-on' : ''}" data-lead-tab="${k}" aria-selected="${tab === k}">${label}</button>`).join('')}
      </nav>

      <div class="lead-panes">
        ${isNew ? '' : pane('overview', leadOverviewHtml(r, doc))}
        ${pane('details', details)}
        ${pane('contacts', contacts)}
        ${isNew ? '' : pane('history', leadHistoryHtml(doc || r))}
        ${pane('notes', notes)}
        ${isNew ? '' : pane('files', leadFilesHtml(r))}
      </div>

      <footer class="inv-detail-foot">
        <span class="ad-quote-msg" id="lead-msg"></span>
        <button type="button" class="ad-btn ad-btn-primary" id="lead-save">${isNew ? 'Add lead' : 'Save changes'}</button>
      </footer>
    </aside>`;
}

function wireLeadDetail() {
  const panel = document.querySelector('.lead-detail');
  if (!panel) return;
  const doc = (state.leads || []).find((x) => x.id === state.openLeadId);

  const close = document.getElementById('lead-close');
  if (close) close.addEventListener('click', () => { state.openLeadId = null; render(); });

  const showTab = (k) => {
    state.leadTab = k;
    panel.querySelectorAll('.lead-tab[data-lead-tab]').forEach((b) => {
      const on = b.getAttribute('data-lead-tab') === k;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', String(on));
    });
    panel.querySelectorAll('[data-lead-pane]').forEach((p) => p.classList.toggle('is-on', p.getAttribute('data-lead-pane') === k));
    // the Overview is a read-out of the draft, so redraw it with any edits
    if (k === 'overview') {
      const ov = panel.querySelector('[data-lead-pane="overview"]');
      if (ov) ov.innerHTML = leadOverviewHtml(leadDraft, doc);
    }
    panel.scrollTop = 0;
  };
  const contactsTabLabel = () => {
    const t = panel.querySelector('.lead-tab[data-lead-tab="contacts"]');
    const n = leadContactCount(leadDraft);
    if (t) t.textContent = 'Contacts' + (n ? ` (${n})` : '');
  };

  panel.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.lcI != null) {
      const c = leadDraft.contacts[Number(t.dataset.lcI)];
      if (c) c[t.dataset.lcF] = t.value;
      return;
    }
    if (!t.dataset.lf) return;
    if (t.dataset.lf === 'estValue') leadDraft.estValueCents = Math.max(0, Math.round(Number(t.value || 0) * 100));
    else leadDraft[t.dataset.lf] = t.value;
    if (t.dataset.lf === 'contactName' || t.dataset.lf === 'phone' || t.dataset.lf === 'email') contactsTabLabel();
  });
  panel.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'lead-file-input') { uploadLeadFiles(t.files); t.value = ''; return; }
    if (t.dataset.lf === 'linkedQuoteId') {
      leadDraft.linkedQuoteId = t.value;
      const q = (state.quoteDocs || []).find((x) => x.id === t.value);
      leadDraft.linkedQuoteNumber = q ? (q.number || '') : '';
      render();
    } else if (t.dataset.lf === 'type') {
      leadDraft.type = t.value;
    }
  });

  // keyboard: Enter / Space on a Fit bar sets it
  panel.addEventListener('keydown', (e) => {
    const el = e.target.closest('.lead-fitr.is-edit [data-fit]');
    if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); el.click(); }
  });

  panel.addEventListener('click', (e) => {
    const fitBar = e.target.closest('.lead-fitr.is-edit [data-fit]');
    if (fitBar) {
      const n = Number(fitBar.getAttribute('data-fit'));
      if (state.openLeadId && state.openLeadId !== '__new__') { setLeadFit(state.openLeadId, n); return; }
      // a new lead: just the draft, saved with the lead
      leadDraft.rating = Math.round(leadDraft.rating || 0) === n ? n - 1 : n;
      const holder = fitBar.closest('.lead-fitr');
      if (holder) holder.outerHTML = leadFitRater(leadDraft.rating, true, '');
      return;
    }
    const tabBtn = e.target.closest('[data-lead-tab]');
    if (tabBtn) { showTab(tabBtn.getAttribute('data-lead-tab')); return; }
    const menu = panel.querySelector('.lead-more-menu');
    const act = e.target.closest('[data-lead-act]');
    if (!act || act.disabled) { if (menu) menu.classList.remove('is-open'); return; }
    const what = act.getAttribute('data-lead-act');
    if (what !== 'more' && menu) menu.classList.remove('is-open');
    if (what === 'email') openLeadCompose();
    else if (what === 'ics') leadIcsDownload(leadDraft, state.openLeadId);
    else if (what === 'won') { leadDraft.stage = 'won'; saveLead(act); }
    else if (what === 'more') { if (menu) menu.classList.toggle('is-open'); }
    else if (what === 'delete') deleteLead(act);
    else if (what === 'target') toggleLeadTarget();
    else if (what === 'rmfile') deleteLeadFile(act.getAttribute('data-path'));
    else if (what === 'addcontact' || what === 'rmcontact') {
      leadDraft.contacts = Array.isArray(leadDraft.contacts) ? leadDraft.contacts : [];
      if (what === 'addcontact') leadDraft.contacts.push({ name: '', role: '', phone: '', email: '' });
      else leadDraft.contacts.splice(Number(act.getAttribute('data-i')), 1);
      const list = panel.querySelector('#lead-oc-list');
      if (list) list.innerHTML = leadOtherContactsHtml(leadDraft);
      contactsTabLabel();
      if (what === 'addcontact') { const first = panel.querySelector('#lead-oc-list .lead-oc:last-child input'); if (first) first.focus(); }
    } else if (what === 'quote') {
      if (leadDraft.linkedQuoteId) {
        state.openLeadId = null;
        state.openQuoteId = leadDraft.linkedQuoteId;
        location.hash = '#/quoteDocs';
      } else {
        createQuoteFromLead();
      }
    }
  });

  const save = document.getElementById('lead-save');
  if (save) save.addEventListener('click', () => saveLead(save));
}

function leadClean(r) {
  const type = LEAD_TYPES[r.type] ? r.type : 'production';
  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  return {
    type,
    title: s(r.title, 160), contactName: s(r.contactName, 120),
    phone: s(r.phone, 40), email: s(r.email, 200), website: s(r.website, 300), socials: s(r.socials, 500),
    eventName: s(r.eventName, 200), eventDate: s(r.eventDate, 20), venue: s(r.venue, 160), town: s(r.town, 80), crowd: s(r.crowd, 80),
    source: LEAD_SOURCES[r.source] ? r.source : 'manual', sourceUrl: s(r.sourceUrl, 500), ticketUrl: s(r.ticketUrl, 500),
    budget: s(r.budget, 300), needs: s(r.needs, 500),
    rating: Math.max(0, Math.min(5, Math.round(r.rating || 0))),
    stage: LEAD_STAGES[r.stage] ? r.stage : 'new',
    linkedQuoteId: s(r.linkedQuoteId, 60), linkedQuoteNumber: s(r.linkedQuoteNumber, 40),
    lastContacted: s(r.lastContacted, 20), notes: s(r.notes, 6000),
    dateText: s(r.dateText, 120),
    category: s(r.category, 80),
    grokRating: GROK_PILL[r.grokRating] ? r.grokRating : '',
    winPct: s(r.winPct, 4),
    nextAction: s(r.nextAction, 1000), incumbent: s(r.incumbent, 1000),
    haul: s(r.haul, 120), whyFit: s(r.whyFit, 1000), decisionMaker: s(r.decisionMaker, 300),
    importBatch: s(r.importBatch, 60),
    estValueCents: Math.max(0, Math.round(Number(r.estValueCents) || 0)),
    followUp: /^\d{4}-\d{2}-\d{2}$/.test(s(r.followUp, 10)) ? s(r.followUp, 10) : '',
    target: !!r.target,
    organiser: s(r.organiser, 160), startTime: s(r.startTime, 120),
    imageUrl: /^https?:\/\//i.test(s(r.imageUrl, 1000)) ? s(r.imageUrl, 1000) : '',
    eoiDate: /^\d{4}-\d{2}-\d{2}$/.test(s(r.eoiDate, 10)) ? s(r.eoiDate, 10) : '', eoiNote: s(r.eoiNote, 300),
    recurrence: s(r.recurrence, 160), lastEdition: s(r.lastEdition, 400), venueSetup: s(r.venueSetup, 200),
    power: ['mains', 'generator', 'unknown'].includes(r.power) ? r.power : '',
    km: String(r.km == null ? '' : r.km).trim() === '' ? '' : Math.max(0, Math.round(Number(r.km) || 0)),
    contacts: (Array.isArray(r.contacts) ? r.contacts : [])
      .map((c) => ({ name: s(c.name, 120), role: s(c.role, 80), phone: s(c.phone, 40), email: s(c.email, 200) }))
      .filter((c) => c.name || c.phone || c.email)
      .slice(0, 12),
    updatedAt: Date.now(),
  };
}

/*  What changed, in words, for the History timeline. */
function leadChanges(prev, next) {
  if (!prev) return ['Lead added'];
  const out = [];
  const st = (x) => LEAD_STAGES[x || 'new'] || x;
  if ((prev.stage || 'new') !== next.stage) out.push(`Stage: ${st(prev.stage)} → ${st(next.stage)}`);
  if ((prev.followUp || '') !== next.followUp) out.push(next.followUp ? `Follow-up set for ${fmtLeadDate(next.followUp)}` : 'Follow-up cleared');
  if (Math.round(prev.rating || 0) !== next.rating) out.push(next.rating ? `Fit set to ${next.rating}/5` : 'Fit cleared');
  if ((prev.linkedQuoteId || '') !== next.linkedQuoteId && next.linkedQuoteId) out.push(`Quote ${next.linkedQuoteNumber || ''} linked`);
  const pc = (prev.contacts || []).length;
  if (pc !== next.contacts.length) out.push(next.contacts.length > pc ? 'Contact added' : 'Contact removed');
  if ((prev.email || '') !== next.email || (prev.phone || '') !== next.phone) out.push('Contact details updated');
  if ((prev.lastContacted || '') !== next.lastContacted && next.lastContacted) out.push(`Marked contacted on ${fmtLeadDate(next.lastContacted)}`);
  if ((prev.imageUrl || '') !== next.imageUrl) out.push(next.imageUrl ? 'Photo link updated' : 'Photo link removed');
  if ((prev.eoiDate || '') !== next.eoiDate && next.eoiDate) out.push(`Supplier deadline noted: ${fmtLeadDate(next.eoiDate)}`);
  return out;
}

async function saveLead(btn) {
  const msg = document.getElementById('lead-msg');
  const r = leadDraft;
  if (!String(r.title || '').trim() && !String(r.contactName || '').trim()) {
    if (msg) { msg.textContent = 'Give it a name or a contact first.'; msg.className = 'ad-quote-msg is-bad'; }
    return;
  }
  const clean = leadClean(r);
  if (msg) { msg.textContent = 'Saving…'; msg.className = 'ad-quote-msg'; }
  if (btn) btn.disabled = true;
  try {
    const { collection, doc, setDoc, addDoc, arrayUnion } = fb.f;
    state.leads = state.leads || [];
    const isNew = state.openLeadId === '__new__';
    const prev = isNew ? null : state.leads.find((x) => x.id === state.openLeadId);
    if (!prev || (prev.imageUrl || '') !== clean.imageUrl) clean.imageBroken = false;   // a new link gets a fresh chance
    const log = leadChanges(prev, clean).map((text, i) => ({ at: Date.now() + i, text }));
    if (isNew) {
      clean.createdAt = Date.now();
      clean.history = log;
      const ref = await addDoc(collection(fb.db, 'leads'), clean);
      state.openLeadId = ref.id;
      state.leads.push({ id: ref.id, ...clean });
      if (state.leadTab === 'details') state.leadTab = 'overview';
    } else {
      const id = state.openLeadId;
      const payload = { ...clean };
      if (log.length) payload.history = arrayUnion(...log);
      await setDoc(doc(fb.db, 'leads', id), payload, { merge: true });
      const cur = state.leads.find((x) => x.id === id);
      if (cur) { Object.assign(cur, clean); cur.history = [...(cur.history || []), ...log]; }
      else state.leads.push({ id, ...clean, history: log });
    }
    if (msg) { msg.textContent = 'Saved.'; msg.className = 'ad-quote-msg is-ok'; }
    render();
  } catch (err) {
    if (msg) { msg.textContent = err.message || 'Could not save.'; msg.className = 'ad-quote-msg is-bad'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteLead(btn) {
  if (!window.confirm('Delete this lead? This cannot be undone.')) return;
  const id = state.openLeadId;
  if (id === '__new__') { state.openLeadId = null; render(); return; }
  if (btn) btn.disabled = true;
  try {
    const { doc, deleteDoc } = fb.f;
    await deleteDoc(doc(fb.db, 'leads', id));
    state.leads = (state.leads || []).filter((x) => x.id !== id);
    state.openLeadId = null;
    render();
  } catch (err) {
    const msg = document.getElementById('lead-msg');
    if (msg) { msg.textContent = err.message || 'Could not delete.'; msg.className = 'ad-quote-msg is-bad'; }
    if (btn) btn.disabled = false;
  }
}

/* ---- email composer: draft + send, never auto-send ---- */
function openLeadCompose() {
  const r = leadDraft;
  if (!String(r.email || '').trim()) {
    const msg = document.getElementById('lead-msg');
    if (msg) { msg.textContent = 'Add an email address first.'; msg.className = 'ad-quote-msg is-bad'; }
    return;
  }
  const who = (r.contactName || '').trim().split(/\s+/)[0] || 'there';
  const ev = r.eventName || r.title || 'your event';
  const subject = `SoundzGood Whitsundays — ${r.eventName || r.title || 'your event'}`;
  const body =
`Hi ${who},

I'm Max from SoundzGood Whitsundays — we do sound, lighting, staging and DJ/entertainment for events around the Whitsundays and beyond.

I came across ${ev} and wanted to see whether you've got your audio/production sorted. We're local, reliable, and can put together a package to suit whatever you're planning.

If you'd like a quick quote or a chat, just reply here or give me a call.

Cheers,
Max
SoundzGood Whitsundays
www.soundzgood.com.au`;
  state.leadCompose = { to: r.email.trim(), subject, body, leadId: state.openLeadId };
  render();
}

function leadComposeHtml() {
  const c = state.leadCompose;
  return `
    <div class="lead-compose-back" id="lead-compose-back">
      <div class="lead-compose" role="dialog" aria-label="Email lead">
        <header class="lead-compose-head">
          <h3>Email lead</h3>
          <button type="button" class="inv-detail-close" id="lead-compose-close" aria-label="Close">&times;</button>
        </header>
        <div class="lead-compose-body">
          <label class="ad-field"><span>To</span><input class="ad-input" id="lc-to" value="${attr(c.to)}"></label>
          <label class="ad-field"><span>Subject</span><input class="ad-input" id="lc-subject" value="${attr(c.subject)}"></label>
          <label class="ad-field"><span>Message</span><textarea class="ad-input" id="lc-body" rows="12">${esc(c.body)}</textarea></label>
          <p class="lead-compose-note">Sends from bookings@soundzgood.com.au. Nothing goes out until you press Send.</p>
        </div>
        <footer class="lead-compose-foot">
          <button type="button" class="ad-btn" id="lc-cancel">Cancel</button>
          <button type="button" class="ad-btn ad-btn-primary" id="lc-send">Send email</button>
          <span class="ad-quote-msg" id="lc-msg"></span>
        </footer>
      </div>
    </div>`;
}

function wireLeadCompose() {
  const close = () => { state.leadCompose = null; render(); };
  const x = document.getElementById('lead-compose-close');
  const cancel = document.getElementById('lc-cancel');
  const back = document.getElementById('lead-compose-back');
  if (x) x.addEventListener('click', close);
  if (cancel) cancel.addEventListener('click', close);
  if (back) back.addEventListener('click', (e) => { if (e.target === back) close(); });

  const send = document.getElementById('lc-send');
  if (send) send.addEventListener('click', async () => {
    const to = (document.getElementById('lc-to').value || '').trim();
    const subject = (document.getElementById('lc-subject').value || '').trim();
    const body = document.getElementById('lc-body').value || '';
    const msg = document.getElementById('lc-msg');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { if (msg) { msg.textContent = 'That email does not look right.'; msg.className = 'ad-quote-msg is-bad'; } return; }
    if (!subject || !body.trim()) { if (msg) { msg.textContent = 'Add a subject and a message.'; msg.className = 'ad-quote-msg is-bad'; } return; }
    if (msg) { msg.textContent = 'Sending…'; msg.className = 'ad-quote-msg'; }
    send.disabled = true;
    try {
      await call('sendLeadEmail', { to, subject, body, leadId: state.leadCompose.leadId || '' });
      // record that we made contact: stamp the date and nudge the stage forward
      const today = new Date().toISOString().slice(0, 10);
      leadDraft.lastContacted = today;
      if (leadDraft.stage === 'new') leadDraft.stage = 'contacted';
      const id = state.leadCompose.leadId;
      if (id && id !== '__new__') {
        const { doc, setDoc } = fb.f;
        await setDoc(doc(fb.db, 'leads', id), { lastContacted: today, stage: leadDraft.stage, updatedAt: Date.now() }, { merge: true });
        const cur = (state.leads || []).find((x) => x.id === id);
        if (cur) { cur.lastContacted = today; cur.stage = leadDraft.stage; }
        await leadLog(id, `Outreach email sent to ${to} — “${subject}”`);
      }
      state.leadCompose = null;
      render();
      const m2 = document.getElementById('lead-msg');
      if (m2) { m2.textContent = 'Email sent.'; m2.className = 'ad-quote-msg is-ok'; }
    } catch (err) {
      if (msg) { msg.textContent = (err && err.message) || 'Could not send.'; msg.className = 'ad-quote-msg is-bad'; }
      send.disabled = false;
    }
  });
}

/* =========================================================================
   LEAD RATING — a phone-sized card deck for rating every lead quickly.
   Only Max's own Fit rating (1-5) counts here; imported heat / win % are
   not shown. Rate, then an action:
     Won        -> stage Won
     More info  -> queued for the nightly research (needsResearch), leaves
                   the deck until the research is done
     Locked     -> tagged "Locked - another supplier" (verdict)
     Pass       -> tagged "Not for us" (verdict)
     Next       -> saves the rating if one is picked, else skips for now
   Nothing is ever hidden or deleted: Pass / Locked are tags only.
   ========================================================================= */
const LEAD_VERDICT = { pass: 'Not for us', locked: 'Locked — another supplier' };

function rateState() {
  if (!state.rate) state.rate = { tab: 'review', pick: 0, skip: [], back: [], focus: '', busy: false };
  return state.rate;
}
function rateSortKey(r) {
  const d = leadSortDate(r);
  // upcoming soonest first, then undated, then past events
  if (!d) return '1';
  return (d < leadTodayIso() ? '2' : '0') + d;
}
function rateDeck() {
  const s = rateState();
  const list = (state.leads || []).filter((r) => !Number(r.rating) && !r.needsResearch)
    .sort((a, b) => rateSortKey(a).localeCompare(rateSortKey(b)) || String(a.title || '').localeCompare(String(b.title || '')));
  // "Next" without a rating sends a lead to the back for this session
  const skipped = list.filter((r) => s.skip.includes(r.id));
  return list.filter((r) => !s.skip.includes(r.id)).concat(skipped);
}
function rateWaiting() { return (state.leads || []).filter((r) => r.needsResearch); }
function rateRated() { return (state.leads || []).filter((r) => Number(r.rating)).sort((a, b) => rateSortKey(a).localeCompare(rateSortKey(b))); }

function rateMissing(r) {
  const miss = [];
  if (!leadHasExactDate(r)) miss.push('Exact date');
  if (leadNeedsContact(r)) miss.push('Contact');
  if (!String(r.website || '').trim()) miss.push('Website');
  if (!String(r.crowd || '').trim()) miss.push('Crowd size');
  return miss;
}

function rateCardHtml(r, pos, total) {
  const s = rateState();
  const [icon, cls] = leadCatStyle(r);
  const img = r.imageBroken ? '' : leadImageUrl(r);
  const when = leadWhen(r) || 'Date TBC';
  const where = r.venue || r.town || '';
  const km = leadKmText(r);
  const v = leadValue(r);
  const org = leadOrganiser(r);
  const about = String(r.whyFit || r.needs || r.enrichNotes || r.notes || '').split('\n— Earlier')[0].trim();
  const facts = [
    ['Organiser', org], ['Crowd', r.crowd], ['Needs', r.needs], ['Venue setup', r.venueSetup],
    ['Power', r.power && r.power !== 'unknown' ? (r.power === 'generator' ? 'Generator needed' : 'Mains on site') : ''],
    ['Runs', r.recurrence], ['Last year', r.lastEdition], ['Supplier now', r.incumbent],
    ['Supplier deadline', r.eoiDate ? fmtLeadDate(r.eoiDate) + (r.eoiNote ? ' — ' + r.eoiNote : '') : ''],
  ].filter(([, x]) => String(x || '').trim());
  const miss = rateMissing(r);
  const pick = s.pick || Number(r.rating) || 0;
  const tags = [
    r.category ? `<span class="rt-chip">${esc(r.category)}</span>` : '',
    r.stage === 'won' ? '<span class="rt-chip is-won">🏆 Won</span>' : '',
    r.verdict ? `<span class="rt-chip is-verdict">${esc(LEAD_VERDICT[r.verdict] || r.verdict)}</span>` : '',
    r.needsResearch ? '<span class="rt-chip is-info">Waiting on research</span>' : '',
  ].join('');
  return `
    <article class="rt-card" data-rate-id="${attr(r.id)}">
      <div class="rt-hero ${cls}">
        ${img ? `<img src="${attr(img)}" alt="" referrerpolicy="no-referrer" data-lead-img="${attr(r.id)}">` : `<span class="rt-hero-ico" aria-hidden="true">${icon}</span>`}
        ${total ? `<span class="rt-count">${pos} of ${total}</span>` : ''}
        <div class="rt-hero-text">
          <h2>${esc(r.title || r.eventName || 'Lead')}</h2>
          <p>📅 ${esc(when)}</p>
          ${where ? `<p>📍 ${esc(where)}${km ? ` <span>· ${esc(km)}</span>` : ''}</p>` : (km ? `<p>🚚 ${esc(km)}</p>` : '')}
        </div>
      </div>
      <div class="rt-body">
        ${tags.trim() ? `<div class="rt-chips">${tags}</div>` : ''}
        <div class="rt-stats">
          <div><b>${esc(r.crowd || '—')}</b><span>Expected crowd</span></div>
          <div><b>${v ? leadDollars(v.cents) : '—'}</b><span>${v && v.src === 'quote' ? 'Quote value' : 'Est. value'}</span></div>
        </div>
        <div class="rt-links">${leadWebIconsHtml(r)}${leadContactIconsHtml(r)}</div>
        ${about ? `<p class="rt-about">${esc(about.length > 320 ? about.slice(0, 317) + '…' : about)}</p>` : ''}
        ${facts.length ? `<dl class="rt-facts">${facts.map(([k, x]) => `<div><dt>${esc(k)}</dt><dd>${esc(x)}</dd></div>`).join('')}</dl>` : ''}
        ${miss.length ? `<p class="rt-miss">Missing: ${miss.map(esc).join(' · ')}</p>` : ''}
        <button type="button" class="rt-open" data-rate-open="${attr(r.id)}">Open full lead ›</button>
      </div>
    </article>
    <div class="rt-rate">
      <p>Rate this lead <span>(1 = low, 5 = high fit)</span></p>
      <div class="rt-bar" role="radiogroup" aria-label="Fit rating">
        ${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="${pick === n}" class="rt-seg${n <= pick ? ' is-fill' : ''}${n === pick ? ' is-on' : ''}" data-rate-pick="${n}">${n}</button>`).join('')}
      </div>
    </div>
    <div class="rt-acts">
      <button type="button" class="rt-act is-won" data-rate-act="won"><i>🏆</i>Won</button>
      <button type="button" class="rt-act is-info" data-rate-act="info"><i>?</i>More info</button>
      <button type="button" class="rt-act is-locked" data-rate-act="locked"><i>🔒</i>Locked</button>
      <button type="button" class="rt-act is-pass" data-rate-act="pass"><i>✕</i>Pass</button>
      <button type="button" class="rt-act is-next" data-rate-act="next"><i>»</i>Next</button>
    </div>
    <p class="rt-hint" id="rt-hint">${pick ? 'Now pick an action' : 'Choose a rating, then an action'}</p>`;
}

function rateListHtml(rows, empty) {
  if (!rows.length) return `<p class="rt-empty">${empty}</p>`;
  return `<ul class="rt-list">${rows.map((r) => `
    <li><button type="button" data-rate-focus="${attr(r.id)}">
      <span class="rt-li-t">${esc(r.title || 'Lead')}</span>
      <span class="rt-li-m">${esc(leadWhen(r) || 'Date TBC')}${Number(r.rating) ? ` · Fit ${Number(r.rating)}/5` : ''}${r.verdict ? ' · ' + esc(LEAD_VERDICT[r.verdict] || '') : ''}${r.stage === 'won' ? ' · 🏆 Won' : ''}</span>
    </button></li>`).join('')}</ul>`;
}

function leadRateHtml() {
  const s = rateState();
  const deck = rateDeck();
  const all = (state.leads || []).length;
  const rated = rateRated();
  const waiting = rateWaiting();
  const pct = all ? Math.round((rated.length / all) * 100) : 0;
  const focus = s.focus && (state.leads || []).find((x) => x.id === s.focus);
  let body;
  if (focus) {
    body = `<button type="button" class="rt-backlist" data-rate-unfocus>‹ Back to list</button>${rateCardHtml(focus, 0, 0)}`;
  } else if (s.tab === 'review') {
    body = deck.length ? rateCardHtml(deck[0], 1, deck.length) : '<p class="rt-empty">🎉 Every lead is rated. New leads and researched ones will show up here.</p>';
  } else if (s.tab === 'waiting') {
    body = rateListHtml(waiting, 'Nothing waiting — tap "More info" on a lead to queue it for the nightly research.');
  } else {
    body = rateListHtml(rated, 'No leads rated yet.');
  }
  return `
    <div class="rt-wrap">
      <div class="rt-phone">
        <div class="rt-top">
          ${s.back.length && !focus && s.tab === 'review' ? '<button type="button" class="rt-prev" data-rate-prev aria-label="Previous lead">‹</button>' : ''}
          <nav class="rt-tabs">
            ${[['review', 'Review', deck.length], ['waiting', 'More info', waiting.length], ['rated', 'Rated', rated.length]]
              .map(([k, label, n]) => `<button type="button" class="rt-tab${s.tab === k && !focus ? ' is-on' : ''}" data-rate-tab="${k}">${label} <span>${n}</span></button>`).join('')}
          </nav>
        </div>
        <div class="rt-prog"><span>${deck.length} left to review</span><span>${rated.length} of ${all} rated · ${pct}%</span></div>
        <div class="rt-progbar"><i style="width:${pct}%"></i></div>
        ${body}
      </div>
    </div>`;
}

async function rateSave(r, patchData, logText) {
  const s = rateState();
  s.busy = true;
  try {
    const e = { at: Date.now(), text: logText };
    const { doc, setDoc, arrayUnion } = fb.f;
    const data = { ...patchData, updatedAt: Date.now(), history: arrayUnion(e) };
    await setDoc(doc(fb.db, 'leads', r.id), data, { merge: true });
    Object.assign(r, patchData);
    r.history = [...(r.history || []), e];
  } catch (err) {
    console.error('rate save', err);
    const h = document.getElementById('rt-hint');
    if (h) { h.textContent = 'Could not save — check your connection.'; h.classList.add('is-bad'); }
    s.busy = false;
    return false;
  }
  s.busy = false;
  return true;
}

async function rateAct(act) {
  const s = rateState();
  if (s.busy) return;
  const id = (document.querySelector('.rt-card') || {}).getAttribute && document.querySelector('.rt-card').getAttribute('data-rate-id');
  const r = id && (state.leads || []).find((x) => x.id === id);
  if (!r) return;
  const pick = s.pick || 0;
  const hint = document.getElementById('rt-hint');
  if (['won', 'locked', 'pass'].includes(act) && !pick && !Number(r.rating)) {
    if (hint) { hint.textContent = 'Pick a rating (1–5) first'; hint.classList.add('is-bad'); }
    return;
  }
  const patchData = {};
  const log = [];
  if (pick && pick !== Number(r.rating)) { patchData.rating = pick; log.push(`Fit ${pick}/5`); }
  if (act === 'won') { patchData.stage = 'won'; patchData.verdict = ''; log.push('Stage → Won'); }
  if (act === 'locked') { patchData.verdict = 'locked'; log.push('Tagged: Locked — another supplier'); }
  if (act === 'pass') { patchData.verdict = 'pass'; log.push('Tagged: Not for us'); }
  if (act === 'info') { patchData.needsResearch = true; log.push('Queued for research (more info)'); }
  if (act === 'next' && !log.length) {
    // skip for now - it comes back at the end of the deck
    if (!s.focus) { s.skip = s.skip.filter((x) => x !== r.id).concat(r.id); s.back.push(r.id); }
    s.pick = 0; s.focus = '';
    render();
    return;
  }
  if (log.length && !(await rateSave(r, patchData, 'Lead Rating: ' + log.join(' · ')))) return;
  if (!s.focus) s.back.push(r.id);
  s.skip = s.skip.filter((x) => x !== r.id);
  s.pick = 0;
  s.focus = '';
  render();
}

function wireLeadRate() {
  const root = document.querySelector('.rt-phone');
  if (!root) return;
  wireLeadImageErrors();
  const s = rateState();
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-rate-tab], [data-rate-pick], [data-rate-act], [data-rate-focus], [data-rate-unfocus], [data-rate-prev], [data-rate-open]');
    if (!t) return;
    if (t.hasAttribute('data-rate-tab')) { s.tab = t.getAttribute('data-rate-tab'); s.focus = ''; s.pick = 0; render(); return; }
    if (t.hasAttribute('data-rate-pick')) {
      const n = Number(t.getAttribute('data-rate-pick'));
      s.pick = s.pick === n ? 0 : n;
      root.querySelectorAll('[data-rate-pick]').forEach((b) => {
        const k = Number(b.getAttribute('data-rate-pick'));
        b.classList.toggle('is-fill', k <= s.pick);
        b.classList.toggle('is-on', k === s.pick);
        b.setAttribute('aria-checked', String(k === s.pick));
      });
      const h = document.getElementById('rt-hint');
      if (h) { h.textContent = s.pick ? 'Now pick an action' : 'Choose a rating, then an action'; h.classList.remove('is-bad'); }
      return;
    }
    if (t.hasAttribute('data-rate-act')) { rateAct(t.getAttribute('data-rate-act')); return; }
    if (t.hasAttribute('data-rate-focus')) { s.focus = t.getAttribute('data-rate-focus'); s.pick = 0; render(); window.scrollTo(0, 0); return; }
    if (t.hasAttribute('data-rate-unfocus')) { s.focus = ''; s.pick = 0; render(); return; }
    if (t.hasAttribute('data-rate-prev')) {
      // step back to the last lead you acted on, to change your mind
      const id = s.back.pop();
      if (id) { s.focus = id; s.pick = 0; render(); }
      return;
    }
    if (t.hasAttribute('data-rate-open')) {
      const id = t.getAttribute('data-rate-open');
      if (openLead(id, 'overview')) location.hash = '#/leads';
    }
  });
}

/*  Keys on a computer: 1-5 rate, W / I / L / P / N act. */
let rateKeysWired = false;
function wireRateKeys() {
  if (rateKeysWired) return;
  rateKeysWired = true;
  document.addEventListener('keydown', (e) => {
    if (state.view !== 'leadRate' || e.altKey || e.ctrlKey || e.metaKey || e.target.closest('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if (/^[1-5]$/.test(k)) { const b = document.querySelector(`[data-rate-pick="${k}"]`); if (b) b.click(); return; }
    const act = { w: 'won', i: 'info', l: 'locked', p: 'pass', n: 'next', arrowright: 'next' }[k];
    if (act && document.querySelector('.rt-card')) rateAct(act);
  });
}

VIEWS.leadRate = {
  html() { return leadRateHtml(); },
  wire() { wireRateKeys(); wireLeadRate(); },
};
