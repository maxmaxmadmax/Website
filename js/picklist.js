/* ==========================================================================
   CREW PICK LIST  -  picklist.html?t=<crewToken>   (Max, 16 Oct 2026)

   Shows a booked job's gear (no prices) grouped by category, with Packed and
   Returned ticks. Each tick saves straight away, so Max sees progress in
   admin and everyone on the crew link sees the same list. The list also
   refreshes itself every 20 seconds while it's open.
   ========================================================================== */
import { firebaseConfig, functionsRegion, isFirebaseConfigured } from './firebase-config.js?v=567';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

function esc(v) {
  const d = document.createElement('div');
  d.textContent = String(v == null ? '' : v);
  return d.innerHTML;
}
const token = () => new URLSearchParams(location.search).get('t') || '';

let callable = null;   // { get, tick } once Firebase is up
let data = null;       // the last pick list loaded
let busy = 0;          // ticks still saving - don't refresh over them

async function initFns() {
  const [{ initializeApp }, functions] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-functions.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const fns = functions.getFunctions(app, functionsRegion);
  callable = {
    get: functions.httpsCallable(fns, 'getPickList'),
    tick: functions.httpsCallable(fns, 'setPickTick'),
  };
}

/* "2026-10-20" -> "Tue 20 Oct 2026" */
function niceDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(/,/g, '');
}

/* the order categories appear in (anything else after, A-Z) */
const CAT_ORDER = ['Packages', 'Kits', 'Audio', 'Speaker', 'Mixer', 'Microphone', 'Amp', 'DI', 'IEM', 'Studio Monitor', 'Stands', 'Cable', 'Power',
  'Lighting', 'Truss', 'Stage', 'Furniture', 'Backline', 'DJ Mixer', 'Vision', 'Other'];
const catRank = (c) => { const i = CAT_ORDER.findIndex((x) => x.toLowerCase() === String(c).toLowerCase()); return i < 0 ? 50 : i; };

function counts() {
  const items = data.items || [];
  const t = data.ticks || {};
  const total = items.length;
  const packed = items.filter((i) => t[i.key] && t[i.key].packed).length;
  const returned = items.filter((i) => t[i.key] && t[i.key].returned).length;
  const pieces = items.reduce((n, i) => n + (i.qty || 0), 0);
  return { total, packed, returned, pieces };
}

function progressHtml() {
  const c = counts();
  const bar = (n, label, cls) => `
    <div class="pl-prog ${cls}">
      <span>${label} <b>${n} of ${c.total}</b></span>
      <i><em style="width:${c.total ? Math.round(100 * n / c.total) : 0}%"></em></i>
    </div>`;
  return bar(c.packed, 'Packed', 'is-packed') + bar(c.returned, 'Returned', 'is-returned');
}

function render() {
  const d = data;
  const t = d.ticks || {};
  const range = d.hire.startDate
    ? niceDay(d.hire.startDate) + (d.hire.endDate && d.hire.endDate !== d.hire.startDate ? ' &ndash; ' + niceDay(d.hire.endDate) : '')
    : esc(d.eventDate || '');
  const groups = {};
  (d.items || []).forEach((i) => { (groups[i.category || 'Other'] = groups[i.category || 'Other'] || []).push(i); });
  const cats = Object.keys(groups).sort((a, b) => catRank(a) - catRank(b) || a.localeCompare(b));
  const c = counts();
  const box = (i, field, label) => `
    <label class="pl-box${t[i.key] && t[i.key][field] ? ' is-on' : ''}">
      <input type="checkbox" data-key="${esc(i.key)}" data-field="${field}"${t[i.key] && t[i.key][field] ? ' checked' : ''}>
      <span aria-hidden="true">&#10003;</span><em>${label}</em>
    </label>`;
  const info = (label, value) => value ? `<div><dt>${label}</dt><dd>${value}</dd></div>` : '';
  const contact = [d.contact.name, d.contact.business].filter(Boolean).map(esc).join(' &middot; ')
    + (d.contact.phone ? `<br><a href="tel:${esc(d.contact.phone.replace(/[^\d+]/g, ''))}">${esc(d.contact.phone)}</a>` : '');
  const times = d.times.start || d.times.finish ? esc([d.times.start, d.times.finish].filter(Boolean).join(' – ')) : '';

  document.getElementById('pl-root').innerHTML = `
    <header class="pl-head">
      <img src="/images/logo-quote.png" alt="SoundzGood Whitsundays" class="pl-logo">
      <div class="pl-head-r"><h1>Pick list</h1><p>${esc(d.number)}</p></div>
    </header>

    <section class="pl-job">
      <h2>${esc(d.eventName || 'Job')}</h2>
      <dl class="pl-info">
        ${info('Hire dates', range)}
        ${info('Event times', times)}
        ${info('Where', esc(d.contact.address || d.town || ''))}
        ${info('Getting there', esc(d.delivery))}
        ${info('On-site contact', contact)}
        ${info('Crew', d.crew.map((x) => esc(x.name) + (x.note ? ' <small>' + esc(x.note) + '</small>' : '')).join('<br>'))}
      </dl>
      ${d.notes ? `<p class="pl-notes"><b>Notes:</b> ${esc(d.notes)}</p>` : ''}
      ${d.paidInFull ? '' : '<p class="pl-flag">Balance still owing on this job &mdash; check with Max before handing over gear.</p>'}
    </section>

    <section class="pl-progress" id="pl-progress">${progressHtml()}</section>

    <section class="pl-list">
      <p class="pl-count">${c.total} line${c.total === 1 ? '' : 's'} &middot; ${c.pieces} piece${c.pieces === 1 ? '' : 's'} in total</p>
      ${cats.map((cat) => `
        <div class="pl-cat">
          <h3>${esc(cat)}</h3>
          ${groups[cat].map((i) => `
            <div class="pl-row${t[i.key] && t[i.key].packed ? ' is-packed' : ''}">
              <span class="pl-qty">${esc(i.qty)}&times;</span>
              <span class="pl-name">${esc(i.name)}</span>
              <span class="pl-ticks">${box(i, 'packed', 'Packed')}${box(i, 'returned', 'Returned')}</span>
            </div>`).join('')}
        </div>`).join('')}
    </section>

    <footer class="pl-foot">
      <button type="button" class="pl-btn" id="pl-print">Print</button>
      <span id="pl-msg" class="pl-msg"></span>
      <span class="pl-sig">Packed by ____________________ &nbsp; Checked back in by ____________________</span>
    </footer>`;

  document.getElementById('pl-print').addEventListener('click', () => window.print());
}

/* a tick: show it straight away, save it, undo it if the save fails */
async function onTick(e) {
  const inp = e.target.closest('input[data-key]');
  if (!inp) return;
  const key = inp.getAttribute('data-key');
  const field = inp.getAttribute('data-field');
  const value = inp.checked;
  data.ticks = data.ticks || {};
  data.ticks[key] = { ...(data.ticks[key] || {}), [field]: value };
  inp.closest('.pl-box').classList.toggle('is-on', value);
  if (field === 'packed') inp.closest('.pl-row').classList.toggle('is-packed', value);
  document.getElementById('pl-progress').innerHTML = progressHtml();
  const msg = document.getElementById('pl-msg');
  busy++;
  try {
    await callable.tick({ token: token(), key, field, value });
    if (msg) msg.textContent = 'Saved';
  } catch (err) {
    data.ticks[key][field] = !value;
    inp.checked = !value;
    inp.closest('.pl-box').classList.toggle('is-on', !value);
    if (msg) msg.textContent = 'Could not save that tick - check your signal and try again.';
    document.getElementById('pl-progress').innerHTML = progressHtml();
  } finally {
    busy--;
  }
}

async function refresh() {
  if (busy || document.hidden) return;
  try {
    const res = await callable.get({ token: token() });
    if (busy) return;
    data = res.data;
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  } catch (e) { /* keep showing what we have */ }
}

function fail(text) {
  document.getElementById('pl-root').innerHTML = `<p class="pl-loading">${esc(text)}</p>`;
}

async function load() {
  if (!token()) return fail('No pick list in this link.');
  if (!isFirebaseConfigured) return fail('This link cannot be opened right now.');
  try {
    await initFns();
    const res = await callable.get({ token: token() });
    data = res.data;
    render();
    document.getElementById('pl-root').addEventListener('change', onTick);
    setInterval(refresh, 20000);
  } catch (err) {
    fail((err && err.message) || 'This pick list link is not valid.');
  }
}

/* test hook: render(sample) without Firebase (local preview only) */
export function renderSample(sample) {
  data = sample;
  render();
  callable = { tick: async () => ({ data: { ok: true } }) };
  document.getElementById('pl-root').addEventListener('change', onTick);
}

if (!window.__plTest) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
}
