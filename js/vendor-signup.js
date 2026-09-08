/* --------------------------------------------------------------------------
   Eatz & Beatz - vendor signup flow

   Vendor type -> business details -> category -> setup -> documents ->
   site on the map -> review -> pay -> confirmation.

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
} from './firebase-config.js';

import { VendorMap, previewLayout, previewCategories } from './vendor-map.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

/* Prices shown before the server confirms them. The server prices from the
   event document; these are only for display. Market stalls are priced by
   marquee size, so their key is market-<size>. */
const PRICING = {
  'food': { cents: 10000, label: '$100' },
  'market-3x3': { cents: 5000, label: '$50' },
  'market-3x6': { cents: 8000, label: '$80' },
  'community': { cents: 0, label: 'Free' },
};

const VENDOR_LABEL = {
  food: 'Food Vendor',
  market: 'Market Stall',
  community: 'Non-Food Community Group',
};

/* Matches priceKeyFor() in functions/index.js */
function priceKey() {
  if (state.vendorType === 'market') {
    return `market-${state.stallSize || '3x3'}`;
  }
  return state.vendorType;
}

function priceInfo() {
  return PRICING[priceKey()] || PRICING.community;
}

function vendorLabel() {
  const base = VENDOR_LABEL[state.vendorType] || '';
  if (state.vendorType === 'market' && state.stallSize) {
    return `${base} (${state.stallSize}m marquee)`;
  }
  return base;
}

const STEPS = ['type', 'business', 'category', 'setup', 'documents', 'site', 'review'];

/* -------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */
const state = {
  step: 'type',
  preview: !isFirebaseConfigured,

  vendorType: null,
  stallSize: null,        // market only: '3x3' or '3x6'
  business: {},
  categoryId: null,
  categoryName: null,
  setup: {},
  documents: [],
  siteId: null,
  siteLabel: null,

  bookingId: null,
  holdExpiresAt: null,
  user: null,
  confirmed: null,
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
function watchAuth() {
  fb.a.onAuthStateChanged(fb.auth, (user) => {
    state.user = user;
    if (map) map.setUid(user ? user.uid : null);
    renderAccountBar();
    if (user) loadExistingBooking();
    render();
  });
}

async function signUp(email, password) {
  const cred = await fb.a.createUserWithEmailAndPassword(fb.auth, email, password);
  return cred.user;
}

async function signIn(email, password) {
  const cred = await fb.a.signInWithEmailAndPassword(fb.auth, email, password);
  return cred.user;
}

function renderAccountBar() {
  const bar = document.getElementById('vs-account');
  if (!bar) return;

  if (state.user) {
    bar.innerHTML = `
      <span class="vs-account-email">Signed in as ${escapeHtml(state.user.email || 'vendor')}</span>
      <button type="button" class="vs-link" id="vs-signout">Sign out</button>
    `;
    const btn = document.getElementById('vs-signout');
    if (btn) btn.addEventListener('click', () => fb.a.signOut(fb.auth));
  } else {
    bar.innerHTML = '';
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
  const price = document.querySelectorAll('[data-price]');
  price.forEach((el) => {
    const type = el.getAttribute('data-price');
    if (ev.pricing && ev.pricing[type] != null) {
      el.textContent = ev.pricing[type] === 0
        ? 'Free'
        : `$${(ev.pricing[type] / 100).toFixed(0)}`;
    }
  });
}

/* -------------------------------------------------------------------------
   Map
   ------------------------------------------------------------------------- */
function buildMap() {
  const host = document.getElementById('vs-map');
  if (!host) return;

  map = new VendorMap(host, {
    onSelect: (site) => chooseSite(site),
  });

  if (state.user) map.setUid(state.user.uid);
}

function renderMapMeta() {
  const legend = document.getElementById('vs-map-counts');
  if (!legend || !map) return;

  const c = map.counts();
  legend.textContent = state.vendorType
    ? `${c.available} available for ${vendorLabel().toLowerCase()}` +
      (c.mine ? ` · ${c.mine} held by you` : '')
    : '';
}

async function chooseSite(site) {
  if (state.preview) {
    state.siteId = site.id;
    state.siteLabel = site.label;
    map.setSelected(site.id);
    renderSiteChoice();
    return;
  }

  if (!state.user) {
    setStepError('site', 'Please create an account or sign in before choosing a site.');
    return;
  }

  setBusy('site', true);
  setStepError('site', '');

  try {
    await ensureBookingDoc();

    const call = fb.fn.httpsCallable(fb.fns, 'holdSite');
    const res = await call({ eventId, siteId: site.id, bookingId: state.bookingId });

    state.siteId = site.id;
    state.siteLabel = res.data.siteLabel;
    state.holdExpiresAt = res.data.holdExpiresAt;

    map.setSelected(site.id);
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
      state.siteLabel = null;
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
    stallSize: state.stallSize,
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
    stallSize: state.stallSize,
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
    state.business = b.business || {};
    state.categoryId = b.categoryId || null;
    state.setup = b.setup || {};
    state.documents = b.documents || [];
    state.siteId = b.siteId || null;
    state.siteLabel = b.siteLabel || null;

    if (map) {
      map.setVendorType(state.vendorType, state.stallSize);
      map.setSelected(state.siteId);
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
    setStepError('documents', 'Please create an account or sign in before uploading.');
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
/* Food vendors and market stalls both pick a category. Community groups
   do not, so that step drops out of the flow for them. */
function needsCategory() {
  return state.vendorType === 'food' || state.vendorType === 'market';
}

function visibleSteps() {
  return STEPS.filter((s) => s !== 'category' || needsCategory());
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
    if (map) map.setVendorType(state.vendorType, state.stallSize);
    renderSiteChoice();
    renderMapMeta();
    renderSignInPrompt();
  }
  if (state.step === 'review') renderReview();
  if (state.step === 'documents') renderDocumentList();
}

function renderStepper(steps) {
  const host = document.getElementById('vs-stepper');
  if (!host) return;

  const names = {
    type: 'Vendor type',
    business: 'Business',
    category: 'Category',
    setup: 'Setup',
    documents: 'Documents',
    site: 'Your site',
    review: 'Review & pay',
  };

  const current = steps.indexOf(state.step);

  host.innerHTML = steps.map((s, i) => `
    <li class="vs-stepper-item ${i === current ? 'is-current' : ''} ${i < current ? 'is-done' : ''}">
      <span class="vs-stepper-num">${i + 1}</span>
      <span class="vs-stepper-name">${names[s]}</span>
    </li>
  `).join('');
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
  if (!out) return;

  out.textContent = state.siteLabel
    ? `Selected: site ${state.siteLabel}`
    : 'No site selected yet.';
  out.classList.toggle('is-chosen', Boolean(state.siteLabel));
}

function renderSignInPrompt() {
  const wrap = document.getElementById('vs-auth');
  if (!wrap) return;
  wrap.hidden = state.preview || Boolean(state.user);
}

function renderReview() {
  const host = document.getElementById('vs-review');
  if (!host) return;

  const price = priceInfo();

  const rows = [
    ['Vendor type', vendorLabel() || '-'],
    ['Business', state.business.name || '-'],
    ['Contact', state.business.contactName || '-'],
    ['Email', state.business.email || '-'],
    ['Phone', state.business.phone || '-'],
  ];

  if (needsCategory()) {
    rows.push(['Category', state.categoryName || '-']);
  }

  rows.push(
    ['Frontage', state.setup.frontage ? `${state.setup.frontage} m` : '-'],
    ['Depth', state.setup.depth ? `${state.setup.depth} m` : '-'],
    ['Own power', state.setup.ownPower || '-'],
    ['Power and water', state.setup.selfSufficient ? 'Bringing my own' : 'Not confirmed'],
    ['Arrival', state.setup.arrivalTime || '-'],
    ['Documents', state.documents.length ? `${state.documents.length} attached` : 'None'],
    ['Site', state.siteLabel || 'Not chosen']
  );

  host.innerHTML = `
    <dl class="vs-summary-list">
      ${rows.map(([k, v]) => `
        <div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>
      `).join('')}
    </dl>

    <div class="vs-total">
      <span>Total</span>
      <strong>${price.label}${price.cents ? ' AUD' : ''}</strong>
    </div>
  `;

  const payBtn = document.getElementById('vs-pay');
  if (payBtn) {
    payBtn.textContent = price.cents === 0 ? 'Confirm Booking' : `Pay ${price.label} and Book`;
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
      state.stallSize = btn.getAttribute('data-stall-size') || null;

      document.querySelectorAll('[data-vendor-type]').forEach((b) => {
        b.classList.toggle('is-selected', b === btn);
      });

      if (map) map.setVendorType(state.vendorType, state.stallSize);
      setStepError('type', '');
      nextStep();
    });
  });

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

  // auth
  const authForm = document.getElementById('vs-auth-form');
  if (authForm) {
    authForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const email = document.getElementById('vs-auth-email').value.trim();
      const pw = document.getElementById('vs-auth-password').value;
      const mode = authForm.getAttribute('data-mode') || 'signup';

      setStepError('auth', '');
      setBusy('auth', true);

      try {
        if (mode === 'signup') await signUp(email, pw);
        else await signIn(email, pw);
      } catch (err) {
        setStepError('auth', friendlyError(err));
      } finally {
        setBusy('auth', false);
      }
    });
  }

  document.querySelectorAll('[data-auth-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-auth-mode');
      const form = document.getElementById('vs-auth-form');
      if (form) form.setAttribute('data-mode', mode);

      document.querySelectorAll('[data-auth-mode]').forEach((b) => {
        b.classList.toggle('is-selected', b === btn);
      });

      const submit = document.getElementById('vs-auth-submit');
      if (submit) submit.textContent = mode === 'signup' ? 'Create Account' : 'Sign In';
    });
  });

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
  if (step === 'business') {
    state.business = {
      name: val('vs-biz-name'),
      contactName: val('vs-biz-contact'),
      email: val('vs-biz-email'),
      phone: val('vs-biz-phone'),
      abn: val('vs-biz-abn'),
      description: val('vs-biz-desc'),
    };
  }

  if (step === 'setup') {
    state.setup = {
      frontage: val('vs-setup-frontage'),
      depth: val('vs-setup-depth'),
      // All vendors run off their own power and water at this event, so
      // what we record is what they are bringing, not what they want from us.
      ownPower: val('vs-setup-own-power'),
      powerDetails: val('vs-setup-power-details'),
      selfSufficient: document.getElementById('vs-setup-selfsufficient')?.checked || false,
      vehicleOnSite: document.getElementById('vs-setup-vehicle')?.checked || false,
      arrivalTime: val('vs-setup-arrival'),
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

  if (step === 'business') {
    const name = val('vs-biz-name');
    const contact = val('vs-biz-contact');
    const email = val('vs-biz-email');
    const phone = val('vs-biz-phone');

    if (!name || !contact || !email || !phone) {
      setStepError('business', 'Please fill in business name, contact, email and phone.');
      return false;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStepError('business', 'That email address does not look right.');
      return false;
    }
  }

  if (step === 'category' && needsCategory() && !state.categoryId) {
    setStepError('category', 'Please choose a category.');
    return false;
  }

  if (step === 'setup') {
    if (!val('vs-setup-frontage') || !val('vs-setup-depth')) {
      setStepError('setup', 'Please give us your frontage and depth in metres.');
      return false;
    }

    // Every vendor brings their own power and water to this event, so we
    // ask them to say plainly that they can.
    const ack = document.getElementById('vs-setup-selfsufficient');
    if (ack && !ack.checked) {
      setStepError('setup',
        'Please confirm you are bringing your own power and water.');
      return false;
    }
  }

  if (step === 'site' && !state.siteId) {
    setStepError('site', 'Please choose a site on the map.');
    return false;
  }

  return true;
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
  if (code.includes('email-already-in-use')) {
    return 'That email already has an account. Switch to Sign In above.';
  }
  if (code.includes('weak-password')) return 'Please use at least 6 characters.';
  if (code.includes('invalid-email')) return 'That email address does not look right.';
  if (code.includes('wrong-password') || code.includes('invalid-credential')) {
    return 'Email or password was not right.';
  }
  if (code.includes('permission-denied')) return 'You do not have permission to do that.';
  if (code.includes('unauthenticated')) return 'Please sign in first.';

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
