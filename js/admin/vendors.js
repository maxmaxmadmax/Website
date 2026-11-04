/* SOUNDZGOOD ADMIN - vendors.js
   Vendors: the numbers, the application lists and the detail panel.
   A plain script: every admin file shares one page scope, loaded in order by admin.html. */
'use strict';

/* =========================================================================
   THE NUMBERS
   Where the event stands: applied, in, paid, ground left. Sits above the
   vendor list because every number is a count of the rows underneath.
   ========================================================================= */
function statsStrip() {
    const apps = realApplications();

    /*  Out of the running: turned away, or gone of their own accord. They
      still show in the list, but they are not pending anything and they do
      not owe anybody money, so they are kept out of those counts. */
    const isOut = (b) => bucket(b) === 'declined';
    const live = apps.filter((b) => !isOut(b));

    const confirmed = live.filter((b) => b.status === 'confirmed').length;
    const pending = live.filter((b) => !b.reviewStatus && b.status !== 'confirmed').length;
    const declined = apps.filter(isOut).length;

    const paid = live.filter((b) => b.paymentStatus === 'paid' || b.paymentStatus === 'free').length;
    const unpaid = live.length - paid;

    const filled = state.sites.filter((s) => s.status === 'booked' || s.status === 'held').length;
    const available = state.sites.filter((s) => s.status === 'available').length;

    /*  Each card filters the list below it to the rows it counts, so a number
      that looks wrong is one click from the vendors behind it. The two site
      cards count sites rather than vendors, so they do not filter. */
    const cards = [
        ['Total applications', apps.length, 'all vendor types', '', { status: 'all', payment: 'all' }],
        ['Confirmed', confirmed, 'locked in', 'is-green', { status: 'confirmed' }],
        ['Pending review', pending, 'awaiting a decision', 'is-amber', { status: 'pending' }],
        ['Declined', declined, 'turned away or cancelled', 'is-red', { status: 'declined' }],
        ['Paid', paid, 'money received', 'is-green', { payment: 'paid' }],
        ['Unpaid', unpaid, 'still owing', 'is-amber', { payment: 'unpaid' }],
        ['Sites filled', filled, pct(filled, state.sites.length) + ' of the ground', 'is-blue', null],
        ['Sites available', available, 'still to sell', '', null]
    ];

    return `
    <div class="ad-tiles">
      ${cards
          .map(([label, value, note, mod, filter]) => {
              const inner = `<span class="ad-tile-body"><b class="ad-tile-value">${value}</b><span class="ad-tile-label">${esc(label)}</span><em class="ad-tile-note">${esc(note)}</em></span>`;
              return filter
                  ? `<button type="button" class="ad-tile ${mod}" data-stat="${attr(JSON.stringify(filter))}">${inner}</button>`
                  : `<div class="ad-tile ${mod}">${inner}</div>`;
          })
          .join('')}
    </div>`;
}

function wireStats() {
    document.querySelectorAll('[data-stat]').forEach((card) => {
        card.addEventListener('click', () => {
            const want = JSON.parse(card.getAttribute('data-stat'));
            // A card sets only what it counts by and clears the rest.
            state.filters = {
                search: '',
                vendorType: 'all',
                status: want.status || 'all',
                payment: want.payment || 'all'
            };
            render();
        });
    });
}

function pct(part, whole) {
    if (!whole) return '0%';
    return Math.round((part / whole) * 100) + '%';
}

/* =========================================================================
   VENDOR AND APPLICATION LISTS
   Applications = still waiting on a decision or a payment. Vendors = who is
   coming. Same list, search, filters and detail panel - only the starting
   rows differ.
   ========================================================================= */

/*  The bucket a row belongs in, worked out once so the filter, the pill and
    the two lists all agree on what a booking is. */
function bucket(b) {
    if (b.reviewStatus === 'declined' || b.status === 'cancelled') return 'declined';
    if (b.reviewStatus === 'waitlisted') return 'waitlisted';
    if (b.status === 'confirmed') return 'confirmed';
    if (b.reviewStatus === 'approved') return 'approved';
    return 'pending';
}

/*  Filtering to Unpaid is somebody building a chase list, so a vendor who
    was declined or has cancelled is neither paid nor unpaid - they drop out
    of both. Same rule the dashboard counts by. */
function paymentBucket(b) {
    if (b.paymentStatus === 'paid' || b.paymentStatus === 'free') return 'paid';
    if (bucket(b) === 'declined') return 'moot';
    return 'unpaid';
}

/*  Everything a person might reasonably type into the search box, flattened
    into one string per booking. */
function haystack(b) {
    const biz = b.business || {};
    return [
        biz.name,
        biz.contactName,
        biz.email,
        biz.phone,
        b.reference,
        b.categoryName,
        b.siteLabel,
        b.vendorType,
        (b.siteIds || []).join(' ')
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

function applyFilters(rows) {
    const f = state.filters;
    const term = f.search.trim().toLowerCase();

    return rows.filter((b) => {
        if (f.status !== 'all' && bucket(b) !== f.status) return false;
        if (f.vendorType !== 'all' && b.vendorType !== f.vendorType) return false;
        if (f.payment !== 'all' && paymentBucket(b) !== f.payment) return false;
        if (term && !haystack(b).includes(term)) return false;
        return true;
    });
}

const STATUS_CHOICES = [
    ['all', 'Any status'],
    ['pending', 'Pending review'],
    ['approved', 'Approved'],
    ['confirmed', 'Confirmed'],
    ['waitlisted', 'Waitlisted'],
    ['declined', 'Declined']
];

const TYPE_CHOICES = [
    ['all', 'Any type'],
    ['food', 'Food'],
    ['market', 'Market']
];

const PAYMENT_CHOICES = [
    ['all', 'Any payment'],
    ['paid', 'Paid'],
    ['unpaid', 'Unpaid']
];

function selectField(id, choices, current) {
    return `<select id="${id}">${choices
        .map(([v, label]) => `<option value="${attr(v)}"${v === current ? ' selected' : ''}>${esc(label)}</option>`)
        .join('')}</select>`;
}

function filterBar() {
    const f = state.filters;
    return `
    <div class="ad-filters">
      <input type="search" id="ad-search" class="ad-search"
             placeholder="Search name, email, phone, site…"
             value="${attr(f.search)}">
      ${selectField('ad-f-status', STATUS_CHOICES, f.status)}
      ${selectField('ad-f-type', TYPE_CHOICES, f.vendorType)}
      ${selectField('ad-f-payment', PAYMENT_CHOICES, f.payment)}
      <button type="button" class="ad-btn" id="ad-f-clear">Clear</button>
    </div>`;
}

function wireFilters() {
    const on = (id, key, evt) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener(evt, () => {
            state.filters[key] = el.value;
            if (evt === 'input') renderKeepCaret(id);
            else render();
        });
    };

    on('ad-search', 'search', 'input');
    on('ad-f-status', 'status', 'change');
    on('ad-f-type', 'vendorType', 'change');
    on('ad-f-payment', 'payment', 'change');

    const clear = document.getElementById('ad-f-clear');
    if (clear)
        clear.addEventListener('click', () => {
            state.filters = { search: '', status: 'all', vendorType: 'all', payment: 'all' };
            render();
        });
}

function listTable(rows) {
    if (!rows.length) {
        return `<p class="ad-empty">Nothing matches those filters.</p>`;
    }

    return `
    <div class="ad-table-wrap">
      <table class="ad-table">
        <thead><tr>
          <th>Vendor</th><th>Type</th><th>Category</th><th>Site</th>
          <th>Status</th><th>Payment</th><th>Applied</th>
        </tr></thead>
        <tbody>
          ${rows
              .map(
                  (b) => `
            <tr data-open="${attr(b.id)}">
              <td>
                <span class="ad-cell-strong">${esc(vendorName(b))}</span>
                <span class="ad-cell-sub">${esc((b.business && b.business.email) || '')}</span>
              </td>
              <td>${typePill(b.vendorType)}</td>
              <td class="ad-cell-muted">${esc(b.categoryName || '—')}</td>
              <td>${esc(b.siteLabel || '—')}</td>
              <td>${statusPill(b)}</td>
              <td>${paymentPill(b)}</td>
              <td class="ad-cell-muted">${esc(dateShort(b.createdAt))}</td>
            </tr>`
              )
              .join('')}
        </tbody>
      </table>
    </div>`;
}

function wireRows() {
    document.querySelectorAll('[data-open]').forEach((row) => {
        row.addEventListener('click', () => {
            state.openBookingId = row.getAttribute('data-open');
            render();
        });
    });
}

/*  Both list views are the same page with a different starting set, and
    only the one that shows everybody carries the numbers. */
function listView(title, blurb, pick, opts = {}) {
    return {
        html() {
            const all = realApplications().filter(pick);
            const rows = applyFilters(all);
            const total = all.length;
            const ev = state.events.find((e) => e.id === state.activeEventId);

            return `
        <div class="ad-page-head">
          <div>
            <h1>${esc(title)}</h1>
            <p>${esc(blurb)}${ev && opts.stats ? ' &middot; ' + esc(ev.name || ev.id) : ''}</p>
          </div>
          <div class="ad-page-actions">
            <span class="ad-count">${rows.length}${rows.length === total ? '' : ' of ' + total}</span>
            <button type="button" class="ad-btn ad-btn-orange" id="ad-add-open">
              Add vendor
            </button>
          </div>
        </div>

        ${opts.stats ? statsStrip() : ''}

        ${filterBar()}

        <section class="ad-card ad-panel">
          ${listTable(rows)}
        </section>

        ${addVendorForm()}
        ${detailPanel()}`;
        },

        wire() {
            if (opts.stats) wireStats();
            wireFilters();
            wireRows();
            wireAddVendor();
            wireDetail();
        }
    };
}

/* -------------------------------------------------------------------------
   Adding a vendor by hand (phone or walk-up). Asks only who they are and
   the kind of stall; seating and payment go through the normal drawer.
   ------------------------------------------------------------------------- */
function addVendorForm() {
    if (!state.addingVendor) return '';

    return `
    <div class="ad-scrim" id="ad-add-scrim"></div>
    <div class="ad-modal" role="dialog" aria-label="Add a vendor">
      <form id="ad-add-form">
        <header class="ad-modal-head">
          <h2>Add a vendor</h2>
          <button type="button" class="ad-drawer-close" id="ad-add-close"
                  aria-label="Close">&times;</button>
        </header>

        <div class="ad-modal-body">
          <label for="ad-add-name">Business name</label>
          <input id="ad-add-name" required maxlength="120">

          <label for="ad-add-type">Vendor type</label>
          <select id="ad-add-type">
            <option value="food">Food</option>
            <option value="market">Market</option>
          </select>

          <label for="ad-add-contact">Contact name</label>
          <input id="ad-add-contact" maxlength="120">

          <label for="ad-add-email">Email</label>
          <input id="ad-add-email" type="email" maxlength="160">

          <label for="ad-add-phone">Phone</label>
          <input id="ad-add-phone" type="tel" maxlength="40">

          <label for="ad-add-bays">Bays</label>
          <input id="ad-add-bays" type="number" min="1" max="8" value="1">

          <label for="ad-add-desc">What they do</label>
          <textarea id="ad-add-desc" rows="3" maxlength="2000"></textarea>

          <p class="ad-action-msg" id="ad-add-msg" hidden></p>
        </div>

        <footer class="ad-modal-foot">
          <button type="button" class="ad-btn" id="ad-add-cancel">Cancel</button>
          <button type="submit" class="ad-btn ad-btn-orange">Add vendor</button>
        </footer>
      </form>
    </div>`;
}

function wireAddVendor() {
    const open = document.getElementById('ad-add-open');
    if (open)
        open.addEventListener('click', () => {
            state.addingVendor = true;
            render();
        });

    const close = () => {
        state.addingVendor = false;
        render();
    };
    ['ad-add-close', 'ad-add-cancel', 'ad-add-scrim'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', close);
    });

    const form = document.getElementById('ad-add-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const val = (id) => (document.getElementById(id).value || '').trim();
        const msg = document.getElementById('ad-add-msg');
        const submit = form.querySelector('[type="submit"]');

        submit.disabled = true;
        msg.hidden = false;
        msg.className = 'ad-action-msg';
        msg.textContent = 'Adding…';

        try {
            const res = await call('adminCreateBooking', {
                eventId: state.activeEventId,
                vendorType: val('ad-add-type'),
                bayCount: Number(val('ad-add-bays')) || 1,
                business: {
                    name: val('ad-add-name'),
                    contactName: val('ad-add-contact'),
                    email: val('ad-add-email'),
                    phone: val('ad-add-phone'),
                    description: val('ad-add-desc')
                }
            });

            /*  Straight into their drawer - whoever added them almost always
          wants to seat them next. */
            state.addingVendor = false;
            state.openBookingId = res.bookingId;
            render();
        } catch (err) {
            msg.className = 'ad-action-msg is-bad';
            msg.textContent = friendly(err);
            submit.disabled = false;
        }
    });
}

/*  Vendors is the whole picture - everybody, with the event's numbers above
    them. Applications is the short list of people still waiting on a
    decision, so it is somewhere to work through rather than somewhere to
    look things up. Anyone already decided on is found in Vendors. */
VIEWS.vendors = listView('Vendors', 'Everyone who has applied, newest first.', () => true, { stats: true });

VIEWS.applications = listView('Applications', 'Still waiting on a decision.', (b) => ['pending', 'waitlisted'].includes(bucket(b)));

/* =========================================================================
   DETAIL PANEL - slides in over the list, so the list keeps its place.
   Every button calls an admin Cloud Function (never Firestore directly) so
   seating and money change in one server-side transaction.
   ========================================================================= */
/*  Clicks run `run`, asking first when the button has data-confirm. */
function guarded(el, run) {
    if (!el) return;
    el.addEventListener('click', () => {
        const ask = el.getAttribute('data-confirm');
        if (ask && !window.confirm(ask)) return;
        run();
    });
}

/*  Text on a small .ad-quote-msg line; mod is '', 'is-ok' or 'is-bad'. */
function setMsg(el, text, mod) {
    if (!el) return;
    el.textContent = text;
    el.className = 'ad-quote-msg' + (mod ? ' ' + mod : '');
}

/*  Show text on an .ad-action-msg line; mod is '', 'is-ok' or 'is-bad'. */
function showMsg(bar, text, mod) {
    if (!bar) return;
    bar.hidden = false;
    bar.className = 'ad-action-msg' + (mod ? ' ' + mod : '');
    bar.textContent = text;
}

function row(label, value) {
    return `<div class="ad-kv"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
}

/*  Runs an admin function and shows what happened in the drawer. The live
    subscription redraws the page on its own once Firestore comes back, so
    there is nothing to refresh by hand. */
async function runAction(button, name, data) {
    const bar = document.getElementById('ad-action-msg');
    const buttons = [...document.querySelectorAll('.ad-actions button, .ad-actions-row button, .ad-note-form button')];

    buttons.forEach((b) => {
        b.disabled = true;
    });
    if (button) button.classList.add('is-working');
    showMsg(bar, 'Working…', '');

    try {
        await call(name, data);
        showMsg(bar, 'Saved.', 'is-ok');
    } catch (err) {
        showMsg(bar, friendly(err), 'is-bad');
        buttons.forEach((b) => {
            b.disabled = false;
        });
    }

    if (button) button.classList.remove('is-working');
}

function detailPanel() {
    if (!state.openBookingId) return '';

    const b = state.bookings.find((x) => x.id === state.openBookingId);
    if (!b) return '';

    const biz = b.business || {};
    const setup = b.setup || {};
    const docs = b.documents || [];
    const sites = b.siteIds && b.siteIds.length ? b.siteIds.join(', ') : b.siteId || '';

    return `
    <div class="ad-scrim" id="ad-scrim"></div>
    <aside class="ad-drawer" id="ad-drawer" role="dialog" aria-label="Application detail">

      <header class="ad-drawer-head">
        <div>
          <h2>${esc(vendorName(b))}</h2>
          <p>${statusPill(b)} ${paymentPill(b)} ${typePill(b.vendorType)}</p>

          <!--  Which event this application is for. The list is already
                filtered to one event by the picker at the top of the
                page, but an application is a thing somebody reads on its
                own - in a drawer, or over a shoulder - and it should say
                what it belongs to without relying on what is selected
                three feet away.                                     -->
          <p class="ad-drawer-event">${esc(eventNameOf(b.eventId))}</p>
        </div>
        <button type="button" class="ad-drawer-close" id="ad-drawer-close"
                aria-label="Close">&times;</button>
      </header>

      <div class="ad-drawer-body">

        ${actionBar(b)}

        <h3 class="ad-drawer-h">Contact</h3>
        <dl class="ad-kvs">
          ${row('Business', esc(biz.name || '—'))}
          ${row('Contact name', esc(biz.contactName || '—'))}
          ${row('Email', biz.email ? `<a href="mailto:${attr(biz.email)}">${esc(biz.email)}</a>` : '—')}
          ${row('Phone', biz.phone ? `<a href="tel:${attr(biz.phone)}">${esc(biz.phone)}</a>` : '—')}
          ${row('Socials', esc(biz.socials || '—'))}
        </dl>

        ${
            biz.description
                ? `
          <h3 class="ad-drawer-h">What they do</h3>
          <p class="ad-drawer-text">${esc(biz.description)}</p>`
                : ''
        }

        <h3 class="ad-drawer-h">Site</h3>
        ${sitePicker(b)}
        <dl class="ad-kvs">
          ${row('Category', esc(b.categoryName || '—'))}
          ${row('Assigned site', esc(b.siteLabel || 'Not assigned'))}
          ${row('Site IDs', esc(sites || '—'))}
          ${row('Bays', esc(b.bayCount || 1))}
          ${row('Frontage', esc(setup.frontage ? setup.frontage + ' m' : '—'))}
          ${row('Depth', esc(setup.depth ? setup.depth + ' m' : '—'))}
          ${row('Own power', setup.ownPower ? 'Yes' : 'No')}
          ${row('FAQs read', (setup.readFaqs ?? setup.selfSufficient) ? 'Yes' : 'No')}
          ${setup.notes ? row('Notes', esc(setup.notes)) : ''}
        </dl>

        <h3 class="ad-drawer-h">Money</h3>
        <dl class="ad-kvs">
          ${row('Site fee', esc(money(b.amountCents)))}
          ${b.bookingFeeCents != null ? row('Booking fee', esc(money(b.bookingFeeCents))) : ''}
          ${b.gstCents != null ? row('GST', esc(money(b.gstCents))) : ''}
          ${row('Total', `<strong>${esc(money(b.totalCents != null ? b.totalCents : b.amountCents))}</strong>`)}
          ${row('Paid', esc(money(b.amountPaidCents)))}
          ${row('Reference', esc(b.reference || '—'))}
        </dl>

        <h3 class="ad-drawer-h">Documents</h3>
        ${
            docs.length
                ? `
          <ul class="ad-docs">
            ${docs
                .map((d) => {
                    const href = safeUrl(d.url);
                    const label = esc(d.name || d.type || 'Document');
                    return `
              <li>
                ${
                    href
                        ? `<a href="${attr(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
                        : `<span class="ad-doc-bad">${label}</span>
                     <span class="ad-cell-sub">Not a file we uploaded - link withheld</span>`
                }
                <span class="ad-cell-sub">${esc(d.type || '')}</span>
              </li>`;
                })
                .join('')}
          </ul>`
                : `<p class="ad-drawer-text ad-cell-muted">None uploaded.</p>`
        }

        <h3 class="ad-drawer-h">Internal notes</h3>
        ${notesBlock(b)}

        <h3 class="ad-drawer-h">History</h3>
        <dl class="ad-kvs">
          ${row('Applied', esc(dateShort(b.createdAt)))}
          ${row('Confirmed', esc(dateShort(b.confirmedAt)))}
          ${row('Last change', esc(dateShort(b.updatedAt)))}
          ${b.reviewedBy ? row('Reviewed by', esc(b.reviewedBy)) : ''}
          ${b.addedByAdmin ? row('Added by', esc(b.addedBy || 'staff')) : ''}
        </dl>

      </div>
    </aside>`;
}

/* -------------------------------------------------------------------------
   The decision and payment buttons. The current state is not offered back
   as a button.
   ------------------------------------------------------------------------- */
function actionBar(b) {
    const now = bucket(b);
    const paid = paymentBucket(b) === 'paid';

    const decide = [
        ['approved', 'Approve', 'ad-btn-orange'],
        ['waitlisted', 'Waitlist', ''],
        ['declined', 'Decline', 'ad-btn-danger']
    ].filter(([value]) => value !== now);

    /*  Declining hands the site back and drops the category count, which is
      not obvious from a button called Decline, so it says so first. */
    return `
    <div class="ad-actions">
      <p class="ad-actions-h">Decision</p>
      <div class="ad-actions-row">
        ${decide
            .map(
                ([value, label, cls]) => `
          <button type="button" class="ad-btn ${cls}"
                  data-decide="${attr(value)}"
                  ${value === 'declined' ? 'data-confirm="Decline this vendor? Their site goes back on the market."' : ''}>
            ${esc(label)}
          </button>`
            )
            .join('')}
        ${
            b.reviewStatus && now !== 'confirmed'
                ? `
          <button type="button" class="ad-btn" data-decide="pending">Back to pending</button>`
                : ''
        }
      </div>

      <p class="ad-actions-h">Payment</p>
      <div class="ad-actions-row">
        ${
            !paid
                ? `
          <button type="button" class="ad-btn ad-btn-primary" data-pay="paid"
                  data-confirm="Mark as paid? If they are on a site this confirms their booking.">
            Mark paid
          </button>
          <button type="button" class="ad-btn" data-pay="free"
                  data-confirm="Let them in for free? If they are on a site this confirms their booking.">
            Free entry
          </button>`
                : `
          <button type="button" class="ad-btn" data-pay="unpaid">Mark unpaid</button>`
        }
      </div>

      ${
          b.status !== 'cancelled'
              ? `
      <h3 class="ad-drawer-h">Not coming?</h3>
      <div class="ad-actions-row">
        <button type="button" class="ad-btn ad-btn-danger" id="ad-cancel-booking"
                data-confirm="Cancel ${attr(vendorName(b))}? They come off the event page and the vendor list${b.siteLabel ? ', and ' + attr(b.siteLabel) + ' is freed' : ''}. No refund is made - do that in Stripe if needed.">
          Not coming &ndash; cancel booking
        </button>
      </div>`
              : '<p class="ad-drawer-text ad-cell-muted">This booking is cancelled.</p>'
      }

      <p class="ad-action-msg" id="ad-action-msg" hidden></p>
    </div>`;
}

/* -------------------------------------------------------------------------
   Seating. Lists the sites this vendor could actually go on: the free ones
   of the right kind, plus whatever they are already holding.
   ------------------------------------------------------------------------- */
function sitePicker(b) {
    const wantType = b.vendorType === 'food' ? 'food' : 'market';
    const theirs = new Set(b.siteIds && b.siteIds.length ? b.siteIds : b.siteId ? [b.siteId] : []);

    const options = state.sites.filter((s) => theirs.has(s.id) || (s.type === wantType && s.status === 'available'));

    if (!options.length && !theirs.size) {
        return `<p class="ad-drawer-text ad-cell-muted">No free ${esc(wantType)} sites left.</p>`;
    }

    return `
    <div class="ad-seat">
      <select id="ad-seat-pick" multiple size="${Math.min(8, Math.max(4, options.length))}"
              aria-label="Sites for this vendor">
        ${options
            .map(
                (s) => `
          <option value="${attr(s.id)}"${theirs.has(s.id) ? ' selected' : ''}>
            ${esc(s.label)}${theirs.has(s.id) ? ' — theirs' : ''}
          </option>`
            )
            .join('')}
      </select>
      <p class="ad-seat-hint">Ctrl or Cmd click for more than one bay.</p>
      <div class="ad-actions-row">
        <button type="button" class="ad-btn ad-btn-primary" id="ad-seat-save">Save sites</button>
        ${
            theirs.size && b.status === 'confirmed'
                ? `
          <button type="button" class="ad-btn" id="ad-seat-tell"
                  data-confirm="Email ${attr(vendorName(b))} the 'Site changed' message (site ${attr(b.siteLabel || '')})?">
            Email: your site has changed
          </button>`
                : ''
        }
        ${
            theirs.size
                ? `
          <button type="button" class="ad-btn" id="ad-seat-free"
                  data-confirm="Take their site away and leave them unseated?">
            Free their site
          </button>`
                : ''
        }
      </div>
    </div>`;
}

function notesBlock(b) {
    const notes = Array.isArray(b.notes) ? [...b.notes] : [];
    notes.sort((x, y) => secs(y.at) - secs(x.at));

    return `
    ${
        notes.length
            ? `
      <ul class="ad-notes">
        ${notes
            .map(
                (n) => `
          <li>
            <p class="ad-note-text">${esc(n.text)}</p>
            <p class="ad-note-by">${esc(n.by || 'staff')} &middot; ${esc(dateShort(n.at))}</p>
          </li>`
            )
            .join('')}
      </ul>`
            : `<p class="ad-drawer-text ad-cell-muted">No notes yet.</p>`
    }

    <form class="ad-note-form" id="ad-note-form">
      <textarea id="ad-note-text" rows="2"
                placeholder="Add a note - staff only, the vendor never sees this"
      >${esc(state.noteDraft)}</textarea>
      <button type="submit" class="ad-btn">Add note</button>
    </form>`;
}

function wireDetail() {
    const close = () => {
        state.openBookingId = null;
        render();
    };

    const btn = document.getElementById('ad-drawer-close');
    if (btn) btn.addEventListener('click', close);

    const scrim = document.getElementById('ad-scrim');
    if (scrim) scrim.addEventListener('click', close);

    const id = state.openBookingId;
    if (!id) return;

    document.querySelectorAll('[data-decide]').forEach((el) => {
        guarded(el, () =>
            runAction(el, 'adminReviewBooking', {
                bookingId: id,
                decision: el.getAttribute('data-decide')
            })
        );
    });

    document.querySelectorAll('[data-pay]').forEach((el) => {
        guarded(el, () =>
            runAction(el, 'adminSetPayment', {
                bookingId: id,
                paymentStatus: el.getAttribute('data-pay')
            })
        );
    });
    const cancelBtn = document.getElementById('ad-cancel-booking');
    guarded(cancelBtn, () => runAction(cancelBtn, 'adminCancelBooking', { bookingId: id }));

    const save = document.getElementById('ad-seat-save');
    if (save)
        save.addEventListener('click', () => {
            const pick = document.getElementById('ad-seat-pick');
            const chosen = [...pick.selectedOptions].map((o) => o.value);
            if (!chosen.length) {
                window.alert('Pick at least one site, or use Free their site.');
                return;
            }
            runAction(save, 'adminAssignSite', { bookingId: id, siteIds: chosen });
        });

    const free = document.getElementById('ad-seat-free');
    guarded(free, () => runAction(free, 'adminAssignSite', { bookingId: id, siteIds: [] }));
    const tell = document.getElementById('ad-seat-tell');
    guarded(tell, () => runAction(tell, 'adminSendSiteChanged', { bookingId: id }));

    const noteForm = document.getElementById('ad-note-form');
    const noteBox = document.getElementById('ad-note-text');

    /*  A vendor saving their own page redraws this one, so a half typed note
      is kept in state and put back rather than vanishing mid-sentence. */
    if (noteBox) {
        noteBox.addEventListener('input', () => {
            state.noteDraft = noteBox.value;
        });
    }

    if (noteForm)
        noteForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const text = noteBox.value.trim();
            if (!text) return;
            state.noteDraft = '';
            await runAction(noteForm.querySelector('button'), 'adminAddNote', { bookingId: id, text });
            const again = document.getElementById('ad-note-text');
            if (again) again.value = '';
        });
}

/*  Escape closes the drawer from anywhere. Registered once, not per render,
    or every redraw would stack another listener. */
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.openBookingId) {
        state.openBookingId = null;
        render();
    }
});
