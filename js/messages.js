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
const CLIENT_EMAILS = [
  ['When they finish the website quote bot', 'Instant estimate', 'Your SoundzGood estimate - (event type)', 'The person who used the bot', 'Auto'],
  ['When you press Send on a quote', 'Quote ready', 'Your quote SG-Q-0000 from SoundzGood', 'That client (and their CC email)', 'You send it'],
  ['When you press Send on an invoice', 'Invoice ready', 'Your invoice SG-I-0000 from SoundzGood', 'That client (and their CC email)', 'You send it'],
  ['When you email a lead from the Lead Generator', 'Lead outreach', 'You write it each time', 'That business', 'You send it'],
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
function bodyHtml(body, values, esc) {
  return String(body || '').replace(/\r/g, '').split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) return '';
    if (lines.every((l) => /^\s*-\s+/.test(l))) {
      return '<ul>' + lines.map((l) => '<li>' + fill(esc(l.replace(/^\s*-\s+/, '')), values, esc) + '</li>').join('') + '</ul>';
    }
    return '<p>' + lines.map((l) => fill(esc(l), values, esc)).join('<br>') + '</p>';
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
  };
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
  const list = (state.messages || []).slice().sort((a, b) => {
    if (a.system && !b.system) return -1;
    if (b.system && !a.system) return 1;
    return (sendDate(a, ev) || '9999').localeCompare(sendDate(b, ev) || '9999');
  });
  const rows = list.map((m) => {
    const [label, tone] = STATUS[m.status] || STATUS.draft;
    const total = m.system ? paidVendors(state.bookings, state.activeEventId).length : recipients(state.bookings, state.activeEventId, m).length;
    const sent = m.system
      ? paidVendors(state.bookings, state.activeEventId).filter((b) => b.invoiceEmailedAt).length
      : (m.sentCount || 0);
    const failed = (m.failed || []).length;
    return `<tr data-ms-open="${h.attr(m.id)}">
      <td class="ms-when">${h.esc(whenText(m, ev))}</td>
      <td><strong>${h.esc(m.name || '(no name)')}</strong><span class="ms-sub">${h.esc(fill(m.subject || '', { event_name: ev.name || '', event_date: ev.dateLabel || '' }, String))}</span></td>
      <td>${h.esc(m.system ? 'Each vendor as they pay' : (WHO[m.who] || WHO.all))}${m.promo ? ' <span class="ms-tag">Promo</span>' : ''}</td>
      <td><span class="ms-chip ms-${tone}">${h.esc(label)}</span></td>
      <td class="ms-sent">${sent} of ${total}${failed ? ` <span class="ms-fail">${failed} failed</span>` : ''}</td>
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
      <button type="button" class="ms-tab" disabled title="Coming soon">Sponsors &amp; suppliers</button>
    </div>
    ${tab === 'clients' ? clientsHtml(h) : `<div class="ad-card ms-card">
      <table class="ms-table">
        <thead><tr><th>When</th><th>Message &amp; subject</th><th>Who</th><th>Status</th><th>Sent</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="ad-cell-muted">${state.msgSeeding ? 'Adding the starter messages&hellip;' : 'No messages yet.'}</td></tr>`}</tbody>
      </table>
    </div>
    <p class="ms-key">You also get an office copy of every new vendor booking at info@soundzgood.com.au.</p>`}
    <p class="ms-key"><span class="ms-chip ms-grey">Draft</span> still being written &nbsp; <span class="ms-chip ms-amber">Your OK</span> ready &mdash; needs your approval &nbsp; <span class="ms-chip ms-green">Auto</span> approved, sends itself</p>
  </div>`;
}

function clientsHtml(h) {
  return `<div class="ad-card ms-card"><table class="ms-table">
      <thead><tr><th>When</th><th>Message &amp; subject</th><th>Who</th><th>Status</th></tr></thead>
      <tbody>${CLIENT_EMAILS.map(([when, name, subj, who, st]) => `<tr class="ms-fixed">
        <td class="ms-when">${h.esc(when)}</td>
        <td><strong>${h.esc(name)}</strong><span class="ms-sub">${h.esc(subj)}</span></td>
        <td>${h.esc(who)}</td>
        <td><span class="ms-chip ${st === 'Auto' ? 'ms-green' : 'ms-blue'}">${h.esc(st)}</span></td></tr>`).join('')}</tbody>
    </table></div>
    <p class="ms-key">These client emails already go out today. Editing them here, plus the quote follow-ups, balance reminders and review requests, comes in step 2.</p>`;
}

function editorHtml(ctx, ev) {
  const { state, h } = ctx;
  const isNew = state.msgOpen === 'new';
  const m = isNew ? { status: 'draft' } : ((state.messages || []).find((x) => x.id === state.msgOpen) || { status: 'draft' });
  if (!state.msgDraft) state.msgDraft = isNew ? blankMessage() : draftFrom(m);
  const d = state.msgDraft;
  const [label, tone] = STATUS[m.status] || STATUS.draft;
  const back = '<button type="button" class="ms-back" data-ms-back>&larr; All messages</button>';

  /* the invoice email: fixed wording, pause / resume / test only */
  if (m.system) {
    const all = paidVendors(state.bookings, state.activeEventId);
    return `<div class="ms">${back}
      <div class="ms-title"><h1>${h.esc(m.name)}</h1><span class="ms-chip ms-${tone}">${h.esc(label)}</span></div>
      <div class="ms-sentence">Sends each vendor their <b>tax invoice &amp; event guide</b> the moment they pay. ${all.filter((b) => b.invoiceEmailedAt).length} of ${all.length} paid vendors have it.</div>
      <div class="ad-card ms-card ms-pad">
        <p class="ms-prev-h" id="ms-sys-h">Loading the email&hellip;</p>
        <p class="ms-sys-subj" id="ms-sys-subj"></p>
        <iframe class="ms-sys-frame" id="ms-sys-frame" title="Email preview"></iframe>
        <p class="ms-sys-link" id="ms-sys-link"></p>
        <div class="ms-actions">
          <button type="button" class="ad-btn" data-ms-act="test">Test to me</button>
          ${m.status === 'paused'
            ? '<button type="button" class="ad-btn ad-btn-primary" data-ms-act="resume">Resume</button>'
            : '<button type="button" class="ad-btn" data-ms-act="pause">Pause</button>'}
        </div>
        <p class="ms-msg" id="ms-msg" hidden></p>
      </div>
    </div>`;
  }

  const saved = isNew ? null : draftFrom(m);
  const dirty = isNew || !sameDraft(saved, d);
  const list = recipients(state.bookings, state.activeEventId, d);
  const day = sendDate(d, ev);
  const sentence = `This sends <b>&ldquo;${h.esc(fill(d.subject, sampleValues(list[0], ev), String) || '(no subject yet)')}&rdquo;</b> to <b>${list.length} ${h.esc((WHO_SHORT[d.who] || WHO_SHORT.all))}</b>`
    + (day ? ` on <b>${h.esc(niceDay(day))} at ${SEND_TIME}</b>.` : ' &mdash; <b>pick when</b>.');
  const locked = m.status === 'sent';
  const t = d.trigger || {};
  const failed = m.failed || [];

  return `<div class="ms">${back}
    <div class="ms-title"><h1>${h.esc(d.name || (isNew ? 'New message' : 'Message'))}</h1><span class="ms-chip ms-${tone}">${h.esc(label)}</span>
      ${!isNew ? `<span class="ms-count">Sent ${m.sentCount || 0} of ${list.length}</span>` : ''}</div>
    <div class="ms-sentence" id="ms-sentence">${sentence}</div>
    <div class="ms-grid">
      <div class="ad-card ms-card ms-pad">
        <label class="ms-f"><span>Name (just for you)</span><input class="ad-input" data-ms="name" value="${h.attr(d.name)}" placeholder="e.g. One week to go"${locked ? ' disabled' : ''}></label>
        <div class="ms-row">
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
        </div>
        <details class="ms-list"><summary>See who gets it (${list.length})</summary>
          <ul>${list.map((b) => `<li>${h.esc((b.business || {}).name || '')} <span>${h.esc((b.business || {}).email || '')}${b.siteLabel ? ' · site ' + h.esc(b.siteLabel) : ''}</span></li>`).join('') || '<li>No paid vendors match yet.</li>'}</ul>
        </details>
        <label class="ms-f"><span>Subject</span><input class="ad-input" data-ms="subject" value="${h.attr(d.subject)}"${locked ? ' disabled' : ''}></label>
        <label class="ms-f"><span>Message</span><textarea class="ad-input ms-body" data-ms="body" rows="14"${locked ? ' disabled' : ''}>${h.esc(d.body)}</textarea></label>
        <p class="ms-help">Blank line = new paragraph. Start a line with &ldquo;- &rdquo; for a bullet. Click to add:</p>
        <div class="ms-chips">${FIELDS.map(([k, l]) => `<button type="button" data-ms-field="${k}" title="${h.attr(l)}"${locked ? ' disabled' : ''}>{{${k}}}</button>`).join('')}</div>
        <label class="ms-check"><input type="checkbox" data-ms="promo"${d.promo ? ' checked' : ''}${locked ? ' disabled' : ''}> Promotional (news about other events) &mdash; adds an unsubscribe link</label>
        <div class="ms-actions">
          ${locked ? '' : `<button type="button" class="ad-btn${dirty ? ' ad-btn-primary' : ''}" data-ms-act="save">${dirty ? 'Save' : 'Saved'}</button>`}
          ${!isNew ? '<button type="button" class="ad-btn" data-ms-act="test">Test to me</button>' : ''}
          ${!isNew && !dirty && m.status === 'review' ? '<button type="button" class="ad-btn ms-approve" data-ms-act="approve">Approve</button>' : ''}
          ${!isNew && m.status === 'approved' ? '<button type="button" class="ad-btn" data-ms-act="pause">Pause</button>' : ''}
          ${!isNew && m.status === 'paused' ? '<button type="button" class="ad-btn ad-btn-primary" data-ms-act="resume">Resume</button>' : ''}
          ${!isNew && ['approved', 'paused', 'review'].includes(m.status) ? '<button type="button" class="ad-btn" data-ms-act="cancel">Cancel</button>' : ''}
          ${!isNew && !(m.sentCount > 0) ? '<button type="button" class="ad-btn ms-del" data-ms-act="delete">Delete</button>' : ''}
        </div>
        ${dirty && !isNew && m.status !== 'draft' ? '<p class="ms-note">Changes need your OK again after you save.</p>' : ''}
        <p class="ms-msg" id="ms-msg" hidden></p>
        ${failed.length ? `<div class="ms-failed"><p><b>${failed.length} didn&rsquo;t go</b></p>${failed.map((f) => `<div><span>${h.esc(f.name)} &middot; ${h.esc(f.to)}<em>${h.esc(f.error)}</em></span><button type="button" class="ad-btn ad-btn-small" data-ms-resend="${h.attr(f.bookingId)}">Resend</button></div>`).join('')}</div>` : ''}
      </div>
      <aside class="ad-card ms-card ms-pad">
        <p class="ms-prev-h">Preview &mdash; as ${h.esc(((list[0] || {}).business || {}).name || 'a vendor')} sees it</p>
        <div class="ms-prev" id="ms-prev"></div>
      </aside>
    </div>
  </div>`;
}

function previewHtml(ctx) {
  const { state, h } = ctx;
  const ev = (state.events || []).find((e) => e.id === state.activeEventId) || {};
  const d = state.msgDraft || blankMessage();
  const first = recipients(state.bookings, state.activeEventId, d)[0];
  const v = sampleValues(first, ev);
  return `<div class="ms-mail"><div class="ms-mail-top">SOUNDZGOOD WHITSUNDAYS</div>
    <p class="ms-mail-subj">${h.esc(fill(d.subject, v, String))}</p>
    <div class="ms-mail-body">${bodyHtml(d.body, v, h.esc)}
      <p class="ms-mail-btn"><span>View your invoice &amp; event guide &rarr;</span></p></div>
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
  if (state.activeEventId && state.messagesLoaded && !(state.messages || []).length && !state.msgSeeding && state.msgSeededFor !== state.activeEventId) {
    state.msgSeeding = true;
    state.msgSeededFor = state.activeEventId;
    call('adminMessagesSeed', { eventId: state.activeEventId })
      .catch((e) => window.alert(e.message || 'Could not add the starter messages.'))
      .finally(() => { state.msgSeeding = false; });
  }

  // the invoice email: fetch the real thing (as the first paid vendor got it)
  const frame = document.getElementById('ms-sys-frame');
  if (frame) {
    call('adminMessagePreview', { id: state.msgOpen }).then((r) => {
      const hEl = document.getElementById('ms-sys-h');
      if (hEl) hEl.textContent = 'Exactly what ' + (r.vendor || 'a vendor') + ' received';
      const sEl = document.getElementById('ms-sys-subj');
      if (sEl) sEl.textContent = 'Subject: ' + r.subject;
      frame.srcdoc = r.html;
      frame.onload = () => { try { frame.style.height = frame.contentDocument.documentElement.scrollHeight + 'px'; } catch (e) { /* ignore */ } };
      const l = document.getElementById('ms-sys-link');
      if (l) { l.innerHTML = ''; const a = document.createElement('a'); a.href = r.link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Open their invoice & event guide page →'; l.appendChild(a); }
    }).catch((e) => { const hEl = document.getElementById('ms-sys-h'); if (hEl) hEl.textContent = e.message || 'Could not load the preview.'; });
  }

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
    if (tabBtn) { state.msgTab = tabBtn.getAttribute('data-ms-tab'); render(); return; }
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
      const d = state.msgDraft;
      const n = recipients(state.bookings, state.activeEventId, d).length;
      const day = sendDate(d, ev);
      const esc = ctx.h.esc;
      s.innerHTML = `This sends <b>&ldquo;${esc(fill(d.subject, sampleValues(recipients(state.bookings, state.activeEventId, d)[0], ev), String) || '(no subject yet)')}&rdquo;</b> to <b>${n} ${esc((WHO_SHORT[d.who] || WHO_SHORT.all))}</b>`
        + (day ? ` on <b>${esc(niceDay(day))} at ${SEND_TIME}</b>.` : ' &mdash; <b>pick when</b>.');
    }
    const save = root.querySelector('[data-ms-act="save"]');
    if (save) { save.textContent = 'Save'; save.classList.add('ad-btn-primary'); }
    const appr = root.querySelector('[data-ms-act="approve"]');
    if (appr) appr.remove();   // changed: save first, then approve
  };
  root.addEventListener('input', onEdit);
  root.addEventListener('change', onEdit);
}
