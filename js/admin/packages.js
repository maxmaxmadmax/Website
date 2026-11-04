/* SOUNDZGOOD ADMIN - packages.js
   Packages: bundles the quote bot draws on.
   A plain script: every admin file shares one page scope, loaded in order by admin.html. */
'use strict';

/* =========================================================================
   PACKAGES  -  reusable, self-serve bundles the quote bot draws on

   A package belongs to an event type (Wedding, Party, ...) and holds one or
   more SIZE TIERS (Up to 50, Up to 150, ...), each a list of inventory items.
   On top sit OPTIONAL EXTRAS the customer can tick on. The price is never
   typed - it is the sum of the items' day rates, run through the kit engine
   so required gear (amps, leads) is included automatically. Change a price
   once in Inventory and every package follows.
   ========================================================================= */

function blankPackage() {
    return {
        name: '',
        eventType: '',
        description: '',
        active: true,
        maxGuests: '', // '' = any size; the bot picks the smallest that fits
        items: [],
        extras: [],
        discountCents: 0,
        minCents: 0,
        overrideCents: 0 // overrideCents > 0 replaces the auto price; minCents = price floor
    };
}

/*  Price helpers. Value = the gear day-rate sum (incl. kit-required gear).
    Customer price = a manual override, else value minus the package discount. */
function pkgValueCents(p, byId) {
    return packageItemsPriceCents((p && p.items) || [], byId).dayCents;
}
function pkgCustomerCents(p, byId) {
    if (p && p.overrideCents > 0) return p.overrideCents;
    const val = pkgValueCents(p, byId);
    const afterDisc = Math.max(0, val - Math.max(0, Math.round((p && p.discountCents) || 0)));
    return Math.max(Math.max(0, Math.round((p && p.minCents) || 0)), afterDisc); // never below the floor
}

let packageDraft = blankPackage();

function subscribeToPackages() {
    const { collection, onSnapshot } = fb.f;
    unsubscribes.push(
        onSnapshot(
            collection(fb.db, 'packages'),
            (snap) => {
                const rows = snapRows(snap);
                rows.sort(
                    (a, b) =>
                        (a.eventType || '').localeCompare(b.eventType || '') ||
                        (a.order || 0) - (b.order || 0) ||
                        (a.name || '').localeCompare(b.name || '')
                );
                state.packages = rows;
                if (state.view === 'packages') {
                    if (state.openPackageId)
                        renderPkgRows(); // panel open: refresh list only
                    else render();
                }
            },
            (err) => console.error('packages', err)
        )
    );
}

/*  Every inventory item keyed by id, for the kit engine and lookups. */
function invByIdMap() {
    const byId = {};
    invItems().forEach((it) => {
        byId[it.id] = it;
    });
    return byId;
}

/*  Day-rate price of a list of {itemId, qty}, including any required gear the
    kit engine pulls in. Returns cents + any stock shortages at that size.   */
function packageItemsPriceCents(items, byId) {
    const cart = {};
    (items || []).forEach((r) => {
        if (!r || !r.itemId) return;
        cart[r.itemId] = (cart[r.itemId] || 0) + Math.max(0, Math.round(r.qty || 0));
    });
    if (!Object.keys(cart).length) return { dayCents: 0, shortages: [] };
    const kit = expandKit(cart, byId);
    const baseCents = kit.base.reduce((s, b) => s + b.lineCents, 0);
    return { dayCents: baseCents + kit.addCents, shortages: kit.shortages };
}

function pkgEventTypes() {
    const set = new Set();
    (state.packages || []).forEach((p) => {
        if (p.eventType) set.add(p.eventType);
    });
    return [...set].sort((a, b) => a.localeCompare(b));
}

VIEWS.packages = {
    html() {
        const open = state.openPackageId != null;
        return `<div class="inv-wrap${open ? ' has-detail' : ''}">
      ${packageMainHtml()}
      ${open ? packageDetailHtml() : ''}
    </div>`;
    },
    wire() {
        wirePackageList();
        if (state.openPackageId != null) wirePackageDetail();
    }
};

/* ---- list (built to match the Inventory manager) ---- */
function pkgStats() {
    const rows = state.packages || [];
    return {
        total: rows.length,
        active: rows.filter((p) => p.active !== false).length,
        off: rows.filter((p) => p.active === false).length,
        types: pkgEventTypes().length
    };
}

function pkgFiltered() {
    const rows = state.packages || [];
    const f = state.pkgFilter || 'all';
    const needle = (state.pkgSearch || '').trim().toLowerCase();
    return rows.filter((p) => {
        if (f !== 'all' && (p.eventType || '') !== f) return false;
        if (!needle) return true;
        return [p.name, p.eventType].filter(Boolean).join(' ').toLowerCase().includes(needle);
    });
}

function pkgThumb(p) {
    const letter = (p.name || p.eventType || '?').trim().charAt(0).toUpperCase();
    return `<span class="inv-thumb ${invCatClass(p.eventType || '')}">${esc(letter)}</span>`;
}

function packageMainHtml() {
    const s = pkgStats();
    const f = state.pkgFilter;
    const types = pkgEventTypes();
    const opt = (v, l) => `<option value="${attr(v)}"${f === v ? ' selected' : ''}>${esc(l)}</option>`;

    return `
      <div class="inv-main">
        <div class="inv-head">
          <div class="inv-head-title">
            <span class="ad-mail-icon" aria-hidden="true">&#128230;</span>
            <div>
              <h1>Packages</h1>
              <p>Reusable bundles the quote bot builds from. The price is live from Inventory.</p>
            </div>
          </div>
          <div class="inv-head-actions">
            <button type="button" class="ad-btn ad-btn-primary" id="pkg-new">+ New package</button>
          </div>
        </div>

        <div class="ad-tiles">
          ${invTile('&#128230;', 'is-grey', s.total, 'Packages', '')}
          ${invTile('&#10003;', 'is-green', s.active, 'Active', '')}
          ${invTile('&#9711;', 'is-amber', s.off, 'Off', '')}
          ${invTile('&#9635;', 'is-blue', s.types, 'Event types', '')}
        </div>

        <div class="inv-toolbar">
          <input type="search" id="pkg-search" class="ad-search" placeholder="Search packages..."
                 value="${attr(state.pkgSearch)}" aria-label="Search packages">
          <select id="pkg-f-type" class="ad-select" aria-label="Filter by event type">
            ${opt('all', 'All event types')}${types.map((t) => opt(t, t)).join('')}
          </select>
        </div>

        <div class="ad-table-wrap inv-table-wrap">
          <table class="ad-table inv-table">
            <thead><tr>
              <th>Package</th><th>Event type</th><th>Gear</th><th>Extras</th>
              <th class="inv-num">Price</th><th>Status</th><th></th>
            </tr></thead>
            <tbody id="pkg-rows"></tbody>
          </table>
        </div>

        <div class="inv-foot" id="pkg-foot"></div>
      </div>`;
}

function renderPkgRows() {
    const host = document.getElementById('pkg-rows');
    const foot = document.getElementById('pkg-foot');
    if (!host) return;
    const byId = invByIdMap();
    const rows = pkgFiltered();
    host.innerHTML = rows.length
        ? rows
              .map((p) => {
                  const draft = packageFromDoc(p); // handles legacy tier data too
                  const gearN = (draft.items || []).length;
                  const xtra = (draft.extras || []).length;
                  return `
      <tr class="inv-row${state.openPackageId === p.id ? ' is-open' : ''}" data-open-pkg="${attr(p.id)}">
        <td class="inv-item-cell">${pkgThumb(p)}
          <span class="inv-item-text"><span class="inv-item-name">${esc(p.name || 'Untitled')}</span>${p.description ? `<span class="inv-item-sub">${esc(p.description)}</span>` : ''}</span></td>
        <td>${p.eventType ? `<span class="ad-pill ${invCatClass(p.eventType)}">${esc(p.eventType)}</span>` : '<span class="ad-cell-muted">—</span>'}</td>
        <td>${gearN} item${gearN === 1 ? '' : 's'}</td>
        <td>${xtra} extra${xtra === 1 ? '' : 's'}</td>
        <td class="inv-num">${esc(money(pkgCustomerCents(draft, byId)))}<span class="inv-perday">/day</span></td>
        <td>${p.active === false ? '<span class="ad-pill ad-pill-grey">Off</span>' : '<span class="ad-pill ad-pill-green">Active</span>'}</td>
        <td class="ad-cell-right"><button type="button" class="inv-open-btn" data-open-pkg="${attr(p.id)}" aria-label="Edit">&#8250;</button></td>
      </tr>`;
              })
              .join('')
        : `<tr><td colspan="7" class="ad-cell-muted">No packages match. Try clearing the search, or hit &ldquo;New package&rdquo;.</td></tr>`;
    if (foot) foot.innerHTML = `<p class="inv-foot-count">${rows.length} package${rows.length === 1 ? '' : 's'}</p>`;
}

function wirePackageList() {
    renderPkgRows();
    const nw = document.getElementById('pkg-new');
    if (nw)
        nw.addEventListener('click', () => {
            packageDraft = blankPackage();
            state.pkgTab = 'details';
            state.openPackageId = '__new__';
            render();
        });
    const search = document.getElementById('pkg-search');
    if (search)
        search.addEventListener('input', () => {
            state.pkgSearch = search.value;
            renderPkgRows();
        });
    const typeSel = document.getElementById('pkg-f-type');
    if (typeSel)
        typeSel.addEventListener('change', () => {
            state.pkgFilter = typeSel.value;
            renderPkgRows();
        });
    const host = document.getElementById('pkg-rows');
    if (host)
        host.addEventListener('click', (e) => {
            const r = e.target.closest('[data-open-pkg]');
            if (!r) return;
            const id = r.getAttribute('data-open-pkg');
            const doc = (state.packages || []).find((x) => x.id === id);
            packageDraft = doc ? packageFromDoc(doc) : blankPackage();
            state.pkgTab = 'details';
            state.openPackageId = id;
            render();
        });
}

function packageFromDoc(doc) {
    // Migrate old tier-based packages: fold the first tier's gear into the flat list.
    let items = Array.isArray(doc.items) ? doc.items : null;
    let discountCents = Math.max(0, Math.round(doc.discountCents || 0));
    if (!items && Array.isArray(doc.tiers) && doc.tiers.length) {
        items = doc.tiers[0].items || [];
        if (!discountCents) discountCents = Math.max(0, Math.round(doc.tiers[0].discountCents || 0));
    }
    let maxGuests = doc.maxGuests;
    if (maxGuests == null && Array.isArray(doc.tiers) && doc.tiers.length) maxGuests = doc.tiers[0].maxGuests;
    return {
        name: doc.name || '',
        eventType: doc.eventType || '',
        description: doc.description || '',
        active: doc.active !== false,
        maxGuests: maxGuests == null || maxGuests === '' ? '' : Math.max(0, Math.round(maxGuests)),
        items: (items || []).map((i) => ({ itemId: i.itemId, qty: Math.max(1, Math.round(i.qty || 1)) })),
        extras: (doc.extras || []).map((i) => ({ itemId: i.itemId, qty: Math.max(1, Math.round(i.qty || 1)) })),
        discountCents,
        minCents: Math.max(0, Math.round(doc.minCents || 0)),
        overrideCents: Math.max(0, Math.round(doc.overrideCents || 0))
    };
}

/* ---- detail panel (slides in from the right, like Inventory) ---- */
const PKG_TABS = [
    ['details', 'Details'],
    ['equipment', 'Equipment'],
    ['extras', 'Extras'],
    ['pricing', 'Pricing'],
    ['preview', 'Preview']
];

function packageDetailHtml() {
    const isNew = state.openPackageId === '__new__';
    const p = packageDraft;
    const pill =
        p.active !== false
            ? '<span class="ad-pill ad-pill-green pkg-head-pill">Active</span>'
            : '<span class="ad-pill ad-pill-grey pkg-head-pill">Off</span>';
    const tabs = PKG_TABS.map(
        ([k, l]) => `<button type="button" class="ad-linetab${state.pkgTab === k ? ' is-on' : ''}" data-pkg-tab="${k}">${l}</button>`
    ).join('');

    return `
    <aside class="inv-detail pkg-detail" aria-label="Package details">
      <header class="inv-detail-head">
        <div>
          <h2>${isNew ? 'New package' : esc(p.name || 'Package')} ${pill}</h2>
          ${p.description ? `<p class="inv-detail-sub">${esc(p.description)}</p>` : ''}
        </div>
        <button type="button" class="inv-detail-close" id="pkg-close" aria-label="Close">&times;</button>
      </header>

      <nav class="ad-linetabs">${tabs}</nav>

      <div class="inv-detail-body" id="pkg-tabbody"></div>

      <footer class="inv-detail-foot">
        ${isNew ? '' : '<button type="button" class="ad-btn inv-del" id="pkg-del">Delete package</button>'}
        <button type="button" class="ad-btn ad-btn-primary" id="pkg-save">${isNew ? 'Add package' : 'Save package'}</button>
        <span class="ad-quote-msg" id="pkg-msg"></span>
      </footer>
    </aside>`;
}

/*  A generic inventory typeahead: wires an input + results box so typing shows
    the top 3 matches; onPick(id) is called when one is chosen.              */
function pkgRenderResults(box, term, activeIdx) {
    const t = String(term || '')
        .trim()
        .toLowerCase();
    if (!t) {
        box.hidden = true;
        box.innerHTML = '';
        return [];
    }
    const matches = invSearchList()
        .filter((it) => it.name.toLowerCase().includes(t))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .slice(0, 3);
    if (!matches.length) {
        box.hidden = false;
        box.innerHTML = '<div class="qb-res-empty">No matching inventory</div>';
        return [];
    }
    box.hidden = false;
    box.innerHTML = matches
        .map(
            (it, i) => `
    <div class="qb-res${i === activeIdx ? ' is-active' : ''}" data-add="${attr(it.id)}">
      <span class="qb-res-name">${esc(it.name)}</span>
      <span class="qb-res-price">${esc(money(it.priceCents))}/day</span>
    </div>`
        )
        .join('');
    return matches;
}

function attachTypeahead(input, box, onPick) {
    if (!input || !box) return;
    let active = -1;
    const matchNow = () =>
        invSearchList()
            .filter((it) => it.name.toLowerCase().includes(input.value.trim().toLowerCase()))
            .slice(0, 3);
    input.addEventListener('input', () => {
        active = -1;
        pkgRenderResults(box, input.value, active);
    });
    input.addEventListener('focus', () => {
        if (input.value.trim()) pkgRenderResults(box, input.value, active);
    });
    input.addEventListener('keydown', (e) => {
        const m = matchNow();
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            active = Math.min(m.length - 1, active + 1);
            pkgRenderResults(box, input.value, active);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            active = Math.max(0, active - 1);
            pkgRenderResults(box, input.value, active);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const pick = m[active] || m[0];
            if (pick) {
                onPick(pick.id);
                input.value = '';
                box.hidden = true;
                active = -1;
            }
        } else if (e.key === 'Escape') {
            box.hidden = true;
            active = -1;
        }
    });
    box.addEventListener('mousedown', (e) => {
        const r = e.target.closest('[data-add]');
        if (!r) return;
        e.preventDefault();
        onPick(r.getAttribute('data-add'));
        input.value = '';
        box.hidden = true;
        active = -1;
    });
    input.addEventListener('blur', () =>
        setTimeout(() => {
            box.hidden = true;
        }, 150)
    );
}

function addPkgItem(list, itemId) {
    const existing = list.find((x) => x.itemId === itemId);
    if (existing) existing.qty = Math.max(1, Math.round(existing.qty || 1) + 1);
    else list.push({ itemId, qty: 1 });
}

/*  A gear thumbnail: the inventory item's photo, or a tinted initial - same
    look as the Inventory list. */
function pkgThumbItem(inv) {
    if (inv && inv.photoUrl) return `<span class="pkg-gthumb inv-thumb-img"><img src="${attr(inv.photoUrl)}" alt="" loading="lazy"></span>`;
    const l = ((inv && (inv.category || inv.name)) || '?').trim().charAt(0).toUpperCase();
    return `<span class="pkg-gthumb ${invCatClass((inv && inv.category) || '')}">${esc(l)}</span>`;
}

/*  A row of gear (included or extra) with an image, +/- qty stepper, rate and
    total. attrName is 'pi' (included) or 'xi' (extra). */
function pkgGearRow(it, byId, attrName, idx) {
    const inv = byId[it.itemId] || {};
    const qty = Math.max(1, Math.round(it.qty || 1));
    const line = (inv.priceCents || 0) * qty;
    return `
    <div class="pkg-gearrow" data-${attrName}="${idx}">
      <div class="pkg-gear-name">${pkgThumbItem(inv)}<span>${esc(inv.name || it.itemId)}</span></div>
      <div class="pkg-gear-qty">
        <button type="button" class="pkg-step" data-${attrName}-dec title="Less">&minus;</button>
        <span class="pkg-qtyval">${qty}</span>
        <button type="button" class="pkg-step" data-${attrName}-inc title="More">+</button>
      </div>
      <div class="pkg-gear-rate">${esc(money(inv.priceCents || 0))}</div>
      <div class="pkg-gear-total">${esc(money(line))}</div>
      <button type="button" class="qb-del" data-${attrName}-del title="Remove">&times;</button>
    </div>`;
}

function pkgSearchAdder(target) {
    return `
    <div class="qb-searchwrap pkg-searchwrap">
      <input type="text" class="qb-searchin" data-pkg-search="${target}" autocomplete="off" placeholder="&#128269;  Add inventory item&hellip;">
      <div class="qb-results pkg-results" data-pkg-results hidden></div>
    </div>`;
}

/*  Render the active tab into the panel body, and wire its search box(es). */
function renderPkgTab() {
    const host = document.getElementById('pkg-tabbody');
    if (!host) return;
    const tabs = { details: pkgDetailsTab, equipment: pkgEquipmentTab, extras: pkgExtrasTab, pricing: pkgPricingTab };
    host.innerHTML = (tabs[state.pkgTab || 'details'] || pkgPreviewTab)();

    host.querySelectorAll('[data-pkg-search]').forEach((input) => {
        const box = input.parentElement.querySelector('[data-pkg-results]');
        const target = input.getAttribute('data-pkg-search');
        attachTypeahead(input, box, (id) => {
            addPkgItem(target === 'extras' ? packageDraft.extras : packageDraft.items, id);
            renderPkgTab();
        });
    });
}

function pkgDetailsTab() {
    const p = packageDraft;
    const datalist = pkgEventTypes()
        .map((t) => `<option value="${attr(t)}">`)
        .join('');
    return `
    <div class="pkg-sec-h">Package details</div>
    <div class="inv-fgrid">
      <label class="ad-field inv-span2"><span>Package name *</span>
        <input class="ad-input" data-pf="name" value="${attr(p.name)}" placeholder="e.g. DJ Package – Small"></label>
      <label class="ad-field"><span>Event type</span>
        <input class="ad-input" list="pkg-types" data-pf="eventType" value="${attr(p.eventType)}" placeholder="e.g. DJ / Party">
        <datalist id="pkg-types">${datalist}</datalist></label>
      <label class="ad-field"><span>Suits up to N guests</span>
        <input class="ad-input" type="number" min="0" step="1" data-pf="maxGuests" value="${attr(p.maxGuests)}" placeholder="blank = any size"></label>
      <label class="ad-field inv-span2"><span>Short description</span>
        <textarea class="ad-input" rows="2" data-pf="description" placeholder="Shown to the customer, e.g. Perfect for small parties &amp; functions.">${esc(p.description || '')}</textarea></label>
    </div>
    <label class="inv-toggle">
      <span><strong>Active</strong><em>Offered by the quote bot.</em></span>
      <input type="checkbox" data-pf="active"${p.active !== false ? ' checked' : ''}>
      <span class="inv-switch" aria-hidden="true"></span>
    </label>`;
}

function pkgEquipmentTab() {
    const byId = invByIdMap();
    const p = packageDraft;
    const gear = (p.items || []).length
        ? p.items.map((it, i) => pkgGearRow(it, byId, 'pi', i)).join('')
        : '<p class="pkg-empty">No gear yet — search above to add.</p>';

    const cart = {};
    (p.items || []).forEach((it) => {
        if (it.itemId) cart[it.itemId] = (cart[it.itemId] || 0) + Math.max(0, Math.round(it.qty || 0));
    });
    const kit = Object.keys(cart).length ? expandKit(cart, byId) : { required: [] };
    const reqRows = (kit.required || [])
        .map(
            (r) => `
    <div class="pkg-reqrow">
      <div class="pkg-gear-name">${pkgThumbItem(byId[r.itemId] || {})}<span>${esc(r.name)}</span></div>
      <div class="pkg-req-qty">&times;${esc(r.qty)}</div>
      <div class="pkg-req-tag">${r.charge === 'free' || !r.unitCents ? 'Included' : esc(money(r.lineCents))}</div>
    </div>`
        )
        .join('');

    return `
    <div class="pkg-sec-h">Included gear
      <button type="button" class="ad-btn ad-btn-small pkg-addbtn" data-pkg-focus>+ Add inventory item</button></div>
    ${pkgSearchAdder('items')}
    ${(p.items || []).length ? '<div class="pkg-gearhead"><span>Item</span><span>Qty</span><span>Rate</span><span>Total</span><span></span></div>' : ''}
    <div class="pkg-gearlist">${gear}</div>
    ${
        reqRows
            ? `
      <div class="pkg-sec-h pkg-sec-req">Required gear <span class="pkg-auto">AUTO</span></div>
      <p class="inv-reqs-intro">Automatically included from inventory requirements. Duplicates are consolidated.</p>
      <div class="pkg-gearlist">${reqRows}</div>`
            : ''
    }`;
}

function pkgExtrasTab() {
    const byId = invByIdMap();
    const rows = (packageDraft.extras || []).length
        ? packageDraft.extras.map((it, i) => pkgGearRow(it, byId, 'xi', i)).join('')
        : '<p class="pkg-empty">No extras yet — search above to offer add-ons.</p>';
    return `
    <div class="pkg-sec-h">Optional extras</div>
    <p class="inv-reqs-intro">Add-ons the customer can tick on top of the package.</p>
    ${pkgSearchAdder('extras')}
    ${(packageDraft.extras || []).length ? '<div class="pkg-gearhead"><span>Item</span><span>Qty</span><span>Rate</span><span>Total</span><span></span></div>' : ''}
    <div class="pkg-gearlist">${rows}</div>`;
}

function pkgPricingTab() {
    const byId = invByIdMap();
    const p = packageDraft;
    const val = pkgValueCents(p, byId);
    const useOverride = p.overrideCents > 0;
    const cust = pkgCustomerCents(p, byId);
    const disc = Math.max(0, Math.round(p.discountCents || 0));
    const pct = val ? Math.round((disc / val) * 100) : 0;
    return `
    <div class="pkg-sec-h">Pricing</div>
    <label class="inv-toggle">
      <span><strong>Use inventory pricing</strong><em>Customer price = gear value minus discount.</em></span>
      <input type="checkbox" data-pf-useinv${useOverride ? '' : ' checked'}>
      <span class="inv-switch" aria-hidden="true"></span>
    </label>
    ${
        useOverride
            ? `
      <div class="inv-fgrid"><label class="ad-field inv-span2"><span>Override price $ / day</span>
        <input class="ad-input" type="number" min="0" step="1" data-poverride value="${attr(p.overrideCents ? p.overrideCents / 100 : '')}"></label></div>
      <div class="pkg-pricebox"><div class="pkg-priceline pkg-pricecust"><span>Customer price</span><span>${esc(money(cust))}/day</span></div></div>`
            : `
      <div class="pkg-pricebox">
        <div class="pkg-priceline"><span>Total inventory value</span><span>${esc(money(val))}</span></div>
        <div class="pkg-priceline"><span>Package discount</span>
          <span class="pkg-discinput">&minus;<span class="qb-inline-dollar">$</span><input class="qb-num qb-num-total" type="number" min="0" step="1" data-pdisc value="${attr(disc ? disc / 100 : '')}"></span></div>
        <div class="pkg-priceline"><span>Minimum price <em class="pkg-minhint">(floor)</em></span>
          <span class="pkg-discinput"><span class="qb-inline-dollar">$</span><input class="qb-num qb-num-total" type="number" min="0" step="1" data-pmin value="${attr(p.minCents ? p.minCents / 100 : '')}"></span></div>
        <div class="pkg-priceline pkg-pricecust"><span>Customer price</span><span>${esc(money(cust))}/day</span></div>
      </div>
      ${disc ? `<p class="pkg-savechip">${pct}% off inventory value</p>` : ''}`
    }`;
}

function pkgPreviewTab() {
    const byId = invByIdMap();
    const p = packageDraft;
    const cust = pkgCustomerCents(p, byId);
    const gear = (p.items || [])
        .map((it) => {
            const inv = byId[it.itemId] || {};
            return `<li>${Math.max(1, Math.round(it.qty || 1))}&times; ${esc(inv.name || it.itemId)}</li>`;
        })
        .join('');
    const extras = (p.extras || [])
        .map((it) => {
            const inv = byId[it.itemId] || {};
            return `<li>${esc(inv.name || it.itemId)}${it.qty > 1 ? ' &times;' + it.qty : ''}</li>`;
        })
        .join('');
    return `
    <div class="pkg-preview">
      <h3>${esc(p.name || 'Package')}</h3>
      ${p.eventType ? `<p class="pkg-prev-type">${esc(p.eventType)}</p>` : ''}
      ${p.description ? `<p>${esc(p.description)}</p>` : ''}
      <p class="pkg-prev-price">${esc(money(cust))}<span>/day</span></p>
      ${gear ? `<h4>Included</h4><ul>${gear}</ul>` : ''}
      ${extras ? `<h4>Optional extras</h4><ul>${extras}</ul>` : ''}
    </div>`;
}

/*  Live-update the customer price figure while typing in discount/override,
    without rebuilding the input. */
function updatePkgPriceView() {
    const el = document.querySelector('.pkg-pricecust span:last-child');
    if (el) el.textContent = money(pkgCustomerCents(packageDraft, invByIdMap())) + '/day';
}

function wirePackageDetail() {
    renderPkgTab();

    const wrap = document.querySelector('.inv-detail');
    if (!wrap) return;

    const close = document.getElementById('pkg-close');
    if (close)
        close.addEventListener('click', () => {
            state.openPackageId = null;
            render();
        });

    // tab switching
    wrap.querySelectorAll('[data-pkg-tab]').forEach((b) =>
        b.addEventListener('click', () => {
            state.pkgTab = b.getAttribute('data-pkg-tab');
            wrap.querySelectorAll('[data-pkg-tab]').forEach((x) => x.classList.toggle('is-on', x === b));
            renderPkgTab();
        })
    );

    // field edits (delegated, survives tab re-renders)
    wrap.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.pf) {
            const f = t.dataset.pf;
            if (f === 'active') packageDraft.active = t.checked;
            else packageDraft[f] = t.value;
            return;
        }
        if (t.hasAttribute('data-pf-useinv')) {
            if (t.checked) packageDraft.overrideCents = 0;
            else packageDraft.overrideCents = Math.max(1, packageDraft.overrideCents || pkgCustomerCents(packageDraft, invByIdMap()));
            renderPkgTab();
            return;
        }
        if (t.hasAttribute('data-poverride')) {
            packageDraft.overrideCents = toCents(t.value);
            updatePkgPriceView();
            return;
        }
        if (t.hasAttribute('data-pdisc')) {
            packageDraft.discountCents = toCents(t.value);
            updatePkgPriceView();
            return;
        }
        if (t.hasAttribute('data-pmin')) {
            packageDraft.minCents = toCents(t.value);
            updatePkgPriceView();
            return;
        }
    });

    // steppers, deletes, add-item focus (delegated)
    wrap.addEventListener('click', (e) => {
        const focusAdd = e.target.closest('[data-pkg-focus]');
        if (focusAdd) {
            const s = wrap.querySelector('[data-pkg-search]');
            if (s) s.focus();
            return;
        }

        // pi = an included gear row, xi = an extra
        for (const [a, list] of [
            ['pi', packageDraft.items],
            ['xi', packageDraft.extras]
        ]) {
            const inc = e.target.closest('[data-' + a + '-inc]');
            const dec = e.target.closest('[data-' + a + '-dec]');
            const del = e.target.closest('[data-' + a + '-del]');
            if (!inc && !dec && !del) continue;
            const row = e.target.closest('[data-' + a + ']');
            if (!row) return;
            const i = Number(row.getAttribute('data-' + a));
            const it = list[i];
            if (!it) return;
            if (del) list.splice(i, 1);
            else it.qty = Math.max(1, Math.round((it.qty || 1) + (inc ? 1 : -1)));
            renderPkgTab();
            return;
        }
    });

    const save = document.getElementById('pkg-save');
    if (save) save.addEventListener('click', () => savePackage(save));
    const del = document.getElementById('pkg-del');
    if (del) del.addEventListener('click', () => deletePackage(del));
}

async function savePackage(btn) {
    const msg = document.getElementById('pkg-msg');
    const p = packageDraft;
    if (!String(p.name || '').trim()) {
        setMsg(msg, 'Give the package a name first.', 'is-bad');
        return;
    }
    const clean = {
        name: String(p.name).trim().slice(0, 160),
        eventType: String(p.eventType || '')
            .trim()
            .slice(0, 80),
        description: String(p.description || '')
            .trim()
            .slice(0, 600),
        active: p.active !== false,
        maxGuests: p.maxGuests === '' || p.maxGuests == null ? null : Math.max(0, Math.round(Number(p.maxGuests) || 0)),
        items: (p.items || []).filter((i) => i.itemId).map((i) => ({ itemId: i.itemId, qty: Math.max(1, Math.round(i.qty || 1)) })),
        extras: (p.extras || []).filter((i) => i.itemId).map((i) => ({ itemId: i.itemId, qty: Math.max(1, Math.round(i.qty || 1)) })),
        discountCents: Math.max(0, Math.round(p.discountCents || 0)),
        minCents: Math.max(0, Math.round(p.minCents || 0)),
        overrideCents: Math.max(0, Math.round(p.overrideCents || 0)),
        tiers: null, // clear any legacy tier data now the model is flat
        updatedAt: Date.now()
    };

    setMsg(msg, 'Saving…', '');
    if (btn) btn.disabled = true;
    try {
        const { collection, doc, setDoc, addDoc } = fb.f;
        state.packages = state.packages || [];
        if (state.openPackageId === '__new__') {
            clean.order = state.packages.length;
            clean.createdAt = Date.now();
            const ref = await addDoc(collection(fb.db, 'packages'), clean);
            state.openPackageId = ref.id;
            state.packages.push({ id: ref.id, ...clean });
        } else {
            const id = state.openPackageId;
            await setDoc(doc(fb.db, 'packages', id), clean, { merge: true });
            const cur = state.packages.find((x) => x.id === id);
            if (cur) Object.assign(cur, clean);
            else state.packages.push({ id, ...clean });
        }
        setMsg(msg, 'Saved.', 'is-ok');
        render();
    } catch (err) {
        setMsg(msg, err.message || 'Could not save.', 'is-bad');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function deletePackage(btn) {
    if (!window.confirm('Delete this package? This cannot be undone.')) return;
    const id = state.openPackageId;
    if (id === '__new__') {
        state.openPackageId = null;
        render();
        return;
    }
    if (btn) btn.disabled = true;
    try {
        const { doc, deleteDoc } = fb.f;
        await deleteDoc(doc(fb.db, 'packages', id));
        state.packages = (state.packages || []).filter((x) => x.id !== id);
        state.openPackageId = null;
        render();
    } catch (err) {
        const msg = document.getElementById('pkg-msg');
        setMsg(msg, err.message || 'Could not delete.', 'is-bad');
        if (btn) btn.disabled = false;
    }
}
