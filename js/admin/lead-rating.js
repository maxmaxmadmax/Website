/* SOUNDZGOOD ADMIN - lead-rating.js
   Gig Match: rating and sorting leads (Pass / Save / Chase).
   A plain script: every admin file shares one page scope, loaded in order by admin.html. */
'use strict';

/* =========================================================================
   LEAD RATING — a phone-sized card deck for rating every lead quickly.
   Only Max's own Fit rating (1-5) counts here; imported heat / win % are
   not shown. Rate, then an action:
     Won        -> stage Won
     More info  -> queued for the nightly research (needsResearch), leaves
                   the deck until the research is done
     Locked     -> tagged "Locked - another supplier" (verdict)
     Pass       -> tagged "Not for us" (verdict)
     Next       -> saves the rating if one is picked, else skips for now
   Nothing is ever hidden or deleted: Pass / Locked are tags only.
   ========================================================================= */
const LEAD_VERDICT = { pass: 'Not for us', locked: 'Locked — another supplier', nextyear: 'Target next year' };

function rateState() {
    if (!state.rate) state.rate = { tab: 'review', pick: 0, skip: [], back: [], focus: '', busy: false };
    return state.rate;
}
/*  Deck order: dominate our area first.
    Distance band first - home turf (<=80 km), regional (80-300), far (300+), unknown -
    then soonest date within each band (an event that has already happened sits
    at its next edition; no date goes to the end of its band).           */
function rateBand(r) {
    const km = leadKm(r);
    if (km == null) return 3;
    if (km <= 80) return 0;
    return km <= 300 ? 1 : 2;
}
function rateSortKey(r) {
    let d = leadSortDate(r);
    if (d) {
        const today = todayIso();
        while (d < today) d = Number(d.slice(0, 4)) + 1 + d.slice(4);
    }
    return rateBand(r) + (d ? '0' + d : '9');
}

function rateDeck() {
    const s = rateState();
    // a lead Max just left a note on stays on screen until he picks an action
    const list = (state.leads || [])
        .filter((r) => !r2Decided(r) || r.id === s.stay)
        .sort((a, b) => rateSortKey(a).localeCompare(rateSortKey(b)) || String(a.title || '').localeCompare(String(b.title || '')));
    // "Next" without a rating sends a lead to the back for this session
    const skipped = list.filter((r) => s.skip.includes(r.id));
    return list.filter((r) => !s.skip.includes(r.id)).concat(skipped);
}

/*  "Ask Scout now": Scout (a routine on Max's computer) checks every 15 min
    from 6am-10pm and only works when this has been pressed.            */
function scoutBarHtml() {
    // no button - an Ask Scout note is sent with the rating + action. This is
    // just a quiet status line while Scout has something on, or just finished.
    const st = state.scoutState || {};
    const req = Number(st.requestedAt || 0);
    const started = Number(st.startedAt || 0);
    const done = Number(st.doneAt || 0);
    const ago = (ms) => {
        const m = Math.round((Date.now() - ms) / 60000);
        if (m < 1) return 'just now';
        return m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
    };
    let status = '';
    if (req > started) status = '🔭 Scout has your asks — he checks at 7am and 2pm';
    else if (started > done) status = '🔭 Scout is working on your asks…';
    else if (done && Date.now() - done < 6 * 3600000) status = '🔭 Scout ' + ago(done) + (st.lastSummary ? ': ' + st.lastSummary : '');
    return status ? `<p class="rt-scout-line">${esc(status)}</p>` : '';
}

async function rateSave(r, patchData, logText) {
    const s = rateState();
    s.busy = true;
    try {
        const e = { at: Date.now(), text: logText };
        const { doc, setDoc, arrayUnion } = fb.f;
        const data = { ...patchData, updatedAt: Date.now(), history: arrayUnion(e) };
        await setDoc(doc(fb.db, 'leads', r.id), data, { merge: true });
        Object.assign(r, patchData);
        r.history = [...(r.history || []), e];
    } catch (err) {
        console.error('rate save', err);
        const h = document.getElementById('rt-hint');
        if (h) {
            h.textContent = 'Could not save — check your connection.';
            h.classList.add('is-bad');
        }
        s.busy = false;
        return false;
    }
    s.busy = false;
    return true;
}

const RATE_ACT_LABEL = {
    won: 'Won',
    info: 'To Phil',
    nextyear: 'Target next year',
    locked: 'Locked',
    pass: 'Pass',
    next: 'Next',
    save: 'Save',
    chase: 'Chase',
    note: 'Note'
};
async function rateSendAsk(r, text, act) {
    const ctx = RATE_ACT_LABEL[act] || act;
    const tip = { at: Date.now(), text, done: false, reply: '', context: 'Max: ' + ctx };
    try {
        const e = { at: Date.now(), text: 'Asked Scout: ' + text.slice(0, 200) };
        const { doc, setDoc, arrayUnion } = fb.f;
        await setDoc(doc(fb.db, 'leads', r.id), { tips: arrayUnion(tip), updatedAt: Date.now(), history: arrayUnion(e) }, { merge: true });
        r.tips = [...(r.tips || []), tip];
        r.history = [...(r.history || []), e];
        // off he goes - Scout's 15-minute check sees this and starts
        await setDoc(doc(fb.db, 'scout', 'state'), { requestedAt: Date.now() }, { merge: true });
    } catch (err) {
        console.error('ask scout', err);
        const h = document.getElementById('rt-hint');
        if (h) {
            h.textContent = 'Could not send to Scout — check your connection.';
            h.classList.add('is-bad');
        }
        return false;
    }
    return true;
}

/*  Browse the deck without answering: swipe the card left (next) or right
    (previous), or use the arrow keys. Nothing is saved; the rating you've
    picked and any Ask Scout text are cleared as you move on.            */
function rateBrowse(dir) {
    const s = rateState();
    const n = rateDeck().length;
    if (!n) return;
    s.pos = ((Number(s.pos) || 0) + dir + n) % n;
    s.pick = 0;
    s.tipDraft = '';
    s.edit = false;
    s.tip = false;
    s.stay = '';
    render();
    const card = document.querySelector('.rt-card');
    if (card) card.classList.add(dir > 0 ? 'is-in-right' : 'is-in-left');
}

/*  Notes for the researcher: Max jots what he knows or wants checked
    ("Luke Geiger played last year, ABMC did production, Heath was the
    contact - check the location"). Saving queues the lead for the next
    research run, which sorts the facts into the lead, does the checks and
    writes a reply back onto the note.                                   */
function leadTipsHtml(r) {
    const seen = new Set();
    const tips = (r.tips || [])
        .slice()
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .map((t) => {
            const rep = String((t && t.reply) || '').trim();
            if (rep && seen.has(rep)) return { ...t, reply: '', same: true };
            if (rep) seen.add(rep);
            return t;
        })
        .slice(0, 3);
    if (!tips.length) return '';
    return `<div class="rt-tips">${tips
        .map(
            (t) => `
    <div class="rt-tip${t.done ? ' is-done' : ''}">
      <p><b>📝 You (${esc(leadRelDay(new Date(t.at || Date.now()).toISOString().slice(0, 10)).toLowerCase())}):</b> ${esc(t.text || '')}</p>
      ${t.done ? (t.same || t.together ? '<p class="rt-tip-wait">Answered together with the note above</p>' : `<p class="rt-tip-reply"><b>🔭 Scout:</b> ${esc(t.reply || 'Done.')}</p>`) : '<p class="rt-tip-wait">Waiting for Scout — he checks at 7am and 2pm</p>'}
    </div>`
        )
        .join('')}</div>`;
}

/* =========================================================================
   LEAD SORTING - Pass / Save / Chase.
     Pass  -> tagged "Not for us" (still visible everywhere)
     Save  -> maybe later - the Saved list
     Chase -> go after it - the Chasing list, and Scout starts on outreach
   After a decision an optional note (quick chips + text) goes to Scout.
   More info opens everything captured: Overview / Contacts / History / Notes.
   ========================================================================= */
const R2_ACTS = {
    pass: { label: 'Pass', ico: '✕', log: 'Pass — not for us' },
    save: { label: 'Save', ico: '☆', log: 'Saved for later' },
    chase: { label: 'Chase', ico: '✓', log: 'Chasing' }
};
const R2_CHIPS = ['Good potential', 'Contact after event', 'Look at 2027', 'Needs more info', 'Wedding / private', 'Send estimate'];
function r2Decided(r) {
    // only the new decisions count: old 1-5 ratings and Target/Locked tags get re-sorted
    return ['pass', 'save', 'chase'].includes(r.verdict) || r.stage === 'won';
}
function r2List(kind) {
    const all = state.leads || [];
    let pick = (r) => r.verdict === 'pass';
    if (kind === 'saved') pick = (r) => r.verdict === 'save';
    else if (kind === 'chasing') pick = (r) => r.verdict === 'chase' || r.stage === 'won';
    return all.filter(pick).sort((a, b) => rateSortKey(a).localeCompare(rateSortKey(b)));
}
function r2When(r) {
    if (leadHasExactDate(r)) return fmtLeadDate(r.eventDate.slice(0, 10));
    return leadWhen(r) || 'Date TBC';
}
function r2Photo(r, cls, extra) {
    const [icon, tint] = leadCatStyle(r);
    const img = r.imageBroken ? '' : leadImageUrl(r);
    return `<div class="${cls} ${tint}">${img ? `<img src="${attr(img)}" alt="" referrerpolicy="no-referrer" data-lead-img="${attr(r.id)}">` : `<span aria-hidden="true">${icon}</span>`}${extra || ''}</div>`;
}
/*  Tags over the card photo: days to the event (left) and km from Bowen (right). */
function r2PhotoTags(r) {
    let when = '';
    if (leadHasExactDate(r)) {
        const d = Math.round((new Date(r.eventDate.slice(0, 10) + 'T00:00:00') - new Date(new Date().toDateString())) / 864e5);
        if (d === 0) when = '🎉 Today!';
        else if (d === 1) when = '⏳ Tomorrow';
        else if (d > 1) when = `⏳ ${d} days to go`;
        else when = `Was ${-d} day${d === -1 ? '' : 's'} ago`;
    } else {
        const k = leadMonthKey(r);
        if (k) when = '🗓️ ' + LEAD_MON[Number(k.slice(5, 7)) - 1].replace(/^./, (c) => c.toUpperCase()) + ' ' + k.slice(0, 4);
    }
    const km = leadKm(r);
    let dist = '';
    if (km === 0) dist = '📍 Local';
    else if (km != null) dist = `🚚 ${km.toLocaleString('en-AU')} km`;
    return (
        (when ? `<span class="r2-ptag is-when">${esc(when)}</span>` : '') + (dist ? `<span class="r2-ptag is-km">${esc(dist)}</span>` : '')
    );
}
function r2Meta(r) {
    const where = r.venue || r.town || '';
    return `<p class="r2-meta"><span>📅 ${esc(r2When(r))}</span>${where ? `<span>📍 ${esc(where)}</span>` : ''}${leadKmText(r) ? `<span class="r2-km">${esc(leadKmText(r))}</span>` : ''}</p>`;
}
function r2Tip(r) {
    const p = String(r.pitch || '').trim();
    if (!p) return '';
    let warm = 'is-good';
    if (/not worth|skip|too far|too small|locked|pass/i.test(p)) warm = 'is-cool';
    else if (/2027|next year|after/i.test(p)) warm = 'is-later';
    const ico = { 'is-good': '📈', 'is-later': '🗓️', 'is-cool': '⚠️' }[warm];
    return `<div class="r2-tip ${warm}"><span aria-hidden="true">${ico}</span><p>${esc(p.length > 150 ? p.slice(0, 147) + '…' : p)}</p></div>`;
}
function r2Buttons(r, withMore) {
    return `<div class="r2-acts">
    ${Object.entries(R2_ACTS)
        .map(
            ([k, a]) =>
                `<button type="button" class="r2-act is-${k}${r.verdict === k ? ' is-on' : ''}" data-r2-act="${k}" data-r2-id="${attr(r.id)}"><i>${a.ico}</i><span>${a.label}</span></button>`
        )
        .join('')}
    ${withMore ? `<button type="button" class="r2-act is-more" data-r2-more="${attr(r.id)}"><i>···</i><span>More info</span></button>` : ''}
  </div>`;
}
function r2CardHtml(r) {
    return `
    <article class="r2-card rt-card" data-rate-id="${attr(r.id)}">
      ${r2Photo(r, 'r2-photo', r2PhotoTags(r))}
      <div class="r2-body">
        <h2 class="r2-title">${esc(r.title || r.eventName || 'Lead')}</h2>
        ${r2Meta(r)}
        ${r2Tip(r)}
      </div>
    </article>
    ${r2Buttons(r, true)}`;
}
function r2Tile(ico, big, small) {
    return `<div class="r2-tile"><span aria-hidden="true">${ico}</span><b>${esc(big || '—')}</b><small>${esc(small)}</small></div>`;
}
function r2DetailHtml(r) {
    const s = rateState();
    const tab = s.dtab || 'overview';
    const v = leadValue(r);
    const music = String(r.liveMusic || '').trim();
    let musicShort = 'See notes';
    if (!music) musicShort = '—';
    else if (/^\s*(none|no live|not found)/i.test(music)) musicShort = 'None found';
    else if (/^\s*yes/i.test(music)) musicShort = 'Yes';
    const runs = String(r.recurrence || '')
        .replace(/\s*[—–-].*$/, '')
        .trim();
    const brief = [
        ['When', [r2When(r), r.startTime].filter(Boolean).join(' · ')],
        ['Where', [r.venue || r.town, r.venueSetup, leadKmText(r)].filter(Boolean).join(' · ')],
        ['Organiser', leadOrganiser(r)],
        ['Live music', music],
        ['Supplier now', r.incumbent],
        ['Needs', r.needs],
        ['Supplier deadline', r.eoiDate ? fmtLeadDate(r.eoiDate) + (r.eoiNote ? ' — ' + r.eoiNote : '') : '']
    ].filter(([, x]) => String(x || '').trim());
    const site = leadSafeUrl(r.website);
    const src = site || leadSafeUrl(r.sourceUrl);
    const phone = String(r.phone || '').trim();
    const email = String(r.email || '').trim();
    const okEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    let sms = '<span class="r2-reachbtn is-off">💬 SMS</span>';
    if (leadIsCouncil(r)) sms = '<span class="r2-reachbtn is-off">💬 SMS (council: email)</span>';
    else if (leadIsMobile(phone)) sms = `<a class="r2-reachbtn is-sms" href="${attr(leadSmsHref(r))}">💬 SMS${r.smsDraft ? ' ✓' : ''}</a>`;
    const panes = {
        overview: `
      <div class="r2-tiles">
        ${r2Tile('👥', r.crowd, 'Expected crowd')}
        ${r2Tile('📊', v ? leadDollars(v.cents) : '', v && v.src === 'quote' ? 'Quote value' : 'Potential value')}
        ${r2Tile('🎵', musicShort, 'Live music')}
        ${r2Tile('🔁', runs, 'Runs')}
      </div>
      ${String(r.summary || '').trim() ? `<h3 class="r2-h">About</h3><p class="r2-p">${esc(r.summary)}</p>` : ''}
      ${r2Tip(r)}
      ${brief.length ? `<ul class="r2-brief">${brief.map(([k, x]) => `<li><b>${esc(k)}:</b> ${esc(x)}</li>`).join('')}</ul>` : ''}
      ${leadFreshHtml(r)}
      ${src ? `<h3 class="r2-h">Source</h3><p class="r2-p"><a href="${attr(src.href)}" target="_blank" rel="noopener noreferrer">${esc(src.hostname.replace(/^www\./, '') + (src.pathname.length > 1 ? src.pathname : ''))}</a></p>` : ''}`,
        contacts: `
      <dl class="r2-dl">
        <div><dt>Contact</dt><dd>${esc(r.contactName || '') || '<span class="lead-mc-none">Not provided</span>'}</dd></div>
        ${r.decisionMaker ? `<div><dt>Decision maker</dt><dd>${esc(r.decisionMaker)}</dd></div>` : ''}
        <div><dt>Phone</dt><dd>${phone ? `<a href="tel:${attr(phone.replace(/[^\d+]/g, ''))}">${esc(phone)}</a>` : '<span class="lead-mc-none">Not provided</span>'}</dd></div>
        <div><dt>Email</dt><dd>${okEmail ? `<a href="mailto:${attr(email)}">${esc(email)}</a>` : '<span class="lead-mc-none">Not provided</span>'}</dd></div>
        <div><dt>Website</dt><dd>${site ? `<a href="${attr(site.href)}" target="_blank" rel="noopener noreferrer">${esc(site.hostname.replace(/^www\./, ''))}</a>` : '<span class="lead-mc-none">Not provided</span>'}</dd></div>
      </dl>
      <div class="r2-links">${leadContactIconsHtml(r)}</div>
      <div class="r2-reach">
        ${sms}
        ${phone ? `<a class="r2-reachbtn is-call" href="tel:${attr(phone.replace(/[^\d+]/g, ''))}">📞 Call</a>` : '<span class="r2-reachbtn is-off">📞 Call</span>'}
        ${okEmail ? `<button type="button" class="r2-reachbtn is-email" data-r2-email="${attr(r.id)}">✉️ Email</button>` : '<span class="r2-reachbtn is-off">✉️ Email</span>'}
      </div>`,
        history: `
      ${r.lastEdition ? `<h3 class="r2-h">Last edition</h3><p class="r2-p">${esc(r.lastEdition)}</p>` : ''}
      ${music ? `<h3 class="r2-h">Live music</h3><p class="r2-p">${esc(music)}</p>` : ''}
      ${r.recurrence ? `<h3 class="r2-h">Runs</h3><p class="r2-p">${esc(r.recurrence)}</p>` : ''}
      <h3 class="r2-h">Activity</h3>
      <ul class="r2-hist">${
          (r.history || [])
              .slice()
              .sort((a, b) => (b.at || 0) - (a.at || 0))
              .slice(0, 12)
              .map(
                  (e) =>
                      `<li><small>${esc(leadRelDay(new Date(e.at || Date.now()).toISOString().slice(0, 10)))}</small> ${esc(e.text || '')}</li>`
              )
              .join('') || '<li>Nothing yet.</li>'
      }</ul>`,
        notes: `
      ${leadTipsHtml(r) || '<p class="r2-p r2-muted">No asks yet.</p>'}
      ${r.notes ? `<h3 class="r2-h">Notes</h3><p class="r2-p">${esc(String(r.notes).slice(0, 600))}</p>` : ''}
      <label class="r2-ask"><span aria-hidden="true">🔭</span><textarea rows="3" data-r2-asktext placeholder="Ask Scout — what you know or what to do">${esc(s.tipDraft || '')}</textarea></label>
      <button type="button" class="r2-send" data-r2-ask="${attr(r.id)}">Send to Scout</button>`
    };
    return `
    <div class="r2-detail" data-rate-id="${attr(r.id)}">
      <div class="r2-dtop"><button type="button" class="r2-back" data-r2-back aria-label="Back">‹</button><h2>${esc(r.title || 'Lead')}</h2></div>
      <div class="r2-dscroll">
        ${r2Photo(r, 'r2-dphoto')}
        ${r2Meta(r)}
        <nav class="r2-tabs">${[
            ['overview', 'Overview'],
            ['contacts', 'Contacts'],
            ['history', 'History'],
            ['notes', 'Notes']
        ]
            .map(([k, l]) => `<button type="button" class="${tab === k ? 'is-on' : ''}" data-r2-tab="${k}">${l}</button>`)
            .join('')}</nav>
        <div class="r2-pane">${panes[tab]}</div>
      </div>
      ${r2Buttons(r, false)}
    </div>`;
}
function r2SheetHtml() {
    const s = rateState();
    const sh = s.sheet;
    if (!sh) return '';
    const a = R2_ACTS[sh.act] || {};
    return `
    <div class="r2-sheet-bg" data-r2-skip></div>
    <div class="r2-sheet" role="dialog" aria-label="Ask Scout">
      <div class="r2-sheet-top"><b>🔭 Ask Scout <span>(optional) · ${esc(a.label || '')}</span></b><button type="button" data-r2-skip aria-label="Close">✕</button></div>
      ${sh.act === 'chase' ? '<p class="r2-sheet-info">Scout is preparing outreach for this lead. Anything you add here goes with it.</p>' : ''}
      <textarea rows="3" data-r2-note placeholder="Tell Scout what you know or what to do…">${esc(sh.text || '')}</textarea>
      <div class="r2-chips">${R2_CHIPS.map((c) => `<button type="button" class="${(sh.chips || []).includes(c) ? 'is-on' : ''}" data-r2-chip="${attr(c)}">${esc(c)}</button>`).join('')}</div>
      <button type="button" class="r2-savenext" data-r2-savenext>Send to Scout &amp; next</button>
      <button type="button" class="r2-skip" data-r2-skip>Skip</button>
    </div>`;
}
function r2Current() {
    const s = rateState();
    if (s.focus) return (state.leads || []).find((x) => x.id === s.focus) || null;
    if (s.tab && s.tab !== 'review') return null;
    const deck = rateDeck();
    return deck.length ? deck[Math.min(Math.max(0, s.pos || 0), deck.length - 1)] : null;
}
/*  Hard delete - Max only, by hand, from the Deleted list. The agents never delete. */
async function r2DeleteForever(id) {
    const r = (state.leads || []).concat(state.archivedLeads || []).find((x) => x.id === id);
    if (!r) return;
    if (!window.confirm('Delete "' + (r.title || 'this lead') + '"?\n\nThis can\'t be undone.')) return;
    try {
        const { doc, deleteDoc } = fb.f;
        await deleteDoc(doc(fb.db, 'leads', id));
        state.archivedLeads = (state.archivedLeads || []).filter((x) => x.id !== id);
        state.leads = (state.leads || []).filter((x) => x.id !== id);
        const st = rateState();
        st.menu = false;
        if (st.focus === id) st.focus = '';
        render();
    } catch (err) {
        console.error('delete forever', err);
        window.alert('Could not delete - check your connection.');
    }
}

async function r2Archive(id, on) {
    const s = rateState();
    const r = (state.leads || []).concat(state.archivedLeads || []).find((x) => x.id === id);
    if (!r) return;
    if (
        on &&
        !window.confirm(
            'Delete "' +
                (r.title || 'this lead') +
                '"?\n\nIt disappears from every list but is kept in the background, so Findo won\'t re-add it. You can restore it from the menu → Deleted.'
        )
    )
        return;
    const patch = on ? { archived: true, archivedAt: Date.now() } : { archived: false };
    if (!(await rateSave(r, patch, on ? 'Deleted (archived) by Max' : 'Restored by Max'))) return;
    s.menu = false;
    if (on && s.focus === id) s.focus = '';
    render();
}

function leadSortHtml() {
    const s = rateState();
    const deck = rateDeck();
    const focus = s.focus && (state.leads || []).find((x) => x.id === s.focus);
    const lists = { saved: r2List('saved'), chasing: r2List('chasing'), passed: r2List('passed') };
    let body;
    if (focus) body = r2DetailHtml(focus);
    else if (s.tab === 'review' || (!lists[s.tab] && s.tab !== 'deleted')) {
        if (!Number.isInteger(s.pos) || s.pos < 0) s.pos = 0;
        if (s.pos >= deck.length) s.pos = Math.max(0, deck.length - 1);
        body = deck.length
            ? r2CardHtml(deck[s.pos])
            : '<p class="rt-empty">🎉 All sorted. New leads show up here once Phil has filled them in.</p>';
    } else if (s.tab === 'deleted') {
        const rows = state.archivedLeads || [];
        body = rows.length
            ? `<ul class="rt-list">${rows.map((r) => `<li class="r2-delrow"><span><span class="rt-li-t">${esc(r.title || 'Lead')}</span><span class="rt-li-m">${esc(r2When(r))}</span></span><button type="button" data-r2-restore="${attr(r.id)}">Restore</button><button type="button" class="is-forever" data-r2-forever="${attr(r.id)}">Delete forever</button></li>`).join('')}</ul>`
            : '<p class="rt-empty">Nothing deleted.</p>';
    } else {
        const rows = lists[s.tab];
        body = rows.length
            ? `<ul class="rt-list">${rows.map((r) => `<li><button type="button" data-r2-open="${attr(r.id)}"><span class="rt-li-t">${esc(r.title || 'Lead')}</span><span class="rt-li-m">${esc(r2When(r))}${leadKmText(r) ? ' · ' + esc(leadKmText(r)) : ''}</span></button></li>`).join('')}</ul>`
            : '<p class="rt-empty">Nothing here yet.</p>';
    }
    const titles = { review: 'Gig Match', saved: 'Saved', chasing: 'Chasing', passed: 'Passed', deleted: 'Deleted' };
    return `
    <div class="rt-wrap">
      <div class="rt-phone r2">
        <div class="rt-top">
          <a class="rt-exit" href="#/leads" aria-label="Close">✕</a>
          <h1 class="r2-h1">${esc(titles[s.tab] || 'Gig Match')}</h1>
          <span class="rt-top-fill"></span>
          ${!focus && (s.tab === 'review' || !lists[s.tab]) && deck.length ? `<span class="r2-of">${s.pos + 1} of ${deck.length}</span>` : ''}
          <button type="button" class="rt-burger${s.menu ? ' is-on' : ''}" data-rate-menu aria-label="Menu">☰</button>
        </div>
        ${
            s.menu
                ? `<div class="rt-menu">
          <nav class="rt-tabs">${[
              ['review', 'To sort', deck.length],
              ['chasing', 'Chasing', lists.chasing.length],
              ['saved', 'Saved', lists.saved.length],
              ['passed', 'Passed', lists.passed.length]
          ]
              .map(
                  ([k, l, n]) =>
                      `<button type="button" class="rt-tab${s.tab === k ? ' is-on' : ''}" data-r2-list="${k}">${l} <span>${n}</span></button>`
              )
              .join('')}</nav>
          ${scoutBarHtml() || '<p class="rt-scout-line">🔭 Scout: nothing on right now</p>'}
          ${state.withPhil ? `<p class="rt-scout-line">🔍 Phil is checking ${state.withPhil} new find${state.withPhil === 1 ? '' : 's'} (Findo / Tell)</p>` : ''}
          ${r2Current() ? `<button type="button" class="r2-del" data-r2-delete="${attr(r2Current().id)}">🗑 Delete this lead</button>` : ''}
          ${(state.archivedLeads || []).length ? `<button type="button" class="r2-dellist" data-r2-list="deleted">Deleted (${state.archivedLeads.length})</button>` : ''}
        </div>`
                : ''
        }
        <div class="rt-main">${body}</div>
        ${r2SheetHtml()}
      </div>
    </div>`;
}

async function r2Decide(id, act) {
    const s = rateState();
    const r = (state.leads || []).find((x) => x.id === id);
    if (!r || s.busy || !R2_ACTS[act]) return;
    if (r.verdict !== act) {
        const patch = { verdict: act };
        if (act === 'chase') patch.target = true;
        if (!(await rateSave(r, patch, 'Lead sorting: ' + R2_ACTS[act].log))) return;
    }
    s.menu = false;
    s.sheet = { id, act, chips: [], text: '' };
    render();
}
async function r2Finish(withNote) {
    const s = rateState();
    const sh = s.sheet;
    if (!sh) return;
    const r = (state.leads || []).find((x) => x.id === sh.id);
    const note = withNote ? [...(sh.chips || []), String(sh.text || '').trim()].filter(Boolean).join('. ') : '';
    // Chase = Scout prepares outreach; any note rides along with it
    const ask =
        sh.act === 'chase'
            ? ['Chase: prepare outreach for this lead (check the details, then a checked intro SMS, or an email if council).', note]
                  .filter(Boolean)
                  .join(' Max adds: ')
            : note;
    if (r && ask && !(await rateSendAsk(r, ask, sh.act))) return;
    s.sheet = null;
    s.tipDraft = '';
    if (s.focus === sh.id) s.focus = '';
    render();
}

function wireLeadSort() {
    const root = document.querySelector('.rt-phone');
    if (!root) return;
    wireLeadImageErrors();
    const s = rateState();
    root.addEventListener('input', (e) => {
        if (e.target.matches('[data-r2-note]') && s.sheet) s.sheet.text = e.target.value;
        if (e.target.matches('[data-r2-asktext]')) s.tipDraft = e.target.value;
    });
    root.addEventListener('click', async (e) => {
        const t = e.target.closest(
            '[data-r2-forever], [data-r2-delete], [data-r2-restore], [data-rate-menu], [data-r2-list], [data-r2-act], [data-r2-more], [data-r2-open], [data-r2-back], [data-r2-tab], [data-r2-chip], [data-r2-savenext], [data-r2-skip], [data-r2-ask], [data-r2-email]'
        );
        if (!t) return;
        // "Delete this lead" archives it; only "Delete forever" in the Deleted list removes it
        if (t.hasAttribute('data-r2-delete')) {
            r2Archive(t.getAttribute('data-r2-delete'), true);
            return;
        }
        if (t.hasAttribute('data-r2-forever')) {
            r2DeleteForever(t.getAttribute('data-r2-forever'));
            return;
        }
        if (t.hasAttribute('data-r2-restore')) {
            r2Archive(t.getAttribute('data-r2-restore'), false);
            return;
        }
        if (t.hasAttribute('data-rate-menu')) {
            s.menu = !s.menu;
            render();
            return;
        }
        if (t.hasAttribute('data-r2-list')) {
            s.tab = t.getAttribute('data-r2-list');
            s.menu = false;
            s.focus = '';
            render();
            return;
        }
        if (t.hasAttribute('data-r2-act')) {
            r2Decide(t.getAttribute('data-r2-id'), t.getAttribute('data-r2-act'));
            return;
        }
        if (t.hasAttribute('data-r2-more') || t.hasAttribute('data-r2-open')) {
            s.focus = t.getAttribute('data-r2-more') || t.getAttribute('data-r2-open');
            s.dtab = 'overview';
            s.tipDraft = '';
            render();
            return;
        }
        if (t.hasAttribute('data-r2-back')) {
            s.focus = '';
            render();
            return;
        }
        if (t.hasAttribute('data-r2-tab')) {
            s.dtab = t.getAttribute('data-r2-tab');
            render();
            return;
        }
        if (t.hasAttribute('data-r2-chip') && s.sheet) {
            const c = t.getAttribute('data-r2-chip');
            s.sheet.chips = (s.sheet.chips || []).includes(c) ? s.sheet.chips.filter((x) => x !== c) : [...(s.sheet.chips || []), c];
            t.classList.toggle('is-on');
            return;
        }
        if (t.hasAttribute('data-r2-savenext')) {
            r2Finish(true);
            return;
        }
        if (t.hasAttribute('data-r2-skip')) {
            r2Finish(false);
            return;
        }
        if (t.hasAttribute('data-r2-ask')) {
            const r = (state.leads || []).find((x) => x.id === t.getAttribute('data-r2-ask'));
            const text = String(s.tipDraft || '').trim();
            if (!r || !text) return;
            t.disabled = true;
            if (await rateSendAsk(r, text, 'note')) {
                s.tipDraft = '';
                render();
            } else t.disabled = false;
            return;
        }
        if (t.hasAttribute('data-r2-email')) {
            const id = t.getAttribute('data-r2-email');
            if (openLead(id, 'overview')) {
                location.hash = '#/leads';
                setTimeout(() => openLeadCompose(), 50);
            }
        }
    });
    // swipe the card to browse (nothing is saved)
    const card = root.querySelector('.r2-card');
    if (card && !s.focus && !s.sheet) {
        let x0 = 0,
            y0 = 0,
            t0 = 0,
            on = false,
            horiz = null;
        const start = (x, y, target) => {
            if (target.closest('a, button, textarea')) {
                on = false;
                return;
            }
            on = true;
            horiz = null;
            x0 = x;
            y0 = y;
            t0 = Date.now();
        };
        const move = (x, y) => {
            if (!on) return;
            const dx = x - x0,
                dy = y - y0;
            if (horiz === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) horiz = Math.abs(dx) > Math.abs(dy);
            if (horiz) card.style.transform = `translateX(${dx}px) rotate(${dx * 0.03}deg)`;
        };
        const finish = (x, y) => {
            if (!on) return;
            on = false;
            card.style.transform = '';
            const dx = x - x0,
                dy = y - y0;
            const fast = Math.abs(dx) / Math.max(1, Date.now() - t0) > 0.45;
            if (horiz && (Math.abs(dx) > 45 || (fast && Math.abs(dx) > 20)) && Math.abs(dx) > Math.abs(dy)) rateBrowse(dx < 0 ? 1 : -1);
        };
        card.addEventListener('touchstart', (e) => start(e.touches[0].clientX, e.touches[0].clientY, e.target), { passive: true });
        card.addEventListener('touchmove', (e) => move(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
        card.addEventListener('touchend', (e) => finish(e.changedTouches[0].clientX, e.changedTouches[0].clientY));
        card.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button === 0) start(e.clientX, e.clientY, e.target);
        });
        card.addEventListener('pointermove', (e) => {
            if (e.pointerType === 'mouse') move(e.clientX, e.clientY);
        });
        card.addEventListener('pointerup', (e) => {
            if (e.pointerType === 'mouse') finish(e.clientX, e.clientY);
        });
        card.addEventListener('dragstart', (e) => e.preventDefault());
    }
}
let r2KbWired = false;
function wireLeadSortKeyboard() {
    if (r2KbWired || !window.visualViewport) return;
    r2KbWired = true;
    const vv = window.visualViewport;
    const fit = () => {
        const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        document.documentElement.style.setProperty('--r2-kb', kb + 'px');
        const sheet = document.querySelector('.r2-sheet');
        if (sheet && kb > 0) {
            const ta = sheet.querySelector('textarea:focus');
            if (ta) ta.scrollIntoView({ block: 'nearest' });
        }
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    fit();
}

let r2KeysWired = false;
function wireLeadSortKeys() {
    if (r2KeysWired) return;
    r2KeysWired = true;
    document.addEventListener('keydown', (e) => {
        if (state.view !== 'leadRate' || e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.target && e.target.closest && e.target.closest('input, select, textarea')) return;
        const s = rateState();
        if (s.sheet || s.focus) return;
        const k = e.key.toLowerCase();
        if (k === 'arrowright' || k === 'arrowleft') {
            rateBrowse(k === 'arrowright' ? 1 : -1);
            return;
        }
        const card = document.querySelector('.r2-card');
        const act = { p: 'pass', s: 'save', c: 'chase' }[k];
        if (act && card) r2Decide(card.getAttribute('data-rate-id'), act);
    });
}

VIEWS.leadRate = {
    html() {
        return leadSortHtml();
    },
    wire() {
        wireLeadSortKeys();
        wireLeadSortKeyboard();
        wireLeadSort();
    }
};
