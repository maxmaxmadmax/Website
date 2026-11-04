/* SOUNDZGOOD ADMIN - inventory.js
   Inventory: the equipment manager.
   A plain script: every admin file shares one page scope, loaded in order by admin.html. */
'use strict';

/* =========================================================================
   INVENTORY  -  the equipment manager

   A table with thumbnails, category and status pills, quantities and hire
   pricing, plus a detail panel for editing one item. It is the source of
   truth - the bot's extras and prices come from items flagged "Available
   for quotes". Quantities and status are set by hand.

   Items live in the `inventory` collection, one document each.
   ========================================================================= */

/*  The real gear, live from Firestore (empty until it arrives). */
function invModelRaw() {
    return Array.isArray(state.inventory) ? state.inventory : [];
}

const invNum = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
};

/*  Normalise a stored item to every field the page expects, coping with
    older documents (quantity -> quantityTotal, and no availability yet). */
function invItem(raw) {
    const r = raw || {};
    const qt = invNum(r.quantityTotal != null ? r.quantityTotal : r.quantity, 0);
    const qaRaw = r.quantityAvailable != null ? r.quantityAvailable : qt;
    return {
        id: r.id || '',
        name: r.name || '',
        subtitle: r.subtitle || '',
        category: r.category || '',
        status: r.status || 'available',
        quantityTotal: qt,
        quantityAvailable: Math.max(0, Math.min(invNum(qaRaw, 0), qt)),
        quantityRepair: Math.max(0, Math.min(invNum(r.quantityRepair, 0), qt)),
        location: r.location || '',
        pricingType: r.pricingType || 'per-day',
        priceCents: invNum(r.priceCents, 0),
        extraDayCents: invNum(r.extraDayCents, 0),
        replacementCents: invNum(r.replacementCents, 0),
        setupMins: Math.max(0, invNum(r.setupMins, 0)), // man-minutes to set up one unit; feeds labour
        internalNotes: r.internalNotes || '',
        specs: r.specs || '',
        weight: r.weight || '',
        powerDraw: r.powerDraw || '',
        included: r.included || '',
        inBot: r.inBot !== false,
        photoUrl: r.photoUrl || '',
        photoPath: r.photoPath || '',
        repairFault: r.repairFault || '',
        repairWith: r.repairWith || '',
        repairDue: r.repairDue || '',
        requirements: (Array.isArray(r.requirements) ? r.requirements : []).map(normalizeReq),
        order: invNum(r.order, 0),
        isSystem: r.isSystem === true, // a KIT or PACKAGE - made of other gear (Kit / Package builder)
        bundleType: r.isSystem === true ? (r.bundleType === 'package' ? 'package' : 'kit') : '',
        botOffer: r.botOffer === true, // packages: offered on the website bot
        eventType: r.eventType || '',
        maxGuests: invNum(r.maxGuests, 0),
        systemParts: Array.isArray(r.systemParts) ? r.systemParts : [],
        consumable: r.consumable === true, // used up on the job (haze fluid...) - Consumables tab
        unit: r.unit || '', // e.g. "1 L bottle"
        reorderAt: Math.max(0, invNum(r.reorderAt, 0)) // low-stock warning at or below this
    };
}

function invItems() {
    return invModelRaw().map(invItem);
}
const invLow = (it) => it.consumable && it.reorderAt > 0 && it.quantityTotal - it.quantityRepair <= it.reorderAt;

/* -------------------------------------------------------------------------
   Item requirements  -  the gear an item needs (see js/admin/kit.js for the maths)
   ------------------------------------------------------------------------- */
function normalizeReq(r) {
    r = r || {};
    const rule = r.rule === 'shared' ? 'shared' : 'per-item';
    const charge = ['normal', 'discounted', 'free'].includes(r.charge) ? r.charge : 'normal';
    return {
        itemId: String(r.itemId || ''),
        rule,
        qty: Math.max(rule === 'shared' ? 1 : 0, Math.round(invNum(r.qty, 1))),
        coversN: Math.max(1, Math.round(invNum(r.coversN, 1))),
        charge,
        discountCents: Math.max(0, Math.round(invNum(r.discountCents, 0)))
    };
}

/*  The working copy of the open item's requirements, edited in the panel and
    written back on save. Kept off the item so a live snapshot cannot wipe an
    edit in progress (same reason as the pending photo).                    */
let invReqDraft = [];
function initInvReqDraft(item) {
    invReqDraft = (item && Array.isArray(item.requirements) ? item.requirements : []).map(normalizeReq);
}

/*  Every OTHER item, for the "required item" dropdown - an item cannot
    require itself.                                                         */
function invReqOptions(excludeId) {
    return invItems()
        .filter((it) => it.id && it.id !== excludeId && it.name)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/*  itemsById for the kit engine, with the item being edited overlaid with
    the in-progress draft (and given a temp id when it is brand new).      */
function invKitIndex(editId, editName) {
    const byId = invByIdMap();
    const id = editId && editId !== '__new__' ? editId : '__preview__';
    byId[id] = {
        id,
        name: editName || (byId[editId] && byId[editId].name) || 'This item',
        priceCents: (byId[editId] && byId[editId].priceCents) || 0,
        quantityAvailable: byId[editId] ? byId[editId].quantityAvailable : Infinity,
        quantityTotal: byId[editId] ? byId[editId].quantityTotal : Infinity,
        requirements: invReqDraft
    };
    return { byId, id };
}

/*  Category pills get a stable colour from the category name, so "Audio" is
    always the same blue without a hard-coded list.                        */
const INV_CAT_CLASSES = ['inv-c1', 'inv-c2', 'inv-c3', 'inv-c4', 'inv-c5', 'inv-c6'];
function invCatClass(cat) {
    if (!cat) return 'inv-c0';
    let h = 0;
    for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
    return INV_CAT_CLASSES[h % INV_CAT_CLASSES.length];
}

const INV_STATUS = {
    available: ['ad-pill-green', 'Available'],
    'on-hire': ['ad-pill-blue', 'On Hire'],
    'in-repair': ['ad-pill-red', 'In Repair']
};
function invStatusPill(status) {
    const [cls, label] = INV_STATUS[status] || INV_STATUS.available;
    return `<span class="ad-pill ${cls}">${esc(label)}</span>`;
}

/*  A thumbnail stand-in when there is no photo: a tinted tile with the
    category's first letter. */
function invThumb(it) {
    if (it.photoUrl) {
        return `<span class="inv-thumb inv-thumb-img"><img src="${attr(it.photoUrl)}" alt="" loading="lazy"></span>`;
    }
    const letter = (it.category || it.name || '?').trim().charAt(0).toUpperCase();
    return `<span class="inv-thumb ${invCatClass(it.category)}">${esc(letter)}</span>`;
}

/*  The units, split so available + on-hire + in-repair == total, counted
    from the quantities on each item rather than a single status - so one
    item can have some units on hire and some in for repair at once.

    owned  = available + in repair + on hire.
    Anything not available and not in repair is taken to be out on hire.    */
function invStats() {
    const items = invItems();
    let total = 0,
        available = 0,
        onHire = 0,
        inRepair = 0;
    items.forEach((it) => {
        if (it.consumable) return; // the tiles count gear, not haze fluid
        const repair = Math.min(it.quantityRepair, it.quantityTotal);
        const avail = Math.min(it.quantityAvailable, it.quantityTotal - repair);
        total += it.quantityTotal;
        available += avail;
        inRepair += repair;
        onHire += Math.max(0, it.quantityTotal - avail - repair);
    });
    return { total, available, onHire, inRepair };
}

function invDistinct(key) {
    const set = [];
    invItems().forEach((it) => {
        const v = (it[key] || '').trim();
        if (v && !set.includes(v)) set.push(v);
    });
    return set.sort((a, b) => a.localeCompare(b));
}

function invFiltered() {
    const f = state.invFilter;
    const needle = (f.search || '').trim().toLowerCase();
    const cons = state.invTab === 'consumables';
    return invItems().filter((it) => {
        if (it.consumable !== cons) return false; // gear and consumables on their own tabs
        if (f.category !== 'all' && it.category !== f.category) return false;
        if (f.location !== 'all' && it.location !== f.location) return false;
        if (f.status !== 'all' && it.status !== f.status) return false;
        if (!needle) return true;
        return searchMatch(needle, it.name, it.subtitle, it.category, it.location);
    });
}

const INV_PER_PAGE = 50; // the list scrolls inside the screen, so more fit per page

/* -------------------------------------------------------------------------
   The view
   ------------------------------------------------------------------------- */
VIEWS.inventory = {
    html() {
        const s = invStats();
        const pct = (n) => (s.total ? Math.round((n / s.total) * 100) : 0);
        const cats = invDistinct('category');
        const locs = invDistinct('location');
        const f = state.invFilter;

        const opt = (val, label, cur) => `<option value="${attr(val)}"${cur === val ? ' selected' : ''}>${esc(label)}</option>`;

        const open = state.openInvId != null || state.openSysId != null;
        const oldPkgs = oldBotPackages().length;
        const lowCount = invItems().filter(invLow).length;
        const dates = invDates();

        return `
      <div class="inv-wrap${open ? ' has-detail' : ''}">
        <div class="inv-main">
          <div class="inv-head">
            <div class="inv-head-title">
              <span class="ad-mail-icon" aria-hidden="true">&#128230;</span>
              <div>
                <h1>Inventory</h1>
                <p>Manage your equipment, availability and hire pricing.</p>
              </div>
            </div>
            <div class="inv-head-actions">
              <button type="button" class="ad-btn" id="inv-add-pkg" title="Kits and single items together, e.g. 4-Piece Band Backline">+ New package</button>
              <button type="button" class="ad-btn" id="inv-add-sys" title="A rig made of other gear, e.g. FOH Kit">+ New kit</button>
              <button type="button" class="ad-btn" id="inv-shrink" title="Make every photo smaller and name it after the product">Shrink photos</button>
              <button type="button" class="ad-btn ad-btn-primary" id="inv-add">${state.invTab === 'consumables' ? '+ Add consumable' : '+ Add Item'}</button>
            </div>
          </div>

          <div class="ad-tiles">
            ${invTile('&#128230;', 'is-grey', s.total, 'Total Items', '')}
            ${invTile('&#10003;', 'is-green', s.available, 'Available', pct(s.available) + '%')}
            ${invTile('&#128666;', 'is-blue', s.onHire, 'On Hire', pct(s.onHire) + '%')}
            ${invTile('&#128295;', 'is-amber', s.inRepair, 'In Repair', pct(s.inRepair) + '%')}
          </div>

          ${
              oldPkgs
                  ? `<div class="inv-migrate">
            <span>You have <b>${oldPkgs}</b> website-bot package${oldPkgs === 1 ? '' : 's'} in the old Packages section. Move them here so you can edit them with kits.</span>
            <button type="button" class="ad-btn ad-btn-small" id="inv-migrate-pkgs">Move into Inventory</button>
          </div>`
                  : ''
          }
          <div class="ad-tabs" role="tablist">
            <button type="button" class="ad-tab${state.invTab !== 'consumables' ? ' is-on' : ''}" data-inv-tab="gear">Equipment</button>
            <button type="button" class="ad-tab${state.invTab === 'consumables' ? ' is-on' : ''}" data-inv-tab="consumables">Consumables${lowCount ? ' <span class="inv-low-dot" title="Something is low - reorder">' + lowCount + ' low</span>' : ''}</button>
          </div>
          <div class="inv-toolbar">
            <input type="search" id="inv-search" class="ad-search" placeholder="Search items..."
                   value="${attr(f.search)}" aria-label="Search inventory">
            <select id="inv-f-category" class="ad-select" aria-label="Filter by category">
              ${opt('all', 'All categories', f.category)}
              ${cats.map((c) => opt(c, c, f.category)).join('')}
            </select>
            <select id="inv-f-location" class="ad-select" aria-label="Filter by location">
              ${opt('all', 'All locations', f.location)}
              ${locs.map((c) => opt(c, c, f.location)).join('')}
            </select>
            <span class="inv-dates" title="Show what's on hire and left for these dates">
              <span>Stock for</span>
              <input type="date" id="inv-d-from" class="ad-input" value="${attr(dates.from)}" aria-label="From">
              <span>to</span>
              <input type="date" id="inv-d-to" class="ad-input" value="${attr(dates.to)}" aria-label="To">
            </span>
            <select id="inv-f-status" class="ad-select" aria-label="Filter by status">
              ${opt('all', 'All status', f.status)}
              ${opt('available', 'Available', f.status)}
              ${opt('on-hire', 'On Hire', f.status)}
              ${opt('in-repair', 'In Repair', f.status)}
            </select>
          </div>

          <div class="ad-table-wrap inv-table-wrap">
            <table class="ad-table inv-table">
              <thead>
                <tr>
                  ${invTh('name', 'Item')}
                  ${invTh('category', 'Category')}
                  ${invTh('quantityTotal', 'Total', true)}
                  <th class="inv-num" title="Booked jobs (deposit in) on the dates above">On hire</th>
                  <th class="inv-num" title="Total, less in repair, less on hire">Left</th>
                  ${invTh('location', 'Location')}
                  ${invTh('priceCents', 'Hire / day', true)}
                  ${invTh('extraDayCents', 'Extra day', true)}
                  ${invTh('status', 'Status')}
                  <th></th>
                </tr>
              </thead>
              <tbody id="inv-rows"></tbody>
            </table>
          </div>

          <div class="inv-foot" id="inv-foot"></div>
        </div>

        ${state.openSysId != null ? systemPanelHtml(sysDraft, invItems(), H, invDistinct('category')) : open ? invDetail() : ''}
      </div>
    `;
    },

    wire() {
        wireInventory();
    }
};

/*  A sortable column header. Clicking it sorts by that field; clicking the
    active one flips the direction.                                         */
function invTh(key, label, num) {
    const on = state.invSort.key === key;
    //  An idle up/down arrow on every column so it reads as sortable; the
    //  active column shows a solid up or down caret instead.
    const glyph = on ? (state.invSort.dir === 'asc' ? '▲' : '▼') : '⇅';
    return `<th class="${num ? 'inv-num ' : ''}inv-th-sort${on ? ' is-sorted' : ''}"
              data-sort="${attr(key)}">${esc(label)}<span class="inv-caret${on ? '' : ' inv-caret-idle'}">${glyph}</span></th>`;
}

const INV_NUM_KEYS = ['quantityTotal', 'quantityAvailable', 'priceCents', 'extraDayCents'];

/*  Apply the chosen column sort. No sort chosen -> leave the default order
    (category, then name) the list already comes in.                        */
function invSorted(list) {
    // SYSTEMS FIRST, A-Z, then the rest as chosen below
    // PACKAGES first, then KITS, each A-Z, then single items
    const az = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
    const pkgs = list.filter((it) => it.isSystem && it.bundleType === 'package').sort(az);
    const kits = list.filter((it) => it.isSystem && it.bundleType !== 'package').sort(az);
    const rest = invSortedRest(list.filter((it) => !it.isSystem));
    return pkgs.concat(kits, rest);
}
function invSortedRest(list) {
    const { key, dir } = state.invSort;
    if (!key) return list;
    const mul = dir === 'desc' ? -1 : 1;

    //  Names that start with a letter come first (A-Z); anything starting with
    //  a number or symbol sorts after Z, rather than jumping to the top.
    const rank = (s) => (/^\s*[a-z]/i.test(s) ? 0 : 1);

    return list.slice().sort((a, b) => {
        if (INV_NUM_KEYS.includes(key)) return ((a[key] || 0) - (b[key] || 0)) * mul;
        const av = String(a[key] || '');
        const bv = String(b[key] || '');
        const ra = rank(av);
        const rb = rank(bv);
        if (ra !== rb) return (ra - rb) * mul;
        return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' }) * mul;
    });
}

/*  Refresh the carets / highlight on the header row in place, so sorting
    does not need a full re-render (which would disturb an open panel).    */
function updateInvSortHeaders() {
    document.querySelectorAll('.inv-table thead [data-sort]').forEach((th) => {
        const on = state.invSort.key === th.getAttribute('data-sort');
        th.classList.toggle('is-sorted', on);
        const caret = th.querySelector('.inv-caret');
        if (caret) caret.textContent = on ? (state.invSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    });
}

function invTile(icon, cls, value, label, pct) {
    return `
    <div class="ad-tile">
      <span class="ad-tile-ico ${cls}" aria-hidden="true">${icon}</span>
      <span class="ad-tile-body"><b class="ad-tile-value">${esc(value)}</b><span class="ad-tile-label">${esc(label)}</span></span>
      ${pct ? `<span class="ad-tile-pct">${esc(pct)}</span>` : ''}
    </div>`;
}

/*  The event types the website bot offers - from packages already set up,
    plus the usual ones, for the Package builder's Event type box.         */
function botEventTypes() {
    const set = new Set(['Live Music', 'Wedding', 'Corporate', 'DJ / Party']);
    (state.packages || []).forEach((p) => {
        if (p.eventType) set.add(p.eventType);
    });
    invItems().forEach((it) => {
        if (it.bundleType === 'package' && it.eventType) set.add(it.eventType);
    });
    return [...set].sort((a, b) => a.localeCompare(b));
}

/*  Moves an old website-bot "Packages" record into Inventory as a real
    package. The old record is kept, marked moved and switched off. */
function oldBotPackages() {
    return (state.packages || []).filter((p) => !p.migratedTo && Array.isArray(p.items) && p.items.length);
}
async function migrateOldPackages(btn) {
    const old = oldBotPackages();
    if (!old.length) return;
    if (
        !window.confirm(
            'Move ' +
                old.length +
                ' website-bot package' +
                (old.length === 1 ? '' : 's') +
                ' into Inventory as packages? They keep their gear, price, event type and guest size, and the bot keeps offering them.'
        )
    )
        return;
    btn.disabled = true;
    const { collection, doc, setDoc, addDoc } = fb.f;
    const items = invItems();
    let done = 0;
    for (const p of old) {
        const d = sysDraftFrom(null, 'package');
        d.parts = (p.items || []).filter((i) => i && i.itemId).map((i) => ({ itemId: i.itemId, qty: Math.max(1, Math.round(i.qty || 1)) }));
        const s = sysSummary(d, items);
        const price =
            p.overrideCents > 0
                ? p.overrideCents
                : Math.max(Math.max(0, Math.round(p.minCents || 0)), s.partsCents - Math.max(0, Math.round(p.discountCents || 0)));
        const data = {
            name: p.name || 'Package',
            category: 'Package',
            subtitle: p.description || '',
            isSystem: true,
            bundleType: 'package',
            botOffer: p.active !== false,
            eventType: p.eventType || '',
            maxGuests: Math.max(0, Math.round(Number(p.maxGuests) || 0)),
            priceCents: price,
            extraDayCents: 0,
            pricingType: 'per-day',
            status: 'available',
            inBot: true,
            quantityTotal: s.build === Infinity ? 0 : s.build,
            quantityAvailable: s.build === Infinity ? 0 : s.build,
            quantityRepair: 0,
            systemParts: d.parts,
            requirements: Object.keys(s.eff).map((id) => ({
                itemId: id,
                rule: 'per-item',
                qty: s.eff[id],
                coversN: 1,
                charge: 'free',
                discountCents: 0
            })),
            order: (state.inventory || []).length + done
        };
        try {
            const ref = await addDoc(collection(fb.db, 'inventory'), data);
            await setDoc(doc(fb.db, 'packages', p.id), { migratedTo: ref.id, active: false }, { merge: true });
            done++;
        } catch (e) {
            window.alert('Could not move "' + (p.name || p.id) + '": ' + (e.message || e));
        }
    }
    btn.textContent = done + ' moved';
}

/*  KIT / PACKAGE BUILDER state (js/admin/system-builder.js) */
let sysDraft = sysDraftFrom(null);
function openSystem(id, type) {
    const it = id && id !== '__new__' ? invItems().find((x) => x.id === id) : null;
    clearPendingPhoto();
    sysDraft = sysDraftFrom(it, type);
    sysDraft.eventTypes = botEventTypes();
    sysDraft.crewList = (state.resources || [])
        .filter((r) => r.active !== false && r.name)
        .map((r) => ({ id: r.id, name: r.name, dayRateCents: r.dayRateCents || 0, type: r.type || 'staff' }));
    state.openInvId = null;
    state.openSysId = it ? it.id : '__new__';
    render();
}
async function saveSystem(data) {
    const { collection, doc, setDoc, addDoc } = fb.f;
    if (state.openSysId && state.openSysId !== '__new__') {
        await setDoc(doc(fb.db, 'inventory', state.openSysId), data, { merge: true });
    } else {
        const ref = await addDoc(collection(fb.db, 'inventory'), { ...data, order: (state.inventory || []).length });
        state.openSysId = ref.id;
        sysDraft.id = ref.id;
        if (pendingPhoto) {
            // a photo added before the first save
            try {
                const up = await doUploadPhoto(ref.id, pendingPhoto, data.name);
                sysDraft.photoUrl = up.url;
            } catch (e) {
                /* system saved; photo can be re-added */
            }
            clearPendingPhoto();
        }
    }
}

/*  STOCK FOR CHOSEN DATES: booked jobs (deposit in) count
    against stock; quoted / accepted-but-unpaid jobs show as "pencilled".   */
function todayIso() {
    return isoDay(new Date());
}
function invDates() {
    const t = todayIso();
    const d = state.invDates || { from: t, to: t };
    return { from: d.from || t, to: d.to && d.to >= (d.from || t) ? d.to : d.from || t };
}
function invStockCells(it, use, byId) {
    if (it.isSystem) {
        let build = Infinity;
        (it.requirements || []).forEach((r) => {
            const p = byId[r.itemId];
            if (!p) return;
            const pu = use[p.id] || { booked: 0 };
            const leftP = Math.max(0, p.quantityTotal - Math.min(p.quantityRepair || 0, p.quantityTotal) - pu.booked);
            build = Math.min(build, Math.floor(leftP / Math.max(1, r.qty || 1)));
        });
        if (build === Infinity) build = 0;
        const us = use[it.id] || { booked: 0, pencilled: 0 };
        return (
            '<td class="inv-num">' +
            (us.booked || us.pencilled
                ? '<span title="Systems booked on these dates">' +
                  us.booked +
                  (us.pencilled ? ' <small>+' + us.pencilled + '</small>' : '') +
                  '</span>'
                : '<span class="ad-cell-muted">&mdash;</span>') +
            '</td><td class="inv-num"><b class="inv-left' +
            (build ? '' : ' is-out') +
            '" title="How many you can still build from the parts left">' +
            build +
            '</b></td>'
        );
    }
    const u = use[it.id] || { booked: 0, pencilled: 0, jobs: [] };
    const repair = Math.min(it.quantityRepair || 0, it.quantityTotal);
    const left = Math.max(0, it.quantityTotal - repair - u.booked);
    let tone = '';
    if (left <= 0 && (u.booked || u.pencilled)) tone = ' is-out';
    else if (u.pencilled > left) tone = ' is-tight';
    const jobs = u.jobs.length
        ? '<div class="inv-jobs">' +
          u.jobs
              .map((j) => '<span>' + esc(j.qty) + '&times; ' + esc(j.label) + (j.booked ? '' : ' <em>(pencilled)</em>') + '</span>')
              .join('') +
          '</div>'
        : '';
    const hire =
        u.booked || u.pencilled
            ? '<details class="inv-hire" data-no-row><summary>' +
              (u.booked || '0') +
              (u.pencilled ? ' <small>+' + u.pencilled + ' pencilled</small>' : '') +
              '</summary>' +
              jobs +
              '</details>'
            : '<span class="ad-cell-muted">&mdash;</span>';
    return '<td class="inv-num">' + hire + '</td><td class="inv-num"><b class="inv-left' + tone + '">' + left + '</b></td>';
}

function invRowsHtml() {
    const dates = invDates();
    const use = stockUsage(state.quoteDocs || [], dates.from, dates.to);
    const rows = invSorted(invFiltered());
    const pages = Math.max(1, Math.ceil(rows.length / INV_PER_PAGE));
    if (state.invPage > pages) state.invPage = pages;
    const start = (state.invPage - 1) * INV_PER_PAGE;
    const pageRows = rows.slice(start, start + INV_PER_PAGE);
    const byId = pageRows.some((it) => it.isSystem) ? invByIdMap() : {};

    const body = pageRows.length
        ? pageRows
              .map(
                  (it) => `
    <tr class="inv-row${it.isSystem ? ' inv-row-sys' + (it.bundleType === 'package' ? ' inv-row-pkg' : '') : ''}${state.openInvId === it.id || state.openSysId === it.id ? ' is-open' : ''}" data-inv="${attr(it.id)}">
      <td class="inv-item-cell">
        ${invThumb(it)}
        <span class="inv-item-text">
          <span class="inv-item-name">${esc(it.name || 'Untitled')}${it.isSystem ? '<span class="inv-sys-badge' + (it.bundleType === 'package' ? ' is-pkg' : '') + '">' + (it.bundleType === 'package' ? 'Package' : 'Kit') + ' &middot; ' + ((it.systemParts && it.systemParts.length) || (it.requirements || []).length) + (it.bundleType === 'package' ? ' items' : ' parts') + (it.botOffer ? ' &middot; on bot' : '') + '</span>' : ''}</span>
          ${it.subtitle ? `<span class="inv-item-sub">${esc(it.subtitle)}</span>` : ''}
        </span>
      </td>
      <td>${it.category ? `<span class="ad-pill ${invCatClass(it.category)}">${esc(it.category)}</span>` : '<span class="ad-cell-muted">—</span>'}</td>
      <td class="inv-num">${esc(it.quantityTotal)}</td>
      ${invStockCells(it, use, byId)}
      <td>${it.location ? esc(it.location) : '<span class="ad-cell-muted">—</span>'}</td>
      <td class="inv-num">${esc(money(it.priceCents))}</td>
      <td class="inv-num">${it.extraDayCents ? esc(money(it.extraDayCents)) : '<span class="ad-cell-muted">—</span>'}</td>
      <td>${it.consumable ? (invLow(it) ? '<span class="ad-pill ad-pill-red">Reorder</span>' : '<span class="ad-pill ad-pill-green">In stock</span>') : invStatusPill(it.status)}</td>
      <td class="ad-cell-right"><button type="button" class="inv-open-btn" data-inv-open="${attr(it.id)}" aria-label="Edit">&#8250;</button></td>
    </tr>`
              )
              .join('')
        : `<tr><td colspan="10" class="ad-cell-muted">No items match. Try clearing the filters, or add one.</td></tr>`;

    return { body, total: rows.length, pages, start, shown: pageRows.length };
}

function renderInvRows() {
    const host = document.getElementById('inv-rows');
    const foot = document.getElementById('inv-foot');
    if (!host) return;

    const r = invRowsHtml();
    host.innerHTML = r.body;

    if (foot) {
        const from = r.total ? r.start + 1 : 0;
        const to = r.start + r.shown;
        let nums = '';
        for (let p = 1; p <= r.pages; p++) {
            nums += `<button type="button" class="ad-pg${p === state.invPage ? ' is-on' : ''}"
                 data-inv-page="${p}">${p}</button>`;
        }
        foot.innerHTML = `
      <p class="inv-foot-count">Showing ${from}–${to} of ${r.total} items</p>
      <div class="ad-pages">
        <button type="button" class="ad-pg" data-inv-page="${Math.max(1, state.invPage - 1)}"
                ${state.invPage === 1 ? 'disabled' : ''}>‹</button>
        ${nums}
        <button type="button" class="ad-pg" data-inv-page="${Math.min(r.pages, state.invPage + 1)}"
                ${state.invPage === r.pages ? 'disabled' : ''}>›</button>
      </div>`;
    }
}

/* -------------------------------------------------------------------------
   Detail panel  -  edit one item
   ------------------------------------------------------------------------- */
function invEditingItem() {
    if (state.openInvId === '__new__') {
        const cons = state.invTab === 'consumables';
        return invItem({
            status: 'available',
            quantityTotal: cons ? 0 : 1,
            quantityAvailable: cons ? 0 : 1,
            pricingType: 'per-day',
            inBot: !cons,
            location: '',
            consumable: cons,
            category: cons ? 'Consumables' : ''
        });
    }
    const found = (state.inventory || []).find((x) => x.id === state.openInvId);
    return invItem(found || {});
}

function invDetail() {
    const it = invEditingItem();
    const isNew = state.openInvId === '__new__';
    const dollars = (c) => (c ? c / 100 : '');

    const statusOpt = (v, l) => `<option value="${v}"${it.status === v ? ' selected' : ''}>${l}</option>`;

    return `
    <aside class="inv-detail${it.consumable ? ' is-cons' : ''}" aria-label="Item details">
      <header class="inv-detail-head">
        <div>
          <h2>${isNew ? (it.consumable ? 'New consumable' : 'New item') : esc(it.name || 'Item')}</h2>
          ${!isNew && it.subtitle ? `<p class="inv-detail-sub">${esc(it.subtitle)}</p>` : ''}
        </div>
        <button type="button" class="inv-detail-close" id="inv-close" aria-label="Close">&times;</button>
      </header>

      <div class="inv-detail-body">
        <div class="inv-photo">
          <div class="inv-photo-preview" id="inv-photo-drop" title="Drag, paste or click to add a photo">
            ${
                it.photoUrl
                    ? `<img src="${attr(it.photoUrl)}" alt="">`
                    : `<span class="inv-photo-ph ${invCatClass(it.category)}">${esc((it.category || it.name || '?').trim().charAt(0).toUpperCase())}</span>`
            }
          </div>
          <div class="inv-photo-actions">
            <label class="ad-btn ad-btn-small inv-photo-btn">
              ${it.photoUrl ? 'Replace photo' : 'Upload photo'}
              <input type="file" accept="image/*" id="inv-photo-input" hidden></label>
            ${it.photoUrl ? '<button type="button" class="ad-btn ad-btn-small" id="inv-photo-remove">Remove</button>' : ''}
            <p class="inv-photo-hint">Drag an image in, or paste a screenshot (Ctrl / Cmd + V)</p>
            <span class="ad-quote-msg" id="inv-photo-msg"></span>
          </div>
        </div>

        <div class="inv-fgrid">
          <label class="ad-field inv-span2"><span>Item name</span>
            <input class="ad-input" data-f="name" value="${attr(it.name)}" placeholder="${it.consumable ? 'Haze fluid' : 'Electro-Voice ICOA 12'}"></label>
          <input type="hidden" data-f="consumable" value="${it.consumable ? '1' : ''}">
          <label class="ad-field inv-span2"><span>Subtitle</span>
            <input class="ad-input" data-f="subtitle" value="${attr(it.subtitle)}" placeholder="Active Speaker"></label>

          <label class="ad-field"><span>Category</span>
            <input class="ad-input" data-f="category" value="${attr(it.category)}" placeholder="Audio"></label>
          <label class="ad-field inv-gear-only"><span>Status</span>
            <select class="ad-select" data-f="status">
              ${statusOpt('available', 'Available')}
              ${statusOpt('on-hire', 'On Hire')}
              ${statusOpt('in-repair', 'In Repair')}
            </select></label>

          <label class="ad-field inv-cons-only"><span>Unit</span>
            <input class="ad-input" data-f="unit" value="${attr(it.unit)}" placeholder="1 L bottle"></label>
          <label class="ad-field"><span>${it.consumable ? 'In stock' : 'Quantity owned'}</span>
            <input class="ad-input" type="number" min="0" step="1" data-f="quantityTotal" value="${attr(it.quantityTotal)}"></label>
          <label class="ad-field inv-cons-only"><span>Reorder when down to</span>
            <input class="ad-input" type="number" min="0" step="1" data-f="reorderAt" value="${attr(it.reorderAt || '')}" placeholder="e.g. 2"></label>
          <label class="ad-field inv-gear-only"><span>Quantity available</span>
            <input class="ad-input" type="number" min="0" step="1" data-f="quantityAvailable" value="${attr(it.quantityAvailable)}"></label>

          <label class="ad-field inv-gear-only"><span>Quantity in repair</span>
            <input class="ad-input" type="number" min="0" step="1" data-f="quantityRepair" value="${attr(it.quantityRepair)}"></label>
          <div class="ad-field inv-gear-only"><span>On hire (worked out)</span>
            <p class="inv-onhire" id="inv-onhire">${attr(Math.max(0, it.quantityTotal - it.quantityAvailable - it.quantityRepair))}</p></div>

          <label class="ad-field inv-span2"><span>Default location</span>
            <input class="ad-input" data-f="location" value="${attr(it.location)}" placeholder="Bowen"></label>

          <label class="ad-field"><span>${it.consumable ? 'Charge per unit $' : 'Hire price (1 day) $'}</span>
            <input class="ad-input" type="number" min="0" step="1" data-f="priceCents" value="${attr(dollars(it.priceCents))}"></label>
          <label class="ad-field inv-gear-only"><span>Extra day price $</span>
            <input class="ad-input" type="number" min="0" step="1" data-f="extraDayCents" value="${attr(dollars(it.extraDayCents))}"></label>

          <label class="ad-field inv-span2 inv-gear-only"><span>Setup time (min per unit)</span>
            <input class="ad-input" type="number" min="0" step="1" data-f="setupMins" value="${attr(it.setupMins || '')}"
                   placeholder="e.g. 10"><em class="inv-field-hint">Man-minutes to set one up. Feeds the labour charge on delivered quotes.</em></label>

          <label class="ad-field inv-span2"><span>Replacement value $</span>
            <input class="ad-input" type="number" min="0" step="1" data-f="replacementCents" value="${attr(dollars(it.replacementCents))}"></label>

          <label class="ad-field inv-span2"><span>Internal notes</span>
            <textarea class="ad-input" rows="2" data-f="internalNotes" placeholder="Just for the team...">${esc(it.internalNotes)}</textarea></label>
        </div>

        <div class="inv-detail-section inv-gear-only">
          <h3>Repair &amp; maintenance</h3>
          <div class="inv-fgrid">
            <label class="ad-field inv-span2"><span>What&rsquo;s wrong / being done</span>
              <textarea class="ad-input" rows="2" data-f="repairFault" placeholder="e.g. blown driver, sent for reconing">${esc(it.repairFault)}</textarea></label>
            <label class="ad-field"><span>With / who&rsquo;s fixing it</span>
              <input class="ad-input" data-f="repairWith" value="${attr(it.repairWith)}" placeholder="e.g. JD Audio Repairs"></label>
            <label class="ad-field"><span>Expected back</span>
              <input class="ad-input" data-f="repairDue" value="${attr(it.repairDue)}" placeholder="e.g. Fri 3 Oct"></label>
          </div>
        </div>

        <div class="inv-detail-section inv-gear-only">
          <h3>Extra equipment details</h3>
          <div class="inv-fgrid">
            <label class="ad-field inv-span2"><span>Specs</span>
              <textarea class="ad-input" rows="2" data-f="specs" placeholder="12&quot; two-way powered loudspeaker...">${esc(it.specs)}</textarea></label>
            <label class="ad-field"><span>Weight</span>
              <input class="ad-input" data-f="weight" value="${attr(it.weight)}" placeholder="17.4 kg"></label>
            <label class="ad-field"><span>Power draw</span>
              <input class="ad-input" data-f="powerDraw" value="${attr(it.powerDraw)}" placeholder="300 W (max)"></label>
            <label class="ad-field inv-span2"><span>What's included</span>
              <textarea class="ad-input" rows="2" data-f="included" placeholder="1x speaker, 1x power cable...">${esc(it.included)}</textarea></label>
          </div>
        </div>

        <div class="inv-detail-section inv-reqs inv-gear-only">
          <div class="inv-reqs-head">
            <h3>Item requirements</h3>
            <button type="button" class="ad-btn ad-btn-small inv-reqs-add" id="inv-req-add">+ Add requirement</button>
          </div>
          <p class="inv-reqs-intro">Gear this item needs to work. When it&rsquo;s hired,
             these come too &mdash; and their own requirements follow automatically.</p>
          <div class="inv-reqs-list" id="inv-reqs-list"></div>
          <div class="inv-reqs-preview" id="inv-reqs-preview"></div>
        </div>

        <label class="inv-toggle inv-gear-only">
          <span>
            <strong>Available for quotes</strong>
            <em>Offer this item as an extra in the estimate bot.</em>
          </span>
          <input type="checkbox" data-f="inBot"${it.inBot ? ' checked' : ''}>
          <span class="inv-switch" aria-hidden="true"></span>
        </label>
      </div>

      <footer class="inv-detail-foot">
        ${isNew ? '' : '<button type="button" class="ad-btn inv-del" id="inv-delete">Delete</button>'}
        <button type="button" class="ad-btn ad-btn-primary" id="inv-save">
          ${isNew ? 'Add item' : 'Save changes'}</button>
        <span class="ad-quote-msg" id="inv-msg"></span>
      </footer>
    </aside>`;
}

/* -------------------------------------------------------------------------
   Wiring
   ------------------------------------------------------------------------- */
function wireInventory() {
    renderInvRows();

    // KIT / PACKAGE BUILDER: + New kit, + New package, and the panel when it's open
    const addSys = document.getElementById('inv-add-sys');
    if (addSys) addSys.addEventListener('click', () => openSystem('__new__', 'kit'));
    const addPkg = document.getElementById('inv-add-pkg');
    if (addPkg) addPkg.addEventListener('click', () => openSystem('__new__', 'package'));
    const mig = document.getElementById('inv-migrate-pkgs');
    if (mig) mig.addEventListener('click', () => migrateOldPackages(mig));
    if (state.openSysId != null) {
        wireSystemPanel(sysDraft, invItems, H, invDistinct('category'), {
            save: saveSystem,
            close() {
                clearPendingPhoto();
                state.openSysId = null;
                render();
            },
            afterDraw: wireInvPhoto
        });
    }

    // stock dates: From / To (To follows From if it would be earlier)
    ['inv-d-from', 'inv-d-to'].forEach((idd) => {
        const el = document.getElementById(idd);
        if (el)
            el.addEventListener('change', () => {
                const d = invDates();
                const from = (document.getElementById('inv-d-from') || {}).value || d.from;
                let to = (document.getElementById('inv-d-to') || {}).value || from;
                if (to < from) {
                    to = from;
                    const t = document.getElementById('inv-d-to');
                    if (t) t.value = to;
                }
                state.invDates = { from, to };
                renderInvRows();
            });
    });

    /*  Delegate on the wrapper, which render() recreates each time, rather
      than on the persistent #ad-desk - a listener on the desk would stack
      up a duplicate on every re-render.                                  */
    const wrap = document.querySelector('.inv-wrap');
    if (!wrap) return;

    const add = document.getElementById('inv-add');
    if (add)
        add.addEventListener('click', () => {
            clearPendingPhoto();
            initInvReqDraft(null);
            state.openSysId = null;
            state.openInvId = '__new__';
            render();
        });
    wrap.querySelectorAll('[data-inv-tab]').forEach((b) =>
        b.addEventListener('click', () => {
            state.invTab = b.getAttribute('data-inv-tab');
            state.invPage = 1;
            state.openInvId = null;
            state.openSysId = null;
            state.invFilter.category = 'all';
            render();
        })
    );

    // one-off: shrink + rename the photos already uploaded
    const shrinkBtn = document.getElementById('inv-shrink');
    if (shrinkBtn)
        shrinkBtn.addEventListener('click', async () => {
            if (
                !window.confirm(
                    'Shrink every inventory photo and name it after the product?\n\nThe old big files are kept for now, so nothing breaks.'
                )
            )
                return;
            shrinkBtn.disabled = true;
            shrinkBtn.textContent = 'Shrinking…';
            try {
                const r = await call('adminOptimisePhotos', {});
                window.alert(
                    'Done: ' +
                        r.done +
                        ' photos shrunk (' +
                        r.beforeKB +
                        ' KB -> ' +
                        r.afterKB +
                        ' KB).' +
                        (r.failed ? '\n' + r.failed + ' could not be done.' : '')
                );
            } catch (e) {
                window.alert(e.message || 'Could not shrink the photos.');
            }
            shrinkBtn.disabled = false;
            shrinkBtn.textContent = 'Shrink photos';
        });
    const search = document.getElementById('inv-search');
    if (search) {
        search.addEventListener('input', () => {
            state.invFilter.search = search.value;
            state.invPage = 1;
            renderInvRows();
        });
    }
    [
        ['inv-f-category', 'category'],
        ['inv-f-location', 'location'],
        ['inv-f-status', 'status']
    ].forEach(([id, key]) => {
        const el = document.getElementById(id);
        if (el)
            el.addEventListener('change', () => {
                state.invFilter[key] = el.value;
                state.invPage = 1;
                renderInvRows();
            });
    });

    // table: open a row, or page
    wrap.addEventListener('click', (e) => {
        const sortTh = e.target.closest('[data-sort]');
        if (sortTh) {
            const k = sortTh.getAttribute('data-sort');
            if (state.invSort.key === k) {
                state.invSort.dir = state.invSort.dir === 'asc' ? 'desc' : 'asc';
            } else {
                state.invSort.key = k;
                state.invSort.dir = 'asc';
            }
            state.invPage = 1;
            updateInvSortHeaders();
            renderInvRows();
            return;
        }
        const page = e.target.closest('[data-inv-page]');
        if (page) {
            state.invPage = Number(page.getAttribute('data-inv-page')) || 1;
            renderInvRows();
            return;
        }
        if (e.target.closest('[data-no-row]')) return; // the "on hire" job list, not the item
        const row = e.target.closest('[data-inv]');
        const openBtn = e.target.closest('[data-inv-open]');
        const id = openBtn ? openBtn.getAttribute('data-inv-open') : row ? row.getAttribute('data-inv') : null;
        // a kit / package opens in its builder, not the item editor
        if (id && (invItems().find((x) => x.id === id) || {}).isSystem) {
            openSystem(id);
            return;
        }
        if (id) {
            state.openSysId = null;
            clearPendingPhoto();
            initInvReqDraft((state.inventory || []).find((x) => x.id === id));
            state.openInvId = id;
            render();
        }
    });

    wireInvDetail();
}

/*  A photo waiting to go up for a brand-new item that has not been saved
    yet - it is uploaded the moment the item is created, so you can add the
    picture and the details together.                                      */
let pendingPhoto = null;
/* the item the photo box belongs to: the open item, or the open system */
const photoTargetId = () => (state.openSysId != null ? state.openSysId : state.openInvId);
let pendingPhotoUrl = '';

function clearPendingPhoto() {
    pendingPhoto = null;
    if (pendingPhotoUrl) {
        try {
            URL.revokeObjectURL(pendingPhotoUrl);
        } catch (e) {
            /* noop */
        }
    }
    pendingPhotoUrl = '';
}

function wireInvDetail() {
    const close = document.getElementById('inv-close');
    if (close)
        close.addEventListener('click', () => {
            clearPendingPhoto();
            state.openInvId = null;
            render();
        });

    const save = document.getElementById('inv-save');
    if (save) save.addEventListener('click', () => saveInvItem(save));

    const del = document.getElementById('inv-delete');
    if (del) del.addEventListener('click', () => deleteInvItem(del));

    wireInvReqs();

    /*  Keep the "On hire (worked out)" number live as the quantities change,
      so the split is obvious before saving: on hire = owned - available -
      in repair.                                                            */
    const panel = document.querySelector('.inv-detail');
    const onhire = document.getElementById('inv-onhire');
    if (panel && onhire) {
        const num = (f) => {
            const el = panel.querySelector(`[data-f="${cssEsc(f)}"]`);
            return Math.max(0, Math.round(Number((el && el.value) || 0)));
        };
        const recalc = () => {
            const owned = num('quantityTotal');
            const v = Math.max(0, owned - num('quantityAvailable') - num('quantityRepair'));
            onhire.textContent = String(v);
        };
        ['quantityTotal', 'quantityAvailable', 'quantityRepair'].forEach((f) => {
            const el = panel.querySelector(`[data-f="${cssEsc(f)}"]`);
            if (el) el.addEventListener('input', recalc);
        });
    }

    wireInvPhoto();
}

/*  The photo box (pick / drag / paste) - used by the item panel AND the
    System builder, so both work the same way.        */
function wireInvPhoto() {
    const photoInput = document.getElementById('inv-photo-input');
    if (photoInput) {
        photoInput.addEventListener('change', () => {
            const file = photoInput.files && photoInput.files[0];
            if (file) handlePhotoFile(file);
            photoInput.value = ''; // let the same file be picked again after a remove
        });
    }
    const photoRemove = document.getElementById('inv-photo-remove');
    if (photoRemove) photoRemove.addEventListener('click', onRemovePhoto);

    // Drag-and-drop onto the photo box.
    const drop = document.getElementById('inv-photo-drop');
    if (drop) {
        const stop = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };
        drop.addEventListener('dragover', (e) => {
            stop(e);
            drop.classList.add('is-drop');
        });
        drop.addEventListener('dragleave', (e) => {
            stop(e);
            drop.classList.remove('is-drop');
        });
        drop.addEventListener('drop', (e) => {
            stop(e);
            drop.classList.remove('is-drop');
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (file) handlePhotoFile(file);
        });
        drop.addEventListener('click', () => {
            if (photoInput) photoInput.click();
        });
    }

    // Paste a screenshot (Ctrl/Cmd+V) while a detail panel is open. Wired once,
    // on the document, and guarded by whether an item is open.
    if (!window.__invPasteWired) {
        window.__invPasteWired = true;
        document.addEventListener('paste', (e) => {
            if (state.view !== 'inventory' || photoTargetId() == null) return;
            const items = (e.clipboardData && e.clipboardData.items) || [];
            for (const it of items) {
                if (it.type && it.type.startsWith('image/')) {
                    const f = it.getAsFile();
                    if (f) {
                        e.preventDefault();
                        handlePhotoFile(f);
                    }
                    break;
                }
            }
        });
    }
}

/*  A photo arrived (picked, dropped or pasted). For a saved item it uploads
    straight away; for a new one it is held and uploaded on save.          */
function handlePhotoFile(file) {
    const msg = document.getElementById('inv-photo-msg');
    const bad = (t) => {
        setMsg(msg, t, 'is-bad');
    };

    if (!file || !/^image\//.test(file.type)) return bad('That’s not an image.');
    if (file.size > 8 * 1024 * 1024) return bad('Image is over 8 MB — try a smaller one.');

    if (photoTargetId() === '__new__') {
        clearPendingPhoto();
        pendingPhoto = file;
        pendingPhotoUrl = URL.createObjectURL(file);
        if (state.openSysId != null) sysDraft.photoUrl = pendingPhotoUrl; // survives the panel redrawing
        setInvPhotoPreview(pendingPhotoUrl);
        setMsg(msg, 'Photo ready — it’ll save with the item.', 'is-ok');
        return;
    }
    uploadInvPhoto(photoTargetId(), file);
}

/*  Remove clears a pending (unsaved) photo locally, or deletes a saved one. */
function onRemovePhoto() {
    if (pendingPhoto) {
        clearPendingPhoto();
        setInvPhotoPreview('');
        const msg = document.getElementById('inv-photo-msg');
        setMsg(msg, '', '');
        return;
    }
    removeInvPhoto(photoTargetId());
}

/*  Photos are shrunk to 800px WebP in the browser before upload and saved
    under the product's name, e.g. inventory/allen-heath-ab168-14w97n8h.webp. */
const photoSlug = (name, id) => (slugify(name || 'item', 60) || 'item') + '-' + String(id).slice(0, 8);
async function shrinkPhoto(file, max = 800) {
    try {
        const bmp = await createImageBitmap(file);
        const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas');
        c.width = Math.round(bmp.width * scale);
        c.height = Math.round(bmp.height * scale);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.82));
        return blob && blob.size < file.size ? blob : file;
    } catch (e) {
        return file;
    } // odd format - upload it as it is
}
/*  Push one image to Storage under inventory/ and record its URL on the doc. */
async function doUploadPhoto(id, file, name) {
    const { ref, uploadBytes, getDownloadURL, deleteObject } = fb.st;
    const { doc, setDoc } = fb.f;
    const item = (state.inventory || []).find((x) => x.id === id);
    const small = await shrinkPhoto(file);
    const ext = small.type === 'image/webp' ? '.webp' : '';
    const path = 'inventory/' + photoSlug(name || (item && item.name) || (sysDraft && sysDraft.name), id) + ext;
    await uploadBytes(ref(fb.storage, path), small, { contentType: small.type || file.type });
    const url = await getDownloadURL(ref(fb.storage, path));
    const oldPath = item && item.photoPath;
    await setDoc(doc(fb.db, 'inventory', id), { photoUrl: url, photoPath: path }, { merge: true });
    // the photo it replaces is no longer used by anything - tidy it away
    if (oldPath && oldPath !== path && deleteObject) {
        try {
            await deleteObject(ref(fb.storage, oldPath));
        } catch (e) {
            /* already gone */
        }
    }
    if (item) {
        item.photoUrl = url;
        item.photoPath = path;
    }
    return { url, path };
}

/*  Upload a photo for a saved item straight away, updating only the preview
    (not a full render, which would wipe anything typed but not yet saved).
    The table thumbnail refreshes on its own through the inventory snapshot. */
async function uploadInvPhoto(id, file) {
    if (!id || id === '__new__') return;
    const msg = document.getElementById('inv-photo-msg');
    setMsg(msg, 'Uploading…', '');

    try {
        const { url } = await doUploadPhoto(id, file);
        if (state.openSysId === id) sysDraft.photoUrl = url;
        setInvPhotoPreview(url);
        setMsg(msg, 'Photo saved.', 'is-ok');
    } catch (err) {
        setMsg(msg, err.message || 'Upload failed.', 'is-bad');
    }
}

async function removeInvPhoto(id) {
    if (!id || id === '__new__') return;
    const item = (state.inventory || []).find((x) => x.id === id) || {};
    const msg = document.getElementById('inv-photo-msg');
    try {
        const { ref, deleteObject } = fb.st;
        const { doc, setDoc } = fb.f;
        if (item.photoPath) {
            try {
                await deleteObject(ref(fb.storage, item.photoPath));
            } catch (e) {
                /* already gone */
            }
        }
        await setDoc(doc(fb.db, 'inventory', id), { photoUrl: '', photoPath: '' }, { merge: true });
        item.photoUrl = '';
        item.photoPath = '';
        if (state.openSysId === id) sysDraft.photoUrl = '';
        setInvPhotoPreview(''); // in place, keep the form
        setMsg(msg, 'Photo removed.', 'is-ok');
    } catch (err) {
        setMsg(msg, err.message || 'Could not remove.', 'is-bad');
    }
}

/*  Swap the photo preview and its buttons without touching the rest of the
    detail panel, so a photo change never disturbs the fields being edited. */
function setInvPhotoPreview(url) {
    const panel = document.querySelector('.inv-detail');
    if (!panel) return;

    const preview = panel.querySelector('.inv-photo-preview');
    const cat = (panel.querySelector('[data-f="category"]') || {}).value || '';
    const name = (panel.querySelector('[data-f="name"]') || {}).value || '';
    if (preview) {
        preview.innerHTML = url
            ? `<img src="${attr(url)}" alt="">`
            : `<span class="inv-photo-ph ${invCatClass(cat)}">${esc((cat || name || '?').trim().charAt(0).toUpperCase())}</span>`;
    }

    const actions = panel.querySelector('.inv-photo-actions');
    if (actions) {
        const label = actions.querySelector('.inv-photo-btn');
        if (label) label.childNodes[0].nodeValue = url ? 'Replace photo ' : 'Upload photo ';
        let remove = actions.querySelector('#inv-photo-remove');
        if (url && !remove) {
            remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'ad-btn ad-btn-small';
            remove.id = 'inv-photo-remove';
            remove.textContent = 'Remove';
            remove.addEventListener('click', onRemovePhoto);
            if (label) label.insertAdjacentElement('afterend', remove);
        } else if (!url && remove) {
            remove.remove();
        }
    }
}

async function saveInvItem(btn) {
    const panel = document.querySelector('.inv-detail');
    const msg = document.getElementById('inv-msg');
    if (!panel) return;

    const get = (f) => {
        const el = panel.querySelector(`[data-f="${cssEsc(f)}"]`);
        if (!el) return '';
        return el.type === 'checkbox' ? el.checked : el.value;
    };
    const dollarsToCents = (v) => Math.round(Number(v || 0) * 100);
    const int = (v) => Math.max(0, Math.round(Number(v || 0)));
    const text = (f, max) =>
        String(get(f) || '')
            .trim()
            .slice(0, max);

    const name = String(get('name') || '').trim();
    if (!name) {
        setMsg(msg, 'Give it a name first.', 'is-bad');
        return;
    }

    const qt = int(get('quantityTotal'));
    const data = {
        name,
        subtitle: String(get('subtitle') || '').trim(),
        category: String(get('category') || '').trim(),
        status: get('status') || 'available',
        quantityTotal: qt,
        quantityRepair: Math.min(int(get('quantityRepair')), qt),
        quantityAvailable: get('consumable') ? qt : Math.min(int(get('quantityAvailable')), qt),
        location: String(get('location') || '').trim(),
        pricingType: 'per-day',
        priceCents: dollarsToCents(get('priceCents')),
        extraDayCents: dollarsToCents(get('extraDayCents')),
        replacementCents: dollarsToCents(get('replacementCents')),
        setupMins: int(get('setupMins')),
        internalNotes: text('internalNotes', 2000),
        repairFault: text('repairFault', 1000),
        repairWith: text('repairWith', 200),
        repairDue: text('repairDue', 100),
        specs: text('specs', 2000),
        weight: text('weight', 100),
        powerDraw: text('powerDraw', 100),
        included: text('included', 2000),
        inBot: !get('consumable') && !!get('inBot'),
        consumable: !!get('consumable'),
        unit: text('unit', 60),
        reorderAt: int(get('reorderAt')),
        // Requirements come from their own draft, not the field grid. Drop any
        // half-added row that never got an item chosen.
        requirements: invReqDraft
            .map(normalizeReq)
            .filter((r) => r.itemId)
            .slice(0, 40)
    };

    setMsg(msg, 'Saving…', '');
    if (btn) btn.disabled = true;

    try {
        const { collection, doc, setDoc, addDoc } = fb.f;
        state.inventory = state.inventory || [];

        if (state.openInvId === '__new__') {
            data.order = state.inventory.length;
            const ref = await addDoc(collection(fb.db, 'inventory'), data);
            state.openInvId = ref.id; // stay open on the new item
            // Seed state now so the re-render shows the saved item without waiting
            // on the snapshot round-trip.
            state.inventory.push({ id: ref.id, ...data });
            // A photo added before saving goes up now that the item has an id.
            if (pendingPhoto) {
                try {
                    await doUploadPhoto(ref.id, pendingPhoto, data.name);
                } catch (e) {
                    /* item saved; photo can be retried */
                }
                clearPendingPhoto();
            }
        } else {
            const id = state.openInvId;
            await setDoc(doc(fb.db, 'inventory', id), data, { merge: true });
            // Merge onto what we already hold (keeps photoUrl), so the re-render
            // below shows exactly what was saved rather than pre-save state.
            const cur = state.inventory.find((x) => x.id === id);
            if (cur) Object.assign(cur, data);
            else state.inventory.push({ id, ...data });
        }
        // A deliberate save may repaint the panel (header/name, photo controls);
        // state is already updated above, so nothing typed is lost.
        render();
        const m2 = document.getElementById('inv-msg'); // the repaint made a fresh one
        setMsg(m2, 'Saved.', 'is-ok');
    } catch (err) {
        if (btn) btn.disabled = false;
        setMsg(msg, err.message || 'Could not save.', 'is-bad');
    }
}

async function deleteInvItem(btn) {
    if (!state.openInvId || state.openInvId === '__new__') return;
    const item = (state.inventory || []).find((x) => x.id === state.openInvId);
    const name = item ? item.name || 'this item' : 'this item';
    if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;

    if (btn) btn.disabled = true;
    try {
        const { doc, deleteDoc } = fb.f;
        await deleteDoc(doc(fb.db, 'inventory', state.openInvId));
        state.openInvId = null;
        render();
    } catch (err) {
        if (btn) btn.disabled = false;
        const msg = document.getElementById('inv-msg');
        setMsg(msg, err.message || 'Could not delete.', 'is-bad');
    }
}

/* -------------------------------------------------------------------------
   Item requirements  -  the detail-panel editor + live kit preview
   ------------------------------------------------------------------------- */
let invReqPreviewQty = 1;

function reqRowHtml(r, i, options) {
    const chosen = options.find((o) => o.id === r.itemId);
    const chargeOpts = [
        ['normal', 'Normal price'],
        ['discounted', 'Discounted'],
        ['free', 'Included free']
    ]
        .map((c) => `<option value="${c[0]}"${r.charge === c[0] ? ' selected' : ''}>${c[1]}</option>`)
        .join('');

    const qtyFields =
        r.rule === 'shared'
            ? `<label class="inv-req-f"><span>Qty</span>
         <input class="ad-input" type="number" min="1" step="1" data-rf="qty" value="${attr(r.qty)}"></label>
       <label class="inv-req-f"><span>Covers (units)</span>
         <input class="ad-input" type="number" min="1" step="1" data-rf="coversN" value="${attr(r.coversN)}"></label>`
            : `<label class="inv-req-f"><span>Qty per unit</span>
         <input class="ad-input" type="number" min="0" step="1" data-rf="qty" value="${attr(r.qty)}"></label>`;

    const discField =
        r.charge === 'discounted'
            ? `<label class="inv-req-f"><span>Price $</span>
         <input class="ad-input" type="number" min="0" step="1" data-rf="discountCents" value="${attr(r.discountCents ? r.discountCents / 100 : '')}"></label>`
            : '';

    return `
    <div class="inv-req" data-i="${i}">
      <button type="button" class="inv-req-del" data-req-del title="Remove">&times;</button>
      <div class="inv-req-grid">
        <div class="inv-req-f inv-req-item"><span>Required item</span>
          <div class="inv-req-pick">
            <input class="ad-input" data-req-search autocomplete="off" placeholder="Type to search gear&hellip;"
                   value="${attr(chosen ? chosen.name : '')}">
            <div class="inv-req-results" hidden></div>
          </div></div>
        <label class="inv-req-f"><span>How</span>
          <select class="ad-select" data-rf="rule">
            <option value="per-item"${r.rule === 'per-item' ? ' selected' : ''}>Per item</option>
            <option value="shared"${r.rule === 'shared' ? ' selected' : ''}>Shared capacity</option>
          </select></label>
        ${qtyFields}
        <label class="inv-req-f"><span>Charge</span>
          <select class="ad-select" data-rf="charge">${chargeOpts}</select></label>
        ${discField}
      </div>
    </div>`;
}

/*  Items added or renamed while a panel is open show up in the "Required
    item" dropdowns straight away. Only the option list is swapped - each
    dropdown keeps its choice, and nothing typed in the panel is touched. */
function refreshInvReqOptions() {
    const options = invReqOptions(state.openInvId);
    document.querySelectorAll('#inv-reqs-list .inv-req').forEach((row) => {
        const r = invReqDraft[Number(row.getAttribute('data-i'))];
        const box = row.querySelector('[data-req-search]');
        const o = r && options.find((x) => x.id === r.itemId);
        if (box && o && document.activeElement !== box) box.value = o.name;
    });
}

/*  The search box on a requirement row: up to 8 matches as you type, every
    word must match. Click (or Enter for the first) to choose.          */
function reqMatches(text) {
    const words = String(text || '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
    if (!words.length) return [];
    return invReqOptions(state.openInvId)
        .filter((o) =>
            words.every((w) =>
                String(o.name || '')
                    .toLowerCase()
                    .includes(w)
            )
        )
        .slice(0, 8);
}
function showReqResults(box) {
    const res = box.parentElement.querySelector('.inv-req-results');
    const hits = reqMatches(box.value);
    res.innerHTML = hits.length
        ? hits.map((o) => `<button type="button" data-req-pick="${attr(o.id)}">${esc(o.name)}</button>`).join('')
        : '<p class="inv-req-none">No gear matches.</p>';
    res.hidden = !String(box.value || '').trim();
}
function pickReqItem(row, id) {
    const r = invReqDraft[Number(row.getAttribute('data-i'))];
    if (!r) return;
    const o = invReqOptions(state.openInvId).find((x) => x.id === id);
    r.itemId = id;
    const box = row.querySelector('[data-req-search]');
    if (box) box.value = o ? o.name : '';
    row.querySelector('.inv-req-results').hidden = true;
    renderInvReqPreview();
}

function renderInvReqs() {
    const list = document.getElementById('inv-reqs-list');
    if (!list) return;
    const options = invReqOptions(state.openInvId);
    list.innerHTML = invReqDraft.length
        ? invReqDraft.map((r, i) => reqRowHtml(r, i, options)).join('')
        : '<p class="inv-reqs-empty">No requirements yet &mdash; add the gear this item needs to work.</p>';
    renderInvReqPreview();
}

/*  Live "what comes with it" preview, run through the same kit engine the
    quotes and pick list will use.                                          */
function renderInvReqPreview() {
    const host = document.getElementById('inv-reqs-preview');
    if (!host) return;

    const nameEl = document.querySelector('.inv-detail [data-f="name"]');
    const editName = nameEl ? nameEl.value : '';
    const { byId, id } = invKitIndex(state.openInvId, editName);
    const qty = Math.max(1, Math.round(invReqPreviewQty || 1));

    const kit = expandKit({ [id]: qty }, byId);

    const chargeLabel = (r) => (r.charge === 'free' ? 'included free' : money(Math.round(r.unitCents || 0)) + ' ea');

    const lines = kit.required.length
        ? kit.required
              .map(
                  (r) =>
                      `<li><span class="inv-req-pv-qty">${esc(r.qty)}&times;</span> ${esc(r.name)}
           <span class="inv-req-pv-charge">${chargeLabel(r)}</span></li>`
              )
              .join('')
        : '<li class="inv-reqs-empty">Nothing else needed.</li>';

    const shorts = kit.shortages.length
        ? `<p class="inv-reqs-short">&#9888; Short: ${kit.shortages
              .map((s) => `${esc(s.name)} needs ${s.needed}, ${s.available === Infinity ? '—' : s.available} available`)
              .join('; ')}</p>`
        : '';

    host.innerHTML = `
    <div class="inv-reqs-pv">
      <p class="inv-reqs-pv-head">If you hire
        <input class="ad-input inv-req-pv-num" type="number" id="inv-req-qty" min="1" step="1" value="${attr(qty)}">
        of this, the kit adds:</p>
      <ul class="inv-reqs-pv-list">${lines}</ul>
      <p class="inv-reqs-pv-total">${kit.addCents ? 'Adds ' + money(Math.round(kit.addCents)) : 'No extra charge'}</p>
      ${shorts}
    </div>`;
}

function applyReqField(r, f, val) {
    if (f === 'discountCents') r.discountCents = toCents(val);
    else if (f === 'qty') r.qty = Math.max(0, Math.round(Number(val || 0)));
    else if (f === 'coversN') r.coversN = Math.max(1, Math.round(Number(val || 0)));
    else r[f] = val; // itemId, rule, charge
}

function wireInvReqs() {
    const addBtn = document.getElementById('inv-req-add');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            invReqDraft.push(normalizeReq({ itemId: '', rule: 'per-item', qty: 1, coversN: 1, charge: 'normal' }));
            renderInvReqs();
            const boxes = document.querySelectorAll('#inv-reqs-list [data-req-search]');
            if (boxes.length) boxes[boxes.length - 1].focus();
        });
    }

    const list = document.getElementById('inv-reqs-list');
    if (list) {
        list.addEventListener('change', (e) => {
            const el = e.target.closest('[data-rf]');
            const row = el && el.closest('.inv-req');
            if (!row) return;
            const i = Number(row.getAttribute('data-i'));
            const r = invReqDraft[i];
            if (!r) return;
            const f = el.getAttribute('data-rf');
            applyReqField(r, f, el.value);
            if (f === 'rule' || f === 'charge') {
                invReqDraft[i] = normalizeReq(r);
                renderInvReqs();
            } else renderInvReqPreview();
        });
        list.addEventListener('input', (e) => {
            const el = e.target.closest('[data-rf]');
            const row = el && el.closest('.inv-req');
            if (!row) return;
            const f = el.getAttribute('data-rf');
            if (f === 'rule' || f === 'charge' || f === 'itemId') return; // selects handled on change
            const i = Number(row.getAttribute('data-i'));
            const r = invReqDraft[i];
            if (!r) return;
            applyReqField(r, f, el.value);
            renderInvReqPreview();
        });
        // the "Required item" search box
        list.addEventListener('input', (e) => {
            if (e.target.matches('[data-req-search]')) showReqResults(e.target);
        });
        list.addEventListener('keydown', (e) => {
            if (!e.target.matches('[data-req-search]')) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                const first = reqMatches(e.target.value)[0];
                if (first) pickReqItem(e.target.closest('.inv-req'), first.id);
            } else if (e.key === 'Escape') e.target.parentElement.querySelector('.inv-req-results').hidden = true;
        });
        list.addEventListener('mousedown', (e) => {
            // mousedown so it beats the box losing focus
            const pick = e.target.closest('[data-req-pick]');
            if (!pick) return;
            e.preventDefault();
            pickReqItem(pick.closest('.inv-req'), pick.getAttribute('data-req-pick'));
        });
        list.addEventListener('focusout', (e) => {
            if (!e.target.matches('[data-req-search]')) return;
            const row = e.target.closest('.inv-req');
            setTimeout(() => {
                const res = row && row.querySelector('.inv-req-results');
                if (res) res.hidden = true;
                // typed text that isn't a choice goes back to the chosen item's name
                const r = row && invReqDraft[Number(row.getAttribute('data-i'))];
                const o = r && invReqOptions(state.openInvId).find((x) => x.id === r.itemId);
                if (row) row.querySelector('[data-req-search]').value = o ? o.name : '';
            }, 150);
        });
        list.addEventListener('click', (e) => {
            const del = e.target.closest('[data-req-del]');
            if (!del) return;
            const row = del.closest('.inv-req');
            invReqDraft.splice(Number(row.getAttribute('data-i')), 1);
            renderInvReqs();
        });
    }

    const preview = document.getElementById('inv-reqs-preview');
    if (preview) {
        preview.addEventListener('input', (e) => {
            if (e.target.id === 'inv-req-qty') {
                invReqPreviewQty = Math.max(1, Math.round(Number(e.target.value || 1)));
                renderInvReqPreview();
            }
        });
    }

    invReqPreviewQty = 1;
    renderInvReqs();
}
