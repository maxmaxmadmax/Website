/* ==========================================================================
   SYSTEM BUILDER  -  Inventory > "+ New system"   (Max, 16 Oct 2026)

   A SYSTEM is an inventory item made of other gear, e.g.
     FOH System = 2 x tops + 4 x subs + 1 x 4-ch amp  (+ their cables)
   It is saved as a normal inventory item with isSystem: true and its parts
   as INCLUDED required gear, so quotes show one line at one price with the
   parts listed under it, the pick list shows every part, and stock is
   counted on the real parts. Each part's own required gear (leads, stands)
   still comes along automatically through the kit engine (js/kit.js).

   Pure HTML + wiring; admin-app.js hands in the items and does the saving.
   ========================================================================== */
import { expandKit, resolveTotals } from './kit.js?v=463';

/* the working copy of the system being built */
export function sysDraftFrom(item) {
  const it = item || {};
  return {
    id: it.id || '',
    name: it.name || '',
    category: it.category || 'Audio',
    subtitle: it.subtitle || '',
    priceCents: it.priceCents || 0,
    photoUrl: it.photoUrl || '',
    priceTouched: !!it.id,   // an existing system keeps its price; a new one follows the parts
    // what Max picked (systemParts); older saves only have the de-duplicated requirements
    parts: (Array.isArray(it.systemParts) && it.systemParts.length ? it.systemParts : (it.requirements || []))
      .filter((r) => r && r.itemId).map((r) => ({ itemId: r.itemId, qty: Math.max(1, r.qty || 1) })),
    search: '',
  };
}

const byIdOf = (items) => { const m = {}; items.forEach((i) => { m[i.id] = i; }); return m; };

/* the numbers the panel shows. A part that another part ALREADY brings along
   (e.g. the amp a Stinger needs) is only counted once - its extra quantity
   is 'covered' and left out of the price, the stock check and the save.   */
export function sysSummary(d, items) {
  const byId = byIdOf(items);
  const cart = {};
  d.parts.forEach((p) => { if (byId[p.itemId]) cart[p.itemId] = (cart[p.itemId] || 0) + p.qty; });
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
  const partsCents = kit.base.reduce((n, x) => n + x.lineCents, 0) + (kit.addCents || 0);
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
  const s = sysSummary(d, items);
  const price = d.priceTouched ? d.priceCents : s.partsCents;
  const save = s.partsCents && price < s.partsCents ? Math.round(100 * (1 - price / s.partsCents)) : 0;
  return `
    <aside class="inv-detail sys-panel" aria-label="System builder">
      <header class="inv-detail-head">
        <div>
          <h2>${d.id ? 'Edit system' : 'New system'}</h2>
          <p class="inv-detail-sub">A rig made of other gear - one line on a quote</p>
        </div>
        <button type="button" class="inv-detail-close" id="sys-close" aria-label="Close">&times;</button>
      </header>
      <div class="inv-detail-body">
        <div class="inv-photo">
          <div class="inv-photo-preview" id="inv-photo-drop" title="Drag, paste or click to add a photo">
            ${d.photoUrl ? `<img src="${h.attr(d.photoUrl)}" alt="">` : '<span class="inv-photo-ph">S</span>'}
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
          <input class="ad-input" id="sys-name" value="${h.attr(d.name)}" placeholder="e.g. FOH System"></label>
        <div class="sys-row2">
          <label class="sys-field">Category
            <input class="ad-input" id="sys-cat" list="sys-cats" value="${h.attr(d.category)}">
            <datalist id="sys-cats">${(cats || []).map((c) => `<option value="${h.attr(c)}">`).join('')}</datalist></label>
          <label class="sys-field">Short description
            <input class="ad-input" id="sys-sub" value="${h.attr(d.subtitle)}" placeholder="e.g. Tops, subs & amp"></label>
        </div>

        <p class="sys-h">Parts</p>
        <div class="sys-search">
          <input class="ad-input" id="sys-search" placeholder="&#128269; Search gear to add..." value="${h.attr(d.search)}" autocomplete="off">
          <div class="sys-results" id="sys-results"></div>
        </div>
        <div id="sys-parts">${partsHtml(d, byId, h, s.covered)}</div>
        ${s.tagAlong.length ? `<p class="sys-tag"><b>Comes with automatically:</b> ${s.tagAlong.map((r) => h.esc(r.qty + ' × ' + r.name)).join(', ')}</p>` : ''}

        <p class="sys-h">Price</p>
        <div class="sys-price">
          <div><span>Parts add up to</span><b>${h.esc(h.money(s.partsCents))} / day</b></div>
          <label><span>System price</span>
            <span class="sys-dollar">$<input class="ad-input" type="number" min="0" step="1" id="sys-price" value="${h.attr(Math.round(price / 100))}"> / day</span></label>
          ${save > 0 ? `<em>Saves the customer ${save}%</em>` : ''}
        </div>

        <p class="sys-build${s.build ? '' : ' is-none'}">${d.parts.length
          ? (s.build ? '&#10003; You can build <b>' + s.build + '</b> of these with what you own' : '&#9888; You don’t own enough parts to build one')
          : 'Add the main gear above - cables and stands come along on their own.'}</p>

        <div class="sys-actions">
          <button type="button" class="ad-btn ad-btn-primary" id="sys-save">Save system</button>
          <span class="ad-quote-msg" id="sys-msg"></span>
        </div>
      </div>
    </aside>`;
}

function partsHtml(d, byId, h, covered) {
  if (!d.parts.length) return '<p class="sys-empty">No parts yet.</p>';
  return d.parts.map((p, i) => {
    const it = byId[p.itemId] || { name: '(missing item)' };
    return `<div class="sys-part" data-sys-i="${i}">
        <span class="qb-grip sys-grip" title="Drag to reorder">&#10303;</span>
        <span class="sys-pname">${h.esc(it.name)}<small>${h.esc(it.category || '')}</small>${covered && covered[p.itemId] ? '<em class="sys-covered">' + covered[p.itemId] + ' already comes with another part - only counted once</em>' : ''}</span>
        <span class="sys-qty"><button type="button" data-sys-minus="${i}" aria-label="Less">&minus;</button><b>${p.qty}</b><button type="button" data-sys-plus="${i}" aria-label="More">+</button></span>
        <span class="sys-own">${h.esc(it.quantityTotal != null ? it.quantityTotal : '?')} owned</span>
      </div>`;
  }).join('');
}

/* search results: real gear only (not other systems, not this one) */
function resultsHtml(d, items, h) {
  const q = d.search.trim().toLowerCase();
  if (!q) return '';
  const words = q.split(/\s+/);
  const hits = items.filter((it) => !it.isSystem && it.id !== d.id &&
    words.every((w) => [it.name, it.subtitle, it.category].join(' ').toLowerCase().includes(w))).slice(0, 6);
  if (!hits.length) return '<p class="sys-none">No gear matches.</p>';
  return hits.map((it) => `<button type="button" data-sys-add="${h.attr(it.id)}">${h.esc(it.name)}<small>${h.esc(it.category || '')} &middot; ${h.esc(h.money(it.priceCents || 0))}/day</small></button>`).join('');
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
    else if (id === 'sys-price') { d.priceCents = Math.max(0, Math.round(Number(e.target.value || 0) * 100)); d.priceTouched = true; }
    else if (id === 'sys-search') { d.search = e.target.value; document.getElementById('sys-results').innerHTML = resultsHtml(d, getItems(), h); }
  });
  panel.addEventListener('click', (e) => {
    const add = e.target.closest('[data-sys-add]');
    if (add) {
      const itemId = add.getAttribute('data-sys-add');
      const ex = d.parts.find((p) => p.itemId === itemId);
      if (ex) ex.qty++; else d.parts.push({ itemId, qty: 1 });
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
      if (!d.name) return say('Give the system a name first.', true);
      if (!d.parts.length) return say('Add at least one part.', true);
      const s = sysSummary(d, getItems());
      const price = d.priceTouched ? d.priceCents : s.partsCents;
      say('Saving…');
      act.save({
        name: d.name,
        category: (d.category || '').trim() || 'Audio',
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
        systemParts: d.parts.map((p) => ({ itemId: p.itemId, qty: p.qty })),   // as picked, for editing
        requirements: Object.keys(s.eff).map((id) => ({ itemId: id, rule: 'per-item', qty: s.eff[id], coversN: 1, charge: 'free', discountCents: 0 })),
      }).then(() => say('Saved.'), (err) => say((err && err.message) || 'Could not save.', true));
    }
  });
}
