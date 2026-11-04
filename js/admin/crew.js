/* SOUNDZGOOD ADMIN - crew.js
   Crew & vehicles: staff, vehicles and trailers.
   A plain script: every admin file shares one page scope, loaded in order by admin.html. */
'use strict';

/* =========================================================================
   CREW & VEHICLES  -  staff / vehicle / trailer records, billable to a quote

   Not gear (that's Inventory) and not a roster - just the people and vehicles
   you own, each with a day rate so it can be dropped onto a quote as a line.
   Kept private (admin-only) since they carry phone numbers and pay rates.
   ========================================================================= */

const RES_TYPES = { staff: 'Staff', vehicle: 'Vehicle', trailer: 'Trailer' };

function blankResource(type) {
    return {
        type: type || 'staff',
        name: '',
        role: '',
        phone: '',
        email: '',
        rego: '',
        capacity: '',
        dayRateCents: 0,
        active: true,
        notes: ''
    };
}

let resourceDraft = blankResource();

function subscribeToResources() {
    const { collection, onSnapshot } = fb.f;
    const rank = { staff: 0, vehicle: 1, trailer: 2 };
    unsubscribes.push(
        onSnapshot(
            collection(fb.db, 'resources'),
            (snap) => {
                const rows = snapRows(snap);
                rows.sort(
                    (a, b) =>
                        (rank[a.type] ?? 9) - (rank[b.type] ?? 9) ||
                        (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' })
                );
                state.resources = rows;
                if (state.view === 'resources') {
                    if (state.openResourceId)
                        renderResRows(); // panel open: refresh list only
                    else render();
                }
            },
            (err) => console.error('resources', err)
        )
    );
}

VIEWS.resources = {
    html() {
        const open = state.openResourceId != null;
        return `<div class="inv-wrap${open ? ' has-detail' : ''}">
      ${resourceMainHtml()}
      ${open ? resourceDetailHtml() : ''}
    </div>`;
    },
    wire() {
        wireResourceList();
        if (state.openResourceId != null) wireResourceDetail();
    }
};

/* ---- list (built to match the Inventory manager) ---- */
function resStats() {
    const rows = state.resources || [];
    const byType = (t) => rows.filter((r) => (r.type || 'staff') === t).length;
    return { total: rows.length, staff: byType('staff'), vehicle: byType('vehicle'), trailer: byType('trailer') };
}

function resFiltered() {
    const rows = state.resources || [];
    const f = state.resFilter || 'all';
    const needle = (state.resSearch || '').trim().toLowerCase();
    return rows.filter((r) => {
        if (f !== 'all' && (r.type || 'staff') !== f) return false;
        if (!needle) return true;
        return searchMatch(needle, r.name, r.role, r.rego, r.capacity, RES_TYPES[r.type]);
    });
}

function resSub(r) {
    if ((r.type || 'staff') === 'staff') return [r.role, r.phone].filter(Boolean).join(' · ');
    return [r.rego, r.capacity].filter(Boolean).join(' · ');
}

function resThumb(r) {
    const letter = (r.name || RES_TYPES[r.type] || '?').trim().charAt(0).toUpperCase();
    return `<span class="inv-thumb ${invCatClass(RES_TYPES[r.type] || '')}">${esc(letter)}</span>`;
}

const RES_TYPE_PILL = { staff: 'ad-pill-green', vehicle: 'ad-pill-blue', trailer: 'ad-pill-amber' };
function resTypePill(type) {
    const t = RES_TYPES[type] ? type : 'staff';
    return `<span class="ad-pill ${RES_TYPE_PILL[t]}">${esc(RES_TYPES[t])}</span>`;
}
function resActivePill(r) {
    return r.active === false ? '<span class="ad-pill ad-pill-grey">Off</span>' : '<span class="ad-pill ad-pill-green">Active</span>';
}

function resourceMainHtml() {
    const s = resStats();
    const f = state.resFilter;
    const opt = (v, l) => `<option value="${v}"${f === v ? ' selected' : ''}>${l}</option>`;

    return `
      <div class="inv-main">
        <div class="inv-head">
          <div class="inv-head-title">
            <span class="ad-mail-icon" aria-hidden="true">&#128666;</span>
            <div>
              <h1>Crew &amp; Vehicles</h1>
              <p>Your staff, vehicles and trailers. Each has a day rate, so it can be added to a quote as a billable line.</p>
            </div>
          </div>
          <div class="inv-head-actions res-addbtns">
            <button type="button" class="ad-btn ad-btn-small" data-res-new="staff">+ Staff</button>
            <button type="button" class="ad-btn ad-btn-small" data-res-new="vehicle">+ Vehicle</button>
            <button type="button" class="ad-btn ad-btn-primary" data-res-new="trailer">+ Trailer</button>
          </div>
        </div>

        <div class="ad-tiles">
          ${invTile('&#128100;', 'is-green', s.staff, 'Staff', '')}
          ${invTile('&#128666;', 'is-blue', s.vehicle, 'Vehicles', '')}
          ${invTile('&#128230;', 'is-amber', s.trailer, 'Trailers', '')}
          ${invTile('&#9776;', 'is-grey', s.total, 'Total', '')}
        </div>

        <div class="inv-toolbar">
          <input type="search" id="res-search" class="ad-search" placeholder="Search crew &amp; vehicles..."
                 value="${attr(state.resSearch)}" aria-label="Search crew and vehicles">
          <select id="res-f-type" class="ad-select" aria-label="Filter by type">
            ${opt('all', 'All types')}${opt('staff', 'Staff')}${opt('vehicle', 'Vehicles')}${opt('trailer', 'Trailers')}
          </select>
        </div>

        <div class="ad-table-wrap inv-table-wrap">
          <table class="ad-table inv-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Details</th>
                <th class="inv-num">Day rate</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="res-rows"></tbody>
          </table>
        </div>

        <div class="inv-foot" id="res-foot"></div>
      </div>`;
}

function renderResRows() {
    const host = document.getElementById('res-rows');
    const foot = document.getElementById('res-foot');
    if (!host) return;
    const rows = resFiltered();
    host.innerHTML = rows.length
        ? rows
              .map(
                  (r) => `
    <tr class="inv-row${state.openResourceId === r.id ? ' is-open' : ''}" data-open-res="${attr(r.id)}">
      <td class="inv-item-cell">
        ${resThumb(r)}
        <span class="inv-item-text"><span class="inv-item-name">${esc(r.name || 'Untitled')}</span></span>
      </td>
      <td>${resTypePill(r.type)}</td>
      <td>${resSub(r) ? esc(resSub(r)) : '<span class="ad-cell-muted">—</span>'}</td>
      <td class="inv-num">${esc(money(r.dayRateCents))}<span class="inv-perday">/day</span></td>
      <td>${resActivePill(r)}</td>
      <td class="ad-cell-right"><button type="button" class="inv-open-btn" data-open-res="${attr(r.id)}" aria-label="Edit">&#8250;</button></td>
    </tr>`
              )
              .join('')
        : `<tr><td colspan="6" class="ad-cell-muted">No records match. Try clearing the search, or add one above.</td></tr>`;
    if (foot) foot.innerHTML = `<p class="inv-foot-count">${rows.length} record${rows.length === 1 ? '' : 's'}</p>`;
}

function wireResourceList() {
    renderResRows();

    document.querySelectorAll('[data-res-new]').forEach((b) =>
        b.addEventListener('click', () => {
            resourceDraft = blankResource(b.getAttribute('data-res-new'));
            state.openResourceId = '__new__';
            render();
        })
    );

    const search = document.getElementById('res-search');
    if (search)
        search.addEventListener('input', () => {
            state.resSearch = search.value;
            renderResRows();
        });
    const typeSel = document.getElementById('res-f-type');
    if (typeSel)
        typeSel.addEventListener('change', () => {
            state.resFilter = typeSel.value;
            renderResRows();
        });

    const host = document.getElementById('res-rows');
    if (host)
        host.addEventListener('click', (e) => {
            const r = e.target.closest('[data-open-res]');
            if (!r) return;
            const id = r.getAttribute('data-open-res');
            const doc = (state.resources || []).find((x) => x.id === id);
            resourceDraft = doc ? resourceFromDoc(doc) : blankResource();
            state.openResourceId = id;
            render();
        });
}

function resourceFromDoc(doc) {
    return {
        type: RES_TYPES[doc.type] ? doc.type : 'staff',
        name: doc.name || '',
        role: doc.role || '',
        phone: doc.phone || '',
        email: doc.email || '', // keep it on edit
        rego: doc.rego || '',
        capacity: doc.capacity || '',
        dayRateCents: Math.max(0, Math.round(doc.dayRateCents || 0)),
        active: doc.active !== false,
        notes: doc.notes || ''
    };
}

/* ---- detail panel (slides in from the right, like Inventory) ---- */
function resourceDetailHtml() {
    const isNew = state.openResourceId === '__new__';
    const r = resourceDraft;
    const type = RES_TYPES[r.type] ? r.type : 'staff';
    const isStaff = type === 'staff';
    const rate = r.dayRateCents ? r.dayRateCents / 100 : '';
    const typeOpt = (v) => `<option value="${v}"${type === v ? ' selected' : ''}>${RES_TYPES[v]}</option>`;

    return `
    <aside class="inv-detail" aria-label="Record details">
      <header class="inv-detail-head">
        <div>
          <h2>${isNew ? 'New ' + RES_TYPES[type].toLowerCase() : esc(r.name || 'Record')}</h2>
          ${!isNew ? `<p class="inv-detail-sub">${esc(RES_TYPES[type])}</p>` : ''}
        </div>
        <button type="button" class="inv-detail-close" id="res-close" aria-label="Close">&times;</button>
      </header>

      <div class="inv-detail-body">
        <div class="inv-fgrid">
          <label class="ad-field"><span>Type</span>
            <select class="ad-select" data-rf="type">${typeOpt('staff')}${typeOpt('vehicle')}${typeOpt('trailer')}</select></label>
          <label class="ad-field"><span>Day rate (ex GST) $</span>
            <input class="ad-input" type="number" min="0" step="1" data-rf="dayRateCents" value="${attr(rate)}"></label>

          <label class="ad-field inv-span2"><span>Name</span>
            <input class="ad-input" data-rf="name" value="${attr(r.name)}" placeholder="${isStaff ? 'e.g. Jesse Taylor' : 'e.g. Mercedes Sprinter'}"></label>

          ${
              isStaff
                  ? `
          <label class="ad-field"><span>Role</span><input class="ad-input" data-rf="role" value="${attr(r.role)}" placeholder="e.g. Sound tech"></label>
          <label class="ad-field"><span>Phone</span><input class="ad-input" data-rf="phone" value="${attr(r.phone)}" placeholder="Mobile"></label>
          <label class="ad-field"><span>Email</span><input class="ad-input" type="email" data-rf="email" value="${attr(r.email || '')}" placeholder="For job details + pick lists"></label>`
                  : `
          <label class="ad-field"><span>Rego</span><input class="ad-input" data-rf="rego" value="${attr(r.rego)}" placeholder="e.g. 123 ABC"></label>
          <label class="ad-field"><span>Capacity / size</span><input class="ad-input" data-rf="capacity" value="${attr(r.capacity)}" placeholder="e.g. 1 tonne"></label>`
          }

          <label class="ad-field inv-span2"><span>Notes</span>
            <textarea class="ad-input" rows="2" data-rf="notes" placeholder="Just for the team...">${esc(r.notes)}</textarea></label>
        </div>

        <label class="inv-toggle">
          <span>
            <strong>Active</strong>
            <em>Available to add to a quote as a billable line.</em>
          </span>
          <input type="checkbox" data-rf="active"${r.active !== false ? ' checked' : ''}>
          <span class="inv-switch" aria-hidden="true"></span>
        </label>
      </div>

      <footer class="inv-detail-foot">
        ${isNew ? '' : '<button type="button" class="ad-btn inv-del" id="res-delete">Delete</button>'}
        <button type="button" class="ad-btn ad-btn-primary" id="res-save">${isNew ? 'Add record' : 'Save changes'}</button>
        <span class="ad-quote-msg" id="res-msg"></span>
      </footer>
    </aside>`;
}

function wireResourceDetail() {
    const panel = document.querySelector('.inv-detail');
    if (!panel) return;

    const close = document.getElementById('res-close');
    if (close)
        close.addEventListener('click', () => {
            state.openResourceId = null;
            render();
        });

    panel.addEventListener('input', (e) => {
        const t = e.target;
        if (!t.dataset.rf) return;
        const f = t.dataset.rf;
        if (f === 'active') resourceDraft.active = t.checked;
        else if (f === 'dayRateCents') resourceDraft.dayRateCents = toCents(t.value);
        else resourceDraft[f] = t.value;
    });

    // switching the type swaps the staff / vehicle fields
    const typeSel = panel.querySelector('[data-rf="type"]');
    if (typeSel)
        typeSel.addEventListener('change', () => {
            resourceDraft.type = typeSel.value;
            render();
        });

    const save = document.getElementById('res-save');
    if (save) save.addEventListener('click', () => saveResource(save));
    const del = document.getElementById('res-delete');
    if (del) del.addEventListener('click', () => deleteResource(del));
}

async function saveResource(btn) {
    const msg = document.getElementById('res-msg');
    const r = resourceDraft;
    if (!String(r.name || '').trim()) {
        setMsg(msg, 'Give it a name first.', 'is-bad');
        return;
    }
    const type = RES_TYPES[r.type] ? r.type : 'staff';
    const isStaff = type === 'staff';
    const text = (v, max) =>
        String(v || '')
            .trim()
            .slice(0, max);
    // staff keep role / phone / email (for job emails); vehicles and trailers keep rego / capacity
    const clean = {
        type,
        name: String(r.name).trim().slice(0, 120),
        role: isStaff ? text(r.role, 80) : '',
        phone: isStaff ? text(r.phone, 40) : '',
        email: isStaff
            ? String(r.email || '')
                  .trim()
                  .toLowerCase()
                  .slice(0, 200)
            : '',
        rego: isStaff ? '' : text(r.rego, 40),
        capacity: isStaff ? '' : text(r.capacity, 80),
        dayRateCents: Math.max(0, Math.round(r.dayRateCents || 0)),
        active: r.active !== false,
        notes: text(r.notes, 1000),
        updatedAt: Date.now()
    };

    setMsg(msg, 'Saving…', '');
    if (btn) btn.disabled = true;
    try {
        const { collection, doc, setDoc, addDoc } = fb.f;
        state.resources = state.resources || [];
        if (state.openResourceId === '__new__') {
            clean.createdAt = Date.now();
            const ref = await addDoc(collection(fb.db, 'resources'), clean);
            state.openResourceId = ref.id;
            state.resources.push({ id: ref.id, ...clean });
        } else {
            const id = state.openResourceId;
            await setDoc(doc(fb.db, 'resources', id), clean, { merge: true });
            const cur = state.resources.find((x) => x.id === id);
            if (cur) Object.assign(cur, clean);
            else state.resources.push({ id, ...clean });
        }
        setMsg(msg, 'Saved.', 'is-ok');
        render();
    } catch (err) {
        setMsg(msg, err.message || 'Could not save.', 'is-bad');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function deleteResource(btn) {
    if (!window.confirm('Delete this record? This cannot be undone.')) return;
    const id = state.openResourceId;
    if (id === '__new__') {
        state.openResourceId = null;
        render();
        return;
    }
    if (btn) btn.disabled = true;
    try {
        const { doc, deleteDoc } = fb.f;
        await deleteDoc(doc(fb.db, 'resources', id));
        state.resources = (state.resources || []).filter((x) => x.id !== id);
        state.openResourceId = null;
        render();
    } catch (err) {
        const msg = document.getElementById('res-msg');
        setMsg(msg, err.message || 'Could not delete.', 'is-bad');
        if (btn) btn.disabled = false;
    }
}
