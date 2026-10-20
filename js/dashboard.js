/* ==========================================================================
   DASHBOARD  -  the first thing you see in /admin  (Max, 20 Oct 2026)

   Max's answers to 10 questions (see memory: soundzgood dashboard):
     1. Money cards across the top, with up / down vs last month
     2. To-dos and the next 30 days of jobs, side by side
     3. One card for the next event (countdown, sites, vendor money, sponsors)
     4. Sales per month this year, as a bar chart, at the bottom
     5. Quick buttons: New quote, New event, Send message
   No leads - those stay on Gig Opportunities.

   Pure functions like js/sales-pipeline.js: admin-app.js passes in the live
   data (ctx) and the helpers (esc, attr, money). Nothing here reads Firebase.

   NOTE ON "MONEY IN": a quote keeps the total paid, not a list of payments,
   so a payment counts in the month it was last paid (lastPaidAt / paidAt /
   acceptedAt). Close enough for a dashboard; the invoices are the record.
   ========================================================================== */

import { isBooked, pickLineProgress } from './stock.js?v=632';
import { stageOf, lateFeeDue } from './sales-pipeline.js?v=632';
import { SPONSOR_LEVELS, SPONSOR_GOAL_CENTS } from './sponsor-data.js?v=632';

const LEVEL = Object.fromEntries(SPONSOR_LEVELS.map((l) => [l.key, l]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ---------- small helpers ---------- */
function ms(t) {
  if (!t) return 0;
  if (typeof t === 'number') return t;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (t.seconds != null) return t.seconds * 1000;
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : 0;
}
const isoToday = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function isoAdd(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10);
}
const dead = (q) => q.status === 'cancelled' || q.status === 'declined';
const owingOf = (q) => Math.round(q.totalCents || 0) + Math.round(q.lateFeeCents || 0) - Math.round(q.amountPaidCents || 0);
const soldAt = (q) => ms(q.acceptedAt) || (['accepted', 'invoiced', 'paid'].includes(q.status) ? ms(q.invoicedAt) || ms(q.paidAt) : 0);
const paidAt = (q) => ms(q.lastPaidAt) || ms(q.paidAt) || ms(q.acceptedAt);
const who = (q) => { const c = q.customer || {}; return c.business || c.name || 'No name yet'; };
const shortDate = (iso) => { const t = Date.parse(iso + 'T00:00:00'); return t ? new Date(t).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : ''; };

/* the first day of a month, `back` months ago */
function monthStart(back) { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() - back, 1).getTime(); }

/* ---------- the numbers ---------- */
export function dashboardData(ctx) {
  const jobs = (ctx.quotes || []).filter((q) => !q.vendor && !q.archived);
  const thisM = monthStart(0), nextM = monthStart(-1), lastM = monthStart(1);
  const inMonth = (t, from, to) => t >= from && t < to;
  const sum = (list, f) => list.reduce((t, q) => t + Math.max(0, Math.round(f(q) || 0)), 0);

  const sold = jobs.filter((q) => !dead(q) && soldAt(q));
  const salesNow = sum(sold.filter((q) => inMonth(soldAt(q), thisM, nextM)), (q) => q.totalCents);
  const salesLast = sum(sold.filter((q) => inMonth(soldAt(q), lastM, thisM)), (q) => q.totalCents);

  const paid = jobs.filter((q) => (q.amountPaidCents || 0) > 0);
  const inNow = sum(paid.filter((q) => inMonth(paidAt(q), thisM, nextM)), (q) => q.amountPaidCents);
  const inLast = sum(paid.filter((q) => inMonth(paidAt(q), lastM, thisM)), (q) => q.amountPaidCents);

  const owed = jobs.filter((q) => !dead(q) && (isBooked(q) || ['accepted', 'invoiced'].includes(q.status)) && owingOf(q) > 0)
    .sort((a, b) => owingOf(b) - owingOf(a));

  const today = isoToday(), until = isoAdd(today, 30);
  const upcoming = jobs.filter((q) => !dead(q) && (isBooked(q) || ['accepted', 'invoiced'].includes(q.status)))
    .filter((q) => { const s = q.hire && q.hire.startDate; return s && s >= today && s <= until && !dead(q); })
    .sort((a, b) => String(a.hire.startDate).localeCompare(String(b.hire.startDate)));
  const next30 = sum(upcoming.filter(isBooked), (q) => q.totalCents);

  const paidBooking = (b) => b.status === 'confirmed' || b.paymentStatus === 'paid';
  const vendorCents = sum((ctx.bookings || []).filter(paidBooking), (b) => (b.totalCents != null ? b.totalCents : b.amountCents));

  // sales per month this year
  const year = new Date().getFullYear();
  const chart = MONTHS.map((m, i) => ({
    label: m,
    cents: sum(sold.filter((q) => { const d = new Date(soldAt(q)); return d.getFullYear() === year && d.getMonth() === i; }), (q) => q.totalCents),
    now: i === new Date().getMonth(),
  }));

  return { salesNow, salesLast, inNow, inLast, owed, owedCents: sum(owed, owingOf), upcoming, next30, vendorCents, chart, year };
}

/* ---------- to-dos ---------- */
export function todoGroups(ctx) {
  const jobs = (ctx.quotes || []).filter((q) => !q.vendor && !q.archived);
  const today = isoToday();
  const weekAgo = Date.now() - 7 * 86400000;
  const out = [];
  const add = (key, label, items, href) => { if (items.length) out.push({ key, label, items, href }); };

  add('approve', 'Quotes to approve', jobs.filter((q) => q.status === 'draft')
    .map((q) => ({ text: who(q) + (q.source === 'bot' ? ' · from the website bot' : ''), href: '#/quoteDocs?q=' + q.id })));
  add('details', 'Details just in', jobs.filter((q) => q.detailsReceivedAt && ['draft', 'approved'].includes(q.status))
    .map((q) => ({ text: who(q) + ' filled in their details', href: '#/quoteDocs?q=' + q.id })));
  add('overdue', 'Overdue payments', jobs.filter((q) => !dead(q) && owingOf(q) > 0
      && (q.kind === 'invoice' || ['accepted', 'invoiced'].includes(q.status))
      && (lateFeeDue(q) > 0 || (q.hire && q.hire.startDate && isoAdd(q.hire.startDate, -7) < today && q.paymentStatus !== 'deposit')))
    .map((q) => ({ text: who(q) + ' owes ' + ctx.h.money(owingOf(q)) + (lateFeeDue(q) ? ' · late fee due' : ''), href: '#/quoteDocs?q=' + q.id })));
  add('messages', 'Messages to approve', (ctx.messages || []).filter((m) => m.status === 'review')
    .map((m) => ({ text: m.name || m.subject || 'A message', href: '#/vendorEmail' })));
  add('failed', 'Emails that failed', (ctx.emailLog || []).filter((e) => e.ok === false && !e.test && ms(e.at) > weekAgo)
    .map((e) => ({ text: (e.subject || 'Email') + ' → ' + (e.to || ''), href: '#/vendorEmail' })));
  // (vendor applications removed 20 Oct 2026 - vendors book and pay themselves, nothing to review)
  add('waitlist', 'Waitlist offers out', (ctx.waitlist || []).filter((w) => w.status === 'offered')
    .map((w) => ({ text: (w.name || 'A vendor') + ' has been offered a spot', href: '#/vendorEmail' })));
  return out;
}

/* ---------- the next event ---------- */
export function eventCard(ctx) {
  const ev = (ctx.events || []).find((e) => e.id === ctx.activeEventId);
  if (!ev) return null;
  const today = isoToday();
  const days = ev.dateISO ? Math.round((Date.parse(ev.dateISO + 'T00:00:00') - Date.parse(today + 'T00:00:00')) / 86400000) : null;
  const sites = ctx.sites || [];
  const sold = sites.filter((s) => s.status === 'booked').length;
  const paidBooking = (b) => b.status === 'confirmed' || b.paymentStatus === 'paid';
  const vendorCents = (ctx.bookings || []).filter(paidBooking).reduce((t, b) => t + Math.round((b.totalCents != null ? b.totalCents : b.amountCents) || 0), 0);
  const sponsorCents = (ctx.sponsors || []).filter((p) => p.status === 'yes')
    .reduce((t, p) => t + (p.amountCents || (LEVEL[p.level] && LEVEL[p.level].priceCents) || 0), 0);
  return { ev, days, sold, total: sites.length, vendorCents, sponsorCents, goal: SPONSOR_GOAL_CENTS };
}

/* ---------- event-day weather (Max, 20 Oct 2026) ---------- */
function wxIcon(code) {
  if (code == null) return '';
  if (code === 0) return '&#9728;&#65039;';                 // sun
  if (code <= 2) return '&#127780;&#65039;';                // sun + cloud
  if (code === 3 || code === 45 || code === 48) return '&#9729;&#65039;';   // cloud / fog
  if (code >= 95) return '&#9928;&#65039;';                 // storm
  if (code >= 51) return '&#127783;&#65039;';               // rain
  return '&#9729;&#65039;';
}
export function weatherTag(w, esc) {
  if (!w) return '';
  if (w.later) return '<span class="db-tag db-wx">Forecast from ' + esc(new Date(Date.parse(w.date + 'T00:00:00') - 15 * 86400000).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })) + '</span>';
  if (w.rain == null && w.gust == null) return '';
  const wet = (w.rain || 0) >= 50, windy = (w.gust || 0) >= 40;
  const warn = (w.rain || 0) >= 70 || (w.gust || 0) >= 55 || w.code >= 95;
  return '<span class="db-tag db-wx' + (warn ? ' is-bad' : wet || windy ? ' is-warn' : '') + '" title="Forecast for the event day">'
    + wxIcon(w.code) + ' ' + (w.temp != null ? Math.round(w.temp) + '&deg; &middot; ' : '')
    + Math.round(w.rain || 0) + '% rain' + (w.mm != null ? ' (' + (w.mm >= 10 ? Math.round(w.mm) : Math.round(w.mm * 10) / 10) + ' mm)' : '') + ' &middot; wind ' + Math.round(w.wind || 0) + ' km/h'
    + (w.gust != null ? ' (gusts ' + Math.round(w.gust) + ')' : '') + '</span>';
}

/* ---------- the page ---------- */
export function dashboardHtml(ctx) {
  const { esc, attr, money } = ctx.h;
  const d = dashboardData(ctx);
  const todos = todoGroups(ctx);
  const evc = eventCard(ctx);
  const trend = (now, last) => {
    if (!last && !now) return '<span class="db-trend">&nbsp;</span>';
    if (!last) return '<span class="db-trend is-up">&#9650; new this month</span>';
    const pct = Math.round((now - last) / last * 100);
    return `<span class="db-trend ${pct >= 0 ? 'is-up' : 'is-down'}">${pct >= 0 ? '&#9650;' : '&#9660;'} ${Math.abs(pct)}% vs last month</span>`;
  };
  const card = (label, cents, sub, extra = '') => `
      <div class="db-stat">
        <p class="db-stat-label">${label}</p>
        <p class="db-stat-num">${money(cents)}</p>
        ${sub}${extra}
      </div>`;
  const hour = new Date().getHours();

  const jobRow = (q) => {
    const c = q.customer || {};
    const st = stageOf(q);
    const pp = q.crewToken ? pickLineProgress(q) : null;
    const crew = (q.lines || []).filter((l) => l.resType || l.type === 'labour')
      .map((l) => String(l.name || '').trim()).filter(Boolean);
    const phone = String(c.phone || '').replace(/[^0-9+]/g, '');
    return `
        <li class="db-job">
          <div class="db-job-date"><b>${esc(shortDate(q.hire.startDate))}</b></div>
          <div class="db-job-main">
            <p class="db-job-who">${esc(who(q))}${c.eventName ? ' &middot; <span>' + esc(c.eventName) + '</span>' : ''}</p>
            ${c.eventVenue ? `<p class="db-job-sub">${esc(c.eventVenue)}</p>` : ''}
            <p class="db-job-tags">
              <span class="ad-pill ad-pill-${st.status[1]}">${esc(owingOf(q) > 0 && isBooked(q) ? 'Deposit in · ' + money(owingOf(q)) + ' owing' : st.status[0])}</span>
              ${pp && pp.lines ? `<span class="db-tag">${pp.returned === pp.lines ? 'All gear back' : pp.packed + ' of ' + pp.lines + ' packed'}</span>` : ''}
              ${weatherTag(ctx.weather && ctx.weather[q.id], esc)}
              ${crew.length ? `<span class="db-tag">${esc(crew.slice(0, 3).join(', '))}${crew.length > 3 ? ' +' + (crew.length - 3) : ''}</span>` : ''}
            </p>
          </div>
          <div class="db-job-acts">
            <a class="ad-btn" href="#/quoteDocs?q=${attr(q.id)}">Quote</a>
            ${q.crewToken ? `<a class="ad-btn" href="/picklist?t=${attr(q.crewToken)}" target="_blank" rel="noopener">Pick list</a>` : ''}
            ${phone ? `<a class="ad-btn" href="tel:${attr(phone)}">Call</a>` : ''}
          </div>
        </li>`;
  };

  const max = Math.max(1, ...d.chart.map((m) => m.cents));
  const rems = ctx.reminders || [];
  const remHtml = `
          <div class="db-todo db-rem">
            <p class="db-todo-h">Reminders ${rems.length ? '<span class="db-count">' + rems.length + '</span>' : ''}</p>
            <ul>${rems.map((r) => `<li><label><input type="checkbox" data-rem-done="${attr(r.id)}"> <span>${esc(r.text)}</span></label></li>`).join('')}</ul>
            <form class="db-rem-add" data-rem-add><input type="text" placeholder="Add a reminder and press Enter" maxlength="300" aria-label="Add a reminder"></form>
          </div>`;
  return `
  <section class="db">
    <header class="db-head">
      <div>
        <h1>${hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening'}, Max</h1>
        <p>${esc(new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}</p>
      </div>
      <div class="db-quick">
        <a class="ad-btn ad-btn-primary" href="#/quoteDocs?q=new">+ New quote</a>
        <a class="ad-btn" href="#/events">+ New event</a>
        <a class="ad-btn" href="#/vendorEmail">Send message</a>
      </div>
    </header>

    <div class="db-stats">
      ${card('Sales this month', d.salesNow, trend(d.salesNow, d.salesLast))}
      ${card('Money in this month', d.inNow, trend(d.inNow, d.inLast))}
      ${card('Money owed', d.owedCents, `<span class="db-trend">${d.owed.length} job${d.owed.length === 1 ? '' : 's'}${d.owed.length ? ': ' + esc(d.owed.slice(0, 2).map(who).join(', ')) + (d.owed.length > 2 ? '&hellip;' : '') : ''}</span>`)}
      ${card('Next 30 days', d.next30, `<span class="db-trend">${d.upcoming.filter(isBooked).length} confirmed job${d.upcoming.filter(isBooked).length === 1 ? '' : 's'}</span>`)}
      ${card('Vendor site fees', d.vendorCents, `<span class="db-trend">${esc(evc ? evc.ev.name || 'This event' : 'This event')}</span>`)}
    </div>

    <div class="db-cols">
      <div class="ad-card db-panel">
        <h2>To-dos ${todos.length || rems.length ? '<span class="db-count">' + (todos.reduce((t, g) => t + g.items.length, 0) + rems.length) + '</span>' : ''}</h2>
        ${remHtml}
        ${todos.length ? todos.map((g) => `
          <div class="db-todo">
            <p class="db-todo-h"><a href="${attr(g.href)}">${esc(g.label)}</a> <span class="db-count">${g.items.length}</span></p>
            <ul>${g.items.slice(0, 4).map((it) => `<li><a href="${attr(it.href)}">${esc(it.text)}</a></li>`).join('')}
              ${g.items.length > 4 ? `<li><a href="${attr(g.href)}">+ ${g.items.length - 4} more</a></li>` : ''}</ul>
          </div>`).join('') : (rems.length ? '' : '<p class="db-empty">All caught up. Nothing waiting on you.</p>')}
      </div>

      <div class="ad-card db-panel">
        <h2>Next 30 days ${d.upcoming.length ? '<span class="db-count">' + d.upcoming.length + '</span>' : ''}</h2>
        ${d.upcoming.length ? `<ul class="db-jobs">${d.upcoming.map(jobRow).join('')}</ul>` : '<p class="db-empty">No jobs in the next 30 days.</p>'}
      </div>
    </div>

    ${evc ? `
    <div class="ad-card db-panel db-event">
      <div class="db-event-head">
        <h2>${esc(evc.ev.name || 'Next event')}${evc.ev.subtitle ? ' <span>' + esc(evc.ev.subtitle) + '</span>' : ''}</h2>
        <p class="db-countdown">${evc.days == null ? '' : evc.days > 1 ? '<b>' + evc.days + '</b> days to go' : evc.days === 1 ? '<b>Tomorrow</b>' : evc.days === 0 ? '<b>Today!</b>' : 'Finished'}</p>
      </div>
      <div class="db-event-grid">
        <div><p class="db-stat-label">Sites sold</p><p class="db-stat-num">${evc.sold} <small>of ${evc.total}</small></p>
          <div class="db-bar"><i style="width:${evc.total ? Math.round(evc.sold / evc.total * 100) : 0}%"></i></div></div>
        <div><p class="db-stat-label">Vendor money</p><p class="db-stat-num">${money(evc.vendorCents)}</p></div>
        <div><p class="db-stat-label">Sponsorship</p><p class="db-stat-num">${money(evc.sponsorCents)} <small>of ${money(evc.goal)}</small></p>
          <div class="db-bar"><i style="width:${Math.min(100, Math.round(evc.sponsorCents / evc.goal * 100))}%"></i></div></div>
      </div>
      <p class="db-event-links"><a href="#/vendors">Vendors</a> &middot; <a href="#/map">Sites &amp; Map</a> &middot; <a href="#/vendorEmail">Messages</a></p>
    </div>` : ''}

    <div class="ad-card db-panel">
      <h2>Sales by month, ${d.year}</h2>
      <div class="db-chart" role="img" aria-label="Sales by month">
        ${d.chart.map((m) => `
          <div class="db-col${m.now ? ' is-now' : ''}" title="${attr(m.label + ': ' + money(m.cents))}">
            <span class="db-col-val">${m.cents ? '$' + (m.cents >= 100000 ? Math.round(m.cents / 100000) + 'k' : Math.round(m.cents / 100)) : ''}</span>
            <i style="height:${Math.round(m.cents / max * 100)}%"></i>
            <span class="db-col-lab">${m.label}</span>
          </div>`).join('')}
      </div>
    </div>
  </section>`;
}
