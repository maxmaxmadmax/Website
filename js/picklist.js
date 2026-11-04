/* ==========================================================================
   CREW PICK LIST  -  picklist.html?t=<crewToken>[&v=gear]

   Shows a booked job's gear (no prices) grouped by category, with Packed and
   Returned ticks. Each tick saves straight away, so admin and everyone on
   the crew link see the same list. Refreshes itself every 20 seconds.
   &v=gear is the band / crew gear list: no ticks, no money flags.
   Data: getPickList / setPickTick / addPickExtra / removePickExtra.

   CONTENTS
     SETUP        Firebase callables and the page state
     FORMATTING   escaping, dates, times, phone links
     CATEGORIES   category order and the quote-style sections
     TICKS        which lines get ticks, the counts, the progress bars
     RENDER       the whole page
     BRIEF        the DJ gig brief
     EXTRA GEAR   gear the crew add: search, add, remove
     PHOTOS       tap an item to see its photo
     SAVING       a tick saves straight away; the 20-second refresh
     START        load, and the local test hook
   ========================================================================== */
import { firebaseConfig, functionsRegion, isFirebaseConfigured } from './firebase-config.js?v=839';

/* ---- SETUP ---- */
const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
const token = () => new URLSearchParams(location.search).get('t') || '';

let GEAR_VIEW = new URLSearchParams(location.search).get('v') === 'gear';
let callable = null; // the Firebase callables once loaded
let data = null; // the last pick list loaded
let busy = 0; // saves still running - don't refresh over them

async function initFns() {
    const [{ initializeApp }, functions] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-functions.js`)]);
    const app = initializeApp(firebaseConfig);
    const fns = functions.getFunctions(app, functionsRegion);
    callable = {
        get: functions.httpsCallable(fns, 'getPickList'),
        tick: functions.httpsCallable(fns, 'setPickTick'),
        addExtra: functions.httpsCallable(fns, 'addPickExtra'),
        removeExtra: functions.httpsCallable(fns, 'removePickExtra')
    };
}

/* ---- FORMATTING ---- */
function esc(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* "2026-10-20" -> "Tue 20 Oct 2026" */
function niceDay(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return '';
    return new Date(+m[1], +m[2] - 1, +m[3])
        .toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
        .replace(/,/g, '');
}

/* "18:30" -> "6:30pm" (the details form stores 24-hour time). Anything else is shown as-is. */
function niceTime(v) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
    if (!m) return String(v || '');
    const h = +m[1];
    return (h % 12 || 12) + ':' + m[2] + (h < 12 ? 'am' : 'pm');
}

/* "6:30pm – 11pm", escaped */
function timeRange(start, finish) {
    return esc([niceTime(start), niceTime(finish)].filter(Boolean).join(' – '));
}

/* a phone number as a tap-to-call link */
function phoneLink(phone) {
    return `<a href="tel:${esc(phone.replace(/[^\d+]/g, ''))}">${esc(phone)}</a>`;
}

/* free text, escaped, with the first phone number in it made tappable */
function telLinks(text) {
    return esc(text).replace(/(\+?\d[\d\s]{7,}\d)/, (n) => '<a href="tel:' + n.replace(/\s/g, '') + '">' + n + '</a>');
}

/* one line of a details list; nothing when there's no value */
function info(label, value) {
    return value ? `<div><dt>${label}</dt><dd>${value}</dd></div>` : '';
}

/* ---- CATEGORIES ---- */
/* the order categories appear in on older jobs (anything else after, A-Z) */
const CAT_ORDER = [
    'Packages',
    'Kits',
    'Audio',
    'Speaker',
    'Mixer',
    'Microphone',
    'Amp',
    'DI',
    'IEM',
    'Studio Monitor',
    'Stands',
    'Cable',
    'Power',
    'Lighting',
    'Truss',
    'Stage',
    'Furniture',
    'Backline',
    'DJ Mixer',
    'Vision',
    'Other'
];
function catRank(c) {
    const i = CAT_ORDER.findIndex((x) => x.toLowerCase() === String(c).toLowerCase());
    return i < 0 ? 50 : i;
}

/*  Sections like the quote. KEEP IN STEP with COST_GROUP in
    js/quote-view.js: inventory category -> the heading it sits under.  */
const COST_GROUP = {
    audio: 'Audio',
    mixer: 'Audio',
    amp: 'Audio',
    microphone: 'Audio',
    iem: 'Audio',
    di: 'Audio',
    'studio monitor': 'Audio',
    cable: 'Audio',
    stands: 'Audio',
    speaker: 'Audio',
    speakers: 'Audio',
    'mic kit': 'Backline',
    drum: 'Backline',
    drums: 'Backline',
    lighting: 'Lighting',
    truss: 'Lighting',
    stage: 'Staging',
    furniture: 'Staging',
    backline: 'Backline',
    'dj mixer': 'DJ equipment',
    vision: 'Vision',
    power: 'Audio'
};
const COST_GROUP_ORDER = ['Audio', 'Backline', 'Lighting', 'Staging', 'DJ equipment', 'Vision', 'Other'];

function sectionOf(r) {
    if (r.custom) return 'Other';
    const cat = String(r.category || '')
        .trim()
        .toLowerCase();
    return COST_GROUP[cat] || 'Audio';
}

function catLabel(r) {
    const c = String(r.category || '').trim();
    return c ? c.charAt(0).toUpperCase() + c.slice(1) : 'Other';
}

/* an item's included parts: a kit's own order first, then category A-Z, then name */
function byPartOrder(a, b) {
    return (
        (a.sysOrder != null ? a.sysOrder : 1e9) - (b.sysOrder != null ? b.sysOrder : 1e9) ||
        catLabel(a).localeCompare(catLabel(b)) ||
        a.name.localeCompare(b.name, undefined, { numeric: true })
    );
}

/* ---- TICKS ---- */
/* the lines that get ticks: the quote-style rows (or the totals on older jobs), plus extra gear */
function tickLines() {
    return (data.rows || data.items || []).concat(GEAR_VIEW ? [] : data.extras || []);
}

/* a line's ticks - its own, or the ones saved before per item */
function ticksOf(r) {
    const t = data.ticks || {};
    return t[r.key] || (r.itemKey && t[r.itemKey]) || {};
}

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
      <i><em style="width:${c.total ? Math.round((100 * n) / c.total) : 0}%"></em></i>
    </div>`;
    return bar(c.packed, 'Packed', 'is-packed') + bar(c.returned, 'Returned', 'is-returned');
}

/* ---- RENDER ---- */
function tickBox(i, field, label) {
    return `
    <label class="pl-box${ticksOf(i)[field] ? ' is-on' : ''}">
      <input type="checkbox" data-key="${esc(i.key)}" data-field="${field}"${ticksOf(i)[field] ? ' checked' : ''}>
      <span aria-hidden="true">&#10003;</span><em>${label}</em>
    </label>`;
}

/* the item name; with a photo, the name and a thumbnail both open it */
function itemNameHtml(i) {
    if (!i.photo) return esc(i.name);
    const pic = `<button type="button" class="pl-pic" data-photo="${esc(i.photo)}" data-name="${esc(i.name)}" aria-label="See a photo of ${esc(i.name)}"><img src="${esc(i.photo)}" alt="" loading="lazy"></button>`;
    const name = `<button type="button" class="pl-picname" data-photo="${esc(i.photo)}" data-name="${esc(i.name)}">${esc(i.name)}</button>`;
    return pic + name;
}

/* one gear line: sub = an included part, kit = an item with its own parts list */
function rowHtml(i, sub, kit) {
    const arrow = sub ? '<span class="pl-arrow">&#9492;</span>' : '';
    const kitTag = kit ? ' <span class="pl-kit">Kit</span>' : '';
    const ticks = GEAR_VIEW ? '' : `<span class="pl-ticks">${tickBox(i, 'packed', 'Packed')}${tickBox(i, 'returned', 'Returned')}</span>`;
    return `
            <div class="pl-row${sub ? ' pl-sub' : ''}${ticksOf(i).packed ? ' is-packed' : ''}">
              <span class="pl-qty">${esc(i.qty)}&times;</span>
              <span class="pl-name">${arrow}${itemNameHtml(i)}${kitTag}</span>
              ${ticks}
            </div>`;
}

/* an item and its included parts, with small category headings between parts */
function unitHtml(u) {
    const isKit = u.some((p) => p.sub && p.sysOrder != null);
    const parts = u.slice(1).map((p, j) => {
        const prev = j ? u[j] : null; // the part before this one
        // a kit's own parts keep the kit's order with no headings (like the quote builder)
        const head = p.sysOrder != null || (prev && catLabel(prev) === catLabel(p)) ? '' : `<p class="pl-subhead">${esc(catLabel(p))}</p>`;
        return head + rowHtml(p, true);
    });
    return rowHtml(u[0], false, isKit) + parts.join('');
}

/*  Like the quote: Audio / Backline / Lighting... each item with its
    included parts under it (small category headings, A-Z).            */
function quoteStyleList(rows) {
    const units = [];
    rows.forEach((r) => {
        if (r.sub && units.length) units[units.length - 1].push(r);
        else units.push([r]);
    });
    units.forEach((u) => {
        u.splice(1, u.length - 1, ...u.slice(1).sort(byPartOrder));
    });
    const bySec = {};
    units.forEach((u) => {
        const sec = sectionOf(u[0]);
        (bySec[sec] = bySec[sec] || []).push(u);
    });
    return COST_GROUP_ORDER.filter((k) => bySec[k])
        .map(
            (k) => `
        <div class="pl-cat">
          <h3>${esc(k)}</h3>
          ${bySec[k].map((u) => unitHtml(u)).join('')}
        </div>`
        )
        .join('');
}

/* older jobs: the totals by category */
function oldList(items) {
    const groups = {};
    items.forEach((i) => {
        const cat = i.category || 'Other';
        (groups[cat] = groups[cat] || []).push(i);
    });
    const cats = Object.keys(groups).sort((a, b) => catRank(a) - catRank(b) || a.localeCompare(b));
    return cats
        .map(
            (cat) => `
        <div class="pl-cat">
          <h3>${esc(cat)}</h3>
          ${groups[cat].map((i) => rowHtml(i, false)).join('')}
        </div>`
        )
        .join('');
}

function pageHeading(d, gearLines) {
    if (!GEAR_VIEW) return 'Pick list';
    if (!d.brief) return 'Gear list';
    return 'Gig brief' + (gearLines ? ' &amp; gear' : '');
}

function hireRange(d) {
    if (!d.hire.startDate) return esc(d.eventDate || '');
    const end = d.hire.endDate && d.hire.endDate !== d.hire.startDate ? ' &ndash; ' + niceDay(d.hire.endDate) : '';
    return niceDay(d.hire.startDate) + end;
}

/* venue with a tap-for-directions link (falls back to the customer's address / town) */
function venueHtml(d) {
    if (!d.venue) return esc(d.contact.address || d.town || '');
    const maps = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(d.venue);
    return `${esc(d.venue)}<br><a href="${maps}" target="_blank" rel="noopener">Directions &rarr;</a>`;
}

function contactHtml(d) {
    const who = [d.contact.name, d.contact.business].filter(Boolean).map(esc).join(' &middot; ');
    return who + (d.contact.phone ? '<br>' + phoneLink(d.contact.phone) : '');
}

function assignedHtml(d) {
    return (d.assigned || []).map((x) => esc(x.name) + (x.phone ? ' <small>' + phoneLink(x.phone) + '</small>' : '')).join('<br>');
}

function crewHtml(d) {
    return d.crew.map((x) => esc(x.name) + (x.note ? ' <small>' + esc(x.note) + '</small>' : '')).join('<br>');
}

/* the gear-list note, or the money flag on a pick list */
function jobFlagHtml(d) {
    if (GEAR_VIEW)
        return '<p class="pl-notes">This is the gear SoundzGood Whitsundays is supplying. Anything missing? Call Max on 0422 393 022.</p>';
    if (d.paidInFull) return '';
    return '<p class="pl-flag">Balance still owing on this job &mdash; check with Max before handing over gear.</p>';
}

function render() {
    const d = data;
    const c = counts();
    document.getElementById('pl-root').innerHTML = `
    <header class="pl-head">
      <img src="/images/logo-quote.png" alt="SoundzGood Whitsundays" class="pl-logo">
      <div class="pl-head-r"><h1>${pageHeading(d, c.total)}</h1><p>${esc(d.number)}</p></div>
    </header>

    <section class="pl-job">
      <h2>${esc(d.eventName || 'Job')}</h2>
      <dl class="pl-info">
        ${info('Event date', esc(d.eventDate || ''))}
        ${d.times.soundcheck ? info('Soundcheck', esc(niceTime(d.times.soundcheck))) : ''}
        ${info('Event starts', timeRange(d.times.start, d.times.finish))}
        ${info('Venue', venueHtml(d))}
        ${info('Hire dates', hireRange(d))}
        ${info('Getting there', esc(d.delivery))}
        ${info('Event day contact', d.dayContact ? telLinks(d.dayContact) : '')}
        ${info(d.dayContact ? 'Customer' : 'On-site contact', contactHtml(d))}
        ${info('Working it', assignedHtml(d))}
        ${info('Crew', crewHtml(d))}
      </dl>
      ${d.customerNotes ? `<p class="pl-notes"><b>From the customer:</b> ${esc(d.customerNotes)}</p>` : ''}
      ${d.notes ? `<p class="pl-notes"><b>Notes:</b> ${esc(d.notes)}</p>` : ''}
      ${jobFlagHtml(d)}
    </section>

    ${d.brief ? briefHtml(d.brief, c.total) : ''}

    ${GEAR_VIEW ? '' : `<section class="pl-progress" id="pl-progress">${progressHtml()}</section>`}

    <section class="pl-list"${d.brief && !c.total ? ' hidden' : ''}>
      <p class="pl-count">${c.total} line${c.total === 1 ? '' : 's'} &middot; ${c.pieces} piece${c.pieces === 1 ? '' : 's'} in total</p>
      ${d.rows ? quoteStyleList(d.rows) : oldList(d.items || [])}
    </section>

    ${GEAR_VIEW ? '' : extrasHtml()}

    <footer class="pl-foot">
      <button type="button" class="pl-btn" id="pl-print">Print</button>
      <span id="pl-msg" class="pl-msg"></span>
      ${GEAR_VIEW ? '' : '<span class="pl-sig">Packed by ____________________ &nbsp; Checked back in by ____________________</span>'}
    </footer>`;

    document.getElementById('pl-print').addEventListener('click', () => window.print());
}

/* ---- BRIEF ---- */
/*  For a DJ gig: set times, the booking notes and the venue's notes,
    address and contact. No SoundzGood gear on the job = the venue
    supplies it, and that's said plainly.                              */
function briefHtml(b, gearLines) {
    return `
    <section class="pl-job pl-brief">
      <h2>The brief</h2>
      <dl class="pl-info">
        ${info('DJ', esc(b.dj))}
        ${info('Set times', timeRange(b.start, b.finish))}
        ${info('Venue address', esc(b.address))}
        ${info('Venue contact', b.venueContact ? telLinks(b.venueContact) : '')}
        ${info('Your deck', esc(b.deck))}
      </dl>
      ${b.notes ? '<p class="pl-notes"><b>About the gig:</b>\n' + esc(b.notes) + '</p>' : ''}
      ${b.venueNotes ? '<p class="pl-notes"><b>Venue notes:</b>\n' + esc(b.venueNotes) + '</p>' : ''}
      ${gearLines ? '' : '<p class="pl-notes"><b>Gear:</b> the venue supplies the PA and decks (at least a Pioneer XDJ-RX3, or 2 × CDJ-3000 with a DJM-A9). Check with the venue before the night.</p>'}
    </section>`;
}

/* ---- EXTRA GEAR ---- */
/*  Gear going out that isn't on the quote - the crew add it here so it
    gets ticked out and back. No prices, and it never changes the quote.
    Pick from our inventory or type anything.                          */
function extrasHtml() {
    const list = data.extras || [];
    return `
    <section class="pl-list pl-extras">
      <h3 class="pl-extras-h">Extra gear <small>not on the quote &middot; added by the crew</small></h3>
      ${list.map((x) => withDel(rowHtml(x, false, false), x)).join('')}
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

/* the × to take an extra off, at the end of its row (inside the ticks, after them) */
function withDel(html, x) {
    const btn =
        '<button type="button" class="pl-xdel" data-x-del="' + esc(x.key) + '" aria-label="Remove ' + esc(x.name) + '">&times;</button>';
    const at = html.lastIndexOf('</span>');
    return at < 0 ? html + btn : html.slice(0, at) + btn + html.slice(at);
}

/* inventory matches as you type (every word has to match), best first */
function invMatches(q) {
    const words = String(q || '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
    if (!words.length) return [];
    const startsRank = (it) => (it.name.toLowerCase().startsWith(words[0]) ? 0 : 1);
    return (data.inventory || [])
        .filter((it) => words.every((w) => it.name.toLowerCase().includes(w)))
        .sort((a, b) => startsRank(a) - startsRank(b) || a.name.length - b.name.length)
        .slice(0, 6);
}

function matchHtml(it) {
    const pic = it.photo ? '<img src="' + esc(it.photo) + '" alt="">' : '<span class="pl-x-noimg"></span>';
    return (
        '<button type="button" class="pl-x-res" data-pick-id="' +
        esc(it.id) +
        '" data-pick-name="' +
        esc(it.name) +
        '">' +
        pic +
        '<span>' +
        esc(it.name) +
        '</span></button>'
    );
}

// typing in the box: show the matches
document.addEventListener('input', (e) => {
    if (e.target.id !== 'pl-x-name') return;
    e.target.removeAttribute('data-item');
    const box = document.getElementById('pl-x-results');
    const m = invMatches(e.target.value);
    box.hidden = !m.length;
    box.innerHTML = m.map(matchHtml).join('');
});

// picking a match fills the box; clicking anywhere else closes the matches
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

// Add and × buttons: save, then reload the list
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
            if (!name) {
                nameEl.focus();
                return;
            }
            const picked = nameEl.getAttribute('data-item');
            const inv = (data.inventory || []).find((it) => (picked && it.id === picked) || it.name.toLowerCase() === name.toLowerCase());
            add.disabled = true;
            await callable.addExtra({
                token: token(),
                name,
                qty: Number(document.getElementById('pl-x-qty').value) || 1,
                itemId: inv ? inv.id : ''
            });
            if (msg) msg.textContent = 'Added ' + name;
        } else {
            const key = del.getAttribute('data-x-del');
            const x = (data.extras || []).find((r) => r.key === key);
            if (!window.confirm('Remove ' + ((x && x.name) || 'this') + ' from the extra gear?')) return;
            await callable.removeExtra({ token: token(), key });
        }
    } catch (err) {
        if (msg) msg.textContent = (err && err.message) || 'Could not save that - check your signal and try again.';
    } finally {
        busy--;
    }
    await refresh();
});

/* ---- PHOTOS ---- */
/*  Tap an item (or its little picture) to see its photo from Inventory,
    big. Tap anywhere, or press Escape, to close.                      */
document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-photo]');
    const open = document.querySelector('.pl-lightbox');
    if (open && (!b || open.contains(e.target))) {
        open.remove();
        return;
    }
    if (!b) return;
    const box = document.createElement('div');
    box.className = 'pl-lightbox';
    box.innerHTML =
        '<figure><img src="' +
        esc(b.getAttribute('data-photo')) +
        '" alt=""><figcaption>' +
        esc(b.getAttribute('data-name') || '') +
        '<small>Tap anywhere to close</small></figcaption></figure>';
    document.body.appendChild(box);
});

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.pl-lightbox');
    if (open) open.remove();
});

/* ---- SAVING ---- */
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

/* reload the list, keeping the scroll position; skipped while saving or hidden */
async function refresh() {
    if (busy || document.hidden) return;
    try {
        const res = await callable.get({ token: token(), gear: GEAR_VIEW });
        if (busy) return;
        data = res.data;
        const y = window.scrollY;
        render();
        window.scrollTo(0, y);
    } catch (e) {
        /* keep showing what we have */
    }
}

/* ---- START ---- */
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
        if (data.gearOnly) GEAR_VIEW = true; // the shared gear list link is always the gear view
        document.title = (GEAR_VIEW ? 'Gear List' : 'Pick List') + ' | SoundzGood Whitsundays';
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
