/*  SPONSOR DIRECTORY - research, not asking. Every business worth knowing
    about, one card each: logo, industry, a value score, a stage
    (Idea -> Researching -> Ready to ask -> Asked -> Sponsor), contact,
    socials, what they usually give, and their history with our events.

    The ask itself still goes from an event's Sponsors tab; that creates the
    per-event record in `sponsors`. The directory lives in `sponsorBiz`,
    one doc per business, and reads `sponsors` for the history.

    One sponsor per industry: once a business in an industry has said yes
    to the event picked, the others in that industry show "industry taken". */

import { spAvatar, spColor } from './messages.js?v=803';

export const STAGES = [['idea', 'Idea'], ['research', 'Researching'], ['ready', 'Ready to ask'], ['asked', 'Asked'], ['sponsor', 'Sponsor'], ['no', 'Not now']];
const STAGE = Object.fromEntries(STAGES);
const SIZE = { '': '—', small: 'Small (1-5 staff)', medium: 'Medium (6-20)', large: 'Large (20+)', corp: 'Corporate / chain' };
const LOCAL = { '': '—', bowen: 'Bowen', whitsundays: 'Whitsundays', nq: 'North Queensland', far: 'Further away' };
const GIVES = { '': '—', cash: 'Cash', inkind: 'In-kind', prize: 'Prizes', mix: 'Cash + prizes' };
export const INDUSTRIES = ['Automotive', 'Real estate', 'Building & trades', 'Mining & industry', 'Finance & accounting', 'Legal', 'Insurance', 'Health & medical', 'Beauty & hair', 'Fitness & sport', 'Hospitality - pubs & clubs', 'Hospitality - cafes & restaurants', 'Accommodation & tourism', 'Retail - groceries', 'Retail - hardware & home', 'Retail - fashion & gifts', 'Printing & signage', 'Media & marketing', 'Agriculture & fishing', 'Marine & boating', 'Transport & logistics', 'Education & childcare', 'Government & council', 'Community & not-for-profit', 'Other'];

const key = (s) => String(s || '').trim().toLowerCase();
const money0 = (c) => '$' + Math.round((c || 0) / 100).toLocaleString('en-AU');
const today = () => new Date().toISOString().slice(0, 10);
const niceDate = (iso) => iso ? new Date(String(iso).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const secs = (t) => (t && typeof t.seconds === 'number') ? t.seconds : 0;
const handle = (url) => { const m = /(?:facebook|instagram)\.com\/([A-Za-z0-9_.-]+)/i.exec(String(url || '')); return m ? '@' + m[1] : ''; };

/* the suggested value, 1-5, from the facts; their own stars win if set */
export function suggestedScore(b, hist) {
  let s = 0;
  s += { small: 1, medium: 2, large: 3, corp: 3 }[b.size] || 0;
  s += { bowen: 2, whitsundays: 1.5, nq: 1, far: 0 }[b.local] || 0;
  s += Math.min(2, (hist.backed || 0));
  if (b.budgetCents >= 200000) s += 2; else if (b.budgetCents >= 50000) s += 1;
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
  return { records: mine, backed: yes.length, cents, lastAsked: asked ? new Date(secs(asked.askedAt) * 1000).toISOString().slice(0, 10) : '', events: yes.map((p) => (evOf[p.eventId] || {}).name || p.eventId) };
}

export function sponsorDirHtml(ctx) {
  const { state, h } = ctx;
  const f = state.spDir || (state.spDir = { tab: 'biz', q: '', stage: '', industry: '', event: state.activeEventId || '' });
  const events = (state.events || []).slice().sort((a, b) => String(b.dateISO || '').localeCompare(String(a.dateISO || '')));
  const evOf = Object.fromEntries(events.map((e) => [e.id, e]));
  const sponsors = state.sponsorsAll || [];
  const list = (state.sponsorBiz || []).map((b) => { const hist = history(b, sponsors, evOf); return { ...b, hist, score: b.stars || suggestedScore(b, hist) }; });

  // industry exclusivity for the event picked
  const takenBy = {};
  sponsors.filter((p) => p.status === 'yes' && (!f.event || p.eventId === f.event)).forEach((p) => {
    const biz = list.find((b) => (p.bizId && p.bizId === b.id) || key(p.business) === key(b.business));
    const ind = key(biz && biz.industry);
    if (ind && !takenBy[ind]) takenBy[ind] = p.business;
  });
  const taken = (b) => { const t = takenBy[key(b.industry)]; return t && key(t) !== key(b.business) ? t : ''; };

  const q = key(f.q);
  const rows = list.filter((b) => (!f.stage || (b.stage || 'idea') === f.stage) && (!f.industry || key(b.industry) === key(f.industry))
    && (!q || [b.business, b.industry, b.contactName, b.email, b.website, b.notes, b.blurb].some((v) => key(v).includes(q))))
    .sort((a, b) => b.score - a.score || (b.hist.backed - a.hist.backed) || String(a.business).localeCompare(String(b.business)));
  const industries = [...new Set(INDUSTRIES.concat(list.map((b) => b.industry).filter(Boolean)))];

  const card = (b) => {
    const t = taken(b);
    return `<article class="spd-biz${state.spDirOpen === b.id ? ' is-open' : ''}${t ? ' is-taken' : ''}" data-spd-open="${h.attr(b.id)}" style="--sp-brand:${h.attr(spColor(b))}">
      <div class="spd-biz-top">${spAvatar(h, b, true)}
        <div class="spd-biz-head"><b>${h.esc(b.business)}</b>
          <span>${h.esc(b.industry || 'No industry yet')}</span>
          ${stars(b.score)}${b.stars ? '' : '<i class="spd-sugg" title="Suggested from the facts - set your own stars in the profile">suggested</i>'}
        </div>
        <span class="spd-stage is-${h.attr(t ? 'taken' : (b.stage || 'idea'))}">${t ? 'Industry taken' : h.esc(STAGE[b.stage || 'idea'] || 'Idea')}</span>
      </div>
      ${b.blurb ? `<p class="spd-blurb">${h.esc(b.blurb.length > 120 ? b.blurb.slice(0, 117) + '…' : b.blurb)}</p>` : ''}
      <ul class="spd-facts">
        ${b.contactName || b.phone ? `<li>&#128100; ${h.esc([b.contactName, b.phone].filter(Boolean).join(' · '))}</li>` : ''}
        ${b.gives ? `<li>&#127873; ${h.esc(GIVES[b.gives] || b.gives)}${b.givesWhat ? ' - ' + h.esc(b.givesWhat) : ''}</li>` : ''}
        <li>&#128197; ${b.hist.backed ? `Backed ${b.hist.backed} event${b.hist.backed === 1 ? '' : 's'}${b.hist.cents ? ', ' + money0(b.hist.cents) : ''}` : 'Never sponsored us'}${b.hist.lastAsked || b.lastAskedAt ? ' · last asked ' + h.esc(niceDate(b.hist.lastAsked || b.lastAskedAt)) : ''}</li>
        ${t ? `<li class="is-warn">&#9888; ${h.esc(t)} already sponsors this industry</li>` : ''}
      </ul>
      <div class="spd-biz-foot">
        ${b.facebook ? `<a href="${h.attr(b.facebook)}" target="_blank" rel="noopener" title="Facebook">f</a>` : ''}${b.instagram ? `<a href="${h.attr(b.instagram)}" target="_blank" rel="noopener" title="Instagram">&#9711;</a>` : ''}${b.website ? `<a href="${h.attr(b.website)}" target="_blank" rel="noopener" title="Website">&#127760;</a>` : ''}
        ${b.shared ? '<em title="They shared our event">&#128227; shared</em>' : ''}
      </div>
    </article>`;
  };

  const industryTab = () => {
    const groups = {};
    list.forEach((b) => { const k = b.industry || 'No industry yet'; (groups[k] = groups[k] || []).push(b); });
    const names = Object.keys(groups).sort((a, b) => (a === 'No industry yet') - (b === 'No industry yet') || a.localeCompare(b));
    return `<div class="spd-inds">${names.map((n) => {
      const g = groups[n].sort((a, b) => b.score - a.score);
      const t = takenBy[key(n)];
      return `<section class="spd-ind${t ? ' is-taken' : ''}"><header><b>${h.esc(n)}</b><span>${g.length}</span>${t ? `<em>&#10003; ${h.esc(t)}</em>` : '<em class="is-open">open</em>'}</header>
        <ul>${g.map((b) => `<li data-spd-open="${h.attr(b.id)}">${spAvatar(h, b)}<span>${h.esc(b.business)}</span>${stars(b.score, 'spd-stars is-small')}<i class="spd-stage is-${h.attr(b.stage || 'idea')}">${h.esc(STAGE[b.stage || 'idea'])}</i></li>`).join('')}</ul></section>`;
    }).join('') || '<p class="ad-empty">No businesses yet.</p>'}</div>`;
  };

  const opt = (v, label, cur) => `<option value="${h.attr(v)}"${cur === v ? ' selected' : ''}>${h.esc(label)}</option>`;
  const sponsorsNow = list.filter((b) => (b.stage === 'sponsor'));
  const tagList = list.filter((b) => b.hist.backed || b.stage === 'sponsor').map((b) => handle(b.instagram) || handle(b.facebook)).filter(Boolean);

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
        <button type="button" class="ad-tab${f.tab === 'ind' ? ' is-on' : ''}" data-spd-tab="ind">Industries</button>
        <label class="spd-evpick">One sponsor per industry for: <select class="ad-select" data-spd-f="event">${opt('', 'any event', f.event)}${events.filter((e) => e.status !== 'archived').map((e) => opt(e.id, e.name + (e.subtitle ? ' - ' + e.subtitle : ''), f.event)).join('')}</select></label>
      </div>
      ${f.tab === 'ind' ? industryTab() : `
      <div class="spd-filters">
        <input class="ad-input spd-q" type="search" placeholder="Search businesses, industries, contacts" value="${h.attr(f.q)}" data-spd-f="q">
        <select class="ad-select" data-spd-f="stage">${opt('', 'Stage: All', f.stage)}${STAGES.map(([k, l]) => opt(k, l, f.stage)).join('')}</select>
        <select class="ad-select" data-spd-f="industry">${opt('', 'Industry: All', f.industry)}${industries.map((i) => opt(i, i, f.industry)).join('')}</select>
      </div>
      ${rows.length ? `<div class="spd-grid">${rows.map(card).join('')}</div>` : `<p class="ad-empty">${q || f.stage || f.industry ? 'No business matches that.' : 'Nothing here yet. Add a business, or press Find businesses.'}</p>`}`}
    </div>
    ${state.spDirOpen ? panelHtml(ctx, list, evOf, taken) : ''}
    ${state.spDirFind ? findHtml(ctx, list) : ''}
  </div>`;
}

function panelHtml(ctx, list, evOf, taken) {
  const { state, h } = ctx;
  const b = list.find((x) => x.id === state.spDirOpen);
  if (!b) return '';
  const f = (field, label, value, type, extra) => `<label class="sp-f"><span>${label}</span><input class="ad-input" type="${type || 'text'}" value="${h.attr(value || '')}" data-spd-field="${field}"${extra || ''}></label>`;
  const sel = (field, label, map, cur) => `<label class="sp-f"><span>${label}</span><select class="ad-select" data-spd-field="${field}">${Object.keys(map).map((k) => `<option value="${h.attr(k)}"${(cur || '') === k ? ' selected' : ''}>${h.esc(map[k])}</option>`).join('')}</select></label>`;
  const site = String(b.website || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
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
        <p><span class="spd-stage is-${h.attr(b.stage || 'idea')}">${h.esc(STAGE[b.stage || 'idea'])}</span>${t ? ` <span class="spd-stage is-taken">Industry taken by ${h.esc(t)}</span>` : ''}</p>
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
      <section class="spd-box"><h3>History</h3>
        ${b.hist.records.length ? `<ul class="spd-evlist">${b.hist.records.map((p) => `<li><a href="#/event?id=${encodeURIComponent(p.eventId)}&tab=sponsors">${h.esc((evOf[p.eventId] || {}).name || p.eventId)}</a><em>${h.esc((evOf[p.eventId] || {}).dateLabel || '')}</em><span class="spd-stage is-${p.status === 'yes' ? 'sponsor' : p.status === 'no' ? 'no' : 'asked'}">${h.esc({ yes: 'Sponsor', no: 'Said no', asked: 'Asked', interested: 'Interested', todo: 'To ask' }[p.status || 'todo'])}${p.level ? ' · ' + h.esc(p.level) : ''}${p.amountCents ? ' · ' + money0(p.amountCents) : ''}</span></li>`).join('')}</ul>` : '<p class="ad-seat-hint">Not on any event yet. Add them to an event\'s Sponsors tab to send the ask.</p>'}
      </section>
      <section class="spd-box"><h3>Research notes</h3><textarea class="ad-input" rows="4" data-spd-field="notes" placeholder="Who to talk to, what they care about, what they have sponsored before&hellip;">${h.esc(b.notes || '')}</textarea></section>
    </div>
    <div class="spd-panel-acts">
      ${b.email ? `<a class="ad-btn" href="mailto:${h.attr(b.email)}">Email</a>` : ''}${b.phone ? `<a class="ad-btn" href="tel:${h.attr(String(b.phone).replace(/\s+/g, ''))}">Call</a>` : ''}
      <select class="ad-select" data-spd-addto><option value="">Add to an event&hellip;</option>${Object.values(evOf).filter((e) => e.status !== 'archived' && !b.hist.records.some((p) => p.eventId === e.id)).map((e) => `<option value="${h.attr(e.id)}">${h.esc(e.name)}${e.subtitle ? ' - ' + h.esc(e.subtitle) : ''}</option>`).join('')}</select>
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
    ${fd.results ? (fd.results.length ? `<ul class="spd-find-list">${fd.results.map((r, i) => { const dup = have.has(key(r.business)); return `<li class="${dup ? 'is-dup' : ''}"><label><input type="checkbox" data-spd-findpick="${i}"${dup ? ' disabled' : ''}><span><b>${h.esc(r.business)}</b>${dup ? ' <i>already in the directory</i>' : ''}<small>${h.esc([r.kind, r.address].filter(Boolean).join(' · '))}</small><small>${h.esc([r.phone, r.website ? r.website.replace(/^https?:\/\//, '') : ''].filter(Boolean).join(' · ') || 'no phone or website listed')}</small></span></label></li>`; }).join('')}</ul>
      <div class="spd-find-acts"><label class="sp-f"><span>Industry for these</span><input class="ad-input" list="spd-ind-list2" data-spd-findind placeholder="e.g. Automotive"><datalist id="spd-ind-list2">${INDUSTRIES.map((i) => `<option value="${h.attr(i)}">`).join('')}</datalist></label><button type="button" class="ad-btn ad-btn-primary" data-spd-findadd${fd.adding ? ' disabled' : ''}>${fd.adding ? 'Adding…' : 'Add ticked to the directory'}</button></div>` : '<p class="ad-empty">Nothing found for that. Try another word, or add it by hand.</p>') : ''}
  </div>`;
}

export function wireSponsorDir(ctx) {
  const { state, render, biz, sponsors, upload, call } = ctx;
  const root = document.getElementById('ad-desk');
  if (!root) return;
  const current = () => (state.sponsorBiz || []).find((x) => x.id === state.spDirOpen);
  const toCents = (v) => Math.max(0, Math.round(Number(String(v).replace(/[^0-9.]/g, '')) * 100) || 0);
  const lookup = async (b) => {
    const r = await call('lookupBusiness', { website: b.website });
    const d = (r && r.data) || {};
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
    if (e.target.closest('[data-spd-close]')) { state.spDirOpen = null; render(); return; }
    if (e.target.closest('[data-spd-findclose]')) { state.spDirFind = null; render(); return; }
    const tab = e.target.closest('[data-spd-tab]');
    if (tab) { state.spDir.tab = tab.getAttribute('data-spd-tab'); render(); return; }
    const op = e.target.closest('[data-spd-open]');
    if (op && !e.target.closest('a, button, input, label, select')) { state.spDirOpen = op.getAttribute('data-spd-open'); render(); return; }
    if (e.target.closest('[data-spd-find]')) { state.spDirFind = { q: '', results: null }; render(); return; }
    if (e.target.closest('[data-spd-importmenu]')) { state.spDirImportMenu = !state.spDirImportMenu; render(); return; }
    const imp = e.target.closest('[data-spd-import]');
    if (imp) {
      state.spDirImportMenu = false;
      const what = imp.getAttribute('data-spd-import');
      const have = new Set((state.sponsorBiz || []).map((b) => key(b.business)));
      let list = [];
      imp.disabled = true; imp.textContent = 'Fetching…';
      try {
        if (what === 'leads') {
          list = (state.leads || []).filter((l) => l.title).map((l) => ({ business: String(l.title).slice(0, 120), industry: String(l.category || '').slice(0, 60), contactName: l.contactName || '', phone: l.phone || '', email: l.email || '', website: l.website || '', facebook: /facebook\.com/i.test(l.socials || '') ? String(l.socials).match(/https?:\/\/[^\s,]*facebook\.com[^\s,]*/i)[0] : '', instagram: /instagram\.com/i.test(l.socials || '') ? String(l.socials).match(/https?:\/\/[^\s,]*instagram\.com[^\s,]*/i)[0] : '', address: l.address || l.suburb || '', notes: l.notes || '', local: 'bowen', source: 'lead', leadId: l.id }));
        } else {
          const r = await call('importMapBusinesses', { region: what });
          list = ((r && r.data && r.data.results) || []).map((b) => ({ ...b, kind: undefined, source: 'osm' }));
          list.forEach((b) => { delete b.kind; });
        }
      } catch (err) { window.alert(err.message || 'Import failed.'); render(); return; }
      const fresh = list.filter((b) => b.business && !have.has(key(b.business)));
      if (!fresh.length) { window.alert('Nothing new - they are all in the directory already.'); render(); return; }
      if (!window.confirm('Add ' + fresh.length + ' business' + (fresh.length === 1 ? '' : 'es') + ' to the directory? (' + (list.length - fresh.length) + ' already in.)')) { render(); return; }
      await biz.addMany(fresh);
      window.alert('Added ' + fresh.length + '. Open any of them and press "Fill from website" for logo, blurb and socials.');
      return;
    }
    if (e.target.closest('[data-spd-new]')) {
      const name = window.prompt('Business name');
      if (!name || !name.trim()) return;
      const id = await biz.add({ business: name.trim().slice(0, 120), source: 'manual' });
      state.spDirOpen = id; render();
      return;
    }
    if (e.target.closest('[data-spd-tag]')) {
      const all = (state.sponsorBiz || []).filter((b) => b.stage === 'sponsor' || history(b, state.sponsorsAll || [], {}).backed);
      const tags = [...new Set(all.map((b) => handle(b.instagram) || handle(b.facebook)).filter(Boolean))];
      try { await navigator.clipboard.writeText(tags.join(' ')); window.alert('Copied ' + tags.length + ' handle' + (tags.length === 1 ? '' : 's') + ':\n' + tags.join(' ')); }
      catch (err) { window.prompt('Copy these:', tags.join(' ')); }
      return;
    }
    if (e.target.closest('[data-spd-findadd]')) {
      const fd = state.spDirFind; if (!fd || !fd.results) return;
      const picks = [...root.querySelectorAll('[data-spd-findpick]:checked')].map((x) => fd.results[+x.getAttribute('data-spd-findpick')]).filter(Boolean);
      if (!picks.length) { window.alert('Tick at least one.'); return; }
      const industry = String((root.querySelector('[data-spd-findind]') || {}).value || '').trim().slice(0, 60);
      fd.adding = true; render();
      for (const r of picks) {
        const rec = { business: r.business, industry, website: r.website || '', phone: r.phone || '', email: r.email || '', address: r.address || '', facebook: r.facebook || '', instagram: r.instagram || '', local: 'bowen', source: 'osm', stage: 'idea' };
        if (r.website) { try { Object.assign(rec, await lookup(rec)); } catch (err) { /* no website info - fine */ } }
        await biz.add(rec);
      }
      state.spDirFind = null; render();
      return;
    }
    const b = current();
    if (!b) return;
    const st = e.target.closest('[data-spd-stage]');
    if (st) { const patch = { stage: st.getAttribute('data-spd-stage') }; if (patch.stage === 'asked' && !b.lastAskedAt) patch.lastAskedAt = today(); await biz.update(b.id, patch); return; }
    const star = e.target.closest('[data-spd-stars] button');
    if (star) { await biz.update(b.id, { stars: +star.getAttribute('data-n') }); return; }
    if (e.target.closest('[data-spd-unstar]')) { await biz.update(b.id, { stars: 0 }); return; }
    if (e.target.closest('[data-spd-lookup]')) {
      const btn = e.target.closest('[data-spd-lookup]'); btn.disabled = true; btn.textContent = 'Reading…';
      try { const patch = await lookup(b); if (!Object.keys(patch).length) { window.alert('Nothing new found on their site.'); btn.disabled = false; btn.textContent = 'Fill from website'; } else await biz.update(b.id, patch); }
      catch (err) { window.alert(err.message || 'Could not read their website.'); btn.disabled = false; btn.textContent = 'Fill from website'; }
      return;
    }
    if (e.target.closest('[data-spd-del]')) {
      if (!window.confirm('Remove ' + b.business + ' from the directory? Their event records stay.')) return;
      state.spDirOpen = null;
      await biz.remove(b.id);
    }
  });

  root.addEventListener('submit', async (e) => {
    if (!e.target.matches('[data-spd-findform]')) return;
    e.preventDefault();
    const fd = state.spDirFind; if (!fd) return;
    fd.q = String((root.querySelector('[data-spd-findq]') || {}).value || '').trim();
    if (fd.q.length < 2) return;
    fd.busy = true; fd.error = ''; render();
    try { const r = await call('findBusinesses', { query: fd.q }); fd.results = (r && r.data && r.data.results) || []; }
    catch (err) { fd.error = err.message || 'Search failed.'; fd.results = null; }
    fd.busy = false; render();
  });

  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('[data-spd-f="q"]')) { state.spDir.q = t.value; const pos = t.selectionStart; render(); const again = root.querySelector('[data-spd-f="q"]'); if (again) { again.focus(); again.setSelectionRange(pos, pos); } }
  });

  root.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.matches('[data-spd-f]') && t.getAttribute('data-spd-f') !== 'q') { state.spDir[t.getAttribute('data-spd-f')] = t.value; render(); return; }
    const b = current();
    if (!b) return;
    if (t.matches('[data-spd-field]')) {
      const field = t.getAttribute('data-spd-field');
      let value = String(t.value || '').trim().slice(0, field === 'notes' ? 3000 : field === 'blurb' ? 300 : 200);
      if (field === 'color' && !/^#[0-9a-f]{6}$/i.test(value)) value = '';
      if (['website', 'facebook', 'instagram'].includes(field) && value && !/^https?:\/\//i.test(value)) value = 'https://' + value;
      if (field === 'business' && !value) return;
      await biz.update(b.id, { [field]: value });
      return;
    }
    if (t.matches('[data-spd-money]')) { await biz.update(b.id, { [t.getAttribute('data-spd-money')]: toCents(t.value) }); return; }
    if (t.matches('[data-spd-bool]')) { await biz.update(b.id, { [t.getAttribute('data-spd-bool')]: !!t.checked }); return; }
    if (t.matches('[data-spd-addto]') && t.value) {
      await sponsors.add({ business: b.business, bizId: b.id, contactName: b.contactName || '', email: b.email || '', phone: b.phone || '', website: b.website || '', logo: b.logo || '', color: b.color || '', source: 'directory', eventId: t.value });
      window.alert(b.business + ' is now on that event\'s Sponsors tab - send the ask from there.');
      return;
    }
    if (t.matches('[data-spd-logo]')) {
      const file = t.files && t.files[0];
      if (!file || !upload) return;
      try { const url = await upload(file, 'sponsor-logos/' + b.id + '/'); await biz.update(b.id, { logo: url }); }
      catch (err) { window.alert('Upload failed - ' + (err.message || 'try again')); }
    }
  });
}
