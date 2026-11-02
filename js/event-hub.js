/* ==========================================================================
   EVENT HUB  -  one event, every part of it under tabs

   Overview and Budget are drawn here. The other tabs are the existing
   admin pages (Vendors, Sites & Map, Entertainment, Messages, Sponsors)
   rendered by admin-app.js and passed in as `inner`.

   Pure functions - no Firebase, no page state. admin-app.js passes in
   state and the helpers (esc, attr, money) and wires the clicks.
   ========================================================================== */

import { SPONSOR_LEVELS } from './sponsor-data.js?v=770';

const LEVEL = Object.fromEntries(SPONSOR_LEVELS.map((l) => [l.key, l]));

export const HUB_TABS = [
  ['overview', 'Overview'], ['budget', 'Budget'], ['vendors', 'Vendors'], ['map', 'Sites & Map'],
  ['entertainment', 'Entertainment'], ['messages', 'Messages'], ['sponsors', 'Sponsors'], ['website', 'Website'],
];

/* the lines a new budget starts with - income first, then costs */
export const BUDGET_STARTER = [
  { name: 'Vendor site fees', kind: 'income', auto: 'vendors' },
  { name: 'Sponsorship', kind: 'income', auto: 'sponsors' },
  { name: 'Bar & drinks', kind: 'income' },
  { name: 'Entertainment', kind: 'cost' },
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
  };
}

/* budget lines with the automatic actuals filled in */
export function budgetLines(ctx, f) {
  return (ctx.budget || []).map((l) => {
    const actual = l.auto === 'vendors' ? f.vendorCents : l.auto === 'sponsors' ? f.sponsorYes : (l.actualCents || 0);
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
        ${tab === 'overview' ? overviewHtml(ctx) : tab === 'budget' ? budgetHtml(ctx) : tab === 'website' ? websiteHtml(ctx) : (ctx.inner || '')}
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
  const link = (tab, label) => `<a class="ad-btn" href="#/event?id=${attr(ev.id)}&tab=${tab}">${label}</a>`;
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
    <div class="ev-links">
      ${link('vendors', 'Vendors')}${link('map', 'Sites &amp; Map')}${link('entertainment', 'Entertainment')}${link('messages', 'Messages')}${link('sponsors', 'Sponsors')}${link('budget', 'Budget')}
    </div>`;
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
    if (!l.plannedCents && !l.actualCents) return '<td class="ev-bud-diff"></td>';
    return `<td class="ev-bud-diff ${d < 0 ? 'is-bad' : 'is-good'}">${d < 0 ? '&minus;' : '+'}${esc(money(Math.abs(d)))}</td>`;
  };
  const rowHtml = (l) => `
    <tr data-bud-row="${attr(l.id)}">
      <td><input class="ad-input ev-bud-name" value="${attr(l.name || '')}" data-bud="name" data-id="${attr(l.id)}" placeholder="Line"></td>
      <td><input class="ad-input ev-bud-num" type="number" step="0.01" min="0" value="${dollars(l.plannedCents)}" data-bud="plannedCents" data-id="${attr(l.id)}" placeholder="0.00"></td>
      <td>${l.auto
        ? `<span class="ev-bud-auto" title="Filled in from ${l.auto === 'vendors' ? 'paid vendor bookings' : 'sponsors who said yes'}">${esc(money(l.actualCents))} <small>auto</small></span>`
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

function websiteHtml(ctx) {
  const { ev, h } = ctx;
  const esc = h.esc, attr = h.attr, money = h.money;
  const p = ev.pricing || {};
  const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  return `
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
          ${row('Signup', ev.status === 'open' ? 'Open - vendors can book' : esc(ev.status || 'closed'))}
        </dl>
        <div class="ad-actions-row">
          <button type="button" class="ad-btn ad-btn-primary" data-edit-ev="${attr(ev.id)}">Edit details</button>
          <a class="ad-btn" href="/events" target="_blank" rel="noopener">View the events page &rarr;</a>
          <a class="ad-btn" href="/vendor-signup" target="_blank" rel="noopener">Vendor signup page &rarr;</a>
        </div>
      </div>
      <div class="ad-card ev-pad">
        <h2>Where it's used</h2>
        <p class="ad-drawer-text">A change here goes everywhere at once: the public events page, the vendor signup page, the vendor guide and every email field like {{event_venue}}.</p>
        <p class="ad-drawer-text">Moved venue or changed the date? Edit it once, then send vendors a message from the Messages tab.</p>
      </div>
    </div>`;
}
