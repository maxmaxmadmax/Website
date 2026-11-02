/* ==========================================================================
   EVENT HUB  -  one event, every part of it under tabs

   Overview and Budget are drawn here. The other tabs are the existing
   admin pages (Vendors, Sites & Map, Entertainment, Messages, Sponsors)
   rendered by admin-app.js and passed in as `inner`.

   Pure functions - no Firebase, no page state. admin-app.js passes in
   state and the helpers (esc, attr, money) and wires the clicks.
   ========================================================================== */

import { SPONSOR_LEVELS } from './sponsor-data.js?v=780';

const LEVEL = Object.fromEntries(SPONSOR_LEVELS.map((l) => [l.key, l]));

export const HUB_TABS = [
  ['overview', 'Overview'], ['budget', 'Budget'], ['vendors', 'Vendors'], ['map', 'Sites & Map'],
  ['programme', 'Programme'], ['messages', 'Messages'], ['sponsors', 'Sponsors'], ['website', 'Website'],
];

/* the lines a new budget starts with - income first, then costs */
export const BUDGET_STARTER = [
  { name: 'Vendor site fees', kind: 'income', auto: 'vendors' },
  { name: 'Sponsorship', kind: 'income', auto: 'sponsors' },
  { name: 'Bar & drinks', kind: 'income' },
  { name: 'Entertainment & activities', kind: 'cost', auto: 'programme' },
  { name: 'Equipment & production', kind: 'cost' },
  { name: 'Marketing & posters', kind: 'cost' },
  { name: 'Staff & security', kind: 'cost' },
  { name: 'Permits, insurance & venue', kind: 'cost' },
  { name: 'Other', kind: 'cost' },
];

const isoToday = () => {
  const n = new Date();
  return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
};

/* 'today' | 'upcoming' | 'past' */
export function eventGroup(ev) {
  if (!ev.dateISO) return 'upcoming';
  const t = isoToday();
  return ev.dateISO < t ? 'past' : ev.dateISO === t ? 'today' : 'upcoming';
}

const paid = (b) => b.status === 'confirmed' || b.paymentStatus === 'paid';
const bCents = (b) => (b.totalCents != null ? b.totalCents : (b.amountCents || 0));
const sponsorCents = (p) => (LEVEL[p.level] && LEVEL[p.level].priceCents) || 0;

/* the numbers every tab shares */
export function eventFigures(ctx) {
  const bookings = (ctx.bookings || []).filter((b) => b.eventId === ctx.ev.id && b.status !== 'cancelled');
  const paidList = bookings.filter(paid);
  const sponsors = (ctx.sponsors || []).filter((p) => p.eventId === ctx.ev.id);
  const sites = ctx.sites || [];
  return {
    vendorCents: paidList.reduce((t, b) => t + bCents(b), 0),
    sponsorYes: sponsors.filter((p) => p.status === 'yes').reduce((t, p) => t + sponsorCents(p), 0),
    sponsorMaybe: sponsors.filter((p) => p.status === 'interested').reduce((t, p) => t + sponsorCents(p), 0),
    paidCount: paidList.length,
    unpaidCount: bookings.length - paidList.length,
    unseated: paidList.filter((b) => !b.siteLabel).length,
    filled: sites.filter((s) => s.status === 'booked' || s.status === 'held').length,
    totalSites: sites.length,
    waiting: (ctx.waitlist || []).filter((w) => w.eventId === ctx.ev.id && w.status === 'waiting').length,
    programmeCents: (ctx.programme || []).reduce((t, p) => t + (p.costCents || 0), 0),
  };
}

/* budget lines with the automatic actuals filled in */
export function budgetLines(ctx, f) {
  return (ctx.budget || []).map((l) => {
    const actual = l.auto === 'vendors' ? f.vendorCents : l.auto === 'sponsors' ? f.sponsorYes : l.auto === 'programme' ? f.programmeCents : (l.actualCents || 0);
    return { ...l, actualCents: actual };
  });
}
const sum = (rows, k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
export function budgetTotals(lines) {
  const inc = lines.filter((l) => l.kind === 'income'), cost = lines.filter((l) => l.kind !== 'income');
  return {
    plannedIn: sum(inc, 'plannedCents'), actualIn: sum(inc, 'actualCents'),
    plannedOut: sum(cost, 'plannedCents'), actualOut: sum(cost, 'actualCents'),
  };
}

/* ---------- the page ---------- */
export function eventHubHtml(ctx) {
  const { ev, tab, h } = ctx;
  const esc = h.esc, attr = h.attr;
  const grp = eventGroup(ev);
  return `
    <div class="ev-hub">
      <div class="ad-page-head ev-hub-head">
        <div>
          <p class="ev-hub-crumb"><a href="#/events">Events</a> &rsaquo; ${esc(grp === 'past' ? 'Past' : grp === 'today' ? 'Today' : 'Upcoming')}</p>
          <h1>${esc(ev.name || ev.id)}</h1>
          <p>${esc(ev.dateLabel || ev.dateISO || 'No date set')}${ev.venue ? ' &middot; ' + esc(ev.venue) : ''}${ev.location ? ', ' + esc(ev.location) : ''}</p>
        </div>
        <div class="ad-page-actions">
          ${ctx.eventPill(ev.status)}
          <button type="button" class="ad-btn" data-edit-ev="${attr(ev.id)}">Edit details</button>
          ${ev.status === 'open'
            ? `<button type="button" class="ad-btn" data-close-ev="${attr(ev.id)}" data-confirm="Close vendor signup for ${attr(ev.name || ev.id)}? Nobody new can take a site.">Close signup</button>`
            : `<button type="button" class="ad-btn" data-open-ev="${attr(ev.id)}" data-confirm="Open vendor signup for ${attr(ev.name || ev.id)}?">Open signup</button>`}
        </div>
      </div>
      <div class="ev-tabs" role="tablist">
        ${HUB_TABS.map(([k, label]) => `<a role="tab" class="ev-tab${tab === k ? ' is-on' : ''}" href="#/event?id=${attr(ev.id)}&tab=${k}">${label}</a>`).join('')}
      </div>
      <div class="ev-hub-body">
        ${tab === 'overview' ? overviewHtml(ctx) : tab === 'budget' ? budgetHtml(ctx) : tab === 'website' ? websiteHtml(ctx) : tab === 'programme' ? programmeHtml(ctx) : (ctx.inner || '')}
      </div>
      <p class="ad-action-msg" id="ad-action-msg" hidden></p>
    </div>`;
}

function card(title, big, sub, tone) {
  return `<div class="ad-card ev-card${tone ? ' ' + tone : ''}"><p class="ev-card-t">${title}</p><p class="ev-card-big">${big}</p>${sub ? `<p class="ev-card-sub">${sub}</p>` : ''}</div>`;
}

function overviewHtml(ctx) {
  const { ev, h } = ctx;
  const esc = h.esc, attr = h.attr, money = h.money;
  const f = eventFigures(ctx);
  const lines = budgetLines(ctx, f);
  const t = budgetTotals(lines);
  const hasBudget = lines.length > 0;
  const profit = t.actualIn - t.actualOut;
  return `
    <div class="ev-grid">
      ${card('Sites filled', `${f.filled} <small>of ${f.totalSites}</small>`, f.unseated ? f.unseated + ' paid vendor' + (f.unseated === 1 ? '' : 's') + ' with no site' : 'Everyone paid has a site')}
      ${card('Vendors paid', String(f.paidCount), f.unpaidCount ? f.unpaidCount + ' still to pay' : 'Nobody owing')}
      ${card('Money in', esc(money(f.vendorCents + f.sponsorYes)), esc(money(f.vendorCents)) + ' vendor fees &middot; ' + esc(money(f.sponsorYes)) + ' sponsors' + (f.sponsorMaybe ? ' (+' + esc(money(f.sponsorMaybe)) + ' interested)' : ''))}
      ${hasBudget
        ? card('Profit so far', esc(money(profit)), esc(money(t.actualOut)) + ' spent of ' + esc(money(t.plannedOut)) + ' planned', profit < 0 ? 'is-bad' : 'is-good')
        : card('Budget', '&mdash;', 'No budget yet - start one on the Budget tab')}
      ${card('Waitlist', String(f.waiting), f.waiting ? 'waiting for a spot' : 'nobody waiting')}
    </div>
`;
}

function budgetHtml(ctx) {
  const { h } = ctx;
  const esc = h.esc, attr = h.attr, money = h.money;
  const f = eventFigures(ctx);
  const lines = budgetLines(ctx, f);
  if (!lines.length) {
    return `
      <div class="ad-card ev-empty">
        <h2>No budget yet</h2>
        <p>Start with the usual lines - vendor fees and sponsorship fill themselves in from what's been paid. Add, rename or remove anything after.</p>
        <button type="button" class="ad-btn ad-btn-primary" id="ev-bud-seed">Start the budget</button>
      </div>`;
  }
  const t = budgetTotals(lines);
  const dollars = (c) => (c ? (c / 100).toFixed(2) : '');
  const diffCell = (l) => {
    const d = l.kind === 'income' ? l.actualCents - l.plannedCents : l.plannedCents - l.actualCents;
    if (!l.plannedCents && !l.actualCents) return '<td class="ev-bud-diff">&nbsp;</td>';
    return `<td class="ev-bud-diff ${d < 0 ? 'is-bad' : 'is-good'}">${d < 0 ? '&minus;' : '+'}${esc(money(Math.abs(d)))}</td>`;
  };
  const rowHtml = (l) => `
    <tr data-bud-row="${attr(l.id)}">
      <td><input class="ad-input ev-bud-name" value="${attr(l.name || '')}" data-bud="name" data-id="${attr(l.id)}" placeholder="Line"></td>
      <td><input class="ad-input ev-bud-num" type="number" step="0.01" min="0" value="${dollars(l.plannedCents)}" data-bud="plannedCents" data-id="${attr(l.id)}" placeholder="0.00"></td>
      <td>${l.auto
        ? `<span class="ev-bud-auto" title="Filled in from ${l.auto === 'vendors' ? 'paid vendor bookings' : l.auto === 'sponsors' ? 'sponsors who said yes' : 'the Programme tab'}">${esc(money(l.actualCents))} <small>auto</small></span>`
        : `<input class="ad-input ev-bud-num" type="number" step="0.01" min="0" value="${dollars(l.actualCents)}" data-bud="actualCents" data-id="${attr(l.id)}" placeholder="0.00">`}</td>
      ${diffCell(l)}
      <td class="ev-bud-x"><button type="button" class="ad-linkish" data-bud-del="${attr(l.id)}" aria-label="Remove ${attr(l.name || 'line')}">&times;</button></td>
    </tr>`;
  const section = (kind, title, pIn, aIn) => `
    <tbody>
      <tr class="ev-bud-h"><th>${title}</th><th>Planned</th><th>Actual</th><th>Diff</th><th></th></tr>
      ${lines.filter((l) => (l.kind === 'income') === (kind === 'income')).map(rowHtml).join('')}
      <tr class="ev-bud-tot"><td>Total ${title.toLowerCase()}</td><td>${esc(money(pIn))}</td><td>${esc(money(aIn))}</td><td></td><td></td></tr>
    </tbody>`;
  const pp = t.plannedIn - t.plannedOut, ap = t.actualIn - t.actualOut;
  return `
    <div class="ev-grid ev-grid-3">
      ${card('Planned profit', esc(money(pp)), esc(money(t.plannedIn)) + ' in &middot; ' + esc(money(t.plannedOut)) + ' out', pp < 0 ? 'is-bad' : '')}
      ${card('Actual so far', esc(money(ap)), esc(money(t.actualIn)) + ' in &middot; ' + esc(money(t.actualOut)) + ' out', ap < 0 ? 'is-bad' : 'is-good')}
      ${card('Still to spend', esc(money(Math.max(0, t.plannedOut - t.actualOut))), 'of the planned costs')}
    </div>
    <div class="ad-card ev-bud-card">
      <table class="ev-bud">
        ${section('income', 'Income', t.plannedIn, t.actualIn)}
        ${section('cost', 'Costs', t.plannedOut, t.actualOut)}
      </table>
      <form class="ev-bud-add" id="ev-bud-add">
        <select class="ad-select" name="kind"><option value="cost">Cost</option><option value="income">Income</option></select>
        <input class="ad-input" name="name" placeholder="New line, e.g. Fireworks" required maxlength="80">
        <input class="ad-input ev-bud-num" name="planned" type="number" step="0.01" min="0" placeholder="Planned $">
        <button type="submit" class="ad-btn">Add line</button>
      </form>
      <p class="ad-seat-hint">Amounts save as you type. Vendor fees and sponsorship fill in by themselves.</p>
    </div>`;
}

export const NOTICE_WORD = { venue: 'Venue change', postponed: 'Postponed', cancelled: 'Cancelled', info: 'Update' };
function websiteHtml(ctx) {
  const { ev, h } = ctx;
  const esc = h.esc, attr = h.attr, money = h.money;
  const p = ev.pricing || {};
  const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  const n = ev.notice || {};
  return `
    <div class="ad-card ev-pad ev-notice-box${n.kind ? ' is-on is-' + attr(n.kind) : ''}">
      <div class="ev-notice-top">
        <div>
          <h2>Notice</h2>
          ${n.kind ? `<p class="ev-notice-cur"><span class="ad-pill ${n.kind === 'cancelled' ? 'ad-pill-red' : 'ad-pill-amber'}">${esc(NOTICE_WORD[n.kind] || n.kind)}</span> <b>${esc(n.title || '')}</b>${n.text ? ' &mdash; ' + esc(n.text) : ''}</p>`
            : '<p class="ad-drawer-text">Nothing up. Use these when plans change at the last minute - it goes on the public page within a minute, and you can email the vendors straight after.</p>'}
        </div>
        ${n.kind ? '<button type="button" class="ad-btn" data-notice="clear">Take it down</button>' : ''}
      </div>
      <div class="ad-actions-row ev-notice-acts">
        <button type="button" class="ad-btn ad-btn-primary" data-notice="venue">&#127783; Change venue</button>
        <button type="button" class="ad-btn" data-notice="postponed">&#128197; Postpone</button>
        <button type="button" class="ad-btn" data-notice="info">&#128227; Post an update</button>
        <button type="button" class="ad-btn ad-btn-danger" data-notice="cancelled">Cancel the event</button>
      </div>
    </div>
    <div class="ev-grid ev-grid-2">
      <div class="ad-card ev-pad">
        <h2>What the website shows</h2>
        <dl class="ad-kvs">
          ${row('Name', esc(ev.name || ''))}
          ${row('Tagline', esc(ev.subtitle || '&mdash;'))}
          ${row('Date', esc(ev.dateLabel || ev.dateISO || '&mdash;'))}
          ${row('Venue', esc([ev.venue, ev.location].filter(Boolean).join(', ') || '&mdash;'))}
          ${row('Food stall', esc(money(p.food)))}
          ${row('Market bay', esc(money(p.marketPerBay)))}
          ${row('Times', ev.startTime ? esc(ev.startTime) + (ev.finishTime ? ' &ndash; ' + esc(ev.finishTime) : '') : '&mdash;')}
          ${row('Intro', esc(ev.intro || '&mdash;'))}
          ${row('Signup', ev.status === 'open' ? 'Open - vendors can book' : esc(ev.status || 'closed'))}
        </dl>
        <div class="ad-actions-row">
          <button type="button" class="ad-btn ad-btn-primary" data-edit-ev="${attr(ev.id)}">Edit details</button>
          <a class="ad-btn" href="/event?e=${attr(ev.id)}" target="_blank" rel="noopener">View the live page &rarr;</a>
          <a class="ad-btn" href="/vendor-signup" target="_blank" rel="noopener">Vendor signup page &rarr;</a>
        </div>
      </div>
      <div class="ad-card ev-pad">
        <h2>Where it's used</h2>
        <p class="ad-drawer-text">The live page at <code>/event?e=${esc(ev.id)}</code> is built from this event: poster, facts, notice, programme, paid vendors and sponsors. Edit details, and it changes within a minute.</p>
        <p class="ad-drawer-text">Moved venue or changed the date? Edit it once, then send vendors a message from the Messages tab.</p>
      </div>
    </div>`;
}

/* ---------- the Events page: one wide card per event ---------- */
const EVENT_POSTERS = [
  { match: (ev) => /eatz/i.test(ev.name || '') && String(ev.dateISO || '').startsWith('2026-10-31'), url: '/images/events/eatz-beatz-halloween-2026-v3.webp' },
];
export function posterOf(ev) {
  if (ev.image && /^(https:\/\/|\/)[^\s'"()<>\\]*$/.test(ev.image)) return ev.image;
  const p = EVENT_POSTERS.find((x) => x.match(ev));
  return p ? p.url : '';
}

/*  ctx: { ev, active, figures|null, budget, h, eventPill }. Figures are
    only known for the active event (its bookings are the ones subscribed). */
export function eventCardHtml(ctx) {
  const { ev, active, h } = ctx;
  const esc = h.esc, attr = h.attr, money = h.money;
  const f = ctx.figures;
  const lines = f ? budgetLines({ budget: ctx.budget || [] }, f) : [];
  const t = budgetTotals(lines);
  const revenue = f ? f.vendorCents + f.sponsorYes : 0;
  const expenses = t.actualOut;
  const profit = revenue - expenses;
  const poster = posterOf(ev);
  const grp = eventGroup(ev);
  const stat = (big, label) => `<div class="ev-stat"><b>${big}</b><span>${label}</span></div>`;
  const dash = '<b class="is-dim">&mdash;</b>';
  return `
    <article class="ad-card ev-banner${active ? ' is-active' : ''}${grp === 'past' ? ' is-past' : ''}" data-open-hub="${attr(ev.id)}">
      <div class="ev-banner-art${poster ? '' : ' is-blank'}"${poster ? ` style="background-image:url('${attr(poster)}')"` : ''}>
        ${poster ? `<div class="ev-poster" style="background-image:url('${attr(poster)}')"></div>` : '<span>No poster yet<br><small>Edit &rsaquo; Upload poster</small></span>'}
      </div>
      <div class="ev-banner-main">
        <header class="ev-banner-head">
          <div>
            <p class="ev-banner-kicker">${grp === 'past' ? 'Past event' : grp === 'today' ? 'Tonight' : 'Upcoming'}${active ? ' &middot; <b>active</b>' : ''}${ev.notice && ev.notice.kind ? ` &middot; <span class="ev-notice-tag is-${attr(ev.notice.kind)}">${esc({ venue: 'Venue change', postponed: 'Postponed', cancelled: 'Cancelled', info: 'Update' }[ev.notice.kind] || 'Notice')}</span>` : ''}</p>
            <h2>${esc(ev.name || ev.id)}</h2>
            <p class="ev-banner-when">${esc(ev.dateLabel || ev.dateISO || 'No date set')}${ev.venue ? ' &middot; ' + esc(ev.venue) : ''}${ev.location ? ', ' + esc(ev.location) : ''}</p>
          </div>
          ${ctx.eventPill(ev.status)}
        </header>

        <div class="ev-banner-stats">
          ${f ? stat(`${f.filled} <small>/ ${f.totalSites}</small>`, 'sites filled') : stat(dash, 'sites filled')}
          ${f ? stat(String(f.paidCount), 'vendors paid' + (f.unpaidCount ? ` <em>&middot; ${f.unpaidCount} owing</em>` : '')) : stat(dash, 'vendors paid')}
          ${f ? stat(String(f.waiting), 'on the waitlist') : stat(dash, 'on the waitlist')}
          ${stat(esc(money(ev.pricing && ev.pricing.food)) + ' <small>/ ' + esc(money(ev.pricing && ev.pricing.marketPerBay)) + '</small>', 'food stall / market bay')}
        </div>

        <div class="ev-banner-money">
          <div class="ev-money is-in"><span>Revenue</span><b>${f ? esc(money(revenue)) : '&mdash;'}</b><small>${f ? esc(money(f.vendorCents)) + ' vendors &middot; ' + esc(money(f.sponsorYes)) + ' sponsors' : 'open the event to see'}</small></div>
          <div class="ev-money is-out"><span>Expenses</span><b>${f && lines.length ? esc(money(expenses)) : '&mdash;'}</b><small>${f && lines.length ? 'of ' + esc(money(t.plannedOut)) + ' planned' : 'no budget yet'}</small></div>
          <div class="ev-money ${f && lines.length ? (profit < 0 ? 'is-bad' : 'is-good') : ''}"><span>Profit</span><b>${f && lines.length ? esc(money(profit)) : '&mdash;'}</b><small>${f && lines.length ? 'revenue minus expenses' : ''}</small></div>
        </div>

        <div class="ad-actions-row ev-banner-acts">
          <button type="button" class="ad-btn ad-btn-primary" data-open-hub="${attr(ev.id)}">Open event</button>
          <a class="ad-btn" href="#/event?id=${attr(ev.id)}&tab=budget">Budget</a>
          <button type="button" class="ad-btn" data-edit-ev="${attr(ev.id)}">Edit</button>
          ${ev.status === 'open'
            ? `<button type="button" class="ad-btn" data-close-ev="${attr(ev.id)}" data-confirm="Close vendor signup for ${attr(ev.name || ev.id)}? Nobody new can take a site.">Close signup</button>`
            : `<button type="button" class="ad-btn" data-open-ev="${attr(ev.id)}" data-confirm="Open vendor signup for ${attr(ev.name || ev.id)}?">Open signup</button>`}
        </div>
      </div>
    </article>`;
}

/* ---------- the timeline across the top of the Events page ---------- */
export function timelineHtml(events, activeId, h) {
  const esc = h.esc, attr = h.attr;
  const dated = events.filter((e) => e.dateISO).slice().sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  if (dated.length < 1) return '';
  const day = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
  const today = day(new Date().toISOString().slice(0, 10));
  const lo = Math.min(day(dated[0].dateISO), today) - 20, hi = Math.max(day(dated[dated.length - 1].dateISO), today) + 20;
  const x = (d) => ((d - lo) / Math.max(1, hi - lo) * 100).toFixed(2);
  const short = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
  return `
    <div class="ev-tl" aria-label="Events timeline">
      <div class="ev-tl-line"></div>
      <div class="ev-tl-now" style="left:${x(today)}%"><span>Today</span></div>
      ${dated.map((e, i) => {
        const g = eventGroup(e);
        return `<a class="ev-tl-dot is-${g}${e.id === activeId ? ' is-active' : ''}${i % 2 ? ' is-low' : ''}" style="left:${x(day(e.dateISO))}%" href="#/event?id=${attr(e.id)}" title="${attr(e.name || e.id)} - ${attr(e.dateLabel || e.dateISO)}">
          <i></i><b>${esc(e.name || e.id)}</b><small>${esc(short(e.dateISO))}</small></a>`;
      }).join('')}
    </div>`;
}

/* ---------- the Programme: everything happening on the night, in time order ---------- */
export const PROGRAMME_KINDS = [['act', 'Live act / DJ'], ['activity', 'Activity'], ['food', 'Food & drink'], ['moment', 'Announcement / moment'], ['ops', 'Behind the scenes']];
const KIND = Object.fromEntries(PROGRAMME_KINDS);
const ampm = (t) => { const r = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); if (!r) return ''; const h = +r[1]; return (h % 12 || 12) + (r[2] === '00' ? '' : ':' + r[2]) + (h < 12 ? 'am' : 'pm'); };
const minutes = (t) => { const r = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return r ? (+r[1] < 4 ? +r[1] + 24 : +r[1]) * 60 + +r[2] : 9999; };   // after midnight sorts last

function programmeHtml(ctx) {
  const { ev, h } = ctx;
  const esc = h.esc, attr = h.attr, money = h.money;
  const items = (ctx.programme || []).slice().sort((a, b) => minutes(a.start) - minutes(b.start) || (a.order || 0) - (b.order || 0));
  const total = items.reduce((t, p) => t + (p.costCents || 0), 0);
  const acts = (ctx.talent || []).filter((t) => !t.hidden).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const dollars = (c) => (c ? (c / 100).toFixed(2) : '');
  const row = (p) => `
    <tr class="ev-prog-row is-${attr(p.kind || 'activity')}" data-prog-row="${attr(p.id)}">
      <td class="ev-prog-time"><input class="ad-input" type="time" value="${attr(p.start || '')}" data-prog="start" data-id="${attr(p.id)}"><span class="ev-prog-to">&ndash;</span><input class="ad-input" type="time" value="${attr(p.finish || '')}" data-prog="finish" data-id="${attr(p.id)}"></td>
      <td><input class="ad-input ev-prog-what" value="${attr(p.title || '')}" data-prog="title" data-id="${attr(p.id)}" placeholder="What's happening"></td>
      <td><input class="ad-input" value="${attr(p.who || '')}" data-prog="who" data-id="${attr(p.id)}" placeholder="Who (act, chef, team)" list="ev-prog-acts"></td>
      <td><select class="ad-select" data-prog="kind" data-id="${attr(p.id)}">${PROGRAMME_KINDS.map(([k, l]) => `<option value="${k}"${(p.kind || 'activity') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><input class="ad-input ev-prog-num" type="number" step="0.01" min="0" value="${dollars(p.costCents)}" data-prog="costCents" data-id="${attr(p.id)}" placeholder="0.00"></td>
      <td><input class="ad-input" value="${attr(p.notes || '')}" data-prog="notes" data-id="${attr(p.id)}" placeholder="Notes - power, stage, contact"></td>
      <td class="ev-prog-x"><button type="button" class="ad-linkish" data-prog-del="${attr(p.id)}" aria-label="Remove">&times;</button></td>
    </tr>`;
  return `
    <div class="ev-grid ev-grid-3">
      ${card('On the programme', String(items.length), items.length ? items.filter((p) => p.kind === 'act').length + ' act' + (items.filter((p) => p.kind === 'act').length === 1 ? '' : 's') + ' &middot; ' + items.filter((p) => p.kind !== 'act').length + ' other' : 'nothing yet')}
      ${card('Runs', items.length && items[0].start ? esc(ampm(items[0].start)) + (items[items.length - 1].finish || items[items.length - 1].start ? ' &ndash; ' + esc(ampm(items[items.length - 1].finish || items[items.length - 1].start)) : '') : '&mdash;', 'first to last on the list')}
      ${card('Entertainment & activities', esc(money(total)), 'goes straight into the budget')}
    </div>
    <div class="ad-card ev-prog-card">
      <datalist id="ev-prog-acts">${acts.map((t) => `<option value="${attr(t.name || t.slug)}">`).join('')}</datalist>
      ${items.length ? `
      <table class="ev-prog">
        <thead><tr><th>Time</th><th>What</th><th>Who</th><th>Kind</th><th>Cost</th><th>Notes</th><th></th></tr></thead>
        <tbody>${items.map(row).join('')}</tbody>
      </table>` : `<p class="ev-prog-empty">Nothing on the programme yet. Add the gates opening, the acts, the jumping castle, the cooking demo - anything that happens on the night.</p>`}
      <form class="ev-prog-add" id="ev-prog-add">
        <input class="ad-input" type="time" name="start" title="Start time">
        <input class="ad-input" name="title" placeholder="Add to the programme, e.g. Free jumping castle" required maxlength="120">
        <input class="ad-input" name="who" placeholder="Who" list="ev-prog-acts" maxlength="120">
        <select class="ad-select" name="kind">${PROGRAMME_KINDS.map(([k, l]) => `<option value="${k}"${k === 'activity' ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <input class="ad-input ev-prog-num" name="cost" type="number" step="0.01" min="0" placeholder="Cost $">
        <button type="submit" class="ad-btn ad-btn-primary">Add</button>
      </form>
      <p class="ad-seat-hint">Saves as you type, sorted by start time. Type a name under Who to pick an act from the roster.</p>
    </div>`;
}
