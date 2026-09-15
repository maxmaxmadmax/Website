/* --------------------------------------------------------------------------
   Vendor signup

   One page, five sections, and you scroll: select event -> vendor type ->
   your details -> choose site -> review and pay. It was a seven screen
   wizard, and the names of things still show it in places - a step error
   is set with setStepError, because that is what the error lines are
   still called in the markup.

   Two things worth knowing if you come back to this later:

   1. Nothing here decides anything that matters. Holding a site, checking a
      food category is not full, and marking a booking paid all happen in
      Cloud Functions. This file asks; the server answers.

   2. If js/firebase-config.js still has its placeholder values the page runs
      in PREVIEW mode - every screen works so the page can be reviewed, but
      nothing saves and payment is blocked.
   -------------------------------------------------------------------------- */

import {
  firebaseConfig,
  functionsRegion,
  eventId as defaultEventId,
  isFirebaseConfigured,
} from './firebase-config.js?v=79';

import { VendorMap, previewLayout, previewCategories } from './vendor-map.js?v=79';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

/* Prices shown before the server confirms them. The server prices from the
   event document; these are only for display.

   A food van is a flat fee for its 6 m x 3 m site. A market stall is sold
   by the 3 m x 3 m bay - between one and eight in a row. */
const PRICE = {
  foodCents: 10000,
  marketPerBayCents: 5000,
};

const MAX_BAYS = 8;

/*  VENDOR_LABEL was used on the confirmation screen and never defined -
    a ReferenceError that only fires after a real payment, which is why
    it sat there. Defined here now, and the side column uses it too.  */
const VENDOR_LABEL = {
  food: 'Food Vendor',
  market: 'Market Stall',
};

/* Matches priceFor() in functions/index.js */
function priceCents() {
  if (state.vendorType === 'food') return PRICE.foodCents;
  if (state.vendorType === 'market') {
    return PRICE.marketPerBayCents * (state.bayCount || 1);
  }
  return 0;
}

/*  WHAT THEY ACTUALLY PAY - shown before they commit to anything.

    Mirrors feeBreakdown() in functions/index.js. That one decides the
    charge; this one only decides what the page says. If the two ever
    disagree the vendor is quoted wrong, which is bad enough on its own,
    so keep them in step.

        fee   = 4% of the site price, plus 99c
        GST   = 10% of (site + fee)

    A free site stays free - no fee, no GST. */
const FEE_PERCENT = 0.04;
const FEE_FIXED_CENTS = 99;
const GST_RATE = 0.10;

function feeBreakdown(siteCents) {
  const site = Math.max(0, Math.round(Number(siteCents) || 0));
  if (site === 0) {
    return { siteCents: 0, bookingFeeCents: 0, gstCents: 0, totalCents: 0 };
  }

  const bookingFeeCents = Math.round(site * FEE_PERCENT) + FEE_FIXED_CENTS;
  const gstCents = Math.round((site + bookingFeeCents) * GST_RATE);

  return {
    siteCents: site,
    bookingFeeCents,
    gstCents,
    totalCents: site + bookingFeeCents + gstCents,
  };
}

/*  Whole dollars where it is round, cents where it is not - $100 rather
    than $100.00, but $115.49 rather than $115. Right for a headline price
    on a card. */
function money(cents) {
  if (cents === 0) return 'Free';
  return cents % 100 === 0
    ? `$${(cents / 100).toFixed(0)}`
    : `$${(cents / 100).toFixed(2)}`;
}

/*  Always two decimals, for the cost breakdown. A column reading $50,
    $2.99, $5.30 looks like a mistake even when it is not - the figures
    have to line up under each other to be checkable. */
function exact(cents) {
  return `$${((cents || 0) / 100).toFixed(2)}`;
}

/*  What a vendor is allowed to see, and what each status says to them.
    draft and archived are deliberately absent - those are ours.

    canApply decides whether the button works. An event with applications
    closed or not yet open still shows, because "we run this every year and
    it opens in March" is worth knowing.                                */
const EVENT_STATUS = {
  open:    { label: 'Accepting Vendors',   tone: 'is-open',    canApply: true },
  limited: { label: 'Limited Spots',       tone: 'is-limited', canApply: true },
  closed:  { label: 'Applications Closed', tone: 'is-closed',  canApply: false },
  soon:    { label: 'Coming Soon',         tone: 'is-soon',    canApply: false },
};

/* -------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */
const state = {
  /*  Set when a vendor picks an event. Everything that reads an event
      reads this - there is no module level event id any more, because a
      page that can apply to several must not have one.               */
  eventId: null,
  events: [],
  preview: !isFirebaseConfigured,

  vendorType: null,
  bayCount: 1,            // market only: how many bays are held, set from the map
  business: {},
  categoryId: null,
  categoryName: null,
  setup: {},
  documents: [],
  siteId: null,
  siteIds: [],
  siteLabel: null,

  bookingId: null,
  holdExpiresAt: null,
  user: null,
  confirmed: null,

  /* the event document, so the review step can name the event they are
     buying into rather than repeating it in the markup */
  event: null,
};

let fb = null;          // firebase handles once loaded
let map = null;
let categories = [];
let sitesUnsub = null;
let categoriesUnsub = null;
let holdTimer = null;

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', init);

async function init() {
  wireStaticControls();

  if (state.preview) {
    showPreviewBanner();
    startPreview();
    return;
  }

  try {
    fb = await loadFirebase();
    watchAuth();
  } catch (err) {
    console.error('Firebase failed to start', err);
    state.preview = true;
    showPreviewBanner('Could not reach Firebase. Showing a preview only.');
    startPreview();
    return;
  }

  buildMap();
  await handleReturnFromStripe();

  /*  Sites and categories belong to an event, so nothing is subscribed
      until one is chosen.                                             */
  if (state.eventId) subscribeToEvent();

  render();
  loadEvents();
}

/*  Everything that hangs off the chosen event, in one place so that
    choosing a different one can tear the old one down first.          */
function subscribeToEvent() {
  if (!fb || !state.eventId) return;
  subscribeSites();
  subscribeCategories();
}

/* -------------------------------------------------------------------------
   Choosing an event

   The page used to be the signup for one event, named in a constant. It
   now takes applications for all of them, so the event is the first thing
   asked and everything after it - the sites, the categories, the prices,
   the booking - belongs to whichever one was picked.
   ------------------------------------------------------------------------- */

/*  Every event a vendor is allowed to see, soonest first. Read once rather
    than watched: the list changes when we add an event, not while somebody
    is part way through a form.                                          */
async function loadEvents() {
  if (state.preview) {
    state.events = [{
      id: defaultEventId,
      name: 'Eatz & Beatz',
      subtitle: 'Halloween Edition',
      dateLabel: 'Saturday 31 October 2026',
      dateISO: '2026-10-31',
      venue: 'Bowen Sports Complex',
      location: 'Bowen, Queensland',
      status: 'open',
    }];
    renderEvents();
    return;
  }

  try {
    const { collection, getDocs } = fb.f;
    const snap = await getDocs(collection(fb.db, 'events'));

    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));

    /*  Only the statuses a vendor should see. draft and archived are ours. */
    state.events = rows
      .filter((ev) => EVENT_STATUS[ev.status])
      .sort((a, b) => String(a.dateISO || '').localeCompare(String(b.dateISO || '')));

    renderEvents();
  } catch (err) {
    console.error('events', err);
    const host = document.getElementById('vs-events');
    if (host) {
      host.innerHTML =
        '<p class="vs-events-loading">Could not load the events just now. ' +
        'Please refresh, or email info@soundzgood.com.au.</p>';
    }
  }
}

function renderEvents() {
  const host = document.getElementById('vs-events');
  if (!host) return;

  if (!state.events.length) {
    host.innerHTML =
      '<p class="vs-events-loading">No events are taking vendor applications ' +
      'at the moment. Check back soon.</p>';
    return;
  }

  host.innerHTML = state.events.map(eventCard).join('');

  host.querySelectorAll('[data-choose-event]').forEach((btn) => {
    btn.addEventListener('click', () => chooseEvent(btn.getAttribute('data-choose-event')));
  });
}

function eventCard(ev) {
  const st = EVENT_STATUS[ev.status] || EVENT_STATUS.soon;
  const chosen = state.eventId === ev.id;

  /*  The photo is a variable on the card, the way every other card on this
      site does it, so an event without one shows its gradient rather than
      a broken picture.                                                  */
  const art = ev.image
    ? ' style="--vs-ev-art:url(\'' + escapeHtml(ev.image) + '\')"'
    : '';

  const action = st.canApply
    ? '<button type="button" class="btn btn-ticket vs-event-go" ' +
      'data-choose-event="' + escapeHtml(ev.id) + '">' +
      (chosen ? 'Selected' : 'Apply for this event') +
      ' <span aria-hidden="true">&#8594;</span></button>'
    : '<span class="btn vs-event-go is-disabled" aria-disabled="true">' +
      (ev.status === 'soon' ? 'Applications open soon' : 'Applications closed') +
      '</span>';

  return '' +
    '<article class="vs-event' + (chosen ? ' is-chosen' : '') +
      (st.canApply ? '' : ' is-shut') + '"' + art + '>' +
      '<div class="vs-event-art" aria-hidden="true">' +
        '<span class="vs-event-status ' + st.tone + '">' + escapeHtml(st.label) + '</span>' +
      '</div>' +
      '<div class="vs-event-body">' +
        '<h3>' + escapeHtml(ev.name || ev.id) + '</h3>' +
        '<p class="vs-event-when">' +
          escapeHtml(ev.dateLabel || ev.dateISO || 'Date to be announced') + '</p>' +
        '<p class="vs-event-where">' + escapeHtml(ev.venue || ev.location || '') + '</p>' +
        (ev.subtitle
          ? '<p class="vs-event-blurb">' + escapeHtml(ev.subtitle) + '</p>'
          : '') +
        action +
      '</div>' +
    '</article>';
}

/*  Picking one.

    Changing event after starting throws the part-filled application away,
    because a site number and a food category belong to the event they were
    chosen at. Carrying them across would hold a site at an event nobody
    applied to, which is the kind of thing that ends with two vendors on
    one patch of grass.                                                  */
function chooseEvent(id) {
  const ev = state.events.find((e) => e.id === id);
  if (!ev) return;

  if (state.eventId && state.eventId !== id) {
    const ok = window.confirm(
      'Start a new application for ' + (ev.name || id) + '?\n\n' +
      'Anything filled in for the other event will be cleared.'
    );
    if (!ok) return;
    resetForNewEvent();
  }

  state.eventId = id;
  state.event = ev;

  if (!state.preview) subscribeToEvent();

  render();

  /*  Section two, not three. This said 'details' from when vendor type and
      business details shared a section; splitting them left it pointing
      past the vendor type cards at the form below.                   */
  goToSection('type');
}

/*  Back to a blank application with the vendor still signed in. Used when
    somebody swaps events, and when they apply for a second one after
    finishing the first.                                                 */
function resetForNewEvent() {
  if (sitesUnsub) { sitesUnsub(); sitesUnsub = null; }
  if (categoriesUnsub) { categoriesUnsub(); categoriesUnsub = null; }

  state.bookingId = null;
  state.vendorType = null;
  state.bayCount = 1;
  state.categoryId = null;
  state.siteIds = [];
  state.siteId = null;
  state.confirmed = false;
  categories = [];
}

/*  The event this application is for, above every step after the first.
    Hidden on the choosing step itself, where it would be telling somebody
    what they are already looking at.                                    */
function startPreview() {
  categories = previewCategories();
  buildMap();
  const layout = previewLayout();
  map.setLayout(layout);
  render();
}

async function loadFirebase() {
  const [{ initializeApp }, auth, firestore, storage, functions] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
    import(`${SDK}/firebase-storage.js`),
    import(`${SDK}/firebase-functions.js`),
  ]);

  const app = initializeApp(firebaseConfig);

  return {
    app,
    auth: auth.getAuth(app),
    db: firestore.getFirestore(app),
    storage: storage.getStorage(app),
    fns: functions.getFunctions(app, functionsRegion),
    a: auth,
    f: firestore,
    s: storage,
    fn: functions,
  };
}

/* -------------------------------------------------------------------------
   Preview banner
   ------------------------------------------------------------------------- */
function showPreviewBanner(message) {
  const el = document.getElementById('vs-preview-banner');
  if (!el) return;
  if (message) {
    const p = el.querySelector('[data-preview-message]');
    if (p) p.textContent = message;
  }
  el.hidden = false;
}

/* -------------------------------------------------------------------------
   Auth
   ------------------------------------------------------------------------- */
/*  NOBODY MAKES AN ACCOUNT TO PAY.

    A food truck filling in this form does not want a username and a
    password, and asking for one before they can pick a site loses people
    who were about to give us money.

    So the browser signs itself in anonymously, silently, the moment the
    page loads. The vendor never sees it. Nothing behind the form changes:
    Firebase still issues a real uid, so requireAuth in the Cloud Functions
    still passes, the Firestore rules still match the booking to its owner,
    and a site is still held against a specific person - two vendors cannot
    grab the same bay. It is the sign-up screen that goes, not the identity.

    The cost is that the identity lives in this browser. Clear the browser
    and the booking cannot be found from the vendor's side any more - which
    is why the reference number is put in front of them at the end, their
    email is on the record, and staff can always find them in /admin. */
function watchAuth() {
  fb.a.onAuthStateChanged(fb.auth, (user) => {
    state.user = user;
    if (map) map.setUid(user ? user.uid : null);
    if (user) loadExistingBooking();
    render();

    if (!user) signInQuietly();
  });
}

let signingIn = false;

async function signInQuietly() {
  if (signingIn) return;
  signingIn = true;

  try {
    await fb.a.signInAnonymously(fb.auth);
  } catch (err) {
    /*  The one failure a vendor could actually hit: anonymous sign-in
        turned off on the project. Say something, rather than leaving the
        Hold button quietly doing nothing forever. */
    console.error('anonymous sign-in failed', err);
    setStepError('site',
      'Something went wrong getting you started. Please refresh and try again.');
  } finally {
    signingIn = false;
  }
}

/* -------------------------------------------------------------------------
   Live data
   ------------------------------------------------------------------------- */
function subscribeSites() {
  if (!fb) return;
  const { collection, onSnapshot, doc } = fb.f;

  // event doc: map size and landmarks
  onSnapshot(doc(fb.db, 'events', state.eventId), (snap) => {
    if (!snap.exists()) return;
    const ev = snap.data();
    state.event = ev;
    map.setLayout({
      mapSize: ev.map || { width: 1000, height: 700 },
      landmarks: ev.landmarks || [],
    });
    paintEventHeader(ev);
  });

  sitesUnsub = onSnapshot(
    collection(fb.db, 'events', state.eventId, 'sites'),
    (snap) => {
      const sites = [];
      snap.forEach((d) => sites.push({ id: d.id, ...d.data() }));
      sites.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
      map.setLayout({ sites });
      renderMapMeta();
    },
    (err) => console.error('sites listener', err)
  );
}

function subscribeCategories() {
  if (!fb) return;
  const { collection, onSnapshot } = fb.f;

  categoriesUnsub = onSnapshot(
    collection(fb.db, 'events', state.eventId, 'categories'),
    (snap) => {
      categories = [];
      snap.forEach((d) => categories.push({ id: d.id, ...d.data() }));
      categories.sort((a, b) => a.name.localeCompare(b.name));
      renderCategories();
    },
    (err) => console.error('categories listener', err)
  );
}

function paintEventHeader(ev) {
  if (!ev.pricing) return;

  const shown = {
    food: ev.pricing.food,
    'market-bay': ev.pricing.marketPerBay,
  };

  document.querySelectorAll('[data-price]').forEach((el) => {
    const cents = shown[el.getAttribute('data-price')];
    if (cents != null) el.textContent = money(cents);
  });
}

/* -------------------------------------------------------------------------
   Map
   ------------------------------------------------------------------------- */
function buildMap() {
  const host = document.getElementById('vs-map');
  if (!host) return;

  map = new VendorMap(host, {
    maxBays: MAX_BAYS,
    // Clicking only builds up the shape on screen. Nothing is held until
    // the vendor confirms, so they can try sizes without locking bays away
    // from anyone else.
    onSelect: () => {
      renderSiteChoice();
      renderMapMeta();
    },
  });

  if (state.user) map.setUid(state.user.uid);
}

function renderMapMeta() {
  const legend = document.getElementById('vs-map-counts');
  if (!legend || !map) return;

  if (!state.vendorType) { legend.textContent = ''; return; }

  const c = map.counts();
  const parts = [`${c.openNow} open now`];
  if (c.notYetOpen) parts.push(`${c.notYetOpen} open later`);
  if (c.mine) parts.push(`${c.mine} held by you`);

  legend.textContent = parts.join(' · ');
}

/* What the vendor has clicked but not yet confirmed. */
function pendingSites() {
  return map ? map.selectedSites() : [];
}

function pendingLabel() {
  return pendingSites().map((s) => s.label).join(' + ');
}

function pendingPriceCents() {
  const n = pendingSites().length || 1;
  return state.vendorType === 'food' ? PRICE.foodCents : PRICE.marketPerBayCents * n;
}

/* Take the bays the vendor has picked. One call for the whole group, so
   the server allocates them together or not at all. */
async function holdChosenSites() {
  const chosen = pendingSites();
  if (!chosen.length) return;

  const ids = chosen.map((s) => s.id);

  if (state.preview) {
    state.siteId = ids[0];
    state.siteIds = ids;
    state.bayCount = state.vendorType === 'market' ? ids.length : 1;
    state.siteLabel = pendingLabel();
    renderSiteChoice();
    return;
  }

  /*  Anonymous sign-in normally lands long before anybody has read this
      far, so this is the rare case of it not having come back yet - or
      having failed. Nudge it along rather than telling them to do
      something the page no longer asks for. */
  if (!state.user) {
    setStepError('site', 'Still getting set up - give it a second and try again.');
    signInQuietly();
    return;
  }

  setBusy('site', true);
  setStepError('site', '');

  try {
    await ensureBookingDoc();

    const call = fb.fn.httpsCallable(fb.fns, 'holdSite');
    const res = await call({ eventId: state.eventId, siteIds: ids, bookingId: state.bookingId });

    state.siteIds = res.data.siteIds || ids;
    state.siteId = state.siteIds[0];
    state.bayCount = state.vendorType === 'market' ? state.siteIds.length : 1;
    state.siteLabel = res.data.siteLabel;
    state.holdExpiresAt = res.data.holdExpiresAt;

    map.setSelected(state.siteIds);
    startHoldCountdown();
    renderSiteChoice();
  } catch (err) {
    setStepError('site', friendlyError(err));
  } finally {
    setBusy('site', false);
  }
}

function startHoldCountdown() {
  stopHoldCountdown();
  const el = document.getElementById('vs-hold-timer');
  if (!el || !state.holdExpiresAt) return;

  const tick = () => {
    const left = state.holdExpiresAt - Date.now();

    if (left <= 0) {
      el.textContent = 'Your hold has expired. Choose a site again.';
      el.classList.add('is-expired');
      state.siteId = null;
      state.siteIds = [];
      state.siteLabel = null;
      state.bayCount = 1;
      map.setSelected(null);
      renderSiteChoice();
      stopHoldCountdown();
      return;
    }

    const mins = Math.floor(left / 60000);
    const secs = Math.floor((left % 60000) / 1000);
    el.textContent = `Site held for ${mins}:${String(secs).padStart(2, '0')}`;
    el.classList.remove('is-expired');
  };

  tick();
  holdTimer = setInterval(tick, 1000);
}

function stopHoldCountdown() {
  if (holdTimer) clearInterval(holdTimer);
  holdTimer = null;
}

/* -------------------------------------------------------------------------
   Booking document
   ------------------------------------------------------------------------- */
async function ensureBookingDoc() {
  if (state.bookingId) return state.bookingId;

  const { collection, addDoc, serverTimestamp } = fb.f;

  const ref = await addDoc(collection(fb.db, 'bookings'), {
    uid: state.user.uid,
    eventId: state.eventId,
    vendorType: state.vendorType,
    bayCount: state.bayCount,
    business: state.business,
    categoryId: state.categoryId,
    setup: state.setup,
    documents: state.documents,
    status: 'draft',
    paymentStatus: 'none',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  state.bookingId = ref.id;
  localStorage.setItem('sg-vendor-booking', ref.id);
  return ref.id;
}

async function saveDraft() {
  if (state.preview || !fb || !state.user || !state.bookingId) return;

  const { doc, updateDoc, serverTimestamp } = fb.f;

  await updateDoc(doc(fb.db, 'bookings', state.bookingId), {
    vendorType: state.vendorType,
    bayCount: state.bayCount,
    business: state.business,
    categoryId: state.categoryId,
    setup: state.setup,
    documents: state.documents,
    updatedAt: serverTimestamp(),
  });
}

async function loadExistingBooking() {
  const saved = localStorage.getItem('sg-vendor-booking');
  if (!saved || !fb) return;

  try {
    const { doc, getDoc } = fb.f;
    const snap = await getDoc(doc(fb.db, 'bookings', saved));
    if (!snap.exists()) return;

    const b = snap.data();
    if (b.uid !== state.user.uid) return;

    if (b.status === 'confirmed') {
      state.confirmed = { id: snap.id, ...b };
      showConfirmation();
      return;
    }

    state.bookingId = snap.id;
    state.vendorType = b.vendorType || state.vendorType;
    state.bayCount = b.bayCount || 1;
    state.business = b.business || {};
    state.categoryId = b.categoryId || null;
    state.setup = b.setup || {};
    state.documents = b.documents || [];
    state.siteId = b.siteId || null;
    state.siteIds = b.siteIds || (b.siteId ? [b.siteId] : []);
    state.siteLabel = b.siteLabel || null;

    if (map) {
      map.setVendorType(state.vendorType);
      map.setSelected(state.siteIds);
    }
  } catch (err) {
    console.warn('Could not restore booking', err);
  }
}

/* -------------------------------------------------------------------------
   Documents
   ------------------------------------------------------------------------- */
async function uploadDocument(file, docType) {
  if (state.preview) {
    state.documents.push({
      type: docType,
      name: file.name,
      size: file.size,
      preview: true,
    });
    renderDocumentList();
    return;
  }

  if (!state.user) {
    setStepError('documents', 'Still getting set up - give it a second and try again.');
    signInQuietly();
    return;
  }

  const maxBytes = 10 * 1024 * 1024;
  if (file.size > maxBytes) {
    setStepError('documents', `${file.name} is larger than 10 MB.`);
    return;
  }

  const allowed = ['application/pdf'];
  if (!allowed.includes(file.type) && !file.type.startsWith('image/')) {
    setStepError('documents', 'Please upload a PDF or an image.');
    return;
  }

  setBusy('documents', true);
  setStepError('documents', '');

  try {
    const { ref, uploadBytes, getDownloadURL } = fb.s;
    const safeName = file.name.replace(/[^\w.\-]+/g, '_');
    const path = `vendor-documents/${state.user.uid}/${Date.now()}-${safeName}`;
    const storageRef = ref(fb.storage, path);

    await uploadBytes(storageRef, file, { contentType: file.type });
    const url = await getDownloadURL(storageRef);

    state.documents.push({
      type: docType,
      name: file.name,
      size: file.size,
      path,
      url,
      uploadedAt: Date.now(),
    });

    await ensureBookingDoc();
    await saveDraft();
    renderDocumentList();
  } catch (err) {
    setStepError('documents', friendlyError(err));
  } finally {
    setBusy('documents', false);
  }
}

function renderDocumentList() {
  const list = document.getElementById('vs-doc-list');
  if (!list) return;

  if (!state.documents.length) {
    list.innerHTML = '<li class="vs-doc-empty">No documents added yet.</li>';
    return;
  }

  list.innerHTML = state.documents.map((d, i) => `
    <li class="vs-doc">
      <span class="vs-doc-type">${escapeHtml(d.type)}</span>
      <span class="vs-doc-name">${escapeHtml(d.name)}</span>
      <span class="vs-doc-size">${formatSize(d.size)}</span>
      <button type="button" class="vs-link" data-remove-doc="${i}">Remove</button>
    </li>
  `).join('');

  list.querySelectorAll('[data-remove-doc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.documents.splice(Number(btn.getAttribute('data-remove-doc')), 1);
      renderDocumentList();
      saveDraft();
    });
  });
}

/* -------------------------------------------------------------------------
   Checkout
   ------------------------------------------------------------------------- */
async function payAndBook() {
  if (state.preview) {
    setStepError('review',
      'Preview mode - payments are switched off until Firebase and Stripe are connected.');
    return;
  }

  if (!validateAll()) return;

  collectForm();

  if (!state.siteId) {
    setStepError('review', 'Choose a site before paying.');
    return;
  }

  setBusy('review', true);
  setStepError('review', '');

  try {
    await saveDraft();

    const call = fb.fn.httpsCallable(fb.fns, 'createCheckout');
    const res = await call({ bookingId: state.bookingId });

    if (res.data.free || res.data.alreadyConfirmed) {
      await refreshConfirmed();
      return;
    }

    if (res.data.url) {
      window.location.assign(res.data.url);
      return;
    }

    setStepError('review', 'Could not start checkout. Please try again.');
  } catch (err) {
    setStepError('review', friendlyError(err));
  } finally {
    setBusy('review', false);
  }
}

/* Stripe sends people back here. The redirect is only a hint - the booking
   is not treated as paid until the webhook has written it, so this polls
   the booking rather than believing the URL. */
/*  Coming back from Stripe, paid or cancelled.

    The booking knows which event it is for and this page no longer does,
    so the event is read back off it before anything else happens. Without
    that, a cancelled checkout returns to a review step with no sites and
    no categories loaded, because nothing knows which event's to load.  */
async function handleReturnFromStripe() {
  const params = new URLSearchParams(window.location.search);
  const bookingId = params.get('booking');

  if (!bookingId) return;

  state.bookingId = bookingId;
  localStorage.setItem('sg-vendor-booking', bookingId);

  if (fb) {
    try {
      const { doc, getDoc } = fb.f;
      const snap = await getDoc(doc(fb.db, 'bookings', bookingId));
      if (snap.exists()) {
        const b = snap.data();
        if (b.eventId) state.eventId = b.eventId;
      }
    } catch (err) {
      console.error('could not read the booking on return', err);
    }
  }

  if (params.get('cancelled')) {
    setStepError('review', 'Checkout was cancelled. Your site is still held for a few minutes.');
    goToSection('review');
    return;
  }

  if (params.get('paid')) {
    showWaitingForPayment();
    pollForConfirmation(bookingId);
  }
}

function showWaitingForPayment() {
  const el = document.getElementById('vs-confirming');
  if (el) el.hidden = false;
  document.querySelectorAll('.vs-sec').forEach((el) => { el.hidden = true; });
  document.querySelector('.vs-side')?.setAttribute('hidden', '');
}

async function pollForConfirmation(bookingId, attempt = 0) {
  if (!fb) return;

  const { doc, getDoc } = fb.f;

  try {
    const snap = await getDoc(doc(fb.db, 'bookings', bookingId));

    if (snap.exists() && snap.data().status === 'confirmed') {
      state.confirmed = { id: snap.id, ...snap.data() };
      showConfirmation();
      return;
    }

    if (snap.exists() && snap.data().status === 'needs_attention') {
      const el = document.getElementById('vs-confirming');
      if (el) {
        el.innerHTML = `
          <h2>We need to sort something out</h2>
          <p>Your payment went through, but the site was taken while you were
             paying. Nothing further is needed from you right now - we will be
             in touch to move you to another site or refund you.</p>
          <p><a class="btn" href="/contact">Contact SoundzGood</a></p>`;
      }
      return;
    }
  } catch (err) {
    console.warn('Still waiting on the webhook', err);
  }

  // Webhooks are usually instant but can lag a little. Back off, and after
  // about a minute tell them it is safe to leave.
  if (attempt < 20) {
    setTimeout(() => pollForConfirmation(bookingId, attempt + 1), 3000);
  } else {
    const el = document.getElementById('vs-confirming');
    if (el) {
      const p = el.querySelector('[data-confirming-note]');
      if (p) {
        p.textContent =
          'This is taking longer than usual. Your payment is safe and your ' +
          'booking will be confirmed by email. You can close this page.';
      }
    }
  }
}

async function refreshConfirmed() {
  const { doc, getDoc } = fb.f;
  const snap = await getDoc(doc(fb.db, 'bookings', state.bookingId));
  if (snap.exists()) {
    state.confirmed = { id: snap.id, ...snap.data() };
    showConfirmation();
  }
}

function showConfirmation() {
  const wrap = document.getElementById('vs-confirmed');
  const confirming = document.getElementById('vs-confirming');

  if (confirming) confirming.hidden = true;
  document.querySelectorAll('.vs-sec').forEach((el) => { el.hidden = true; });
  document.querySelector('.vs-side')?.setAttribute('hidden', '');

  if (!wrap) return;
  const b = state.confirmed || {};

  wrap.hidden = false;
  wrap.innerHTML = `
    <div class="vs-confirm-card">
      <p class="vs-eyebrow">Booking confirmed</p>
      <h2>You're in.</h2>
      <p class="vs-confirm-ref">Reference <strong>${escapeHtml(b.reference || b.id || '')}</strong></p>

      <dl class="vs-summary-list">
        <div><dt>Vendor</dt><dd>${escapeHtml(b.business?.name || '')}</dd></div>
        <div><dt>Type</dt><dd>${escapeHtml(VENDOR_LABEL[b.vendorType] || b.vendorType || '')}</dd></div>
        ${b.categoryName ? `<div><dt>Category</dt><dd>${escapeHtml(b.categoryName)}</dd></div>` : ''}
        <div><dt>Site</dt><dd>${escapeHtml(b.siteLabel || '')}</dd></div>
        <div><dt>Paid</dt><dd>${b.amountPaidCents != null
          ? '$' + (b.amountPaidCents / 100).toFixed(2)
          : (b.paymentStatus === 'free' ? 'Free' : '-')}</dd></div>
      </dl>

      <p class="vs-confirm-note">
        Eatz &amp; Beatz Halloween Edition &middot; Saturday 31 October 2026 &middot;
        Bowen Sports Complex. We'll email your bump-in time and site details closer
        to the date.
      </p>

      <div class="buttons">
        <a class="btn" href="/events">Back to Events</a>
        <a class="btn btn-outline" href="/contact">Contact Us</a>
      </div>
    </div>
  `;
}

/* -------------------------------------------------------------------------
   Sections

   The form is one page now: five sections, stacked, and you scroll. There
   is no current step any more - what used to be state.step is replaced by
   asking each section whether it has what it needs, which is also what
   the summary down the side reports.

   The order still matters. What you sell comes before the map, because a
   category that is already full should stop somebody before they get
   attached to a site.
   ------------------------------------------------------------------------- */
const SECTIONS = [
  { id: 'event',   label: 'Select Event' },
  { id: 'type',    label: 'Vendor Type' },
  { id: 'details', label: 'Your Details' },
  { id: 'site',    label: 'Choose Site' },
  { id: 'review',  label: 'Review & Pay' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/*  Has this section got everything it needs?

    Read live from the fields rather than from state, because state is only
    filled in when somebody presses Continue and the rail has to keep up
    with the typing.                                                      */
function sectionDone(id) {
  const ticked = (elId) => !!document.getElementById(elId)?.checked;

  switch (id) {
    case 'event':
      return !!state.eventId;

    case 'type':
      return !!state.vendorType;

    case 'details':
      return !!val('vs-biz-name') && !!val('vs-biz-contact')
          && EMAIL_RE.test(val('vs-biz-email')) && !!val('vs-biz-phone')
          && !!state.categoryId
          && !!val('vs-setup-frontage') && !!val('vs-setup-depth')
          && !!val('vs-setup-own-power') && ticked('vs-setup-selfsufficient');

    case 'site':
      return !!state.siteId;

    case 'review':
      return !!state.confirmed;

    default:
      return false;
  }
}

/*  Scrolls a section to just under the rail.

    Not scrollIntoView with a scroll-margin: the rail is one line of steps
    on a wide screen and can be taller on a narrow one, so any fixed margin
    is wrong at some width and the heading ends up tucked underneath. This
    measures it.                                                        */
function goToSection(id) {
  const el = document.getElementById('sec-' + id);
  if (!el) return;

  const rail = document.getElementById('vs-rail');
  const clear = (rail ? rail.getBoundingClientRect().height : 0) + 14;
  const top = el.getBoundingClientRect().top + window.scrollY - clear;

  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function render() {
  if (state.confirmed) return;

  /*  Everything after choosing an event is locked until one is chosen -
      the prices, the categories and the sites all belong to a single
      event, so there is nothing truthful to show before then.         */
  const chosen = !!state.eventId;
  document.querySelectorAll('.vs-sec').forEach((el) => {
    if (el.getAttribute('data-sec') === 'event') return;
    el.classList.toggle('is-locked', !chosen);
  });

  renderEvents();
  renderPicked();
  renderSide();
  renderRail();  if (!chosen) return;

  renderCategories();
  if (map) map.setVendorType(state.vendorType);
  renderSiteChoice();
  renderMapMeta();
  renderDocumentList();
  renderReview();
}

/*  THE STEP RAIL

    Five steps across the top of the form, sticky. A step is done when its
    section has everything it needs, and the one highlighted is whichever
    section is on screen - not the next unfinished one, because on a page
    you scroll those two are different things and the rail should say where
    you are looking.

    Clicking one scrolls to it. Nothing here gates anything: the rail
    reports, it does not lock.                                          */
let railOn = 'event';

function onFormChange() {
  renderSide();
  renderRail();
}

function renderRail() {
  const host = document.getElementById('vs-rail');
  if (!host) return;

  host.innerHTML = '<ol class="vs-rail-list">' + SECTIONS.map((sec, i) => {
    const done = sectionDone(sec.id);
    const here = sec.id === railOn;

    return '' +
      '<li class="' + (done ? 'is-done ' : '') + (here ? 'is-here' : '') + '">' +
        '<button type="button" data-rail="' + sec.id + '">' +
          '<span class="vs-rail-num">' + (done ? '&#10003;' : (i + 1)) + '</span>' +
          '<span class="vs-rail-label">' + sec.label + '</span>' +
        '</button>' +
      '</li>';
  }).join('') + '</ol>';

  host.querySelectorAll('[data-rail]').forEach((btn) => {
    btn.addEventListener('click', () => goToSection(btn.getAttribute('data-rail')));
  });
}

/*  Which section is on screen, for the rail. Whatever crosses a third of
    the way down the window - not the very top, where a section is only
    just arriving and does not yet have anybody's attention.            */
function watchScroll() {
  let queued = false;

  const check = () => {
    queued = false;
    const line = window.innerHeight / 3;
    let here = SECTIONS[0].id;

    SECTIONS.forEach((sec) => {
      const el = document.getElementById('sec-' + sec.id);
      if (el && el.getBoundingClientRect().top <= line) here = sec.id;
    });

    if (here !== railOn) {
      railOn = here;
      renderRail();
    }
  };

  window.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(check);
  }, { passive: true });

  check();
}

/*  THE EVENT YOU PICKED

    Sits under the cards the moment one is chosen, and carries the two
    prices and the power situation. Those used to be a step of their own
    that everybody walked past on the way to the form; here they arrive
    at the only moment they mean anything.                              */
function renderPicked() {
  const wrap = document.getElementById('vs-picked');
  const head = document.getElementById('vs-picked-head');
  if (!wrap || !head) return;

  const ev = state.event;
  if (!ev || !state.eventId) {
    wrap.hidden = true;
    return;
  }

  const art = ev.image
    ? ' style="--vs-ev-art:url(\'' + escapeHtml(ev.image) + '\')"'
    : '';

  wrap.hidden = false;
  head.innerHTML = '' +
    '<span class="vs-picked-art"' + art + ' aria-hidden="true">' +
      '<span class="vs-picked-tick">&#10003;</span>' +
    '</span>' +

    '<div class="vs-picked-what">' +
      '<p class="vs-picked-label">Selected event</p>' +
      '<strong>' + escapeHtml(ev.name || state.eventId) + '</strong>' +
      '<span class="vs-picked-when">' +
        escapeHtml(ev.dateLabel || ev.dateISO || '') + '</span>' +
      '<span class="vs-picked-where">' +
        escapeHtml(ev.venue || ev.location || '') + '</span>' +
    '</div>' +

    '<div class="vs-picked-fact">' +
      '<p class="vs-picked-label">Food vendor</p>' +
      '<strong>' + money(PRICE.foodCents) + '</strong>' +
      '<span>6 m &times; 3 m site</span>' +
    '</div>' +

    '<div class="vs-picked-fact">' +
      '<p class="vs-picked-label">Market stall</p>' +
      '<strong>' + money(PRICE.marketPerBayCents) + ' / bay</strong>' +
      '<span>3 m &times; 3 m per bay<br>(up to 8 adjoining bays)</span>' +
    '</div>' +

    '<div class="vs-picked-fact">' +
      '<p class="vs-picked-label">Power / water</p>' +
      '<span>No power or water supplied.<br>Generators recommended.</span>' +
    '</div>' +

    '<button type="button" class="vs-picked-more-btn" data-more>' +
      'Event details &amp; FAQs <span aria-hidden="true">&#9662;</span>' +
    '</button>';

  const btn = head.querySelector('[data-more]');
  const more = document.getElementById('vs-picked-more');
  if (btn && more) {
    btn.addEventListener('click', () => {
      more.hidden = !more.hidden;
      btn.classList.toggle('is-open', !more.hidden);
      btn.setAttribute('aria-expanded', String(!more.hidden));
    });
  }
}

/*  YOUR APPLICATION

    The booking as it stands, down the side. It was a second list of the
    five steps, which is what the rail across the top already does - so it
    says what is actually being bought instead: which event, which kind of
    vendor, which site, and what it comes to.                           */
function renderSide() {
  const host = document.getElementById('vs-chosen');
  if (!host) return;

  const ev = state.event;

  if (!ev || !state.eventId) {
    host.innerHTML =
      '<h3 class="vs-side-head">Your application</h3>' +
      '<p class="vs-side-empty">Choose an event above and your booking will ' +
      'build up here as you go.</p>';
    return;
  }

  const art = ev.image
    ? ' style="--vs-ev-art:url(\'' + escapeHtml(ev.image) + '\')"'
    : '';

  const b = feeBreakdown(priceCents());

  const bays = state.bayCount || 1;
  const siteLine = state.vendorType === 'market'
    ? 'Market stall × ' + bays + ' bay' + (bays > 1 ? 's' : '')
    : 'Food vendor site';

  const typeRow = state.vendorType
    ? '<strong>' + escapeHtml(VENDOR_LABEL[state.vendorType] || '') + '</strong>' +
      '<span>' + (state.vendorType === 'food'
        ? money(PRICE.foodCents) + ' &middot; 6 m &times; 3 m'
        : money(PRICE.marketPerBayCents) + ' per bay') + '</span>'
    : '<span class="vs-side-wait">Not chosen yet</span>';

  const siteRow = state.siteLabel
    ? '<strong>' + escapeHtml(state.siteLabel) + '</strong>' +
      '<span>Held for you while you finish.</span>'
    : '<span class="vs-side-wait">Not selected yet</span>' +
      '<span>Choose your site on the map below.</span>';

  host.innerHTML = '' +
    '<div class="vs-side-top">' +
      '<h3 class="vs-side-head">Your application</h3>' +
      '<button type="button" class="vs-side-change" data-change-event>Edit event</button>' +
    '</div>' +

    '<div class="vs-side-card">' +
      '<span class="vs-side-art"' + art + ' aria-hidden="true"></span>' +
      '<span class="vs-side-card-text">' +
        '<strong>' + escapeHtml(ev.name || state.eventId) + '</strong>' +
        '<span>' + escapeHtml(ev.dateLabel || ev.dateISO || '') + '</span>' +
        '<span>' + escapeHtml(ev.venue || ev.location || '') + '</span>' +
      '</span>' +
    '</div>' +

    '<div class="vs-side-row">' +
      '<p class="vs-side-label">Vendor type</p>' + typeRow +
    '</div>' +

    '<div class="vs-side-row">' +
      '<p class="vs-side-label">Site selection</p>' + siteRow +
    '</div>' +

    /*  Itemised, not a total with a note under it saying fees are in
        there somewhere. A vendor comparing our $100 site against the
        $115.49 that leaves their account deserves to see which line is
        ours, which is the payment processor's and which is the tax.

        The bays line is spelled out for market stalls because the site
        total moves with the map - two bays at $50 reads as a mistake
        otherwise.                                                    */
    (b.totalCents
      ? '<div class="vs-side-sum">' +
          '<div>' +
            '<span>' + escapeHtml(siteLine) + '</span>' +
            '<span>' + exact(b.siteCents) + '</span>' +
          '</div>' +
          '<div>' +
            '<span>Booking fee <em>4% + $0.99</em></span>' +
            '<span>' + exact(b.bookingFeeCents) + '</span>' +
          '</div>' +
          '<div>' +
            '<span>GST <em>10%</em></span>' +
            '<span>' + exact(b.gstCents) + '</span>' +
          '</div>' +
        '</div>'
      : '') +

    '<div class="vs-side-total">' +
      '<span>Total</span>' +
      '<strong>' + exact(b.totalCents) + '</strong>' +
    '</div>' +

    (b.totalCents
      ? ''
      : '<p class="vs-side-fineprint">Choose a vendor type to see your total</p>') +

    '<button type="button" class="btn vs-side-go" data-side-go>' +
      'Continue to next step <span aria-hidden="true">&#8594;</span>' +
    '</button>' +

    '<p class="vs-side-hold">' +
      'Your site is held for 10 minutes once selected. Complete your ' +
      'application and payment to confirm.' +
    '</p>';

  const change = host.querySelector('[data-change-event]');
  if (change) change.addEventListener('click', () => goToSection('event'));

  /*  One button that always points at the first thing still to do, so it
      works wherever somebody has scrolled to.                         */
  const go = host.querySelector('[data-side-go]');
  if (go) {
    const next = SECTIONS.find((sec) => !sectionDone(sec.id)) || SECTIONS[SECTIONS.length - 1];
    go.addEventListener('click', () => goToSection(next.id));
  }
}

function renderCategories() {
  const host = document.getElementById('vs-categories');
  if (!host) return;

  // Food vendors see food categories, market stalls see market ones.
  const mine = categories.filter((c) => c.appliesTo === state.vendorType);

  const heading = document.getElementById('vs-category-heading');
  if (heading) {
    heading.textContent = state.vendorType === 'market'
      ? 'What do you sell?'
      : 'Your food category';
  }

  if (!categories.length) {
    host.innerHTML = '<p class="vs-muted">Loading categories…</p>';
    return;
  }

  if (!mine.length) {
    host.innerHTML = '<p class="vs-muted">No categories set up for this vendor type yet.</p>';
    return;
  }

  host.innerHTML = mine.map((c) => {
    const full = (c.count || 0) >= c.limit;
    const selected = state.categoryId === c.id;

    return `
      <button type="button"
              class="vs-category ${full ? 'is-full' : ''} ${selected ? 'is-selected' : ''}"
              data-category="${escapeHtml(c.id)}"
              ${full && !selected ? 'disabled aria-disabled="true"' : ''}>
        <span class="vs-category-name">${escapeHtml(c.name)}</span>
        <span class="vs-category-count">${c.count || 0} / ${c.limit}</span>
        ${full ? '<span class="vs-category-full">FULL</span>' : ''}
      </button>
    `;
  }).join('');

  host.querySelectorAll('[data-category]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-category');
      const cat = mine.find((c) => c.id === id);
      state.categoryId = id;
      state.categoryName = cat ? cat.name : null;
      renderCategories();
      setStepError('category', '');
    });
  });
}

function renderSiteChoice() {
  const out = document.getElementById('vs-site-choice');
  const confirm = document.getElementById('vs-site-confirm');
  if (!out) return;

  const chosen = pendingSites();
  const held = Boolean(state.siteLabel);
  const heldIds = state.siteIds.join(',');
  const sameAsHeld = held && chosen.map((s) => s.id).join(',') === heldIds;

  /*  Site fee here, not the total. This line is about comparing one site
      against another while they are picking, and the fee and GST are the
      same whichever they choose - the review step spells the whole lot
      out before they pay. */
  if (sameAsHeld) {
    out.textContent = `Held for you: site ${state.siteLabel} · ${money(priceCents())} site fee`;
  } else if (chosen.length) {
    const n = chosen.length;
    const size = state.vendorType === 'market'
      ? ` (${n} bay${n > 1 ? 's' : ''} · ${n * 3} m x 3 m)`
      : ' (6 m x 3 m)';
    out.textContent = `Picked: ${pendingLabel()}${size} · ${money(pendingPriceCents())} site fee`;
  } else if (held) {
    out.textContent = `Held for you: site ${state.siteLabel}`;
  } else {
    out.textContent = state.vendorType === 'market'
      ? `Tap the bays you want. Take up to ${MAX_BAYS} joined together for a bigger stall.`
      : 'Tap the site you want.';
  }

  out.classList.toggle('is-chosen', sameAsHeld || chosen.length > 0);

  if (confirm) {
    confirm.hidden = chosen.length === 0 || sameAsHeld;
    confirm.textContent = chosen.length > 1
      ? `Hold these ${chosen.length} bays`
      : 'Hold this site';
  }
}

/*  The sign-in panel is gone - see watchAuth. This is kept as a no-op
    rather than chased through every call site, and hides the panel if an
    old cached copy of the page is still serving it. */
/*  THE REVIEW STEP

    A stack of small cards, one idea each: what you are buying, what it
    costs, and who takes the money. Everything is one column at every
    width, because a checkout is read top to bottom and most vendors fill
    this in on a phone anyway.

    This replaced a five column table beside a sidebar. The table had to
    be rebuilt into labelled blocks below 768px to be readable at all, so
    the desktop and phone layouts were really two designs to keep in step.
    ------------------------------------------------------------------------- */

/*  The little glyph in front of the line item. Drawn rather than loaded -
    two icons are not worth an image request, and these inherit the text
    colour so they never look pasted on. */
const ITEM_ICONS = {
  food: `<svg viewBox="0 0 120 80" aria-hidden="true">
           <path d="M14 54V30h48l14 12v12z"/>
           <path d="M62 30h10l14 12H62z"/>
           <circle cx="34" cy="58" r="6"/>
           <circle cx="76" cy="58" r="6"/>
           <path d="M10 26h60l-4-8H14z"/>
         </svg>`,
  market: `<svg viewBox="0 0 120 80" aria-hidden="true">
             <path d="M18 34h84v30H18z"/>
             <path d="M14 18h92l10 16H4z"/>
             <path d="M34 44h24v20H34z"/>
           </svg>`,
};

function renderReview() {
  const host = document.getElementById('vs-review');
  if (!host) return;

  const b = feeBreakdown(priceCents());
  const ev = state.event || {};
  const isMarket = state.vendorType === 'market';
  const bays = isMarket ? (state.bayCount || 1) : 1;

  /*  Priced per bay so the sum is visible: two bays at $50 reads as
      2 x $50.00 = $100.00 rather than an unexplained $100. */
  const perBay = bays > 1 ? Math.round(b.siteCents / bays) : b.siteCents;

  const itemName = isMarket
    ? `Market bay${bays > 1 ? 's' : ''}`
    : 'Food vendor site';

  const itemSub = [state.siteLabel, state.categoryName]
    .filter(Boolean).map(escapeHtml).join(' &middot; ') || 'No site chosen yet';

  /*  The event line under the card title. It is the one thing the old
      sidebar carried that is not repeated anywhere else on this step. */
  const eventLine = [ev.name || 'Eatz & Beatz', ev.dateLabel]
    .filter(Boolean).map(escapeHtml).join(' &middot; ');

  const details = [
    ['Business', state.business.name],
    ['Contact', state.business.contactName],
    ['Email', state.business.email],
    ['Phone', state.business.phone],
    ['Social media', state.business.socials],
    ['Frontage', state.setup.frontage ? `${state.setup.frontage} m` : ''],
    ['Depth', state.setup.depth ? `${state.setup.depth} m` : ''],
    ['Power', state.setup.ownPower],
    ['Power and water', state.setup.selfSufficient ? 'Bringing my own' : ''],
    ['Vehicle on site', state.setup.vehicleOnSite ? 'Yes' : ''],
    ['Documents', state.documents.length ? `${state.documents.length} attached` : ''],
  ].filter(([, v]) => v);

  host.innerHTML = `
    <div class="vs-checkout">

      <!-- WHAT YOU ARE BUYING -->
      <section class="vs-card">
        <header class="vs-card-head">
          <h3>Your Booking</h3>
          <button type="button" class="vs-pill" data-scroll-to="details">
            <svg viewBox="0 0 24 24" aria-hidden="true" class="vs-pill-ico">
              <path d="M4 20h4l10-10-4-4L4 16z"/>
              <path d="M14 6l4 4 2-2-4-4z"/>
            </svg>
            Edit booking
          </button>
        </header>

        ${eventLine ? `<p class="vs-card-sub">${eventLine}</p>` : ''}

        <div class="vs-lineitem">
          <span class="vs-lineitem-ico" aria-hidden="true">
            ${ITEM_ICONS[state.vendorType] || ITEM_ICONS.food}
          </span>
          <span class="vs-lineitem-txt">
            <strong>${escapeHtml(itemName)}</strong>
            <span>${itemSub}</span>
          </span>
        </div>

        <dl class="vs-figures">
          <div><dt>Price</dt><dd>${exact(perBay)}</dd></div>
          <div><dt>Qty</dt><dd>${bays}</dd></div>
          <div><dt>Total</dt><dd class="is-strong">${exact(b.siteCents)}</dd></div>
        </dl>
      </section>

      <!-- WHAT IT COSTS -->
      <section class="vs-card">
        <h3>Price Summary</h3>

        <dl class="vs-sum">
          <div><dt>Site total</dt><dd>${exact(b.siteCents)}</dd></div>
          <div>
            <dt>Booking fee
              <button type="button" class="vs-info" data-info
                      aria-expanded="false" aria-label="What is the booking fee?">i</button>
            </dt>
            <dd>${exact(b.bookingFeeCents)}</dd>
          </div>
          <div><dt>GST (10%)</dt><dd>${exact(b.gstCents)}</dd></div>
        </dl>

        <p class="vs-info-note" data-info-note hidden>
          4% of the site price plus 99c, which covers the card processing and
          running the booking system. It is charged once, not per bay.
        </p>

        <div class="vs-sum-total">
          <span>Total to pay</span>
          <strong>${b.totalCents === 0 ? 'Free' : exact(b.totalCents)}</strong>
        </div>
      </section>

      <!-- WHO TAKES THE MONEY -->
      <section class="vs-card vs-secure">
        <div class="vs-secure-head">
          <span class="vs-secure-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M7 10V7a5 5 0 0110 0v3" fill="none" stroke="currentColor" stroke-width="2"/>
              <rect x="4" y="10" width="16" height="10" rx="2"/>
            </svg>
          </span>
          <span>
            <strong>Secure payment via Stripe</strong>
            <span>Your information is encrypted and secure.</span>
          </span>
        </div>

        <ul class="vs-secure-row">
          <li><span aria-hidden="true">&#128737;</span> Safe &amp; secure</li>
          <li><span aria-hidden="true">&#128179;</span> All major cards</li>
          <li><span aria-hidden="true">&#127807;</span> Supports local events</li>
        </ul>
      </section>

      ${details.length ? `
        <details class="vs-card vs-yourdetails">
          <summary>Your details<span>${details.length} items</span></summary>
          <dl class="vs-summary-list">
            ${details.map(([k, v]) => `
              <div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join('')}
          </dl>
        </details>` : ''}

      <p class="vs-checkout-foot">
        Questions? The event details and the ones vendors usually ask are on
        <button type="button" class="vs-help-link" data-open-faqs>event info &amp; FAQs</button>.
      </p>
    </div>
  `;

  /*  Wired here rather than in wireStaticControls because this markup is
      rebuilt on every render. */
  host.querySelectorAll('[data-scroll-to]').forEach((btn) => {
    btn.addEventListener('click', () => goToSection(btn.getAttribute('data-scroll-to')));
  });

  host.querySelectorAll('[data-open-faqs]').forEach((btn) => {
    btn.addEventListener('click', () => {
      /*  The FAQs are folded away under the event cards now, so this both
          opens them and takes you there - opening something off screen
          reads as nothing happening.                                   */
      const faqs = document.querySelector('.vs-faqbox');
      if (faqs) {
        faqs.open = true;
        faqs.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  /*  The (i) beside the booking fee. A tooltip would be unreachable on a
      phone, so it opens a line of text instead. */
  const info = host.querySelector('[data-info]');
  const note = host.querySelector('[data-info-note]');
  if (info && note) {
    info.addEventListener('click', () => {
      note.hidden = !note.hidden;
      info.setAttribute('aria-expanded', String(!note.hidden));
    });
  }

  const payBtn = document.getElementById('vs-pay');
  if (payBtn) {
    payBtn.textContent = b.totalCents === 0
      ? 'Confirm booking'
      : `Pay ${exact(b.totalCents)} AUD`;
    payBtn.disabled = !state.siteLabel;
  }
}

/* -------------------------------------------------------------------------
   Static wiring
   ------------------------------------------------------------------------- */
function wireStaticControls() {
  // vendor type
  document.querySelectorAll('[data-vendor-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.vendorType = btn.getAttribute('data-vendor-type');

        document.querySelectorAll('[data-vendor-type]').forEach((b) => {
          b.classList.toggle('is-selected', b === btn);
        });

        setStepError('type', '');

        /* Size is no longer asked for here. A market stall is however many
           bays the vendor picks on the map, so the price follows from that
           and the flow moves straight on. */
        if (map) map.setVendorType(state.vendorType);

        /*  No jump. The price and the map both follow from this, so the
            page is re-rendered where it stands and the vendor carries on
            down the same section.                                     */
        render();
    });
  });

  // hold the bays picked on the map
  const holdBtn = document.getElementById('vs-site-confirm');
  if (holdBtn) holdBtn.addEventListener('click', holdChosenSites);

  /*  Continue. It checks its own section, keeps what is in it and takes
      you to the next one - it is a scroll, not a screen change, so the
      section you just filled in stays on the page behind you.        */
  document.querySelectorAll('[data-go]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sec = btn.closest('.vs-sec');
      const from = sec ? sec.getAttribute('data-sec') : null;

      if (from && !validateSection(from)) return;

      collectForm();
      saveDraft();
      renderSide();
      goToSection(btn.getAttribute('data-go'));
    });
  });

  /*  The rail and the side column follow the typing. One listener on the
      whole form rather than one per field, so fields added later are
      covered without anybody remembering to wire them.              */
  const form = document.getElementById('vs-flow');
  if (form) {
    form.addEventListener('input', onFormChange);
    form.addEventListener('change', onFormChange);
  }

  // documents
  const fileInput = document.getElementById('vs-file');
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const type = document.getElementById('vs-doc-type');
      const files = Array.from(fileInput.files || []);
      files.forEach((f) => uploadDocument(f, type ? type.value : 'Document'));
      fileInput.value = '';
    });
  }

  /*  The 0/300 under "What do you sell?". It is what we put in the
      marketing, so the limit is real and worth showing rather than
      cutting somebody off at the end.                              */
  const desc = document.getElementById('vs-biz-desc');
  const count = document.getElementById('vs-biz-desc-count');
  if (desc && count) {
    const tick = () => {
      if (desc.value.length > 300) desc.value = desc.value.slice(0, 300);
      count.textContent = desc.value.length + '/300';
    };
    desc.addEventListener('input', tick);
    tick();
  }

  watchScroll();

  // pay
  const payBtn = document.getElementById('vs-pay');
  if (payBtn) payBtn.addEventListener('click', payAndBook);

  // jump to the flow from the hero
  document.querySelectorAll('[data-start]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const anchor = document.getElementById('vs-flow');
      if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function collectForm() {
  state.business = {
    name: val('vs-biz-name'),
    contactName: val('vs-biz-contact'),
    email: val('vs-biz-email'),
    phone: val('vs-biz-phone'),
    socials: val('vs-biz-socials'),
    description: val('vs-biz-desc'),
  };

  state.setup = {
    frontage: val('vs-setup-frontage'),
    depth: val('vs-setup-depth'),
    /* All vendors run off their own power and water at this event, so what
       we record is what they are bringing, not what they want from us.
       Loud generators get placed away from the stage. */
    ownPower: val('vs-setup-own-power'),
    selfSufficient: document.getElementById('vs-setup-selfsufficient')?.checked || false,
    vehicleOnSite: document.getElementById('vs-setup-vehicle')?.checked || false,
    notes: val('vs-setup-notes'),
  };
}

function validateSection(id) {
  if (id === 'type') {
    setStepError('type', '');
    if (!state.vendorType) {
      setStepError('type', 'Please choose a vendor type.');
      return false;
    }
    return true;
  }

  /*  Business, what you sell and your setup are one section now, so they
      are checked in the order they appear on the page and the first thing
      missing is scrolled to - on a long section a message at the bottom
      can sit off screen and look like nothing happened.                */
  if (id === 'details') {
    setStepError('details', '');
    setStepError('category', '');
    setStepError('setup', '');

    const name = val('vs-biz-name');
    const contact = val('vs-biz-contact');
    const email = val('vs-biz-email');
    const phone = val('vs-biz-phone');

    if (!name || !contact || !email || !phone) {
      return fail('details', 'Please fill in business name, contact, email and phone.',
        'vs-biz-name');
    }
    if (!EMAIL_RE.test(email)) {
      return fail('details', 'That email address does not look right.', 'vs-biz-email');
    }
    if (!state.categoryId) {
      return fail('category', 'Please choose a category.', 'vs-categories');
    }
    if (!val('vs-setup-frontage') || !val('vs-setup-depth')) {
      return fail('setup', 'Please choose your frontage and depth.', 'vs-setup-frontage');
    }
    if (!val('vs-setup-own-power')) {
      return fail('setup', 'Please tell us what power you are bringing.', 'vs-setup-own-power');
    }

    /* Every vendor brings their own power and water to this event, so we
       ask them to say plainly that they can. */
    const ack = document.getElementById('vs-setup-selfsufficient');
    if (ack && !ack.checked) {
      return fail('setup', 'Please confirm you are bringing your own power and water.',
        'vs-setup-selfsufficient');
    }
    return true;
  }

  if (id === 'site') {
    setStepError('site', '');
    if (!state.siteId) {
      setStepError('site', 'Please choose a site on the map.');
      return false;
    }
    return true;
  }

  if (id === 'event') return !!state.eventId;

  return true;
}

/*  Everything, in order, for the pay button. It has to check the sections
    above it because on one page nobody is forced to walk through them -
    you can scroll straight past a half-filled one to the bottom.       */
function validateAll() {
  return ['type', 'details', 'site'].every((id) => {
    if (validateSection(id)) return true;
    goToSection(id);
    return false;
  });
}

/* Show the problem and take the vendor to the field it is about. */
function fail(where, message, focusId) {
  setStepError(where, message);

  const el = document.getElementById(focusId);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
  }

  return false;
}

/* -------------------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------------------- */
function val(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function setStepError(step, message) {
  const el = document.querySelector(`[data-error="${step}"]`);
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}

function setBusy(step, busy) {
  const el = document.querySelector(`[data-busy="${step}"]`);
  if (el) el.hidden = !busy;

  document.querySelectorAll(`[data-step="${step}"] button`).forEach((b) => {
    b.disabled = busy;
  });
}

function friendlyError(err) {
  const code = err && (err.code || err.message) || '';

  if (code.includes('already-exists')) return err.message;
  if (code.includes('resource-exhausted')) return err.message;
  if (code.includes('invalid-email')) return 'That email address does not look right.';
  if (code.includes('permission-denied')) return 'You do not have permission to do that.';

  /*  There is no sign-in screen to send anybody to any more, so these two
      mean the silent anonymous sign-in has not landed - a refresh is the
      honest advice, not "sign in". */
  if (code.includes('unauthenticated') || code.includes('admin-restricted-operation')) {
    return 'Lost your place for a moment. Please refresh the page and try again.';
  }

  return (err && err.message) || 'Something went wrong. Please try again.';
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value == null ? '' : value);
  return div.innerHTML;
}

/* Tidy up listeners if the page is left. */
window.addEventListener('beforeunload', () => {
  if (sitesUnsub) sitesUnsub();
  if (categoriesUnsub) categoriesUnsub();
  stopHoldCountdown();
});
