/*  SPONSOR DIRECTORY - research, not asking. Every business worth knowing
    about, one card each: logo, industry, a value score, a stage
    (Idea -> Researching -> Ready to ask -> Asked -> Sponsor), contact,
    socials, what they usually give, and their history with our events.

    The ask itself still goes from an event's Sponsors tab; that creates the
    per-event record in `sponsors`. The directory lives in `sponsorBiz`,
    one doc per business, and reads `sponsors` for the history.

    One sponsor per industry: once a business in an industry has said yes
    to the event picked, the others in that industry show "industry taken". */

import { spAvatar, spColor } from './messages.js?v=836';
import { SPONSOR_LEVELS } from './sponsor-data.js?v=836';

/* what to ask for, from the score */
const ASK = { 5: 'gold', 4: 'silver', 3: 'bronze', 2: 'supporter', 1: 'supporter' };
const LEVEL_OF = Object.fromEntries(SPONSOR_LEVELS.map((l) => [l.key, l]));
export function suggestedAsk(b) {
    const hist = b.hist || {};
    if (hist.top) {
        // they have given before: ask for their best, rounded up a touch, and name the package it fits
        const cents = Math.round((hist.top * 1.1) / 5000) * 5000;
        const fit = SPONSOR_LEVELS.filter((l) => l.priceCents && l.priceCents <= cents).sort((x, y) => y.priceCents - x.priceCents)[0];
        return {
            level: fit ? fit.key : 'supporter',
            label: fit ? fit.name.split(' - ')[0] : 'Supporter',
            cents,
            basis: 'gave ' + money0(hist.top) + (hist.last ? ' to ' + hist.last.event + (hist.last.year ? ' ' + hist.last.year : '') : '')
        };
    }
    if (hist.bestTier > 0 && hist.best) {
        // we know the tier they took elsewhere, not the dollars: pitch the matching package
        const key =
            hist.bestTier >= 3.5
                ? 'gold'
                : hist.bestTier >= 2.5
                  ? 'gold'
                  : hist.bestTier >= 1.5
                    ? 'silver'
                    : hist.bestTier >= 0.75
                      ? 'bronze'
                      : 'supporter';
        const lv = LEVEL_OF[key] || {};
        return {
            level: key,
            label: (lv.name || 'Supporter').split(' - ')[0],
            cents: lv.priceCents || 25000,
            basis: (TIER_WORD(hist.bestTier) || hist.best.what) + ' at ' + hist.best.event + (hist.best.year ? ' ' + hist.best.year : '')
        };
    }
    const lvl = LEVEL_OF[ASK[b.score] || 'supporter'] || {};
    const cents = b.budgetCents || lvl.priceCents || (b.gives === 'prize' ? 0 : 25000);
    return {
        level: lvl.key || 'supporter',
        label: (lvl.name || 'Supporter').split(' - ')[0],
        cents,
        basis: b.budgetCents ? 'your budget guess' : 'from the stars'
    };
}
/* why this score, in a few words */
export function whyScore(b) {
    const w = [];
    if (b.size === 'corp' || b.size === 'large') w.push('big employer');
    else if (b.size === 'medium') w.push('mid-size');
    if (b.local === 'bowen') w.push('Bowen local');
    else if (b.local === 'whitsundays') w.push('Whitsundays');
    if (b.hist && b.hist.last)
        w.push('gave ' + money0(b.hist.last.amountCents) + ' to ' + b.hist.last.event + (b.hist.last.year ? ' ' + b.hist.last.year : ''));
    else if (b.hist && b.hist.best)
        w.push(
            (TIER_WORD(b.hist.bestTier) || 'sponsor') +
                ' at ' +
                b.hist.best.event +
                (b.hist.best.year ? ' ' + b.hist.best.year : '') +
                (b.hist.deals.length > 1 ? ' +' + (b.hist.deals.length - 1) + ' more' : '')
        );
    if (b.hist && b.hist.backed) w.push('backed us ' + b.hist.backed + 'x');
    if (b.budgetCents) w.push('budget guess $' + Math.round(b.budgetCents / 100));
    if (b.facebook || b.instagram) w.push('on socials');
    if (b.gives) w.push('gives ' + ({ cash: 'cash', inkind: 'in-kind', prize: 'prizes', mix: 'cash + prizes' }[b.gives] || b.gives));
    return w.join(' · ') || 'no facts yet - open and fill in size, how local, budget';
}

export const STAGES = [
    ['idea', 'Idea'],
    ['research', 'Researching'],
    ['ready', 'Ready to ask'],
    ['asked', 'Asked'],
    ['sponsor', 'Sponsor'],
    ['no', 'Not now']
];
const STAGE = Object.fromEntries(STAGES);
const SIZE = { '': '—', small: 'Small (1-5 staff)', medium: 'Medium (6-20)', large: 'Large (20+)', corp: 'Corporate / chain' };
const LOCAL = { '': '—', bowen: 'Bowen', whitsundays: 'Whitsundays', nq: 'North Queensland', far: 'Further away' };
const GIVES = { '': '—', cash: 'Cash', inkind: 'In-kind', prize: 'Prizes', mix: 'Cash + prizes' };
export const INDUSTRIES = [
    'Automotive',
    'Real estate',
    'Building & trades',
    'Mining & industry',
    'Finance & accounting',
    'Legal',
    'Insurance',
    'Health & medical',
    'Beauty & hair',
    'Fitness & sport',
    'Hospitality - pubs & clubs',
    'Hospitality - cafes & restaurants',
    'Accommodation & tourism',
    'Retail - groceries',
    'Retail - hardware & home',
    'Retail - fashion & gifts',
    'Printing & signage',
    'Media & marketing',
    'Agriculture & fishing',
    'Marine & boating',
    'Transport & logistics',
    'Education & childcare',
    'Government & council',
    'Community & not-for-profit',
    'Other'
];

const key = (s) =>
    String(s || '')
        .trim()
        .toLowerCase();
const money0 = (c) => '$' + Math.round((c || 0) / 100).toLocaleString('en-AU');
const today = () => new Date().toISOString().slice(0, 10);
const niceDate = (iso) =>
    iso
        ? new Date(String(iso).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
        : '';
const secs = (t) => (t && typeof t.seconds === 'number' ? t.seconds : 0);
const handle = (url) => {
    const m = /(?:facebook|instagram)\.com\/([A-Za-z0-9_.-]+)/i.exec(String(url || ''));
    return m ? '@' + m[1] : '';
};

/* how big a tier is, from the words on a sponsor page */
export function tierRank(what) {
    const w = String(what || '').toLowerCase();
    const kind = /in.?kind/.test(w) ? -0.5 : 0; // in-kind counts a touch less than cash
    if (/naming|title|presenting|platinum|premium|major/.test(w)) return 4 + kind;
    if (/gold/.test(w)) return 3 + kind;
    if (/silver/.test(w)) return 2 + kind;
    if (/bronze/.test(w)) return 1 + kind;
    if (/sponsor|supporter|partner|donor|prize/.test(w)) return 0.5;
    return 0;
}
const TIER_WORD = (r) => (r >= 4 ? 'Naming / Platinum' : r >= 3 ? 'Gold' : r >= 2 ? 'Silver' : r >= 1 ? 'Bronze' : r > 0 ? 'Sponsor' : '');
/* the suggested value, 1-5, from the facts; their own stars win if set */
export function suggestedScore(b, hist) {
    let s = 0;
    s += { small: 1, medium: 2, large: 3, corp: 3 }[b.size] || 0;
    s += { bowen: 2, whitsundays: 1.5, nq: 1, far: 0 }[b.local] || 0;
    s += Math.min(2, hist.backed || 0);
    if (hist.bestTier >= 3) s += 2;
    else if (hist.bestTier >= 1) s += 1.5;
    else if (hist.bestTier > 0) s += 1; // they already sponsor things
    if (b.budgetCents >= 200000) s += 2;
    else if (b.budgetCents >= 50000) s += 1;
    if (b.facebook || b.instagram) s += 0.5;
    return Math.max(1, Math.min(5, Math.round(s / 2)));
}
const stars = (n, cls) => `<span class="${cls || 'spd-stars'}" aria-label="${n} of 5">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>`;

/* their history across every event, from the per-event records */
function history(b, sponsors, evOf) {
    const mine = (sponsors || []).filter((p) => (b.id && p.bizId === b.id) || key(p.business) === key(b.business));
    const yes = mine.filter((p) => p.status === 'yes');
    const cents = yes.reduce((t, p) => t + (p.amountCents || 0), 0);
    const asked = mine.filter((p) => p.askedAt).sort((x, y) => secs(y.askedAt) - secs(x.askedAt))[0];
    const past = (b.past || []).slice().sort((x, y) => (y.year || 0) - (x.year || 0));
    const ours = yes.map((p) => ({
        event: (evOf[p.eventId] || {}).name || p.eventId,
        year: +String((evOf[p.eventId] || {}).dateISO || '').slice(0, 4) || 0,
        amountCents: p.amountCents || (LEVEL_OF[p.level] || {}).priceCents || 0,
        what: p.level || '',
        ours: true
    }));
    const deals = past.concat(ours).sort((x, y) => (y.year || 0) - (x.year || 0));
    const given = deals.filter((d) => d.amountCents);
    const last = given[0] || null;
    const top = given.reduce((m, d) => Math.max(m, d.amountCents), 0);
    deals.forEach((d) => {
        d.rank = tierRank(d.what);
    });
    const best =
        deals.slice().sort((x, y) => (y.amountCents || 0) - (x.amountCents || 0) || y.rank - x.rank || (y.year || 0) - (x.year || 0))[0] ||
        null;
    const bestTier = best ? best.rank : 0;
    const bestLabel = best
        ? (best.amountCents ? money0(best.amountCents) + ' ' : '') +
          (TIER_WORD(best.rank) || best.what || 'sponsor') +
          ' · ' +
          best.event +
          (best.year ? ' ' + best.year : '')
        : '';
    return {
        deals,
        last,
        top,
        best,
        bestTier,
        bestLabel,
        records: mine,
        backed: yes.length,
        cents,
        lastAsked: asked ? new Date(secs(asked.askedAt) * 1000).toISOString().slice(0, 10) : '',
        events: yes.map((p) => (evOf[p.eventId] || {}).name || p.eventId)
    };
}

export function sponsorDirHtml(ctx) {
    const { state, h } = ctx;
    const f = state.spDir || (state.spDir = { tab: 'pot', q: '', stage: '', industry: '', event: '' });
    const events = (state.events || []).slice().sort((a, b) => String(b.dateISO || '').localeCompare(String(a.dateISO || '')));
    const evOf = Object.fromEntries(events.map((e) => [e.id, e]));
    const sponsors = state.sponsorsAll || [];
    const list = (state.sponsorBiz || []).map((b) => {
        const hist = history(b, sponsors, evOf);
        return { ...b, hist, score: b.stars || suggestedScore(b, hist) };
    });

    // industry exclusivity for the event picked
    const takenBy = {};
    sponsors
        .filter((p) => p.status === 'yes' && (!f.event || p.eventId === f.event))
        .forEach((p) => {
            const biz = list.find((b) => (p.bizId && p.bizId === b.id) || key(p.business) === key(b.business));
            const ind = key(biz && biz.industry);
            if (ind && !takenBy[ind]) takenBy[ind] = p.business;
        });
    const taken = (b) => {
        const t = takenBy[key(b.industry)];
        return t && key(t) !== key(b.business) ? t : '';
    };

    const q = key(f.q);
    const rows = list
        .filter(
            (b) =>
                (!f.stage || (b.stage || 'idea') === f.stage) &&
                (!f.industry || key(b.industry) === key(f.industry)) &&
                (!q || [b.business, b.industry, b.contactName, b.email, b.website, b.notes, b.blurb].some((v) => key(v).includes(q)))
        )
        .sort(
            (a, b) =>
                b.score - a.score ||
                b.hist.bestTier - a.hist.bestTier ||
                b.hist.backed - a.hist.backed ||
                String(a.business).localeCompare(String(b.business))
        );
    const industries = [...new Set(INDUSTRIES.concat(list.map((b) => b.industry).filter(Boolean)))];

    const row = (b) => {
        const t = taken(b);
        const h2 = b.hist || {};
        return `<tr class="spd-row${state.spDirOpen === b.id ? ' is-open' : ''}${t ? ' is-taken' : ''}" data-spd-open="${h.attr(b.id)}" style="--sp-brand:${h.attr(spColor(b))}">
      <td class="spd-c-biz"><span class="spd-biz-in">${spAvatar(h, b)}<span><b>${h.esc(b.business)}</b>${b.address ? `<small>${h.esc(b.address)}</small>` : ''}</span></span></td>
      <td class="spd-c-val">${stars(b.score)}${b.stars ? '' : '<small class="spd-sugg">suggested</small>'}</td>
      <td><span class="spd-stage is-${h.attr(t ? 'taken' : b.stage || 'idea')}">${t ? 'Industry taken' : h.esc(STAGE[b.stage || 'idea'] || 'Idea')}</span></td>
      <td class="spd-c-contact">${b.contactName ? `<b>${h.esc(b.contactName)}</b>` : ''}${b.phone ? `<small>${h.esc(b.phone)}</small>` : ''}${b.email ? `<small>${h.esc(b.email)}</small>` : ''}${!b.contactName && !b.phone && !b.email ? '<small class="is-dim">no contact yet</small>' : ''}</td>
      <td class="spd-c-hist">${h2.best ? `<b>${h2.best.amountCents ? money0(h2.best.amountCents) : h.esc(TIER_WORD(h2.best.rank) || h2.best.what || 'Sponsor')}</b><small>${h.esc(h2.best.event)}${h2.best.year ? ' ' + h2.best.year : ''}${h2.deals.length > 1 ? ' · ' + h2.deals.length + ' deals' : ''}</small>` : '<small class="is-dim">nothing known</small>'}</td>
      <td class="spd-c-ask"><b>${suggestedAsk(b).cents ? money0(suggestedAsk(b).cents) : '—'}</b><small>${h.esc(suggestedAsk(b).label)}</small></td>
      <td class="spd-c-gives">${b.gives ? h.esc(GIVES[b.gives] || b.gives) : '<small class="is-dim">—</small>'}${b.givesWhat ? `<small>${h.esc(b.givesWhat)}</small>` : ''}</td>
      <td class="spd-c-soc">${b.facebook ? `<a href="${h.attr(b.facebook)}" target="_blank" rel="noopener" title="Facebook">f</a>` : ''}${b.instagram ? `<a href="${h.attr(b.instagram)}" target="_blank" rel="noopener" title="Instagram">&#9711;</a>` : ''}${b.website ? `<a href="${h.attr(b.website)}" target="_blank" rel="noopener" title="Website">&#127760;</a>` : ''}${b.shared ? '<em title="They shared our event">&#128227;</em>' : ''}</td>
    </tr>`;
    };
    const tableHtml = () => {
        const groups = {};
        rows.forEach((b) => {
            const k = b.industry || 'No industry yet';
            (groups[k] = groups[k] || []).push(b);
        });
        const names = Object.keys(groups).sort((x, y) => (x === 'No industry yet') - (y === 'No industry yet') || x.localeCompare(y));
        return `<div class="ad-card spd-tablewrap"><table class="spd-table spd-list">
      <thead><tr><th>Business</th><th>Value</th><th>Stage</th><th>Contact</th><th>Best known deal</th><th>Suggested ask</th><th>Usually gives</th><th>Links</th></tr></thead>
      <tbody>${names
          .map((n) => {
              const t = takenBy[key(n)];
              return (
                  `<tr class="spd-group"><td colspan="8"><b>${h.esc(n)}</b><span>${groups[n].length}</span>${t ? `<em>&#10003; taken by ${h.esc(t)}</em>` : '<em class="is-open">open</em>'}</td></tr>` +
                  groups[n].map(row).join('')
              );
          })
          .join('')}</tbody>
    </table></div>`;
    };

    /* POTENTIAL: per open industry, the best business we have not asked yet */
    const potentialTab = () => {
        const open = list.filter((b) => !['no', 'sponsor', 'asked'].includes(b.stage || 'idea') && !taken(b));
        const byInd = {};
        open.forEach((b) => {
            const k = b.industry || 'No industry yet';
            (byInd[k] = byInd[k] || []).push(b);
        });
        const rows = Object.keys(byInd)
            .map((ind) => {
                const g = byInd[ind].sort(
                    (a, b) => b.score - a.score || b.hist.bestTier - a.hist.bestTier || b.hist.backed - a.hist.backed
                );
                return { ind, best: g[0], others: g.length - 1, ask: suggestedAsk(g[0]) };
            })
            .sort(
                (a, b) =>
                    b.best.score - a.best.score ||
                    b.best.hist.bestTier - a.best.hist.bestTier ||
                    b.ask.cents - a.ask.cents ||
                    a.ind.localeCompare(b.ind)
            );
        const total = rows.reduce((t, r) => t + r.ask.cents, 0);
        const takenRows = Object.keys(takenBy).sort();
        return `<div class="spd-pot">
      <div class="spd-pot-stats">
        <div class="spd-stat is-target"><span class="spd-stat-ico">&#127919;</span><div><small>Potential on the table</small><b>${money0(total)}</b></div></div>
        <div class="spd-stat is-yes"><span class="spd-stat-ico">&#128269;</span><div><small>Open industries with a candidate</small><b>${rows.length}</b></div></div>
        <div class="spd-stat is-got"><span class="spd-stat-ico">&#10003;</span><div><small>Industries already taken</small><b>${takenRows.length}</b></div></div>
      </div>
      <p class="ad-seat-hint">The strongest business we have not asked yet in each open industry, best first. Suggested ask comes from the stars (5 = Gold, 4 = Silver, 3 = Bronze) or your budget guess. Set stars and facts in the profile to sharpen it.</p>
      ${
          rows.length
              ? `<div class="ad-card spd-tablewrap"><table class="spd-table"><thead><tr><th>Industry</th><th>Best candidate</th><th>Why</th><th class="spd-num">Suggested ask</th><th>Stage</th><th></th></tr></thead><tbody>
      ${rows
          .map((r) => {
              const b = r.best;
              return `<tr class="spd-row" data-spd-open="${h.attr(b.id)}">
        <td><b>${h.esc(r.ind)}</b>${r.others ? `<small>+${r.others} other${r.others === 1 ? '' : 's'}</small>` : ''}</td>
        <td><span class="spd-biz-in" style="--sp-brand:${h.attr(spColor(b))}">${spAvatar(h, b)}<span><b>${h.esc(b.business)}</b><small>${stars(b.score, 'spd-stars is-small')}${b.stars ? '' : ' <i class="spd-sugg">suggested</i>'}</small></span></span></td>
        <td class="spd-why">${h.esc(whyScore(b))}</td>
        <td class="spd-num"><b>${r.ask.cents ? money0(r.ask.cents) : '—'}</b><small>${h.esc(r.ask.label)} · ${h.esc(r.ask.basis || '')}</small></td>
        <td><span class="spd-stage is-${h.attr(b.stage || 'idea')}">${h.esc(STAGE[b.stage || 'idea'])}</span></td>
        <td class="spd-act">${b.phone ? `<a class="ad-btn ad-btn-small" href="tel:${h.attr(String(b.phone).replace(/\s+/g, ''))}">Call</a>` : ''}${b.email ? `<a class="ad-btn ad-btn-small" href="mailto:${h.attr(b.email)}">Email</a>` : ''}<button type="button" class="ad-btn ad-btn-small" data-spd-open="${h.attr(b.id)}">Open</button></td>
      </tr>`;
          })
          .join('')}</tbody></table></div>`
              : '<p class="ad-empty">Nothing to suggest yet - add businesses and give them an industry.</p>'
      }
      ${takenRows.length ? `<p class="spd-taken-line"><b>Taken:</b> ${takenRows.map((k) => h.esc(k) + ' (' + h.esc(takenBy[k]) + ')').join(' · ')}</p>` : ''}
    </div>`;
    };

    const industryTab = () => {
        const groups = {};
        list.forEach((b) => {
            const k = b.industry || 'No industry yet';
            (groups[k] = groups[k] || []).push(b);
        });
        const names = Object.keys(groups).sort((a, b) => (a === 'No industry yet') - (b === 'No industry yet') || a.localeCompare(b));
        return `<div class="spd-inds">${
            names
                .map((n) => {
                    const g = groups[n].sort((a, b) => b.score - a.score);
                    const t = takenBy[key(n)];
                    return `<section class="spd-ind${t ? ' is-taken' : ''}"><header><b>${h.esc(n)}</b><span>${g.length}</span>${t ? `<em>&#10003; ${h.esc(t)}</em>` : '<em class="is-open">open</em>'}</header>
        <ul>${g.map((b) => `<li data-spd-open="${h.attr(b.id)}">${spAvatar(h, b)}<span>${h.esc(b.business)}</span>${stars(b.score, 'spd-stars is-small')}<i class="spd-stage is-${h.attr(b.stage || 'idea')}">${h.esc(STAGE[b.stage || 'idea'])}</i></li>`).join('')}</ul></section>`;
                })
                .join('') || '<p class="ad-empty">No businesses yet.</p>'
        }</div>`;
    };

    const opt = (v, label, cur) => `<option value="${h.attr(v)}"${cur === v ? ' selected' : ''}>${h.esc(label)}</option>`;
    const sponsorsNow = list.filter((b) => b.stage === 'sponsor');
    const tagList = list
        .filter((b) => b.hist.backed || b.stage === 'sponsor')
        .map((b) => handle(b.instagram) || handle(b.facebook))
        .filter(Boolean);

    return `<div class="spd${state.spDirOpen ? ' has-panel' : ''}">
    <div class="spd-main">
      <div class="spd-head">
        <div><h1>Sponsor directory</h1><p>${list.length} business${list.length === 1 ? '' : 'es'} &middot; ${sponsorsNow.length} sponsor${sponsorsNow.length === 1 ? '' : 's'} &middot; ${Object.keys(takenBy).length} industr${Object.keys(takenBy).length === 1 ? 'y' : 'ies'} taken. Research here; send the ask from the event's Sponsors tab.</p></div>
        <button type="button" class="ad-btn" data-spd-tag${tagList.length ? '' : ' disabled title="No sponsor socials yet"'} title="Copies every sponsor's handle for a post">&#128227; Tag our sponsors</button>
        <button type="button" class="ad-btn" data-spd-find>&#128269; Find businesses</button>
        <span class="spd-import">
          <button type="button" class="ad-btn" data-spd-importmenu>&#8681; Import &#9662;</button>
          <span class="spd-import-menu"${state.spDirImportMenu ? '' : ' hidden'}>
            <button type="button" data-spd-import="leads">From the Lead Generator (${(state.leads || []).length})</button>
            <button type="button" data-spd-import="bowen">Every mapped business in Bowen</button>
            <button type="button" data-spd-import="whitsundays">Every mapped business in the Whitsundays</button>
          </span>
        </span>
        <button type="button" class="ad-btn ad-btn-primary" data-spd-new>+ Add a business</button>
      </div>
      <div class="spd-tabs">
        <button type="button" class="ad-tab${f.tab !== 'ind' ? ' is-on' : ''}" data-spd-tab="biz">Businesses</button>
        <button type="button" class="ad-tab${f.tab === 'pot' ? ' is-on' : ''}" data-spd-tab="pot">&#9733; Potential</button>
        <button type="button" class="ad-tab${f.tab === 'ind' ? ' is-on' : ''}" data-spd-tab="ind">Industries</button>
      </div>
      ${
          f.tab === 'pot'
              ? potentialTab()
              : f.tab === 'ind'
                ? industryTab()
                : `
      <div class="spd-filters">
        <input class="ad-input spd-q" type="search" placeholder="Search businesses, industries, contacts" value="${h.attr(f.q)}" data-spd-f="q">
        <select class="ad-select" data-spd-f="stage">${opt('', 'Stage: All', f.stage)}${STAGES.map(([k, l]) => opt(k, l, f.stage)).join('')}</select>
        <select class="ad-select" data-spd-f="industry">${opt('', 'Industry: All', f.industry)}${industries.map((i) => opt(i, i, f.industry)).join('')}</select>
      </div>
      ${rows.length ? tableHtml() : `<p class="ad-empty">${q || f.stage || f.industry ? 'No business matches that.' : 'Nothing here yet. Add a business, or press Find businesses.'}</p>`}`
      }
    </div>
    ${state.spDirOpen ? panelHtml(ctx, list, evOf, taken) : ''}
    ${state.spDirFind ? findHtml(ctx, list) : ''}
  </div>`;
}

function panelHtml(ctx, list, evOf, taken) {
    const { state, h } = ctx;
    const b = list.find((x) => x.id === state.spDirOpen);
    if (!b) return '';
    const f = (field, label, value, type, extra) =>
        `<label class="sp-f"><span>${label}</span><input class="ad-input" type="${type || 'text'}" value="${h.attr(value || '')}" data-spd-field="${field}"${extra || ''}></label>`;
    const sel = (field, label, map, cur) =>
        `<label class="sp-f"><span>${label}</span><select class="ad-select" data-spd-field="${field}">${Object.keys(map)
            .map((k) => `<option value="${h.attr(k)}"${(cur || '') === k ? ' selected' : ''}>${h.esc(map[k])}</option>`)
            .join('')}</select></label>`;
    const site = String(b.website || '')
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '');
    const t = taken(b);
    const sugg = suggestedScore(b, b.hist);
    return `<aside class="spd-panel" style="--sp-brand:${h.attr(spColor(b))}">
    <div class="spd-panel-top"><span>Business profile</span><button type="button" class="ad-drawer-close" data-spd-close aria-label="Close">&times;</button></div>
    <div class="spd-panel-id">
      <div class="spd-panel-logo">${spAvatar(h, b, true)}
        <label class="ad-btn ad-btn-small">${b.logo ? 'Change logo' : 'Upload logo'}<input type="file" accept="image/*" data-spd-logo hidden></label>
        ${site ? `<button type="button" class="ad-btn ad-btn-small" data-spd-lookup title="Reads their website for logo, blurb and socials">Fill from website</button>` : ''}
      </div>
      <div class="spd-panel-name">
        <h2>${h.esc(b.business)}</h2>
        <div class="spd-rate"><span class="spd-starpick" data-spd-stars>${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" class="${n <= b.score ? 'is-on' : ''}" aria-label="${n} stars">★</button>`).join('')}</span><small>${b.stars ? `your rating · suggested ${sugg}/5 <button type="button" class="ad-linkish" data-spd-unstar>use suggested</button>` : 'suggested from the facts - click to set your own'}</small></div>
        <p><span class="spd-stage is-${h.attr(b.stage || 'idea')}">${h.esc(STAGE[b.stage || 'idea'])}</span> <span class="spd-ask">Ask: <b>${suggestedAsk(b).cents ? money0(suggestedAsk(b).cents) : '—'}</b> ${h.esc(suggestedAsk(b).label)}</span>${t ? ` <span class="spd-stage is-taken">Industry taken by ${h.esc(t)}</span>` : ''}</p>
      </div>
    </div>
    <div class="spd-panel-body">
      <section class="spd-box"><h3>Stage</h3><div class="spd-stageline">${STAGES.map(([k, l]) => `<button type="button" class="${(b.stage || 'idea') === k ? 'is-on' : ''}" data-spd-stage="${k}">${l}</button>`).join('')}</div></section>
      <div class="spd-2">
        <section class="spd-box"><h3>The business</h3>
          ${f('business', 'Name', b.business)}
          <label class="sp-f"><span>Industry (one sponsor each)</span><input class="ad-input" list="spd-ind-list" value="${h.attr(b.industry || '')}" data-spd-field="industry"></label>
          <datalist id="spd-ind-list">${INDUSTRIES.map((i) => `<option value="${h.attr(i)}">`).join('')}</datalist>
          ${sel('size', 'Size', SIZE, b.size)}
          ${sel('local', 'How local', LOCAL, b.local)}
          <label class="sp-f"><span>Likely budget (a guess)</span><input class="ad-input" data-spd-money="budgetCents" placeholder="$" value="${b.budgetCents ? Math.round(b.budgetCents / 100) : ''}"></label>
          <label class="sp-f"><span>Blurb</span><textarea class="ad-input" rows="2" data-spd-field="blurb" maxlength="300">${h.esc(b.blurb || '')}</textarea></label>
        </section>
        <section class="spd-box"><h3>Contact</h3>
          ${f('contactName', 'Contact person', b.contactName)}
          ${f('role', 'Their role', b.role)}
          ${f('phone', 'Phone', b.phone, 'tel')}
          ${f('email', 'Email', b.email, 'email')}
          ${f('website', 'Website', b.website, 'url', ' placeholder="https://"')}
          ${f('address', 'Address', b.address)}
          <label class="sp-f"><span>Brand colour</span><span class="sp-color"><input type="color" value="${h.attr(spColor(b))}" data-spd-field="color"><code>${h.esc(spColor(b))}</code></span></label>
        </section>
      </div>
      <div class="spd-2">
        <section class="spd-box"><h3>Socials</h3>
          ${f('facebook', 'Facebook', b.facebook, 'url', ' placeholder="https://www.facebook.com/..."')}
          ${f('instagram', 'Instagram', b.instagram, 'url', ' placeholder="https://www.instagram.com/..."')}
          <label class="spd-check"><input type="checkbox" data-spd-bool="shared"${b.shared ? ' checked' : ''}> They shared our event</label>
          ${b.facebook || b.instagram ? `<p class="ad-seat-hint">Tag: ${h.esc([handle(b.facebook), handle(b.instagram)].filter(Boolean).join(' / '))}</p>` : ''}
        </section>
        <section class="spd-box"><h3>What they give</h3>
          ${sel('gives', 'Usually', GIVES, b.gives)}
          ${f('givesWhat', 'Details', b.givesWhat, 'text', ' placeholder="e.g. $500 cash, a $100 voucher, the PA"')}
          <label class="sp-f"><span>Last asked</span><input class="ad-input" type="date" data-spd-field="lastAskedAt" value="${h.attr(b.hist.lastAsked || b.lastAskedAt || '')}"></label>
        </section>
      </div>
      <section class="spd-box spd-deals"><h3>Sponsorship history <small>what they have given, to anyone</small></h3>
        ${
            b.hist.deals.length
                ? `<table class="spd-deal-table"><thead><tr><th>Event</th><th>Year</th><th class="spd-num">Gave</th><th>What / how you know</th><th></th></tr></thead><tbody>${b.hist.deals.map((d) => `<tr><td>${h.esc(d.event)}${d.ours ? ' <i class="spd-ours">ours</i>' : ''}</td><td>${d.year || ''}</td><td class="spd-num">${d.amountCents ? money0(d.amountCents) : TIER_WORD(d.rank) ? '<i>' + h.esc(TIER_WORD(d.rank)) + '</i>' : '—'}</td><td>${h.esc([d.what, d.source].filter(Boolean).join(' · '))}</td><td>${d.ours ? '' : `<button type="button" class="ad-linkish" data-spd-dealdel="${h.attr(d.key || '')}" title="Remove">&times;</button>`}</td></tr>`).join('')}</tbody></table>
        <p class="ad-seat-hint">Best known: <b>${h.esc(b.hist.bestLabel)}</b> &rarr; suggested ask <b>${money0(suggestedAsk(b).cents)}</b> (${h.esc(suggestedAsk(b).label)}).</p>`
                : '<p class="ad-seat-hint">Nothing known yet. Look at the Show, the Fishing Classic, the footy club, the school fete - who they back and how much - and log it here. That sets the ask.</p>'
        }
        <form class="spd-deal-form" data-spd-dealform>
          <input class="ad-input" name="event" placeholder="Event or club (e.g. Bowen Show)" required maxlength="80">
          <input class="ad-input" name="year" type="number" placeholder="Year" min="2000" max="2100">
          <input class="ad-input" name="amount" placeholder="$ (if known)" inputmode="decimal">
          <input class="ad-input" name="what" placeholder="What they gave / level" maxlength="80">
          <input class="ad-input" name="source" placeholder="How you know (poster, website, Max)" maxlength="80">
          <button type="submit" class="ad-btn ad-btn-small ad-btn-primary">+ Add</button>
        </form>
      </section>
      <section class="spd-box"><h3>With us</h3>
        ${b.hist.records.length ? `<ul class="spd-evlist">${b.hist.records.map((p) => `<li><a href="#/event?id=${encodeURIComponent(p.eventId)}&tab=sponsors">${h.esc((evOf[p.eventId] || {}).name || p.eventId)}</a><em>${h.esc((evOf[p.eventId] || {}).dateLabel || '')}</em><span class="spd-stage is-${p.status === 'yes' ? 'sponsor' : p.status === 'no' ? 'no' : 'asked'}">${h.esc({ yes: 'Sponsor', no: 'Said no', asked: 'Asked', interested: 'Interested', todo: 'To ask' }[p.status || 'todo'])}${p.level ? ' · ' + h.esc(p.level) : ''}${p.amountCents ? ' · ' + money0(p.amountCents) : ''}</span></li>`).join('')}</ul>` : '<p class="ad-seat-hint">Not on any event yet. Add them to an event\'s Sponsors tab to send the ask.</p>'}
      </section>
      <section class="spd-box"><h3>Research notes</h3><textarea class="ad-input" rows="4" data-spd-field="notes" placeholder="Who to talk to, what they care about, what they have sponsored before&hellip;">${h.esc(b.notes || '')}</textarea></section>
    </div>
    <div class="spd-panel-acts">
      ${b.email ? `<a class="ad-btn" href="mailto:${h.attr(b.email)}">Email</a>` : ''}${b.phone ? `<a class="ad-btn" href="tel:${h.attr(String(b.phone).replace(/\s+/g, ''))}">Call</a>` : ''}
      <select class="ad-select" data-spd-addto><option value="">Add to an event&hellip;</option>${Object.values(evOf)
          .filter((e) => e.status !== 'archived' && !b.hist.records.some((p) => p.eventId === e.id))
          .map((e) => `<option value="${h.attr(e.id)}">${h.esc(e.name)}${e.subtitle ? ' - ' + h.esc(e.subtitle) : ''}</option>`)
          .join('')}</select>
      <button type="button" class="ad-btn ms-sp-del-btn" data-spd-del>Remove</button>
    </div>
  </aside>`;
}

function findHtml(ctx, list) {
    const { state, h } = ctx;
    const fd = state.spDirFind;
    const have = new Set(list.map((b) => key(b.business)));
    return `<div class="sp-scrim" data-spd-findclose></div>
  <div class="spd-find" role="dialog" aria-label="Find businesses">
    <div class="spd-find-top"><b>Find businesses around Bowen</b><button type="button" class="ad-drawer-close" data-spd-findclose aria-label="Close">&times;</button></div>
    <form class="spd-find-form" data-spd-findform><input class="ad-input" placeholder="e.g. car dealers, cafes, real estate, or a name" value="${h.attr(fd.q || '')}" data-spd-findq autofocus><button type="submit" class="ad-btn ad-btn-primary"${fd.busy ? ' disabled' : ''}>${fd.busy ? 'Looking…' : 'Search'}</button></form>
    <p class="ad-seat-hint">From OpenStreetMap, so small places can be missing - add those by hand. Tick the ones to add; each gets a logo, blurb and socials from its website where it has one.</p>
    ${fd.error ? `<p class="ms-msg ms-bad">${h.esc(fd.error)}</p>` : ''}
    ${
        fd.results
            ? fd.results.length
                ? `<ul class="spd-find-list">${fd.results
                      .map((r, i) => {
                          const dup = have.has(key(r.business));
                          return `<li class="${dup ? 'is-dup' : ''}"><label><input type="checkbox" data-spd-findpick="${i}"${dup ? ' disabled' : ''}><span><b>${h.esc(r.business)}</b>${dup ? ' <i>already in the directory</i>' : ''}<small>${h.esc([r.kind, r.address].filter(Boolean).join(' · '))}</small><small>${h.esc([r.phone, r.website ? r.website.replace(/^https?:\/\//, '') : ''].filter(Boolean).join(' · ') || 'no phone or website listed')}</small></span></label></li>`;
                      })
                      .join('')}</ul>
      <div class="spd-find-acts"><label class="sp-f"><span>Industry for these</span><input class="ad-input" list="spd-ind-list2" data-spd-findind placeholder="e.g. Automotive"><datalist id="spd-ind-list2">${INDUSTRIES.map((i) => `<option value="${h.attr(i)}">`).join('')}</datalist></label><button type="button" class="ad-btn ad-btn-primary" data-spd-findadd${fd.adding ? ' disabled' : ''}>${fd.adding ? 'Adding…' : 'Add ticked to the directory'}</button></div>`
                : '<p class="ad-empty">Nothing found for that. Try another word, or add it by hand.</p>'
            : ''
    }
  </div>`;
}

export function wireSponsorDir(ctx) {
    const { state, render, biz, sponsors, upload, call } = ctx;
    const root = document.querySelector('.spd');
    if (!root) return;
    const current = () => (state.sponsorBiz || []).find((x) => x.id === state.spDirOpen);
    const toCents = (v) => Math.max(0, Math.round(Number(String(v).replace(/[^0-9.]/g, '')) * 100) || 0);
    const lookup = async (b) => {
        const r = await call('lookupBusiness', { website: b.website });
        const d = r || {};
        const patch = {};
        if (d.logo && !b.logo) patch.logo = d.logo;
        if (d.blurb && !b.blurb) patch.blurb = d.blurb;
        if (d.facebook && !b.facebook) patch.facebook = d.facebook;
        if (d.instagram && !b.instagram) patch.instagram = d.instagram;
        if (d.phone && !b.phone) patch.phone = d.phone;
        if (d.email && !b.email) patch.email = d.email;
        return patch;
    };

    root.addEventListener('click', async (e) => {
        if (e.target.closest('[data-spd-close]')) {
            state.spDirOpen = null;
            render();
            return;
        }
        if (e.target.closest('[data-spd-findclose]')) {
            state.spDirFind = null;
            render();
            return;
        }
        const tab = e.target.closest('[data-spd-tab]');
        if (tab) {
            state.spDir.tab = tab.getAttribute('data-spd-tab');
            render();
            return;
        }
        const op = e.target.closest('[data-spd-open]');
        if (op && !e.target.closest('a, button, input, label, select')) {
            state.spDirOpen = op.getAttribute('data-spd-open');
            render();
            return;
        }
        if (e.target.closest('[data-spd-find]')) {
            state.spDirFind = { q: '', results: null };
            render();
            return;
        }
        if (e.target.closest('[data-spd-importmenu]')) {
            state.spDirImportMenu = !state.spDirImportMenu;
            render();
            return;
        }
        const imp = e.target.closest('[data-spd-import]');
        if (imp) {
            state.spDirImportMenu = false;
            const what = imp.getAttribute('data-spd-import');
            const have = new Set((state.sponsorBiz || []).map((b) => key(b.business)));
            let list;
            imp.disabled = true;
            imp.textContent = 'Fetching…';
            try {
                if (what === 'leads') {
                    list = (state.leads || [])
                        .filter((l) => l.title)
                        .map((l) => ({
                            business: String(l.title).slice(0, 120),
                            industry: String(l.category || '').slice(0, 60),
                            contactName: l.contactName || '',
                            phone: l.phone || '',
                            email: l.email || '',
                            website: l.website || '',
                            facebook: /facebook\.com/i.test(l.socials || '')
                                ? String(l.socials).match(/https?:\/\/[^\s,]*facebook\.com[^\s,]*/i)[0]
                                : '',
                            instagram: /instagram\.com/i.test(l.socials || '')
                                ? String(l.socials).match(/https?:\/\/[^\s,]*instagram\.com[^\s,]*/i)[0]
                                : '',
                            address: l.address || l.suburb || '',
                            notes: l.notes || '',
                            local: 'bowen',
                            source: 'lead',
                            leadId: l.id
                        }));
                } else {
                    const r = await call('importMapBusinesses', { region: what });
                    list = ((r && r.results) || []).map((b) => ({ ...b, kind: undefined, source: 'osm' }));
                    list.forEach((b) => {
                        delete b.kind;
                    });
                }
            } catch (err) {
                window.alert(err.message || 'Import failed.');
                render();
                return;
            }
            const fresh = list.filter((b) => b.business && !have.has(key(b.business)));
            if (!fresh.length) {
                window.alert('Nothing new - they are all in the directory already.');
                render();
                return;
            }
            if (
                !window.confirm(
                    'Add ' +
                        fresh.length +
                        ' business' +
                        (fresh.length === 1 ? '' : 'es') +
                        ' to the directory? (' +
                        (list.length - fresh.length) +
                        ' already in.)'
                )
            ) {
                render();
                return;
            }
            await biz.addMany(fresh);
            window.alert('Added ' + fresh.length + '. Open any of them and press "Fill from website" for logo, blurb and socials.');
            return;
        }
        if (e.target.closest('[data-spd-new]')) {
            const name = window.prompt('Business name');
            if (!name || !name.trim()) return;
            const id = await biz.add({ business: name.trim().slice(0, 120), source: 'manual' });
            state.spDirOpen = id;
            render();
            return;
        }
        if (e.target.closest('[data-spd-tag]')) {
            const all = (state.sponsorBiz || []).filter((b) => b.stage === 'sponsor' || history(b, state.sponsorsAll || [], {}).backed);
            const tags = [...new Set(all.map((b) => handle(b.instagram) || handle(b.facebook)).filter(Boolean))];
            try {
                await navigator.clipboard.writeText(tags.join(' '));
                window.alert('Copied ' + tags.length + ' handle' + (tags.length === 1 ? '' : 's') + ':\n' + tags.join(' '));
            } catch (err) {
                window.prompt('Copy these:', tags.join(' '));
            }
            return;
        }
        if (e.target.closest('[data-spd-findadd]')) {
            const fd = state.spDirFind;
            if (!fd || !fd.results) return;
            const picks = [...root.querySelectorAll('[data-spd-findpick]:checked')]
                .map((x) => fd.results[+x.getAttribute('data-spd-findpick')])
                .filter(Boolean);
            if (!picks.length) {
                window.alert('Tick at least one.');
                return;
            }
            const industry = String((root.querySelector('[data-spd-findind]') || {}).value || '')
                .trim()
                .slice(0, 60);
            fd.adding = true;
            render();
            for (const r of picks) {
                const rec = {
                    business: r.business,
                    industry,
                    website: r.website || '',
                    phone: r.phone || '',
                    email: r.email || '',
                    address: r.address || '',
                    facebook: r.facebook || '',
                    instagram: r.instagram || '',
                    local: 'bowen',
                    source: 'osm',
                    stage: 'idea'
                };
                if (r.website) {
                    try {
                        Object.assign(rec, await lookup(rec));
                    } catch (err) {
                        /* no website info - fine */
                    }
                }
                await biz.add(rec);
            }
            state.spDirFind = null;
            render();
            return;
        }
        const b = current();
        if (!b) return;
        const st = e.target.closest('[data-spd-stage]');
        if (st) {
            const patch = { stage: st.getAttribute('data-spd-stage') };
            if (patch.stage === 'asked' && !b.lastAskedAt) patch.lastAskedAt = today();
            await biz.update(b.id, patch);
            return;
        }
        const star = e.target.closest('[data-spd-stars] button');
        if (star) {
            await biz.update(b.id, { stars: +star.getAttribute('data-n') });
            return;
        }
        if (e.target.closest('[data-spd-unstar]')) {
            await biz.update(b.id, { stars: 0 });
            return;
        }
        if (e.target.closest('[data-spd-lookup]')) {
            const btn = e.target.closest('[data-spd-lookup]');
            btn.disabled = true;
            btn.textContent = 'Reading…';
            try {
                const patch = await lookup(b);
                if (!Object.keys(patch).length) {
                    window.alert('Nothing new found on their site.');
                    btn.disabled = false;
                    btn.textContent = 'Fill from website';
                } else await biz.update(b.id, patch);
            } catch (err) {
                window.alert(err.message || 'Could not read their website.');
                btn.disabled = false;
                btn.textContent = 'Fill from website';
            }
            return;
        }
        const dd = e.target.closest('[data-spd-dealdel]');
        if (dd) {
            const k = dd.getAttribute('data-spd-dealdel');
            await biz.update(b.id, { past: (b.past || []).filter((d) => String(d.key || '') !== k) });
            return;
        }
        if (e.target.closest('[data-spd-del]')) {
            if (!window.confirm('Remove ' + b.business + ' from the directory? Their event records stay.')) return;
            state.spDirOpen = null;
            await biz.remove(b.id);
        }
    });

    root.addEventListener('submit', async (e) => {
        if (e.target.matches('[data-spd-dealform]')) {
            e.preventDefault();
            const b = current();
            if (!b) return;
            const fd = new FormData(e.target);
            const deal = {
                key: String(Date.now()),
                event: String(fd.get('event') || '')
                    .trim()
                    .slice(0, 80),
                year: +fd.get('year') || 0,
                amountCents: toCents(fd.get('amount')),
                what: String(fd.get('what') || '')
                    .trim()
                    .slice(0, 80),
                source: String(fd.get('source') || '')
                    .trim()
                    .slice(0, 80)
            };
            if (!deal.event) return;
            await biz.update(b.id, { past: (b.past || []).concat([deal]) });
            return;
        }
        if (!e.target.matches('[data-spd-findform]')) return;
        e.preventDefault();
        const fd = state.spDirFind;
        if (!fd) return;
        fd.q = String((root.querySelector('[data-spd-findq]') || {}).value || '').trim();
        if (fd.q.length < 2) return;
        fd.busy = true;
        fd.error = '';
        render();
        try {
            const r = await call('findBusinesses', { query: fd.q });
            fd.results = (r && r.results) || [];
        } catch (err) {
            fd.error = err.message || 'Search failed.';
            fd.results = null;
        }
        fd.busy = false;
        render();
    });

    root.addEventListener('input', (e) => {
        const t = e.target;
        if (t.matches('[data-spd-f="q"]')) {
            state.spDir.q = t.value;
            const pos = t.selectionStart;
            render();
            const again = root.querySelector('[data-spd-f="q"]');
            if (again) {
                again.focus();
                again.setSelectionRange(pos, pos);
            }
        }
    });

    root.addEventListener('change', async (e) => {
        const t = e.target;
        if (t.matches('[data-spd-f]') && t.getAttribute('data-spd-f') !== 'q') {
            state.spDir[t.getAttribute('data-spd-f')] = t.value;
            render();
            return;
        }
        const b = current();
        if (!b) return;
        if (t.matches('[data-spd-field]')) {
            const field = t.getAttribute('data-spd-field');
            let value = String(t.value || '')
                .trim()
                .slice(0, field === 'notes' ? 3000 : field === 'blurb' ? 300 : 200);
            if (field === 'color' && !/^#[0-9a-f]{6}$/i.test(value)) value = '';
            if (['website', 'facebook', 'instagram'].includes(field) && value && !/^https?:\/\//i.test(value)) value = 'https://' + value;
            if (field === 'business' && !value) return;
            await biz.update(b.id, { [field]: value });
            return;
        }
        if (t.matches('[data-spd-money]')) {
            await biz.update(b.id, { [t.getAttribute('data-spd-money')]: toCents(t.value) });
            return;
        }
        if (t.matches('[data-spd-bool]')) {
            await biz.update(b.id, { [t.getAttribute('data-spd-bool')]: !!t.checked });
            return;
        }
        if (t.matches('[data-spd-addto]') && t.value) {
            await sponsors.add({
                business: b.business,
                bizId: b.id,
                contactName: b.contactName || '',
                email: b.email || '',
                phone: b.phone || '',
                website: b.website || '',
                logo: b.logo || '',
                color: b.color || '',
                source: 'directory',
                eventId: t.value
            });
            window.alert(b.business + " is now on that event's Sponsors tab - send the ask from there.");
            return;
        }
        if (t.matches('[data-spd-logo]')) {
            const file = t.files && t.files[0];
            if (!file || !upload) return;
            try {
                const url = await upload(file, 'sponsor-logos/' + b.id + '/');
                await biz.update(b.id, { logo: url });
            } catch (err) {
                window.alert('Upload failed - ' + (err.message || 'try again'));
            }
        }
    });
}
