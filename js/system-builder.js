/* ==========================================================================
   KIT & PACKAGE BUILDER  -  Inventory > "+ New kit" / "+ New package"
   (Max, 16-17 Oct 2026; kits were first called "systems")

   A KIT is an inventory item made of other gear, e.g.
     FOH Kit = 2 x tops + 4 x subs + 1 x 4-ch amp  (+ their cables)
   A PACKAGE is made of kits and single items, e.g.
     4-Piece Band Backline = Mic kit + Drum kit + bass rig + 2 guitar amps
   and can be offered on the website estimate bot (event type + guest size).
   Both are saved with isSystem: true; bundleType says which ('kit' / 'package').
   It is saved as a normal inventory item with isSystem: true and its parts
   as INCLUDED required gear, so quotes show one line at one price with the
   parts listed under it, the pick list shows every part, and stock is
   counted on the real parts. Each part's own required gear (leads, stands)
   still comes along automatically through the kit engine (js/kit.js).

   Pure HTML + wiring; admin-app.js hands in the items and does the saving.
   ========================================================================== */
import { expandKit, resolveTotals } from './kit.js?v=600';

/* the working copy of the system being built */
export function sysDraftFrom(item, type) {
  const it = item || {};
  const bundleType = (it.bundleType || type) === 'package' ? 'package' : 'kit';
  return {
    id: it.id || '',
    bundleType,
    botOffer: it.botOffer === true,            // packages: offered on the website bot
    eventType: it.eventType || '',
    maxGuests: it.maxGuests || '',
    name: it.name || '',
    category: it.category || (bundleType === 'package' ? 'Package' : 'Audio'),
    subtitle: it.subtitle || '',
    priceCents: it.priceCents || 0,
    photoUrl: it.photoUrl || '',
    priceTouched: !!it.id,   // an existing system keeps its price; a new one follows the parts
    // what Max picked (systemParts); older saves only have the de-duplicated requirements
    parts: (Array.isArray(it.systemParts) && it.systemParts.length ? it.systemParts : (it.requirements || []))
      .filter((r) => r && (r.itemId || r.resourceId)).map((r) => (r.resourceId
        ? { resourceId: r.resourceId, qty: Math.max(1, r.qty || 1) }      // crew (packages only)
        : { itemId: r.itemId, qty: Math.max(1, r.qty || 1) })),
    search: '',
  };
}

/* the words used for each type */
const W = (d) => (d.bundleType === 'package'
  ? { one: 'package', One: 'Package', parts: 'Contents', sub: 'Kits and single items together - one line on a quote',
      ph: 'e.g. 4-Piece Band Backline', hint: 'Search above to add kits and single items.', make: 'make' }
  : { one: 'kit', One: 'Kit', parts: 'Parts', sub: 'A rig made of other gear - one line on a quote',
      ph: 'e.g. FOH Kit', hint: 'Add the main gear above - cables and stands come along on their own.', make: 'build' });

/* crew (from Crew & Vehicles) handed in by admin as d.crewList */
const crewOf = (d, id) => (d.crewList || []).find((r) => r.id === id) || null;
const crewRate = (d, id) => { const r = crewOf(d, id); return r ? Math.max(0, Math.round(r.dayRateCents || 0)) : 0; };

const byIdOf = (items) => { const m = {}; items.forEach((i) => { m[i.id] = i; }); return m; };

/* the numbers the panel shows. A part that another part ALREADY brings along
   (e.g. the amp a Stinger needs) is only counted once - its extra quantity
   is 'covered' and left out of the price, the stock check and the save.   */
export function sysSummary(d, items) {
  const byId = byIdOf(items);
  const cart = {};
  d.parts.forEach((p) => { if (p.itemId && byId[p.itemId]) cart[p.itemId] = (cart[p.itemId] || 0) + p.qty; });
  const crewCents = d.parts.filter((p) => p.resourceId).reduce((n, p) => n + crewRate(d, p.resourceId) * p.qty, 0);
  // how much of each part the OTHER parts already pull in
  const covered = {};
  Object.keys(cart).forEach((id) => {
    const others = { ...cart }; delete others[id];
    const t = Object.keys(others).length ? resolveTotals(others, byId) : {};
    const pulled = Math.max(0, (t[id] || 0));
    if (pulled) covered[id] = Math.min(cart[id], pulled);
  });
  const eff = {};
  Object.keys(cart).forEach((id) => { const q = cart[id] - (covered[id] || 0); if (q > 0) eff[id] = q; });
  const kit = Object.keys(eff).length ? expandKit(eff, byId) : { base: [], required: [], addCents: 0, totals: {} };
  // what it would cost hired piece by piece (parts + any charged gear they bring)
  const partsCents = kit.base.reduce((n, x) => n + x.lineCents, 0) + (kit.addCents || 0) + crewCents;
  const tagAlong = kit.required.filter((r) => !eff[r.itemId]);
  // how many full kits (every lead and amp included) you own enough for
  let build = Infinity;
  Object.keys(kit.totals || {}).forEach((id) => {
    const it = byId[id]; const need = kit.totals[id];
    if (!it || !need) return;
    const usable = Math.max(0, (it.quantityTotal || 0) - Math.min(it.quantityRepair || 0, it.quantityTotal || 0));
    build = Math.min(build, Math.floor(usable / need));
  });
  return { partsCents, tagAlong, covered, eff, build: Object.keys(eff).length ? build : 0 };
}

/* the side panel */
export function systemPanelHtml(d, items, h, cats) {
  const byId = byIdOf(items);
  const w = W(d);
  const s = sysSummary(d, items);
  const price = d.priceTouched ? d.priceCents : s.partsCents;
  const save = s.partsCents && price < s.partsCents ? Math.round(100 * (1 - price / s.partsCents)) : 0;
  return `
    <aside class="inv-detail sys-panel" aria-label="${w.One} builder">
      <header class="inv-detail-head">
        <div>
          <h2>${d.id ? 'Edit ' + w.one : 'New ' + w.one}</h2>
          <p class="inv-detail-sub">${w.sub}</p>
        </div>
        <button type="button" class="inv-detail-close" id="sys-close" aria-label="Close">&times;</button>
      </header>
      <div class="inv-detail-body">
        <div class="inv-photo">
          <div class="inv-photo-preview" id="inv-photo-drop" title="Drag, paste or click to add a photo">
            ${d.photoUrl ? `<img src="${h.attr(d.photoUrl)}" alt="">` : '<span class="inv-photo-ph">' + (d.bundleType === 'package' ? 'P' : 'K') + '</span>'}
          </div>
          <div class="inv-photo-actions">
            <label class="ad-btn ad-btn-small inv-photo-btn">${d.photoUrl ? 'Replace photo' : 'Upload photo'}
              <input type="file" accept="image/*" id="inv-photo-input" hidden></label>
            ${d.photoUrl ? '<button type="button" class="ad-btn ad-btn-small" id="inv-photo-remove">Remove</button>' : ''}
            <p class="inv-photo-hint">Drag an image in, or paste a screenshot (Ctrl / Cmd + V)</p>
            <span class="ad-quote-msg" id="inv-photo-msg"></span>
          </div>
        </div>
        <label class="sys-field">Name
          <input class="ad-input" id="sys-name" value="${h.attr(d.name)}" placeholder="${h.attr(w.ph)}"></label>
        <div class="sys-row2">
          <label class="sys-field">Category
            <input class="ad-input" id="sys-cat" list="sys-cats" value="${h.attr(d.category)}">
            <datalist id="sys-cats">${(cats || []).map((c) => `<option value="${h.attr(c)}">`).join('')}</datalist></label>
          <label class="sys-field">Short description
            <input class="ad-input" id="sys-sub" value="${h.attr(d.subtitle)}" placeholder="${d.bundleType === 'package' ? 'e.g. Drums, mics, bass & guitar amps' : 'e.g. Tops, subs & amp'}"></label>
        </div>

        <p class="sys-h">${w.parts}</p>
        <div class="sys-search">
          <input class="ad-input" id="sys-search" placeholder="&#128269; Search ${d.bundleType === 'package' ? 'kits, gear or crew' : 'gear'} to add..." value="${h.attr(d.search)}" autocomplete="off">
          <div class="sys-results" id="sys-results"></div>
        </div>
        <div id="sys-parts">${partsHtml(d, byId, h, s.covered)}</div>
        ${s.tagAlong.length ? `<p class="sys-tag"><b>${d.bundleType === 'package' ? 'Also included (inside the kits):' : 'Comes with automatically:'}</b> ${s.tagAlong.map((r) => h.esc(r.qty + ' × ' + r.name)).join(', ')}</p>` : ''}

        <p class="sys-h">Price</p>
        <div class="sys-price">
          <div><span>Parts add up to</span><b>${h.esc(h.money(s.partsCents))} / day</b></div>
          <label><span>${w.One} price</span>
            <span class="sys-dollar">$<input class="ad-input" type="number" min="0" step="1" id="sys-price" value="${h.attr(Math.round(price / 100))}"> / day</span></label>
          ${save > 0 ? `<em>Saves the customer ${save}%</em>` : ''}
        </div>

        <p class="sys-build${s.build ? '' : ' is-none'}">${d.parts.length
          ? (s.build ? '&#10003; You can ' + w.make + ' <b>' + s.build + '</b> of these with what you own' : '&#9888; You don’t own enough gear to ' + w.make + ' one')
          : w.hint}</p>

        ${d.bundleType === 'package' ? `
        <p class="sys-h">Website bot</p>
        <label class="sys-check"><input type="checkbox" id="sys-bot"${d.botOffer ? ' checked' : ''}> Offer this package on the instant estimate</label>
        <div class="sys-row2${d.botOffer ? '' : ' is-off'}">
          <label class="sys-field">Event type
            <input class="ad-input" id="sys-event" list="sys-events" value="${h.attr(d.eventType)}" placeholder="e.g. Live Music">
            <datalist id="sys-events">${(d.eventTypes || []).map((c) => `<option value="${h.attr(c)}">`).join('')}</datalist></label>
          <label class="sys-field">Up to how many guests
            <input class="ad-input" type="number" min="0" step="10" id="sys-guests" value="${h.attr(d.maxGuests)}" placeholder="Any size"></label>
        </div>` : ''}

        <div class="sys-actions">
          <button type="button" class="ad-btn ad-btn-primary" id="sys-save">Save ${w.one}</button>
          <span class="ad-quote-msg" id="sys-msg"></span>
        </div>
      </div>
    </aside>`;
}

function partsHtml(d, byId, h, covered) {
  if (!d.parts.length) return '<p class="sys-empty">No parts yet.</p>';
  return d.parts.map((p, i) => {
    if (p.resourceId) {
      const r = crewOf(d, p.resourceId) || { name: '(crew member removed)' };
      return `<div class="sys-part" data-sys-i="${i}">
        <span class="qb-grip sys-grip" title="Drag to reorder">&#10303;</span>
        <span class="sys-pname"><span class="qb-sys-tag is-crew">Crew</span>${h.esc(r.name)}<small>${h.esc(h.money(r.dayRateCents || 0))}/day</small></span>
        <span class="sys-qty"><button type="button" data-sys-minus="${i}" aria-label="Less">&minus;</button><b>${p.qty}</b><button type="button" data-sys-plus="${i}" aria-label="More">+</button></span>
        <span class="sys-own"></span>
      </div>`;
    }
    const it = byId[p.itemId] || { name: '(missing item)' };
    return `<div class="sys-part" data-sys-i="${i}">
        <span class="qb-grip sys-grip" title="Drag to reorder">&#10303;</span>
        <span class="sys-pname">${it.isSystem ? '<span class="qb-sys-tag">Kit</span>' : ''}${h.esc(it.name)}<small>${h.esc(it.category || '')}</small>${covered && covered[p.itemId] ? '<em class="sys-covered">' + covered[p.itemId] + ' already comes with another part - only counted once</em>' : ''}</span>
        <span class="sys-qty"><button type="button" data-sys-minus="${i}" aria-label="Less">&minus;</button><b>${p.qty}</b><button type="button" data-sys-plus="${i}" aria-label="More">+</button></span>
        <span class="sys-own">${h.esc(it.quantityTotal != null ? it.quantityTotal : '?')} owned</span>
      </div>`;
  }).join('');
}

/* search results: a kit takes single gear; a package takes single gear AND
   kits (never another package, never itself). Kits come first.           */
function resultsHtml(d, items, h) {
  const q = d.search.trim().toLowerCase();
  if (!q) return '';
  const words = q.split(/\s+/);
  const allowed = (it) => it.id !== d.id && (!it.isSystem || (d.bundleType === 'package' && it.bundleType !== 'package'));
  const found = items.filter((it) => allowed(it) &&
    words.every((w) => [it.name, it.subtitle, it.category].join(' ').toLowerCase().includes(w)));
  const hits = found.filter((it) => it.isSystem).concat(found.filter((it) => !it.isSystem)).slice(0, 8);
  const crew = d.bundleType === 'package' ? (d.crewList || []).filter((r) => words.every((w) => [r.name, r.type].join(' ').toLowerCase().includes(w))).slice(0, 4) : [];
  const crewHtml = crew.map((r) => `<button type="button" data-sys-add="res:${h.attr(r.id)}"><span class="qb-sys-tag is-crew">Crew</span>${h.esc(r.name)}<small>${h.esc(h.money(r.dayRateCents || 0))}/day</small></button>`).join('');
  if (!hits.length && crew.length) return crewHtml;
  if (!hits.length) return '<p class="sys-none">No gear matches.</p>';
  if (crewHtml) return crewHtml + hits.map((it) => `<button type="button" data-sys-add="${h.attr(it.id)}">${it.isSystem ? '<span class="qb-sys-tag">Kit</span>' : ''}${h.esc(it.name)}<small>${h.esc(it.category || '')} &middot; ${h.esc(h.money(it.priceCents || 0))}/day</small></button>`).join('');
  return hits.map((it) => `<button type="button" data-sys-add="${h.attr(it.id)}">${it.isSystem ? '<span class="qb-sys-tag">Kit</span>' : ''}${h.esc(it.name)}<small>${h.esc(it.category || '')} &middot; ${h.esc(h.money(it.priceCents || 0))}/day</small></button>`).join('');
}

/* clicks and typing. act = { save(data), close() }. Re-draws the panel in
   place (keeping the search box focused) as parts change.                */
export function wireSystemPanel(d, getItems, h, cats, act) {
  const panel = document.querySelector('.sys-panel');
  if (!panel) return;
  if (act.afterDraw) act.afterDraw();   // e.g. the photo box (admin-app.js)
  const redraw = () => {
    const keep = document.activeElement && document.activeElement.id;
    const fresh = document.createElement('div');
    fresh.innerHTML = systemPanelHtml(d, getItems(), h, cats);
    panel.replaceWith(fresh.firstElementChild);
    wireSystemPanel(d, getItems, h, cats, act);
    const res = document.getElementById('sys-results');
    if (res) res.innerHTML = resultsHtml(d, getItems(), h);
    if (keep) { const el = document.getElementById(keep); if (el) { el.focus(); if (el.setSelectionRange && el.value != null && el.type !== 'number') el.setSelectionRange(el.value.length, el.value.length); } }
  };
  const val = (id) => (document.getElementById(id) || {}).value || '';

  // DRAG TO REORDER the parts (grab the grip) - same feel as quote lines
  const list = document.getElementById('sys-parts');
  if (list) {
    let from = null;
    const marks = () => list.querySelectorAll('.qb-drop-before, .qb-drop-after').forEach((el) => el.classList.remove('qb-drop-before', 'qb-drop-after'));
    const where = (e) => {
      const row = e.target.closest('[data-sys-i]');
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { row, i: +row.getAttribute('data-sys-i'), after: (e.clientY - r.top) > r.height / 2 };
    };
    list.addEventListener('mousedown', (e) => { const g = e.target.closest('.sys-grip'); if (g) g.closest('[data-sys-i]').setAttribute('draggable', 'true'); });
    list.addEventListener('mouseup', () => list.querySelectorAll('[draggable]').forEach((el) => el.removeAttribute('draggable')));
    list.addEventListener('dragstart', (e) => {
      const row = e.target.closest('[data-sys-i]');
      if (!row || row.getAttribute('draggable') !== 'true') { e.preventDefault(); return; }
      from = +row.getAttribute('data-sys-i');
      row.classList.add('qb-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(from)); } catch (_) { /* old browsers */ }
    });
    list.addEventListener('dragover', (e) => {
      if (from == null) return;
      e.preventDefault();
      marks();
      const w = where(e);
      if (w) w.row.classList.add(w.after ? 'qb-drop-after' : 'qb-drop-before');
    });
    list.addEventListener('drop', (e) => {
      if (from == null) return;
      e.preventDefault();
      const w = where(e);
      const a = from; from = null; marks();
      if (!w) return;
      let to = w.i + (w.after ? 1 : 0);
      const [moved] = d.parts.splice(a, 1);
      if (a < to) to--;
      d.parts.splice(to, 0, moved);
      redraw();
    });
    list.addEventListener('dragend', () => { from = null; marks(); list.querySelectorAll('[draggable]').forEach((el) => el.removeAttribute('draggable')); });
  }

  panel.addEventListener('input', (e) => {
    const id = e.target.id;
    if (id === 'sys-name') d.name = e.target.value;
    else if (id === 'sys-cat') d.category = e.target.value;
    else if (id === 'sys-sub') d.subtitle = e.target.value;
    else if (id === 'sys-event') d.eventType = e.target.value;
    else if (id === 'sys-guests') d.maxGuests = e.target.value;
    else if (id === 'sys-bot') { d.botOffer = e.target.checked; redraw(); }
    else if (id === 'sys-price') { d.priceCents = Math.max(0, Math.round(Number(e.target.value || 0) * 100)); d.priceTouched = true; }
    else if (id === 'sys-search') { d.search = e.target.value; document.getElementById('sys-results').innerHTML = resultsHtml(d, getItems(), h); }
  });
  panel.addEventListener('click', (e) => {
    const add = e.target.closest('[data-sys-add]');
    if (add) {
      const v = add.getAttribute('data-sys-add');
      if (v.startsWith('res:')) {   // crew member
        const resourceId = v.slice(4);
        const ex = d.parts.find((p) => p.resourceId === resourceId);
        if (ex) ex.qty++; else d.parts.push({ resourceId, qty: 1 });
      } else {
        const itemId = v;
        const ex = d.parts.find((p) => p.itemId === itemId);
        if (ex) ex.qty++; else d.parts.push({ itemId, qty: 1 });
      }
      d.search = '';
      redraw();
      return;
    }
    const plus = e.target.closest('[data-sys-plus]');
    if (plus) { d.parts[+plus.getAttribute('data-sys-plus')].qty++; redraw(); return; }
    const minus = e.target.closest('[data-sys-minus]');
    if (minus) {
      const i = +minus.getAttribute('data-sys-minus');
      d.parts[i].qty--;
      if (d.parts[i].qty < 1) d.parts.splice(i, 1);   // down to 0 = take it out
      redraw();
      return;
    }
    if (e.target.closest('#sys-close')) { act.close(); return; }
    if (e.target.closest('#sys-save')) {
      const msg = document.getElementById('sys-msg');
      const say = (t, bad) => { if (msg) { msg.textContent = t; msg.className = 'ad-quote-msg ' + (bad ? 'is-bad' : 'is-ok'); } };
      d.name = val('sys-name').trim();
      const w = W(d);
      if (!d.name) return say('Give the ' + w.one + ' a name first.', true);
      if (!d.parts.length) return say('Add at least one ' + (d.bundleType === 'package' ? 'kit or item.' : 'part.'), true);
      if (d.bundleType === 'package' && d.botOffer && !String(d.eventType || '').trim()) return say('Pick an event type for the bot (e.g. Live Music).', true);
      const s = sysSummary(d, getItems());
      const price = d.priceTouched ? d.priceCents : s.partsCents;
      say('Saving…');
      act.save({
        name: d.name,
        category: (d.category || '').trim() || (d.bundleType === 'package' ? 'Package' : 'Audio'),
        bundleType: d.bundleType,
        botOffer: d.bundleType === 'package' && d.botOffer === true,
        eventType: d.bundleType === 'package' ? String(d.eventType || '').trim() : '',
        maxGuests: d.bundleType === 'package' ? Math.max(0, Math.round(Number(d.maxGuests) || 0)) : 0,
        subtitle: (d.subtitle || '').trim(),
        isSystem: true,
        priceCents: price,
        extraDayCents: 0,
        pricingType: 'per-day',
        status: 'available',
        inBot: true,
        quantityTotal: s.build === Infinity ? 0 : s.build,
        quantityAvailable: s.build === Infinity ? 0 : s.build,
        quantityRepair: 0,
        // the parts, as INCLUDED required gear (no extra charge - the system price covers them)
        systemParts: d.parts.map((p) => (p.resourceId ? { resourceId: p.resourceId, qty: p.qty } : { itemId: p.itemId, qty: p.qty })),   // as picked, for editing
        // crew in a package, with name + rate as they were (the bot reads this)
        crewParts: d.parts.filter((p) => p.resourceId).map((p) => { const r = crewOf(d, p.resourceId) || {}; return { resourceId: p.resourceId, qty: p.qty, name: r.name || '', dayRateCents: r.dayRateCents || 0, type: r.type || 'staff' }; }),
        requirements: Object.keys(s.eff).map((id) => ({ itemId: id, rule: 'per-item', qty: s.eff[id], coversN: 1, charge: 'free', discountCents: 0 })),
      }).then(() => say('Saved.'), (err) => say((err && err.message) || 'Could not save.', true));
    }
  });
}
