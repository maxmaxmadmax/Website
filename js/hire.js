/* ==========================================================================
   EQUIPMENT HIRE  -  the public catalogue

   Reads the same `inventory` collection the admin manages and the estimate
   bot prices from, so the gear and prices shown here are always in step. A
   category filter narrows the grid; every card's "Enquire" button opens the
   estimate bot (js/quote-bot.js, via data-open-quote-bot).

   Public read only - nothing here writes. If Firebase is not configured the
   page shows a friendly empty state rather than throwing.
   ========================================================================== */

import { firebaseConfig, isFirebaseConfigured } from './firebase-config.js?v=128';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

let items = [];
let activeCat = 'all';

const money = (cents) => '$' + Math.round((cents || 0) / 100).toLocaleString('en-AU');

function esc(value) {
  const d = document.createElement('div');
  d.textContent = String(value == null ? '' : value);
  return d.innerHTML;
}

/*  Category pills get a stable colour from the name - same idea as the admin
    table, so "Audio" reads the same everywhere.                           */
const CAT_CLASSES = ['hc1', 'hc2', 'hc3', 'hc4', 'hc5', 'hc6'];
function catClass(cat) {
  if (!cat) return 'hc0';
  let h = 0;
  for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
  return CAT_CLASSES[h % CAT_CLASSES.length];
}

async function load() {
  if (!isFirebaseConfigured) return renderEmpty('The catalogue is not connected yet.');

  try {
    const [{ initializeApp }, firestore] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);
    const app = initializeApp(firebaseConfig);
    const db = firestore.getFirestore(app);
    const snap = await firestore.getDocs(firestore.collection(db, 'inventory'));

    items = [];
    snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
    items = items.filter((it) => it && it.name);
    items.sort((a, b) =>
      (a.category || '').localeCompare(b.category || '')
      || (a.name || '').localeCompare(b.name || ''));

    renderFilters();
    renderGrid();
  } catch (err) {
    renderEmpty('We could not load the gear just now. Please try again later.');
  }
}

function categories() {
  const set = [];
  items.forEach((it) => {
    const c = (it.category || '').trim();
    if (c && !set.includes(c)) set.push(c);
  });
  return set.sort((a, b) => a.localeCompare(b));
}

function renderFilters() {
  const host = document.getElementById('hire-filters');
  if (!host) return;
  const cats = categories();
  if (!cats.length) { host.innerHTML = ''; return; }

  const chip = (val, label) =>
    `<button type="button" class="hire-chip${activeCat === val ? ' is-on' : ''}"
             data-cat="${esc(val)}">${esc(label)}</button>`;

  host.innerHTML = chip('all', 'All gear') + cats.map((c) => chip(c, c)).join('');

  host.querySelectorAll('[data-cat]').forEach((b) => {
    b.addEventListener('click', () => {
      activeCat = b.getAttribute('data-cat');
      renderFilters();
      renderGrid();
    });
  });
}

function renderGrid() {
  const host = document.getElementById('hire-grid');
  if (!host) return;

  const list = activeCat === 'all'
    ? items : items.filter((it) => (it.category || '') === activeCat);

  if (!list.length) {
    host.innerHTML = '<p class="hire-empty">No gear in this category yet '
      + '&mdash; <a href="/contact">get in touch</a> and we’ll sort you out.</p>';
    return;
  }

  host.innerHTML = list.map(card).join('');
}

function card(it) {
  const cls = catClass(it.category);
  const media = it.photoUrl
    ? `<img src="${esc(it.photoUrl)}" alt="${esc(it.name)}" loading="lazy">`
    : `<span class="hire-noimg ${cls}" aria-hidden="true">${esc((it.category || it.name || '?').trim().charAt(0).toUpperCase())}</span>`;

  const price = it.priceCents
    ? `<p class="hire-price">${money(it.priceCents)} <span>/ day</span></p>` : '';

  return `
    <article class="hire-card">
      <div class="hire-media">${media}</div>
      <div class="hire-body">
        ${it.category ? `<span class="hire-cat ${cls}">${esc(it.category)}</span>` : ''}
        <h3 class="hire-name">${esc(it.name)}</h3>
        ${it.subtitle ? `<p class="hire-sub">${esc(it.subtitle)}</p>` : ''}
        <div class="hire-foot">
          ${price}
          <button type="button" class="hire-enquire" data-open-quote-bot>Enquire</button>
        </div>
      </div>
    </article>`;
}

function renderEmpty(msg) {
  const host = document.getElementById('hire-grid');
  if (host) host.innerHTML = `<p class="hire-empty">${esc(msg)} `
    + '<a href="/contact">Contact us</a> and we’ll help.</p>';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', load);
} else {
  load();
}
