/* ==========================================================================
   SALES PIPELINE  -  the list of every job, from estimate to paid
   (Max's mock-up, 16 Oct 2026 - replaces the old "Quotes & Invoices" list)

   One row per job. Each job is ONE document that moves through:
     Estimate (draft) -> Quote (approved / sent) -> Payment (invoiced) -> Job (paid)

   Pure functions only - no Firebase, no page state - so this file can be
   tested on its own. admin-app.js passes in the quotes and the helpers
   (esc, attr, money) and wires the clicks.
   ========================================================================== */

import { isBooked, pickProgress } from './stock.js?v=615';

/* which of the 4 steps a job has reached, and how it shows in the list */
const STAGES = {
  draft:     { step: 1, tab: 'estimates', status: ['Estimate', 'grey'],
               next: ['doc', 'orange', 'Review estimate', 'Approve to send to client'] },
  approved:  { step: 2, tab: 'quotes', status: ['Quote ready', 'blue'],
               next: ['send', 'orange', 'Send quote', 'Approved, not sent yet'] },
  sent:      { step: 2, tab: 'quotes', status: ['Quote sent', 'blue'],
               next: ['send', 'blue', 'Waiting on client', 'Quote sent'] },
  accepted:  { step: 3, tab: 'payment', status: ['Accepted', 'amber'],
               next: ['dollar', 'amber', 'Awaiting payment', 'Deposit outstanding'] },
  invoiced:  { step: 3, tab: 'payment', status: ['Invoice - unpaid', 'amber'],
               next: ['dollar', 'amber', 'Awaiting payment', 'Deposit outstanding'] },
  paid:      { step: 4, tab: 'confirmed', status: ['Confirmed', 'green'],
               next: ['cal', 'green', 'Job ready', 'Paid in full'] },
  declined:  { step: 2, tab: 'archived', status: ['Declined', 'red'],
               next: ['doc', 'grey', 'Archived', 'Customer declined'] },
  cancelled: { step: 1, tab: 'archived', status: ['Cancelled', 'grey'],
               next: ['doc', 'grey', 'Archived', 'Cancelled'] },
};

/* Delete forever is only for estimates / quotes with no money and no invoice
   number - tax invoices must be kept (ATO: 5 years), so those get Archive. */
export function canDelete(q) {
  return ['draft', 'approved', 'sent', 'declined', 'cancelled'].includes(q.status)
    && !q.invoiceNumber && !(q.amountPaidCents > 0) && q.kind !== 'invoice';
}

/*  LATE PAYMENT CHARGE DUE? (Max, 20 Oct 2026) - same rule as lateFeeState()
    in functions/index.js: unpaid more than 28 days after the due date (7 days
    before the event), then every further full month. Returns the next 2%
    amount in cents, or 0.                                                  */
function isoAdd(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10);
}
export function lateFeeDue(q) {
  const owing = Math.round(q.totalCents || 0) + Math.round(q.lateFeeCents || 0) - Math.round(q.amountPaidCents || 0);
  if (owing <= 0 || q.vendor || q.status === 'cancelled' || q.status === 'declined' || q.paymentStatus === 'paid') return 0;
  if (!(q.kind === 'invoice' || ['accepted', 'invoiced'].includes(q.status))) return 0;
  const due = isoAdd(q.hire && q.hire.startDate, -7);
  if (!due) return 0;
  const first = isoAdd(due, 29);   // more than 28 days after the due date
  const now = new Date();
  const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  if (today < first) return 0;
  const [fy, fm, fd] = first.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  const allowed = 1 + Math.max(0, (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0));
  return allowed > (q.lateFees || []).length ? Math.round(owing * 0.02) : 0;
}

export function stageOf(q) {
  /*  A vendor's tax invoice (Max, 19 Oct 2026): always paid, and has its own
      Vendors tab so it never counts as a job for the crew.               */
  if (q.vendor) {
    return { step: 4, tab: 'vendors', status: ['Paid', 'green'],
             next: ['doc', 'green', 'Invoice issued', q.emailedAt ? 'Emailed to vendor' : 'Not emailed yet'] };
  }
  const s = STAGES[q.status] || STAGES.draft;
  // payment detail for jobs waiting on money
  const pp = isBooked(q) && q.crewToken ? pickProgress(q) : null;
  const packing = pp && pp.lines ? (pp.returned === pp.lines ? 'All gear back in' : pp.packed ? pp.packed + ' of ' + pp.lines + ' packed' : 'Pick list ready') : '';
  if (s.step === 4) return packing ? { ...s, next: [s.next[0], s.next[1], s.next[2], packing] } : s;
  if (s.step === 3) {
    let sub = 'Deposit outstanding';
    if (q.paymentStatus === 'deposit') sub = 'Final payment due' + (packing ? ' · ' + packing : '');
    else if (q.paymentStatus === 'bank') sub = 'Bank transfer expected';
    const late = lateFeeDue(q);
    if (late) return { ...s, next: ['dollar', 'red', 'Late fee due', 'Add 2% ($' + (late / 100).toFixed(2) + ') from the menu'] };
    return { ...s, next: [s.next[0], s.next[1], s.next[2], sub] };
  }
  return s;
}

/* the tabs along the top: [key, label, which jobs] */
export const TABS = [
  ['all', 'All', (q) => stageOf(q).tab !== 'archived'],
  ['action', 'Needs action', (q) => q.status === 'draft' || q.status === 'approved'],
  ['estimates', 'Estimates', (q) => stageOf(q).tab === 'estimates'],
  ['quotes', 'Quotes', (q) => stageOf(q).tab === 'quotes'],
  ['payment', 'Awaiting payment', (q) => stageOf(q).tab === 'payment'],
  ['confirmed', 'Jobs confirmed', (q) => stageOf(q).tab === 'confirmed'],
  ['vendors', 'Vendors', (q) => !!q.vendor],
  ['archived', 'Archived', (q) => stageOf(q).tab === 'archived'],
];

/* small line icons for the "next step" pills and the stat cards */
const ICON = {
  doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
  send: '<path d="M21 3 3 10.5l7 2.5 2.5 7z"/><path d="M10 13 21 3"/>',
  dollar: '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.8 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6.5v11"/>',
  cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
};
const svg = (k) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[k] + '</svg>';

/* "2026-10-20" -> sortable number; text dates fall back to the creation date */
function eventSortKey(q) {
  const iso = q.hire && q.hire.startDate;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return Date.parse(iso + 'T00:00:00');
  return 0;
}
function eventDateText(q) {
  const t = eventSortKey(q);
  if (t) return new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  return (q.customer && q.customer.eventDate) || '';
}
function createdKey(q) {
  const c = q.createdAt;
  if (!c) return 0;
  if (typeof c === 'number') return c;
  if (c.seconds != null) return c.seconds * 1000;
  if (typeof c.toMillis === 'function') return c.toMillis();
  return 0;
}

/* search + tab + date filter + sort, all from the view's filter state */
export function filterJobs(jobs, f) {
  const tab = TABS.find((t) => t[0] === f.tab) || TABS[0];
  const words = String(f.search || '').toLowerCase().split(/\s+/).filter(Boolean);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const today = now.getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();

  let out = jobs.filter(tab[2]).filter((q) => {
    if (words.length) {
      const c = q.customer || {};
      const hay = [c.name, c.business, c.email, c.eventName, c.eventType, q.number, q.invoiceNumber]
        .join(' ').toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    const t = eventSortKey(q);
    if (f.dates === 'upcoming') return t >= today;
    if (f.dates === 'month') return t >= monthStart && t < monthEnd;
    if (f.dates === 'past') return t && t < today;
    return true;
  });

  const dir = f.sortDir === 'asc' ? 1 : -1;
  const by = {
    customer: (q) => String((q.customer && (q.customer.name || q.customer.business)) || '').toLowerCase(),
    total: (q) => q.totalCents || 0,
    date: (q) => eventSortKey(q),
    status: (q) => stageOf(q).step,
    created: (q) => createdKey(q),
  }[f.sort || 'created'] || ((q) => createdKey(q));
  out = out.slice().sort((a, b) => {
    const x = by(a), y = by(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
  return out;
}

export function counts(jobs) {
  const n = {};
  TABS.forEach(([k, , test]) => { n[k] = jobs.filter(test).length; });
  return n;
}

/* the whole view (header, stat cards, tabs, empty table body) */
export function pipelineHtml(jobs, f, h) {
  const n = counts(jobs);
  const stat = (tab, icon, tone, num, title, sub) => `
    <button type="button" class="sp-stat" data-sp-tab="${tab}">
      <span class="sp-stat-ico sp-${tone}">${svg(icon)}</span>
      <span><b>${num}</b><strong>${title}</strong><em>${sub}</em></span>
    </button>`;
  const withClient = jobs.filter((q) => q.status === 'approved' || q.status === 'sent').length;
  const head = (key, label) => {
    const on = f.sort === key;
    return `<th><button type="button" class="sp-sort${on ? ' is-on' : ''}" data-sp-sort="${key}">${label}
      <span aria-hidden="true">${on ? (f.sortDir === 'asc' ? '&#8593;' : '&#8595;') : '&#8645;'}</span></button></th>`;
  };
  const dateOpt = (v, l) => `<option value="${v}"${f.dates === v ? ' selected' : ''}>${l}</option>`;
  return `
    <div class="sp">
      <div class="sp-top">
        <div>
          <h1>Sales Pipeline</h1>
          <p>From enquiry to paid and job ready</p>
        </div>
        <label class="sp-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
          <input type="search" id="sp-search" placeholder="Search quotes, customers or events…" value="${h.attr(f.search || '')}">
        </label>
        <button type="button" class="ad-btn ad-btn-primary sp-new" id="q-new">+ New quote</button>
      </div>

      <div class="sp-stats">
        ${stat('estimates', 'doc', 'orange', n.estimates, 'Need review', 'Estimates waiting for approval')}
        ${stat('quotes', 'send', 'blue', withClient, 'With client', 'Quotes sent or awaiting acceptance')}
        ${stat('payment', 'dollar', 'amber', n.payment, 'Awaiting payment', 'Deposit or payment outstanding')}
        ${stat('confirmed', 'cal', 'green', n.confirmed, 'Jobs confirmed', 'Paid and ready for crew')}
      </div>

      <div class="sp-bar">
        <div class="sp-tabs" role="tablist">
          ${TABS.map(([k, label]) => `<button type="button" role="tab" class="sp-tab${f.tab === k ? ' is-on' : ''}" data-sp-tab="${k}">${label}${k === 'archived' ? '' : ' (' + n[k] + ')'}</button>`).join('')}
        </div>
        <select id="sp-dates" class="ad-select sp-dates" aria-label="Event dates">
          ${dateOpt('all', 'All dates')}${dateOpt('upcoming', 'Upcoming')}${dateOpt('month', 'This month')}${dateOpt('past', 'Past')}
        </select>
      </div>

      ${vendorSendBar(jobs, h)}
      <div class="sp-table-wrap">
        <table class="sp-table">
          <thead><tr>
            ${head('customer', 'Customer / event')}
            ${head('date', 'Event date')}
            <th>Progress</th>
            <th>Next step</th>
            ${head('total', 'Total')}
            <th></th>
          </tr></thead>
          <tbody id="q-rows"></tbody>
        </table>
      </div>
    </div>`;
}

/*  VENDOR INVOICES NOT EMAILED YET (Max, 19 Oct 2026): one button sends
    every paid vendor their invoice & event guide (asks first).          */
function vendorSendBar(jobs, h) {
  const unsent = jobs.filter((q) => q.vendor && !q.emailedAt).length;
  if (!unsent) return '';
  return `<div class="sp-vendor-send"><span><b>${unsent} vendor${unsent === 1 ? '' : 's'}</b> haven&rsquo;t been emailed their invoice &amp; event guide yet.</span>
    <button type="button" class="ad-btn ad-btn-primary" data-sp-sendall>Email all ${unsent}</button></div>`;
}

/* the table rows */
export function rowsHtml(rows, f, h) {
  if (!rows.length) {
    const msg = f.search ? 'Nothing matches that search.' : 'Nothing here yet. Hit &ldquo;New quote&rdquo; to start one.';
    return `<tr><td colspan="6" class="sp-empty">${msg}</td></tr>`;
  }
  const steps = ['Estimate', 'Quote', 'Payment', 'Job'];
  return rows.map((q) => {
    const st = stageOf(q);
    const c = q.customer || {};
    const num = q.kind === 'invoice' && q.invoiceNumber ? q.invoiceNumber : q.number;
    const progress = steps.map((label, i) => {
      const done = i < st.step;
      const cls = done ? (st.step === 4 ? ' is-done is-green' : ' is-done') : '';
      return `<span class="sp-step${cls}"><b>${done ? '&#10003;' : ''}</b><em>${label}</em></span>`;
    }).join('');
    const [ico, tone, nTitle, nSub] = st.next;
    if (q.vendor) {
      return `
      <tr data-open-q="${h.attr(q.id)}">
        <td class="sp-cust">
          <strong>${h.esc(c.name || 'Vendor')}<span class="ad-bot-tag">Vendor</span></strong>
          <span>${h.esc(c.eventName || '')}${q.invoiceNumber ? ' <i>' + h.esc(q.invoiceNumber) + '</i>' : ''}</span>
        </td>
        <td class="sp-date">${h.esc(eventDateText(q) || '—')}</td>
        <td><div class="sp-progress sp-off" title="Not used for vendors">${progress}</div></td>
        <td><span class="sp-next sp-${tone}">${svg(ico)}<span><b>${h.esc(nTitle)}</b><em>${h.esc(nSub)}</em></span></span></td>
        <td class="sp-total">${h.esc(h.money(q.totalCents || 0))}</td>
        <td class="sp-act">
          <button type="button" class="sp-view">View</button>
          <details class="sp-more" data-no-open>
            <summary aria-label="More"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
            <div class="sp-menu">
              <button type="button" data-sp-vendor="view" data-id="${h.attr(q.id)}">Open invoice &amp; event guide</button>
              <button type="button" data-sp-vendor="copy" data-id="${h.attr(q.id)}">Copy vendor link</button>
              <button type="button" data-sp-vendor="test" data-id="${h.attr(q.id)}">Email test to me</button>
            </div>
          </details>
        </td>
      </tr>`;
    }
    return `
      <tr data-open-q="${h.attr(q.id)}">
        <td class="sp-cust">
          <strong>${h.esc(c.name || c.business || 'No name yet')}${q.source === 'bot' ? '<span class="ad-bot-tag">Bot</span>' : ''}${q.detailsReceivedAt && ['draft', 'approved'].includes(q.status) ? '<span class="ad-bot-tag sp-details-tag">Details in</span>' : ''}</strong>
          <span>${h.esc(c.eventName || c.eventType || '')}${num ? ' <i>' + h.esc(num) + '</i>' : ''}</span>
        </td>
        <td class="sp-date">${h.esc(eventDateText(q) || '—')}</td>
        <td><div class="sp-progress">${progress}</div></td>
        <td><span class="sp-next sp-${tone}">${svg(ico)}<span><b>${h.esc(nTitle)}</b><em>${h.esc(nSub)}</em></span></span></td>
        <td class="sp-total">${h.esc(h.money((q.totalCents || 0) + (q.lateFeeCents || 0)))}${q.lateFeeCents ? '<span class="sp-late">incl. late fees</span>' : ''}</td>
        <td class="sp-act">
          <button type="button" class="sp-view">View</button>
          <details class="sp-more" data-no-open>
            <summary aria-label="More"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
            <div class="sp-menu">
              ${lateFeeDue(q) ? `<button type="button" data-sp-act="latefee" data-id="${h.attr(q.id)}">Add 2% late fee ($${(lateFeeDue(q) / 100).toFixed(2)})</button>` : ''}
              ${(q.lateFees || []).length ? `<button type="button" data-sp-act="unlatefee" data-id="${h.attr(q.id)}">Remove last late fee</button>` : ''}
              ${q.token ? `<a href="/quote?t=${h.attr(q.token)}" target="_blank" rel="noopener">Open customer page</a>
              <button type="button" data-sp-copy="${h.attr('https://www.soundzgood.com.au/quote?t=' + q.token)}">Copy customer link</button>` : '<span>Save it first to get a link</span>'}
              ${q.token ? `<a href="/quote?t=${h.attr(q.token)}&print=1" target="_blank" rel="noopener">Download PDF</a>` : ''}
              ${isBooked(q)
                ? (q.crewToken
                  ? `<a href="/picklist?t=${h.attr(q.crewToken)}" target="_blank" rel="noopener">Open pick list</a>
              <button type="button" data-sp-copy="${h.attr('https://www.soundzgood.com.au/picklist?t=' + q.crewToken)}">Copy crew link</button>`
                  : `<button type="button" data-sp-act="picklist" data-id="${h.attr(q.id)}">Make pick list</button>`)
                + `<button type="button" data-sp-act="gearlist" data-id="${h.attr(q.id)}">Email gear list (no prices)</button>`
                : (['approved', 'sent', 'accepted', 'invoiced'].includes(q.status) ? `<button type="button" data-sp-act="deposit" data-id="${h.attr(q.id)}">Deposit received</button>` : '')}
              ${['approved', 'sent', 'accepted', 'invoiced'].includes(q.status) ? `<button type="button" data-sp-act="paid" data-id="${h.attr(q.id)}">Mark paid</button>` : ''}
              ${(isBooked(q) || q.paymentStatus) && q.paymentMethod !== 'card' && !(q.stripeSessions && q.stripeSessions.length) ? `<button type="button" data-sp-act="undopay" data-id="${h.attr(q.id)}">Undo deposit / payment</button>` : ''}
              <button type="button" data-sp-act="duplicate" data-id="${h.attr(q.id)}">Duplicate</button>
              ${st.tab === 'archived'
                ? `<button type="button" data-sp-act="restore" data-id="${h.attr(q.id)}">Restore</button>`
                : `<button type="button" data-sp-act="archive" data-id="${h.attr(q.id)}">Archive</button>`}
              ${canDelete(q) || st.tab === 'archived' ? `<button type="button" class="sp-danger" data-sp-act="delete" data-id="${h.attr(q.id)}">Delete forever</button>` : ''}
            </div>
          </details>
        </td>
      </tr>`;
  }).join('');
}

/* the clicks: tabs, stat cards, sort headers, search, dates, copy link,
   and opening a job. f is the view's filter state (kept by the caller so it
   survives re-renders). act = { open(id), newQuote(), duplicate(id),
   archive(id), restore(id), del(id), paid(id) } - the admin page does the real work. */
export function wirePipeline(getJobs, f, h, act) {
  const body = document.getElementById('q-rows');
  const paint = () => { if (body) body.innerHTML = rowsHtml(filterJobs(getJobs(), f), f, h); };
  const repaintAll = () => {
    const root = document.querySelector('.sp');
    if (!root) return;
    const fresh = document.createElement('div');
    fresh.innerHTML = pipelineHtml(getJobs(), f, h);
    root.replaceWith(fresh.firstElementChild);
    wirePipeline(getJobs, f, h, act);
  };
  paint();

  const root = document.querySelector('.sp');
  if (!root) return;
  root.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-sp-tab]');
    if (tab) { f.tab = tab.getAttribute('data-sp-tab'); repaintAll(); return; }
    const sort = e.target.closest('[data-sp-sort]');
    if (sort) {
      const k = sort.getAttribute('data-sp-sort');
      if (f.sort === k) f.sortDir = f.sortDir === 'asc' ? 'desc' : 'asc';
      else { f.sort = k; f.sortDir = k === 'customer' ? 'asc' : 'desc'; }
      repaintAll();
      return;
    }
    const copy = e.target.closest('[data-sp-copy]');
    if (copy) {
      const link = copy.getAttribute('data-sp-copy');
      (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
        .then(() => { copy.textContent = 'Copied!'; })
        .catch(() => { window.prompt('Copy the customer link:', link); });
      return;
    }
    const sa = e.target.closest('[data-sp-sendall]');
    if (sa) { act.sendAllVendors(sa); return; }
    const vb = e.target.closest('[data-sp-vendor]');
    if (vb) { act.vendorInvoice(vb.getAttribute('data-id'), vb.getAttribute('data-sp-vendor'), vb); return; }
    const a = e.target.closest('[data-sp-act]');
    if (a) {
      const fn = { duplicate: act.duplicate, archive: act.archive, restore: act.restore, delete: act.del, paid: act.paid, deposit: act.deposit, picklist: act.picklist, undopay: act.undopay, latefee: act.latefee, unlatefee: act.unlatefee, gearlist: act.gearlist }[a.getAttribute('data-sp-act')];
      if (fn) fn(a.getAttribute('data-id'));
      return;
    }
    if (e.target.closest('[data-no-open]')) return;   // the ⌄ menu
    if (e.target.closest('#q-new')) { act.newQuote(); return; }
    const row = e.target.closest('[data-open-q]');
    if (row) {
      const id = row.getAttribute('data-open-q');
      if (id.startsWith('vendor:')) act.vendorInvoice(id, 'view');
      else act.open(id);
    }
  });
  const search = document.getElementById('sp-search');
  if (search) search.addEventListener('input', () => { f.search = search.value; paint(); });
  const dates = document.getElementById('sp-dates');
  if (dates) dates.addEventListener('change', () => { f.dates = dates.value; paint(); });
  // close any open ⌄ menu when clicking elsewhere (added once)
  if (!window.__spMenuCloser) window.__spMenuCloser = true, document.addEventListener('click', (e) => {
    document.querySelectorAll('.sp-more[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  });
}
