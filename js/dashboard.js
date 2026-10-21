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

import { isBooked, pickLineProgress } from './stock.js?v=647';
import { stageOf, lateFeeDue } from './sales-pipeline.js?v=647';
import { SPONSOR_LEVELS, SPONSOR_GOAL_CENTS } from './sponsor-data.js?v=647';

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

/*  GRAND VIEW FRIDAYS (Max, 20 Oct 2026): we play the Grand View Hotel every
    Friday. Any Friday in the window with nobody booked there is flagged, so
    Max remembers to book a DJ.                                            */
/*  KEEP IN STEP with pubCore() in js/admin-app.js + functions/index.js */
const PUB_WORDS = /\b(hotel|tavern|pub|bar|club|the|inn|bowen|qld|queensland)\b/g;
export function pubCore(v) {
  return String(v || '').toLowerCase().split(',')[0].replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .replace(PUB_WORDS, ' ').replace(/\s+/g, ' ').trim();
}
const samePub = (a, b) => { const x = pubCore(a), y = pubCore(b); return !!x && !!y && (x.includes(y) || y.includes(x)); };
/*  REGULAR NIGHTS (Max, 21 Oct 2026): every pub night in the window with
    nobody booked. No list saved yet = the Grand View every Friday.        */
export function openRegularNights(schedule, nights, days) {
  const list = nights && nights.length ? nights : [{ venue: 'Grand View Hotel, Bowen', weekday: 5 }];
  const out = [];
  const d = new Date(); d.setHours(0, 0, 0, 0);
  for (let i = 0; i <= days; i++) {
    const x = new Date(d.getTime() + i * 86400000);
    const iso = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    list.filter((n) => Number(n.weekday) === x.getDay()).forEach((n) => {
      if (!(schedule || []).some((b) => b.date === iso && samePub(b.venue, n.venue))) out.push({ iso, venue: n.venue, weekday: n.weekday });
    });
  }
  return out;
}
const dayWord = (w) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number(w)] || '';

/* the first day of a month, `back` months ago */
function monthStart(back) { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() - back, 1).getTime(); }

/* ---------- the numbers ---------- */
export function dashboardData(ctx) {
  const jobs = (ctx.quotes || []).filter((q) => !q.vendor && !q.archived && !q.isTemplate);
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
  /*  Next 30 days (Max, 20 Oct 2026): booked jobs, accepted jobs, quotes
      that are out (approved / sent), AND our own events like Eatz & Beatz. */
  const inWindow = (d) => d && d >= today && d <= until;
  const events = (ctx.events || [])
    .filter((ev) => inWindow(ev.dateISO) && !['archived', 'cancelled', 'draft'].includes(ev.status))
    .map((ev) => ({
      id: 'ev:' + ev.id, isEvent: true, ev, hire: { startDate: ev.dateISO },
      customer: { name: ev.name || 'Our event', eventName: ev.subtitle || '', eventVenue: [ev.venue, ev.location].filter(Boolean).join(', ') },
    }));
  // entertainment gigs - the Grand View and everywhere else (Max, 20 Oct 2026)
  const actName = (slug) => ((ctx.talent || []).find((t) => t.slug === slug) || {}).name || slug || 'Act';
  const gigs = (ctx.schedule || []).filter((b) => inWindow(b.date)).map((b) => ({
    id: 'gig:' + b.id, isGig: true, bookingId: b.id, hire: { startDate: b.date },
    customer: { name: actName(b.slug), eventName: b.time || '', eventVenue: b.venue || '' },
  }));
  const openFridays = ctx.schedule ? openRegularNights(ctx.schedule, ctx.regularNights, 30).map((n) => ({
    id: 'fri:' + n.iso + ':' + pubCore(n.venue), isGig: true, noDj: true, hire: { startDate: n.iso },
    customer: { name: String(n.venue).split(',')[0], eventName: dayWord(n.weekday) + ' night', eventVenue: n.venue },
  })) : [];
  const upcoming = jobs.filter((q) => !dead(q) && (isBooked(q) || ['approved', 'sent', 'accepted', 'invoiced'].includes(q.status)))
    .filter((q) => inWindow(q.hire && q.hire.startDate))
    .concat(events, gigs, openFridays)
    .sort((a, b) => String(a.hire.startDate).localeCompare(String(b.hire.startDate)));
  const next30 = sum(upcoming.filter((q) => !q.isEvent && !q.isGig && isBooked(q)), (q) => q.totalCents);

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
  const jobs = (ctx.quotes || []).filter((q) => !q.vendor && !q.archived && !q.isTemplate);
  const today = isoToday();
  const weekAgo = Date.now() - 7 * 86400000;
  const out = [];
  const add = (key, label, items, href) => { if (items.length) out.push({ key, label, items, href }); };

  if (ctx.schedule) add('dj', 'Book a DJ', openRegularNights(ctx.schedule, ctx.regularNights, 30)
    .map((n) => ({ text: shortDate(n.iso) + ' · ' + String(n.venue).split(',')[0] + ' - nobody booked yet', href: '#/entertainment' })));
  // PUB INVOICES (Max, 21 Oct 2026): the night's been played - ready for Max's OK
  add('pub', 'DJ gig invoices to check & send', jobs.filter((q) => q.pubNight && q.status === 'approved' && String(q.pubDate || '') <= today)
    .map((q) => {
      const dj = (q.lines || []).filter((l) => l.pubDj && /^DJ performance/.test(l.name || '')).map((l) => String(l.name).replace(/^DJ performance - /, '') + ' ' + String(l.description || '').split(' @')[0]).join(', ');
      return {
        text: String(q.pubVenue || '').split(',')[0] + ' · ' + shortDate(q.pubDate) + ' · ' + ctx.h.money(q.totalCents) + (dj ? ' · ' + dj : '')
          + ((q.pubNoRate || []).length ? ' · add a rate for ' + q.pubNoRate.join(', ') : '')
          + (q.gigHours > 4 ? ' · over 4 hrs - check it' : ''),
        href: '#/quoteDocs?q=' + q.id,
        btns: ((q.pubBookings || [])[0] ? '<button type="button" class="ad-btn db-mini" data-pub-times="' + ctx.h.attr(q.pubBookings[0]) + '">&#128241; DJ times</button>' : '')
          + '<button type="button" class="ad-btn ad-btn-primary db-mini" data-pub-send="' + ctx.h.attr(q.id) + '">Send</button>',
      };
    }));
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

/*  The forecast as a small card, left of the Quote button (Max, 20 Oct 2026).
    Line icons (not emoji) on a sky gradient - amber when wet or windy, red
    for heavy rain, strong gusts or storms.                                */
const WX_SVG = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  part: '<path d="M8 3v1.5M3.5 7.5H5M4.8 4.3l1 1M11.2 4.3l-1 1"/><path d="M5.5 10a3 3 0 0 1 5.6-1.6"/><path d="M8 19h9a3.5 3.5 0 0 0 0-7 5 5 0 0 0-9.6 1.4A2.8 2.8 0 0 0 8 19z"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.7A3.2 3.2 0 0 0 7 18z"/>',
  rain: '<path d="M7 14h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.7A3.2 3.2 0 0 0 7 14z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>',
  storm: '<path d="M7 13h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.7A3.2 3.2 0 0 0 7 13z"/><path d="M12 14l-2 4h3l-2 4"/>',
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/>',
  cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
};
const wxSvg = (k) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + WX_SVG[k] + '</svg>';
function wxKind(code) {
  if (code == null) return 'cloud';
  if (code === 0) return 'sun';
  if (code <= 2) return 'part';
  if (code >= 95) return 'storm';
  if (code >= 51) return 'rain';
  return 'cloud';
}
export function weatherBox(w, esc) {
  if (!w) return '';
  if (w.later) {
    const from = new Date(Date.parse(w.date + 'T00:00:00') - 15 * 86400000);
    return '<div class="db-wxbox is-later" title="Forecasts reach about 15 days ahead">' + wxSvg('cal')
      + '<p class="wx-later">Forecast<br><span>from ' + esc(isNaN(from) ? '' : from.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })) + '</span></p></div>';
  }
  if (w.rain == null && w.gust == null) return '';
  const wet = (w.rain || 0) >= 50 || (w.mm || 0) >= 5, windy = (w.gust || 0) >= 40;
  const bad = (w.rain || 0) >= 70 || (w.mm || 0) >= 15 || (w.gust || 0) >= 55 || w.code >= 95;
  const mm = w.mm != null ? (w.mm >= 10 ? Math.round(w.mm) : Math.round(w.mm * 10) / 10) + 'mm' : '';
  return '<div class="db-wxbox' + (bad ? ' is-bad' : wet || windy ? ' is-warn' : '') + '" title="Forecast for the event day">'
    + '<div class="wx-top">' + wxSvg(wxKind(w.code))
    + (w.temp != null ? '<p class="wx-temp">' + Math.round(w.temp) + '&deg;' + (w.low != null ? '<span>' + Math.round(w.low) + '&deg;</span>' : '') + '</p>' : '') + '</div>'
    + '<p class="wx-row">' + wxSvg('drop') + Math.round(w.rain || 0) + '%' + (mm ? '<em>' + mm + '</em>' : '') + '</p>'
    + '<p class="wx-row">' + wxSvg('wind') + Math.round(w.wind || 0) + (w.gust != null ? '&ndash;' + Math.round(w.gust) : '') + '<em>km/h</em></p>'
    + '</div>';
}

/*  WEEK SEPARATORS (Max, 21 Oct 2026): "This week", "Next week", "Later",
    so what's on this week stands out. Weeks run Monday to Sunday.        */
function withWeeks(list, row) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const toSun = (7 - d.getDay()) % 7;                       // days until Sunday (0 on a Sunday)
  const iso = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  const endThis = iso(new Date(d.getTime() + toSun * 86400000));
  const endNext = iso(new Date(d.getTime() + (toSun + 7) * 86400000));
  const groupOf = (q) => (q.hire.startDate <= endThis ? 'This week' : q.hire.startDate <= endNext ? 'Next week' : 'Later');
  let last = '';
  return list.map((q) => {
    const g = groupOf(q);
    const sep = g !== last ? '<li class="db-sep' + (g === 'This week' ? ' is-now' : '') + '"><span>' + g + '</span><em>'
      + list.filter((x) => groupOf(x) === g).length + '</em></li>' : '';
    last = g;
    return sep + row(q);
  }).join('');
}

/*  CONFIRMED vs WAITING (Max, 21 Oct 2026): confirmed rows get a green glow,
    waiting rows grey diagonal stripes, and a word under the date.        */
const stateTag = (ok) => ok ? '<span class="db-state is-ok">&#10003; Confirmed</span>' : '<span class="db-state is-wait">Waiting</span>';

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

  const eventRow = (q) => {
    const c = q.customer;
    const sitesNote = q.ev.id === ctx.activeEventId && (ctx.sites || []).length
      ? (ctx.sites || []).filter((x) => x.status === 'booked').length + ' of ' + ctx.sites.length + ' sites sold' : '';
    return `
        <li class="db-job is-event is-confirmed">
          <div class="db-job-date"><b>${esc(shortDate(q.hire.startDate))}</b>${stateTag(true)}</div>
          <div class="db-job-main">
            <p class="db-job-who">${esc(c.name)}${c.eventName ? ' &middot; <span>' + esc(c.eventName) + '</span>' : ''}</p>
            ${c.eventVenue ? `<p class="db-job-sub">${esc(c.eventVenue)}</p>` : ''}
            <p class="db-job-tags">
              <span class="ad-pill db-pill-ours">Our event</span>
              ${sitesNote ? `<span class="db-tag">${esc(sitesNote)}</span>` : ''}
            </p>
          </div>
          <div class="db-job-wx">${weatherBox(ctx.weather && ctx.weather[q.id], esc)}</div>
          <div class="db-job-acts">
            <a class="ad-btn" href="#/vendors">Vendors</a>
            <a class="ad-btn" href="#/map">Map</a>
          </div>
        </li>`;
  };
  const gigRow = (q) => {
    const c = q.customer;
    return `
        <li class="db-job is-gig ${q.noDj ? 'is-pending' : 'is-confirmed'}">
          <div class="db-job-date"><b>${esc(shortDate(q.hire.startDate))}</b>${stateTag(!q.noDj)}</div>
          <div class="db-job-main">
            <p class="db-job-who">${esc(c.name)}${c.eventName ? ' &middot; <span>' + esc(c.eventName) + '</span>' : ''}</p>
            ${c.eventVenue ? `<p class="db-job-sub">${esc(c.eventVenue)}</p>` : ''}
            <p class="db-job-tags">${q.noDj ? '<span class="ad-pill ad-pill-red">No DJ booked</span>' : '<span class="ad-pill db-pill-gig">Gig</span>'}${(() => {
              const inv = (ctx.quotes || []).find((x) => x.pubNight && x.pubDate === q.hire.startDate && pubCore(x.pubVenue) === pubCore(c.eventVenue) && x.status !== 'cancelled');
              if (!inv) return '';
              const word = inv.status === 'approved' ? 'Invoice ready' : inv.paymentStatus === 'paid' || inv.status === 'paid' ? 'Paid' : 'Invoice sent';
              return ` <a class="db-tag db-invtag" href="#/quoteDocs?q=${attr(inv.id)}">${esc(word)} &middot; ${esc(money(inv.totalCents))}</a>`;
            })()}</p>
          </div>
          <div class="db-job-wx">${weatherBox(ctx.weather && ctx.weather[q.id], esc)}</div>
          <div class="db-job-acts">
            <a class="ad-btn${q.noDj ? ' ad-btn-primary' : ''}" href="#/entertainment">${q.noDj ? 'Book a DJ' : 'Entertainment'}</a>
          </div>
        </li>`;
  };
  const jobRow = (q) => {
    if (q.isEvent) return eventRow(q);
    if (q.isGig) return gigRow(q);
    const c = q.customer || {};
    const st = stageOf(q);
    const pp = q.crewToken ? pickLineProgress(q) : null;
    const crew = (q.lines || []).filter((l) => l.resType || l.type === 'labour')
      .map((l) => String(l.name || '').trim()).filter(Boolean);
    const phone = String(c.phone || '').replace(/[^0-9+]/g, '');
    return `
        <li class="db-job ${isBooked(q) ? 'is-confirmed' : 'is-pending'}">
          <div class="db-job-date"><b>${esc(shortDate(q.hire.startDate))}</b>${stateTag(isBooked(q))}</div>
          <div class="db-job-main">
            <p class="db-job-who">${esc(who(q))}${c.eventName ? ' &middot; <span>' + esc(c.eventName) + '</span>' : ''}</p>
            ${c.eventVenue ? `<p class="db-job-sub">${esc(c.eventVenue)}</p>` : ''}
            <p class="db-job-tags">
              <span class="ad-pill ad-pill-${st.status[1]}">${esc(owingOf(q) > 0 && isBooked(q) ? 'Deposit in · ' + money(owingOf(q)) + ' owing' : st.status[0])}</span>
              ${pp && pp.lines ? `<span class="db-tag">${pp.returned === pp.lines ? 'All gear back' : pp.packed + ' of ' + pp.lines + ' packed'}</span>` : ''}
              ${(q.crewAssigned || []).length
                ? `<span class="db-tag db-crewtag">&#128119; ${esc(q.crewAssigned.map((x) => x.name.split(' ')[0]).join(', '))}</span>`
                : (isBooked(q) ? '<span class="db-tag db-nocrew">No crew yet</span>' : '')}
              ${crew.length ? `<span class="db-tag">${esc(crew.slice(0, 3).join(', '))}${crew.length > 3 ? ' +' + (crew.length - 3) : ''}</span>` : ''}
            </p>
          </div>
          <div class="db-job-wx">${weatherBox(ctx.weather && ctx.weather[q.id], esc)}</div>
          <div class="db-job-acts">
            <button type="button" class="ad-btn" data-crew="${attr(q.id)}">&#128119; Crew</button>
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
        <p>${esc(new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}${ctx.fyWeek ? ` <span class="db-week">Week ${esc(ctx.fyWeek.week)} &middot; ${esc(ctx.fyWeek.label)}</span>` : ''}</p>
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
      ${card('Next 30 days', d.next30, `<span class="db-trend">${d.upcoming.filter((q) => !q.isEvent && !q.isGig && isBooked(q)).length} confirmed job${d.upcoming.filter((q) => !q.isEvent && !q.isGig && isBooked(q)).length === 1 ? '' : 's'}</span>`)}
      ${card('Vendor site fees', d.vendorCents, `<span class="db-trend">${esc(evc ? evc.ev.name || 'This event' : 'This event')}</span>`)}
    </div>

    <div class="db-cols">
      <div class="ad-card db-panel">
        <h2>To-dos ${todos.length || rems.length ? '<span class="db-count">' + (todos.reduce((t, g) => t + g.items.length, 0) + rems.length) + '</span>' : ''}</h2>
        ${remHtml}
        ${todos.length ? todos.map((g) => `
          <div class="db-todo">
            <p class="db-todo-h"><a href="${attr(g.href)}">${esc(g.label)}</a> <span class="db-count">${g.items.length}</span></p>
            <ul>${g.items.slice(0, g.key === 'pub' ? 20 : 4).map((it) => `<li><a href="${attr(it.href)}">${esc(it.text)}</a>${it.btns ? '<span class="db-todo-btns">' + it.btns + '</span>' : ''}</li>`).join('')}
              ${g.items.length > 4 ? `<li><a href="${attr(g.href)}">+ ${g.items.length - 4} more</a></li>` : ''}</ul>
          </div>`).join('') : (rems.length ? '' : '<p class="db-empty">All caught up. Nothing waiting on you.</p>')}
      </div>

      <div class="ad-card db-panel">
        <h2>Next 30 days ${d.upcoming.length ? '<span class="db-count">' + d.upcoming.length + '</span>' : ''}</h2>
        ${d.upcoming.length ? `<ul class="db-jobs">${withWeeks(d.upcoming, jobRow)}</ul>` : '<p class="db-empty">No jobs in the next 30 days.</p>'}
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
      <p class="db-event-links"><button type="button" class="ad-btn db-copy" data-copy="${attr('https://www.soundzgood.com.au/vendor-signup?event=' + evc.ev.id + '&waitlist=1')}">Copy waitlist link</button> <button type="button" class="ad-btn db-copy" data-copy="${attr('https://www.soundzgood.com.au/vendor-signup?event=' + evc.ev.id)}">Copy vendor signup link</button> &nbsp; <a href="#/vendors">Vendors</a> &middot; <a href="#/map">Sites &amp; Map</a> &middot; <a href="#/vendorEmail">Messages</a></p>
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
