/* ==========================================================================
   CREW PICK LIST  -  picklist.html?t=<crewToken>

   Shows a booked job's gear (no prices) grouped by category, with Packed and
   Returned ticks. Each tick saves straight away, so admin and everyone on
   the crew link see the same list. Refreshes itself every 20 seconds.
   ========================================================================== */
import { firebaseConfig, functionsRegion, isFirebaseConfigured } from './firebase-config.js?v=748';

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
    addExtra: functions.httpsCallable(fns, 'addPickExtra'),
    removeExtra: functions.httpsCallable(fns, 'removePickExtra'),
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

/*  Sections like the quote. KEEP IN STEP with COST_GROUP in
    js/quote-view.js: inventory category -> the heading it sits under.  */
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
const tickLines = () => (data.rows || data.items || []).concat(GEAR_VIEW ? [] : (data.extras || []));   // + extra gear
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

// &v=gear - the band / crew gear list: no ticks, no money flags
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
              <span class="pl-name">${sub ? '<span class="pl-arrow">&#9492;</span>' : ''}${i.photo ? `<button type="button" class="pl-pic" data-photo="${esc(i.photo)}" data-name="${esc(i.name)}" aria-label="See a photo of ${esc(i.name)}"><img src="${esc(i.photo)}" alt="" loading="lazy"></button>` : ''}${i.photo ? `<button type="button" class="pl-picname" data-photo="${esc(i.photo)}" data-name="${esc(i.name)}">${esc(i.name)}</button>` : esc(i.name)}${kit ? ' <span class="pl-kit">Kit</span>' : ''}</span>
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
  // older jobs: the totals by category
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
      <div class="pl-head-r"><h1>${GEAR_VIEW ? (d.brief ? 'Gig brief' + (c.total ? ' &amp; gear' : '') : 'Gear list') : 'Pick list'}</h1><p>${esc(d.number)}</p></div>
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

    ${d.brief ? briefHtml(d.brief, c.total) : ''}

    ${GEAR_VIEW ? '' : `<section class="pl-progress" id="pl-progress">${progressHtml()}</section>`}

    <section class="pl-list"${d.brief && !c.total ? ' hidden' : ''}>
      <p class="pl-count">${c.total} line${c.total === 1 ? '' : 's'} &middot; ${c.pieces} piece${c.pieces === 1 ? '' : 's'} in total</p>
      ${d.rows ? quoteStyleList() : oldList()}
    </section>

    ${GEAR_VIEW ? '' : extrasHtml(row)}

    <footer class="pl-foot">
      <button type="button" class="pl-btn" id="pl-print">Print</button>
      <span id="pl-msg" class="pl-msg"></span>
      ${GEAR_VIEW ? '' : '<span class="pl-sig">Packed by ____________________ &nbsp; Checked back in by ____________________</span>'}
    </footer>`;

  document.getElementById('pl-print').addEventListener('click', () => window.print());
}

/*  THE BRIEF for a DJ gig: set times, the booking notes and the venue's
    notes, address and contact. No SoundzGood gear on the job = the venue
    supplies it, and that's said plainly.                              */
function briefHtml(b, gearLines) {
  const tel = (t) => esc(t).replace(/(\+?\d[\d\s]{7,}\d)/, (n) => '<a href="tel:' + n.replace(/\s/g, '') + '">' + n + '</a>');
  const set = b.start || b.finish ? esc([niceTime(b.start), niceTime(b.finish)].filter(Boolean).join(' – ')) : '';
  const row = (k, v) => v ? '<div><dt>' + esc(k) + '</dt><dd>' + v + '</dd></div>' : '';
  return `
    <section class="pl-job pl-brief">
      <h2>The brief</h2>
      <dl class="pl-info">
        ${row('DJ', esc(b.dj))}
        ${row('Set times', set)}
        ${row('Venue address', esc(b.address))}
        ${row('Venue contact', b.venueContact ? tel(b.venueContact) : '')}
        ${row('Your deck', esc(b.deck))}
      </dl>
      ${b.notes ? '<p class="pl-notes"><b>About the gig:</b>\n' + esc(b.notes) + '</p>' : ''}
      ${b.venueNotes ? '<p class="pl-notes"><b>Venue notes:</b>\n' + esc(b.venueNotes) + '</p>' : ''}
      ${gearLines ? '' : '<p class="pl-notes"><b>Gear:</b> the venue supplies the PA and decks (at least a Pioneer XDJ-RX3, or 2 × CDJ-3000 with a DJM-A9). Check with the venue before the night.</p>'}
    </section>`;
}

/*  EXTRA GEAR: gear going out that isn't on the quote - the crew add it
    here so it gets ticked out and back. No prices, and it never changes
    the quote. Pick from our inventory or type anything.               */
/* the × to take an extra off, at the end of its row (after the ticks) */
function withDel(html, x) {
  const btn = '<button type="button" class="pl-xdel" data-x-del="' + esc(x.key) + '" aria-label="Remove ' + esc(x.name) + '">&times;</button>';
  const at = html.lastIndexOf('</span>');
  return at < 0 ? html + btn : html.slice(0, at) + btn + html.slice(at);   // inside the ticks, at the end
}
/*  Inventory matches as you type (every word has to match), best first. */
function invMatches(q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return (data.inventory || []).filter((it) => words.every((w) => it.name.toLowerCase().includes(w)))
    .sort((a, b) => (a.name.toLowerCase().startsWith(words[0]) ? 0 : 1) - (b.name.toLowerCase().startsWith(words[0]) ? 0 : 1) || a.name.length - b.name.length)
    .slice(0, 6);
}
document.addEventListener('input', (e) => {
  if (e.target.id !== 'pl-x-name') return;
  e.target.removeAttribute('data-item');
  const box = document.getElementById('pl-x-results');
  const m = invMatches(e.target.value);
  box.hidden = !m.length;
  box.innerHTML = m.map((it) => '<button type="button" class="pl-x-res" data-pick-id="' + esc(it.id) + '" data-pick-name="' + esc(it.name) + '">'
    + (it.photo ? '<img src="' + esc(it.photo) + '" alt="">' : '<span class="pl-x-noimg"></span>') + '<span>' + esc(it.name) + '</span></button>').join('');
});
document.addEventListener('click', (e) => {
  const pick = e.target.closest('[data-pick-id]');
  const box = document.getElementById('pl-x-results');
  if (pick) {
    const inp = document.getElementById('pl-x-name');
    inp.value = pick.getAttribute('data-pick-name');
    inp.setAttribute('data-item', pick.getAttribute('data-pick-id'));
    box.hidden = true;
    document.getElementById('pl-x-qty').focus();
    return;
  }
  if (box && !e.target.closest('.pl-x-search')) box.hidden = true;
});
function extrasHtml(row) {
  const list = data.extras || [];
  return `
    <section class="pl-list pl-extras">
      <h3 class="pl-extras-h">Extra gear <small>not on the quote &middot; added by the crew</small></h3>
      ${list.map((x) => withDel(row(x, false, false), x)).join('')}
      <div class="pl-addx">
        <div class="pl-x-search">
          <input type="text" id="pl-x-name" maxlength="120" placeholder="Add gear - start typing, e.g. lead" autocomplete="off">
          <div class="pl-x-results" id="pl-x-results" hidden></div>
        </div>
        <input type="number" id="pl-x-qty" min="1" max="99" value="1" aria-label="How many">
        <button type="button" class="pl-btn" id="pl-x-add">Add</button>
      </div>
    </section>`;
}
document.addEventListener('click', async (e) => {
  const add = e.target.closest('#pl-x-add');
  const del = e.target.closest('[data-x-del]');
  if (!add && !del) return;
  const msg = document.getElementById('pl-msg');
  busy++;
  try {
    if (add) {
      const nameEl = document.getElementById('pl-x-name');
      const name = String(nameEl.value || '').trim();
      if (!name) { nameEl.focus(); return; }
      const picked = nameEl.getAttribute('data-item');
      const inv = (data.inventory || []).find((it) => (picked && it.id === picked) || it.name.toLowerCase() === name.toLowerCase());
      add.disabled = true;
      await callable.addExtra({ token: token(), name, qty: Number(document.getElementById('pl-x-qty').value) || 1, itemId: inv ? inv.id : '' });
      if (msg) msg.textContent = 'Added ' + name;
    } else {
      const x = (data.extras || []).find((r) => r.key === del.getAttribute('data-x-del'));
      if (!window.confirm('Remove ' + ((x && x.name) || 'this') + ' from the extra gear?')) return;
      await callable.removeExtra({ token: token(), key: del.getAttribute('data-x-del') });
    }
  } catch (err) {
    if (msg) msg.textContent = (err && err.message) || 'Could not save that - check your signal and try again.';
  } finally {
    busy--;
  }
  await refresh();
});

/*  ITEM PHOTOS: tap an item (or its little picture) to see its photo
    from Inventory, big. Tap anywhere to close.                         */
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-photo]');
  const open = document.querySelector('.pl-lightbox');
  if (open && (!b || open.contains(e.target))) { open.remove(); return; }
  if (!b) return;
  const box = document.createElement('div');
  box.className = 'pl-lightbox';
  box.innerHTML = '<figure><img src="' + esc(b.getAttribute('data-photo')) + '" alt=""><figcaption>' + esc(b.getAttribute('data-name') || '') + '<small>Tap anywhere to close</small></figcaption></figure>';
  document.body.appendChild(box);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const o = document.querySelector('.pl-lightbox'); if (o) o.remove(); } });

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
