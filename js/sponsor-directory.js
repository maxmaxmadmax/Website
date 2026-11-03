/*  SPONSORS - the sponsorship CRM across every event. Stat cards, a target
    bar, filters, a table of every sponsor record (one per business per
    event) and a profile panel: contact, package & value, payment, the
    promised benefits as a checklist, notes and the next follow-up.

    The records are the per-event docs in `sponsors` (the hub's board, the
    proposal page and the event page read the same ones). Business details
    (logo, colour, website, contact) are copied to the same business on
    every event so they stay in step.                                      */

import { SPONSOR_LEVELS, SPONSOR_GOAL_CENTS } from './sponsor-data.js?v=801';
import { spAvatar, spColor } from './messages.js?v=801';

const LEVEL = Object.fromEntries(SPONSOR_LEVELS.map((l) => [l.key, l]));
const levelName = (k) => (LEVEL[k] ? LEVEL[k].name.split(' - ')[0] : '');
const STATUS = { todo: ['To ask', 'grey'], asked: ['Proposal sent', 'blue'], interested: ['Interested', 'amber'], yes: ['Confirmed', 'green'], no: ['Declined', 'grey'] };
const KIND = { cash: 'Cash', inkind: 'In-kind', prize: 'Prize' };
const key = (name) => String(name || '').trim().toLowerCase();
const money0 = (c) => '$' + Math.round((c || 0) / 100).toLocaleString('en-AU');
const cents = (p) => p.amountCents || (LEVEL[p.level] && LEVEL[p.level].priceCents) || 0;
const today = () => new Date().toISOString().slice(0, 10);
const niceDate = (iso) => iso ? new Date(iso + 'T12:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const perksOf = (p) => (LEVEL[p.level] ? LEVEL[p.level].perks : []);

export function sponsorDirHtml(ctx) {
  const { state, h } = ctx;
  const events = (state.events || []).slice().sort((a, b) => String(b.dateISO || '').localeCompare(String(a.dateISO || '')));
  const evOf = Object.fromEntries(events.map((e) => [e.id, e]));
  const f = state.spDir || (state.spDir = { event: state.activeEventId || '', q: '', status: '', level: '', kind: '' });
  const all = (state.sponsorsAll || []).filter((p) => key(p.business));
  const inEvent = f.event ? all.filter((p) => p.eventId === f.event) : all;
  const q = key(f.q);
  const rows = inEvent.filter((p) => (!f.status || (p.status || 'todo') === f.status) && (!f.level || p.level === f.level) && (!f.kind || (p.kind || 'cash') === f.kind)
    && (!q || [p.business, p.contactName, p.email, p.website, p.notes].some((v) => key(v).includes(q))))
    .sort((a, b) => String((evOf[b.eventId] || {}).dateISO || '').localeCompare(String((evOf[a.eventId] || {}).dateISO || '')) || cents(b) - cents(a) || String(a.business).localeCompare(String(b.business)));

  // THE NUMBERS - for the event picked (or every event)
  const yes = inEvent.filter((p) => p.status === 'yes');
  const confirmed = yes.filter((p) => p.kind !== 'prize').reduce((t, p) => t + cents(p), 0);
  const prizes = yes.filter((p) => p.kind === 'prize');
  const cash = yes.filter((p) => (p.kind || 'cash') === 'cash').reduce((t, p) => t + cents(p), 0);
  const received = yes.reduce((t, p) => t + (p.paidCents || 0), 0);
  const target = SPONSOR_GOAL_CENTS * Math.max(1, f.event ? 1 : new Set(all.map((p) => p.eventId)).size);
  const pct = Math.min(100, Math.round(confirmed / target * 100));
  const overdue = (p) => p.followUpAt && p.followUpAt < today() && !['yes', 'no'].includes(p.status || 'todo');

  const chip = (p) => { const s = STATUS[p.status || 'todo'] || STATUS.todo; return `<span class="ms-chip spd-chip ms-${s[1]}${overdue(p) ? ' is-overdue' : ''}">${overdue(p) ? 'Overdue' : s[0]}</span>`; };
  const row = (p) => {
    const ev = evOf[p.eventId] || {};
    const open = state.spDirRow === p.id;
    return `<tr class="spd-row${state.spDirOpen === p.id ? ' is-open' : ''}" data-spd-row="${h.attr(p.id)}">
      <td class="spd-tog"><button type="button" class="ad-linkish" data-spd-expand="${h.attr(p.id)}" aria-label="Details">${open ? '&#9662;' : '&#9656;'}</button></td>
      <td class="spd-biz"><span class="spd-biz-in" style="--sp-brand:${h.attr(spColor(p))}">${spAvatar(h, p)}<span><b>${h.esc(p.business)}</b>${p.gives ? `<small>${h.esc(p.gives)}</small>` : ''}</span></span></td>
      <td class="spd-ev">${h.esc(ev.name || p.eventId || '')}${ev.subtitle ? `<small>${h.esc(ev.subtitle)}</small>` : ''}</td>
      <td>${h.esc(levelName(p.level) || '—')}</td>
      <td class="spd-num">${cents(p) ? money0(cents(p)) : '—'}</td>
      <td>${h.esc(KIND[p.kind || 'cash'])}</td>
      <td>${chip(p)}</td>
      <td class="spd-fu${overdue(p) ? ' is-overdue' : ''}">${p.followUpAt ? h.esc(niceDate(p.followUpAt)) : '—'}</td>
      <td class="spd-act"><button type="button" class="ad-btn ad-btn-small" data-spd-open="${h.attr(p.id)}">Open profile</button></td>
    </tr>${open ? `<tr class="spd-detail"><td colspan="9"><div class="spd-detail-in">
      <div><b>Contact person</b><span>${h.esc(p.contactName || '—')}</span></div>
      <div><b>Phone / email</b><span>${h.esc(p.phone || '—')}<br>${h.esc(p.email || '—')}</span></div>
      <div><b>Sponsorship value</b><span>${cents(p) ? money0(cents(p)) + ' (' + KIND[p.kind || 'cash'] + ')' : '—'}<br>${h.esc(levelName(p.level) ? 'Package: ' + levelName(p.level) : '')}</span></div>
      <div class="spd-detail-notes"><b>Notes</b><span>${h.esc(p.notes || '—')}</span></div>
      <div><b>Next follow-up</b><span>${p.followUpAt ? h.esc(niceDate(p.followUpAt)) : '—'}</span></div>
    </div></td></tr>` : ''}`;
  };

  const opt = (v, label, cur) => `<option value="${h.attr(v)}"${cur === v ? ' selected' : ''}>${h.esc(label)}</option>`;
  const stat = (cls, icon, label, big) => `<div class="spd-stat is-${cls}"><span class="spd-stat-ico">${icon}</span><div><small>${label}</small><b>${big}</b></div></div>`;

  return `<div class="spd${state.spDirOpen ? ' has-panel' : ''}">
    <div class="spd-main">
      <div class="spd-head">
        <div><h1>Sponsors</h1><p>Sponsorship CRM across every SoundzGood event.</p></div>
        <label class="spd-evpick">Event: <select class="ad-select" data-spd-f="event">${opt('', 'All events', f.event)}${events.map((e) => opt(e.id, e.name + (e.subtitle ? ' - ' + e.subtitle : ''), f.event)).join('')}</select></label>
        <button type="button" class="ad-btn" data-spd-mc${f.event ? '' : ' disabled title="Pick an event first"'}>&#128221; MC sheet</button>
        <button type="button" class="ad-btn ad-btn-primary" data-spd-new>+ Add sponsor</button>
      </div>
      <div class="spd-stats">
        ${stat('target', '&#127919;', 'Target', money0(target))}
        ${stat('yes', '&#10003;', 'Confirmed', money0(confirmed))}
        ${stat('got', '&#128176;', 'Received', money0(received))}
        ${stat('owe', '&#9888;', 'Outstanding', money0(Math.max(0, cash - received)))}
        ${stat('prize', '&#127873;', 'Prizes', String(prizes.length))}
      </div>
      <div class="ad-card spd-bar">
        <div class="spd-bar-l"><div class="spd-bar-t"><b>Sponsorship target progress</b><span>${money0(confirmed)} / ${money0(target)} (${pct}%)</span></div><div class="spd-track"><span style="width:${pct}%"></span></div></div>
        <div class="spd-bar-r"><div><small>Total sponsorship value</small><b>${money0(confirmed)}</b></div><div><small>Cash</small><b class="is-cash">${money0(cash)}</b></div><div><small>In-kind</small><b class="is-kind">${money0(confirmed - cash)}</b></div></div>
      </div>
      <div class="spd-filters">
        <input class="ad-input spd-q" type="search" placeholder="Search sponsors (name, contact, etc.)" value="${h.attr(f.q)}" data-spd-f="q">
        <select class="ad-select" data-spd-f="status">${opt('', 'Status: All', f.status)}${Object.keys(STATUS).map((k) => opt(k, STATUS[k][0], f.status)).join('')}</select>
        <select class="ad-select" data-spd-f="level">${opt('', 'Package: All', f.level)}${SPONSOR_LEVELS.map((l) => opt(l.key, levelName(l.key), f.level)).join('')}</select>
        <select class="ad-select" data-spd-f="kind">${opt('', 'Type: All', f.kind)}${Object.keys(KIND).map((k) => opt(k, KIND[k], f.kind)).join('')}</select>
      </div>
      <div class="ad-card spd-tablewrap">
        <table class="spd-table">
          <thead><tr><th></th><th>Sponsor</th><th>Event</th><th>Package</th><th class="spd-num">Value</th><th>Type</th><th>Status</th><th>Next follow-up</th><th></th></tr></thead>
          <tbody>${rows.map(row).join('') || `<tr><td colspan="9" class="ad-empty">${q || f.status || f.level || f.kind ? 'No sponsor matches those filters.' : 'No sponsors yet. Add one, or ask businesses from the event\'s Sponsors tab.'}</td></tr>`}</tbody>
        </table>
        <p class="spd-count">Showing ${rows.length} of ${inEvent.length} sponsor${inEvent.length === 1 ? '' : 's'}</p>
      </div>
    </div>
    ${state.spDirOpen ? panelHtml(ctx, all, evOf) : ''}
  </div>`;
}

function panelHtml(ctx, all, evOf) {
  const { state, h } = ctx;
  const p = all.find((x) => x.id === state.spDirOpen);
  if (!p) return '';
  const ev = evOf[p.eventId] || {};
  const s = STATUS[p.status || 'todo'] || STATUS.todo;
  const f = (field, label, value, type, extra) => `<label class="sp-f"><span>${label}</span><input class="ad-input" type="${type || 'text'}" value="${h.attr(value || '')}" data-spd-field="${field}"${extra || ''}></label>`;
  const site = String(p.website || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const value = cents(p), paid = p.paidCents || 0, balance = Math.max(0, ((p.kind || 'cash') === 'cash' ? value : 0) - paid);
  const done = new Set(p.delivered || []);
  const perks = perksOf(p);
  const others = all.filter((x) => x.id !== p.id && key(x.business) === key(p.business));
  const notIn = Object.values(evOf).filter((e) => e.id !== p.eventId && !others.some((o) => o.eventId === e.id) && e.status !== 'archived');
  return `<aside class="spd-panel" style="--sp-brand:${h.attr(spColor(p))}">
    <div class="spd-panel-top"><span>Sponsor profile</span><button type="button" class="ad-drawer-close" data-spd-close aria-label="Close">&times;</button></div>
    <div class="spd-panel-id">
      <div class="spd-panel-logo">${spAvatar(h, p, true)}
        <label class="ad-btn ad-btn-small">${p.logo ? 'Change logo' : 'Upload logo'}<input type="file" accept="image/*" data-spd-logo hidden></label>
        ${site ? `<button type="button" class="ad-btn ad-btn-small" data-spd-findlogo title="Grabs the icon from ${h.attr(site)}">Find from website</button>` : ''}
      </div>
      <div class="spd-panel-name">
        <h2>${h.esc(p.business)}</h2>
        <span class="ms-chip spd-chip ms-${s[1]}">${s[0]}</span>
        <p>${h.esc(levelName(p.level) ? levelName(p.level) + ' sponsor' : 'No package yet')} &middot; ${h.esc(ev.name || p.eventId || '')}${ev.subtitle ? ' - ' + h.esc(ev.subtitle) : ''}</p>
      </div>
    </div>
    <div class="spd-panel-body">
      <div class="spd-2">
        <section class="spd-box"><h3>Contact details</h3>
          ${f('contactName', 'Contact person', p.contactName)}
          ${f('phone', 'Phone', p.phone, 'tel')}
          ${f('email', 'Email', p.email, 'email')}
          ${f('website', 'Website', p.website, 'url', ' placeholder="https://"')}
          <label class="sp-f"><span>Brand colour</span><span class="sp-color"><input type="color" value="${h.attr(spColor(p))}" data-spd-field="color"><code>${h.esc(spColor(p))}</code></span></label>
        </section>
        <section class="spd-box"><h3>Package &amp; value</h3>
          <label class="sp-f"><span>Package</span><select class="ad-select" data-spd-doc="level"><option value="">Package&hellip;</option>${SPONSOR_LEVELS.map((l) => `<option value="${l.key}"${p.level === l.key ? ' selected' : ''}>${h.esc(levelName(l.key))}${l.priceCents ? ' ' + money0(l.priceCents) : ''}</option>`).join('')}</select></label>
          <label class="sp-f"><span>Value</span><input class="ad-input" data-spd-money="amountCents" placeholder="${h.attr(LEVEL[p.level] && LEVEL[p.level].priceCents ? money0(LEVEL[p.level].priceCents) + ' (package price)' : '$')}" value="${p.amountCents ? Math.round(p.amountCents / 100) : ''}"></label>
          <label class="sp-f"><span>Type</span><select class="ad-select" data-spd-doc="kind">${Object.keys(KIND).map((k) => `<option value="${k}"${(p.kind || 'cash') === k ? ' selected' : ''}>${KIND[k]}</option>`).join('')}</select></label>
          <label class="sp-f"><span>What they give ${(p.kind || 'cash') === 'cash' ? '(optional)' : ''}</span><input class="ad-input" data-spd-doc="gives" maxlength="200" placeholder="${(p.kind || 'cash') === 'prize' ? 'e.g. $100 voucher, a hamper, 2 x dinner for two' : 'e.g. the stage, printing, PA hire'}" value="${h.attr(p.gives || '')}"></label>
          <label class="sp-f"><span>Status</span><select class="ad-select" data-spd-doc="status">${Object.keys(STATUS).map((k) => `<option value="${k}"${(p.status || 'todo') === k ? ' selected' : ''}>${STATUS[k][0]}</option>`).join('')}</select></label>
          <label class="sp-f"><span>Next follow-up</span><input class="ad-input" type="date" data-spd-doc="followUpAt" value="${h.attr(p.followUpAt || '')}"></label>
        </section>
      </div>
      <div class="spd-2">
        <section class="spd-box"><h3>Invoice &amp; payment</h3>
          <dl class="spd-dl"><dt>Total value</dt><dd>${money0(value)}</dd><dt>Paid</dt><dd>${money0(paid)}</dd><dt>Balance</dt><dd>${money0(balance)}</dd></dl>
          <label class="sp-f"><span>Paid so far</span><input class="ad-input" data-spd-money="paidCents" placeholder="$" value="${paid ? Math.round(paid / 100) : ''}"></label>
          ${f('invoiceRef', 'Invoice no.', p.invoiceRef, 'text', ' data-spd-doc="invoiceRef"')}
          ${(p.kind || 'cash') === 'prize' ? '<p class="ad-seat-hint">A prize - nothing to invoice.</p>' : ''}${value && (p.kind || 'cash') === 'cash' ? (balance ? `<span class="ms-chip spd-chip ms-amber">${money0(balance)} outstanding</span>` : '<span class="ms-chip spd-chip ms-green">&#10003; Paid in full</span>') : ''}
        </section>
        <section class="spd-box"><h3>Promised benefits</h3>
          ${perks.length ? `<ul class="spd-perks">${perks.map((t) => `<li><label><input type="checkbox" data-spd-perk="${h.attr(t)}"${done.has(t) ? ' checked' : ''}> ${h.esc(t)}</label></li>`).join('')}</ul><p class="ad-seat-hint">${done.size} of ${perks.length} delivered</p>` : '<p class="ad-seat-hint">Pick a package to see what we promised.</p>'}
        </section>
      </div>
      <section class="spd-box"><h3>Notes</h3><textarea class="ad-input" rows="4" data-spd-doc="notes" placeholder="Agreement, artwork, who to call&hellip;">${h.esc(p.notes || '')}</textarea>${p.message ? `<div class="sp-theirs"><b>Their message</b><p>${h.esc(p.message)}</p></div>` : ''}</section>
      ${others.length ? `<section class="spd-box"><h3>Also on</h3><ul class="spd-evlist">${others.map((o) => `<li><a href="#" data-spd-open="${h.attr(o.id)}">${h.esc((evOf[o.eventId] || {}).name || o.eventId)}</a><em>${h.esc((evOf[o.eventId] || {}).dateLabel || '')}</em><span class="ms-chip spd-chip ms-${(STATUS[o.status || 'todo'] || STATUS.todo)[1]}">${(STATUS[o.status || 'todo'] || STATUS.todo)[0]}</span></li>`).join('')}</ul></section>` : ''}
    </div>
    <div class="spd-panel-acts">
      ${p.email ? `<a class="ad-btn" href="mailto:${h.attr(p.email)}">Email</a>` : ''}
      <a class="ad-btn" href="/sponsor?e=${encodeURIComponent(p.eventId || '')}${p.token ? '&t=' + encodeURIComponent(p.token) : ''}" target="_blank" rel="noopener">Proposal &#8599;</a>
      <a class="ad-btn" href="#/event?id=${encodeURIComponent(p.eventId || '')}&tab=sponsors">Event board</a>
      ${notIn.length ? `<select class="ad-select" data-spd-addto><option value="">Add to another event&hellip;</option>${notIn.map((e) => `<option value="${h.attr(e.id)}">${h.esc(e.name)}${e.subtitle ? ' - ' + h.esc(e.subtitle) : ''}</option>`).join('')}</select>` : ''}
      <button type="button" class="ad-btn ms-sp-del-btn" data-spd-del>Remove</button>
    </div>
  </aside>`;
}

export function wireSponsorDir(ctx) {
  const { state, render, sponsors, upload } = ctx;
  const root = document.getElementById('ad-desk');
  if (!root) return;
  const current = () => (state.sponsorsAll || []).find((x) => x.id === state.spDirOpen);
  const sameBiz = (p) => (state.sponsorsAll || []).filter((x) => key(x.business) === key(p.business));
  const updateBiz = async (p, patch) => { for (const d of sameBiz(p)) await sponsors.update(d.id, patch); };
  const toCents = (v) => Math.max(0, Math.round(Number(String(v).replace(/[^0-9.]/g, '')) * 100) || 0);

  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-spd-close]')) { state.spDirOpen = null; render(); return; }
    const ex = e.target.closest('[data-spd-expand]');
    if (ex) { const id = ex.getAttribute('data-spd-expand'); state.spDirRow = state.spDirRow === id ? null : id; render(); return; }
    const op = e.target.closest('[data-spd-open]');
    if (op) { e.preventDefault(); state.spDirOpen = op.getAttribute('data-spd-open'); render(); return; }
    const tr = e.target.closest('[data-spd-row]');
    if (tr && !e.target.closest('a, button, input, label, select')) { const id = tr.getAttribute('data-spd-row'); state.spDirRow = state.spDirRow === id ? null : id; render(); return; }
    if (e.target.closest('[data-spd-mc]')) { openMcSheet(ctx); return; }
    if (e.target.closest('[data-spd-new]')) {
      const name = window.prompt('Business name');
      if (!name || !name.trim()) return;
      const f = state.spDir || {};
      if (!f.event && !state.activeEventId) { window.alert('Pick an event first.'); return; }
      await sponsors.add({ business: name.trim().slice(0, 120), source: 'manual', eventId: f.event || state.activeEventId });
      return;
    }
    const p = current();
    if (!p) return;
    if (e.target.closest('[data-spd-findlogo]')) {
      const host = String(p.website || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
      if (!host) { window.alert('Add their website first.'); return; }
      await updateBiz(p, { logo: 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=256' });
      return;
    }
    if (e.target.closest('[data-spd-del]')) {
      if (!window.confirm('Remove ' + p.business + ' from ' + ((state.events || []).find((x) => x.id === p.eventId) || {}).name + '? Their other events stay.')) return;
      state.spDirOpen = null;
      await sponsors.remove(p.id);
    }
  });

  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('[data-spd-f="q"]')) { state.spDir.q = t.value; const pos = t.selectionStart; render(); const again = root.querySelector('[data-spd-f="q"]'); if (again) { again.focus(); again.setSelectionRange(pos, pos); } }
  });

  root.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.matches('[data-spd-f]') && t.getAttribute('data-spd-f') !== 'q') { state.spDir[t.getAttribute('data-spd-f')] = t.value; render(); return; }
    const p = current();
    if (!p) return;
    if (t.matches('[data-spd-field]')) {          // business-wide
      const field = t.getAttribute('data-spd-field');
      let value = String(t.value || '').trim().slice(0, 200);
      if (field === 'color' && !/^#[0-9a-f]{6}$/i.test(value)) value = '';
      if (field === 'website' && value && !/^https?:\/\//i.test(value)) value = 'https://' + value;
      if (field === 'invoiceRef') { await sponsors.update(p.id, { invoiceRef: value }); return; }
      await updateBiz(p, { [field]: value });
      return;
    }
    if (t.matches('[data-spd-doc]')) {            // this event only
      const field = t.getAttribute('data-spd-doc');
      await sponsors.update(p.id, { [field]: String(t.value || '').trim().slice(0, field === 'notes' ? 2000 : 200) });
      return;
    }
    if (t.matches('[data-spd-money]')) { await sponsors.update(p.id, { [t.getAttribute('data-spd-money')]: toCents(t.value) }); return; }
    if (t.matches('[data-spd-perk]')) {
      const perk = t.getAttribute('data-spd-perk');
      const done = new Set(p.delivered || []);
      if (t.checked) done.add(perk); else done.delete(perk);
      await sponsors.update(p.id, { delivered: [...done] });
      return;
    }
    if (t.matches('[data-spd-addto]') && t.value) {
      await sponsors.add({ business: p.business, contactName: p.contactName || '', email: p.email || '', phone: p.phone || '', website: p.website || '', logo: p.logo || '', color: p.color || '', source: 'past', eventId: t.value });
      return;
    }
    if (t.matches('[data-spd-logo]')) {
      const file = t.files && t.files[0];
      if (!file || !upload) return;
      try { const url = await upload(file, 'sponsor-logos/' + p.id + '/'); await updateBiz(p, { logo: url }); }
      catch (err) { window.alert('Upload failed - ' + (err.message || 'try again')); }
    }
  });
}

/*  THE MC SHEET - one printable page for the day: every confirmed sponsor
    with their package and what we promised (thank-yous from the stage),
    and every prize with who gave it. Opens in a new tab; print or save
    as PDF from there.                                                     */
function openMcSheet(ctx) {
  const { state, h } = ctx;
  const f = state.spDir || {};
  const ev = (state.events || []).find((e) => e.id === f.event);
  if (!ev) { window.alert('Pick an event first.'); return; }
  const yes = (state.sponsorsAll || []).filter((p) => p.eventId === ev.id && p.status === 'yes');
  const order = { platinum: 0, gold: 1, silver: 2, bronze: 3, supporter: 4 };
  const sponsors = yes.filter((p) => p.kind !== 'prize').sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9) || cents(b) - cents(a) || String(a.business).localeCompare(String(b.business)));
  const prizes = yes.filter((p) => p.kind === 'prize').sort((a, b) => String(a.business).localeCompare(String(b.business)));
  const thanks = (p) => { const m = /(\d+)\s*thank-you/i.exec(perksOf(p).join(' ')); return m ? +m[1] : (p.level ? 1 : 0); };
  const logo = (p) => (p.logo && /^(https:\/\/|\/)/.test(p.logo)) ? `<img src="${h.attr(p.logo)}" alt="">` : '';
  const spRow = (p) => `<tr><td class="logo">${logo(p)}</td><td><b>${h.esc(p.business)}</b>${p.website ? `<br><small>${h.esc(String(p.website).replace(/^https?:\/\//, ''))}</small>` : ''}</td>
    <td>${h.esc(levelName(p.level) || KIND[p.kind || 'cash'])}${p.gives ? `<br><small>${h.esc(p.gives)}</small>` : ''}</td>
    <td class="num">${thanks(p) || '—'}</td>
    <td class="tick">${Array.from({ length: Math.max(1, thanks(p)) }, () => '<span></span>').join('')}</td>
    <td>${h.esc(p.mcNote || p.notes || '')}</td></tr>`;
  const przRow = (p) => `<tr><td class="logo">${logo(p)}</td><td><b>${h.esc(p.business)}</b>${p.contactName ? `<br><small>${h.esc(p.contactName)}${p.phone ? ' &middot; ' + h.esc(p.phone) : ''}</small>` : ''}</td><td>${h.esc(p.gives || '—')}</td><td class="tick"><span></span></td><td>${h.esc(p.notes || '')}</td></tr>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>MC sheet - ${h.esc(ev.name)}</title>
<style>
  body{ font:14px/1.45 Arial, Helvetica, sans-serif; color:#111; margin:0; padding:28px 32px; }
  h1{ font-size:26px; margin:0 0 2px; } h1 small{ font-size:14px; font-weight:normal; color:#666; display:block; margin-top:4px; }
  h2{ font-size:16px; margin:26px 0 8px; padding-bottom:6px; border-bottom:2px solid #ff6b00; }
  table{ width:100%; border-collapse:collapse; } th{ text-align:left; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:#666; padding:6px 8px; border-bottom:1px solid #ddd; }
  td{ padding:8px; border-bottom:1px solid #e6e6e6; vertical-align:top; } td.logo{ width:46px; } td.logo img{ width:40px; height:40px; object-fit:contain; border:1px solid #e6e6e6; border-radius:6px; background:#fff; }
  td.num{ text-align:center; width:60px; } td.tick{ white-space:nowrap; } td.tick span{ display:inline-block; width:16px; height:16px; border:1.5px solid #333; border-radius:4px; margin-right:4px; vertical-align:middle; }
  small{ color:#666; } .bar{ display:flex; gap:10px; margin:0 0 18px; } .bar button{ font:inherit; padding:8px 14px; border:1px solid #333; border-radius:8px; background:#fff; cursor:pointer; }
  .note{ margin-top:22px; padding:12px 14px; border:1px dashed #bbb; border-radius:8px; color:#444; }
  @media print{ .bar{ display:none; } body{ padding:0; } h2{ break-after:avoid; } tr{ break-inside:avoid; } }
</style></head><body>
<div class="bar"><button onclick="print()">Print / save as PDF</button></div>
<h1>MC sheet - ${h.esc(ev.name)}${ev.subtitle ? ' ' + h.esc(ev.subtitle) : ''}<small>${h.esc(ev.dateLabel || '')}${ev.venue ? ' &middot; ' + h.esc(ev.venue) : ''} &middot; tick each thank-you as you do it</small></h1>
<h2>Sponsors to thank (${sponsors.length})</h2>
${sponsors.length ? `<table><thead><tr><th></th><th>Business</th><th>Package / what they gave</th><th>Thank-yous</th><th>Done</th><th>Say this</th></tr></thead><tbody>${sponsors.map(spRow).join('')}</tbody></table>` : '<p><small>No confirmed sponsors yet.</small></p>'}
<h2>Prizes (${prizes.length})</h2>
${prizes.length ? `<table><thead><tr><th></th><th>From</th><th>The prize</th><th>Given</th><th>Notes</th></tr></thead><tbody>${prizes.map(przRow).join('')}</tbody></table>` : '<p><small>No prizes yet - add a business with type Prize.</small></p>'}
<div class="note">Platinum = presenting partner: say "${h.esc(ev.name)} presented by [them]" on opening and closing. Thank every sponsor at least once before the headline act and again at the end of the night.</div>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { window.alert('Your browser blocked the new tab - allow pop-ups for this site.'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}
