/* SOUNDZGOOD ADMIN - leads.js
   Leads: the gig lead generator.
   A plain script: every admin file shares one page scope, loaded in order by admin.html. */
'use strict';

/* =========================================================================
   LEADS — the gig lead generator, built into the admin panel.

   A lead is a prospect for work: production hire, a DJ/performance booking,
   or a venue/regular slot. They arrive from four places (auto-found events,
   manual add, website enquiries, a venue directory), you rate each one
   yourself with 1-5 stars, move it along a pipeline (New -> Contacted ->
   Quoted -> Negotiating -> Won/Lost), link a quote once you build one, and
   email them straight from here (draft + send, never auto-send). Styled to
   match Inventory and Crew & Vehicles.
   ========================================================================= */

const LEAD_TYPES = { production: 'Production hire', dj: 'DJ / Performance', venue: 'Venue / regular' };
const LEAD_SOURCES = { manual: 'Manual', auto: 'Auto-found', website: 'Website', directory: 'Directory' };
const LEAD_STAGE_ORDER = ['new', 'researching', 'contacted', 'quoted', 'negotiating', 'won', 'lost'];
const LEAD_STAGES = {
    new: 'New',
    researching: 'Researching',
    contacted: 'Contacted',
    quoted: 'Quote Sent',
    negotiating: 'In Discussion',
    won: 'Won',
    lost: 'Lost'
};

/*  Heat rating carried over from the research import (Grok's Hot/Warm/...).
    Kept apart from Max's own 5-star rating, which is his call alone.
    Existing = a job SoundzGood already has/won; Locked = someone else is on
    it. Both are flags only - nothing is blocked.                          */
const GROK_ORDER = ['Hot', 'Existing', 'Warm', 'Cool', 'Locked', 'Skip'];
const GROK_PILL = {
    Hot: 'ad-pill-red',
    Existing: 'ad-pill-green',
    Warm: 'ad-pill-amber',
    Cool: 'ad-pill-blue',
    Locked: 'ad-pill-grey',
    Skip: 'ad-pill-grey'
};

function blankLead(type) {
    return {
        type: LEAD_TYPES[type] ? type : 'production',
        title: '',
        contactName: '',
        phone: '',
        email: '',
        website: '',
        socials: '',
        eventName: '',
        eventDate: '',
        dateText: '',
        venue: '',
        town: '',
        crowd: '',
        source: 'manual',
        sourceUrl: '',
        ticketUrl: '',
        budget: '',
        needs: '',
        rating: 0,
        stage: 'new',
        category: '',
        grokRating: '',
        winPct: '',
        nextAction: '',
        incumbent: '',
        haul: '',
        whyFit: '',
        decisionMaker: '',
        linkedQuoteId: '',
        linkedQuoteNumber: '',
        lastContacted: '',
        notes: '',
        importBatch: '',
        estValueCents: 0,
        followUp: '',
        target: false,
        contacts: [],
        files: [],
        history: [],
        km: '',
        organiser: '',
        startTime: '',
        imageUrl: '',
        imageBroken: false,
        eoiDate: '',
        eoiNote: '',
        recurrence: '',
        lastEdition: '',
        venueSetup: '',
        power: ''
    };
}

/*  No phone and no email = can't be worked yet. Worked out live, so it
    clears itself the moment a contact detail is added.                    */
function leadNeedsContact(r) {
    return !String(r.email || '').trim() && !String(r.phone || '').trim();
}

/*  Which month a lead sits in, as 'YYYY-MM' - from the exact date when
    there is one, else read out of the date as the research listed it
    ("Oct 2026", "~Jun/Jul 2027", "May annual"). A month with no year is
    taken as its next occurrence. '' when there is no month at all
    ("TBC 2027", "Recurring / seasonal").                                  */
const LEAD_MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function leadMonthKey(r) {
    if (r.eventDate && /^\d{4}-\d{2}/.test(r.eventDate)) return r.eventDate.slice(0, 7);
    const s = String(r.dateText || '');
    const m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i);
    if (!m) return '';
    const mon = LEAD_MON.indexOf(m[1].toLowerCase()) + 1;
    const y = s.match(/\b(20\d\d)\b/);
    let year = y ? Number(y[1]) : 0;
    if (!year) {
        const now = new Date();
        year = now.getFullYear() + (mon < now.getMonth() + 1 ? 1 : 0);
    }
    return year + '-' + String(mon).padStart(2, '0');
}

/*  Real week-of-year numbers (ISO: weeks start Monday, week 1 is the one
    holding the year's first Thursday - 52 or 53 a year). A week belongs
    to the month its Thursday is in, so a week that straddles two months
    sits under the one with most of its days, and every week shows once.  */
function isoWeekInfo(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dow = d.getUTCDay() || 7; // Mon=1 .. Sun=7
    const thu = new Date(d);
    thu.setUTCDate(d.getUTCDate() + 4 - dow);
    const mon = new Date(d);
    mon.setUTCDate(d.getUTCDate() + 1 - dow);
    const yearStart = Date.UTC(thu.getUTCFullYear(), 0, 1);
    const week = Math.ceil(((thu - yearStart) / 86400000 + 1) / 7);
    return {
        key: thu.getUTCFullYear() + '-W' + String(week).padStart(2, '0'),
        week,
        monthKey: thu.getUTCFullYear() + '-' + String(thu.getUTCMonth() + 1).padStart(2, '0'),
        monday: new Date(mon.getUTCFullYear(), mon.getUTCMonth(), mon.getUTCDate())
    };
}

/*  The week a lead falls in ('2026-W39'), exact dates only - a lead that
    only knows its month has no week and stays off the week rows.        */
function leadWeekKey(r) {
    if (!r.eventDate || !/^\d{4}-\d{2}-\d{2}/.test(r.eventDate)) return '';
    const [y, m, d] = r.eventDate.slice(0, 10).split('-').map(Number);
    return isoWeekInfo(new Date(y, m - 1, d)).key;
}

/*  "21–27 Sep 2026" for the week starting on the given Monday. */
function weekRangeLabel(monday) {
    const sun = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    const mon3 = (dt) => LEAD_MON[dt.getMonth()].charAt(0).toUpperCase() + LEAD_MON[dt.getMonth()].slice(1);
    return monday.getMonth() === sun.getMonth()
        ? `${monday.getDate()}–${sun.getDate()} ${mon3(sun)} ${sun.getFullYear()}`
        : `${monday.getDate()} ${mon3(monday)} – ${sun.getDate()} ${mon3(sun)} ${sun.getFullYear()}`;
}

/*  High / medium / low for the calendar dots. Max's own stars win once he
    has rated a lead; until then the research heat stands in.             */
function leadPriority(r) {
    const n = Math.round(r.rating || 0);
    if (n >= 4) return 'high';
    if (n === 3) return 'medium';
    if (n >= 1) return 'low';
    if (r.grokRating === 'Hot' || r.grokRating === 'Existing') return 'high';
    if (r.grokRating === 'Warm') return 'medium';
    return 'low';
}

let leadDraft = blankLead();

/*  The rating deck redraws on outside changes, but not mid-save or while a tip is typed. */
function rateDeckCanRedraw() {
    if (state.view !== 'leadRate') return false;
    if (state.rate && (state.rate.busy || state.rate.edit || state.rate.tip || state.rate.sheet)) return false;
    const a = document.activeElement;
    return !(a && a.matches && a.matches('[data-rate-tip-text]'));
}

function subscribeToScout() {
    const { doc, onSnapshot } = fb.f;
    unsubscribes.push(
        onSnapshot(
            doc(fb.db, 'scout', 'state'),
            (d) => {
                state.scoutState = d.exists() ? d.data() : {};
                if (rateDeckCanRedraw()) render();
            },
            (err) => console.error('scout', err)
        )
    );
}

function subscribeToLeads() {
    const { collection, onSnapshot } = fb.f;
    unsubscribes.push(
        onSnapshot(
            collection(fb.db, 'leads'),
            (snap) => {
                let rows = snapRows(snap);
                // Findo's new finds stay with Phil until he's checked and filled them in
                const withPhil = (r) => (r.foundBy === 'Findo' || r.foundBy === 'Tell') && !r.enrichedAt;
                state.withPhil = rows.filter(withPhil).length;
                // "Delete" only archives: kept so Findo won't re-add them, restorable from the menu
                state.archivedLeads = rows.filter((r) => r.archived);
                rows = rows.filter((r) => !withPhil(r) && !r.archived);
                /*  Open leads first (by pipeline order), then Max's stars, then the
          imported heat (Hot first) and win %, then name. Won/Lost fall to
          the bottom - they are done with.                                 */
                const grokRank = (r) => {
                    const i = GROK_ORDER.indexOf(r.grokRating);
                    return i < 0 ? 99 : i;
                };
                rows.sort(
                    (a, b) =>
                        LEAD_STAGE_ORDER.indexOf(a.stage || 'new') - LEAD_STAGE_ORDER.indexOf(b.stage || 'new') ||
                        (b.rating || 0) - (a.rating || 0) ||
                        grokRank(a) - grokRank(b) ||
                        (Number(b.winPct) || 0) - (Number(a.winPct) || 0) ||
                        (a.title || '').localeCompare(b.title || '', undefined, { numeric: true, sensitivity: 'base' })
                );
                state.leads = rows;
                if (state.view === 'leads') {
                    if (state.openLeadId) renderLeadListParts(true);
                    else render();
                }
                if (rateDeckCanRedraw()) render();
            },
            (err) => console.error('leads', err)
        )
    );
}

VIEWS.leads = {
    html() {
        const open = state.openLeadId != null;
        return `<div class="inv-wrap${open ? ' has-detail' : ''}">
      ${leadMainHtml()}
      ${open ? leadDetailHtml() : ''}
      ${state.leadCompose ? leadComposeHtml() : ''}
    </div>`;
    },
    wire() {
        wireLeadImageErrors();
        wireLeadList();
        if (state.openLeadId != null) wireLeadDetail();
        if (state.leadCompose) wireLeadCompose();
    }
};

/*  The categories actually in use, for the filter - so it grows with the
    data instead of being a hard-coded list.                              */
function leadCategories() {
    const set = new Set();
    (state.leads || []).forEach((r) => {
        if (r.category) set.add(r.category);
    });
    return [...set].sort((a, b) => a.localeCompare(b));
}

function leadFiltered(ignoreMonth) {
    const rows = state.leads || [];
    const f = state.leadFilter || 'all';
    const tf = state.leadTypeFilter || 'all';
    const cf = state.leadCatFilter || 'all';
    const gf = state.leadGrokFilter || 'all';
    const kf = state.leadContactFilter || 'all';
    const rf = state.leadRegionFilter || 'all';
    const sf = state.leadSizeFilter || 'all';
    const chip = state.leadChip || 'all';
    const needle = (state.leadSearch || '').trim().toLowerCase();
    return rows.filter((r) => {
        if (f !== 'all' && (r.stage || 'new') !== f) return false;
        if (tf !== 'all' && (r.type || 'production') !== tf) return false;
        if (cf !== 'all' && (r.category || '') !== cf) return false;
        if (gf !== 'all' && (r.grokRating || '') !== gf) return false;
        if (kf === 'needs' && !leadNeedsContact(r)) return false;
        if (kf === 'email' && !String(r.email || '').trim()) return false;
        if (kf === 'phone' && !String(r.phone || '').trim()) return false;
        if (rf !== 'all' && leadRegion(r) !== rf) return false;
        if (sf !== 'all' && leadSize(r) !== sf) return false;
        if (!leadChipMatch(r, chip)) return false;
        if ((state.leadRange || 'all') !== 'all' && !leadInRange(r, state.leadRange)) return false;
        if (!ignoreMonth && state.leadMonth && leadMonthKey(r) !== state.leadMonth) return false;
        if (!ignoreMonth && state.leadWeek && leadWeekKey(r) !== state.leadWeek) return false;
        if (!needle) return true;
        return [
            r.title,
            r.organiser,
            r.contactName,
            r.decisionMaker,
            r.eventName,
            r.town,
            r.venue,
            r.email,
            r.phone,
            r.category,
            r.nextAction,
            r.incumbent,
            ...(r.contacts || []).map((c) => c.name + ' ' + c.email)
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(needle);
    });
}

/*  The quick-filter chips (and the KPI tiles, which share them). */
function leadChipMatch(r, chip) {
    const st = r.stage || 'new';
    switch (chip) {
        case 'all':
            return true;
        case 'targets':
            return !!r.target;
        case 'hot':
        case 'high':
            return !!Number(r.rating) && leadPriority(r) === 'high';
        case 'medium':
        case 'low':
            return !!Number(r.rating) && leadPriority(r) === chip;
        case 'needs':
            return leadNeedsContact(r);
        case 'stale':
            return !!r.imageBroken;
        case 'followups':
            return leadFollowState(r) !== '';
        case 'quotes':
            return st === 'quoted';
        case 'inplay':
            return st === 'contacted' || st === 'quoted' || st === 'negotiating';
        default:
            return st === chip; // won / lost
    }
}

/*  Follow-ups: 'overdue' (date has passed), 'due' (within the next 7 days),
    or '' - and never for leads already won or lost. Shown on screen only;
    nothing is emailed or notified.                                        */
function leadFollowState(r) {
    const fu = String(r.followUp || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fu)) return '';
    const st = r.stage || 'new';
    if (st === 'won' || st === 'lost') return '';
    if (fu < todayIso()) return 'overdue';
    const wk = new Date();
    wk.setDate(wk.getDate() + 7);
    return fu <= isoDay(wk) ? 'due' : '';
}

/*  A published supplier deadline (EOI / tender): when it closes and how
    close that is. null when there isn't one.                           */
function leadEoi(r) {
    const d = String(r.eoiDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    const days = Math.round((new Date(d + 'T00:00:00') - new Date(todayIso() + 'T00:00:00')) / 86400000);
    let when = 'later';
    if (days < 0) when = 'closed';
    else if (days <= 30) when = 'soon';
    return { date: d, days, state: when, note: String(r.eoiNote || '').trim() };
}
const LEAD_POWER = { mains: 'Mains power on site', generator: 'Generator needed', unknown: 'Power unknown' };

/*  Region, read from the venue / town / name. North QLD focused.        */
const LEAD_REGIONS = [
    [
        'whitsundays',
        'Whitsundays & Bowen',
        /bowen|airlie|proserpine|cannonvale|whitsunday|hamilton island|hayman|daydream|collinsville|jubilee pocket|shute harbour|cape gloucester|hydeaway|dingo beach|gumlu|guthalungra|merinda|scottville|ben bolt/i
    ],
    [
        'mackay',
        'Mackay & Isaac',
        /mackay|sarina|moranbah|nebo|clermont|dysart|middlemount|glenden|eungella|finch hatton|marian|mirani|walkerston|seaforth|st lawrence|calen|farleigh|palmyra|isaac|bucasia|ooralea|harrup/i
    ],
    [
        'townsville',
        'Townsville & Burdekin',
        /townsville|\bayr\b|home hill|burdekin|giru|brandon|charters towers|ingham|cardwell|hinchinbrook|magnetic island|lucinda|ravenswood|halifax|bluewater|kirwan|the ville|brothers leagues/i
    ],
    [
        'cairns',
        'Cairns & Far North',
        /cairns|mareeba|atherton|yungaburra|port douglas|innisfail|tully|mission beach|kuranda|malanda|ravenshoe|herberton|cooktown|tablelands|gordonvale|babinda|kerribee|cazaly/i
    ],
    [
        'central',
        'Central QLD',
        /rockhampton|yeppoon|gladstone|emerald|biloela|blackwater|capricorn|moura|springsure|fitzroy|frenchville|sapphire|rubyvale/i
    ],
    [
        'outback',
        'Outback',
        /mount isa|mt isa|winton|longreach|barcaldine|richmond|hughenden|cloncurry|julia creek|isisford|blackall|charleville|boulia|birdsville|tambo|aramac|muttaburra|prairie|torrens creek|pentland|ewan|georgetown|croydon|normanton|karumba|camooweal|bedourie|windorah|quilpie|jericho|\balpha\b|ilfracombe|kynuna|mckinlay|outback/i
    ]
];
function leadRegion(r) {
    const t = [r.venue, r.town, r.title, r.eventName].filter(Boolean).join(' ');
    const hit = LEAD_REGIONS.find(([, , re]) => re.test(t));
    return hit ? hit[0] : 'other';
}

/*  Size, from the expected attendance text ("~3,000 expected").         */
const LEAD_SIZES = [
    ['small', 'Under 300'],
    ['medium', '300–2,000'],
    ['large', '2,000–10,000'],
    ['major', '10,000+'],
    ['unknown', 'Size unknown']
];
function leadCrowdNum(r) {
    const m = String(r.crowd || '')
        .replace(/,/g, '')
        .match(/(\d+(?:\.\d+)?)\s*(k\b)?/i);
    if (!m) return 0;
    return Math.round(parseFloat(m[1]) * (m[2] ? 1000 : 1));
}
function leadSize(r) {
    const n = leadCrowdNum(r);
    if (!n) return 'unknown';
    if (n < 300) return 'small';
    if (n < 2000) return 'medium';
    if (n < 10000) return 'large';
    return 'major';
}

/*  The next thing to do on a lead, worked out from where it's up to.
    Clicking it does that thing.                                          */
function leadNextAct(r) {
    const st = r.stage || 'new';
    if (st === 'won' || st === 'lost') return null;
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(r.email || '').trim());
    const phone = !!String(r.phone || '').trim();
    if (!email && !phone) return { k: 'contact', label: 'Find contact', rank: 2 };
    const reach = (label, rank) =>
        email ? { k: 'email', label, rank } : { k: 'call', label: label === 'Follow up' ? 'Call to follow up' : 'Call', rank };
    if (leadFollowState(r) === 'overdue') return { ...reach('Follow up', 0), overdue: true };
    if (st === 'researching') return { k: 'research', label: 'Research', rank: 3 };
    if (st === 'quoted') return { k: 'quote', label: r.linkedQuoteId ? 'Send quote' : 'Create quote', rank: 4 };
    if (st === 'contacted' || st === 'negotiating') return reach('Follow up', 5);
    return reach('Prepare outreach', 1);
}
function leadNextActHtml(r) {
    const a = leadNextAct(r);
    if (!a) return '<span class="ad-cell-muted">—</span>';
    const ico = { email: '✉', call: '📞', contact: '🔍', research: '🔎', quote: '▦' }[a.k] || '›';
    const cls = `lead-nact is-${a.k}${a.overdue ? ' is-overdue' : ''}`;
    const q = (s) => encodeURIComponent(s.replace(/\s+/g, ' ').trim());
    if (a.k === 'call') {
        return `<a class="${cls}" href="tel:${attr(String(r.phone).replace(/[^\d+]/g, ''))}" title="Call ${attr(r.phone)}">${ico} ${esc(a.label)}</a>`;
    }
    if (a.k === 'contact' || a.k === 'research') {
        const what =
            a.k === 'contact'
                ? `${r.contactName || r.title || ''} ${r.venue || ''} contact email phone`
                : `${r.title || r.eventName || ''} ${r.venue || ''}`;
        return `<a class="${cls}" href="https://www.google.com/search?q=${q(what)}" target="_blank" rel="noopener noreferrer" title="Search the web">${ico} ${esc(a.label)}</a>`;
    }
    return `<button type="button" class="${cls}" data-lead-nact="${a.k}" data-id="${attr(r.id)}">${ico} ${esc(a.label)}</button>`;
}

/*  Contacts: the main contact (the lead's own fields) plus any extras. */
function leadContactCount(r) {
    const main = [r.contactName, r.phone, r.email].some((v) => String(v || '').trim()) ? 1 : 0;
    return main + (Array.isArray(r.contacts) ? r.contacts.length : 0);
}

/*  A real date when there is one; otherwise the date as the research listed
    it ("TBC 2027", "Sep annual") rather than inventing a day.            */
function leadWhen(r) {
    return r.eventDate ? fmtLeadDate(r.eventDate) : r.dateText || '';
}

function grokPill(g) {
    return GROK_PILL[g] ? `<span class="ad-pill ${GROK_PILL[g]}">${esc(g)}</span>` : '';
}

function fmtLeadDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

/* ---- the month strip across the top: a dot per lead, coloured by
        priority. Click a month to filter to it, click again to clear. ---- */
const LEAD_CAL_MONTHS = 12;

/*  Financial-year week numbers, as Max works them: Week 1 is the first week
    of July (the Mon-Sun week holding July's first Thursday), counting on to
    52 or 53 at the end of June. A week belongs to the FY and the month its
    Thursday falls in, so every week appears exactly once.                */
function leadFyWeek(monday) {
    const thu = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3);
    const fyYear = thu.getMonth() >= 6 ? thu.getFullYear() : thu.getFullYear() - 1; // FY that starts July fyYear
    const jul1 = new Date(fyYear, 6, 1);
    const firstThu = new Date(fyYear, 6, 1 + ((4 - jul1.getDay() + 7) % 7));
    const week = Math.round((thu - firstThu) / (7 * 86400000)) + 1;
    const label = 'FY' + String(fyYear % 100).padStart(2, '0') + '/' + String((fyYear + 1) % 100).padStart(2, '0');
    return { week, fyYear, label };
}

const VERDICT_LANE = { chase: 'high', save: 'medium', pass: 'low' };
const LANE_WORD = { won: 'won', high: 'chase', medium: 'maybe', low: 'skip' };

function leadCalendarHtml() {
    const now = new Date();
    const nowKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const today = isoWeekInfo(now);
    const todayFy = leadFyWeek(today.monday);
    const start = new Date(now.getFullYear(), now.getMonth() + (state.leadCalOffset || 0), 1);
    const monthKeys = [];
    for (let i = 0; i < LEAD_CAL_MONTHS; i++) {
        const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
        monthKeys.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    }

    // the real weeks in view, filed under the month their Thursday is in
    const weeksByMonth = {};
    monthKeys.forEach((k) => {
        weeksByMonth[k] = [];
    });
    const endLimit = new Date(start.getFullYear(), start.getMonth() + LEAD_CAL_MONTHS, 7);
    for (let mon = isoWeekInfo(start).monday; mon < endLimit; mon = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7)) {
        const w = isoWeekInfo(mon);
        if (weeksByMonth[w.monthKey]) weeksByMonth[w.monthKey].push(w);
    }

    // leads matching every other filter: by month, and (exact dates) by week
    const byMonth = {};
    const byWeek = {};
    let undated = 0;
    const wonWeek = {}; // won jobs per week - a gold trophy sits above that week's dots
    leadFiltered(true).forEach((r) => {
        const k = leadMonthKey(r);
        if (!k) {
            undated++;
            return;
        }
        const wk = leadWeekKey(r);
        // only leads Max has sorted get a dot: Won / Chase / Maybe (saved) / Skip (passed)
        const p = r.stage === 'won' ? 'won' : VERDICT_LANE[r.verdict] || '';
        if (p) {
            (byMonth[k] = byMonth[k] || []).push(p);
            if (wk) (byWeek[wk] = byWeek[wk] || []).push(p);
        }
        if (wk && r.stage === 'won') wonWeek[wk] = (wonWeek[wk] || 0) + 1;
    });
    /*  JOBS WON: every booked job in the Sales Pipeline
      (deposit in or paid) shows on this calendar as won - a gold dot and a
      trophy on its event week. A job already counted through a won lead
      that links to it isn't counted twice.                              */
    const wonViaLead = new Set((state.leads || []).filter((l) => l.stage === 'won' && l.linkedQuoteId).map((l) => l.linkedQuoteId));
    (state.quoteDocs || []).forEach((q) => {
        if (q.vendor || wonViaLead.has(q.id) || q.status === 'cancelled' || q.status === 'declined') return;
        if (!(q.status === 'paid' || q.paymentStatus === 'deposit' || q.paymentStatus === 'paid')) return;
        const iso = q.hire && q.hire.startDate;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return;
        const r = { eventDate: iso };
        const k = leadMonthKey(r);
        const wk = leadWeekKey(r);
        if (!k) return;
        (byMonth[k] = byMonth[k] || []).push('won');
        if (wk) {
            (byWeek[wk] = byWeek[wk] || []).push('won');
            wonWeek[wk] = (wonWeek[wk] || 0) + 1;
        }
    });

    const rank = { won: -1, high: 0, medium: 1, low: 2 };
    const tally = { won: 0, high: 0, medium: 0, low: 0 };
    let dated = 0;
    let cells = '';

    monthKeys.forEach((key) => {
        const [y, m] = key.split('-').map(Number);
        const all = byMonth[key] || [];
        all.forEach((p) => {
            tally[p]++;
        });
        const monthSel = key === state.leadMonth;
        const cls = ['lead-cal-m', key === nowKey ? 'is-now' : '', monthSel ? 'is-sel' : '', all.length ? '' : 'is-empty']
            .filter(Boolean)
            .join(' ');
        const longName = new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });

        //  One slot per week, spaced across the month; up to three dots stacked
        //  in each (highest priority first), so the year reads as 52 weeks.
        const slots = weeksByMonth[key]
            .map((w) => {
                const list = (byWeek[w.key] || []).slice().sort((a, b) => rank[a] - rank[b]);
                dated += list.length;
                const fy = leadFyWeek(w.monday);
                const range = weekRangeLabel(w.monday);
                const on = state.leadWeek === w.key;
                const isToday = w.key === today.key;
                const cnt = { won: 0, high: 0, medium: 0, low: 0 };
                list.forEach((p) => {
                    cnt[p]++;
                });
                // fixed lanes - high on top, medium in the middle, low at the bottom -
                // so each colour lines up across the whole year
                const dots = list.length
                    ? ['won', 'high', 'medium', 'low']
                          .map((p) => (cnt[p] ? `<i class="lead-cdot is-${p}">${cnt[p]}</i>` : '<i class="lead-cdot is-empty"></i>'))
                          .join('')
                    : '';
                const breakdown = ['won', 'high', 'medium', 'low']
                    .filter((p) => cnt[p])
                    .map((p) => `${cnt[p]} ${LANE_WORD[p]}`)
                    .join(', ');
                return `<button type="button" class="lead-wslot${on ? ' is-sel' : ''}${isToday ? ' is-today' : ''}${list.length ? '' : ' is-empty'}"
                data-lead-week="${w.key}" aria-pressed="${on}"
                title="Week ${fy.week} (${fy.label}) · ${range}${isToday ? ' · this week' : ''}${wonWeek[w.key] ? ' · ' + wonWeek[w.key] + ' won' : ''} · ${list.length} dated lead${list.length === 1 ? '' : 's'}${breakdown ? ' (' + breakdown + ')' : ''}"><span class="lead-wslot-no">${fy.week}</span><span class="lead-wslot-dots">${wonWeek[w.key] ? '<i class="lead-ctrophy" aria-label="Won">🏆</i>' : ''}${dots || '<i class="lead-cdot is-empty"></i><i class="lead-cdot is-empty"></i><i class="lead-cdot is-empty"></i><i class="lead-cdot is-empty"></i>'}</span></button>`;
            })
            .join('');

        cells += `
      <div class="${cls}">
        <button type="button" class="lead-cal-head" data-lead-month="${key}" aria-pressed="${monthSel}"
                aria-label="${longName}: ${all.length} lead${all.length === 1 ? '' : 's'}">
          <span class="lead-cal-mon">${LEAD_MON[m - 1].toUpperCase()}</span>
          <span class="lead-cal-yr">${y}</span>
          <strong class="lead-cal-big">${all.length || '—'}</strong>
        </button>
        <div class="lead-wkrow">${slots}</div>
      </div>`;
    });

    let picked = '';
    if (state.leadWeek) {
        const [wy, wn] = state.leadWeek.split('-W').map(Number);
        const w1 = isoWeekInfo(new Date(wy, 0, 4)).monday;
        const monday = new Date(w1.getFullYear(), w1.getMonth(), w1.getDate() + (wn - 1) * 7);
        const fy = leadFyWeek(monday);
        picked = `Week ${fy.week} · ${weekRangeLabel(monday)}`;
    } else if (state.leadMonth) {
        const [y, m] = state.leadMonth.split('-').map(Number);
        picked = new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
    }

    return `
    <div class="lead-cal lead-cal-v3">
      <button type="button" class="lead-cal-arrow" data-lead-cal="-3" aria-label="Earlier months">&#8249;</button>
      <div class="lead-cal-track">${cells}</div>
      <button type="button" class="lead-cal-arrow" data-lead-cal="3" aria-label="Later months">&#8250;</button>
    </div>
    <div class="lead-cal-legend">
      <span class="lead-cal-today">Today: Week ${todayFy.week} · ${todayFy.label}</span>
      <span><i class="lead-dot is-won"></i> Won (${tally.won})</span>
      <span><i class="lead-dot is-high"></i> Chase (${tally.high})</span>
      <span><i class="lead-dot is-medium"></i> Maybe (${tally.medium})</span>
      <span><i class="lead-dot is-low"></i> Skip (${tally.low})</span>
      <span class="lead-cal-undated">Numbers = leads you've sorted that week (${dated}) · No month yet: ${undated}</span>
      ${state.leadCalOffset ? '<button type="button" class="lead-cal-link" data-lead-cal="today">Back to this month</button>' : ''}
      ${picked ? `<button type="button" class="lead-cal-clear" data-lead-clear="1">Showing ${esc(picked)} &times;</button>` : ''}
    </div>`;
}

/*  The strip and the rows both follow the filters, so any filter change
    redraws both. The strip wires itself by delegation on its host, which
    survives the redraw.                                                  */
function renderLeadListParts(keepPage) {
    if (!keepPage) {
        state.leadPage = 1;
        const wrap = document.querySelector('.lead-table-wrap');
        if (wrap) wrap.scrollTop = 0;
    }
    const cal = document.getElementById('lead-cal');
    if (cal) cal.innerHTML = leadCalendarHtml();
    renderLeadRows();
}

function wireLeadCalendar() {
    const cal = document.getElementById('lead-cal');
    if (!cal) return;
    cal.addEventListener('click', (e) => {
        const clear = e.target.closest('[data-lead-clear]');
        if (clear) {
            state.leadMonth = '';
            state.leadWeek = '';
            renderLeadListParts();
            return;
        }
        const wk = e.target.closest('[data-lead-week]');
        if (wk) {
            const key = wk.getAttribute('data-lead-week');
            state.leadWeek = state.leadWeek === key ? '' : key;
            state.leadMonth = '';
            renderLeadListParts();
            return;
        }
        const m = e.target.closest('[data-lead-month]');
        if (m) {
            const key = m.getAttribute('data-lead-month');
            state.leadMonth = state.leadMonth === key ? '' : key;
            state.leadWeek = '';
            renderLeadListParts();
            return;
        }
        const a = e.target.closest('[data-lead-cal]');
        if (a) {
            const v = a.getAttribute('data-lead-cal');
            state.leadCalOffset = v === 'today' ? 0 : (state.leadCalOffset || 0) + Number(v);
            renderLeadListParts();
        }
    });
}

/* ---- look & feel helpers for the Event Opportunities (Leads) screen ---- */

/*  A coloured tile + icon per category stands in for a photo until real
    images arrive. Unknown categories fall back to the lead's type.      */
const LEAD_CAT_STYLE = {
    'Race days': ['🏇', 'lc-race'],
    'Rodeos/campdraft': ['🤠', 'lc-rodeo'],
    'Ag shows': ['🐄', 'lc-ag'],
    'Fishing/sports': ['🎣', 'lc-fish'],
    'Tourism/chamber': ['🌴', 'lc-tour'],
    'Council/civic': ['🏛️', 'lc-civic'],
    'Formal/debutante': ['💃', 'lc-formal'],
    'Corporate/mining': ['⛏️', 'lc-corp'],
    'Sport finals': ['🏆', 'lc-sport'],
    'Festivals/concerts': ['🎤', 'lc-fest'],
    'Pubs/live music': ['🍻', 'lc-pub']
};
const LEAD_TYPE_STYLE = { production: ['🎛️', 'lc-prod'], dj: ['🎧', 'lc-dj'], venue: ['🍻', 'lc-venue'] };
function leadCatStyle(r) {
    return LEAD_CAT_STYLE[r.category] || LEAD_TYPE_STYLE[r.type] || LEAD_TYPE_STYLE.production;
}
/*  A lead's photo is a LINK to the image on their own site - nothing is
    stored. If it stops loading, they've changed their site, so the lead is
    flagged "may be out of date" and queued for the research to re-check. */
function leadImageUrl(r) {
    const u = String(r.imageUrl || '').trim();
    if (/^https:\/\//i.test(u)) return u;
    if (/^http:\/\//i.test(u)) return 'https://' + u.slice(7); // a secure page can't show http images
    return '';
}
function leadCatTile(r, big) {
    const [icon, cls] = leadCatStyle(r);
    const url = r.imageBroken ? '' : leadImageUrl(r);
    const img = url
        ? `<img src="${attr(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-lead-img="${attr(r.id || '')}">`
        : '';
    return `<span class="lead-tile ${cls}${big ? ' is-big' : ''}${img ? ' has-img' : ''}${r.imageBroken ? ' is-stale' : ''}" aria-hidden="true">${icon}${img}${r.imageBroken ? '<em class="lead-stale-badge">!</em>' : ''}</span>`;
}

/*  One page-wide listener catches any lead photo that fails to load. */
let leadImgErrWired = false;
function wireLeadImageErrors() {
    if (leadImgErrWired) return;
    leadImgErrWired = true;
    document.addEventListener(
        'error',
        (e) => {
            const img = e.target;
            if (!img || img.tagName !== 'IMG' || !img.hasAttribute('data-lead-img')) return;
            const holder = img.parentElement;
            const id = img.getAttribute('data-lead-img');
            img.remove();
            if (holder) {
                holder.classList.remove('has-img');
                holder.classList.add('is-stale');
                if (holder.classList.contains('lead-tile') && !holder.querySelector('.lead-stale-badge')) {
                    holder.insertAdjacentHTML('beforeend', '<em class="lead-stale-badge">!</em>');
                }
            }
            if (navigator.onLine !== false) markLeadImageBroken(id); // offline isn't "out of date"
        },
        true
    );
}

async function markLeadImageBroken(id) {
    if (!id || id === '__new__') return;
    const cur = (state.leads || []).find((x) => x.id === id);
    if (!cur || cur.imageBroken) return;
    cur.imageBroken = true;
    if (state.openLeadId === id) leadDraft.imageBroken = true;
    try {
        const e = { at: Date.now(), text: 'Photo link stopped working — info may be out of date (queued for re-check)' };
        const { doc, setDoc, arrayUnion } = fb.f;
        await setDoc(doc(fb.db, 'leads', id), { imageBroken: true, imageBrokenAt: Date.now(), history: arrayUnion(e) }, { merge: true });
        cur.history = [...(cur.history || []), e];
    } catch (err) {
        console.error('photo flag', err);
    }
}

const LEAD_PRIO_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

function leadStagePill2(stage) {
    const s = LEAD_STAGES[stage] ? stage : 'new';
    return `<span class="ad-pill lead-stage is-${s}">${esc(LEAD_STAGES[s])}</span>`;
}

/*  Value: the linked quote's total when there is one, else Max's estimate. */
function leadValue(r) {
    if (r.linkedQuoteId) {
        const q = (state.quoteDocs || []).find((x) => x.id === r.linkedQuoteId);
        if (q && q.totalCents > 0) return { cents: q.totalCents, src: 'quote', number: q.number || '' };
    }
    const e = Math.round(r.estValueCents || 0);
    return e > 0 ? { cents: e, src: 'est' } : null;
}
function leadDollars(cents) {
    return '$' + Math.round((cents || 0) / 100).toLocaleString('en-AU');
}
/*  Contact details as a row of small clickable icons under the lead name:
    phone (tap to call), email, website and social pages. Hover shows the
    number / address; clicking an icon does its job without opening the lead. */
const LEAD_SVG = {
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
    web: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    facebook:
        '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 8h3V4h-3a4 4 0 0 0-4 4v2H8v4h2v8h4v-8h3l1-4h-4V8.5a.5.5 0 0 1 .5-.5z"/></svg>',
    instagram:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".8" fill="currentColor"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 3h3a4 4 0 0 0 4 4v3a7 7 0 0 1-4-1.3V15a6 6 0 1 1-6-6h.5v3.2A3 3 0 1 0 14 15z"/></svg>',
    youtube:
        '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 8.2a3 3 0 0 0-2.1-2.1C18 5.6 12 5.6 12 5.6s-6 0-7.9.5A3 3 0 0 0 2 8.2 31 31 0 0 0 1.6 12 31 31 0 0 0 2 15.8a3 3 0 0 0 2.1 2.1c1.9.5 7.9.5 7.9.5s6 0 7.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .4-3.8 31 31 0 0 0-.4-3.8zM10 15V9l5.2 3z"/></svg>',
    person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>'
};
const LEAD_SOCIAL_HOSTS = [
    ['facebook', /(^|\.)(facebook\.com|fb\.com|fb\.me)$/i],
    ['instagram', /(^|\.)instagram\.com$/i],
    ['tiktok', /(^|\.)tiktok\.com$/i],
    ['youtube', /(^|\.)(youtube\.com|youtu\.be)$/i]
];

/*  A web address as a safe http(s) URL, or null. */
function leadSafeUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
    try {
        const x = new URL(u);
        return x.protocol === 'http:' || x.protocol === 'https:' ? x : null;
    } catch (e) {
        return null;
    }
}
function leadSocialKind(x) {
    const host = x.hostname.replace(/^www\./, '');
    const hit = LEAD_SOCIAL_HOSTS.find(([, re]) => re.test(host));
    return hit ? hit[0] : '';
}

/*  Website + social pages, read from the website and Socials fields.
    Socials can be links ("facebook.com/xyz") or an @handle (Instagram). */
function leadLinks(r) {
    const out = [];
    const seen = new Set();
    // one icon per kind: the website, then the first Facebook / Instagram / TikTok / YouTube page
    const add = (kind, x) => {
        if (seen.has(kind)) return;
        seen.add(kind);
        out.push({ kind, x });
    };
    const web = leadSafeUrl(r.website);
    if (web) add(leadSocialKind(web) || 'web', web);
    String(r.socials || '')
        .split(/[\s,;|]+/)
        .filter(Boolean)
        .forEach((tok) => {
            if (/^@[\w.]{2,}$/.test(tok)) {
                const x = leadSafeUrl('instagram.com/' + tok.slice(1));
                if (x) add('instagram', x);
                return;
            }
            if (!/\.[a-z]{2,}/i.test(tok)) return;
            const x = leadSafeUrl(tok);
            const kind = x && leadSocialKind(x);
            if (kind) add(kind, x); // other links (X, LinkedIn, sub-sites) aren't shown as extra globes
        });
    return out;
}

function leadContactIconsHtml(r) {
    const ic = [];
    const phone = String(r.phone || '').trim();
    if (phone) {
        ic.push(
            `<a class="lead-ic is-phone" href="tel:${attr(phone.replace(/[^\d+]/g, ''))}" title="Call ${attr(phone)}" aria-label="Call ${attr(phone)}">${LEAD_SVG.phone}</a>`
        );
    }
    const email = String(r.email || '').trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        ic.push(
            `<a class="lead-ic is-mail" href="mailto:${attr(email)}" title="Email ${attr(email)}" aria-label="Email ${attr(email)}">${LEAD_SVG.mail}</a>`
        );
    }
    const names = { web: 'Website', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };
    leadLinks(r).forEach(({ kind, x }) => {
        const label = x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname.replace(/\/$/, '') : '');
        ic.push(
            `<a class="lead-ic is-${kind}" href="${attr(x.href)}" target="_blank" rel="noopener noreferrer" title="${attr(names[kind] + ': ' + label)}" aria-label="${attr(names[kind] + ': ' + label)}">${LEAD_SVG[kind]}</a>`
        );
    });
    const crowd = r.crowd ? `<span class="lead-ev-crowd" title="Expected attendance">👥 ${esc(r.crowd)}</span>` : '';
    return ic.length || crowd ? `<span class="lead-ev-icons">${ic.join('')}${crowd}</span>` : '';
}

function leadValueHtml(r) {
    const v = leadValue(r);
    if (!v) return '<span class="ad-cell-muted">—</span>';
    return v.src === 'quote'
        ? `<span class="lead-val" title="Linked quote ${attr(v.number)}">${leadDollars(v.cents)}</span>`
        : `<span class="lead-val is-est" title="Your estimate">~${leadDollars(v.cents)}</span>`;
}

/*  How fresh a lead's info is: when the research last checked it (green
    under a month, amber under 3 months, red older) and when Max last
    changed it himself (the newest History entry).                     */
function leadFreshHtml(r) {
    const at = String(r.enrichedAt || '').slice(0, 10);
    let cls = 'is-none';
    let txt = "Phil hasn't checked this yet";
    if (/^\d{4}-\d{2}-\d{2}$/.test(at)) {
        const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at + 'T00:00:00')) / 86400000);
        if (days <= 30) cls = 'is-fresh';
        else if (days <= 90) cls = 'is-aging';
        else cls = 'is-stale';
        const rel = leadRelDay(at);
        txt = 'Phil checked ' + fmtLeadDate(at) + (/ago|Today|Yesterday/.test(rel) ? ' · ' + rel.toLowerCase() : '');
    }
    const mine = (r.history || []).reduce((m, e) => Math.max(m, Number(e && e.at) || 0), 0);
    const you = mine ? ' · you updated ' + leadRelDay(new Date(mine).toISOString().slice(0, 10)).toLowerCase() : '';
    return `<p class="lead-fresh ${cls}"><span aria-hidden="true">🔍</span> ${esc(txt + you)}</p>`;
}

function leadRelDay(iso) {
    if (!iso) return '';
    const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    if (isNaN(d)) return String(iso);
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    const n = Math.round((t - d) / 86400000);
    if (n < 0) return fmtLeadDate(String(iso).slice(0, 10));
    if (n === 0) return 'Today';
    if (n === 1) return 'Yesterday';
    if (n < 7) return n + ' days ago';
    if (n < 35) {
        const w = Math.round(n / 7);
        return w + ' week' + (w === 1 ? '' : 's') + ' ago';
    }
    return fmtLeadDate(String(iso).slice(0, 10));
}

function leadHasExactDate(r) {
    return !!(r.eventDate && /^\d{4}-\d{2}-\d{2}/.test(r.eventDate));
}
/*  A month-only lead is taken as mid-month (the 15th) - the same day it
    sorts on - so late in a month, "Sep annual" counts as been and gone.  */
function leadIsPast(r) {
    if (leadHasExactDate(r)) return r.eventDate.slice(0, 10) < todayIso();
    const k = leadMonthKey(r);
    return !!k && k + '-15' < todayIso();
}

/*  The "Showing:" range. Past events never count as upcoming, even when
    they fall earlier in this month.                                       */
function leadInRange(r, rg) {
    const k = leadMonthKey(r);
    if (rg === 'nodate') return !k;
    if (!k) return false;
    const past = leadIsPast(r);
    if (rg === 'past') return past;
    if (past) return false;
    const now = new Date();
    const span = { month: 1, next3: 3 }[rg] || 12;
    const end = new Date(now.getFullYear(), now.getMonth() + span - 1, 1);
    const endKey = end.getFullYear() + '-' + String(end.getMonth() + 1).padStart(2, '0');
    return k <= endKey;
}

/*  Sort key date: the exact day, else mid-month for a month-only lead. */
function leadSortDate(r) {
    if (leadHasExactDate(r)) return r.eventDate.slice(0, 10);
    const k = leadMonthKey(r);
    return k ? k + '-15' : '';
}

/*  Column sorting, built like the Inventory table: click a header to sort
    by it, click the active one again to flip. Each column starts in its
    natural direction (soonest date, High heat, biggest value, most recent
    contact, else A-Z), and blanks always sit at the bottom.              */
const LEAD_SORT_DIR = {
    date: 'asc',
    name: 'asc',
    location: 'asc',
    category: 'asc',
    priority: 'asc',
    stage: 'asc',
    value: 'desc',
    last: 'desc',
    updated: 'desc',
    nextact: 'asc',
    followup: 'asc',
    fit: 'desc'
};
const LEAD_SORT_LABEL = {
    date: 'Date (soonest)',
    nextact: 'Next action',
    followup: 'Follow-up date',
    fit: 'Fit (5 first)',
    value: 'Est. value',
    location: 'Distance from Bowen',
    name: 'Name (A–Z)',
    category: 'Category',
    stage: 'Stage',
    last: 'Last contact',
    updated: 'Recently updated'
};

/*  The value a column sorts on; '' or null = blank (always last). */
function leadSortValue(r, key) {
    switch (key) {
        case 'name':
            return r.title || r.contactName || '';
        case 'date':
            return leadSortDate(r);
        case 'location': {
            const k = leadKm(r);
            return k == null ? null : k;
        }
        case 'fit':
            return Math.round(r.rating || 0) || null;
        case 'category':
            return r.category || LEAD_TYPES[r.type] || '';
        case 'priority': {
            const p = { high: 0, medium: 1, low: 2 }[leadPriority(r)];
            const g = GROK_ORDER.indexOf(r.grokRating);
            return p * 1000 + (5 - Math.round(r.rating || 0)) * 100 + (g < 0 ? 99 : g) * 1 - (Number(r.winPct) || 0) / 1000;
        }
        case 'stage':
            return LEAD_STAGE_ORDER.indexOf(r.stage || 'new');
        case 'value': {
            const v = leadValue(r);
            return v ? v.cents : null;
        }
        case 'last':
            return r.lastContacted || '';
        case 'updated':
            return r.updatedAt || null;
        case 'nextact': {
            const a = leadNextAct(r);
            return a ? a.rank : null;
        }
        case 'followup':
            return /^\d{4}-\d{2}-\d{2}/.test(String(r.followUp || '')) ? String(r.followUp).slice(0, 10) : '';
        default:
            return '';
    }
}

function leadSorted(rows) {
    const key = LEAD_SORT_DIR[state.leadSort] ? state.leadSort : 'date';
    const dir = state.leadSortDir === 'asc' || state.leadSortDir === 'desc' ? state.leadSortDir : LEAD_SORT_DIR[key];
    const out = rows.slice();
    const byName = (a, b) => (a.title || '').localeCompare(b.title || '', undefined, { numeric: true, sensitivity: 'base' });

    //  "Date (soonest)": upcoming first, then no-date-yet, then past (most
    //  recent first) - so the top of the list is always what's next.
    if (key === 'date' && dir === 'asc') {
        const grp = (r) => {
            if (!leadMonthKey(r)) return 1;
            return leadIsPast(r) ? 2 : 0;
        };
        return out.sort((a, b) => {
            const g = grp(a) - grp(b);
            if (g) return g;
            const da = leadSortDate(a),
                db = leadSortDate(b);
            if (grp(a) === 2) return db.localeCompare(da) || byName(a, b);
            return da.localeCompare(db) || leadSortValue(a, 'priority') - leadSortValue(b, 'priority') || byName(a, b);
        });
    }

    const mul = dir === 'desc' ? -1 : 1;
    const blank = (v) => v === null || v === undefined || v === '';
    return out.sort((a, b) => {
        const va = leadSortValue(a, key),
            vb = leadSortValue(b, key);
        const ea = blank(va),
            eb = blank(vb);
        if (ea && eb) return byName(a, b);
        if (ea) return 1;
        if (eb) return -1;
        const c =
            typeof va === 'number' && typeof vb === 'number'
                ? va - vb
                : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
        return c * mul || byName(a, b);
    });
}

/*  A sortable header, same look as Inventory's (inv-th-sort / inv-caret). */
function leadTh(key, label, cls) {
    const on = state.leadSort === key;
    const dir = state.leadSortDir || LEAD_SORT_DIR[key];
    const glyph = on ? (dir === 'asc' ? '▲' : '▼') : '⇅';
    return `<th class="${cls ? cls + ' ' : ''}inv-th-sort${on ? ' is-sorted' : ''}" data-lead-sort="${key}"
              aria-sort="${on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${esc(label)}<span class="inv-caret${on ? '' : ' inv-caret-idle'}">${glyph}</span></th>`;
}

/*  Refresh the carets and the Sort menu in place after a sort change. */
function updateLeadSortHeaders() {
    const dir = state.leadSortDir || LEAD_SORT_DIR[state.leadSort] || 'asc';
    document.querySelectorAll('.lead-table thead [data-lead-sort]').forEach((th) => {
        const on = th.getAttribute('data-lead-sort') === state.leadSort;
        th.classList.toggle('is-sorted', on);
        th.setAttribute('aria-sort', on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
        const caret = th.querySelector('.inv-caret');
        if (caret) {
            caret.textContent = on ? (dir === 'asc' ? '▲' : '▼') : '⇅';
            caret.classList.toggle('inv-caret-idle', !on);
        }
    });
    const sel = document.getElementById('lead-sort');
    if (sel) sel.value = state.leadSort;
    const wrap = document.querySelector('.lead-table-wrap');
    if (wrap) wrap.scrollTop = 0;
}

/*  Counts for the KPI tiles and the quick-filter chips - always over every
    lead, so they stay steady while you filter.                           */
function leadChipCounts() {
    const rows = state.leads || [];
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const year = now.getFullYear();
    const c = {
        all: rows.length,
        targets: 0,
        hot: 0,
        needs: 0,
        stale: 0,
        followups: 0,
        quotes: 0,
        inplay: 0,
        won: 0,
        lost: 0,
        hotNew: 0,
        needsHot: 0,
        overdue: 0,
        quotesCents: 0,
        wonYear: 0,
        wonCents: 0
    };
    rows.forEach((r) => {
        const st = r.stage || 'new';
        const hot = !!Number(r.rating) && leadPriority(r) === 'high';
        if (r.target) c.targets++;
        if (r.imageBroken) c.stale++;
        if (hot) {
            c.hot++;
            if ((r.createdAt || 0) >= monthStart) c.hotNew++;
        }
        if (leadNeedsContact(r)) {
            c.needs++;
            if (hot) c.needsHot++;
        }
        const fu = leadFollowState(r);
        if (fu) {
            c.followups++;
            if (fu === 'overdue') c.overdue++;
        }
        if (st === 'quoted') {
            c.quotes++;
            const v = leadValue(r);
            if (v) c.quotesCents += v.cents;
        }
        if (st === 'contacted' || st === 'quoted' || st === 'negotiating') c.inplay++;
        if (st === 'won') {
            c.won++;
            if (new Date(r.updatedAt || 0).getFullYear() === year) {
                c.wonYear++;
                const v = leadValue(r);
                if (v) c.wonCents += v.cents;
            }
        }
        if (st === 'lost') c.lost++;
    });
    return c;
}

/* ---- history: a timeline per lead (added, researched, stage changes,
        follow-ups, emails, quotes, files). Entries are appended, never
        edited, so it is a true record.                                ---- */
async function leadLog(id, text) {
    if (!id || id === '__new__') return;
    try {
        const e = { at: Date.now(), text: String(text).slice(0, 300) };
        const { doc, setDoc, arrayUnion } = fb.f;
        await setDoc(doc(fb.db, 'leads', id), { history: arrayUnion(e) }, { merge: true });
        const cur = (state.leads || []).find((x) => x.id === id);
        if (cur) cur.history = [...(cur.history || []), e];
    } catch (err) {
        console.error('lead log', err);
    }
}

/*  The stored log plus the moments we can read off the lead itself
    (when it was added / imported, when it was researched).             */
function leadTimeline(r) {
    const out = (Array.isArray(r.history) ? r.history : []).map((h) => ({ at: Number(h.at) || 0, text: h.text || '' }));
    if (r.createdAt) out.push({ at: r.createdAt, text: r.importBatch ? 'Imported from the Grok research list' : 'Lead added' });
    if (r.enrichedAt) {
        const chk = (LEAD_CHECK[r.contactCheck] || [])[1];
        out.push({
            at: new Date(String(r.enrichedAt).slice(0, 10) + 'T12:00:00').getTime(),
            text: 'Researched online' + (chk ? ' — ' + chk.toLowerCase() : '')
        });
    }
    return out.filter((h) => h.at).sort((a, b) => b.at - a.at);
}

/* ---- the research log written by the web research pass ---- */
const LEAD_CHECK = {
    verified: ['is-green', 'Contacts verified'],
    added: ['is-blue', 'Contacts added'],
    updated: ['is-amber', 'Contact corrected'],
    partial: ['is-amber', 'Partly verified'],
    unverified: ['is-red', 'Contacts unverified'],
    none: ['is-slate', 'No public contact'],
    skipped: ['is-slate', 'Not researched']
};
const LEAD_FIELD_LABEL = {
    dateText: 'date',
    contactName: 'contact',
    phone: 'phone',
    email: 'email',
    website: 'website',
    venue: 'venue',
    crowd: 'attendance',
    needs: 'need',
    whyFit: 'why it fits',
    ticketUrl: 'ticket link'
};
function leadResearchHtml(doc) {
    if (!doc || !doc.enrichedAt) return '';
    const [cls, label] = LEAD_CHECK[doc.contactCheck] || LEAD_CHECK.partial;
    const prev = doc.enrichPrev && typeof doc.enrichPrev === 'object' ? Object.entries(doc.enrichPrev) : [];
    const sources = (Array.isArray(doc.enrichSources) ? doc.enrichSources : []).filter((u) => /^https?:\/\//i.test(String(u)));
    const host = (u) => {
        try {
            return new URL(u).hostname.replace(/^www\./, '');
        } catch (e) {
            return u;
        }
    };
    return `
        <div class="lead-research">
          <div class="lead-research-head">
            <strong>🔎 Researched ${esc(fmtLeadDate(String(doc.enrichedAt).slice(0, 10)))}</strong>
            <span class="lead-check ${cls}">${esc(label)}</span>
          </div>
          ${doc.enrichNotes ? `<p class="lead-research-notes">${esc(doc.enrichNotes)}</p>` : ''}
          ${prev.length ? `<p class="lead-research-prev">Replaced: ${prev.map(([k, v]) => `${esc(LEAD_FIELD_LABEL[k] || k)} was “${esc(v)}”`).join(' · ')}</p>` : ''}
          ${sources.length ? `<p class="lead-research-src">Sources: ${sources.map((u) => `<a href="${attr(u)}" target="_blank" rel="noopener noreferrer">${esc(host(u))}</a>`).join(' · ')}</p>` : ''}
        </div>`;
}

/* ---- quick actions ---- */

/*  An all-day calendar entry for the event, downloaded as an .ics file. */
function leadIcsDownload(r, id) {
    if (!leadHasExactDate(r)) return;
    const day = r.eventDate.slice(0, 10);
    const start = day.replace(/-/g, '');
    const n = new Date(day + 'T00:00:00');
    n.setDate(n.getDate() + 1);
    const end = isoDay(n).replace(/-/g, '');
    const ic = (s) =>
        String(s || '')
            .replace(/\\/g, '\\\\')
            .replace(/;/g, '\\;')
            .replace(/,/g, '\\,')
            .replace(/\r?\n/g, '\\n');
    const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
    const desc = [r.dateText, r.contactName, r.phone, r.email, r.needs ? 'Needs: ' + r.needs : ''].filter(Boolean).join('\n');
    const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//SoundzGood//Leads//EN',
        'BEGIN:VEVENT',
        'UID:lead-' + (id || day) + '@soundzgood.com.au',
        'DTSTAMP:' + stamp,
        'DTSTART;VALUE=DATE:' + start,
        'DTEND;VALUE=DATE:' + end,
        'SUMMARY:' + ic(r.title || r.eventName || 'Event'),
        'LOCATION:' + ic(r.venue || r.town),
        'DESCRIPTION:' + ic(desc),
        'END:VEVENT',
        'END:VCALENDAR'
    ].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    a.download =
        (r.title || 'event')
            .replace(/[^\w]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) + '.ics';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
    }, 1000);
}

/*  Start a new quote already filled in from the lead. When that quote is
    first saved, saveQuoteDoc links it back here (state.quoteFromLeadId). */
function createQuoteFromLead() {
    const r = leadDraft;
    quoteDraft = blankQuote();
    quoteDraft.customer = {
        ...quoteDraft.customer,
        name: r.contactName || r.decisionMaker || '',
        email: r.email || '',
        phone: r.phone || '',
        address: r.venue || r.town || '',
        eventName: r.eventName || r.title || '',
        eventDate: leadHasExactDate(r) ? r.eventDate.slice(0, 10) : ''
    };
    if (leadHasExactDate(r)) {
        quoteDraft.hire.startDate = r.eventDate.slice(0, 10);
        quoteDraft.hire.endDate = r.eventDate.slice(0, 10);
    }
    state.quoteFromLeadId = state.openLeadId;
    quoteCustomerId = '';
    state.openLeadId = null;
    state.openQuoteId = '__new__';
    location.hash = '#/quoteDocs?q=new';
}

/*  Called once the quote made from a lead is first saved: link it, and move
    a New/Contacted lead on to Quoted.                                      */
async function linkQuoteToLead(leadId, quoteId, number) {
    try {
        const cur = (state.leads || []).find((x) => x.id === leadId);
        const early = !cur || !cur.stage || cur.stage === 'new' || cur.stage === 'researching' || cur.stage === 'contacted';
        const stage = early ? 'quoted' : cur.stage;
        const patchData = { linkedQuoteId: quoteId, linkedQuoteNumber: number || '', stage, updatedAt: Date.now() };
        const { doc, setDoc } = fb.f;
        await setDoc(doc(fb.db, 'leads', leadId), patchData, { merge: true });
        if (cur) Object.assign(cur, patchData);
        await leadLog(leadId, `Quote ${number || ''} created and linked${early ? ' — stage: Quote Sent' : ''}`);
    } catch (err) {
        console.error('link quote to lead', err);
    }
}

function leadMainHtml() {
    const f = state.leadFilter;
    const cf = state.leadCatFilter;
    const rf = state.leadRegionFilter || 'all';
    const sf = state.leadSizeFilter || 'all';
    const opt = (cur, v, l) => `<option value="${attr(v)}"${cur === v ? ' selected' : ''}>${esc(l)}</option>`;
    const c = leadChipCounts();
    const ch = state.leadChip || 'all';
    const chip = (k, label, dot) => `
          <button type="button" class="lead-chip${ch === k ? ' is-active' : ''}" data-lead-chip="${k}">
            ${dot ? `<i class="lead-dot is-${dot}"></i>` : ''}${label} <span>(${c[k]})</span>
          </button>`;
    const kpi = (k, icon, tone, value, label, sub, subTone) => `
          <button type="button" class="ad-tile${ch === k ? ' is-on' : ''}" data-lead-chip="${k}">
            <span class="ad-tile-ico ${tone}" aria-hidden="true">${icon}</span>
            <span class="ad-tile-body"><b class="ad-tile-value">${value}</b><span class="ad-tile-label">${label}</span>${sub ? `<em class="ad-tile-note ${subTone || ''}">${sub}</em>` : ''}</span>
          </button>`;
    const rg = state.leadRange || 'all';
    const so = state.leadSort || 'date';

    return `
      <div class="inv-main lead-page">
        <div class="lead-top">
          <div>
            <h1>Gig Opportunities</h1>
            <p class="lead-tagline">Find. Plan. Connect. More Events for a Louder Tomorrow.</p>
          </div>
          <div class="lead-add">
            <button type="button" class="lead-cta" id="lead-add-btn" aria-haspopup="true" aria-expanded="false">＋ Add Lead <span class="lead-cta-caret" aria-hidden="true">▾</span></button>
            <div class="lead-add-menu" id="lead-add-menu" role="menu">
              <button type="button" role="menuitem" data-lead-new="production">🎛️ Production hire</button>
              <button type="button" role="menuitem" data-lead-new="dj">🎧 DJ / performance</button>
              <button type="button" role="menuitem" data-lead-new="venue">🍻 Venue / regular</button>
            </div>
          </div>
        </div>

        <div class="ad-tiles" id="lead-kpis">
          ${kpi('hot', '🔥', 'is-red', c.hot, 'Hot leads', c.hotNew ? `↑ ${c.hotNew} this month` : '', 'is-good')}
          ${kpi('needs', '📨', 'is-green', c.needs, 'Need contact', c.needsHot ? `${c.needsHot} are hot` : '', 'is-warn')}
          ${kpi('followups', '🔁', 'is-blue', c.followups, 'Follow-ups', c.overdue ? `${c.overdue} overdue` : 'due this week', c.overdue ? 'is-bad' : '')}
          ${kpi('quotes', '📄', 'is-green', c.quotes, 'Quotes out', c.quotesCents ? leadDollars(c.quotesCents) + ' value' : '', '')}
          ${kpi('won', '🏆', 'is-amber', c.wonYear, 'Won (' + new Date().getFullYear() + ')', c.wonCents ? leadDollars(c.wonCents) + ' value' : '', '')}
        </div>

        <div id="lead-cal">${leadCalendarHtml()}</div>

        <div class="lead-chipbar">
          <div class="lead-chips" id="lead-chips">
            ${chip('all', 'All Leads')}${chip('targets', '☆ My Targets')}${chip('hot', 'Hot', 'high')}${chip('needs', 'Need contact')}${c.stale ? chip('stale', '⚠ Out of date') : ''}
            ${chip('followups', 'Follow-ups')}${chip('quotes', 'Quotes')}${chip('inplay', 'In Play')}${chip('won', 'Won')}${chip('lost', 'Lost')}
          </div>
          <div class="lead-sorts">
            <label>Showing:
              <select id="lead-range" class="lead-mini-select" aria-label="Date range">
                ${opt(rg, 'all', 'All dates')}${opt(rg, 'next12', 'Next 12 months')}${opt(rg, 'next3', 'Next 3 months')}${opt(rg, 'month', 'This month')}${opt(rg, 'nodate', 'No date yet')}${opt(rg, 'past', 'Past')}
              </select></label>
            <label>Sort:
              <select id="lead-sort" class="lead-mini-select" aria-label="Sort leads">
                ${Object.keys(LEAD_SORT_LABEL)
                    .map((k) => opt(so, k, LEAD_SORT_LABEL[k]))
                    .join('')}
              </select></label>
          </div>
        </div>

        <div class="inv-toolbar lead-toolbar">
          <input type="search" id="lead-search" class="ad-search" placeholder="Search leads, events, organisers..."
                 value="${attr(state.leadSearch)}" aria-label="Search leads">
          <select id="lead-f-stage" class="ad-select" aria-label="Filter by stage">
            ${opt(f, 'all', 'All stages')}${LEAD_STAGE_ORDER.map((k) => opt(f, k, LEAD_STAGES[k])).join('')}
          </select>
          <select id="lead-f-cat" class="ad-select" aria-label="Filter by category">
            ${opt(cf, 'all', 'All categories')}${leadCategories()
                .map((x) => opt(cf, x, x))
                .join('')}
          </select>
          <select id="lead-f-region" class="ad-select" aria-label="Filter by location">
            ${opt(rf, 'all', 'Any location')}${LEAD_REGIONS.map(([k, l]) => opt(rf, k, l)).join('')}${opt(rf, 'other', 'Other / unknown')}
          </select>
          <select id="lead-f-size" class="ad-select" aria-label="Filter by size">
            ${opt(sf, 'all', 'Any size')}${LEAD_SIZES.map(([k, l]) => opt(sf, k, l)).join('')}
          </select>
        </div>

        <div class="lead-mcards" id="lead-mcards"></div>
        <div class="ad-table-wrap inv-table-wrap lead-table-wrap">
          <table class="ad-table lead-table">
            <thead>
              <tr>
                ${leadTh('name', 'Event', 'lead-evcol')}
                ${leadTh('date', 'Date')}
                ${leadTh('location', 'Location', 'lead-where')}
                ${leadTh('category', 'Category', 'lead-catcol')}
                ${leadTh('value', 'Est. Value', 'lead-num')}
                ${leadTh('nextact', 'Next Action')}
                <th></th>
              </tr>
            </thead>
            <tbody id="lead-rows"></tbody>
          </table>
        </div>

        <div class="lead-foot" id="lead-foot"></div>
      </div>`;
}

/*  Page numbers: first, last and the current page's neighbours, with …
    where pages are skipped.                                             */
function leadPageList(page, pages) {
    const want = new Set([1, pages, page - 1, page, page + 1]);
    if (page <= 3) [2, 3, 4, 5].forEach((n) => want.add(n));
    if (page >= pages - 2) [pages - 4, pages - 3, pages - 2].forEach((n) => want.add(n));
    const list = [...want].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
    const out = [];
    list.forEach((n, i) => {
        if (i && n - list[i - 1] > 1) out.push('…');
        out.push(n);
    });
    return out;
}

/*  Approximate road km from Bowen for towns outside the delivery zones - only
    used to sort leads by distance and show "~km from Bowen" (not for pricing). */
const LEAD_TOWN_KM = {
    'Hamilton Island': 100,
    'Cape Gloucester': 60,
    'Hydeaway Bay': 60,
    'Dingo Beach': 70,
    Gumlu: 60,
    'Magnetic Island': 210,
    Walkerston: 200,
    Marian: 205,
    Sarina: 225,
    Eungella: 250,
    Nebo: 280,
    Carmila: 290,
    Ravenswood: 240,
    Dysart: 380,
    Middlemount: 390,
    Capella: 470,
    Blackwater: 560,
    Springsure: 560,
    Rockhampton: 520,
    Yeppoon: 560,
    'Emu Park': 565,
    Biloela: 640,
    Gladstone: 620,
    Ingham: 310,
    Cardwell: 360,
    Tully: 410,
    'Mission Beach': 430,
    Innisfail: 460,
    Cairns: 550,
    Kuranda: 575,
    'Port Douglas': 620,
    Mareeba: 600,
    Atherton: 620,
    Yungaburra: 630,
    Malanda: 640,
    'Ellis Beach': 575,
    Laura: 850,
    Cooktown: 880,
    Greenvale: 500,
    Georgetown: 850,
    Normanton: 1100,
    Karumba: 1170,
    Aramac: 850,
    Ilfracombe: 840,
    Isisford: 1000,
    Blackall: 900,
    Tambo: 1000,
    Jundah: 1120,
    Boulia: 1200,
    Bedourie: 1400,
    Birdsville: 1500,
    Charleville: 1250,
    Quilpie: 1300,
    Noccundra: 1500,
    'Cameron Corner': 1800,
    'Daydream Island': 95,
    'Long Island': 95,
    'Hayman Island': 110,
    Whitehaven: 110,
    'St Lawrence': 300,
    Clairview: 290,
    Lucinda: 340,
    'Twin Hills': 350,
    'Clarke Creek': 400,
    Prairie: 500,
    Bouldercombe: 540,
    'Mount Surprise': 750,
    Forsayth: 820,
    Bundaberg: 800,
    Camooweal: 1200,
    Weipa: 1400,
    Cunnamulla: 1500
};

/*  Road km from Bowen: Max's own figure if he set one, else the delivery-zone
    or known-town distance of a town named in the venue / town / title, else
    the km in the research's haul note. null = unknown, 0 = local.          */
function leadKm(r) {
    const own = Number(r.km);
    if (String(r.km || '').trim() !== '' && own >= 0) return Math.round(own);
    const text = [r.town, r.venue, r.title].filter(Boolean).join(' ');
    // the longest town name found in the text wins
    const named = (name) => new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text);
    let best = null;
    DELIVERY_ZONES.forEach((z) => {
        const name = String(z.town || '')
            .replace(/\s*\(.*\)\s*/, '')
            .trim();
        if (!name || !(z.km >= 0)) return;
        if (named(name) && (!best || name.length > best.name.length)) best = { name, km: z.km };
    });
    if (best) return best.km;
    Object.entries(LEAD_TOWN_KM).forEach(([name, km]) => {
        if (named(name) && (!best || name.length > best.name.length)) best = { name, km };
    });
    if (best) return best.km;
    // the imported travel note (e.g. "~0.5 hr / 40 km") only when the town isn't known - it is often wrong
    const haul = String(r.haul || '');
    const h = haul.match(/(\d[\d,]*)\s*km/i);
    if (h) return Number(h[1].replace(/,/g, ''));
    if (/\blocal\b/i.test(haul)) return 0;
    return null;
}
function leadKmText(r) {
    const km = leadKm(r);
    if (km == null) return '';
    return km === 0 ? 'Local (Bowen)' : km.toLocaleString('en-AU') + ' km from Bowen';
}

/*  Fit, 1-5, set by Max: five bars. Click a bar to set it; click the top
    lit bar again to step down one. Saves straight away.                  */
function leadFitRater(n, editable, id) {
    const v = Math.max(0, Math.min(5, Math.round(n || 0)));
    let bars = '';
    for (let i = 1; i <= 5; i++) {
        bars += `<span class="lead-fr${i <= v ? ' on' : ''}"${editable ? ` data-fit="${i}" role="button" tabindex="0" aria-label="Fit ${i} of 5"` : ''}></span>`;
    }
    return `<span class="lead-fitr${editable ? ' is-edit' : ''}${v ? ' is-' + v : ' is-unset'}"${id ? ` data-fit-id="${attr(id)}"` : ''}
                title="${v ? 'Fit ' + v + ' / 5' : 'Fit not set'}${editable ? ' — click to set' : ''}"><span class="lead-frs">${bars}</span><em>${v ? v + '/5' : 'Set'}</em></span>`;
}

async function setLeadFit(id, n) {
    const cur = (state.leads || []).find((x) => x.id === id);
    if (!cur) return;
    const v = Math.max(0, Math.min(5, Math.round(n)));
    const next = Math.round(cur.rating || 0) === v ? v - 1 : v;
    cur.rating = next;
    if (state.openLeadId === id) leadDraft.rating = next;
    renderLeadListParts(true);
    document.querySelectorAll(`.lead-detail .lead-fitr[data-fit-id="${CSS.escape(id)}"]`).forEach((el) => {
        el.outerHTML = leadFitRater(next, true, id);
    });
    try {
        const e = { at: Date.now(), text: next ? `Fit set to ${next}/5` : 'Fit cleared' };
        const { doc, setDoc, arrayUnion } = fb.f;
        await setDoc(doc(fb.db, 'leads', id), { rating: next, updatedAt: Date.now(), history: arrayUnion(e) }, { merge: true });
        cur.history = [...(cur.history || []), e];
    } catch (err) {
        console.error('fit', err);
    }
}

/*  The organiser (club / committee / company): Max's own field if set,
    else read off the contact - "Helen Daley (Bowen Turf Club)" or
    "Andrew Watts — Longreach Jockey Club" give the organisation; a plain
    name is shown as it is.                                               */
function leadOrganiser(r) {
    const own = String(r.organiser || '').trim();
    if (own) return own;
    const c = String(r.contactName || '').trim();
    if (!c) return '';
    const paren = c.match(/\(([^()]+)\)\s*$/);
    if (paren) {
        // "(Bowen Turf Club)" is the organisation; "(functions/events)", "(Sec)"
        // or "(organiser)" is a role, so the name in front of it is used instead
        const inside = paren[1].trim();
        const role =
            /^(pres|president|sec|secretary|treasurer|chair|organi[sz]er|manager|owner|office|events?|functions?|admin|ops|contact|booking)/i;
        if (/^[A-Z]/.test(inside) && !role.test(inside)) return inside;
        return c.slice(0, paren.index).trim() || inside;
    }
    const parts = c.split(/\s[—–-]\s/);
    return parts.length > 1 ? parts[parts.length - 1].trim() : c;
}

/*  Start times: Max's own field if set, else the times written into the
    date text ("Sat 31 Oct 2026 — gates 5pm, main event 7pm" -> "gates 5pm,
    main event 7pm"; "Sat 17 Oct 2026, 12–5pm" -> "12–5pm").              */
function leadStartTime(r) {
    const own = String(r.startTime || '').trim();
    if (own) return own;
    const t = String(r.dateText || '');
    const m = t.match(/(?:\b[A-Za-z][A-Za-z-]*\s){0,3}\b\d{1,2}(?::\d{2})?\s*(?:[–-]\s*\d{1,2}(?::\d{2})?\s*)?(?:am|pm)\b/gi);
    return m ? m.map((s) => s.trim()).join(', ') : '';
}

/*  Website + social pages as small clickable icons (no phone / email). */
function leadWebIconsHtml(r) {
    const names = { web: 'Website', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };
    const ic = leadLinks(r).map(({ kind, x }) => {
        const label = x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname.replace(/\/$/, '') : '');
        return `<a class="lead-ic is-${kind}" href="${attr(x.href)}" target="_blank" rel="noopener noreferrer" title="${attr(names[kind] + ': ' + label)}" aria-label="${attr(names[kind] + ': ' + label)}">${LEAD_SVG[kind]}</a>`;
    });
    return ic.length ? `<span class="lead-ev-icons">${ic.join('')}</span>` : '';
}

/* -------------------------------------------------------------------------
   Leads on a phone: one card per lead, always the same eight boxes in the
   same order, so a gap ("Not provided") is obvious. Buttons: Email, Call,
   SMS (opens the phone's Messages with an intro already written), View,
   Next (rate it in Lead Rating).
   ------------------------------------------------------------------------- */
function leadIsMobile(phone) {
    const d = String(phone || '').replace(/[^\d+]/g, '');
    return /^(\+?61|0)4\d{8}$/.test(d);
}
function leadFirstName(r) {
    const c = String(r.contactName || '')
        .split('(')[0]
        .trim();
    if (
        !c ||
        /club|council|society|committee|association|events?|team|inc|pty|ltd|festival|shire|rotary|ops|park|hotel|resort|venue|leagues|pub|bar|centre|center|stadium|racecourse|turf|functions|office|admin/i.test(
            c
        )
    )
        return '';
    return c.split(/\s+/)[0];
}
function leadEventYear(r) {
    const y = leadHasExactDate(r) ? Number(r.eventDate.slice(0, 4)) : new Date().getFullYear();
    return leadIsPast(r) ? y + 1 : y;
}
/*  Intro SMS rules:
    1. ONE simple question. No either/or, no package upsell, no extra pitch.
    2. Default: "Do you have your entertainment booked for this event?"
       (outdoor community events: "stage, sound and entertainment").
    3. A similar job we've done goes in as proof - two points max + a link
       (fishing comps: the Stonka Fishing Challenge).
    4. Council / civic events never get an SMS - email, listing what we do.
    5. No named contact: ask who the right person is.
    6. Target '27 leads: contact them after this year's event.            */
const LEAD_PROOF_LINK = 'www.soundzgood.com.au/services.html#sgs-annual-h';
const LEAD_SAMPLE_JOBS = [
    {
        match: /fish|barra|angl/i,
        line: 'We recently did the production for the Stonka Fishing Challenge, including our live online scoreboard on a large LED screen for the leaderboard',
        ask: 'Would something like that suit your comp and presentation night?'
    },
    {
        match: /\bshow\b|agricultural|pastoral/i,
        line: 'We recently provided the audio and event production for the Don River Dash in Bowen'
    },
    { match: /festival|music|concert|country|folk|rodeo/i, line: 'We recently worked on Paradise Country at Cape Gloucester' }
];
function leadIsCouncil(r) {
    return /council|civic/i.test(String(r.category || '')) || /\bcouncil\b|\bshire\b|\bMECC\b/i.test(String(r.organiser || ''));
}
function leadSampleJob(r) {
    const text = [r.title, r.eventName, r.category, r.summary].join(' ');
    return LEAD_SAMPLE_JOBS.find((j) => j.match.test(text)) || null;
}
/*  The intro SMS: Scout's draft if Max asked for one, otherwise written
    from what the lead holds - the event, the year, what they need.       */
function leadSmsBody(r) {
    if (r.smsDraft && String(r.smsDraft).trim()) return String(r.smsDraft).trim();
    const who = leadFirstName(r);
    const ev = String(r.eventName || r.title || 'your event')
        .replace(/\s+\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b.*$/i, '')
        .replace(/\s+20\d\d\b.*$/, '')
        .replace(/\s*[—–-]\s*$/, '')
        .trim();
    const nextYear = leadIsPast(r) || r.verdict === 'nextyear';
    let when = '';
    if (!nextYear && leadHasExactDate(r)) {
        const d = new Date(r.eventDate.slice(0, 10) + 'T00:00:00');
        when =
            ' on ' +
            d.toLocaleDateString('en-AU', { weekday: 'short' }) +
            ' ' +
            d.getDate() +
            ' ' +
            d.toLocaleDateString('en-AU', { month: 'short' });
    }
    const where =
        r.town || r.venue
            ? ' in ' +
              String(r.town || r.venue)
                  .split(',')[0]
                  .replace(/\s+(QLD|Queensland)$/i, '')
                  .trim()
            : '';
    const evFull = nextYear ? `${ev} ${leadEventYear(r)}` : ev;
    const job = leadSampleJob(r);
    // street parties, parks, foreshores - community events that need a stage (race days / venues don't)
    const outdoor =
        /street|park\b|foreshore/i.test(String(r.venueSetup || '') + ' ' + String(r.venue || '')) &&
        !/racecourse|race ?day|turf/i.test(String(r.venueSetup || '') + ' ' + String(r.venue || '') + ' ' + String(r.title || ''));
    let middle;
    const recent = leadHasExactDate(r) && leadIsPast(r) && Date.now() - new Date(r.eventDate.slice(0, 10) + 'T00:00:00') < 95 * 864e5;
    // regular live-music venue (pub / club): ask about production for their bands
    if (r.type === 'venue' || /pubs\/live music/i.test(String(r.category || ''))) {
        const venue = String(r.title || r.venue || 'your venue')
            .split(/\s+[—–-]\s+/)[0]
            .split(',')[0]
            .trim();
        return [
            `Hi ${who || 'there'},`,
            '',
            'My name is Max from SoundzGood in North Queensland. We provide production services for events: www.soundzgood.com.au/services.html',
            '',
            `I'm just reaching out regarding the live music at ${venue}. Do you have someone looking after sound and production for your bands?`,
            '',
            'When you have some time, would love to discuss this further.',
            '',
            'Cheers,',
            'Max'
        ].join('\n');
    }
    let evWord = 'event';
    if (/cup/i.test(ev)) evWord = 'Cup';
    else if (/rodeo/i.test(ev)) evWord = 'Rodeo Weekend';
    else if (/\bshow\b/i.test(ev)) evWord = 'Show';
    const opener = nextYear && (recent || !leadIsPast(r)) ? `Hope this year's ${evWord} went well. ` : '';
    if (!who) {
        middle = `${opener}I'm just reaching out regarding ${evFull}${where}${when}. Who would be the best person to speak with about the event production and entertainment for it?`;
    } else if (job) {
        const show = /\bshow\b|agricultural|pastoral/i.test([r.title, r.eventName, r.category].join(' '));
        const ask =
            job.ask ||
            (show
                ? `Do you have your audio and AV sorted for ${nextYear ? "next year's Show" : 'the Show'}?`
                : `Do you have your event production sorted for ${nextYear ? 'next year' : 'this event'}?`);
        const lead = nextYear
            ? `${opener}I'm just reaching out ${opener ? 'regarding' : 'ahead of'} ${evFull}${where}.`
            : `I'm just reaching out regarding ${evFull}${where}${when}.`;
        middle = `${lead} ${job.line}, which you can see here: ${LEAD_PROOF_LINK}\n\n${ask}`;
    } else if (nextYear) {
        middle = `${opener}I'm just reaching out ${opener ? 'regarding' : 'ahead of'} ${evFull}${where}. Do you have your event production and entertainment sorted for next year?`;
    } else if (outdoor) {
        middle = `I'm just reaching out regarding ${evFull}${where}${when}. Do you have your stage, sound and entertainment sorted for this year?`;
    } else {
        middle = `I'm just reaching out regarding ${evFull}${where}${when}. Do you have your event production and entertainment sorted for this event?`;
    }
    return [
        `Hi ${who || 'there'},`,
        '',
        job
            ? 'My name is Max from SoundzGood in North Queensland. We provide production services for events.'
            : 'My name is Max from SoundzGood in North Queensland. We provide production services for events: www.soundzgood.com.au/services.html',
        '',
        middle,
        '',
        'When you have some time, would love to discuss this further.',
        '',
        'Cheers,',
        'Max'
    ].join('\n');
}

function leadSmsHref(r) {
    const num = String(r.phone || '').replace(/[^\d+]/g, '');
    // iPhone reads "&body=", Android "?body="
    const sep = /iPad|iPhone|iPod/.test(navigator.userAgent) ? '&' : '?';
    return `sms:${num}${sep}body=${encodeURIComponent(leadSmsBody(r))}`;
}
/*  The card's SMS button: off for council events and non-mobiles; a
    next-year target says when to send it.                               */
function leadSmsButtonHtml(r, phone, mobile) {
    if (leadIsCouncil(r)) return '<span class="lead-mc-btn is-sms is-off" title="Council event - email, not SMS">💬 SMS</span>';
    if (!mobile)
        return `<span class="lead-mc-btn is-sms is-off" title="${phone ? 'Not a mobile number' : 'No phone number'}">💬 SMS</span>`;
    const later = r.verdict === 'nextyear' && !leadIsPast(r) && leadHasExactDate(r);
    let label = r.smsDraft ? 'SMS ✓' : 'SMS';
    let title = '';
    if (later) {
        const when = fmtLeadDate(r.eventDate.slice(0, 10));
        label = 'After ' + esc(when.replace(/\s+20\d\d$/, ''));
        title = ` title="Target next year - best sent after ${attr(when)}"`;
    }
    return `<a class="lead-mc-btn is-sms${r.smsDraft ? ' is-checked' : ''}" href="${attr(leadSmsHref(r))}"${title}>💬 ${label}</a>`;
}

function leadMobileCardHtml(r) {
    const verified = ['verified', 'added', 'updated'].includes(r.contactCheck);
    const tick = verified ? '<i class="lead-mc-ok" title="Checked on an official page">✓</i>' : '';
    const none = '<span class="lead-mc-none">Not provided</span>';
    const box = (ico, label, val, extra = '') =>
        `<div class="lead-mc-box"><span class="lead-mc-ico" aria-hidden="true">${ico}</span><div><span class="lead-mc-lbl">${label}</span>${val || none}${extra}</div></div>`;
    const name = r.title || r.eventName || 'Untitled lead';
    const org = leadOrganiser(r);
    const img = r.imageBroken ? '' : leadImageUrl(r);
    const [icon, cls] = leadCatStyle(r);
    let date = '';
    if (leadHasExactDate(r)) {
        const d = new Date(r.eventDate.slice(0, 10) + 'T00:00:00');
        date = `<b>${esc(fmtLeadDate(r.eventDate.slice(0, 10)))}</b><em>(${d.toLocaleDateString('en-AU', { weekday: 'short' })})</em>`;
    } else if (leadWhen(r)) date = `<b>${esc(leadWhen(r))}</b>`;
    const where = r.venue || r.town || '';
    const km = leadKmText(r);
    const type =
        `<span class="ad-pill lead-cat">${esc(r.category || LEAD_TYPES[r.type] || 'Lead')}</span>` +
        (r.verdict ? `<span class="lead-verdict is-${attr(r.verdict)}">${esc(LEAD_VERDICT[r.verdict] || r.verdict)}</span>` : '') +
        (r.stage === 'won' ? '<span class="lead-verdict is-won">🏆 Won</span>' : '');
    const contact = String(r.contactName || '').trim();
    const phone = String(r.phone || '').trim();
    const email = String(r.email || '').trim();
    const okEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const web = leadSafeUrl(r.website);
    const notes = String(r.summary || r.needs || '').trim();
    const mobile = leadIsMobile(phone);
    return `
  <article class="lead-mc${state.openLeadId === r.id ? ' is-open' : ''}">
    <header class="lead-mc-head">
      <span class="lead-mc-img ${cls}">${img ? `<img src="${attr(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-lead-img="${attr(r.id)}">` : `<i aria-hidden="true">${icon}</i>`}</span>
      <div class="lead-mc-title">
        <h3>${esc(name)}${r.target ? ' <span class="lead-ev-star">★</span>' : ''}</h3>
        ${org ? `<p>${esc(org)}</p>` : ''}
        ${leadWebIconsHtml(r)}
      </div>
      <span class="lead-mc-stage">${esc(LEAD_STAGES[r.stage || 'new'] || 'New')}</span>
    </header>
    <div class="lead-mc-grid">
      ${box('📅', 'Date', date)}
      ${box('📍', 'Location', where ? `<b>${esc(where)}</b>` : '', km ? `<em>${esc(km)}</em>` : '')}
      ${box('🏷️', 'Event type', type)}
      ${box('👥', 'Est. attendance', r.crowd ? `<b>${esc(r.crowd)}</b>` : '')}
    </div>
    <div class="lead-mc-grid">
      ${box('👤', 'Contact name', contact ? `<b>${esc(contact.split(' — ')[0].split('(')[0].trim() || contact)}</b>` : '')}
      ${box('📞', 'Phone', phone ? `<a href="tel:${attr(phone.replace(/[^\d+]/g, ''))}">${esc(phone)}</a>${tick}` : '')}
      ${box('✉️', 'Email', okEmail ? `<a href="mailto:${attr(email)}">${esc(email)}</a>${tick}` : '')}
      ${box('🌐', 'Website', web ? `<a href="${attr(web.href)}" target="_blank" rel="noopener noreferrer">${esc(web.hostname.replace(/^www\./, ''))}</a>${tick}` : '')}
    </div>
    <p class="lead-mc-notes"><span>Event notes</span>${notes ? esc(notes.length > 180 ? notes.slice(0, 177) + '…' : notes) : '<span class="lead-mc-none">Not provided</span>'}</p>
    <div class="lead-mc-acts">
      <button type="button" class="lead-mc-btn is-email" data-mc-email="${attr(r.id)}"${okEmail ? '' : ' disabled'}>✉️ Email</button>
      ${phone ? `<a class="lead-mc-btn is-call" href="tel:${attr(phone.replace(/[^\d+]/g, ''))}">📞 Call</a>` : '<span class="lead-mc-btn is-call is-off">📞 Call</span>'}
      ${leadSmsButtonHtml(r, phone, mobile)}
      <button type="button" class="lead-mc-btn is-view" data-mc-view="${attr(r.id)}">View</button>
      <button type="button" class="lead-mc-btn is-next" data-mc-next="${attr(r.id)}">Next ›</button>
    </div>
  </article>`;
}

function renderLeadRows() {
    const host = document.getElementById('lead-rows');
    const foot = document.getElementById('lead-foot');
    if (!host) return;
    const all = leadSorted(leadFiltered());
    const per = state.leadPerPage || 10;
    const pages = Math.max(1, Math.ceil(all.length / per));
    if (state.leadPage > pages) state.leadPage = pages;
    if (!state.leadPage || state.leadPage < 1) state.leadPage = 1;
    const start = (state.leadPage - 1) * per;
    const rows = all.slice(start, start + per);

    host.innerHTML = rows.length
        ? rows
              .map((r) => {
                  const when = leadWhen(r);
                  const where = r.venue || r.town || '';
                  const km = leadKmText(r);
                  const fu = leadFollowState(r);
                  const name = r.title || r.eventName || r.contactName || 'Untitled lead';
                  const org = leadOrganiser(r);
                  const time = leadStartTime(r);
                  return `
    <tr class="lead-row${state.openLeadId === r.id ? ' is-open' : ''}" data-open-lead="${attr(r.id)}">
      <td class="lead-evcol">
        <div class="lead-ev">
          ${leadCatTile(r)}
          <span class="lead-ev-text">
            <span class="lead-ev-name" title="${attr(name)}">${esc(name)}${r.target ? ' <span class="lead-ev-star" title="My target">★</span>' : ''}</span>
            ${org ? `<span class="lead-ev-org" title="${attr(org)}">${esc(org)}</span>` : ''}
            ${leadWebIconsHtml(r)}
          </span>
        </div>
      </td>
      <td class="lead-when">${when ? `<span class="lead-ico" aria-hidden="true">📅</span>${esc(when)}` : '<span class="ad-cell-muted">—</span>'}${time && !String(when).includes(time) ? `<span class="lead-time" title="${attr(time)}">${esc(time)}</span>` : ''}</td>
      <td class="lead-where">
        ${where ? `<span class="lead-loc" title="${attr(where)}"><span class="lead-ico" aria-hidden="true">📍</span>${esc(where)}</span>` : '<span class="ad-cell-muted">—</span>'}
        ${km ? `<span class="lead-km">${esc(km)}</span>` : ''}
      </td>
      <td class="lead-catcol">${r.category ? `<span class="ad-pill lead-cat">${esc(r.category)}</span>` : `<span class="ad-pill lead-cat is-type">${esc(LEAD_TYPES[r.type] || 'Lead')}</span>`}${r.verdict ? `<span class="lead-verdict is-${attr(r.verdict)}">${esc(LEAD_VERDICT[r.verdict] || r.verdict)}</span>` : ''}</td>
      <td class="lead-num">${leadValueHtml(r)}</td>
      <td>${leadNextActHtml(r)}${fu ? `<span class="lead-fu is-${fu}">${fu === 'overdue' ? 'Overdue ' : 'Due '}${esc(fmtLeadDate(String(r.followUp).slice(0, 10)))}</span>` : ''}${(() => {
          const e = leadEoi(r);
          return e && e.state !== 'closed'
              ? `<span class="lead-eoi is-${e.state}" title="${attr(e.note || 'Supplier deadline')}">EOI closes ${esc(fmtLeadDate(e.date))}</span>`
              : '';
      })()}</td>
      <td class="ad-cell-right"><button type="button" class="lead-more" data-open-lead="${attr(r.id)}" aria-label="${r.id === state.openLeadId ? 'Close' : 'Open'} ${attr(name)}">${r.id === state.openLeadId ? 'Less' : 'More'}</button></td>
    </tr>`;
              })
              .join('')
        : `<tr><td colspan="8" class="ad-cell-muted">No leads match. Try clearing the filters, or add one with ＋ Add Lead.</td></tr>`;
    const mc = document.getElementById('lead-mcards');
    if (mc)
        mc.innerHTML = rows.length
            ? rows.map(leadMobileCardHtml).join('')
            : '<p class="ad-cell-muted">No leads match. Try clearing the filters.</p>';

    if (foot) {
        const from = all.length ? start + 1 : 0;
        const to = Math.min(start + per, all.length);
        const pager = leadPageList(state.leadPage, pages)
            .map((n) =>
                n === '…'
                    ? '<span class="ad-pg-gap">…</span>'
                    : `<button type="button" class="ad-pg${n === state.leadPage ? ' is-on' : ''}" data-lead-page="${n}"${n === state.leadPage ? ' aria-current="page"' : ''}>${n}</button>`
            )
            .join('');
        const perOpt = (n) => `<option value="${n}"${per === n ? ' selected' : ''}>${n} per page</option>`;
        foot.innerHTML = `
      <div class="lead-foot-count"><strong>${all.length} lead${all.length === 1 ? '' : 's'}</strong>
        <span>Showing ${from}–${to} of ${all.length}</span></div>
      <div class="ad-pages">
        <button type="button" class="ad-pg" data-lead-page="${state.leadPage - 1}"${state.leadPage <= 1 ? ' disabled' : ''} aria-label="Previous page">&#8249;</button>
        ${pager}
        <button type="button" class="ad-pg" data-lead-page="${state.leadPage + 1}"${state.leadPage >= pages ? ' disabled' : ''} aria-label="Next page">&#8250;</button>
      </div>
      <select class="lead-mini-select lead-per" id="lead-per" aria-label="Leads per page">${[10, 25, 50, 100].map(perOpt).join('')}</select>`;
    }
}

let leadAddMenuWired = false;

/*  Open a lead in the side panel (on a given tab). */
function openLead(id, tab) {
    const doc = (state.leads || []).find((x) => x.id === id);
    if (!doc) return false;
    leadDraft = leadFromDoc(doc);
    state.openLeadId = id;
    state.leadTab = tab || 'overview';
    return true;
}

/*  Up / Down arrow keys step through the leads on screen, opening each
    in the side panel (ignored while typing in a field). */
let leadKeysWired = false;
function wireLeadKeys() {
    if (leadKeysWired) return;
    leadKeysWired = true;
    document.addEventListener('keydown', (e) => {
        if (state.view !== 'leads' || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
        if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest('input, select, textarea, [contenteditable]')) return;
        const ids = [...document.querySelectorAll('.lead-table tr.lead-row[data-open-lead]')].map((tr) =>
            tr.getAttribute('data-open-lead')
        );
        if (!ids.length) return;
        e.preventDefault();
        const at = ids.indexOf(state.openLeadId);
        const next = at < 0 ? ids[0] : ids[Math.max(0, Math.min(ids.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next === state.openLeadId) return;
        if (!openLead(next, state.leadTab || 'overview')) return;
        render();
        const row = document.querySelector('.lead-table tr.lead-row.is-open');
        if (row) row.scrollIntoView({ block: 'nearest' });
    });
}

function wireLeadList() {
    wireLeadKeys();
    renderLeadRows();
    wireLeadCalendar();

    // ＋ Add Lead ▾ - pick the kind of lead
    const addBtn = document.getElementById('lead-add-btn');
    const addMenu = document.getElementById('lead-add-menu');
    if (addBtn && addMenu) {
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = !addMenu.classList.contains('is-open');
            addMenu.classList.toggle('is-open', open);
            addBtn.setAttribute('aria-expanded', String(open));
        });
        if (!leadAddMenuWired) {
            // one page-wide listener: a click anywhere outside closes the menu
            leadAddMenuWired = true;
            document.addEventListener('click', (e) => {
                if (e.target.closest('.lead-add')) return;
                const m = document.getElementById('lead-add-menu');
                const b = document.getElementById('lead-add-btn');
                if (m) m.classList.remove('is-open');
                if (b) b.setAttribute('aria-expanded', 'false');
            });
        }
    }
    document.querySelectorAll('[data-lead-new]').forEach((b) =>
        b.addEventListener('click', () => {
            leadDraft = blankLead(b.getAttribute('data-lead-new'));
            state.openLeadId = '__new__';
            state.leadTab = 'details';
            render();
        })
    );

    const onSel = (id, key) => {
        const el = document.getElementById(id);
        if (el)
            el.addEventListener('change', () => {
                state[key] = el.value;
                renderLeadListParts();
            });
    };
    onSel('lead-f-stage', 'leadFilter');
    onSel('lead-f-cat', 'leadCatFilter');
    onSel('lead-f-region', 'leadRegionFilter');
    onSel('lead-f-size', 'leadSizeFilter');
    onSel('lead-range', 'leadRange');
    const sortSel = document.getElementById('lead-sort');
    if (sortSel)
        sortSel.addEventListener('change', () => {
            state.leadSort = sortSel.value;
            state.leadSortDir = '';
            state.leadPage = 1;
            updateLeadSortHeaders();
            renderLeadRows();
        });
    const search = document.getElementById('lead-search');
    if (search)
        search.addEventListener('input', () => {
            state.leadSearch = search.value;
            renderLeadListParts();
        });

    const thead = document.querySelector('.lead-table thead');
    if (thead)
        thead.addEventListener('click', (e) => {
            const th = e.target.closest('[data-lead-sort]');
            if (!th) return;
            const k = th.getAttribute('data-lead-sort');
            if (state.leadSort === k) {
                const cur = state.leadSortDir || LEAD_SORT_DIR[k];
                state.leadSortDir = cur === 'asc' ? 'desc' : 'asc';
            } else {
                state.leadSort = k;
                state.leadSortDir = '';
            }
            state.leadPage = 1;
            updateLeadSortHeaders();
            renderLeadRows();
        });

    // chips and KPI tiles share the same quick filters
    const page = document.querySelector('.lead-page');
    if (page)
        page.addEventListener('click', (e) => {
            const b = e.target.closest('[data-lead-chip]');
            if (!b) return;
            const k = b.getAttribute('data-lead-chip');
            state.leadChip = state.leadChip === k && k !== 'all' ? 'all' : k;
            page.querySelectorAll('.lead-chip[data-lead-chip]').forEach((x) =>
                x.classList.toggle('is-active', x.getAttribute('data-lead-chip') === state.leadChip)
            );
            page.querySelectorAll('.ad-tile[data-lead-chip]').forEach((x) =>
                x.classList.toggle('is-on', x.getAttribute('data-lead-chip') === state.leadChip)
            );
            renderLeadListParts();
        });

    const foot = document.getElementById('lead-foot');
    if (foot) {
        foot.addEventListener('click', (e) => {
            const b = e.target.closest('[data-lead-page]');
            if (!b || b.disabled) return;
            state.leadPage = Number(b.getAttribute('data-lead-page')) || 1;
            renderLeadRows();
            const wrap = document.querySelector('.lead-table-wrap');
            if (wrap) {
                wrap.scrollTop = 0;
                // on a phone the page scrolls, not the list, so bring the list into view
                if (!window.matchMedia('(min-width: 900px)').matches) wrap.scrollIntoView({ block: 'nearest' });
            }
        });
        foot.addEventListener('change', (e) => {
            if (e.target.id !== 'lead-per') return;
            state.leadPerPage = Number(e.target.value) || 10;
            state.leadPage = 1;
            renderLeadRows();
        });
    }

    const mcHost = document.getElementById('lead-mcards');
    if (mcHost)
        mcHost.addEventListener('click', (e) => {
            const b = e.target.closest('[data-mc-view], [data-mc-next], [data-mc-email]');
            if (!b) return;
            if (b.hasAttribute('data-mc-view')) {
                if (openLead(b.getAttribute('data-mc-view'), 'overview')) {
                    render();
                    window.scrollTo(0, 0);
                }
                return;
            }
            if (b.hasAttribute('data-mc-email')) {
                if (openLead(b.getAttribute('data-mc-email'), 'overview')) {
                    render();
                    openLeadCompose();
                }
                return;
            }
            if (b.hasAttribute('data-mc-next')) {
                // rate this one in Lead Rating
                const rs = rateState();
                rs.focus = b.getAttribute('data-mc-next');
                rs.pick = 0;
                rs.tipDraft = '';
                location.hash = '#/leadRate';
            }
        });
    const host = document.getElementById('lead-rows');
    if (!host) return;
    host.addEventListener('keydown', (e) => {
        const el = e.target.closest('.lead-fitr.is-edit [data-fit]');
        if (el && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            el.click();
        }
    });
    host.addEventListener('click', (e) => {
        if (e.target.closest('a')) return; // contact icons / search links open themselves
        const fitBar = e.target.closest('.lead-fitr.is-edit [data-fit]');
        if (fitBar) {
            const id = fitBar.closest('[data-fit-id]').getAttribute('data-fit-id');
            setLeadFit(id, Number(fitBar.getAttribute('data-fit')));
            return;
        }
        const act = e.target.closest('[data-lead-nact]');
        if (act) {
            // the Next Action button: open the lead and do the thing
            if (!openLead(act.getAttribute('data-id'), 'overview')) return;
            const k = act.getAttribute('data-lead-nact');
            if (k === 'email') {
                openLeadCompose();
                return;
            }
            if (k === 'quote') {
                if (leadDraft.linkedQuoteId) {
                    state.openLeadId = null;
                    location.hash = '#/quoteDocs?q=' + leadDraft.linkedQuoteId;
                } else {
                    createQuoteFromLead();
                }
                return;
            }
            render();
            return;
        }
        const r = e.target.closest('[data-open-lead]');
        if (!r) return;
        // the row's More button reads Less while its lead is open, and closes the side panel
        if (r.classList.contains('lead-more') && r.getAttribute('data-open-lead') === state.openLeadId) {
            state.openLeadId = null;
            render();
            return;
        }
        if (openLead(r.getAttribute('data-open-lead'), 'overview')) render();
    });
}

function leadFromDoc(doc) {
    const b = blankLead(doc.type);
    Object.keys(b).forEach((k) => {
        if (doc[k] != null) b[k] = doc[k];
    });
    b.rating = Math.max(0, Math.min(5, Math.round(doc.rating || 0)));
    b.stage = LEAD_STAGES[doc.stage] ? doc.stage : 'new';
    b.source = LEAD_SOURCES[doc.source] ? doc.source : 'manual';
    b.estValueCents = Math.max(0, Math.round(doc.estValueCents || 0));
    b.target = !!doc.target;
    // copies, so editing the draft never touches the live list until saved
    b.contacts = (Array.isArray(doc.contacts) ? doc.contacts : []).map((c) => ({
        name: c.name || '',
        role: c.role || '',
        phone: c.phone || '',
        email: c.email || ''
    }));
    b.files = Array.isArray(doc.files) ? doc.files.slice() : [];
    b.history = Array.isArray(doc.history) ? doc.history.slice() : [];
    return b;
}

/* ---- the side panel: compact header + tabs, laid out like the mockup ---- */
const LEAD_OV_SVG = {
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14a6.5 6.5 0 0 1 3 6"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg>',
    money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 6.5c-1-1.3-2.8-2-5-2-2.8 0-4.5 1.4-4.5 3.3 0 4.5 10 2.3 10 7 0 2-1.8 3.4-5 3.4-2.4 0-4.3-.8-5.3-2.2"/></svg>',
    road: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
    org: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 10h4a1 1 0 0 1 1 1v10M8 8h3M8 12h3M8 16h3M3 21h18"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16.5 9.5"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>'
};

function leadNeedItems(needs) {
    return String(needs || '')
        .split(/\s*(?:\/|,|\+|&|;|\||\band\b)\s*/i)
        .map((s) => s.trim())
        .filter((s) => s.length > 1)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .slice(0, 8);
}

function leadOvItem(icon, value, label) {
    return `<div class="lead-ov-item"><span class="lead-ov-ico" aria-hidden="true">${icon}</span>
    <span class="lead-ov-txt"><strong>${value}</strong><em>${esc(label)}</em></span></div>`;
}

/*  "About the event": the opening of the research notes (they lead with
    what the event is), else the why-it-fits line.                        */
function leadAbout(r, doc) {
    // the research's plain-English 'what is this event' wins when there is one
    const sum = String(r.summary || (doc && doc.summary) || '').trim();
    if (sum) return sum;
    const notes = String((doc && doc.enrichNotes) || '').trim();
    if (notes) {
        const parts = notes.match(/[^.!?]+[.!?]+/g) || [notes];
        let out = '';
        for (const p of parts) {
            if ((out + p).length > 230) break;
            out += p;
        }
        return (out || notes.slice(0, 230)).trim();
    }
    return '';
}

function leadOverviewHtml(r, doc) {
    const linkedQ = r.linkedQuoteId ? (state.quoteDocs || []).find((x) => x.id === r.linkedQuoteId) : null;
    const v = leadValue(r);
    const links = leadLinks(r);
    const web = links.find((l) => l.kind === 'web');
    const socials = links.filter((l) => l.kind !== 'web');
    const short = (x) => x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname.replace(/\/$/, '') : '');
    const a = (x, text) => `<a href="${attr(x.href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
    const phone = String(r.phone || '').trim();
    const email = String(r.email || '').trim();
    const contactBits = [
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? `<a href="mailto:${attr(email)}">${esc(email)}</a>` : '',
        phone ? `<a href="tel:${attr(phone.replace(/[^\d+]/g, ''))}">${esc(phone)}</a>` : ''
    ].filter(Boolean);
    const needs = leadNeedItems(r.needs);
    const socialNames = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };
    const dash = '<span class="lead-ov-none">—</span>';
    const fu = leadFollowState(r);
    const fuDate = /^\d{4}-\d{2}-\d{2}/.test(String(r.followUp || '')) ? fmtLeadDate(String(r.followUp).slice(0, 10)) : '';
    const about = leadAbout(r, doc);
    const eoi = leadEoi(r);
    let eoiLeft = '';
    if (eoi && eoi.state === 'closed') eoiLeft = ' (closed)';
    else if (eoi && eoi.state === 'soon') eoiLeft = ` — ${eoi.days} day${eoi.days === 1 ? '' : 's'} left`;
    let fuTag = '';
    if (fu === 'overdue') fuTag = ' <span class="lead-fu is-overdue">overdue</span>';
    else if (fu === 'due') fuTag = ' <span class="lead-fu is-due">this week</span>';

    return `
    <div class="lead-actions">
      <button type="button" class="lead-act is-primary" data-lead-act="email">✉ Prepare Outreach</button>
      <button type="button" class="lead-act" data-lead-act="quote">${linkedQ ? '▦ Open ' + esc(linkedQ.number || 'Quote') : '＋ Create Quote'}</button>
      <div class="lead-actions-row">
        <button type="button" class="lead-act" data-lead-act="ics"${leadHasExactDate(r) ? '' : ' disabled title="Needs an exact event date"'}>📅 Add to Calendar</button>
        <button type="button" class="lead-act" data-lead-act="won"${r.stage === 'won' ? ' disabled' : ''}>${r.stage === 'won' ? '🎉 Won' : '✓ Mark as Won'}</button>
        <span class="lead-more-wrap">
          <button type="button" class="lead-act lead-act-more" data-lead-act="more" aria-label="More actions" aria-haspopup="true">···</button>
          <span class="lead-more-menu" role="menu">
            <button type="button" role="menuitem" data-lead-act="delete">Delete lead</button>
          </span>
        </span>
      </div>
    </div>

    ${
        fuDate || r.nextAction || eoi
            ? `<div class="lead-next${fu === 'overdue' || (eoi && eoi.state === 'soon') ? ' is-overdue' : ''}">
      ${eoi ? `<p title="${attr(eoi.note)}"><strong>Supplier deadline:</strong> ${esc(fmtLeadDate(eoi.date))}${eoiLeft}${eoi.note ? ' · ' + esc(eoi.note) : ''}</p>` : ''}
      ${fuDate ? `<p><strong>Follow up:</strong> ${esc(fuDate)}${fuTag}</p>` : ''}
      ${r.nextAction ? `<p class="lead-next-note" title="${attr(r.nextAction)}"><strong>Next step:</strong> ${esc(r.nextAction)}</p>` : ''}
    </div>`
            : ''
    }

    ${leadFreshHtml(doc || r)}
    ${leadTipsHtml(doc || r)}
    <h3 class="lead-sec">About the Event</h3>
    ${about ? `<p class="lead-about" title="${attr(about)}">${esc(about)}</p>` : ''}
    ${String(r.pitch || '').trim() ? `<p class="lead-pitch" title="${attr(r.pitch)}"><b>Worth it?</b> ${esc(r.pitch)}</p>` : ''}
    <div class="lead-ov-grid">
      <div>
        ${leadOvItem(LEAD_OV_SVG.users, r.crowd ? esc(r.crowd) : dash, 'Expected attendance')}
        ${v ? leadOvItem(LEAD_OV_SVG.money, v.src === 'quote' ? leadDollars(v.cents) + ' (quote)' : '~' + leadDollars(v.cents), 'Value') : ''}
        ${leadKmText(r) || r.haul ? leadOvItem(LEAD_OV_SVG.road, esc([leadKmText(r), r.haul].filter(Boolean).join(' · ')), 'From Bowen') : ''}
      </div>
      <div>
        ${leadOvItem(LEAD_OV_SVG.org, leadOrganiser(r) || r.decisionMaker ? esc(leadOrganiser(r) || r.decisionMaker) : dash, 'Organiser')}
        ${web || !socials.length ? leadOvItem(LEAD_SVG.web, web ? a(web.x, short(web.x)) : dash, 'Website') : ''}
        ${socials.length ? leadOvItem(LEAD_SVG[socials[0].kind] || LEAD_SVG.web, socials.map((s) => a(s.x, socialNames[s.kind] || 'Social')).join(' · '), 'Social media') : ''}
        ${leadOvItem(LEAD_SVG.mail, contactBits.length ? contactBits.join('<br>') : dash, 'Contact')}
      </div>
    </div>

    <h3 class="lead-sec">Why It Fits SoundzGood</h3>
    ${
        needs.length
            ? `<ul class="lead-fit">${needs.map((n) => `<li><span class="lead-fit-ico" aria-hidden="true">${LEAD_OV_SVG.check}</span>${esc(n)}</li>`).join('')}</ul>`
            : '<p class="lead-ov-empty">No requirements yet — add them under Details.</p>'
    }
    ${r.whyFit ? `<p class="lead-fit-why">${esc(r.whyFit)}</p>` : ''}

    ${
        [r.venueSetup, LEAD_POWER[r.power], r.recurrence, r.incumbent].some(Boolean)
            ? `<p class="lead-facts">
      ${r.venueSetup ? `<span title="Venue setup">🏟 ${esc(r.venueSetup)}</span>` : ''}
      ${LEAD_POWER[r.power] ? `<span class="is-power-${r.power}" title="Power">⚡ ${esc(LEAD_POWER[r.power])}</span>` : ''}
      ${r.recurrence ? `<span title="When it runs">🔁 ${esc(r.recurrence)}</span>` : ''}
      ${r.incumbent ? `<span title="${attr(r.incumbent)}">🎤 Supplier: ${esc(r.incumbent)}</span>` : ''}
    </p>`
            : ''
    }`;
}

/* ---- contacts: the main contact plus any number of others ---- */
function leadOtherContactsHtml(r) {
    const list = Array.isArray(r.contacts) ? r.contacts : [];
    return (
        list
            .map(
                (c, i) => `
      <div class="lead-oc">
        <div class="inv-fgrid">
          <label class="ad-field"><span>Name</span><input class="ad-input" data-lc-i="${i}" data-lc-f="name" value="${attr(c.name)}"></label>
          <label class="ad-field"><span>Role</span><input class="ad-input" data-lc-i="${i}" data-lc-f="role" value="${attr(c.role)}" placeholder="e.g. Secretary"></label>
          <label class="ad-field"><span>Phone</span><input class="ad-input" data-lc-i="${i}" data-lc-f="phone" value="${attr(c.phone)}"></label>
          <label class="ad-field"><span>Email</span><input class="ad-input" type="email" data-lc-i="${i}" data-lc-f="email" value="${attr(c.email)}"></label>
        </div>
        <button type="button" class="lead-oc-rm" data-lead-act="rmcontact" data-i="${i}" aria-label="Remove this contact">Remove</button>
      </div>`
            )
            .join('') || '<p class="lead-ov-empty">No other contacts yet.</p>'
    );
}

/* ---- history: the timeline ---- */
function leadHistoryHtml(r) {
    const items = leadTimeline(r);
    const past =
        r.lastEdition || r.recurrence
            ? `<div class="lead-lastyr">${r.lastEdition ? `<p><strong>Last edition:</strong> ${esc(r.lastEdition)}</p>` : ''}${r.recurrence ? `<p><strong>Runs:</strong> ${esc(r.recurrence)}</p>` : ''}</div>`
            : '';
    if (!items.length) return past + '<p class="lead-ov-empty">Nothing recorded yet.</p>';
    return (
        past +
        `<ol class="lead-tl">${items
            .map((h) => {
                const d = new Date(h.at);
                const when =
                    d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) +
                    ' · ' +
                    d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
                return `<li><span class="lead-tl-dot" aria-hidden="true"></span><div><strong>${esc(h.text)}</strong><em>${esc(when)}</em></div></li>`;
            })
            .join('')}</ol>`
    );
}

/* ---- files: briefs, maps, stage plots - private to the admin ---- */
function leadFileSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
}
function leadFilesHtml(r) {
    const files = Array.isArray(r.files) ? r.files : [];
    return `
      <label class="lead-upload">
        <input type="file" id="lead-file-input" multiple>
        <span>＋ Upload files</span>
      </label>
      <p class="lead-upload-hint">Event maps, briefs, stage plots, run sheets — up to 20 MB each. Only admins can see them.</p>
      <p class="ad-quote-msg" id="lead-file-msg"></p>
      ${
          files.length
              ? `<ul class="lead-files">${files
                    .slice()
                    .sort((a, b) => (b.at || 0) - (a.at || 0))
                    .map(
                        (f) => `
        <li>
          <span class="lead-file-ico" aria-hidden="true">${LEAD_OV_SVG.file}</span>
          <span class="lead-file-txt">
            ${/^https:\/\//.test(String(f.url || '')) ? `<a href="${attr(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.name)}</a>` : esc(f.name)}
            <em>${esc(leadFileSize(f.size))} · ${esc(fmtLeadDate(new Date(f.at || 0).toISOString().slice(0, 10)))}</em>
          </span>
          <button type="button" class="lead-file-rm" data-lead-act="rmfile" data-path="${attr(f.path)}" aria-label="Delete ${attr(f.name)}">✕</button>
        </li>`
                    )
                    .join('')}</ul>`
              : '<p class="lead-ov-empty">No files yet.</p>'
      }`;
}

async function uploadLeadFiles(fileList) {
    const id = state.openLeadId;
    const msg = document.getElementById('lead-file-msg');
    const say = (t, cls) => setMsg(msg, t, cls);
    if (!id || id === '__new__') {
        say('Save the lead first, then add files.', 'is-bad');
        return;
    }
    const files = [...(fileList || [])];
    if (!files.length) return;
    const tooBig = files.filter((f) => f.size > 20 * 1024 * 1024);
    const ok = files.filter((f) => f.size <= 20 * 1024 * 1024);
    if (!ok.length) {
        say('Files must be under 20 MB.', 'is-bad');
        return;
    }
    say(`Uploading ${ok.length} file${ok.length === 1 ? '' : 's'}…`);
    try {
        const { ref, uploadBytes, getDownloadURL } = fb.st;
        const added = [];
        for (const file of ok) {
            const safe = file.name.replace(/[^\w.-]+/g, '_').slice(-80);
            const path = `lead-files/${id}/${Date.now()}-${safe}`;
            await uploadBytes(ref(fb.storage, path), file, { contentType: file.type || 'application/octet-stream' });
            const url = await getDownloadURL(ref(fb.storage, path));
            added.push({ name: file.name.slice(0, 160), path, url, size: file.size, type: file.type || '', at: Date.now() });
        }
        const cur = (state.leads || []).find((x) => x.id === id);
        const all = [...((cur && cur.files) || []), ...added];
        const log = added.map((f, i) => ({ at: Date.now() + i, text: 'File added: ' + f.name }));
        const { doc, setDoc, arrayUnion } = fb.f;
        await setDoc(doc(fb.db, 'leads', id), { files: all, history: arrayUnion(...log), updatedAt: Date.now() }, { merge: true });
        if (cur) {
            cur.files = all;
            cur.history = [...(cur.history || []), ...log];
        }
        leadDraft.files = all;
        leadDraft.history = cur ? cur.history : leadDraft.history;
        render();
        if (tooBig.length) say(`${tooBig.length} file${tooBig.length === 1 ? ' was' : 's were'} over 20 MB and skipped.`, 'is-bad');
    } catch (err) {
        say(err.message || 'Upload failed.', 'is-bad');
    }
}

async function deleteLeadFile(path) {
    const id = state.openLeadId;
    const cur = (state.leads || []).find((x) => x.id === id);
    const f = ((cur && cur.files) || []).find((x) => x.path === path);
    if (!f || !window.confirm(`Delete "${f.name}"? This cannot be undone.`)) return;
    try {
        const { ref, deleteObject } = fb.st;
        try {
            await deleteObject(ref(fb.storage, path));
        } catch (e) {
            /* already gone */
        }
        const all = cur.files.filter((x) => x.path !== path);
        const e = { at: Date.now(), text: 'File removed: ' + f.name };
        const { doc, setDoc, arrayUnion } = fb.f;
        await setDoc(doc(fb.db, 'leads', id), { files: all, history: arrayUnion(e), updatedAt: Date.now() }, { merge: true });
        cur.files = all;
        cur.history = [...(cur.history || []), e];
        leadDraft.files = all;
        leadDraft.history = cur.history;
        render();
    } catch (err) {
        const msg = document.getElementById('lead-file-msg');
        setMsg(msg, err.message || 'Could not delete.', 'is-bad');
    }
}

/*  ☆ My Targets - saved straight away, it's a quick toggle. */
async function toggleLeadTarget() {
    leadDraft.target = !leadDraft.target;
    const btn = document.querySelector('.lead-target');
    if (btn) {
        btn.classList.toggle('is-on', leadDraft.target);
        btn.textContent = leadDraft.target ? '★' : '☆';
    }
    const id = state.openLeadId;
    if (!id || id === '__new__') return;
    try {
        const { doc, setDoc } = fb.f;
        await setDoc(doc(fb.db, 'leads', id), { target: leadDraft.target, updatedAt: Date.now() }, { merge: true });
        const cur = (state.leads || []).find((x) => x.id === id);
        if (cur) cur.target = leadDraft.target;
        await leadLog(id, leadDraft.target ? 'Added to My Targets' : 'Removed from My Targets');
        renderLeadRows();
    } catch (err) {
        console.error('target', err);
    }
}

function leadDetailHtml() {
    const isNew = state.openLeadId === '__new__';
    const r = leadDraft;
    const doc = isNew ? null : (state.leads || []).find((x) => x.id === state.openLeadId);
    const type = LEAD_TYPES[r.type] ? r.type : 'production';
    const typeOpt = (v) => `<option value="${v}"${type === v ? ' selected' : ''}>${LEAD_TYPES[v]}</option>`;
    const srcOpt = (v) => `<option value="${v}"${r.source === v ? ' selected' : ''}>${LEAD_SOURCES[v]}</option>`;
    const stageOpt = (v) => `<option value="${v}"${r.stage === v ? ' selected' : ''}>${LEAD_STAGES[v]}</option>`;
    const quotes = (state.quoteDocs || []).filter((q) => q && q.number);
    const qOpt = (q) =>
        `<option value="${attr(q.id)}"${r.linkedQuoteId === q.id ? ' selected' : ''}>${esc(q.number)}${q.customer && q.customer.name ? ' — ' + esc(q.customer.name) : ''}</option>`;
    const linkedQ = r.linkedQuoteId ? (state.quoteDocs || []).find((x) => x.id === r.linkedQuoteId) : null;
    const prio = leadPriority(r);
    const when = r.dateText || leadWhen(r);
    const where = r.venue || r.town || '';
    const recurring = /annual|recurring|seasonal|every|weekly|monthly/i.test(r.dateText || '');
    const est = r.estValueCents ? r.estValueCents / 100 : '';
    const nContacts = leadContactCount(r);
    const nFiles = (r.files || []).length;
    const tabs = isNew
        ? [
              ['details', 'Details'],
              ['contacts', 'Contacts'],
              ['notes', 'Notes']
          ]
        : [
              ['overview', 'Overview'],
              ['details', 'Details'],
              ['contacts', `Contacts${nContacts ? ` (${nContacts})` : ''}`],
              ['history', 'History'],
              ['notes', 'Notes'],
              ['files', `Files${nFiles ? ` (${nFiles})` : ''}`]
          ];
    const tab = tabs.some(([k]) => k === state.leadTab) ? state.leadTab : tabs[0][0];
    const pane = (k, html) =>
        `<section class="lead-pane${tab === k ? ' is-on' : ''}" data-lead-pane="${k}" role="tabpanel">${html}</section>`;

    const details = `
      <div class="inv-fgrid">
        <label class="ad-field"><span>Type</span>
          <select class="ad-select" data-lf="type">${typeOpt('production')}${typeOpt('dj')}${typeOpt('venue')}</select></label>
        <label class="ad-field"><span>Stage</span>
          <select class="ad-select" data-lf="stage">${LEAD_STAGE_ORDER.map(stageOpt).join('')}</select></label>
        <label class="ad-field inv-span2"><span>Lead name / headline</span>
          <input class="ad-input" data-lf="title" value="${attr(r.title)}" placeholder="e.g. Airlie Beach Festival 2027, or The Reef Hotel"></label>
        <label class="ad-field inv-span2"><span>Event name</span>
          <input class="ad-input" data-lf="eventName" value="${attr(r.eventName)}" placeholder="What's on"></label>
        <label class="ad-field"><span>Date</span>
          <input class="ad-input" type="date" data-lf="eventDate" value="${attr(r.eventDate)}"></label>
        <label class="ad-field"><span>Date as listed</span>
          <input class="ad-input" data-lf="dateText" value="${attr(r.dateText)}" placeholder="e.g. Sat 10 Oct, gates 12pm"></label>
        <label class="ad-field inv-span2"><span>Start time(s)</span>
          <input class="ad-input" data-lf="startTime" value="${attr(r.startTime)}" placeholder="${attr(leadStartTime(r) ? 'auto: ' + leadStartTime(r) : 'e.g. Gates 5pm · main event 7pm')}"></label>
        <label class="ad-field"><span>Follow up on</span>
          <input class="ad-input" type="date" data-lf="followUp" value="${attr(r.followUp)}"></label>
        <label class="ad-field"><span>Last contacted</span>
          <input class="ad-input" type="date" data-lf="lastContacted" value="${attr(r.lastContacted)}"></label>
        <label class="ad-field inv-span2"><span>Next step (your note)</span>
          <input class="ad-input" data-lf="nextAction" value="${attr(r.nextAction)}" placeholder="e.g. Call the secretary about the 2027 season"></label>
        <label class="ad-field"><span>Expected attendance</span>
          <input class="ad-input" data-lf="crowd" value="${attr(r.crowd)}" placeholder="e.g. ~3,000"></label>
        <label class="ad-field"><span>Estimated value $</span>
          <input class="ad-input" type="number" min="0" step="100" data-lf="estValue" value="${attr(est)}" placeholder="e.g. 5000"></label>
        <label class="ad-field inv-span2"><span>Linked quote</span>
          <select class="ad-select" data-lf="linkedQuoteId">
            <option value="">— none —</option>
            ${quotes.map(qOpt).join('')}
          </select></label>
        ${linkedQ ? `<p class="lead-quote-note inv-span2">Quote ${esc(linkedQ.number || '')}: <strong>${leadDollars(linkedQ.totalCents)}</strong> — shown as the value instead of the estimate.</p>` : ''}
        <label class="ad-field"><span>Venue</span>
          <input class="ad-input" data-lf="venue" value="${attr(r.venue)}" placeholder="Where"></label>
        <label class="ad-field"><span>Town</span>
          <input class="ad-input" data-lf="town" value="${attr(r.town)}" placeholder="e.g. Airlie Beach"></label>
        <label class="ad-field inv-span2"><span>Likely requirements</span>
          <input class="ad-input" data-lf="needs" value="${attr(r.needs)}" placeholder="e.g. PA / stage / lighting / MC"></label>
        <label class="ad-field inv-span2"><span>Why it fits</span>
          <input class="ad-input" data-lf="whyFit" value="${attr(r.whyFit)}"></label>
        <label class="ad-field inv-span2"><span>Budget signals</span>
          <input class="ad-input" data-lf="budget" value="${attr(r.budget)}" placeholder="Ticketed? Sponsored? Council-backed?"></label>
        <label class="ad-field"><span>Category</span>
          <input class="ad-input" data-lf="category" value="${attr(r.category)}" list="lead-cat-list" placeholder="e.g. Race days"></label>
        <label class="ad-field"><span>Research heat</span>
          <select class="ad-select" data-lf="grokRating">
            <option value="">—</option>
            ${GROK_ORDER.map((g) => `<option value="${g}"${r.grokRating === g ? ' selected' : ''}>${g}</option>`).join('')}
          </select></label>
        <label class="ad-field"><span>Win chance %</span>
          <input class="ad-input" type="number" min="0" max="100" data-lf="winPct" value="${attr(r.winPct)}"></label>
        <label class="ad-field"><span>Haul from Bowen</span>
          <input class="ad-input" data-lf="haul" value="${attr(r.haul)}" placeholder="e.g. ~4 hr / 340 km"></label>
        <label class="ad-field"><span>Km from Bowen</span>
          <input class="ad-input" type="number" min="0" step="1" data-lf="km" value="${attr(r.km)}" placeholder="${attr(leadKm(r) == null ? 'e.g. 340' : 'auto: ' + leadKm(r))}"></label>
        <label class="ad-field inv-span2"><span>Current / previous supplier</span>
          <input class="ad-input" data-lf="incumbent" value="${attr(r.incumbent)}" placeholder="Who does their AV now, if known"></label>
        <label class="ad-field"><span>Supplier deadline (EOI / tender)</span>
          <input class="ad-input" type="date" data-lf="eoiDate" value="${attr(r.eoiDate)}"></label>
        <label class="ad-field"><span>Deadline note</span>
          <input class="ad-input" data-lf="eoiNote" value="${attr(r.eoiNote)}" placeholder="e.g. Council EOI via VendorPanel"></label>
        <label class="ad-field inv-span2"><span>Runs (recurring pattern)</span>
          <input class="ad-input" data-lf="recurrence" value="${attr(r.recurrence)}" placeholder="e.g. 2nd Saturday of October, every year"></label>
        <label class="ad-field inv-span2"><span>Last year's edition</span>
          <input class="ad-input" data-lf="lastEdition" value="${attr(r.lastEdition)}" placeholder="e.g. Sat 11 Oct 2025 · ~2,800 people · lineup: …"></label>
        <label class="ad-field"><span>Venue setup</span>
          <input class="ad-input" data-lf="venueSetup" value="${attr(r.venueSetup)}" placeholder="e.g. Outdoor showground, marquee"></label>
        <label class="ad-field"><span>Power</span>
          <select class="ad-select" data-lf="power">${[
              ['', '—'],
              ['mains', 'Mains power on site'],
              ['generator', 'Generator needed'],
              ['unknown', 'Unknown']
          ]
              .map(([v, l]) => `<option value="${v}"${(r.power || '') === v ? ' selected' : ''}>${l}</option>`)
              .join('')}</select></label>
        <label class="ad-field inv-span2"><span>Ticket / listing link</span>
          <input class="ad-input" data-lf="ticketUrl" value="${attr(r.ticketUrl)}" placeholder="Eventbrite / Humanitix / etc."></label>
        <label class="ad-field inv-span2"><span>Photo link</span>
          <input class="ad-input" data-lf="imageUrl" value="${attr(r.imageUrl)}" placeholder="https://…  (on their site: right-click the photo → Copy image address)"></label>
        ${/fbcdn|cdninstagram|scontent\./i.test(r.imageUrl || '') ? '<p class="lead-quote-note inv-span2">Facebook / Instagram photo links expire within days on their own — use a photo from their website if you can.</p>' : ''}
      </div>
      <datalist id="lead-cat-list">${leadCategories()
          .map((x) => `<option value="${attr(x)}">`)
          .join('')}</datalist>`;

    const contacts = `
      ${isNew ? '' : leadContactIconsHtml(r)}
      <h4 class="lead-sub">Main contact</h4>
      <div class="inv-fgrid">
        <label class="ad-field inv-span2"><span>Organiser (club / committee / company)</span>
          <input class="ad-input" data-lf="organiser" value="${attr(r.organiser)}" placeholder="${attr(leadOrganiser(r) ? 'auto: ' + leadOrganiser(r) : 'e.g. Bowen Turf Club')}"></label>
        <label class="ad-field"><span>Contact person</span>
          <input class="ad-input" data-lf="contactName" value="${attr(r.contactName)}" placeholder="Who you deal with"></label>
        <label class="ad-field"><span>Decision maker</span>
          <input class="ad-input" data-lf="decisionMaker" value="${attr(r.decisionMaker)}"></label>
        <label class="ad-field"><span>Phone</span>
          <input class="ad-input" data-lf="phone" value="${attr(r.phone)}" placeholder="Mobile"></label>
        <label class="ad-field"><span>Email</span>
          <input class="ad-input" type="email" data-lf="email" value="${attr(r.email)}" placeholder="name@example.com"></label>
        <label class="ad-field inv-span2"><span>Website</span>
          <input class="ad-input" data-lf="website" value="${attr(r.website)}" placeholder="https://"></label>
        <label class="ad-field inv-span2"><span>Social media</span>
          <input class="ad-input" data-lf="socials" value="${attr(r.socials)}" placeholder="Facebook / Instagram links, or @handle"></label>
      </div>
      <h4 class="lead-sub">Other contacts</h4>
      <div id="lead-oc-list">${leadOtherContactsHtml(r)}</div>
      <button type="button" class="lead-act lead-act-wide lead-oc-add" data-lead-act="addcontact">＋ Add another contact</button>`;

    const notes = `
      ${leadResearchHtml(doc)}
      <label class="ad-field"><span>Your notes</span>
        <textarea class="ad-input lead-notes" rows="6" data-lf="notes" placeholder="Anything worth remembering...">${esc(r.notes)}</textarea></label>
      <div class="inv-fgrid lead-notes-src">
        <label class="ad-field"><span>Source</span>
          <select class="ad-select" data-lf="source">${srcOpt('manual')}${srcOpt('auto')}${srcOpt('website')}${srcOpt('directory')}</select></label>
        <label class="ad-field"><span>Source link</span>
          <input class="ad-input" data-lf="sourceUrl" value="${attr(r.sourceUrl)}" placeholder="Where you found it"></label>
      </div>`;

    return `
    <aside class="inv-detail lead-detail" aria-label="Lead details">
      <div class="lead-hero ${leadCatStyle(r)[1]}">
        <span class="lead-hero-ico" aria-hidden="true">${leadCatStyle(r)[0]}</span>
        ${!isNew && !r.imageBroken && leadImageUrl(r) ? `<img class="lead-hero-img" src="${attr(leadImageUrl(r))}" alt="" referrerpolicy="no-referrer" data-lead-img="${attr(state.openLeadId)}">` : ''}
        ${isNew ? '' : `<span class="lead-prio is-${prio}">${LEAD_PRIO_LABEL[prio]} priority</span>`}
        <button type="button" class="lead-hero-close" id="lead-close" aria-label="Close">&times;</button>
      </div>

      <div class="lead-dhead">
        <div class="lead-dtitle">
          <h2>${isNew ? 'New lead' : esc(r.title || r.contactName || 'Lead')}</h2>
          <button type="button" class="lead-target${r.target ? ' is-on' : ''}" data-lead-act="target" title="My Targets" aria-pressed="${!!r.target}" aria-label="Add to My Targets">${r.target ? '★' : '☆'}</button>
        </div>
        ${
            !isNew && (when || where)
                ? `<p class="lead-dmeta">
          ${when ? `<span><span class="lead-ico" aria-hidden="true">📅</span>${esc(when)}</span>` : ''}
          ${where ? `<span><span class="lead-ico" aria-hidden="true">📍</span>${esc(where)}</span>` : ''}</p>`
                : ''
        }
        ${
            !isNew
                ? `<div class="lead-dtags">
          ${recurring ? '<span class="ad-pill lead-cat is-recur">Recurring event</span>' : ''}
          ${r.category ? `<span class="ad-pill lead-cat">${esc(r.category)}</span>` : `<span class="ad-pill lead-cat is-type">${esc(LEAD_TYPES[type])}</span>`}
          ${leadStagePill2(r.stage)}
          ${r.grokRating ? `${grokPill(r.grokRating)}${r.winPct ? `<span class="lead-win">${esc(r.winPct)}% win</span>` : ''}` : ''}
          ${leadNeedsContact(r) ? '<span class="lead-flag">Needs contact</span>' : ''}
          ${r.imageBroken ? '<span class="lead-flag is-stale" title="Their photo link stopped working - they have probably updated their site. Queued for the research to re-check.">⚠ Photo gone — may be out of date</span>' : ''}
          ${doc && doc.enrichedAt ? `<button type="button" class="lead-research-pill ${(LEAD_CHECK[doc.contactCheck] || LEAD_CHECK.partial)[0]}" data-lead-tab="notes" title="Researched ${attr(fmtLeadDate(String(doc.enrichedAt).slice(0, 10)))} — open notes &amp; sources">🔎 ${esc((LEAD_CHECK[doc.contactCheck] || LEAD_CHECK.partial)[1])}</button>` : ''}
        </div>`
                : `<div class="lead-drate"><span>Fit</span>${leadFitRater(r.rating, true, '')}</div>`
        }
      </div>

      <nav class="ad-linetabs" role="tablist" aria-label="Lead sections">
        ${tabs.map(([k, label]) => `<button type="button" role="tab" class="ad-linetab${tab === k ? ' is-on' : ''}" data-lead-tab="${k}" aria-selected="${tab === k}">${label}</button>`).join('')}
      </nav>

      <div class="lead-panes">
        ${isNew ? '' : pane('overview', leadOverviewHtml(r, doc))}
        ${pane('details', details)}
        ${pane('contacts', contacts)}
        ${isNew ? '' : pane('history', leadHistoryHtml(doc || r))}
        ${pane('notes', notes)}
        ${isNew ? '' : pane('files', leadFilesHtml(r))}
      </div>

      <footer class="inv-detail-foot">
        <span class="ad-quote-msg" id="lead-msg"></span>
        <button type="button" class="ad-btn ad-btn-primary" id="lead-save">${isNew ? 'Add lead' : 'Save changes'}</button>
      </footer>
    </aside>`;
}

function wireLeadDetail() {
    const panel = document.querySelector('.lead-detail');
    if (!panel) return;
    const doc = (state.leads || []).find((x) => x.id === state.openLeadId);

    const close = document.getElementById('lead-close');
    if (close)
        close.addEventListener('click', () => {
            state.openLeadId = null;
            render();
        });

    const showTab = (k) => {
        state.leadTab = k;
        panel.querySelectorAll('.ad-linetab[data-lead-tab]').forEach((b) => {
            const on = b.getAttribute('data-lead-tab') === k;
            b.classList.toggle('is-on', on);
            b.setAttribute('aria-selected', String(on));
        });
        panel.querySelectorAll('[data-lead-pane]').forEach((p) => p.classList.toggle('is-on', p.getAttribute('data-lead-pane') === k));
        // the Overview is a read-out of the draft, so redraw it with any edits
        if (k === 'overview') {
            const ov = panel.querySelector('[data-lead-pane="overview"]');
            if (ov) ov.innerHTML = leadOverviewHtml(leadDraft, doc);
        }
        panel.scrollTop = 0;
    };
    const contactsTabLabel = () => {
        const t = panel.querySelector('.ad-linetab[data-lead-tab="contacts"]');
        const n = leadContactCount(leadDraft);
        if (t) t.textContent = 'Contacts' + (n ? ` (${n})` : '');
    };

    panel.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.lcI != null) {
            const c = leadDraft.contacts[Number(t.dataset.lcI)];
            if (c) c[t.dataset.lcF] = t.value;
            return;
        }
        if (!t.dataset.lf) return;
        if (t.dataset.lf === 'estValue') leadDraft.estValueCents = toCents(t.value);
        else leadDraft[t.dataset.lf] = t.value;
        if (t.dataset.lf === 'contactName' || t.dataset.lf === 'phone' || t.dataset.lf === 'email') contactsTabLabel();
    });
    panel.addEventListener('change', (e) => {
        const t = e.target;
        if (t.id === 'lead-file-input') {
            uploadLeadFiles(t.files);
            t.value = '';
            return;
        }
        if (t.dataset.lf === 'linkedQuoteId') {
            leadDraft.linkedQuoteId = t.value;
            const q = (state.quoteDocs || []).find((x) => x.id === t.value);
            leadDraft.linkedQuoteNumber = q ? q.number || '' : '';
            render();
        } else if (t.dataset.lf === 'type') {
            leadDraft.type = t.value;
        }
    });

    // keyboard: Enter / Space on a Fit bar sets it
    panel.addEventListener('keydown', (e) => {
        const el = e.target.closest('.lead-fitr.is-edit [data-fit]');
        if (el && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            el.click();
        }
    });

    panel.addEventListener('click', (e) => {
        const fitBar = e.target.closest('.lead-fitr.is-edit [data-fit]');
        if (fitBar) {
            const n = Number(fitBar.getAttribute('data-fit'));
            if (state.openLeadId && state.openLeadId !== '__new__') {
                setLeadFit(state.openLeadId, n);
                return;
            }
            // a new lead: just the draft, saved with the lead
            leadDraft.rating = Math.round(leadDraft.rating || 0) === n ? n - 1 : n;
            const holder = fitBar.closest('.lead-fitr');
            if (holder) holder.outerHTML = leadFitRater(leadDraft.rating, true, '');
            return;
        }
        const tabBtn = e.target.closest('[data-lead-tab]');
        if (tabBtn) {
            showTab(tabBtn.getAttribute('data-lead-tab'));
            return;
        }
        const menu = panel.querySelector('.lead-more-menu');
        const act = e.target.closest('[data-lead-act]');
        if (!act || act.disabled) {
            if (menu) menu.classList.remove('is-open');
            return;
        }
        const what = act.getAttribute('data-lead-act');
        if (what !== 'more' && menu) menu.classList.remove('is-open');
        if (what === 'email') openLeadCompose();
        else if (what === 'ics') leadIcsDownload(leadDraft, state.openLeadId);
        else if (what === 'won') {
            leadDraft.stage = 'won';
            saveLead(act);
        } else if (what === 'more') {
            if (menu) menu.classList.toggle('is-open');
        } else if (what === 'delete') deleteLead(act);
        else if (what === 'target') toggleLeadTarget();
        else if (what === 'rmfile') deleteLeadFile(act.getAttribute('data-path'));
        else if (what === 'addcontact' || what === 'rmcontact') {
            leadDraft.contacts = Array.isArray(leadDraft.contacts) ? leadDraft.contacts : [];
            if (what === 'addcontact') leadDraft.contacts.push({ name: '', role: '', phone: '', email: '' });
            else leadDraft.contacts.splice(Number(act.getAttribute('data-i')), 1);
            const list = panel.querySelector('#lead-oc-list');
            if (list) list.innerHTML = leadOtherContactsHtml(leadDraft);
            contactsTabLabel();
            if (what === 'addcontact') {
                const first = panel.querySelector('#lead-oc-list .lead-oc:last-child input');
                if (first) first.focus();
            }
        } else if (what === 'quote') {
            if (leadDraft.linkedQuoteId) {
                state.openLeadId = null;
                location.hash = '#/quoteDocs?q=' + leadDraft.linkedQuoteId;
            } else {
                createQuoteFromLead();
            }
        }
    });

    const save = document.getElementById('lead-save');
    if (save) save.addEventListener('click', () => saveLead(save));
}

function leadClean(r) {
    const type = LEAD_TYPES[r.type] ? r.type : 'production';
    const s = (v, n) =>
        String(v == null ? '' : v)
            .trim()
            .slice(0, n);
    return {
        type,
        title: s(r.title, 160),
        contactName: s(r.contactName, 120),
        phone: s(r.phone, 40),
        email: s(r.email, 200),
        website: s(r.website, 300),
        socials: s(r.socials, 500),
        eventName: s(r.eventName, 200),
        eventDate: s(r.eventDate, 20),
        venue: s(r.venue, 160),
        town: s(r.town, 80),
        crowd: s(r.crowd, 80),
        source: LEAD_SOURCES[r.source] ? r.source : 'manual',
        sourceUrl: s(r.sourceUrl, 500),
        ticketUrl: s(r.ticketUrl, 500),
        budget: s(r.budget, 300),
        needs: s(r.needs, 500),
        rating: Math.max(0, Math.min(5, Math.round(r.rating || 0))),
        stage: LEAD_STAGES[r.stage] ? r.stage : 'new',
        linkedQuoteId: s(r.linkedQuoteId, 60),
        linkedQuoteNumber: s(r.linkedQuoteNumber, 40),
        lastContacted: s(r.lastContacted, 20),
        notes: s(r.notes, 6000),
        dateText: s(r.dateText, 120),
        category: s(r.category, 80),
        grokRating: GROK_PILL[r.grokRating] ? r.grokRating : '',
        winPct: s(r.winPct, 4),
        nextAction: s(r.nextAction, 1000),
        incumbent: s(r.incumbent, 1000),
        haul: s(r.haul, 120),
        whyFit: s(r.whyFit, 1000),
        decisionMaker: s(r.decisionMaker, 300),
        importBatch: s(r.importBatch, 60),
        estValueCents: Math.max(0, Math.round(Number(r.estValueCents) || 0)),
        followUp: /^\d{4}-\d{2}-\d{2}$/.test(s(r.followUp, 10)) ? s(r.followUp, 10) : '',
        target: !!r.target,
        organiser: s(r.organiser, 160),
        startTime: s(r.startTime, 120),
        imageUrl: /^https?:\/\//i.test(s(r.imageUrl, 1000)) ? s(r.imageUrl, 1000) : '',
        eoiDate: /^\d{4}-\d{2}-\d{2}$/.test(s(r.eoiDate, 10)) ? s(r.eoiDate, 10) : '',
        eoiNote: s(r.eoiNote, 300),
        recurrence: s(r.recurrence, 160),
        lastEdition: s(r.lastEdition, 400),
        venueSetup: s(r.venueSetup, 200),
        power: ['mains', 'generator', 'unknown'].includes(r.power) ? r.power : '',
        km: String(r.km == null ? '' : r.km).trim() === '' ? '' : Math.max(0, Math.round(Number(r.km) || 0)),
        contacts: (Array.isArray(r.contacts) ? r.contacts : [])
            .map((c) => ({ name: s(c.name, 120), role: s(c.role, 80), phone: s(c.phone, 40), email: s(c.email, 200) }))
            .filter((c) => c.name || c.phone || c.email)
            .slice(0, 12),
        updatedAt: Date.now()
    };
}

/*  What changed, in words, for the History timeline. */
function leadChanges(prev, next) {
    if (!prev) return ['Lead added'];
    const out = [];
    const st = (x) => LEAD_STAGES[x || 'new'] || x;
    if ((prev.stage || 'new') !== next.stage) out.push(`Stage: ${st(prev.stage)} → ${st(next.stage)}`);
    if ((prev.followUp || '') !== next.followUp)
        out.push(next.followUp ? `Follow-up set for ${fmtLeadDate(next.followUp)}` : 'Follow-up cleared');
    if (Math.round(prev.rating || 0) !== next.rating) out.push(next.rating ? `Fit set to ${next.rating}/5` : 'Fit cleared');
    if ((prev.linkedQuoteId || '') !== next.linkedQuoteId && next.linkedQuoteId) out.push(`Quote ${next.linkedQuoteNumber || ''} linked`);
    const pc = (prev.contacts || []).length;
    if (pc !== next.contacts.length) out.push(next.contacts.length > pc ? 'Contact added' : 'Contact removed');
    if ((prev.email || '') !== next.email || (prev.phone || '') !== next.phone) out.push('Contact details updated');
    if ((prev.lastContacted || '') !== next.lastContacted && next.lastContacted)
        out.push(`Marked contacted on ${fmtLeadDate(next.lastContacted)}`);
    if ((prev.imageUrl || '') !== next.imageUrl) out.push(next.imageUrl ? 'Photo link updated' : 'Photo link removed');
    if ((prev.eoiDate || '') !== next.eoiDate && next.eoiDate) out.push(`Supplier deadline noted: ${fmtLeadDate(next.eoiDate)}`);
    return out;
}

async function saveLead(btn) {
    const msg = document.getElementById('lead-msg');
    const r = leadDraft;
    if (!String(r.title || '').trim() && !String(r.contactName || '').trim()) {
        setMsg(msg, 'Give it a name or a contact first.', 'is-bad');
        return;
    }
    const clean = leadClean(r);
    setMsg(msg, 'Saving…', '');
    if (btn) btn.disabled = true;
    try {
        const { collection, doc, setDoc, addDoc, arrayUnion } = fb.f;
        state.leads = state.leads || [];
        const isNew = state.openLeadId === '__new__';
        const prev = isNew ? null : state.leads.find((x) => x.id === state.openLeadId);
        if (!prev || (prev.imageUrl || '') !== clean.imageUrl) clean.imageBroken = false; // a new link gets a fresh chance
        const log = leadChanges(prev, clean).map((text, i) => ({ at: Date.now() + i, text }));
        if (isNew) {
            clean.createdAt = Date.now();
            clean.history = log;
            const ref = await addDoc(collection(fb.db, 'leads'), clean);
            state.openLeadId = ref.id;
            state.leads.push({ id: ref.id, ...clean });
            if (state.leadTab === 'details') state.leadTab = 'overview';
        } else {
            const id = state.openLeadId;
            const payload = { ...clean };
            if (log.length) payload.history = arrayUnion(...log);
            await setDoc(doc(fb.db, 'leads', id), payload, { merge: true });
            const cur = state.leads.find((x) => x.id === id);
            if (cur) {
                Object.assign(cur, clean);
                cur.history = [...(cur.history || []), ...log];
            } else state.leads.push({ id, ...clean, history: log });
        }
        setMsg(msg, 'Saved.', 'is-ok');
        render();
    } catch (err) {
        setMsg(msg, err.message || 'Could not save.', 'is-bad');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function deleteLead(btn) {
    if (!window.confirm('Delete this lead? This cannot be undone.')) return;
    const id = state.openLeadId;
    if (id === '__new__') {
        state.openLeadId = null;
        render();
        return;
    }
    if (btn) btn.disabled = true;
    try {
        const { doc, deleteDoc } = fb.f;
        await deleteDoc(doc(fb.db, 'leads', id));
        state.leads = (state.leads || []).filter((x) => x.id !== id);
        state.openLeadId = null;
        render();
    } catch (err) {
        const msg = document.getElementById('lead-msg');
        setMsg(msg, err.message || 'Could not delete.', 'is-bad');
        if (btn) btn.disabled = false;
    }
}

/* ---- email composer: draft + send, never auto-send ---- */
/*  Council / civic events: an introduction that lists what we do. */
function leadCouncilEmail(r, who, ev) {
    return [
        `Hi ${who},`,
        '',
        `My name is Max from SoundzGood in North Queensland. I'm reaching out to introduce ourselves ahead of ${ev}.`,
        '',
        'We provide event production across the region, including:',
        '• Sound systems (PA) for stages, parks and street events',
        '• Lighting and staging',
        '• Large LED screens (live leaderboards, sponsors, video)',
        '• DJs and MCs',
        '• Crew and technicians, bump-in to bump-out',
        '',
        'You can see more of what we do here: www.soundzgood.com.au/services.html',
        '',
        'When you have some time, would love to discuss this further.',
        '',
        'Cheers,',
        'Max',
        'SoundzGood Whitsundays',
        'www.soundzgood.com.au'
    ].join('\n');
}

function openLeadCompose() {
    const r = leadDraft;
    if (!String(r.email || '').trim()) {
        const msg = document.getElementById('lead-msg');
        setMsg(msg, 'Add an email address first.', 'is-bad');
        return;
    }
    const who = (r.contactName || '').trim().split(/\s+/)[0] || 'there';
    const ev = r.eventName || r.title || 'your event';
    // Scout's draft (asked for in Lead Rating) wins over the standard template
    const draft = ((state.leads || []).find((x) => x.id === state.openLeadId) || {}).outreachDraft;
    if (draft && String(draft.body || '').trim()) {
        state.leadCompose = {
            to: r.email.trim(),
            subject: draft.subject || `SoundzGood Whitsundays — ${ev}`,
            body: draft.body,
            leadId: state.openLeadId
        };
        render();
        return;
    }
    if (leadIsCouncil(r)) {
        state.leadCompose = {
            to: r.email.trim(),
            subject: `SoundzGood — event production for ${ev}`,
            body: leadCouncilEmail(r, who, ev),
            leadId: state.openLeadId
        };
        render();
        return;
    }
    const subject = `SoundzGood Whitsundays — ${r.eventName || r.title || 'your event'}`;
    const body = `Hi ${who},

I'm Max from SoundzGood Whitsundays — we do sound, lighting, staging and DJ/entertainment for events around the Whitsundays and beyond.

I came across ${ev} and wanted to see whether you've got your audio/production sorted. We're local, reliable, and can put together a package to suit whatever you're planning.

If you'd like a quick quote or a chat, just reply here or give me a call.

Cheers,
Max
SoundzGood Whitsundays
www.soundzgood.com.au`;
    state.leadCompose = { to: r.email.trim(), subject, body, leadId: state.openLeadId };
    render();
}

function leadComposeHtml() {
    const c = state.leadCompose;
    return `
    <div class="lead-compose-back" id="lead-compose-back">
      <div class="lead-compose" role="dialog" aria-label="Email lead">
        <header class="lead-compose-head">
          <h3>Email lead</h3>
          <button type="button" class="inv-detail-close" id="lead-compose-close" aria-label="Close">&times;</button>
        </header>
        <div class="lead-compose-body">
          <label class="ad-field"><span>To</span><input class="ad-input" id="lc-to" value="${attr(c.to)}"></label>
          <label class="ad-field"><span>Subject</span><input class="ad-input" id="lc-subject" value="${attr(c.subject)}"></label>
          <label class="ad-field"><span>Message</span><textarea class="ad-input" id="lc-body" rows="12">${esc(c.body)}</textarea></label>
          <p class="lead-compose-note">Sends from bookings@soundzgood.com.au. Nothing goes out until you press Send.</p>
        </div>
        <footer class="lead-compose-foot">
          <button type="button" class="ad-btn" id="lc-cancel">Cancel</button>
          <button type="button" class="ad-btn ad-btn-primary" id="lc-send">Send email</button>
          <span class="ad-quote-msg" id="lc-msg"></span>
        </footer>
      </div>
    </div>`;
}

function wireLeadCompose() {
    const close = () => {
        state.leadCompose = null;
        render();
    };
    const x = document.getElementById('lead-compose-close');
    const cancel = document.getElementById('lc-cancel');
    const back = document.getElementById('lead-compose-back');
    if (x) x.addEventListener('click', close);
    if (cancel) cancel.addEventListener('click', close);
    if (back)
        back.addEventListener('click', (e) => {
            if (e.target === back) close();
        });

    const send = document.getElementById('lc-send');
    if (send)
        send.addEventListener('click', async () => {
            const to = (document.getElementById('lc-to').value || '').trim();
            const subject = (document.getElementById('lc-subject').value || '').trim();
            const body = document.getElementById('lc-body').value || '';
            const msg = document.getElementById('lc-msg');
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
                setMsg(msg, 'That email does not look right.', 'is-bad');
                return;
            }
            if (!subject || !body.trim()) {
                setMsg(msg, 'Add a subject and a message.', 'is-bad');
                return;
            }
            setMsg(msg, 'Sending…', '');
            send.disabled = true;
            try {
                await call('sendLeadEmail', { to, subject, body, leadId: state.leadCompose.leadId || '' });
                // record that we made contact: stamp the date and nudge the stage forward
                const today = new Date().toISOString().slice(0, 10);
                leadDraft.lastContacted = today;
                if (leadDraft.stage === 'new') leadDraft.stage = 'contacted';
                const id = state.leadCompose.leadId;
                if (id && id !== '__new__') {
                    const { doc, setDoc } = fb.f;
                    await setDoc(
                        doc(fb.db, 'leads', id),
                        { lastContacted: today, stage: leadDraft.stage, updatedAt: Date.now() },
                        { merge: true }
                    );
                    const cur = (state.leads || []).find((x) => x.id === id);
                    if (cur) {
                        cur.lastContacted = today;
                        cur.stage = leadDraft.stage;
                    }
                    await leadLog(id, `Outreach email sent to ${to} — “${subject}”`);
                }
                state.leadCompose = null;
                render();
                const m2 = document.getElementById('lead-msg');
                setMsg(m2, 'Email sent.', 'is-ok');
            } catch (err) {
                setMsg(msg, (err && err.message) || 'Could not send.', 'is-bad');
                send.disabled = false;
            }
        });
}
