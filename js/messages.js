/* ==========================================================================
   MESSAGES  -  admin page  (Max, 19 Oct 2026)        step 1: Vendors tab

   Replaces the old "Vendor Email Template" page. Emails are sorted by WHO
   they go to (tabs) and then by WHEN they go (rows). Each row shows
   When | Subject | Who | Status | Sent.

   Status:  Draft      still being written
            Your OK    complete - waiting for Max to approve
            Auto       approved - sends itself at 9:35 am on its day
            Paused / Cancelled / Sent

   NOTHING SENDS UNTIL MAX APPROVES IT. Editing an approved message puts it
   back to "Your OK". The server does the sending (functions/index.js,
   MESSAGES section); this page only shows, edits and approves.

   ctx = { state, h: { esc, attr }, call, render, money }
   ========================================================================== */

import { SPONSOR_LEVELS, SPONSOR_GOAL_CENTS, PAST_SPONSORS, SUGGESTED_SPONSORS, NEEDS_EMAIL } from './sponsor-data.js?v=629';

export const SEND_TIME = '9:35 am';

/*  The fields a message can use - KEEP IN STEP with fieldsFor() in
    functions/lib/message-email.js.                                      */
const FIELDS = [
  ['vendor_name', 'Contact name'],
  ['business_name', 'Business name'],
  ['site_number', 'Site number'],
  ['event_name', 'Event name'],
  ['event_date', 'Event date'],
  ['event_venue', 'Venue'],
];
const INVOICE_FIELDS = [['total_paid', 'Total paid'], ['invoice_number', 'Invoice number']];
const WAITLIST_FIELDS = [['expires_at', 'Hold ends (4 hours)']];

const STATUS = {
  draft: ['Draft', 'grey'],
  review: ['Your OK', 'amber'],
  approved: ['Auto', 'green'],
  paused: ['Paused', 'blue'],
  cancelled: ['Cancelled', 'grey'],
  sent: ['Sent', 'green'],
};

const WHO = { all: 'All paid vendors', food: 'Food vendors', market: 'Market stalls' };
const WHO_SHORT = { all: 'paid vendors', food: 'food vendors', market: 'market stalls' };

/*  EMAILS ALREADY GOING OUT TO CLIENTS (shown so everything is in one place).
    Their wording still lives in the server for now (functions/lib/quote-email.js
    and quote-doc-email.js) - they become editable in step 2.             */
const CLIENT_EMAILS = [   // [when, name, subject, who, status, preview key]
  ['When they finish the website quote bot', 'Instant estimate', 'Your SoundzGood estimate - (event type)', 'The person who used the bot', 'Auto', 'estimate'],
  ['When you press Send on a quote', 'Quote ready', 'Your quote SG-Q-0000 from SoundzGood', 'That client (and their CC email)', 'You send it', 'quote'],
  ['When you press Send on an invoice', 'Invoice ready', 'Your invoice SG-I-0000 from SoundzGood', 'That client (and their CC email)', 'You send it', 'invoice'],
  ['When you email a lead from the Lead Generator', 'Lead outreach', 'You write it each time', 'That business', 'You send it', 'lead'],
];

/* ---------- small helpers ---------- */
function addDaysISO(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10);
}
/*  Same rule as messageSendDate() on the server. */
function sendDate(msg, ev) {
  const t = msg.trigger || {};
  const days = Math.max(0, Math.round(Number(t.days) || 0));
  if (t.type === 'daysBefore') return addDaysISO(ev.dateISO, -days);
  if (t.type === 'daysAfter') return addDaysISO(ev.dateISO, days);
  if (t.type === 'date') return t.date || '';
  return '';
}
function niceDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
}
function whenText(msg, ev) {
  const t = msg.trigger || {};
  if (t.type === 'payment') return 'As each vendor pays';
  if (t.type === 'waitlist') return 'When a spot opens';
  if (t.type === 'manual') return 'When you press Send';
  if (t.type === 'sponsorFollowup') return (t.days || 7) + ' days after the ask';
  const day = niceDay(sendDate(msg, ev));
  const n = Math.round(Number(t.days) || 0);
  const rel = t.type === 'daysBefore' ? (n === 1 ? 'Day before' : n + ' days before')
    : t.type === 'daysAfter' ? (n === 1 ? 'Day after' : n + ' days after')
    : t.type === 'date' ? 'On a date' : 'Not set';
  return rel + (day ? ' · ' + day : '');
}
function paidVendors(bookings, eventId) {
  return (bookings || []).filter((b) => b.eventId === eventId
    && (b.status === 'confirmed' || b.paymentStatus === 'paid' || b.paymentStatus === 'free')
    && b.status !== 'cancelled' && b.business && b.business.email);
}
/*  Same filter as messageRecipients() on the server. */
function recipients(bookings, eventId, msg) {
  return paidVendors(bookings, eventId).filter((b) => {
    if (msg.who === 'food' && b.vendorType !== 'food') return false;
    if (msg.who === 'market' && b.vendorType !== 'market') return false;
    if (msg.promo && b.promoOptOut) return false;
    return true;
  });
}

/* ---------- preview: KEEP IN STEP with bodyHtml() in functions/lib/message-email.js ---------- */
function fill(text, values, clean) {
  return String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key) => {
    const v = values[key.toLowerCase()];
    return v === undefined ? whole : clean(v);
  });
}
function linkify(html) {
  return html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}
function bodyHtml(body, values, esc) {
  return String(body || '').replace(/\r/g, '').split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) return '';
    if (lines.every((l) => /^\s*-\s+/.test(l))) {
      return '<ul>' + lines.map((l) => '<li>' + linkify(fill(esc(l.replace(/^\s*-\s+/, '')), values, esc)) + '</li>').join('') + '</ul>';
    }
    return '<p>' + lines.map((l) => linkify(fill(esc(l), values, esc))).join('<br>') + '</p>';
  }).join('');
}
function sampleValues(b, ev) {
  const biz = (b && b.business) || {};
  return {
    vendor_name: biz.contactName || biz.name || 'Jess',
    business_name: biz.name || 'Sample Business',
    site_number: (b && b.siteLabel) || 'F4',
    event_name: ev.name || 'Your event',
    event_date: ev.dateLabel || ev.dateISO || '',
    event_venue: [ev.venue, ev.location].filter(Boolean).join(', '),
    total_paid: '$' + ((((b && (b.totalCents != null ? b.totalCents : b.amountCents)) || 11549) / 100).toFixed(2)),
    invoice_number: (b && b.invoiceNumber) || 'SG-I-0000',
  };
}

/*  The plain sentence at the top of a message. */
function sentenceHtml(ctx, d, m, ev) {
  const { state } = ctx;
  const esc = ctx.h.esc;
  if (m.system === 'sponsor-ask') {
    return `This sends <b>&ldquo;${esc(fill(d.subject, sampleValues(null, ev), String) || '(no subject yet)')}&rdquo;</b> to the businesses you tick on the <b>Sponsors</b> tab, when you press Send.`;
  }
  if (m.system === 'sponsor-followup') {
    return `This sends <b>&ldquo;${esc(fill(d.subject, sampleValues(null, ev), String) || '(no subject yet)')}&rdquo;</b> to any business still &ldquo;Asked&rdquo; <b>7 days after the ask</b>, at ${SEND_TIME}. Anyone who replied or said yes or no is skipped.`;
  }
  if (m.system === 'waitlist') {
    return `This sends <b>&ldquo;${esc(fill(d.subject, sampleValues(null, ev), String) || '(no subject yet)')}&rdquo;</b> to <b>the next person on the waitlist</b> the moment a spot opens. They get <b>4 hours</b> to accept or decline from the email, then it goes to the next person.`;
  }
  if (m.system) {
    const all = paidVendors(state.bookings, state.activeEventId);
    return `This sends <b>&ldquo;${esc(fill(d.subject, sampleValues(all[0], ev), String) || '(no subject yet)')}&rdquo;</b> to <b>each vendor the moment they pay</b>. ${all.filter((b) => b.invoiceEmailedAt).length} of ${all.length} paid vendors have it.`;
  }
  const list = recipients(state.bookings, state.activeEventId, d);
  const day = sendDate(d, ev);
  return `This sends <b>&ldquo;${esc(fill(d.subject, sampleValues(list[0], ev), String) || '(no subject yet)')}&rdquo;</b> to <b>${list.length} ${esc(WHO_SHORT[d.who] || WHO_SHORT.all)}</b>`
    + (day ? ` on <b>${esc(niceDay(day))} at ${SEND_TIME}</b>.` : ' &mdash; <b>pick when</b>.');
}

/* ---------- the draft being edited ---------- */
function blankMessage() {
  return { name: '', subject: '', body: '', who: 'all', promo: false, trigger: { type: 'daysBefore', days: 7, date: '' } };
}
function draftFrom(m) {
  return {
    name: m.name || '', subject: m.subject || '', body: m.body || '', who: m.who || 'all', promo: !!m.promo,
    trigger: { type: (m.trigger && m.trigger.type) || 'daysBefore', days: (m.trigger && m.trigger.days) || 0, date: (m.trigger && m.trigger.date) || '' },
  };
}
function sameDraft(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/* ==========================================================================
   HTML
   ========================================================================== */
export function messagesHtml(ctx) {
  const { state, h } = ctx;
  const ev = (state.events || []).find((e) => e.id === state.activeEventId) || {};
  if (!state.activeEventId) return '<div class="ms"><p class="ad-cell-muted">Choose an event at the top first.</p></div>';
  if (state.msgOpen) return editorHtml(ctx, ev);

  const tab = state.msgTab || 'vendors';
  const list = (state.messages || []).filter((m) => m.audience !== 'sponsors').slice().sort((a, b) => {
    const rank = (x) => (x.system === 'invoice' ? 0 : x.system === 'waitlist' ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (sendDate(a, ev) || '9999').localeCompare(sendDate(b, ev) || '9999');
  });
  const rows = list.map((m) => {
    const [label, tone] = STATUS[m.status] || STATUS.draft;
    const wl = m.system === 'waitlist';
    const total = wl ? (state.waitlist || []).length : (m.system ? paidVendors(state.bookings, state.activeEventId).length : recipients(state.bookings, state.activeEventId, m).length);
    const sent = wl ? (m.sentCount || 0) : (m.system
      ? paidVendors(state.bookings, state.activeEventId).filter((b) => b.invoiceEmailedAt).length
      : (m.sentCount || 0));
    const failed = (m.failed || []).length;
    return `<tr data-ms-open="${h.attr(m.id)}">
      <td class="ms-when">${h.esc(whenText(m, ev))}</td>
      <td><strong>${h.esc(m.name || '(no name)')}</strong><span class="ms-sub">${h.esc(fill(m.subject || '', { event_name: ev.name || '', event_date: ev.dateLabel || '' }, String))}</span></td>
      <td>${h.esc(wl ? 'Next on the waitlist' : (m.system ? 'Each vendor as they pay' : (WHO[m.who] || WHO.all)))}${m.promo ? ' <span class="ms-tag">Promo</span>' : ''}</td>
      <td><span class="ms-chip ms-${tone}">${h.esc(label)}</span></td>
      <td class="ms-sent">${wl ? sent + ' offer' + (sent === 1 ? '' : 's') : sent + ' of ' + total}${failed ? ` <span class="ms-fail">${failed} failed</span>` : ''}</td>
    </tr>`;
  }).join('');

  return `<div class="ms">
    <div class="ms-head">
      <div>
        <h1>Messages</h1>
        <p>Emails for <b>${h.esc(ev.name || 'this event')}</b>. Nothing sends until you approve it &mdash; approved emails go at ${SEND_TIME} on their day.</p>
      </div>
      <button type="button" class="ad-btn ad-btn-primary" data-ms-new>+ New message</button>
    </div>
    <div class="ms-tabs" role="tablist">
      <button type="button" class="ms-tab${tab === 'vendors' ? ' is-on' : ''}" role="tab" data-ms-tab="vendors">Vendors</button>
      <button type="button" class="ms-tab${tab === 'clients' ? ' is-on' : ''}" role="tab" data-ms-tab="clients">Clients</button>
      <button type="button" class="ms-tab" disabled title="Coming soon">Crew &amp; performers</button>
      <button type="button" class="ms-tab${tab === 'sponsors' ? ' is-on' : ''}" role="tab" data-ms-tab="sponsors">Sponsors</button>
      <button type="button" class="ms-tab ms-tab-log${tab === 'sent' ? ' is-on' : ''}" role="tab" data-ms-tab="sent">Sent emails</button>
    </div>
    ${tab === 'sent' ? sentHtml(ctx) : tab === 'sponsors' ? sponsorsHtml(ctx) : tab === 'clients' ? clientsHtml(h, state) : `<div class="ad-card ms-card">
      <table class="ms-table">
        <thead><tr><th>When</th><th>Message &amp; subject</th><th>Who</th><th>Status</th><th>Sent</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="ad-cell-muted">${state.msgSeeding ? 'Adding the starter messages&hellip;' : 'No messages yet.'}</td></tr>`}</tbody>
      </table>
    </div>
    <p class="ms-key">You also get an office copy of every new vendor booking at info@soundzgood.com.au.</p>
    ${waitlistHtml(ctx)}`}
    <p class="ms-key"><span class="ms-chip ms-grey">Draft</span> still being written &nbsp; <span class="ms-chip ms-amber">Your OK</span> ready &mdash; needs your approval &nbsp; <span class="ms-chip ms-green">Auto</span> approved, sends itself</p>
  </div>`;
}

/*  SENT EMAILS: everything the system has sent, newest first. Click one to
    see exactly what went (Max, 20 Oct 2026). Filled by functions/lib/mail-log.js. */
const KIND = {
  quote: 'Quote / invoice', estimate: 'Bot estimate', 'vendor-invoice': 'Vendor invoice', message: 'Message',
  lead: 'Lead outreach', 'office-copy': 'Office copy', 'vendor-confirmation': 'Vendor confirmation', email: 'Email',
};
function whenSent(at) {
  const ms = at && (at.seconds != null ? at.seconds * 1000 : (typeof at.toMillis === 'function' ? at.toMillis() : 0));
  if (!ms) return '';
  return new Date(ms).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
function sentHtml(ctx) {
  const { state, h } = ctx;
  if (!state.emailLog) return '<div class="ad-card ms-card ms-pad"><p class="ad-cell-muted">Loading sent emails&hellip;</p></div>';
  const q = String(state.emailLogFilter || '').toLowerCase();
  const rows = state.emailLog.filter((m) => !q || [m.to, m.cc, m.subject, KIND[m.kind]].join(' ').toLowerCase().includes(q));
  const open = state.emailLog.find((m) => m.id === state.emailLogOpen);
  return `<div class="ms-log-bar">
      <input type="search" class="ad-input" data-ms-logq placeholder="Search by email, subject or type&hellip;" value="${h.attr(state.emailLogFilter || '')}">
      <button type="button" class="ad-btn" data-ms-logrefresh>Refresh</button>
    </div>
    <div class="ms-log-grid${open ? ' has-open' : ''}">
      <div class="ad-card ms-card"><table class="ms-table">
        <thead><tr><th>When</th><th>To</th><th>Subject</th><th>Type</th><th>Status</th></tr></thead>
        <tbody>${rows.map((m) => `<tr data-ms-log="${h.attr(m.id)}"${open && open.id === m.id ? ' class="is-sel"' : ''}>
          <td class="ms-when">${h.esc(whenSent(m.at))}</td>
          <td>${h.esc(m.to)}${m.cc ? '<span class="ms-sub">cc ' + h.esc(m.cc) + '</span>' : ''}</td>
          <td>${h.esc(m.subject)}</td>
          <td>${h.esc(KIND[m.kind] || m.kind)}</td>
          <td>${m.test ? '<span class="ms-chip ms-blue">Test</span>' : (m.ok ? '<span class="ms-chip ms-green">Sent</span>' : '<span class="ms-chip ms-red" title="' + h.attr(m.error || '') + '">Failed</span>')}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="ad-cell-muted">No emails logged yet - they appear here from now on.</td></tr>'}</tbody>
      </table></div>
      ${open ? `<aside class="ad-card ms-card ms-pad ms-log-view">
        <button type="button" class="ms-back" data-ms-logclose>&times; Close</button>
        <p class="ms-log-meta"><b>${h.esc(open.subject)}</b><br>To: ${h.esc(open.to)}${open.cc ? '<br>CC: ' + h.esc(open.cc) : ''}${open.bcc ? '<br>Copy: ' + h.esc(open.bcc) : ''}<br>${h.esc(whenSent(open.at))}${open.ok ? '' : '<br><span class="ms-fail">Failed: ' + h.esc(open.error || '') + '</span>'}</p>
        <iframe class="ms-log-frame" id="ms-log-frame" title="Email"></iframe>
      </aside>` : ''}
    </div>`;
}

/*  SPONSORS (Max, 20 Oct 2026): the two sponsor emails, the $10k goal, and the
    list of businesses - add from the Lead Generator, by hand or past sponsors;
    tick and Send; track Asked / Interested / Yes / No.                    */
const SP_STATUS = {
  todo: ['To ask', 'grey'], asked: ['Asked', 'blue'], interested: ['Interested', 'amber'], yes: ['Yes!', 'green'], no: ['No', 'grey'],
};
const LEVEL = Object.fromEntries(SPONSOR_LEVELS.map((l) => [l.key, l]));
const money0 = (c) => '$' + Math.round((c || 0) / 100).toLocaleString('en-AU');
function sponsorCents(p) {
  if (p.amountCents) return p.amountCents;
  return (LEVEL[p.level] && LEVEL[p.level].priceCents) || 0;
}
function sponsorsHtml(ctx) {
  const { state, h } = ctx;
  const list = (state.sponsors || []).slice().sort((a, b) => (a.business || '').localeCompare(b.business || ''));
  const msgs = (state.messages || []).filter((m) => m.audience === 'sponsors')
    .sort((a, b) => (a.system === 'sponsor-ask' ? -1 : 1) - (b.system === 'sponsor-ask' ? -1 : 1));
  const yes = list.filter((p) => p.status === 'yes').reduce((t, p) => t + sponsorCents(p), 0);
  const maybe = list.filter((p) => p.status === 'interested').reduce((t, p) => t + sponsorCents(p), 0);
  const pct = Math.min(100, Math.round(yes / SPONSOR_GOAL_CENTS * 100));
  const pct2 = Math.min(100 - pct, Math.round(maybe / SPONSOR_GOAL_CENTS * 100));
  const ask = msgs.find((m) => m.system === 'sponsor-ask');
  const ticked = state.spTicked || {};
  const nTicked = list.filter((p) => ticked[p.id] && p.status === 'todo' && p.email).length;
  const added = new Set(list.map((p) => String(p.business || '').toLowerCase()));
  const leads = (state.leads || []).filter((l) => l.email && !added.has(String(l.title || '').toLowerCase()));
  const evId = state.activeEventId;
  const evName = ((state.events || []).find((e) => e.id === evId) || {}).name || '';
  const msgRows = msgs.map((m) => {
    const [label, tone] = STATUS[m.status] || STATUS.draft;
    return `<tr data-ms-open="${h.attr(m.id)}"><td class="ms-when">${h.esc(whenText(m, {}))}</td>
      <td><strong>${h.esc(m.name)}</strong><span class="ms-sub">${h.esc(fill(m.subject || '', { event_name: evName }, String))}</span></td>
      <td><span class="ms-chip ms-${tone}">${h.esc(label)}</span></td><td class="ms-sent">${m.sentCount || 0} sent</td></tr>`;
  }).join('');
  const row = (p) => {
    const [lab, tone] = SP_STATUS[p.status] || SP_STATUS.todo;
    const can = p.status === 'todo' && p.email;
    return `<tr class="ms-fixed">
      <td><input type="checkbox" data-sp-tick="${h.attr(p.id)}"${ticked[p.id] && can ? ' checked' : ''}${can ? '' : ' disabled'} aria-label="Ask ${h.attr(p.business)}"></td>
      <td><strong>${h.esc(p.business)}</strong><span class="ms-sub">${h.esc({ lead: 'Lead Generator', past: 'Past sponsor', manual: 'Added by you', website: 'Sponsor page', suggested: 'Big Bowen business' }[p.source] || '')}</span>${p.notes ? '<span class="ms-sub ms-sp-tip">' + h.esc(p.notes) + '</span>' : ''}</td>
      <td>${h.esc(p.contactName || '')}${p.email ? '<span class="ms-sub">' + h.esc(p.email) + '</span>' : '<input class="ad-input ms-sp-email" data-sp-email="' + h.attr(p.id) + '" placeholder="Add their email" type="email">'}</td>
      <td><select class="ad-select ms-sp-sel" data-sp-status="${h.attr(p.id)}">${Object.keys(SP_STATUS).map((k) => `<option value="${k}"${(p.status || 'todo') === k ? ' selected' : ''}>${SP_STATUS[k][0]}</option>`).join('')}</select>
        <span class="ms-chip ms-${tone} ms-sp-chip">${h.esc(lab)}</span></td>
      <td><select class="ad-select ms-sp-sel" data-sp-level="${h.attr(p.id)}"><option value="">Level&hellip;</option>${SPONSOR_LEVELS.map((l) => `<option value="${l.key}"${p.level === l.key ? ' selected' : ''}>${h.esc(l.name.split(' - ')[0])}${l.priceCents ? ' ' + money0(l.priceCents) : ''}</option>`).join('')}</select>
        ${p.level === 'supporter' ? `<input class="ad-input ms-sp-amt" data-sp-amount="${h.attr(p.id)}" placeholder="$ value" value="${p.amountCents ? Math.round(p.amountCents / 100) : ''}">` : ''}</td>
      <td class="ms-sp-note">${p.message ? '<span title="' + h.attr(p.message) + '">&#128172;</span>' : ''}<button type="button" class="ms-sp-del" data-sp-del="${h.attr(p.id)}" title="Remove">&times;</button></td>
    </tr>`;
  };
  return `<div class="ms-sp-goal ad-card">
      <div><b>${money0(yes)}</b> committed of your <b>${money0(SPONSOR_GOAL_CENTS)}</b> goal${maybe ? ' &middot; <span>' + money0(maybe) + ' interested</span>' : ''}</div>
      <div class="ms-sp-bar"><span style="width:${pct}%"></span><i style="width:${pct2}%"></i></div>
      <a href="/sponsor?e=${encodeURIComponent(evId)}" target="_blank" rel="noopener">Open the sponsor page &#8599;</a>
    </div>
    <div class="ad-card ms-card"><table class="ms-table"><thead><tr><th>When</th><th>Email</th><th>Status</th><th>Sent</th></tr></thead><tbody>${msgRows}</tbody></table></div>
    <div class="ad-card ms-card ms-sp">
      <div class="ms-sp-bar2">
        <b>Businesses to ask</b><span>${list.length}</span>
        <button type="button" class="ad-btn ad-btn-small" data-sp-add>+ Add a business</button>
        <button type="button" class="ad-btn ad-btn-small" data-sp-leads>From Lead Generator (${leads.length})</button>
        <button type="button" class="ad-btn ad-btn-small" data-sp-big>Add big Bowen businesses (${SUGGESTED_SPONSORS.filter((s) => !added.has(s.business.toLowerCase())).length})</button>
        <button type="button" class="ad-btn ad-btn-small" data-sp-past>Add past sponsors</button>
        <button type="button" class="ad-btn ad-btn-primary ms-sp-send" data-sp-send${nTicked ? '' : ' disabled'}>Send the ask to ${nTicked} ticked</button>
      </div>
      ${ask && ask.status !== 'approved' ? '<p class="ms-note ms-sp-warn">Approve &ldquo;Sponsorship - the ask&rdquo; above before you can send.</p>' : ''}
      ${state.spAdding ? `<form class="ms-sp-form" data-sp-form>
        <input class="ad-input" name="business" placeholder="Business" required>
        <input class="ad-input" name="contactName" placeholder="Contact name">
        <input class="ad-input" name="email" type="email" placeholder="Email">
        <input class="ad-input" name="phone" placeholder="Phone">
        <button type="submit" class="ad-btn ad-btn-primary">Add</button><button type="button" class="ad-btn" data-sp-cancel>Cancel</button></form>` : ''}
      ${state.spPicking ? `<div class="ms-sp-pick"><p>Tick the businesses to add (only ones with an email are shown):</p>
        <div class="ms-sp-picklist">${leads.map((l) => `<label><input type="checkbox" data-sp-lead="${h.attr(l.id)}"> <b>${h.esc(l.title || '')}</b> <span>${h.esc(l.contactName || '')} &middot; ${h.esc(l.email)}</span></label>`).join('') || '<p class="ad-cell-muted">No leads with an email that aren&rsquo;t already on the list.</p>'}</div>
        <button type="button" class="ad-btn ad-btn-primary" data-sp-leadadd>Add ticked</button> <button type="button" class="ad-btn" data-sp-cancel>Cancel</button></div>` : ''}
      <table class="ms-table"><thead><tr><th></th><th>Business</th><th>Contact</th><th>Status</th><th>Level</th><th></th></tr></thead>
      <tbody>${list.map(row).join('') || '<tr class="ms-fixed"><td colspan="6" class="ad-cell-muted">No businesses yet - add some from your Lead Generator, by hand, or your past sponsors.</td></tr>'}</tbody></table>
    </div>
    ${needsEmailHtml(h, added)}`;
}

/*  Worth asking, but no public email yet: find it, type it in, Add. */
function needsEmailHtml(h, added) {
  const todo = NEEDS_EMAIL.filter((n) => !added.has(n.business.toLowerCase()));
  if (!todo.length) return '';
  return `<div class="ad-card ms-card ms-sp ms-sp-need"><div class="ms-sp-bar2"><b>Worth asking &mdash; find their email</b><span>${todo.length}</span></div>
    <table class="ms-table"><tbody>${todo.map((n) => `<tr class="ms-fixed"><td><strong>${h.esc(n.business)}</strong><span class="ms-sub ms-sp-tip">${h.esc(n.tip)}</span></td>
      <td><input class="ad-input ms-sp-email" type="email" placeholder="Their email" data-need-email="${h.attr(n.business)}"></td>
      <td class="ad-cell-right"><button type="button" class="ad-btn ad-btn-small" data-need-add="${h.attr(n.business)}">Add</button></td></tr>`).join('')}</tbody></table></div>`;
}

/*  THE WAITLIST for this event (Max, 20 Oct 2026). */
const WL_STATUS = {
  waiting: ['Waiting', 'grey'], offered: ['Offered - 4 hrs', 'amber'], claimed: ['Booking now', 'blue'],
  booked: ['Booked', 'green'], declined: ['Declined', 'grey'], expired: ['Ran out of time', 'grey'],
};
function waitlistHtml(ctx) {
  const { state, h } = ctx;
  const list = (state.waitlist || []).slice().sort((a, b) => ((a.createdAt && a.createdAt.seconds) || 0) - ((b.createdAt && b.createdAt.seconds) || 0));
  const msg = (state.messages || []).find((m) => m.system === 'waitlist');
  const off = !msg || msg.status !== 'approved';
  let pos = { food: 0, market: 0 };
  return `<div class="ad-card ms-card ms-wl">
    <div class="ms-wl-head"><b>Waitlist</b><span>${list.filter((w) => w.status === 'waiting').length} waiting</span>
      ${off ? '<em>Offers are switched off until you approve &ldquo;Waitlist - a spot opened&rdquo; above.</em>' : '<em>When a spot opens the next person is emailed automatically.</em>'}</div>
    <table class="ms-table"><thead><tr><th>#</th><th>Business</th><th>Type</th><th>Contact</th><th>Status</th></tr></thead><tbody>
    ${list.map((w) => {
      const [lab, tone] = WL_STATUS[w.status] || WL_STATUS.waiting;
      const n = w.status === 'waiting' ? ++pos[w.vendorType] : '';
      return `<tr class="ms-fixed"><td>${n}</td><td><strong>${h.esc(w.name)}</strong><span class="ms-sub">${h.esc(w.description || '')}</span></td>
        <td>${w.vendorType === 'food' ? 'Food van' : 'Market stall'}</td>
        <td>${h.esc(w.contactName)}<span class="ms-sub">${h.esc(w.email)}${w.phone ? ' · ' + h.esc(w.phone) : ''}</span></td>
        <td><span class="ms-chip ms-${tone}">${h.esc(lab)}</span>${w.siteLabel && ['offered', 'claimed', 'booked'].includes(w.status) ? '<span class="ms-sub">site ' + h.esc(w.siteLabel) + '</span>' : ''}</td></tr>`;
    }).join('') || '<tr class="ms-fixed"><td colspan="5" class="ad-cell-muted">Nobody on the waitlist yet. The form appears on the vendor page when a type sells out.</td></tr>'}
    </tbody></table></div>`;
}

function clientsHtml(h, state) {
  const p = state.clientPrev;
  return `<div class="ms-log-grid${p ? ' has-open' : ''}"><div class="ad-card ms-card"><table class="ms-table">
      <thead><tr><th>When</th><th>Message &amp; subject</th><th>Who</th><th>Status</th></tr></thead>
      <tbody>${CLIENT_EMAILS.map(([when, name, subj, who, st, key]) => `<tr data-ms-cprev="${key}"${p && p.key === key ? ' class="is-sel"' : ''}>
        <td class="ms-when">${h.esc(when)}</td>
        <td><strong>${h.esc(name)}</strong><span class="ms-sub">${h.esc(subj)}</span></td>
        <td>${h.esc(who)}</td>
        <td><span class="ms-chip ${st === 'Auto' ? 'ms-green' : 'ms-blue'}">${h.esc(st)}</span></td></tr>`).join('')}</tbody>
    </table></div>
    ${p ? `<aside class="ad-card ms-card ms-pad ms-log-view">
        <button type="button" class="ms-back" data-ms-cclose>&times; Close</button>
        <p class="ms-log-meta"><b>${h.esc(p.subject || '')}</b>${p.note ? '<br>' + h.esc(p.note) : ''}</p>
        ${p.loading ? '<p class="ad-cell-muted">Loading&hellip;</p>' : '<iframe class="ms-log-frame" id="ms-cprev-frame" title="Email preview"></iframe>'}
      </aside>` : ''}
    </div>
    <p class="ms-key">Click any of these to see the email. These client emails already go out today. Editing them here, plus the quote follow-ups, balance reminders and review requests, comes in step 2.</p>`;
}

function editorHtml(ctx, ev) {
  const { state, h } = ctx;
  const isNew = state.msgOpen === 'new';
  const m = isNew ? { status: 'draft' } : ((state.messages || []).find((x) => x.id === state.msgOpen) || { status: 'draft' });
  if (!state.msgDraft) state.msgDraft = isNew ? blankMessage() : draftFrom(m);
  const d = state.msgDraft;
  const [label, tone] = STATUS[m.status] || STATUS.draft;
  const back = '<button type="button" class="ms-back" data-ms-back>&larr; All messages</button>';

  const sys = !!m.system;
  const saved = isNew ? null : draftFrom(m);
  const dirty = isNew || !sameDraft(saved, d);
  /*  who it goes to: vendors for vendor emails; for the sponsor emails, the
      businesses on the Sponsors tab - NEVER the vendors (Max, 20 Oct 2026) */
  const spons = m.audience === 'sponsors';
  const list = spons
    ? (state.sponsors || []).filter((p) => p.email && (m.system === 'sponsor-followup' ? p.status === 'asked' : p.status === 'todo'))
        .map((p) => ({ business: { name: p.business, email: p.email } }))
    : m.system === 'waitlist' ? []
    : sys ? paidVendors(state.bookings, state.activeEventId) : recipients(state.bookings, state.activeEventId, d);
  const sentence = sentenceHtml(ctx, d, m, ev);
  const locked = m.status === 'sent';
  const t = d.trigger || {};
  const failed = m.failed || [];

  return `<div class="ms">${back}
    <div class="ms-title"><h1>${h.esc(d.name || (isNew ? 'New message' : 'Message'))}</h1><span class="ms-chip ms-${tone}">${h.esc(label)}</span>
      ${!isNew ? `<span class="ms-count">${spons || m.system === 'waitlist' ? 'Sent ' + (m.sentCount || 0) : 'Sent ' + (sys ? list.filter((b) => b.invoiceEmailedAt).length : (m.sentCount || 0)) + ' of ' + list.length}</span>` : ''}</div>
    <div class="ms-sentence" id="ms-sentence">${sentence}</div>
    <div class="ms-grid">
      <div class="ad-card ms-card ms-pad">
        <label class="ms-f"><span>Name (just for you)</span><input class="ad-input" data-ms="name" value="${h.attr(d.name)}" placeholder="e.g. One week to go"${locked ? ' disabled' : ''}></label>
        ${m.system === 'sponsor-ask' ? '<p class="ms-fixed-when"><b>Who:</b> the businesses you tick on the Sponsors tab &nbsp;&middot;&nbsp; <b>When:</b> when you press Send (a &ldquo;See the sponsor options&rdquo; button with their personal link is added below your text)</p>'
          : m.system === 'sponsor-followup' ? '<p class="ms-fixed-when"><b>Who:</b> anyone still &ldquo;Asked&rdquo; &nbsp;&middot;&nbsp; <b>When:</b> 7 days after the ask, at 9:35 am</p>'
          : m.system === 'waitlist' ? '<p class="ms-fixed-when"><b>Who:</b> the next person on the waitlist &nbsp;&middot;&nbsp; <b>When:</b> the moment a spot opens (Accept and Decline buttons and the 4-hour note are added below your text)</p>'
          : sys ? '<p class="ms-fixed-when"><b>Who:</b> each vendor &nbsp;&middot;&nbsp; <b>When:</b> the moment they pay (total and guide button are added below your text)</p>' : `<div class="ms-row">
          <label class="ms-f"><span>Who</span><select class="ad-select" data-ms="who"${locked ? ' disabled' : ''}>
            ${Object.keys(WHO).map((k) => `<option value="${k}"${d.who === k ? ' selected' : ''}>${WHO[k]}</option>`).join('')}
          </select></label>
          <label class="ms-f"><span>When</span><select class="ad-select" data-ms="trigger.type"${locked ? ' disabled' : ''}>
            <option value="daysBefore"${t.type === 'daysBefore' ? ' selected' : ''}>Days before the event</option>
            <option value="daysAfter"${t.type === 'daysAfter' ? ' selected' : ''}>Days after the event</option>
            <option value="date"${t.type === 'date' ? ' selected' : ''}>On a date</option>
          </select></label>
          ${t.type === 'date'
            ? `<label class="ms-f"><span>Date</span><input type="date" class="ad-input" data-ms="trigger.date" value="${h.attr(t.date || '')}"${locked ? ' disabled' : ''}></label>`
            : `<label class="ms-f ms-days"><span>Days</span><input type="number" min="0" max="365" class="ad-input" data-ms="trigger.days" value="${h.attr(t.days || 0)}"${locked ? ' disabled' : ''}></label>`}
        </div>`}
        ${m.system === 'waitlist' ? '<div hidden>' : `<details class="ms-list"><summary>${spons ? (m.system === 'sponsor-followup' ? 'Businesses still waiting on a reply' : 'Businesses ready to ask (tick them on the Sponsors tab)') : 'See who gets it'} (${list.length})</summary>`}
          <ul>${list.map((b) => `<li>${h.esc((b.business || {}).name || '')} <span>${h.esc((b.business || {}).email || '')}${b.siteLabel ? ' · site ' + h.esc(b.siteLabel) : ''}</span></li>`).join('') || (spons ? '<li>No businesses yet - add them on the Sponsors tab.</li>' : '<li>No paid vendors match yet.</li>')}</ul>
        ${m.system === 'waitlist' ? '</div>' : '</details>'}
        <label class="ms-f"><span>Subject</span><input class="ad-input" data-ms="subject" value="${h.attr(d.subject)}"${locked ? ' disabled' : ''}></label>
        <label class="ms-f"><span>Message</span><textarea class="ad-input ms-body" data-ms="body" rows="14"${locked ? ' disabled' : ''}>${h.esc(d.body)}</textarea></label>
        <p class="ms-help">Blank line = new paragraph. Start a line with &ldquo;- &rdquo; for a bullet. Click to add:</p>
        <div class="ms-chips">${(m.system === 'waitlist' ? FIELDS.concat(WAITLIST_FIELDS) : sys ? FIELDS.concat(INVOICE_FIELDS) : FIELDS).map(([k, l]) => `<button type="button" data-ms-field="${k}" title="${h.attr(l)}"${locked ? ' disabled' : ''}>{{${k}}}</button>`).join('')}</div>
        ${sys ? '' : `<label class="ms-check"><input type="checkbox" data-ms="promo"${d.promo ? ' checked' : ''}${locked ? ' disabled' : ''}> Promotional (news about other events) &mdash; adds an unsubscribe link</label>`}
        <div class="ms-actions">
          ${locked ? '' : `<button type="button" class="ad-btn${dirty ? ' ad-btn-primary' : ''}" data-ms-act="save">${dirty ? 'Save' : 'Saved'}</button>`}
          ${!isNew ? '<button type="button" class="ad-btn" data-ms-act="test">Test to me</button>' : ''}
          ${!isNew && !dirty && m.status === 'review' ? '<button type="button" class="ad-btn ms-approve" data-ms-act="approve">Approve</button>' : ''}
          ${!isNew && m.status === 'approved' ? '<button type="button" class="ad-btn" data-ms-act="pause">Pause</button>' : ''}
          ${!isNew && m.status === 'paused' ? '<button type="button" class="ad-btn ad-btn-primary" data-ms-act="resume">Resume</button>' : ''}
          ${!isNew && !sys && ['approved', 'paused', 'review'].includes(m.status) ? '<button type="button" class="ad-btn" data-ms-act="cancel">Cancel</button>' : ''}
          ${!isNew && !sys && !(m.sentCount > 0) ? '<button type="button" class="ad-btn ms-del" data-ms-act="delete">Delete</button>' : ''}
        </div>
        ${dirty && !isNew && m.status !== 'draft' ? `<p class="ms-note">Changes need your OK again after you save.${sys ? ' Vendors keep getting the approved wording until then.' : ''}</p>` : ''}
        ${m.system === 'invoice' && m.status === 'review' && !dirty ? '<p class="ms-note">Vendors are still getting the last approved wording &mdash; press Approve to switch to this.</p>' : ''}
        ${m.system === 'waitlist' && m.status !== 'approved' && m.status !== 'paused' && !dirty ? '<p class="ms-note">The waitlist sends no offers until you approve this email.</p>' : ''}
        <p class="ms-msg" id="ms-msg" hidden></p>
        ${failed.length ? `<div class="ms-failed"><p><b>${failed.length} didn&rsquo;t go</b></p>${failed.map((f) => `<div><span>${h.esc(f.name)} &middot; ${h.esc(f.to)}<em>${h.esc(f.error)}</em></span><button type="button" class="ad-btn ad-btn-small" data-ms-resend="${h.attr(f.bookingId)}">Resend</button></div>`).join('')}</div>` : ''}
      </div>
      <aside class="ad-card ms-card ms-pad">
        <p class="ms-prev-h">Preview &mdash; ${m.audience === 'sponsors' ? 'as a business sees it (sample details)' : m.system === 'waitlist' ? 'as the next person on the waitlist sees it (sample details)' : 'as ' + h.esc(((list[0] || {}).business || {}).name || 'a vendor') + ' sees it'} &middot; buttons and links open for real</p>
        <div class="ms-prev" id="ms-prev"></div>
      </aside>
    </div>
  </div>`;
}

/*  PREVIEW LINKS ARE REAL (Max, 20 Oct 2026): every button in a preview opens
    the page it goes to, in a new tab, so Max can test it.               */
function guideLinkFor(state) {
  const b = paidVendors(state.bookings, state.activeEventId).find((x) => x.invoiceToken);
  return b ? '/vendor-invoice?t=' + b.invoiceToken : '';
}
const pbtn = (h, label, url, cls) => url
  ? '<a class="' + (cls || '') + '" href="' + h.attr(url) + '" target="_blank" rel="noopener">' + label + '</a>'
  : '<span class="' + (cls || '') + '" title="Opens when a vendor has paid">' + label + '</span>';

function previewHtml(ctx) {
  const { state, h } = ctx;
  const guide = guideLinkFor(state);
  const ev = (state.events || []).find((e) => e.id === state.activeEventId) || {};
  const d = state.msgDraft || blankMessage();
  const m = (state.messages || []).find((x) => x.id === state.msgOpen) || {};
  const first = (m.system ? paidVendors(state.bookings, state.activeEventId) : recipients(state.bookings, state.activeEventId, d))[0];
  const v = sampleValues(first, ev);
  if (m.audience === 'sponsors') {
    const sv = { ...v, vendor_name: 'Sam', business_name: 'Sample Business' };
    return `<div class="ms-mail"><div class="ms-mail-top">SOUNDZGOOD WHITSUNDAYS</div>
    <p class="ms-mail-subj">${h.esc(fill(d.subject, sv, String))}</p>
    <div class="ms-mail-body">${bodyHtml(d.body, sv, h.esc)}
      <p class="ms-mail-btn">${pbtn(h, 'See the sponsor options', '/sponsor?e=' + encodeURIComponent(state.activeEventId || ''))}</p>
      <p class="ms-mail-note">Not for you? Just reply and let us know - we won't email you about it again.</p></div>
    <div class="ms-mail-foot">SoundzGood Whitsundays</div></div>`;
  }
  if (m.system === 'waitlist') {
    const wv = { ...v, vendor_name: 'Sam', business_name: 'Sample Food Co', site_number: 'F4', expires_at: 'Sat 24 Oct, 1:35 pm' };
    return `<div class="ms-mail"><div class="ms-mail-top">SOUNDZGOOD WHITSUNDAYS</div>
    <p class="ms-mail-subj">${h.esc(fill(d.subject, wv, String))}</p>
    <div class="ms-mail-body">${bodyHtml(d.body, wv, h.esc)}
      <p class="ms-mail-btn">${pbtn(h, 'Accept &amp; book my spot', '/vendor-signup')} <span class="ms-mail-btn2" title="In the real email this passes the spot to the next person">No thanks - decline</span></p>
      <p class="ms-mail-note">This spot is held for you until ${h.esc(wv.expires_at)}. It is only yours once payment is received.</p></div>
    <div class="ms-mail-foot">SoundzGood Whitsundays</div></div>`;
  }
  if (m.system) {
    return `<div class="ms-mail"><div class="ms-mail-top">SOUNDZGOOD WHITSUNDAYS<b>Thank you &mdash; you&rsquo;re booked in</b></div>
    <p class="ms-mail-subj">${h.esc(fill(d.subject, v, String))}</p>
    <div class="ms-mail-body">${bodyHtml(d.body, v, h.esc)}
      <div class="ms-mail-total"><small>TOTAL PAID (INCL GST)</small><b>${h.esc(v.total_paid)}</b><span>Invoice ${h.esc(v.invoice_number)}</span></div>
      <p class="ms-mail-btn">${pbtn(h, 'View your invoice &amp; event guide &rarr;', guide)}</p></div>
    <div class="ms-mail-foot">SoundzGood Whitsundays &middot; 34a Williams St, Bowen QLD 4805</div></div>`;
  }
  return `<div class="ms-mail"><div class="ms-mail-top">SOUNDZGOOD WHITSUNDAYS</div>
    <p class="ms-mail-subj">${h.esc(fill(d.subject, v, String))}</p>
    <div class="ms-mail-body">${bodyHtml(d.body, v, h.esc)}
      <p class="ms-mail-btn">${pbtn(h, 'View your invoice &amp; event guide &rarr;', guide)}</p></div>
    <div class="ms-mail-foot">SoundzGood Whitsundays${d.promo ? '<br><u>Unsubscribe from event news</u>' : ''}</div></div>`;
}

/* ==========================================================================
   WIRING
   ========================================================================== */
export function wireMessages(ctx) {
  const { state, call, render } = ctx;
  const root = document.querySelector('.ms');
  if (!root) return;

  // first visit to an event with no messages: add the starters
  if (state.activeEventId && state.messagesLoaded && !state.msgSeeding && state.msgSeededFor !== state.activeEventId) {
    state.msgSeeding = true;
    state.msgSeededFor = state.activeEventId;
    call('adminMessagesSeed', { eventId: state.activeEventId })
      .catch((e) => window.alert(e.message || 'Could not add the starter messages.'))
      .finally(() => { state.msgSeeding = false; });
  }

  // Sent emails: load, search, show the chosen one
  const refreshLog = () => {
    if (!ctx.loadLog) return;
    ctx.loadLog().then((list) => { state.emailLog = list; render(); })
      .catch((err) => { state.emailLog = []; window.alert(err.message || 'Could not load sent emails.'); render(); });
  };
  if (state.msgTab === 'sent' && !state.emailLog) refreshLog();
  const cFrame = document.getElementById('ms-cprev-frame');
  if (cFrame && state.clientPrev && state.clientPrev.html) cFrame.srcdoc = state.clientPrev.html;
  const logFrame = document.getElementById('ms-log-frame');
  if (logFrame) {
    const m = (state.emailLog || []).find((x) => x.id === state.emailLogOpen);
    if (m) logFrame.srcdoc = m.html || ('<pre style="white-space:pre-wrap;font-family:Arial;padding:16px">' + ctx.h.esc(m.text || '') + '</pre>');
  }
  const logQ = root.querySelector('[data-ms-logq]');
  if (logQ) logQ.addEventListener('input', () => {
    state.emailLogFilter = logQ.value;
    const pos = logQ.selectionStart;
    render();
    const again = document.querySelector('[data-ms-logq]');
    if (again) { again.focus(); again.selectionStart = again.selectionEnd = pos; }
  });

  const prev = document.getElementById('ms-prev');
  const paintPreview = () => { if (prev) prev.innerHTML = previewHtml(ctx); };
  paintPreview();

  const say = (t, bad) => {
    const el = document.getElementById('ms-msg');
    if (el) { el.hidden = false; el.textContent = t; el.className = 'ms-msg' + (bad ? ' ms-bad' : ''); }
  };
  const close = () => { state.msgOpen = null; state.msgDraft = null; render(); };

  root.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('[data-ms-tab]');
    if (tabBtn) {
      state.msgTab = tabBtn.getAttribute('data-ms-tab');
      if (state.msgTab === 'sent' && !state.emailLog) refreshLog();
      render();
      return;
    }
    if (e.target.closest('[data-ms-logrefresh]')) { refreshLog(); return; }
    // ---- Sponsors tab ----
    if (e.target.closest('[data-sp-add]')) { state.spAdding = !state.spAdding; state.spPicking = false; render(); return; }
    if (e.target.closest('[data-sp-leads]')) { state.spPicking = !state.spPicking; state.spAdding = false; render(); return; }
    if (e.target.closest('[data-sp-cancel]')) { state.spAdding = false; state.spPicking = false; render(); return; }
    const needAdd = e.target.closest('[data-need-add]');
    if (needAdd) {
      const name = needAdd.getAttribute('data-need-add');
      const box = [...root.querySelectorAll('[data-need-email]')].find((x) => x.getAttribute('data-need-email') === name);
      const email = String((box && box.value) || '').trim();
      if (!/^[^s@]+@[^s@]+.[^s@]+$/.test(email)) { window.alert('Type their email first.'); return; }
      const n = NEEDS_EMAIL.find((x) => x.business === name) || {};
      await ctx.sponsors.add({ business: name, email, notes: n.tip || '', source: 'suggested' });
      return;
    }
    if (e.target.closest('[data-sp-big]')) {
      const have = new Set((state.sponsors || []).map((p) => String(p.business || '').toLowerCase()));
      const add = SUGGESTED_SPONSORS.filter((s) => !have.has(s.business.toLowerCase()));
      // ones added earlier without an email get it filled in now
      const fill = (state.sponsors || []).filter((p) => !p.email && SUGGESTED_SPONSORS.some((s) => s.business.toLowerCase() === String(p.business || '').toLowerCase()));
      if (!add.length && !fill.length) { window.alert('They are all on your list already.'); return; }
      for (const s of add) await ctx.sponsors.add({ business: s.business, email: s.email, notes: s.note, source: 'suggested' });
      for (const p of fill) { const s = SUGGESTED_SPONSORS.find((x) => x.business.toLowerCase() === String(p.business).toLowerCase()); await ctx.sponsors.update(p.id, { email: s.email, notes: s.note }); }
      return;
    }
    if (e.target.closest('[data-sp-past]')) {
      const have = new Set((state.sponsors || []).map((p) => String(p.business || '').toLowerCase()));
      const add = PAST_SPONSORS.filter((n) => !have.has(n.toLowerCase()));
      if (!add.length) { window.alert('Your past sponsors are already on the list.'); return; }
      for (const n of add) await ctx.sponsors.add({ business: n, source: 'past' });
      return;
    }
    if (e.target.closest('[data-sp-leadadd]')) {
      const ids = [...root.querySelectorAll('[data-sp-lead]:checked')].map((x) => x.getAttribute('data-sp-lead'));
      for (const id of ids) {
        const l = (state.leads || []).find((x) => x.id === id);
        if (l) await ctx.sponsors.add({ business: l.title || '', contactName: l.contactName || '', email: l.email || '', phone: l.phone || '', source: 'lead', leadId: l.id });
      }
      state.spPicking = false; render();
      return;
    }
    const del = e.target.closest('[data-sp-del]');
    if (del) {
      const p = (state.sponsors || []).find((x) => x.id === del.getAttribute('data-sp-del'));
      if (p && window.confirm('Remove ' + (p.business || 'this business') + ' from the list?')) await ctx.sponsors.remove(p.id);
      return;
    }
    if (e.target.closest('[data-sp-send]')) {
      const ticked = state.spTicked || {};
      const go = (state.sponsors || []).filter((p) => ticked[p.id] && p.status === 'todo' && p.email);
      if (!go.length) return;
      if (!window.confirm('Send the sponsorship email to ' + go.length + ' business' + (go.length === 1 ? '' : 'es') + '?\n\n' + go.map((p) => '- ' + p.business).join('\n'))) return;
      const b = e.target.closest('[data-sp-send]'); b.disabled = true; b.textContent = 'Sending...';
      try {
        const r = await call('adminSponsorSend', { eventId: state.activeEventId, ids: go.map((p) => p.id) });
        state.spTicked = {};
        window.alert('Sent ' + r.sent + '.' + (r.failed && r.failed.length ? '\n\nNot sent:\n' + r.failed.join('\n') : ''));
      } catch (err) { window.alert(err.message || 'Could not send.'); }
      render();
      return;
    }
    if (e.target.closest('[data-ms-cclose]')) { state.clientPrev = null; render(); return; }
    const cRow = e.target.closest('[data-ms-cprev]');
    if (cRow) {
      const key = cRow.getAttribute('data-ms-cprev');
      state.clientPrev = { key, loading: true };
      render();
      call('adminPreviewClientEmail', { kind: key })
        .then((r) => { if (state.clientPrev && state.clientPrev.key === key) { state.clientPrev = { key, ...r }; render(); } })
        .catch((err) => { state.clientPrev = { key, subject: err.message || 'Could not load the preview.' }; render(); });
      return;
    }
    if (e.target.closest('[data-ms-logclose]')) { state.emailLogOpen = null; render(); return; }
    const logRow = e.target.closest('[data-ms-log]');
    if (logRow) { state.emailLogOpen = logRow.getAttribute('data-ms-log'); render(); return; }
    const open = e.target.closest('[data-ms-open]');
    if (open) { state.msgOpen = open.getAttribute('data-ms-open'); state.msgDraft = null; render(); return; }
    if (e.target.closest('[data-ms-new]')) { state.msgOpen = 'new'; state.msgDraft = blankMessage(); render(); return; }
    if (e.target.closest('[data-ms-back]')) {
      const m = (state.messages || []).find((x) => x.id === state.msgOpen);
      const dirty = state.msgOpen === 'new' ? !!(state.msgDraft && (state.msgDraft.subject || state.msgDraft.body))
        : (m && !m.system && state.msgDraft && !sameDraft(draftFrom(m), state.msgDraft));
      if (dirty && !window.confirm('Leave without saving your changes?')) return;
      close();
      return;
    }
    const field = e.target.closest('[data-ms-field]');
    if (field) {
      const box = root.querySelector('[data-ms="body"]');
      if (!box) return;
      const tag = '{{' + field.getAttribute('data-ms-field') + '}}';
      const at = box.selectionStart != null ? box.selectionStart : box.value.length;
      box.value = box.value.slice(0, at) + tag + box.value.slice(box.selectionEnd || at);
      box.focus();
      box.selectionStart = box.selectionEnd = at + tag.length;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const resend = e.target.closest('[data-ms-resend]');
    if (resend) {
      resend.disabled = true; resend.textContent = 'Sending...';
      try {
        const r = await call('adminMessageResend', { id: state.msgOpen, bookingId: resend.getAttribute('data-ms-resend') });
        say(r.sent ? 'Sent.' : 'Still did not send: ' + (r.error || r.reason || ''), !r.sent);
      } catch (err) { say(err.message || 'Could not resend.', true); }
      return;
    }
    const act = e.target.closest('[data-ms-act]');
    if (!act) return;
    const what = act.getAttribute('data-ms-act');
    const id = state.msgOpen;
    act.disabled = true;
    try {
      if (what === 'save') {
        const res = await call('adminMessageSave', { id: id === 'new' ? null : id, eventId: state.activeEventId, ...state.msgDraft });
        state.msgOpen = res.id;
        state.msgDraft = null;
        render();
        return;
      }
      if (what === 'test') {
        const r = await call('adminMessageTest', { id });
        say(r.sent ? 'Test sent to ' + r.to + ' only. No vendor was emailed.' : 'Test did not send: ' + (r.error || r.reason || ''), !r.sent);
      } else if (what === 'approve' && ((state.messages || []).find((x) => x.id === id) || {}).system) {
        const wlMsg = ((state.messages || []).find((x) => x.id === id) || {}).system === 'waitlist';
        const spMsg = ((state.messages || []).find((x) => x.id === id) || {}).audience === 'sponsors';
        if (spMsg) {
          if (!window.confirm('Approve this sponsorship email? It only goes when you press Send on the Sponsors tab (or 7 days later for the follow-up).')) { act.disabled = false; return; }
          await call('adminMessageAction', { id, action: 'approve' });
          say('Approved.');
          act.disabled = false;
          return;
        }
        if (!window.confirm(wlMsg ? 'Approve this email? From now on, when a spot opens the next person on the waitlist is emailed automatically and gets 4 hours to claim it.' : 'Approve this wording? Every vendor who pays from now on gets it.')) { act.disabled = false; return; }
        await call('adminMessageAction', { id, action: 'approve' });
        say('Approved - new vendors get this wording.');
      } else if (what === 'approve') {
        const m = (state.messages || []).find((x) => x.id === id) || {};
        const ev = (state.events || []).find((x) => x.id === state.activeEventId) || {};
        const n = recipients(state.bookings, state.activeEventId, m).length;
        if (!window.confirm('Approve "' + (m.name || m.subject) + '"?\n\nIt will send itself to ' + n + ' vendor' + (n === 1 ? '' : 's') + ' (and anyone who books before then) on ' + niceDay(sendDate(m, ev)) + ' at ' + SEND_TIME + '.\n\nYou can pause or cancel it any time before then.')) { act.disabled = false; return; }
        const r = await call('adminMessageAction', { id, action: 'approve' });
        say('Approved - it sends on ' + niceDay(r.sendDate) + ' at ' + SEND_TIME + '.');
      } else if (what === 'delete') {
        if (!window.confirm('Delete this message? It has not been sent to anyone.')) { act.disabled = false; return; }
        await call('adminMessageAction', { id, action: 'delete' });
        close();
        return;
      } else if (what === 'cancel') {
        if (!window.confirm('Cancel this message? It will not send.')) { act.disabled = false; return; }
        await call('adminMessageAction', { id, action: 'cancel' });
      } else {
        await call('adminMessageAction', { id, action: what });   // pause / resume
      }
    } catch (err) {
      say(err.message || 'Could not do that.', true);
    }
    act.disabled = false;
  });

  // typing: keep the draft in state (so a live update can't lose it), refresh preview + sentence
  const onEdit = (e) => {
    const k = e.target.getAttribute && e.target.getAttribute('data-ms');
    if (!k || !state.msgDraft) return;
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (k.startsWith('trigger.')) {
      const sub = k.slice(8);
      state.msgDraft.trigger = { ...(state.msgDraft.trigger || {}), [sub]: sub === 'days' ? Math.max(0, Math.round(Number(val) || 0)) : val };
      if (sub === 'type') { render(); return; }   // swaps Days <-> Date box
    } else {
      state.msgDraft[k] = val;
    }
    if (k === 'who' || k === 'promo') { render(); return; }
    paintPreview();
    const s = document.getElementById('ms-sentence');
    if (s) {
      const ev = (state.events || []).find((x) => x.id === state.activeEventId) || {};
      const m = (state.messages || []).find((x) => x.id === state.msgOpen) || {};
      s.innerHTML = sentenceHtml(ctx, state.msgDraft, m, ev);
    }
    const save = root.querySelector('[data-ms-act="save"]');
    if (save) { save.textContent = 'Save'; save.classList.add('ad-btn-primary'); }
    const appr = root.querySelector('[data-ms-act="approve"]');
    if (appr) appr.remove();   // changed: save first, then approve
  };
  root.addEventListener('input', onEdit);
  root.addEventListener('change', onEdit);
  root.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.matches('[data-sp-tick]')) { state.spTicked = { ...(state.spTicked || {}), [t.getAttribute('data-sp-tick')]: t.checked }; render(); return; }
    if (t.matches('[data-sp-status]')) { await ctx.sponsors.update(t.getAttribute('data-sp-status'), { status: t.value }); return; }
    if (t.matches('[data-sp-level]')) { await ctx.sponsors.update(t.getAttribute('data-sp-level'), { level: t.value }); return; }
    if (t.matches('[data-sp-amount]')) { await ctx.sponsors.update(t.getAttribute('data-sp-amount'), { amountCents: Math.max(0, Math.round(Number(String(t.value).replace(/[^0-9.]/g, '')) * 100) || 0) }); return; }
    if (t.matches('[data-sp-email]')) {
      const v = String(t.value || '').trim();
      if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { window.alert('That doesn\'t look like an email address.'); return; }
      await ctx.sponsors.update(t.getAttribute('data-sp-email'), { email: v });
    }
  });
  root.addEventListener('submit', async (e) => {
    if (!e.target.matches('[data-sp-form]')) return;
    e.preventDefault();
    const f = e.target;
    const v = (n) => String((f.querySelector('[name="' + n + '"]') || {}).value || '').trim();
    if (!v('business')) return;
    if (v('email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('email'))) { window.alert('That doesn\'t look like an email address.'); return; }
    await ctx.sponsors.add({ business: v('business'), contactName: v('contactName'), email: v('email'), phone: v('phone'), source: 'manual' });
    state.spAdding = false; render();
  });
}
