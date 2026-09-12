/* --------------------------------------------------------------------------
   Eatz & Beatz - vendor signup flow

   Vendor type -> event info and FAQs -> what you sell -> site on the map
   -> business and setup -> documents -> review -> pay -> confirmation.

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
  eventId,
  isFirebaseConfigured,
} from './firebase-config.js?v=32';

import { VendorMap, previewLayout, previewCategories } from './vendor-map.js?v=32';

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

function vendorLabel() {
  if (state.vendorType === 'food') return 'Food Vendor (6 m x 3 m)';

  if (state.vendorType === 'market') {
    const n = state.bayCount || 1;
    return `Market Stall (${n} x 3 m bay${n > 1 ? 's' : ''}, ${n * 3} m frontage)`;
  }

  return '';
}

/* What you sell comes before the map, because a category that is already
   full should stop a vendor before they get attached to a site. The site
   then comes before business details, so they can see what is left without
   filling anything in first. */
const STEPS = ['type', 'info', 'category', 'site', 'details', 'documents', 'review'];

/* -------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */
const state = {
  step: 'type',
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
    subscribeCategories();
  } catch (err) {
    console.error('Firebase failed to start', err);
    state.preview = true;
    showPreviewBanner('Could not reach Firebase. Showing a preview only.');
    startPreview();
    return;
  }

  buildMap();
  subscribeSites();
  handleReturnFromStripe();
  render();
}

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
  onSnapshot(doc(fb.db, 'events', eventId), (snap) => {
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
    collection(fb.db, 'events', eventId, 'sites'),
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
    collection(fb.db, 'events', eventId, 'categories'),
    (snap) => {
      categories = [];
      snap.forEach((d) => categories.push({ id: d.id, ...d.data() }));
      categories.sort((a, b) => a.name.localeCompare(b.name));
      if (state.step === 'category') renderCategories();
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
    const res = await call({ eventId, siteIds: ids, bookingId: state.bookingId });

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
    eventId,
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
function handleReturnFromStripe() {
  const params = new URLSearchParams(window.location.search);
  const bookingId = params.get('booking');

  if (!bookingId) return;

  state.bookingId = bookingId;
  localStorage.setItem('sg-vendor-booking', bookingId);

  if (params.get('cancelled')) {
    setStepError('review', 'Checkout was cancelled. Your site is still held for a few minutes.');
    goTo('review');
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
  document.querySelectorAll('.vs-step').forEach((s) => { s.hidden = true; });
  const stepper = document.getElementById('vs-stepper');
  if (stepper) stepper.hidden = true;
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
  const stepper = document.getElementById('vs-stepper');

  if (confirming) confirming.hidden = true;
  if (stepper) stepper.hidden = true;
  document.querySelectorAll('.vs-step').forEach((s) => { s.hidden = true; });

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
   Steps and rendering
   ------------------------------------------------------------------------- */
function visibleSteps() {
  return STEPS.slice();
}

function goTo(step) {
  state.step = step;
  render();
  const anchor = document.getElementById('vs-flow');
  if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function nextStep() {
  const steps = visibleSteps();
  const i = steps.indexOf(state.step);
  if (i < steps.length - 1) goTo(steps[i + 1]);
}

function prevStep() {
  const steps = visibleSteps();
  const i = steps.indexOf(state.step);
  if (i > 0) goTo(steps[i - 1]);
}

function render() {
  if (state.confirmed) return;

  const steps = visibleSteps();
  if (!steps.includes(state.step)) state.step = steps[0];

  document.querySelectorAll('.vs-step').forEach((el) => {
    el.hidden = el.getAttribute('data-step') !== state.step;
  });

  renderStepper(steps);

  if (state.step === 'category') renderCategories();
  if (state.step === 'site') {
    if (map) map.setVendorType(state.vendorType);
    renderSiteChoice();
    renderMapMeta();
    renderSignInPrompt();
  }
  if (state.step === 'review') renderReview();
  if (state.step === 'documents') renderDocumentList();
}

/*  THE STEP HEADER

    A back link, a step counter and one segment per step. This replaced a
    row of seven labelled pills: the labels needed the full desktop width
    to be readable, and on a phone they collapsed to seven bare numbers,
    which told nobody anything. A filling bar reads the same at any size.

    It is rebuilt on every render, so the back link is wired here rather
    than in wireStaticControls - a listener attached at load would be
    thrown away with the markup on the first step change. That is also
    why it uses its own attribute instead of [data-back].               */
function renderStepper(steps) {
  const host = document.getElementById('vs-stepper');
  if (!host) return;

  const current = steps.indexOf(state.step);
  const total = steps.length;

  host.innerHTML = `
    <div class="vs-progress-top">
      ${current > 0
        ? `<button type="button" class="vs-progress-back" data-progress-back>
             <span aria-hidden="true">&#8592;</span> Back
           </button>`
        : '<span></span>'}
      <span class="vs-progress-count">Step ${current + 1} of ${total}</span>
    </div>

    <div class="vs-progress-bar" role="progressbar" aria-label="Signup progress"
         aria-valuemin="1" aria-valuemax="${total}" aria-valuenow="${current + 1}">
      <span style="width:${(((current + 1) / total) * 100).toFixed(2)}%"></span>
    </div>
  `;

  const back = host.querySelector('[data-progress-back]');
  if (back) back.addEventListener('click', prevStep);
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
function renderSignInPrompt() {
  const wrap = document.getElementById('vs-auth');
  if (wrap) wrap.hidden = true;
}

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
          <button type="button" class="vs-pill" data-goto-step="details">
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
        <button type="button" class="vs-help-link" data-goto-step="info">step two</button>.
      </p>
    </div>
  `;

  /*  Wired here rather than in wireStaticControls because this markup is
      rebuilt on every render. */
  host.querySelectorAll('[data-goto-step]').forEach((btn) => {
    btn.addEventListener('click', () => goTo(btn.getAttribute('data-goto-step')));
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
        nextStep();
    });
  });

  // hold the bays picked on the map
  const holdBtn = document.getElementById('vs-site-confirm');
  if (holdBtn) holdBtn.addEventListener('click', holdChosenSites);

  // next / back
  document.querySelectorAll('[data-next]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!validateStep(state.step)) return;
      collectStep(state.step);
      saveDraft();
      nextStep();
    });
  });

  document.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', prevStep);
  });

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

function collectStep(step) {
  if (step === 'details') {
    state.business = {
      name: val('vs-biz-name'),
      contactName: val('vs-biz-contact'),
      email: val('vs-biz-email'),
      phone: val('vs-biz-phone'),
      socials: val('vs-biz-socials'),
      description: val('vs-biz-desc'),
    };

    // Business, category and setup share a step, so the setup fields are
    // read in the same pass.
    state.setup = {
      frontage: val('vs-setup-frontage'),
      depth: val('vs-setup-depth'),
      // All vendors run off their own power and water at this event, so
      // what we record is what they are bringing, not what they want from
      // us. Loud generators get placed away from the stage.
      ownPower: val('vs-setup-own-power'),
      selfSufficient: document.getElementById('vs-setup-selfsufficient')?.checked || false,
      vehicleOnSite: document.getElementById('vs-setup-vehicle')?.checked || false,
      notes: val('vs-setup-notes'),
    };
  }
}

function validateStep(step) {
  setStepError(step, '');

  if (step === 'type' && !state.vendorType) {
    setStepError('type', 'Please choose a vendor type.');
    return false;
  }

  if (step === 'category' && !state.categoryId) {
    setStepError('category', 'Please choose a category.');
    return false;
  }

  /* Business and setup share a step, so they share one error line. Checked
     in the order they appear on the page, and the first thing missing is
     scrolled to - otherwise on a long step the message can sit off screen
     and look like nothing happened. */
  if (step === 'details') {
    const name = val('vs-biz-name');
    const contact = val('vs-biz-contact');
    const email = val('vs-biz-email');
    const phone = val('vs-biz-phone');

    if (!name || !contact || !email || !phone) {
      return failDetails('Please fill in business name, contact, email and phone.',
        'vs-biz-name');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return failDetails('That email address does not look right.', 'vs-biz-email');
    }

    if (!val('vs-setup-frontage') || !val('vs-setup-depth')) {
      return failDetails('Please choose your frontage and depth.', 'vs-setup-frontage');
    }

    if (!val('vs-setup-own-power')) {
      return failDetails('Please tell us what power you are bringing.',
        'vs-setup-own-power');
    }

    // Every vendor brings their own power and water to this event, so we
    // ask them to say plainly that they can.
    const ack = document.getElementById('vs-setup-selfsufficient');
    if (ack && !ack.checked) {
      return failDetails('Please confirm you are bringing your own power and water.',
        'vs-setup-selfsufficient');
    }
  }

  if (step === 'site' && !state.siteId) {
    setStepError('site', 'Please choose a site on the map.');
    return false;
  }

  return true;
}

/* Show the problem and take the vendor to the field it is about. */
function failDetails(message, focusId) {
  setStepError('details', message);

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
