/* ==========================================================================
   CREW PICK LIST  -  picklist.html?t=<crewToken>   (Max, 16 Oct 2026)

   Shows a booked job's gear (no prices) grouped by category, with Packed and
   Returned ticks. Each tick saves straight away, so Max sees progress in
   admin and everyone on the crew link sees the same list. The list also
   refreshes itself every 20 seconds while it's open.
   ========================================================================== */
import { firebaseConfig, functionsRegion, isFirebaseConfigured } from './firebase-config.js?v=672';

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

/*  SECTIONS LIKE THE QUOTE (Max, 20 Oct 2026). KEEP IN STEP with COST_GROUP
    in js/quote-view.js: inventory category -> the heading it sits under.  */
const COST_GROUP = {
  audio: 'Audio', mixer: 'Audio', amp: 'Audio', microphone: 'Audio', iem: 'Audio', di: 'Audio',
  'studio monitor': 'Audio', cable: 'Audio', stands: 'Audio',
  speaker: 'Audio', speakers: 'Audio', 'mic kit': 'Backline', drum: 'Backline', drums: 'Backline',
  lighting: 'Lighting', truss: 'Lighting',
  stage: 'Staging', furniture: 'Staging',
  backline: 'Backline', 'dj mixer': 'DJ equipment', vision: 'Vision', power: 'Audio',
};
const COST_GROUP_ORDER = ['Audio', 'Backline', 'Lighting', 'Staging', 'DJ equipment', 'Vision', 'Other'];
const sectionOf = (r) => (r.custom ? 'Other' : (COST_GROUP[String(r.category || '').trim().toLowerCase()] || 'Audio'));
const catLabel = (r) => { const c = String(r.category || '').trim(); return c ? c.charAt(0).toUpperCase() + c.slice(1) : 'Other'; };

/*  The lines that get ticks: the quote-style rows, or (older jobs) the totals. */
const tickLines = () => data.rows || data.items || [];
/*  A line's ticks - its own, or the ones saved before per item. */
const ticksOf = (r) => { const t = data.ticks || {}; return t[r.key] || (r.itemKey && t[r.itemKey]) || {}; };

function counts() {
  const items = tickLines();
  const total = items.length;
  const packed = items.filter((i) => ticksOf(i).packed).length;
  const returned = items.filter((i) => ticksOf(i).returned).length;
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

// &v=gear - the band / crew gear list: no ticks, no money flags (Max, 20 Oct 2026)
const GEAR_VIEW = new URLSearchParams(location.search).get('v') === 'gear';

/*  "18:30" -> "6:30pm" (the details form stores 24-hour time). Anything else is shown as-is. */
function niceTime(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return String(v || '');
  const h = +m[1];
  return (h % 12 || 12) + ':' + m[2] + (h < 12 ? 'am' : 'pm');
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
    <label class="pl-box${ticksOf(i)[field] ? ' is-on' : ''}">
      <input type="checkbox" data-key="${esc(i.key)}" data-field="${field}"${ticksOf(i)[field] ? ' checked' : ''}>
      <span aria-hidden="true">&#10003;</span><em>${label}</em>
    </label>`;
  const info = (label, value) => value ? `<div><dt>${label}</dt><dd>${value}</dd></div>` : '';
  const contact = [d.contact.name, d.contact.business].filter(Boolean).map(esc).join(' &middot; ')
    + (d.contact.phone ? `<br><a href="tel:${esc(d.contact.phone.replace(/[^\d+]/g, ''))}">${esc(d.contact.phone)}</a>` : '');
  const times = d.times.start || d.times.finish ? esc([niceTime(d.times.start), niceTime(d.times.finish)].filter(Boolean).join(' – ')) : '';
  // venue with a tap-for-directions link (falls back to the customer's address / town)
  const where = d.venue
    ? `${esc(d.venue)}<br><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.venue)}" target="_blank" rel="noopener">Directions &rarr;</a>`
    : esc(d.contact.address || d.town || '');

  const row = (i, sub, kit) => `
            <div class="pl-row${sub ? ' pl-sub' : ''}${ticksOf(i).packed ? ' is-packed' : ''}">
              <span class="pl-qty">${esc(i.qty)}&times;</span>
              <span class="pl-name">${sub ? '<span class="pl-arrow">&#9492;</span>' : ''}${esc(i.name)}${kit ? ' <span class="pl-kit">Kit</span>' : ''}</span>
              ${GEAR_VIEW ? '' : `<span class="pl-ticks">${box(i, 'packed', 'Packed')}${box(i, 'returned', 'Returned')}</span>`}
            </div>`;

  /*  Like the quote: Audio / Backline / Lighting... each item with its
      included parts under it (small category headings, A-Z).            */
  function quoteStyleList() {
    const units = [];
    d.rows.forEach((r) => { if (r.sub && units.length) units[units.length - 1].push(r); else units.push([r]); });
    units.forEach((u) => {
      const parts = u.slice(1).sort((a, b) => ((a.sysOrder != null ? a.sysOrder : 1e9) - (b.sysOrder != null ? b.sysOrder : 1e9))
        || catLabel(a).localeCompare(catLabel(b)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
      u.splice(1, u.length - 1, ...parts);
    });
    const bySec = {};
    units.forEach((u) => { (bySec[sectionOf(u[0])] = bySec[sectionOf(u[0])] || []).push(u); });
    return COST_GROUP_ORDER.filter((k) => bySec[k]).map((k) => `
        <div class="pl-cat">
          <h3>${esc(k)}</h3>
          ${bySec[k].map((u) => row(u[0], false, u.some((p) => p.sub && p.sysOrder != null)) + u.slice(1).map((p, j) => {
            const prev = j ? u[j] : null;
            // a kit's own parts keep the kit's order with no headings (like the quote builder)
            const head = p.sysOrder != null || (prev && catLabel(prev) === catLabel(p)) ? '' : `<p class="pl-subhead">${esc(catLabel(p))}</p>`;
            return head + row(p, true);
          }).join('')).join('')}
        </div>`).join('');
  }
  // older jobs saved before 20 Oct 2026: the totals by category
  function oldList() {
    return cats.map((cat) => `
        <div class="pl-cat">
          <h3>${esc(cat)}</h3>
          ${groups[cat].map((i) => row(i, false)).join('')}
        </div>`).join('');
  }

  document.getElementById('pl-root').innerHTML = `
    <header class="pl-head">
      <img src="/images/logo-quote.png" alt="SoundzGood Whitsundays" class="pl-logo">
      <div class="pl-head-r"><h1>${GEAR_VIEW ? 'Gear list' : 'Pick list'}</h1><p>${esc(d.number)}</p></div>
    </header>

    <section class="pl-job">
      <h2>${esc(d.eventName || 'Job')}</h2>
      <dl class="pl-info">
        ${info('Event date', esc(d.eventDate || ''))}
        ${info('Event starts', times)}
        ${info('Venue', where)}
        ${info('Hire dates', range)}
        ${info('Getting there', esc(d.delivery))}
        ${info('Event day contact', d.dayContact ? esc(d.dayContact).replace(/(\+?\d[\d\s]{7,}\d)/, (n) => '<a href="tel:' + n.replace(/\s/g, '') + '">' + n + '</a>') : '')}
        ${info(d.dayContact ? 'Customer' : 'On-site contact', contact)}
        ${info('Working it', (d.assigned || []).map((x) => esc(x.name) + (x.phone ? ' <small><a href="tel:' + esc(x.phone.replace(/[^\d+]/g, '')) + '">' + esc(x.phone) + '</a></small>' : '')).join('<br>'))}
        ${info('Crew', d.crew.map((x) => esc(x.name) + (x.note ? ' <small>' + esc(x.note) + '</small>' : '')).join('<br>'))}
      </dl>
      ${d.customerNotes ? `<p class="pl-notes"><b>From the customer:</b> ${esc(d.customerNotes)}</p>` : ''}
      ${d.notes ? `<p class="pl-notes"><b>Notes:</b> ${esc(d.notes)}</p>` : ''}
      ${GEAR_VIEW ? '<p class="pl-notes">This is the gear SoundzGood Whitsundays is supplying. Anything missing? Call Max on 0422 393 022.</p>' : d.paidInFull ? '' : '<p class="pl-flag">Balance still owing on this job &mdash; check with Max before handing over gear.</p>'}
    </section>

    ${GEAR_VIEW ? '' : `<section class="pl-progress" id="pl-progress">${progressHtml()}</section>`}

    <section class="pl-list">
      <p class="pl-count">${c.total} line${c.total === 1 ? '' : 's'} &middot; ${c.pieces} piece${c.pieces === 1 ? '' : 's'} in total</p>
      ${d.rows ? quoteStyleList() : oldList()}
    </section>

    <footer class="pl-foot">
      <button type="button" class="pl-btn" id="pl-print">Print</button>
      <span id="pl-msg" class="pl-msg"></span>
      ${GEAR_VIEW ? '' : '<span class="pl-sig">Packed by ____________________ &nbsp; Checked back in by ____________________</span>'}
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
  const line = tickLines().find((r) => r.key === key) || { key };
  data.ticks[key] = { ...ticksOf(line), [field]: value };
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
    const res = await callable.get({ token: token(), gear: GEAR_VIEW });
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
    const res = await callable.get({ token: token(), gear: GEAR_VIEW });
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
