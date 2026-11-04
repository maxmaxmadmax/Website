/* SOUNDZGOOD ADMIN - customers.js
   Customers.
   A plain script: every admin file shares one page scope, loaded in order by admin.html. */
'use strict';

/* =========================================================================
   CUSTOMERS

   One record per customer: name, business, type, address, phone, email and
   notes, plus every quote / invoice that matches them (by email, phone or
   name). Lives in Firestore `customers`, admin only.

   - Customers tab: search, add, edit, and a one-off "Import" that builds
     the list from past quotes and quote-bot enquiries (duplicates merged by
     email or phone).
   - Quote builder: a search box above "Customer name" fills the details in.
     Saving the quote adds a new customer, or updates the picked one with any
     changed details.
   ========================================================================= */
const CUST_TYPES = { private: 'Private', business: 'Business', nfp: 'Not-for-profit', council: 'Council', school: 'School', club: 'Club' };
const CUST_TYPE_PILL = {
    private: 'ad-pill-grey',
    business: 'ad-pill-blue',
    nfp: 'ad-pill-green',
    council: 'ad-pill-green',
    school: 'ad-pill-amber',
    club: 'ad-pill-amber'
};

let customerDraft = null;
let quoteCustomerId = ''; // the customer picked on the quote being edited

/* ---- matching helpers ---- */
function custEmailKey(v) {
    return String(v || '')
        .trim()
        .toLowerCase();
}
function custPhoneKey(v) {
    let d = String(v || '').replace(/\D/g, '');
    if (d.startsWith('61') && d.length === 11) d = '0' + d.slice(2); // +61 4.. -> 04..
    return d.length >= 8 ? d : '';
}
function custNameKey(v) {
    return String(v || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

/*  The saved customer this contact belongs to: same email, else same phone. */
function findCustomerMatch(c, skipId) {
    const e = custEmailKey(c.email),
        p = custPhoneKey(c.phone);
    return (
        (state.customers || []).find(
            (x) => x.id !== skipId && ((e && custEmailKey(x.email) === e) || (p && custPhoneKey(x.phone) === p))
        ) || null
    );
}

/*  Every quote / invoice for a customer (email, phone, or exact name). */
function customerQuotes(cu) {
    const e = custEmailKey(cu.email),
        p = custPhoneKey(cu.phone),
        n = custNameKey(cu.name);
    return (state.quoteDocs || []).filter((q) => {
        const c = q.customer || {};
        return (e && custEmailKey(c.email) === e) || (p && custPhoneKey(c.phone) === p) || (!e && !p && n && custNameKey(c.name) === n);
    });
}

function subscribeToCustomers() {
    const { collection, onSnapshot } = fb.f;
    unsubscribes.push(
        onSnapshot(
            collection(fb.db, 'customers'),
            (snap) => {
                const rows = snapRows(snap);
                rows.sort((a, b) =>
                    (a.name || a.business || '').localeCompare(b.name || b.business || '', undefined, { sensitivity: 'base' })
                );
                state.customers = rows;
                if (state.view === 'customers') {
                    if (state.openCustomerId)
                        renderCustRows(); // panel open: refresh list only
                    else render();
                }
            },
            (err) => console.error('customers', err)
        )
    );
}

function blankCustomer() {
    return { name: '', business: '', type: 'private', address: '', phone: '', email: '', ccEmail: '', notes: '' };
}
function customerFromDoc(d) {
    return {
        name: d.name || '',
        business: d.business || '',
        type: CUST_TYPES[d.type] ? d.type : 'private',
        address: d.address || '',
        phone: d.phone || '',
        email: d.email || '',
        ccEmail: d.ccEmail || '',
        notes: d.notes || ''
    };
}
function cleanCustomer(c) {
    const t = (v, n) =>
        String(v == null ? '' : v)
            .trim()
            .slice(0, n);
    return {
        name: t(c.name, 120),
        business: t(c.business, 120),
        type: CUST_TYPES[c.type] ? c.type : 'private',
        address: t(c.address, 300),
        phone: t(c.phone, 40),
        email: t(c.email, 200),
        ccEmail: t(c.ccEmail, 600),
        notes: t(c.notes, 2000),
        updatedAt: Date.now()
    };
}

/* ---- list ---- */
VIEWS.customers = {
    html() {
        const open = state.openCustomerId != null;
        return `<div class="inv-wrap${open ? ' has-detail' : ''}">
      ${customerMainHtml()}
      ${open ? customerDetailHtml() : ''}
    </div>`;
    },
    wire() {
        wireCustomerList();
        if (state.openCustomerId != null) wireCustomerDetail();
    }
};

function custFiltered() {
    const rows = state.customers || [];
    const f = state.custType || 'all';
    const needle = (state.custSearch || '').trim().toLowerCase();
    const digits = needle.replace(/\D/g, '');
    return rows.filter((r) => {
        if (f !== 'all' && (r.type || 'private') !== f) return false;
        if (!needle) return true;
        if (digits.length >= 3 && custPhoneKey(r.phone).includes(digits)) return true;
        return searchMatch(needle, r.name, r.business, r.email, r.ccEmail, r.address, r.notes);
    });
}

function customerMainHtml() {
    const rows = state.customers || [];
    const f = state.custType || 'all';
    const opt = (v, l) => `<option value="${v}"${f === v ? ' selected' : ''}>${l}</option>`;
    const count = (t) => rows.filter((r) => (r.type || 'private') === t).length;
    return `
      <div class="inv-main">
        <div class="inv-head">
          <div class="inv-head-title">
            <span class="ad-mail-icon" aria-hidden="true">&#128101;</span>
            <div>
              <h1>Customers</h1>
              <p>Everyone you quote. Search here, or straight from a quote. New customers are added when a quote is saved.</p>
            </div>
          </div>
          <div class="inv-head-actions">
            <button type="button" class="ad-btn ad-btn-small" id="cust-import">Import from past quotes</button>
            <button type="button" class="ad-btn ad-btn-primary" id="cust-new">+ Customer</button>
          </div>
        </div>
        <p class="ad-quote-msg" id="cust-import-msg"></p>

        <div class="ad-tiles">
          ${invTile('&#128101;', 'is-grey', rows.length, 'Customers', '')}
          ${invTile('&#127968;', 'is-green', count('private'), 'Private', '')}
          ${invTile('&#127970;', 'is-blue', count('business'), 'Business', '')}
          ${invTile('&#127963;', 'is-amber', count('nfp') + count('council') + count('school') + count('club'), 'Not-for-profits, councils, schools &amp; clubs', '')}
        </div>

        <div class="inv-toolbar">
          <input type="search" id="cust-search" class="ad-search" placeholder="Search name, business, phone or email..."
                 value="${attr(state.custSearch || '')}" aria-label="Search customers">
          <select id="cust-f-type" class="ad-select" aria-label="Filter by type">
            ${opt('all', 'All types')}${Object.keys(CUST_TYPES)
                .map((k) => opt(k, CUST_TYPES[k]))
                .join('')}
          </select>
        </div>

        <div class="ad-table-wrap inv-table-wrap">
          <table class="ad-table inv-table">
            <thead><tr><th>Customer</th><th>Type</th><th>Phone</th><th>Email</th><th class="inv-num">Quotes</th><th></th></tr></thead>
            <tbody id="cust-rows"></tbody>
          </table>
        </div>
        <div class="inv-foot" id="cust-foot"></div>
      </div>`;
}

function renderCustRows() {
    const host = document.getElementById('cust-rows');
    const foot = document.getElementById('cust-foot');
    if (!host) return;
    const rows = custFiltered();
    const dash = '<span class="ad-cell-muted">—</span>';
    host.innerHTML = rows.length
        ? rows
              .map((r) => {
                  const t = CUST_TYPES[r.type] ? r.type : 'private';
                  const letter = (r.name || r.business || '?').trim().charAt(0).toUpperCase();
                  return `
    <tr class="inv-row${state.openCustomerId === r.id ? ' is-open' : ''}" data-open-cust="${attr(r.id)}">
      <td class="inv-item-cell">
        <span class="inv-thumb">${esc(letter)}</span>
        <span class="inv-item-text"><span class="inv-item-name">${esc(r.name || r.business || 'Unnamed')}</span>
          ${r.name && r.business ? `<span class="inv-item-sub">${esc(r.business)}</span>` : ''}</span>
      </td>
      <td><span class="ad-pill ${CUST_TYPE_PILL[t]}">${esc(CUST_TYPES[t])}</span></td>
      <td>${r.phone ? esc(r.phone) : dash}</td>
      <td>${r.email ? esc(r.email) : dash}</td>
      <td class="inv-num">${customerQuotes(r).length}</td>
      <td class="ad-cell-right"><button type="button" class="inv-open-btn" data-open-cust="${attr(r.id)}" aria-label="Open">&#8250;</button></td>
    </tr>`;
              })
              .join('')
        : `<tr><td colspan="6" class="ad-cell-muted">${(state.customers || []).length ? 'No customers match. Try clearing the search.' : 'No customers yet. Press "Import from past quotes" to fill the list, or add one.'}</td></tr>`;
    if (foot) foot.innerHTML = `<p class="inv-foot-count">${rows.length} customer${rows.length === 1 ? '' : 's'}</p>`;
}

function wireCustomerList() {
    renderCustRows();
    const nw = document.getElementById('cust-new');
    if (nw)
        nw.addEventListener('click', () => {
            customerDraft = blankCustomer();
            state.openCustomerId = '__new__';
            render();
        });
    const imp = document.getElementById('cust-import');
    if (imp) imp.addEventListener('click', () => importCustomers(imp));
    const search = document.getElementById('cust-search');
    if (search)
        search.addEventListener('input', () => {
            state.custSearch = search.value;
            renderCustRows();
        });
    const typeSel = document.getElementById('cust-f-type');
    if (typeSel)
        typeSel.addEventListener('change', () => {
            state.custType = typeSel.value;
            renderCustRows();
        });
    const host = document.getElementById('cust-rows');
    if (host)
        host.addEventListener('click', (e) => {
            const r = e.target.closest('[data-open-cust]');
            if (!r) return;
            const id = r.getAttribute('data-open-cust');
            const d = (state.customers || []).find((x) => x.id === id);
            customerDraft = d ? customerFromDoc(d) : blankCustomer();
            state.openCustomerId = id;
            render();
        });
}

/* ---- detail panel ---- */
function customerDetailHtml() {
    const isNew = state.openCustomerId === '__new__';
    const c = customerDraft || blankCustomer();
    const typeOpt = (k) => `<option value="${k}"${c.type === k ? ' selected' : ''}>${CUST_TYPES[k]}</option>`;
    const quotes = isNew ? [] : customerQuotes(c);
    const qRows = quotes
        .map(
            (q) => `
      <button type="button" class="cust-q" data-cust-quote="${attr(q.id)}">
        <b>${esc(q.number || 'Draft')}</b>
        <span>${esc((q.customer && q.customer.eventName) || (q.kind === 'invoice' ? 'Invoice' : 'Quote'))}</span>
        <span class="cust-q-amt">${esc(money(q.totalCents || 0))}</span>
        ${qdocPill(q.status || 'draft')}
      </button>`
        )
        .join('');
    return `
    <aside class="inv-detail" aria-label="Customer details">
      <header class="inv-detail-head">
        <div>
          <h2>${isNew ? 'New customer' : esc(c.name || c.business || 'Customer')}</h2>
          ${!isNew && c.name && c.business ? `<p class="inv-detail-sub">${esc(c.business)}</p>` : ''}
        </div>
        <button type="button" class="inv-detail-close" id="cust-close" aria-label="Close">&times;</button>
      </header>

      <div class="inv-detail-body">
        <div class="inv-fgrid">
          <label class="ad-field inv-span2"><span>Name</span>
            <input class="ad-input" data-cf="name" value="${attr(c.name)}" placeholder="e.g. Jess Smith"></label>
          <label class="ad-field"><span>Business (optional)</span>
            <input class="ad-input" data-cf="business" value="${attr(c.business)}"></label>
          <label class="ad-field"><span>Type</span>
            <select class="ad-select" data-cf="type">${Object.keys(CUST_TYPES).map(typeOpt).join('')}</select></label>
          <label class="ad-field inv-span2"><span>Phone</span>
            <input class="ad-input" data-cf="phone" value="${attr(c.phone)}"></label>
          <label class="ad-field inv-span2"><span>Email</span>
            <input class="ad-input" type="email" data-cf="email" value="${attr(c.email)}"></label>
          <label class="ad-field inv-span2"><span>CC email (optional)</span>
            <input class="ad-input" type="email" multiple data-cf="ccEmail" value="${attr(c.ccEmail)}" placeholder="e.g. accounts@, events@ - separate with commas, all get a copy"></label>
          <label class="ad-field inv-span2"><span>Address</span>
            <input class="ad-input" data-cf="address" value="${attr(c.address)}"></label>
          <label class="ad-field inv-span2"><span>Notes</span>
            <textarea class="ad-input" rows="3" data-cf="notes" placeholder="e.g. Council - needs a PO number. Always wants delivery.">${esc(c.notes)}</textarea></label>
        </div>

        ${
            isNew
                ? ''
                : `
        <div class="cust-quotes">
          <p class="cust-quotes-h">Quotes &amp; invoices (${quotes.length})</p>
          ${qRows || '<p class="ad-cell-muted">None yet.</p>'}
          <button type="button" class="ad-btn ad-btn-small" id="cust-new-quote">+ New quote for this customer</button>
        </div>`
        }
      </div>

      <footer class="inv-detail-foot">
        ${isNew ? '' : '<button type="button" class="ad-btn inv-del" id="cust-delete">Delete</button>'}
        <button type="button" class="ad-btn ad-btn-primary" id="cust-save">${isNew ? 'Add customer' : 'Save changes'}</button>
        <span class="ad-quote-msg" id="cust-msg"></span>
      </footer>
    </aside>`;
}

function wireCustomerDetail() {
    const panel = document.querySelector('.inv-detail');
    if (!panel) return;
    const close = document.getElementById('cust-close');
    if (close)
        close.addEventListener('click', () => {
            state.openCustomerId = null;
            render();
        });
    const onField = (e) => {
        const f = e.target.dataset.cf;
        if (f) customerDraft[f] = e.target.value;
    };
    panel.addEventListener('input', onField);
    panel.addEventListener('change', onField);
    const save = document.getElementById('cust-save');
    if (save) save.addEventListener('click', () => saveCustomer(save));
    const del = document.getElementById('cust-delete');
    if (del) del.addEventListener('click', () => deleteCustomer(del));

    panel.querySelectorAll('[data-cust-quote]').forEach((b) =>
        b.addEventListener('click', () => {
            const d = (state.quoteDocs || []).find((x) => x.id === b.getAttribute('data-cust-quote'));
            if (!d) return;
            state.openCustomerId = null;
            location.hash = '#/quoteDocs?q=' + d.id;
        })
    );
    const nq = document.getElementById('cust-new-quote');
    if (nq) nq.addEventListener('click', () => startQuoteForCustomer(state.openCustomerId));
}

async function saveCustomer(btn) {
    const msg = document.getElementById('cust-msg');
    const c = customerDraft;
    if (!String(c.name || c.business || '').trim()) {
        setMsg(msg, 'Add a name or business first.', 'is-bad');
        return;
    }
    const isNew = state.openCustomerId === '__new__';
    const dupe = findCustomerMatch(c, isNew ? '' : state.openCustomerId);
    if (dupe && !window.confirm(`${dupe.name || dupe.business} already has that email or phone number. Save anyway?`)) return;

    const clean = cleanCustomer(c);
    if (btn) btn.disabled = true;
    setMsg(msg, 'Saving…', '');
    try {
        const { collection, doc, setDoc, addDoc } = fb.f;
        state.customers = state.customers || [];
        if (isNew) {
            clean.createdAt = Date.now();
            clean.source = 'admin';
            const ref = await addDoc(collection(fb.db, 'customers'), clean);
            state.openCustomerId = ref.id;
            state.customers.push({ id: ref.id, ...clean });
        } else {
            const id = state.openCustomerId;
            await setDoc(doc(fb.db, 'customers', id), clean, { merge: true });
            const cur = state.customers.find((x) => x.id === id);
            if (cur) Object.assign(cur, clean);
        }
        render();
        const m2 = document.getElementById('cust-msg');
        setMsg(m2, 'Saved.', 'is-ok');
    } catch (err) {
        setMsg(msg, err.message || 'Could not save.', 'is-bad');
    } finally {
        if (btn) btn.disabled = false;
    }
}

/*  Max deletes by hand only - this asks first. Their quotes are not touched. */
async function deleteCustomer(btn) {
    if (!window.confirm('Delete this customer? Their quotes and invoices are kept. This cannot be undone.')) return;
    const id = state.openCustomerId;
    if (btn) btn.disabled = true;
    try {
        const { doc, deleteDoc } = fb.f;
        await deleteDoc(doc(fb.db, 'customers', id));
        state.customers = (state.customers || []).filter((x) => x.id !== id);
        state.openCustomerId = null;
        render();
    } catch (err) {
        const msg = document.getElementById('cust-msg');
        setMsg(msg, err.message || 'Could not delete.', 'is-bad');
        if (btn) btn.disabled = false;
    }
}

/*  One-off fill from past quotes (incl. quote-bot ones) and quote-bot
    enquiries. Anyone already in Customers (same email or phone) is skipped. */
async function importCustomers(btn) {
    const msg = document.getElementById('cust-import-msg');
    const found = [];
    const add = (c, source) => {
        const name = String(c.name || '').trim(),
            business = String(c.business || '').trim();
        if (!name && !business) return;
        const rec = {
            name,
            business,
            address: String(c.address || '').trim(),
            phone: String(c.phone || '').trim(),
            email: String(c.email || '').trim()
        };
        const e = custEmailKey(rec.email),
            p = custPhoneKey(rec.phone),
            n = custNameKey(name || business);
        const same = found.find(
            (x) =>
                (e && custEmailKey(x.email) === e) ||
                (p && custPhoneKey(x.phone) === p) ||
                (!e && !p && custNameKey(x.name || x.business) === n)
        );
        if (same) {
            ['business', 'address', 'phone', 'email'].forEach((k) => {
                if (!same[k] && rec[k]) same[k] = rec[k];
            });
            return;
        }
        found.push({ ...rec, source });
    };
    (state.quoteDocs || []).forEach((q) => add(q.customer || {}, q.source === 'bot' ? 'quote bot' : 'quote'));

    const fresh = found.filter(
        (c) =>
            !findCustomerMatch(c) &&
            !(state.customers || []).some(
                (x) => !x.email && !x.phone && custNameKey(x.name || x.business) === custNameKey(c.name || c.business)
            )
    );
    if (!fresh.length) {
        setMsg(msg, 'Everyone from past quotes is already in Customers.', 'is-ok');
        return;
    }
    if (!window.confirm(`Add ${fresh.length} customer${fresh.length === 1 ? '' : 's'} from past quotes and enquiries?`)) return;

    if (btn) btn.disabled = true;
    try {
        const { collection, addDoc } = fb.f;
        for (const c of fresh) {
            const clean = cleanCustomer({ ...c, type: c.business ? 'business' : 'private' });
            clean.createdAt = Date.now();
            clean.source = c.source;
            await addDoc(collection(fb.db, 'customers'), clean);
        }
        setMsg(msg, `Added ${fresh.length} customer${fresh.length === 1 ? '' : 's'}.`, 'is-ok');
    } catch (err) {
        setMsg(msg, (err && err.message) || 'Import stopped part way - press Import again to finish.', 'is-bad');
    } finally {
        if (btn) btn.disabled = false;
    }
}

/* ---- the quote builder side ---- */

/*  Search box over "Customer name". Type 2+ letters (or 3+ digits of a phone). */
function quoteCustSearchHtml() {
    const picked = quoteCustomerId && (state.customers || []).find((x) => x.id === quoteCustomerId);
    return `
    <div class="qb-cust-find">
      <input type="search" class="qb-cust-input" id="qb-cust-input" autocomplete="off"
             placeholder="Search customers - name, business, phone or email">
      <div class="qb-cust-results" id="qb-cust-results" hidden></div>
      ${picked ? `<p class="qb-cust-picked">Customer: <b>${esc(picked.name || picked.business)}</b> <button type="button" class="qb-cust-clear" id="qb-cust-clear">change</button></p>` : ''}
    </div>`;
}

function wireQuoteCustSearch() {
    const input = document.getElementById('qb-cust-input');
    const box = document.getElementById('qb-cust-results');
    if (!input || !box) return;
    const show = () => {
        const q = input.value.trim().toLowerCase();
        const digits = q.replace(/\D/g, '');
        if (q.length < 2) {
            box.hidden = true;
            return;
        }
        const byPhone = digits.length >= 3 ? (state.customers || []).filter((r) => custPhoneKey(r.phone).includes(digits)) : [];
        const byText = searchList(
            state.customers || [],
            q,
            (r) => r.name || r.business,
            (r) => [r.business, r.email, r.ccEmail]
        );
        const hits = [...new Set([...byPhone, ...byText])].slice(0, 8);
        box.innerHTML = hits.length
            ? hits
                  .map(
                      (r) => `<button type="button" data-pick-cust="${attr(r.id)}"><b>${esc(r.name || r.business)}</b>
          <span>${esc([r.business && r.name ? r.business : '', r.phone, r.email].filter(Boolean).join(' · '))}</span></button>`
                  )
                  .join('')
            : '<p>No match - type their details below. They are added to Customers when you save.</p>';
        box.hidden = false;
    };
    input.addEventListener('input', show);
    input.addEventListener('focus', show);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') box.hidden = true;
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.qb-cust-find')) box.hidden = true;
    });
    box.addEventListener('click', (e) => {
        const b = e.target.closest('[data-pick-cust]');
        if (b) pickQuoteCustomer(b.getAttribute('data-pick-cust'));
    });
    const clr = document.getElementById('qb-cust-clear');
    if (clr)
        clr.addEventListener('click', () => {
            quoteCustomerId = '';
            render();
        });
}

function pickQuoteCustomer(id) {
    const r = (state.customers || []).find((x) => x.id === id);
    if (!r) return;
    quoteCustomerId = id;
    quoteDraft.customer = { ...quoteDraft.customer, ...custContact(r) };
    render();
    scheduleQuoteAutosave();
}

/*  The contact details a saved customer puts on a quote. */
function custContact(r) {
    return {
        name: r.name || '',
        business: r.business || '',
        address: r.address || '',
        phone: r.phone || '',
        email: r.email || '',
        ccEmail: r.ccEmail || ''
    };
}

/*  After a quote saves: update the picked customer's details, or add a new
    customer (unless one with the same email / phone already exists, which
    then gets the update instead).                                        */
async function syncCustomerFromQuote() {
    try {
        const c = quoteDraft && quoteDraft.customer;
        if (!c || !String(c.name || c.business || '').trim()) return;
        const { collection, doc, setDoc, addDoc } = fb.f;
        const picked = quoteCustomerId && (state.customers || []).find((x) => x.id === quoteCustomerId);
        const target = picked || findCustomerMatch(c);
        if (target) {
            const changes = {};
            ['name', 'business', 'address', 'phone', 'email', 'ccEmail'].forEach((k) => {
                const v = String(c[k] || '').trim();
                if (v && v !== (target[k] || '')) changes[k] = v.slice(0, { address: 300, ccEmail: 600 }[k] || 200);
            });
            if (Object.keys(changes).length) {
                changes.updatedAt = Date.now();
                await setDoc(doc(fb.db, 'customers', target.id), changes, { merge: true });
            }
            quoteCustomerId = target.id;
        } else {
            const clean = cleanCustomer({ ...c, type: c.business ? 'business' : 'private' });
            clean.createdAt = Date.now();
            clean.source = 'quote';
            const ref = await addDoc(collection(fb.db, 'customers'), clean);
            quoteCustomerId = ref.id;
        }
    } catch (err) {
        console.error('customer sync', err); // the quote itself saved fine
    }
}

/*  "+ New quote for this customer" from the Customers panel. */
function startQuoteForCustomer(id) {
    const r = (state.customers || []).find((x) => x.id === id);
    if (!r) return;
    quoteDraft = blankQuote();
    quoteDraft.customer = { ...quoteDraft.customer, ...custContact(r) };
    quoteCustomerId = id;
    state.openCustomerId = null;
    state.openQuoteId = '__new__';
    location.hash = '#/quoteDocs?q=new';
}

/*  The quote builder's add-search draws on inventory PLUS active crew and
    vehicles, so any of them can be dropped onto a quote as a billable line. */
function quoteAddSearchList() {
    const inv = invSearchList().map((it) => ({
        id: it.id,
        name: it.name,
        priceCents: it.priceCents,
        kind: 'item',
        sub: it.category || 'Gear',
        system: it.isSystem === true,
        bundle: it.bundleType
    }));
    const res = (state.resources || [])
        .filter((r) => r.active !== false && r.name)
        .map((r) => ({
            id: r.id,
            name: r.name,
            priceCents: r.dayRateCents || 0,
            kind: 'resource',
            sub: RES_TYPES[r.type] || 'Crew',
            type: r.type || 'staff'
        }));
    return inv.concat(res);
}

function addResourceLineToQuote(res) {
    const days = Math.max(1, Math.round(quoteDraft.hire.days || 1));
    quoteDraft.lines.push({
        type: 'custom',
        name: res.name,
        qty: 1,
        unitCents: res.priceCents || 0,
        days,
        resourceId: res.id,
        resType: ['staff', 'vehicle', 'trailer'].includes(res.type) ? res.type : 'staff'
    });
    renderQuoteLines();
}
