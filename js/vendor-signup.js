/* --------------------------------------------------------------------------
   Vendor signup

   One page, scrolled top to bottom: select event -> event info -> vendor
   type -> your details -> choose site -> review and pay.

   Nothing here decides anything that matters. Holding a site, checking a
   food category is not full, and marking a booking paid all happen in
   Cloud Functions. This file asks; the server answers.

   If js/firebase-config.js still has its placeholder values the page runs
   in PREVIEW mode: every screen works so the page can be reviewed, but
   nothing saves and payment is blocked.

   Contents
     1.  Settings
     2.  State
     3.  Prices
     4.  Boot and Firebase
     5.  Firestore REST (public reads without the SDK)
     6.  Events
     7.  Sold out and waitlist
     8.  Auth
     9.  Live event data
     10. Map and site holds
     11. Booking document
     12. Documents
     13. Sections, rail and scrolling
     14. Rendering
     15. Form wiring and validation
     16. Checkout and confirmation
     17. Helpers
   -------------------------------------------------------------------------- */

import { firebaseConfig, functionsRegion, eventId as defaultEventId, isFirebaseConfigured } from './firebase-config.js?v=843';

import { VendorMap, previewLayout, previewCategories } from './vendor-map.js?v=843';
import { termBodyHtml } from './terms-data.js?v=843';
import { VENDOR_TERMS, VENDOR_TERMS_INTRO, VENDOR_TERMS_OUTRO, VENDOR_TERMS_VERSION } from './vendor-terms-data.js?v=843';

/* ---------------------------------------------------------------- 1. Settings */

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

/* Ask for the event list the moment this script runs; loadEventsFast() picks it up. */
const EARLY_EVENTS =
    isFirebaseConfigured && !new URLSearchParams(location.search).has('preview') ? restList('events').catch(() => null) : null;

/* Display prices only - the server prices from the event document.
   A food van is a flat fee for its 6 m x 3 m site; a market stall is
   sold by the 3 m x 3 m bay, one to eight of them joined up. */
const PRICE = {
    foodCents: 10000,
    marketPerBayCents: 5000
};

const MAX_BAYS = 8;

/* Keep in step with feeBreakdown() in functions/index.js, which decides the real charge. */
const FEE_PERCENT = 0.04;
const FEE_FIXED_CENTS = 99;
const GST_RATE = 0.1;

const DESC_MAX = 300;

const VENDOR_LABEL = {
    food: 'Food Vendor',
    market: 'Market Stall'
};

const TYPE_WORD = { food: 'Food vans', market: 'Market stalls' };

/* The statuses a vendor may see (draft and archived are ours). Closed and
   coming-soon events still show; only canApply events take applications. */
const EVENT_STATUS = {
    open: { label: 'Accepting Vendors', tone: 'is-open', canApply: true },
    limited: { label: 'Limited Spots', tone: 'is-limited', canApply: true },
    closed: { label: 'Applications Closed', tone: 'is-closed', canApply: false },
    soon: { label: 'Coming Soon', tone: 'is-soon', canApply: false }
};

/* Posters for events with no card image set in admin. */
const EVENT_POSTERS = [
    {
        match: (ev) => /eatz/i.test(ev.name || '') && String(ev.dateISO || '').startsWith('2026-10-31'),
        url: '/images/events/eatz-beatz-halloween-2026-v3.webp'
    }
];

/* The page sections, in order. What you sell comes before the map, so a
   full category stops somebody before they get attached to a site. */
const SECTIONS = [
    { id: 'event', label: 'Select Event' },
    { id: 'info', label: 'Event Info' },
    { id: 'type', label: 'Vendor Type' },
    { id: 'details', label: 'Your Details' },
    { id: 'site', label: 'Choose Site' },
    { id: 'review', label: 'Review & Pay' }
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* Wait after the last tap on the map before holding, so a three-bay shape is one call. */
const HOLD_SETTLE_MS = 650;

/* Share links:
     /vendor-signup?event=<id>             opens with that event picked
     /vendor-signup?event=<id>&waitlist=1  ...and jumps to the waitlist form */
const LINK = new URLSearchParams(location.search);

/* Line-item icons on the review card. Inline so they take the text colour. */
const ITEM_ICONS = {
    food: `<svg viewBox="0 0 120 80" aria-hidden="true">
           <path d="M14 54V30h48l14 12v12z"/>
           <path d="M62 30h10l14 12H62z"/>
           <circle cx="34" cy="58" r="6"/>
           <circle cx="76" cy="58" r="6"/>
           <path d="M10 26h60l-4-8H14z"/>
         </svg>`,
    market: `<svg viewBox="0 0 120 80" aria-hidden="true">
             <path d="M18 34h84v30H18z"/>
             <path d="M14 18h92l10 16H4z"/>
             <path d="M34 44h24v20H34z"/>
           </svg>`
};

/* ------------------------------------------------------------------- 2. State */

const state = {
    eventId: null,
    event: null, // the chosen event document
    events: [],
    eventsLoaded: false, // the list has come back (it may still be empty)
    preview: !isFirebaseConfigured,

    vendorType: null,
    business: {},
    categoryId: null,
    categoryName: null,
    setup: {},
    documents: [],
    siteId: null,
    siteIds: [],
    siteLabel: null,

    bookingId: null,
    holdExpiresAt: null,
    user: null,
    confirmed: null
};

let fb = null; // Firebase handles once loaded
let fbReadyResolve;
const fbReady = new Promise((r) => {
    fbReadyResolve = r;
}); // resolves when fb is set

let map = null;
let categories = [];
let sitesUnsub = null;
let categoriesUnsub = null;

let holdCountdown = null; // the 1 s "held for m:ss" ticker
let holdSettleTimer = null; // the wait after the last tap
let holdInFlight = false;
let holdAgain = false; // the selection changed while a hold call was running

let signingIn = false;
let railOn = 'event'; // the section on screen, for the rail
let linkEventDone = false;
let linkWaitlistDone = false;

/* ------------------------------------------------------------------ 3. Prices */

/* Bays in a market stall: held first, then picked. Worked out, never stored,
   because a hold only lasts ten minutes. */
function bayCount() {
    if (state.vendorType !== 'market') return 1;
    return state.siteIds.length || pendingSites().length;
}

/* A site picked on the plan, or held. */
function hasSite() {
    return Boolean(state.siteId) || pendingSites().length > 0;
}

/* Nothing is owed until a site is chosen, even for a flat-fee food van. */
function priceCents() {
    if (!hasSite()) return 0;
    if (state.vendorType === 'food') return PRICE.foodCents;
    if (state.vendorType === 'market') return PRICE.marketPerBayCents * bayCount();
    return 0;
}

/* The price of what is picked on the plan right now (one bay before any is picked). */
function pendingPriceCents() {
    const n = pendingSites().length || 1;
    return state.vendorType === 'food' ? PRICE.foodCents : PRICE.marketPerBayCents * n;
}

/* fee = 4% of the site price + 99c; GST = 10% of (site + fee). A free site stays free. */
function feeBreakdown(siteCents) {
    const site = Math.max(0, Math.round(Number(siteCents) || 0));
    if (site === 0) {
        return { siteCents: 0, bookingFeeCents: 0, gstCents: 0, totalCents: 0 };
    }

    const bookingFeeCents = Math.round(site * FEE_PERCENT) + FEE_FIXED_CENTS;
    const gstCents = Math.round((site + bookingFeeCents) * GST_RATE);

    return {
        siteCents: site,
        bookingFeeCents,
        gstCents,
        totalCents: site + bookingFeeCents + gstCents
    };
}

/* Headline price: $100 when round, $115.49 when not. */
function money(cents) {
    if (cents === 0) return 'Free';
    return cents % 100 === 0 ? `$${(cents / 100).toFixed(0)}` : `$${(cents / 100).toFixed(2)}`;
}

/* Always two decimals, so breakdown figures line up. */
function exact(cents) {
    return `$${((cents || 0) / 100).toFixed(2)}`;
}

/* A dash when nothing is owed yet - "$0.00" would read as free. */
function exactOrDash(cents) {
    return cents ? exact(cents) : '&mdash;';
}

/* ------------------------------------------------------- 4. Boot and Firebase */

document.addEventListener('DOMContentLoaded', init);

async function init() {
    wireStaticControls();

    if (state.preview) {
        showPreviewBanner();
        startPreview();
        return;
    }

    // The map and event cards do not wait for Firebase.
    buildMap();
    loadEventsFast();

    try {
        fb = await loadFirebase();
        fbReadyResolve();
        watchAuth();
    } catch (err) {
        console.error('Firebase failed to start', err);
        state.preview = true;
        showPreviewBanner('Could not reach Firebase. Showing a preview only.');
        startPreview();
        return;
    }

    await handleReturnFromStripe();

    if (state.eventId) subscribeToEvent();

    render();
    if (!state.eventsLoaded) loadEvents(); // the quick way failed - use Firebase
}

/* App, auth and Firestore up front; storage and functions follow in the
   background - anything that uses them awaits fbMore() first. */
async function loadFirebase() {
    const [{ initializeApp }, auth, firestore] = await Promise.all([
        import(`${SDK}/firebase-app.js`),
        import(`${SDK}/firebase-auth.js`),
        import(`${SDK}/firebase-firestore.js`)
    ]);

    const app = initializeApp(firebaseConfig);

    const handles = {
        app,
        auth: auth.getAuth(app),
        db: firestore.getFirestore(app),
        a: auth,
        f: firestore
    };
    handles.more = Promise.all([import(`${SDK}/firebase-storage.js`), import(`${SDK}/firebase-functions.js`)]).then(
        ([storage, functions]) => {
            handles.storage = storage.getStorage(app);
            handles.s = storage;
            handles.fns = functions.getFunctions(app, functionsRegion);
            handles.fn = functions;
        }
    );
    return handles;
}

/* Wait for storage + functions (and Firebase itself, if a vendor is quick). */
async function fbMore() {
    if (!fb) await fbReady;
    await fb.more;
}

/* Call a Cloud Function by name. */
async function callFunction(name, data) {
    await fbMore();
    return fb.fn.httpsCallable(fb.fns, name)(data);
}

function startPreview() {
    categories = previewCategories();
    if (!map) buildMap();
    map.setLayout(previewLayout());
    render();
}

function showPreviewBanner(message) {
    const el = document.getElementById('vs-preview-banner');
    if (!el) return;
    if (message) {
        const p = el.querySelector('[data-preview-message]');
        if (p) p.textContent = message;
    }
    el.hidden = false;
}

/* ------------------------------------------ 5. Firestore REST (public reads) */

/* Firestore's REST answer -> plain values. Timestamps keep toMillis() so they
   behave like SDK timestamps. */
function restValue(v) {
    if (!v) return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return v.doubleValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('nullValue' in v) return null;
    if ('timestampValue' in v) {
        const ms = Date.parse(v.timestampValue);
        return { toMillis: () => ms, toDate: () => new Date(ms) };
    }
    if ('mapValue' in v) return restFields((v.mapValue && v.mapValue.fields) || {});
    if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(restValue);
    return null;
}

function restFields(fields) {
    const out = {};
    Object.keys(fields).forEach((k) => {
        out[k] = restValue(fields[k]);
    });
    return out;
}

async function restList(path) {
    const url =
        'https://firestore.googleapis.com/v1/projects/' +
        firebaseConfig.projectId +
        '/databases/(default)/documents/' +
        path +
        '?pageSize=500&key=' +
        firebaseConfig.apiKey;
    const res = await fetch(url);
    if (!res.ok) throw new Error('REST ' + res.status);
    const data = await res.json();
    return (data.documents || []).map((d) => ({ id: d.name.split('/').pop(), ...restFields(d.fields || {}) }));
}

/* ------------------------------------------------------------------ 6. Events */

/* The event cards without waiting for Firebase. If this fails, init() falls back to loadEvents(). */
async function loadEventsFast() {
    if (state.preview) return;
    try {
        const rows = (await EARLY_EVENTS) || (await restList('events'));
        if (state.eventsLoaded) return;
        showEvents(rows);
        loadSoldOutStickers((id) => restList('events/' + id + '/sites'));
    } catch (err) {
        console.warn('quick event list failed - using Firebase', err && err.message);
    }
}

/* Read once rather than watched: the list changes when we add an event,
   not while somebody is part way through a form. */
async function loadEvents() {
    if (state.preview) {
        showEvents([
            {
                id: defaultEventId,
                name: 'Eatz & Beatz',
                subtitle: 'Halloween Edition',
                dateLabel: 'Saturday 31 October 2026',
                dateISO: '2026-10-31',
                venue: 'Bowen Sports Complex',
                location: 'Bowen, Queensland',
                status: 'open'
            }
        ]);
        return;
    }

    try {
        const { collection, getDocs } = fb.f;
        const snap = await getDocs(collection(fb.db, 'events'));

        const rows = [];
        snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
        showEvents(rows);

        loadSoldOutStickers(async (id) => {
            const ss = await getDocs(collection(fb.db, 'events', id, 'sites'));
            const sites = [];
            ss.forEach((d) => sites.push(d.data()));
            return sites;
        });
    } catch (err) {
        console.error('events', err);

        // Loaded in the sense that waiting longer will not help - stops the skeleton.
        state.eventsLoaded = true;

        const host = document.getElementById('vs-events');
        if (host) {
            host.innerHTML =
                '<p class="vs-events-loading">Could not load the events just now. ' +
                'Please refresh, or email info@soundzgood.com.au.</p>';
        }
    }
}

/* Keep the vendor-visible events, soonest first, and draw them. */
function showEvents(rows) {
    state.events = rows
        .filter((ev) => EVENT_STATUS[ev.status])
        .sort((a, b) => String(a.dateISO || '').localeCompare(String(b.dateISO || '')));
    state.eventsLoaded = true;
    renderEvents();
    followEventLink();
}

/* Sold-out stickers for each open event, then redraw the cards. */
function loadSoldOutStickers(readSites) {
    Promise.all(
        state.events
            .filter((ev) => ev.status === 'open')
            .map(async (ev) => {
                try {
                    ev.soldOut = soldOutOf(await readSites(ev.id));
                } catch (e) {
                    /* no sticker */
                }
            })
    ).then(() => renderEvents());
}

function followEventLink() {
    if (linkEventDone || !LINK.get('event')) return;
    const ev = (state.events || []).find((e) => e.id === LINK.get('event'));
    if (!ev) return;
    linkEventDone = true;
    if (state.eventId !== ev.id) chooseEvent(ev.id);
}

function renderEvents() {
    const host = document.getElementById('vs-events');
    if (!host) return;

    if (!state.eventsLoaded) {
        host.innerHTML = '<p class="sr-only" role="status">Loading events&hellip;</p>' + eventSkeleton();
        return;
    }

    if (!state.events.length) {
        host.innerHTML = '<p class="vs-events-loading">No events are taking vendor applications ' + 'at the moment. Check back soon.</p>';
        return;
    }

    host.innerHTML = state.events.map(eventCard).join('');

    host.querySelectorAll('[data-share-event]').forEach((btn) => {
        btn.addEventListener('click', () => shareEvent(btn));
    });
    host.querySelectorAll('[data-choose-event]').forEach((btn) => {
        btn.addEventListener('click', () => chooseEvent(btn.getAttribute('data-choose-event')));
    });
}

/* Phone share sheet, or copy the link on a computer. */
async function shareEvent(btn) {
    const url = 'https://www.soundzgood.com.au/vendor-signup';
    const text = 'Market stalls are open for Eatz & Beatz Halloween Edition - Sat 31 Oct, Bowen Sports Complex. Food vans have sold out!';
    try {
        if (navigator.share) {
            await navigator.share({ title: 'Eatz & Beatz - market stalls', text, url });
            return;
        }
        await navigator.clipboard.writeText(url);
        btn.textContent = 'Link copied!';
        setTimeout(() => {
            btn.textContent = 'Share with other vendors';
        }, 2500);
    } catch (e) {
        if (e && e.name !== 'AbortError') window.prompt('Copy this link to share:', url);
    }
}

/* Three grey cards while loading, so the real ones land in place. */
function eventSkeleton() {
    return (
        '<article class="vs-event is-loading" aria-hidden="true">' +
        '<div class="vs-event-art"></div>' +
        '<div class="vs-event-body">' +
        '<span class="vs-skel vs-skel-title"></span>' +
        '<span class="vs-skel vs-skel-line"></span>' +
        '<span class="vs-skel vs-skel-line is-short"></span>' +
        '<span class="vs-skel vs-skel-btn"></span>' +
        '</div>' +
        '</article>'
    ).repeat(3);
}

/* The art attribute(s) for an event: its own image, a known poster, or a
   data-noart marker for the CSS to dress. */
function eventArt(ev) {
    if (ev && ev.image) {
        return ' style="--vs-ev-art:url(\'' + escapeHtml(/^(https?:|\/|data:)/.test(ev.image) ? ev.image : '/' + ev.image) + '\')"';
    }
    const p = ev && EVENT_POSTERS.find((x) => x.match(ev));
    if (p) return ' data-poster style="--vs-ev-art:url(\'' + escapeHtml(p.url) + '\')"';
    return ' data-noart';
}

function eventCard(ev) {
    const st = EVENT_STATUS[ev.status] || EVENT_STATUS.soon;
    const chosen = state.eventId === ev.id;

    const action = st.canApply
        ? '<button type="button" class="btn btn-ticket vs-event-go" ' +
          'data-choose-event="' +
          escapeHtml(ev.id) +
          '">' +
          (chosen ? 'Selected' : 'Apply for this event') +
          ' <span aria-hidden="true">&#8594;</span></button>'
        : '<span class="btn vs-event-go is-disabled" aria-disabled="true">' +
          (ev.status === 'soon' ? 'Applications open soon' : 'Applications closed') +
          '</span>';

    const share = st.canApply
        ? '<button type="button" class="btn vs-event-share" data-share-event="' + escapeHtml(ev.id) + '">Share with other vendors</button>'
        : '';

    return (
        '<article class="vs-event' +
        (chosen ? ' is-chosen' : '') +
        (st.canApply ? '' : ' is-shut') +
        '"' +
        eventArt(ev) +
        '>' +
        '<div class="vs-event-art" aria-hidden="true">' +
        '<span class="vs-event-status ' +
        st.tone +
        '">' +
        escapeHtml(st.label) +
        '</span>' +
        eventSticker(ev) +
        '</div>' +
        '<div class="vs-event-body">' +
        '<h3>' +
        escapeHtml(ev.name || ev.id) +
        '</h3>' +
        '<p class="vs-event-when">' +
        escapeHtml(ev.dateLabel || ev.dateISO || 'Date to be announced') +
        '</p>' +
        '<p class="vs-event-where">' +
        escapeHtml(ev.venue || ev.location || '') +
        '</p>' +
        (ev.subtitle ? '<p class="vs-event-blurb">' + escapeHtml(ev.subtitle) + '</p>' : '') +
        action +
        share +
        '</div>' +
        '</article>'
    );
}

/* Changing event after starting clears the part-filled application -
   a site and a food category belong to their event. */
function chooseEvent(id) {
    const ev = state.events.find((e) => e.id === id);
    if (!ev) return;

    if (state.eventId && state.eventId !== id) {
        const ok = window.confirm(
            'Start a new application for ' + (ev.name || id) + '?\n\n' + 'Anything filled in for the other event will be cleared.'
        );
        if (!ok) return;
        resetForNewEvent();
    }

    state.eventId = id;
    state.event = ev;

    if (!state.preview) subscribeToEvent();

    render();

    // The step straight after the cards, whatever it is.
    goToSection(SECTIONS[1].id);
}

/* Back to a blank application, still signed in. */
function resetForNewEvent() {
    stopEventListeners();

    state.bookingId = null;
    state.vendorType = null;
    state.categoryId = null;
    state.siteIds = [];
    state.siteId = null;
    state.confirmed = false;
    categories = [];
}

/* --------------------------------------------------- 7. Sold out and waitlist */

/* Free, or on a hold that has run out. */
function siteFree(site) {
    const st = site.status || 'available';
    if (st === 'available') return true;
    if (st === 'held') {
        const ms = timeInMs(site.holdExpiresAt);
        return ms !== null && ms <= Date.now();
    }
    return false;
}

/* A type is sold out when the event has sites of that type and none is free.
   Holds still running don't count (they may let go), except waitlist holds. */
function soldOutOf(sites) {
    const out = {};
    ['food', 'market'].forEach((t) => {
        const of = (sites || []).filter((x) => x.type === t);
        out[t] = of.length > 0 && !of.some((x) => siteFree(x) || (x.status === 'held' && !x.waitlistHold));
    });
    return out;
}

/* The type this visitor claimed from a waitlist email is never sold out to them. */
function isClaimedType(type) {
    return Boolean(state.claim && state.claim.vendorType === type);
}

function isSoldOut(type) {
    return Boolean((state.soldOut || {})[type]) && !isClaimedType(type);
}

function eventSticker(ev) {
    const so = (ev && ev.soldOut) || {};
    if (so.food && so.market) return '<span class="vs-event-sticker">Sold out</span>';

    let type = '';
    if (so.food) type = 'food';
    else if (so.market) type = 'market';

    return type ? '<span class="vs-event-sticker">' + TYPE_WORD[type] + '<br>sold out</span>' : '';
}

/* Stamp sold-out vendor-type cards and disable them; clear a sold-out
   choice unless the vendor already holds a site. */
function renderSoldOut() {
    document.querySelectorAll('[data-vendor-type]').forEach((btn) => {
        const out = isSoldOut(btn.getAttribute('data-vendor-type'));
        btn.classList.toggle('is-soldout', out);
        btn.disabled = out;
        btn.setAttribute('aria-disabled', out ? 'true' : 'false');
        let stamp = btn.querySelector('.vs-type-soldout');
        if (out && !stamp) {
            stamp = document.createElement('span');
            stamp.className = 'vs-type-soldout';
            stamp.textContent = 'Sold out';
            btn.appendChild(stamp);
        } else if (!out && stamp) {
            stamp.remove();
        }
    });

    if (state.vendorType && isSoldOut(state.vendorType) && !(state.siteIds && state.siteIds.length)) {
        state.vendorType = null;
        document.querySelectorAll('[data-vendor-type]').forEach((b) => b.classList.remove('is-selected'));
    }
    renderWaitlist();
}

/* A waitlist form under each sold-out type. When a spot opens the first
   person is emailed and gets 4 hours to claim it. */
function renderWaitlist() {
    const host = document.getElementById('vs-waitlist');
    if (!host) return;
    const types = ['food', 'market'].filter(isSoldOut);
    host.hidden = !types.length || !state.eventId;
    if (host.hidden) {
        host.innerHTML = '';
        return;
    }
    state.wlDone = state.wlDone || {};

    // Keep what someone is typing if the page redraws.
    if (host.querySelector('form') && types.every((t) => host.querySelector('[data-wl-type="' + t + '"]'))) return;

    host.innerHTML = types.map((t) => (state.wlDone[t] ? waitlistDoneCard(t) : waitlistForm(t))).join('');

    if (LINK.get('waitlist') && !linkWaitlistDone) {
        linkWaitlistDone = true;
        setTimeout(() => {
            const top = Math.max(0, host.getBoundingClientRect().top + window.scrollY - railHeight() - 20);
            window.scrollTo({ top, behavior: 'smooth' });
            setTimeout(() => {
                if (Math.abs(window.scrollY - top) > 40) window.scrollTo(0, top);
            }, 900); // jump if smooth scroll didn't happen
            const first = host.querySelector('input');
            if (first) first.focus({ preventScroll: true });
        }, 700);
    }
}

function waitlistDoneCard(type) {
    const position = state.wlDone[type];
    return (
        '<div class="vs-wl-card vs-wl-done" data-wl-type="' +
        type +
        '"><b>You&rsquo;re on the ' +
        TYPE_WORD[type].toLowerCase() +
        ' waitlist' +
        (position > 0 ? ' (#' + position + ')' : '') +
        '.</b>' +
        '<p>We&rsquo;ll email you the moment a spot opens. You&rsquo;ll have 4 hours to claim it, and it&rsquo;s yours once you pay.</p></div>'
    );
}

function waitlistForm(type) {
    return (
        '<form class="vs-wl-card" data-wl-type="' +
        type +
        '">' +
        '<b>' +
        TYPE_WORD[type] +
        ' are sold out &mdash; join the waitlist</b>' +
        '<p>If a spot opens we&rsquo;ll email you straight away. You&rsquo;ll have 4 hours to claim it.</p>' +
        '<div class="vs-wl-grid">' +
        '<label>Business name<input name="name" required autocomplete="organization"></label>' +
        '<label>Your name<input name="contactName" required autocomplete="name"></label>' +
        '<label>Email<input name="email" type="email" required autocomplete="email"></label>' +
        '<label>Phone<input name="phone" type="tel" autocomplete="tel"></label>' +
        '<label class="vs-wl-wide">What do you sell?<input name="description" maxlength="300"></label>' +
        '</div><button type="submit" class="btn">Join the waitlist</button><p class="vs-wl-msg" hidden></p></form>'
    );
}

async function joinWaitlist(form) {
    const t = form.getAttribute('data-wl-type');
    const v = (n) => (form.querySelector('[name="' + n + '"]') || {}).value || '';
    const msg = form.querySelector('.vs-wl-msg');
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
        if (!fb) throw new Error('Still getting set up - try again in a moment.');
        const res = await callFunction('joinWaitlist', {
            eventId: state.eventId,
            vendorType: t,
            name: v('name'),
            contactName: v('contactName'),
            email: v('email'),
            phone: v('phone'),
            description: v('description')
        });
        state.wlDone = state.wlDone || {};
        state.wlDone[t] = (res.data && res.data.position) || -1;
        const host = document.getElementById('vs-waitlist');
        if (host) host.innerHTML = '';
        renderWaitlist();
    } catch (err) {
        btn.disabled = false;
        if (msg) {
            msg.hidden = false;
            msg.textContent = (err && err.message) || 'Could not join the waitlist. Please try again.';
        }
    }
}

/* From the waitlist email: /vendor-signup?claim=<token>. The held site moves
   to this visitor, their details are filled in, and they book and pay as
   normal. The spot is only theirs once payment is received. */
async function claimFromWaitlist() {
    const token = new URLSearchParams(window.location.search).get('claim');
    if (!token || state.claimTried || !fb || !state.user) return;
    state.claimTried = true;
    try {
        const res = await callFunction('claimWaitlist', { token });
        const c = res.data;
        state.claim = c;

        // Wait for the events list, then open theirs.
        for (let i = 0; i < 40 && !(state.events || []).some((e) => e.id === c.eventId); i++) await new Promise((r) => setTimeout(r, 250));
        if (state.eventId !== c.eventId) chooseEvent(c.eventId);

        const fill = {
            'vs-biz-name': c.name,
            'vs-biz-contact': c.contactName,
            'vs-biz-email': c.email,
            'vs-biz-phone': c.phone,
            'vs-biz-desc': c.description
        };
        Object.keys(fill).forEach((id) => {
            const el = document.getElementById(id);
            if (el && !el.value && fill[id]) {
                el.value = fill[id];
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });

        renderSoldOut();
        const typeBtn = document.querySelector('[data-vendor-type="' + c.vendorType + '"]');
        if (typeBtn) {
            typeBtn.disabled = false;
            typeBtn.click();
        }

        const until = new Date(c.expiresAt).toLocaleString('en-AU', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: 'numeric',
            minute: '2-digit'
        });
        showClaimBanner(
            '<b>Your waitlist spot: site ' +
                escapeHtml(c.siteLabel) +
                '</b> is held for you until ' +
                escapeHtml(until) +
                '. Check your details, choose site ' +
                escapeHtml(c.siteLabel) +
                ' on the map and pay to secure it &mdash; it&rsquo;s only yours once payment is received.'
        );
    } catch (err) {
        showClaimBanner((err && err.message) || 'Sorry - this offer is no longer available.', true);
    }
}

function showClaimBanner(html, bad) {
    let el = document.getElementById('vs-claim-banner');
    if (!el) {
        el = document.createElement('div');
        el.id = 'vs-claim-banner';
        const main = document.querySelector('main') || document.body;
        main.insertBefore(el, main.firstChild);
    }
    el.className = 'vs-claim-banner' + (bad ? ' is-bad' : '');
    el.innerHTML = html;
}

/* -------------------------------------------------------------------- 8. Auth */

/* Nobody makes an account to pay. The browser signs in anonymously on load;
   the uid still drives Cloud Function auth, Firestore rules and site holds.
   That identity lives in this browser, so the reference number is shown at
   the end and staff can always find bookings in /admin. */
function watchAuth() {
    fb.a.onAuthStateChanged(fb.auth, (user) => {
        state.user = user;
        if (map) map.setUid(user ? user.uid : null);
        if (user) loadExistingBooking();
        render();
        if (user) claimFromWaitlist();

        if (!user) signInQuietly();
    });
}

async function signInQuietly() {
    if (signingIn) return;
    signingIn = true;

    try {
        await fb.a.signInAnonymously(fb.auth);
    } catch (err) {
        // Most likely anonymous sign-in is turned off on the project.
        console.error('anonymous sign-in failed', err);
        setStepError('site', 'Something went wrong getting you started. Please refresh and try again.');
    } finally {
        signingIn = false;
    }
}

/* --------------------------------------------------------- 9. Live event data */

/* Sites and categories belong to an event, so nothing is watched until one is chosen. */
function subscribeToEvent() {
    if (!fb || !state.eventId) return;
    subscribeSites();
    subscribeCategories();
}

function stopEventListeners() {
    if (sitesUnsub) {
        sitesUnsub();
        sitesUnsub = null;
    }
    if (categoriesUnsub) {
        categoriesUnsub();
        categoriesUnsub = null;
    }
}

function subscribeSites() {
    if (!fb) return;
    const { collection, onSnapshot, doc } = fb.f;

    // The event document: map size, landmarks and prices.
    onSnapshot(doc(fb.db, 'events', state.eventId), (snap) => {
        if (!snap.exists()) return;
        const ev = snap.data();
        state.event = ev;
        map.setLayout({
            mapSize: ev.map || { width: 1000, height: 700 },
            landmarks: ev.landmarks || []
        });
        paintEventPrices(ev);
    });

    sitesUnsub = onSnapshot(
        collection(fb.db, 'events', state.eventId, 'sites'),
        (snap) => {
            const sites = [];
            snap.forEach((d) => sites.push({ id: d.id, ...d.data() }));
            sites.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
            state.soldOut = soldOutOf(sites);
            if (state.event) state.event.soldOut = state.soldOut;
            renderSoldOut();
            renderPicked();
            map.setLayout({ sites });
            renderMapMeta();
            renderSiteChoice();
            renderSide();
            renderReview();
        },
        (err) => console.error('sites listener', err)
    );
}

function subscribeCategories() {
    if (!fb) return;
    const { collection, onSnapshot } = fb.f;

    categoriesUnsub = onSnapshot(
        collection(fb.db, 'events', state.eventId, 'categories'),
        (snap) => {
            categories = [];
            snap.forEach((d) => categories.push({ id: d.id, ...d.data() }));
            categories.sort((a, b) => a.name.localeCompare(b.name));
            renderCategories();
        },
        (err) => console.error('categories listener', err)
    );
}

/* The event's own prices into any [data-price] slot in the markup. */
function paintEventPrices(ev) {
    if (!ev.pricing) return;

    const shown = {
        food: ev.pricing.food,
        'market-bay': ev.pricing.marketPerBay
    };

    document.querySelectorAll('[data-price]').forEach((el) => {
        const cents = shown[el.getAttribute('data-price')];
        if (cents != null) el.textContent = money(cents);
    });
}

/* ----------------------------------------------------- 10. Map and site holds */

function buildMap() {
    const host = document.getElementById('vs-map');
    if (!host) return;

    map = new VendorMap(host, {
        maxBays: MAX_BAYS,
        // Taps build the shape on screen; the hold follows shortly after the tapping stops.
        onSelect: () => {
            renderSiteChoice();
            renderMapMeta();
            renderSide();
            renderReview();
            scheduleHoldSync();
        }
    });

    if (state.user) map.setUid(state.user.uid);
}

function renderMapMeta() {
    const legend = document.getElementById('vs-map-counts');
    if (!legend || !map) return;

    if (!state.vendorType) {
        legend.textContent = '';
        return;
    }

    const c = map.counts();
    const parts = [`${c.openNow} open now`];
    if (c.notYetOpen) parts.push(`${c.notYetOpen} open later`);
    if (c.mine) parts.push(`${c.mine} held by you`);

    legend.textContent = parts.join(' · ');
}

/* What is lit up on the plan. */
function pendingSites() {
    return map ? map.selectedSites() : [];
}

function pendingLabel() {
    return pendingSites()
        .map((s) => s.label)
        .join(' + ');
}

/* The bays this booking is for: held wins, otherwise what is lit up.
   So a vendor who reloads still sees the stall's size. */
function chosenSites() {
    if (state.siteIds.length && map) {
        const held = state.siteIds.map((id) => map.byId.get(id)).filter(Boolean);
        if (held.length) return held;
    }
    return pendingSites();
}

/* Frontage and depth in metres when the bays make a rectangle (3 m each);
   null for anything else, such as an L. */
function stallRectangle(bays) {
    if (!bays.length) return null;

    const columns = new Set(bays.map((b) => b.x)).size;
    const rows = new Set(bays.map((b) => b.y)).size;
    if (columns * rows !== bays.length) return null;

    return { frontage: rows * 3, depth: columns * 3 };
}

/* "6 m x 3 m", or '' for a shape with no simple size. */
function marketFootprint(bays) {
    const rect = stallRectangle(bays);
    return rect ? `${rect.frontage} m x ${rect.depth} m` : '';
}

function sizeSuffix(size) {
    return size ? ' · ' + size : '';
}

function sameIds(a, b) {
    return a.length === b.length && a.every((id, i) => id === b[i]);
}

function scheduleHoldSync() {
    clearTimeout(holdSettleTimer);
    holdSettleTimer = setTimeout(syncHold, HOLD_SETTLE_MS);
}

/* Run the pending hold now, so Continue straight after a tap cannot race it. */
async function flushHoldSync() {
    clearTimeout(holdSettleTimer);
    await syncHold();
}

/* Make the hold match the plan. Changes made during a call are picked up by
   a re-run at the end, so the last thing tapped is what ends up held. */
async function syncHold() {
    if (holdInFlight) {
        holdAgain = true;
        return;
    }

    const want = pendingSites().map((site) => site.id);
    const have = state.siteIds.slice();

    if (sameIds(want, have)) return;

    holdInFlight = true;
    try {
        if (want.length) await holdChosenSites();
        else await releaseHeldSites();
    } finally {
        holdInFlight = false;
        if (holdAgain) {
            holdAgain = false;
            await syncHold();
        }
    }
}

/* One call for the whole group, so the server allocates them together or not at all. */
async function holdChosenSites() {
    const chosen = pendingSites();
    if (!chosen.length) return;

    // Save the form first, so a vendor who leaves after taking a site keeps their details.
    collectForm();

    const ids = chosen.map((s) => s.id);

    if (state.preview) {
        state.siteId = ids[0];
        state.siteIds = ids;
        state.siteLabel = pendingLabel();
        renderSiteChoice();
        return;
    }

    if (!state.user) {
        setStepError('site', 'Still getting set up - give it a second and try again.');
        signInQuietly();
        return;
    }

    setBusy('site', true);
    setStepError('site', '');

    try {
        await ensureBookingDoc();
        await saveDraft();

        const res = await callFunction('holdSite', { eventId: state.eventId, siteIds: ids, bookingId: state.bookingId });

        state.siteIds = res.data.siteIds || ids;
        state.siteId = state.siteIds[0];
        state.siteLabel = res.data.siteLabel;
        state.holdExpiresAt = res.data.holdExpiresAt;

        map.setSelected(state.siteIds);
        startHoldCountdown();
        renderSiteViews();
    } catch (err) {
        setStepError('site', friendlyError(err));
    } finally {
        setBusy('site', false);
    }
}

/* Every bay tapped off again: give them back rather than holding an
   abandoned shape for the full ten minutes. */
async function releaseHeldSites() {
    const ids = state.siteIds.slice();
    if (!ids.length) return;

    if (state.preview || !state.user || !fb) {
        forgetHold();
        return;
    }

    setBusy('site', true);
    try {
        // A failed release is not worth stopping them over: the hold runs out on its own.
        await callFunction('releaseHold', { eventId: state.eventId, siteIds: ids }).catch((err) => {
            console.warn('Could not release the hold', err);
        });
        forgetHold();
    } finally {
        setBusy('site', false);
    }
}

function clearHeldSite() {
    state.siteId = null;
    state.siteIds = [];
    state.siteLabel = null;
    state.holdExpiresAt = null;
}

function forgetHold() {
    clearHeldSite();
    stopHoldCountdown();
    renderSiteViews();
}

/* Everything that shows the held site. */
function renderSiteViews() {
    renderSiteChoice();
    renderSide();
    renderReview();
    renderRail();
}

function startHoldCountdown() {
    stopHoldCountdown();
    const el = document.getElementById('vs-hold-timer');
    if (!el || !state.holdExpiresAt) return;

    const tick = () => {
        const left = state.holdExpiresAt - Date.now();

        if (left <= 0) {
            clearHeldSite();
            map.setSelected(null);

            // Stop first: stopHoldCountdown clears the line this writes.
            stopHoldCountdown();
            el.textContent = 'Your hold has expired. Choose a site again.';
            el.classList.add('is-expired');

            renderSiteViews();
            return;
        }

        const mins = Math.floor(left / 60000);
        const secs = Math.floor((left % 60000) / 1000);
        el.textContent = `Site held for ${mins}:${String(secs).padStart(2, '0')}`;
        el.classList.remove('is-expired');
    };

    tick();
    holdCountdown = setInterval(tick, 1000);
}

function stopHoldCountdown() {
    if (holdCountdown) clearInterval(holdCountdown);
    holdCountdown = null;

    const el = document.getElementById('vs-hold-timer');
    if (el) {
        el.textContent = '';
        el.classList.remove('is-expired');
    }
}

/* ------------------------------------------------------- 11. Booking document */

function readBooking(id) {
    const { doc, getDoc } = fb.f;
    return getDoc(doc(fb.db, 'bookings', id));
}

async function ensureBookingDoc() {
    if (state.bookingId) return state.bookingId;

    const { collection, addDoc, serverTimestamp } = fb.f;

    const ref = await addDoc(collection(fb.db, 'bookings'), {
        uid: state.user.uid,
        eventId: state.eventId,
        vendorType: state.vendorType,
        bayCount: bayCount(),
        business: state.business,
        categoryId: state.categoryId,
        setup: state.setup,
        documents: state.documents,
        status: 'draft',
        paymentStatus: 'none',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    });

    state.bookingId = ref.id;
    localStorage.setItem('sg-vendor-booking', ref.id);
    return ref.id;
}

async function saveDraft() {
    if (state.preview || !fb || !state.user || !state.bookingId) return;

    const { doc, updateDoc, serverTimestamp } = fb.f;

    await updateDoc(doc(fb.db, 'bookings', state.bookingId), {
        vendorType: state.vendorType,
        bayCount: bayCount(),
        business: state.business,
        categoryId: state.categoryId,
        setup: state.setup,
        documents: state.documents,
        updatedAt: serverTimestamp()
    });
}

/* Pick up this browser's unfinished booking (or show it confirmed). */
async function loadExistingBooking() {
    const saved = localStorage.getItem('sg-vendor-booking');
    if (!saved || !fb) return;

    try {
        const snap = await readBooking(saved);
        if (!snap.exists()) return;

        const b = snap.data();
        if (b.uid !== state.user.uid) return;

        if (b.status === 'confirmed') {
            state.confirmed = { id: snap.id, ...b };
            showConfirmation();
            return;
        }

        state.bookingId = snap.id;

        // The event first - everything else in the booking belongs to it.
        if (b.eventId && b.eventId !== state.eventId) {
            state.eventId = b.eventId;
            state.event = state.events.find((e) => e.id === b.eventId) || null;

            if (!state.event) {
                // The event list may not have landed yet, so read this one directly.
                try {
                    const { doc, getDoc } = fb.f;
                    const evSnap = await getDoc(doc(fb.db, 'events', b.eventId));
                    if (evSnap.exists()) state.event = { id: evSnap.id, ...evSnap.data() };
                } catch (evErr) {
                    console.warn('Could not read the event for a restored booking', evErr);
                }
            }

            subscribeToEvent();
        }

        state.vendorType = b.vendorType || state.vendorType;
        state.business = b.business || {};
        state.categoryId = b.categoryId || null;
        state.setup = b.setup || {};
        state.documents = b.documents || [];
        state.siteId = b.siteId || null;
        state.siteIds = b.siteIds || (b.siteId ? [b.siteId] : []);
        state.siteLabel = b.siteLabel || null;

        if (map) {
            map.setVendorType(state.vendorType);
            map.setSelected(state.siteIds);
        }

        fillFormFromState();
        render();
    } catch (err) {
        console.warn('Could not restore booking', err);
    }
}

/* Write a restored booking back into the form. Only empty fields are filled,
   so nothing the vendor has already typed is overwritten. Category chips
   light up from state.categoryId whenever the categories arrive. */
function fillFormFromState() {
    const put = (id, value) => {
        const el = document.getElementById(id);
        if (el && !el.value && value) el.value = value;
    };

    const b = state.business || {};
    put('vs-biz-name', b.name);
    put('vs-biz-contact', b.contactName);
    put('vs-biz-email', b.email);
    put('vs-biz-phone', b.phone);
    put('vs-biz-socials', b.socials);
    put('vs-biz-desc', b.description);

    const setup = state.setup || {};
    put('vs-setup-frontage', setup.frontage);
    put('vs-setup-depth', setup.depth);
    put('vs-setup-own-power', setup.ownPower);
    put('vs-setup-notes', setup.notes);

    const faqs = document.getElementById('vs-setup-faqs');
    if (faqs && setup.readFaqs) faqs.checked = true;

    // The vendor type decides the price, so its card must show as chosen.
    document.querySelectorAll('[data-vendor-type]').forEach((btn) => {
        btn.classList.toggle('is-selected', btn.getAttribute('data-vendor-type') === state.vendorType);
    });

    // Setting .value does not fire input, so update the counter by hand.
    renderDescCount();
}

/* -------------------------------------------------------------- 12. Documents */

async function uploadDocument(file, docType) {
    if (state.preview) {
        state.documents.push({
            type: docType,
            name: file.name,
            size: file.size,
            preview: true
        });
        renderDocumentList();
        return;
    }

    if (!state.user) {
        setStepError('documents', 'Still getting set up - give it a second and try again.');
        signInQuietly();
        return;
    }

    const maxBytes = 10 * 1024 * 1024;
    if (file.size > maxBytes) {
        setStepError('documents', `${file.name} is larger than 10 MB.`);
        return;
    }

    if (file.type !== 'application/pdf' && !file.type.startsWith('image/')) {
        setStepError('documents', 'Please upload a PDF or an image.');
        return;
    }

    setBusy('documents', true);
    setStepError('documents', '');

    try {
        await fbMore();
        const { ref, uploadBytes, getDownloadURL } = fb.s;
        const safeName = file.name.replace(/[^\w.-]+/g, '_');
        const path = `vendor-documents/${state.user.uid}/${Date.now()}-${safeName}`;
        const storageRef = ref(fb.storage, path);

        await uploadBytes(storageRef, file, { contentType: file.type });
        const url = await getDownloadURL(storageRef);

        state.documents.push({
            type: docType,
            name: file.name,
            size: file.size,
            path,
            url,
            uploadedAt: Date.now()
        });

        await ensureBookingDoc();
        await saveDraft();
        renderDocumentList();
    } catch (err) {
        setStepError('documents', friendlyError(err));
    } finally {
        setBusy('documents', false);
    }
}

function renderDocumentList() {
    const list = document.getElementById('vs-doc-list');
    if (!list) return;

    if (!state.documents.length) {
        list.innerHTML = '<li class="vs-doc-empty">No documents added yet.</li>';
        return;
    }

    list.innerHTML = state.documents
        .map(
            (d, i) => `
    <li class="vs-doc">
      <span class="vs-doc-type">${escapeHtml(d.type)}</span>
      <span class="vs-doc-name">${escapeHtml(d.name)}</span>
      <span class="vs-doc-size">${formatSize(d.size)}</span>
      <button type="button" class="vs-link" data-remove-doc="${i}">Remove</button>
    </li>
  `
        )
        .join('');

    list.querySelectorAll('[data-remove-doc]').forEach((btn) => {
        btn.addEventListener('click', () => {
            state.documents.splice(Number(btn.getAttribute('data-remove-doc')), 1);
            renderDocumentList();
            saveDraft();
        });
    });
}

/* -------------------------------------------- 13. Sections, rail and scrolling */

/* Has this section got what it needs? Read live from the fields so the rail
   keeps up with the typing. */
function sectionDone(id) {
    const ticked = (elId) => !!document.getElementById(elId)?.checked;

    switch (id) {
        case 'event':
        case 'info': // nothing to fill in, so done once an event is chosen
            return !!state.eventId;

        case 'type':
            return !!state.vendorType;

        case 'details':
            return (
                !!val('vs-biz-name') &&
                !!val('vs-biz-contact') &&
                EMAIL_RE.test(val('vs-biz-email')) &&
                !!val('vs-biz-phone') &&
                !!state.categoryId &&
                (state.vendorType === 'market' || (!!val('vs-setup-frontage') && !!val('vs-setup-depth'))) &&
                !!val('vs-setup-own-power') &&
                ticked('vs-setup-faqs')
            );

        case 'site':
            return !!state.siteId;

        case 'review':
            return !!state.confirmed;

        default:
            return false;
    }
}

function railHeight() {
    const rail = document.getElementById('vs-rail');
    return rail ? rail.getBoundingClientRect().height : 0;
}

/* Scroll a section to just under the sticky rail. */
function goToSection(id) {
    const el = document.getElementById('sec-' + id);
    if (!el) return;

    const clear = railHeight() + 14;
    const top = el.getBoundingClientRect().top + window.scrollY - clear;

    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

/* Open the event details and FAQs panel and go to it. */
function openFaqs() {
    const panel = document.getElementById('vs-picked-more');
    const btn = document.querySelector('.vs-picked-more-btn');

    if (panel && panel.hidden) {
        panel.hidden = false;
        if (btn) {
            btn.classList.add('is-open');
            btn.setAttribute('aria-expanded', 'true');
        }
    }

    goToSection('info');
}

/* The sticky step rail: ticked when a section is complete, highlighted for
   the one on screen. It reports; it does not lock. */
function renderRail() {
    const host = document.getElementById('vs-rail');
    if (!host) return;

    host.innerHTML =
        '<ol class="vs-rail-list">' +
        SECTIONS.map((sec, i) => {
            const done = sectionDone(sec.id);
            const here = sec.id === railOn;

            return (
                '<li class="' +
                (done ? 'is-done ' : '') +
                (here ? 'is-here' : '') +
                '">' +
                '<button type="button" data-rail="' +
                sec.id +
                '">' +
                '<span class="vs-rail-num">' +
                (done ? '&#10003;' : i + 1) +
                '</span>' +
                '<span class="vs-rail-label">' +
                sec.label +
                '</span>' +
                '</button>' +
                '</li>'
            );
        }).join('') +
        '</ol>';

    host.querySelectorAll('[data-rail]').forEach((btn) => {
        btn.addEventListener('click', () => goToSection(btn.getAttribute('data-rail')));
    });
}

/* The section on screen is the last one whose top has crossed a third of the way down. */
function watchScroll() {
    let queued = false;

    const check = () => {
        queued = false;
        const line = window.innerHeight / 3;
        let here = SECTIONS[0].id;

        SECTIONS.forEach((sec) => {
            const el = document.getElementById('sec-' + sec.id);
            if (el && el.getBoundingClientRect().top <= line) here = sec.id;
        });

        if (here !== railOn) {
            railOn = here;
            renderRail();
        }
    };

    window.addEventListener(
        'scroll',
        () => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(check);
        },
        { passive: true }
    );

    check();
}

/* --------------------------------------------------------------- 14. Rendering */

function render() {
    if (state.confirmed) return;

    // Everything after choosing an event belongs to that event, so it is locked until one is chosen.
    const chosen = !!state.eventId;
    document.querySelectorAll('.vs-sec').forEach((el) => {
        if (el.getAttribute('data-sec') === 'event') return;
        el.classList.toggle('is-locked', !chosen);
    });

    renderEvents();
    renderPicked();
    renderSide();
    renderRail();
    if (!chosen) return;

    renderCategories();
    renderSizeFields();
    if (map) map.setVendorType(state.vendorType);
    renderSiteChoice();
    renderMapMeta();
    renderDocumentList();
    renderReview();
}

function onFormChange() {
    renderSide();
    renderRail();
}

/* The chosen event, under the cards, with the two prices and the power situation. */
function renderPicked() {
    const wrap = document.getElementById('vs-picked');
    const head = document.getElementById('vs-picked-head');
    if (!wrap || !head) return;

    const ev = state.event;
    if (!ev || !state.eventId) {
        wrap.hidden = true;
        return;
    }

    const soldOut = state.soldOut || {};

    wrap.hidden = false;
    head.innerHTML =
        '<span class="vs-picked-art"' +
        eventArt(ev) +
        ' aria-hidden="true">' +
        '<span class="vs-picked-tick">&#10003;</span>' +
        '</span>' +
        '<div class="vs-picked-what">' +
        '<p class="vs-picked-label">Selected event</p>' +
        '<strong>' +
        escapeHtml(ev.name || state.eventId) +
        '</strong>' +
        '<span class="vs-picked-when">' +
        escapeHtml(ev.dateLabel || ev.dateISO || '') +
        '</span>' +
        '<span class="vs-picked-where">' +
        escapeHtml(ev.venue || ev.location || '') +
        '</span>' +
        '</div>' +
        '<div class="vs-picked-fact">' +
        '<p class="vs-picked-label">Food vendor</p>' +
        (soldOut.food ? '<strong class="vs-soldout-word">Sold out</strong>' : '<strong>' + money(PRICE.foodCents) + ' / bay</strong>') +
        '<span>6 m &times; 3 m per bay</span>' +
        '</div>' +
        '<div class="vs-picked-fact">' +
        '<p class="vs-picked-label">Market stall</p>' +
        (soldOut.market
            ? '<strong class="vs-soldout-word">Sold out</strong>'
            : '<strong>' + money(PRICE.marketPerBayCents) + ' / bay</strong>') +
        '<span>3 m &times; 3 m per bay<br>(up to 8 adjoining bays)</span>' +
        '</div>' +
        '<div class="vs-picked-fact">' +
        '<p class="vs-picked-label">Power / water</p>' +
        '<span>No power or water supplied.<br>Generators recommended.</span>' +
        '</div>' +
        '<button type="button" class="vs-picked-more-btn" data-more>' +
        'Event details &amp; FAQs <span aria-hidden="true">&#9662;</span>' +
        '</button>';

    const btn = head.querySelector('[data-more]');
    const more = document.getElementById('vs-picked-more');
    if (btn && more) {
        btn.addEventListener('click', () => {
            more.hidden = !more.hidden;
            btn.classList.toggle('is-open', !more.hidden);
            btn.setAttribute('aria-expanded', String(!more.hidden));
        });
    }
}

/* "Your application" down the side: event, vendor type, site and what it comes to. */
function renderSide() {
    const host = document.getElementById('vs-chosen');
    if (!host) return;

    const ev = state.event;

    if (!ev || !state.eventId) {
        host.innerHTML =
            '<h3 class="vs-side-head">Your application</h3>' +
            '<p class="vs-side-empty">Choose an event above and your booking will ' +
            'build up here as you go.</p>';
        return;
    }

    const b = feeBreakdown(priceCents());

    const bays = bayCount();
    const siteLine = state.vendorType === 'market' ? 'Market stall × ' + bays + ' bay' + (bays > 1 ? 's' : '') : 'Food vendor site';

    const typeRow = state.vendorType
        ? '<strong>' +
          escapeHtml(VENDOR_LABEL[state.vendorType] || '') +
          '</strong>' +
          '<span>' +
          (state.vendorType === 'food'
              ? money(PRICE.foodCents) + ' &middot; 6 m &times; 3 m'
              : money(PRICE.marketPerBayCents) + ' per bay') +
          '</span>'
        : '<span class="vs-side-wait">Not chosen yet</span>';

    const siteRow = state.siteLabel
        ? '<strong>' + escapeHtml(state.siteLabel) + '</strong>' + '<span>Held for you while you finish.</span>'
        : '<span class="vs-side-wait">Not selected yet</span>' + '<span>Choose your site on the map below.</span>';

    // Itemised, so vendors see which line is the site, which is the fee and which is tax.
    const breakdown = b.totalCents
        ? '<div class="vs-side-sum">' +
          '<div>' +
          '<span>' +
          escapeHtml(siteLine) +
          '</span>' +
          '<span>' +
          exact(b.siteCents) +
          '</span>' +
          '</div>' +
          '<div>' +
          '<span>Booking fee <em>4% + $0.99</em></span>' +
          '<span>' +
          exact(b.bookingFeeCents) +
          '</span>' +
          '</div>' +
          '<div>' +
          '<span>GST <em>(10%)</em></span>' +
          '<span>' +
          exact(b.gstCents) +
          '</span>' +
          '</div>' +
          '</div>'
        : '';

    // A total of nothing says why, or it reads as free.
    const finePrint = b.totalCents
        ? ''
        : '<p class="vs-side-fineprint">' +
          (!state.vendorType ? 'Choose a vendor type to see your total' : 'Choose your site to see your total') +
          '</p>';

    host.innerHTML =
        '<div class="vs-side-top">' +
        '<h3 class="vs-side-head">Your application</h3>' +
        '<button type="button" class="vs-side-change" data-change-event>Edit event</button>' +
        '</div>' +
        '<div class="vs-side-card">' +
        '<span class="vs-side-art"' +
        eventArt(ev) +
        ' aria-hidden="true"></span>' +
        '<span class="vs-side-card-text">' +
        '<strong>' +
        escapeHtml(ev.name || state.eventId) +
        '</strong>' +
        '<span>' +
        escapeHtml(ev.dateLabel || ev.dateISO || '') +
        '</span>' +
        '<span>' +
        escapeHtml(ev.venue || ev.location || '') +
        '</span>' +
        '</span>' +
        '</div>' +
        '<div class="vs-side-row">' +
        '<p class="vs-side-label">Vendor type</p>' +
        typeRow +
        '</div>' +
        '<div class="vs-side-row">' +
        '<p class="vs-side-label">Site selection</p>' +
        siteRow +
        '</div>' +
        breakdown +
        '<div class="vs-side-total">' +
        '<span>Total</span>' +
        '<strong>' +
        exactOrDash(b.totalCents) +
        '</strong>' +
        '</div>' +
        finePrint +
        '<button type="button" class="btn vs-side-go" data-side-go>' +
        'Continue to next step <span aria-hidden="true">&#8594;</span>' +
        '</button>' +
        '<p class="vs-side-hold">' +
        'Your site is held for 10 minutes once selected. Complete your ' +
        'application and payment to confirm.' +
        '</p>';

    const change = host.querySelector('[data-change-event]');
    if (change) change.addEventListener('click', () => goToSection('event'));

    // Always points at the first thing still to do.
    const go = host.querySelector('[data-side-go]');
    if (go) {
        const next = SECTIONS.find((sec) => !sectionDone(sec.id)) || SECTIONS[SECTIONS.length - 1];
        go.addEventListener('click', () => goToSection(next.id));
    }
}

/* Frontage and depth are a food van question; a market stall's size is the bays it picks. */
function renderSizeFields() {
    const market = state.vendorType === 'market';

    document.querySelectorAll('[data-size-field]').forEach((el) => {
        el.hidden = market;

        // Not required while hidden, or the form refuses to submit over a field nobody can see.
        el.querySelectorAll('select').forEach((sel) => {
            sel.required = !market;
        });
    });

    const note = document.getElementById('vs-setup-note');
    if (note) {
        note.textContent = market
            ? 'What you are running on. Your size comes from the bays you pick.'
            : 'The size you need on the ground, and what you are running on.';
    }
}

/* Category chips for the chosen vendor type; a full one cannot be picked. */
function renderCategories() {
    const host = document.getElementById('vs-categories');
    if (!host) return;

    const mine = categories.filter((c) => c.appliesTo === state.vendorType);

    const heading = document.getElementById('vs-category-heading');
    if (heading) {
        heading.textContent = state.vendorType === 'market' ? 'What do you sell?' : 'Your food category';
    }

    if (!categories.length) {
        host.innerHTML = '<p class="vs-muted">Loading categories…</p>';
        return;
    }

    if (!mine.length) {
        host.innerHTML = '<p class="vs-muted">No categories set up for this vendor type yet.</p>';
        return;
    }

    host.innerHTML = mine
        .map((c) => {
            const full = (c.count || 0) >= c.limit;
            const selected = state.categoryId === c.id;

            return `
      <button type="button"
              class="vs-category ${full ? 'is-full' : ''} ${selected ? 'is-selected' : ''}"
              data-category="${escapeHtml(c.id)}"
              ${full && !selected ? 'disabled aria-disabled="true"' : ''}>
        <span class="vs-category-name">${escapeHtml(c.name)}</span>
        <span class="vs-category-count">${c.count || 0} / ${c.limit}</span>
        ${full ? '<span class="vs-category-full">FULL</span>' : ''}
      </button>
    `;
        })
        .join('');

    host.querySelectorAll('[data-category]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-category');
            const cat = mine.find((c) => c.id === id);
            state.categoryId = id;
            state.categoryName = cat ? cat.name : null;
            renderCategories();
            setStepError('category', '');
        });
    });
}

/* The line under the map. Site fee only: the fee and GST are the same
   whichever site they pick, and the review spells out the whole lot. */
function renderSiteChoice() {
    const out = document.getElementById('vs-site-choice');
    if (!out) return;

    const chosen = pendingSites();
    const held = Boolean(state.siteLabel);
    const sameAsHeld = held && chosen.map((s) => s.id).join(',') === state.siteIds.join(',');

    if (sameAsHeld) {
        out.textContent = `Held for you: site ${state.siteLabel} · ${money(priceCents())} site fee`;
    } else if (chosen.length) {
        const n = chosen.length;
        const size =
            state.vendorType === 'market' ? ` (${n} bay${n > 1 ? 's' : ''}${sizeSuffix(marketFootprint(chosen))})` : ' (6 m x 3 m)';
        out.textContent = `Picked: ${pendingLabel()}${size} · ${money(pendingPriceCents())} site fee`;
    } else if (held) {
        out.textContent = `Held for you: site ${state.siteLabel}`;
    } else {
        out.textContent =
            state.vendorType === 'market'
                ? `Tap the bays you want - they are held as you pick. Take up to ${MAX_BAYS} joined together for a bigger stall.`
                : 'Tap the site you want - it is held as soon as you do.';
    }

    out.classList.toggle('is-chosen', sameAsHeld || chosen.length > 0);
}

/* "Site M11" / "Sites M12 + M13", or a generic name before a site is chosen. */
function reviewItemName(named, bays, isMarket) {
    if (named) return `Site${bays > 1 ? 's' : ''} ${named}`;
    return isMarket ? 'Market bay' : 'Food vendor site';
}

/* No site is not a price, so it shows a dash; free is a price an admin set. */
function totalToPayHtml(b) {
    if (!hasSite()) return '&mdash;';
    if (b.totalCents === 0) return 'Free';
    return exact(b.totalCents);
}

function payButtonText(b) {
    if (!hasSite()) return 'Pay and Book';
    if (b.totalCents === 0) return 'Confirm booking';
    return `Pay ${exact(b.totalCents)} AUD`;
}

/* The review step: what you are buying, what it costs, and who takes the money. */
function renderReview() {
    const host = document.getElementById('vs-review');
    if (!host) return;

    const b = feeBreakdown(priceCents());
    const ev = state.event || {};
    const isMarket = state.vendorType === 'market';
    const bays = bayCount();

    // Priced per bay so the sum shows: 2 x $50.00 = $100.00.
    const perBay = bays > 1 ? Math.round(b.siteCents / bays) : b.siteCents;

    const named = state.siteLabel || pendingLabel();
    const itemName = reviewItemName(named, bays, isMarket);

    const measured = isMarket ? marketFootprint(chosenSites()) : '6 m x 3 m';

    const itemSub = named
        ? [isMarket ? `Market bay${bays > 1 ? 's' : ''}` : 'Food vendor site', measured, state.categoryName]
              .filter(Boolean)
              .map(escapeHtml)
              .join(' &middot; ')
        : 'No site chosen yet';

    const eventLine = [ev.name || 'Eatz & Beatz', ev.dateLabel].filter(Boolean).map(escapeHtml).join(' &middot; ');

    const details = [
        ['Business', state.business.name],
        ['Contact', state.business.contactName],
        ['Email', state.business.email],
        ['Phone', state.business.phone],
        ['Social media', state.business.socials],
        ['Frontage', state.setup.frontage ? `${state.setup.frontage} m` : ''],
        ['Depth', state.setup.depth ? `${state.setup.depth} m` : ''],
        ['Power', state.setup.ownPower],
        ['FAQs', state.setup.readFaqs ? 'Read' : ''],
        ['Documents', state.documents.length ? `${state.documents.length} attached` : '']
    ].filter(([, v]) => v);

    host.innerHTML = `
    <div class="vs-checkout">

      <!-- WHAT YOU ARE BUYING -->
      <section class="vs-card">
        <header class="vs-card-head">
          <h3>Your Booking</h3>
          <button type="button" class="vs-pill" data-scroll-to="details">
            <svg viewBox="0 0 24 24" aria-hidden="true" class="vs-pill-ico">
              <path d="M4 20h4l10-10-4-4L4 16z"/>
              <path d="M14 6l4 4 2-2-4-4z"/>
            </svg>
            Edit booking
          </button>
        </header>

        ${eventLine ? `<p class="vs-card-sub">${eventLine}</p>` : ''}

        <div class="vs-lineitem">
          <span class="vs-lineitem-ico" aria-hidden="true">
            ${ITEM_ICONS[state.vendorType] || ITEM_ICONS.food}
          </span>
          <span class="vs-lineitem-txt">
            <strong>${escapeHtml(itemName)}</strong>
            <span>${itemSub}</span>
          </span>
        </div>

        <dl class="vs-figures">
          <div><dt>Price</dt><dd>${exactOrDash(perBay)}</dd></div>
          <div><dt>Qty</dt><dd>${bays || '&mdash;'}</dd></div>
          <div><dt>Total</dt><dd class="is-strong">${exactOrDash(b.siteCents)}</dd></div>
        </dl>
      </section>

      <!-- WHAT IT COSTS -->
      <section class="vs-card">
        <h3>Price Summary</h3>

        <dl class="vs-sum">
          <div><dt>Site total</dt><dd>${exactOrDash(b.siteCents)}</dd></div>
          <div>
            <dt>Booking fee
              <button type="button" class="vs-info" data-info
                      aria-expanded="false" aria-label="What is the booking fee?">i</button>
            </dt>
            <dd>${exactOrDash(b.bookingFeeCents)}</dd>
          </div>
          <div><dt>GST (10%)</dt><dd>${exactOrDash(b.gstCents)}</dd></div>
        </dl>

        <p class="vs-info-note" data-info-note hidden>
          4% of the site price plus 99c, which covers the card processing and
          running the booking system. It is charged once, not per bay.
        </p>

        <div class="vs-sum-total">
          <span>Total to pay</span>
          <strong>${totalToPayHtml(b)}</strong>
        </div>
      </section>

      <!-- WHO TAKES THE MONEY -->
      <section class="vs-card vs-secure">
        <div class="vs-secure-head">
          <span class="vs-secure-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M7 10V7a5 5 0 0110 0v3" fill="none" stroke="currentColor" stroke-width="2"/>
              <rect x="4" y="10" width="16" height="10" rx="2"/>
            </svg>
          </span>
          <span>
            <strong>Secure payment via Stripe</strong>
            <span>Your information is encrypted and secure.</span>
          </span>
        </div>

        <ul class="vs-secure-row">
          <li><span aria-hidden="true">&#128737;</span> Safe &amp; secure</li>
          <li><span aria-hidden="true">&#128179;</span> All major cards</li>
          <li><span aria-hidden="true">&#127807;</span> Supports local events</li>
        </ul>
      </section>

      ${
          details.length
              ? `
        <details class="vs-card vs-yourdetails">
          <summary>Your details<span>${details.length} items</span></summary>
          <dl class="vs-summary-list">
            ${details
                .map(
                    ([k, v]) => `
              <div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`
                )
                .join('')}
          </dl>
        </details>`
              : ''
      }

      <p class="vs-checkout-foot">
        Questions? The event details and the ones vendors usually ask are on
        <button type="button" class="vs-help-link" data-open-faqs>event info &amp; FAQs</button>.
      </p>
    </div>
  `;

    // Rebuilt on every render, so wired here rather than in wireStaticControls.
    host.querySelectorAll('[data-scroll-to]').forEach((btn) => {
        btn.addEventListener('click', () => goToSection(btn.getAttribute('data-scroll-to')));
    });

    host.querySelectorAll('[data-open-faqs]').forEach((btn) => {
        btn.addEventListener('click', openFaqs);
    });

    // The (i) beside the booking fee opens a line of text (a tooltip is unreachable on a phone).
    const info = host.querySelector('[data-info]');
    const note = host.querySelector('[data-info-note]');
    if (info && note) {
        info.addEventListener('click', () => {
            note.hidden = !note.hidden;
            info.setAttribute('aria-expanded', String(!note.hidden));
        });
    }

    const payBtn = document.getElementById('vs-pay');
    if (payBtn) {
        payBtn.textContent = payButtonText(b);
        payBtn.disabled = !termsAgreed(); // grey until the Vendor Terms are ticked
    }
}

/* Every [data-terms-body] slot gets the Vendor Terms. */
function renderVendorTerms() {
    const html =
        termBodyHtml(VENDOR_TERMS_INTRO, escapeHtml) +
        VENDOR_TERMS.map(([title, lines], i) => `<h4>${i + 1}. ${escapeHtml(title)}</h4>` + termBodyHtml(lines, escapeHtml)).join('') +
        termBodyHtml(VENDOR_TERMS_OUTRO, escapeHtml);
    document.querySelectorAll('[data-terms-body]').forEach((el) => {
        el.innerHTML = html;
    });
}

/* "N/300" under "What do you sell?". */
function renderDescCount() {
    const desc = document.getElementById('vs-biz-desc');
    const count = document.getElementById('vs-biz-desc-count');
    if (desc && count) count.textContent = desc.value.length + '/' + DESC_MAX;
}

/* ---------------------------------------------- 15. Form wiring and validation */

function wireStaticControls() {
    // The waitlist forms (drawn by renderWaitlist).
    const wl = document.getElementById('vs-waitlist');
    if (wl) {
        wl.addEventListener('submit', (e) => {
            e.preventDefault();
            joinWaitlist(e.target);
        });
    }

    // Vendor type. No jump: the page re-renders where it stands.
    document.querySelectorAll('[data-vendor-type]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const vt = btn.getAttribute('data-vendor-type');
            if (isSoldOut(vt)) return;
            state.vendorType = vt;

            document.querySelectorAll('[data-vendor-type]').forEach((b) => {
                b.classList.toggle('is-selected', b === btn);
            });

            setStepError('type', '');
            if (map) map.setVendorType(state.vendorType);
            render();
        });
    });

    // Continue: check this section, keep what is in it, scroll to the next.
    document.querySelectorAll('[data-go]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const sec = btn.closest('.vs-sec');
            const from = sec ? sec.getAttribute('data-sec') : null;

            // A bay tapped just before Continue is held now, not after the settle timer.
            if (from === 'site') await flushHoldSync();

            if (from && !validateSection(from)) return;

            collectForm();
            saveDraft();
            renderSide();
            goToSection(btn.getAttribute('data-go'));
        });
    });

    // One listener on the whole form keeps the rail and side column in step with typing.
    const form = document.getElementById('vs-flow');
    if (form) {
        form.addEventListener('input', onFormChange);
        form.addEventListener('change', onFormChange);
    }

    // Documents.
    const fileInput = document.getElementById('vs-file');
    if (fileInput) {
        fileInput.addEventListener('change', () => {
            const type = document.getElementById('vs-doc-type');
            const files = Array.from(fileInput.files || []);
            files.forEach((f) => uploadDocument(f, type ? type.value : 'Document'));
            fileInput.value = '';
        });
    }

    // The FAQs link inside the "I have read the FAQs" label must not toggle the checkbox.
    document.querySelectorAll('.vs-check [data-open-faqs]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openFaqs();
        });
    });

    // The description is capped at DESC_MAX characters, with a live counter.
    const desc = document.getElementById('vs-biz-desc');
    const count = document.getElementById('vs-biz-desc-count');
    if (desc && count) {
        const tick = () => {
            if (desc.value.length > DESC_MAX) desc.value = desc.value.slice(0, DESC_MAX);
            renderDescCount();
        };
        desc.addEventListener('input', tick);
        tick();
    }

    watchScroll();

    // Pay and the Vendor Terms.
    const payBtn = document.getElementById('vs-pay');
    if (payBtn) payBtn.addEventListener('click', payAndBook);
    renderVendorTerms();

    const termsBox = document.getElementById('vs-terms-ok');
    if (termsBox) {
        termsBox.addEventListener('change', () => {
            syncPayButton();
            if (termsAgreed()) setStepError('review', '');
        });
    }

    document.querySelectorAll('[data-open-terms]').forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openTerms(link);
        });
    });

    // The hero button jumps to the form.
    document.querySelectorAll('[data-start]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const anchor = document.getElementById('vs-flow');
            if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
}

/* Open the terms nearest the link: the review step has its own copy;
   anywhere else uses the one in the FAQs panel. */
function openTerms(link) {
    if (link.closest('[data-sec="review"]')) {
        const reviewBox = document.getElementById('vs-terms-box2');
        if (reviewBox) {
            reviewBox.open = true;
            reviewBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return;
    }

    openFaqs();
    const box = document.getElementById('vs-terms-box');
    if (box) {
        box.open = true;
        setTimeout(() => box.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    }
}

/* Form fields -> state. */
function collectForm() {
    state.business = {
        name: val('vs-biz-name'),
        contactName: val('vs-biz-contact'),
        email: val('vs-biz-email'),
        phone: val('vs-biz-phone'),
        socials: val('vs-biz-socials'),
        description: val('vs-biz-desc')
    };

    // A market stall's size is measured from its bays; an L-shape has none and is left blank.
    let frontage = val('vs-setup-frontage');
    let depth = val('vs-setup-depth');

    if (state.vendorType === 'market') {
        const rect = stallRectangle(chosenSites());
        frontage = rect ? String(rect.frontage) : '';
        depth = rect ? String(rect.depth) : '';
    }

    state.setup = {
        frontage,
        depth,
        ownPower: val('vs-setup-own-power'), // what they bring - no power is supplied
        readFaqs: document.getElementById('vs-setup-faqs')?.checked || false,
        notes: val('vs-setup-notes')
    };
}

/* Check a section, show what is missing, and say whether it passed. */
function validateSection(id) {
    if (id === 'type') {
        setStepError('type', '');
        if (!state.vendorType) {
            setStepError('type', 'Please choose a vendor type.');
            return false;
        }
        return true;
    }

    // Checked in page order; the first thing missing is scrolled to.
    if (id === 'details') {
        setStepError('details', '');
        setStepError('category', '');
        setStepError('setup', '');

        const name = val('vs-biz-name');
        const contact = val('vs-biz-contact');
        const email = val('vs-biz-email');
        const phone = val('vs-biz-phone');

        if (!name || !contact || !email || !phone) {
            return fail('details', 'Please fill in business name, contact, email and phone.', 'vs-biz-name');
        }
        if (!EMAIL_RE.test(email)) {
            return fail('details', 'That email address does not look right.', 'vs-biz-email');
        }
        if (!state.categoryId) {
            return fail('category', 'Please choose a category.', 'vs-categories');
        }
        if (state.vendorType !== 'market' && (!val('vs-setup-frontage') || !val('vs-setup-depth'))) {
            return fail('setup', 'Please choose your frontage and depth.', 'vs-setup-frontage');
        }
        if (!val('vs-setup-own-power')) {
            return fail('setup', 'Please tell us what power you are bringing.', 'vs-setup-own-power');
        }

        const ack = document.getElementById('vs-setup-faqs');
        if (ack && !ack.checked) {
            return fail('setup', 'Please confirm you have read the frequently asked questions.', 'vs-setup-faqs');
        }
        return true;
    }

    if (id === 'site') {
        setStepError('site', '');
        if (!state.siteId) {
            setStepError('site', 'Please choose a site on the map.');
            return false;
        }
        return true;
    }

    if (id === 'event') return !!state.eventId;

    return true;
}

/* For the pay button: nobody is forced through the sections in order. */
function firstIncomplete() {
    return ['type', 'details', 'site'].find((id) => !validateSection(id)) || null;
}

/* Show the problem and take the vendor to the field it is about. */
function fail(where, message, focusId) {
    setStepError(where, message);

    const el = document.getElementById(focusId);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    }

    return false;
}

/* ------------------------------------------------ 16. Checkout and confirmation */

/* createCheckout refuses without the terms too (functions/index.js). */
function termsAgreed() {
    const box = document.getElementById('vs-terms-ok');
    return !!(box && box.checked);
}

function syncPayButton() {
    const payBtn = document.getElementById('vs-pay');
    if (payBtn) payBtn.disabled = !termsAgreed();
}

async function payAndBook() {
    if (state.preview) {
        setStepError('review', 'Preview mode - payments are switched off until Firebase and Stripe are connected.');
        return;
    }

    if (!termsAgreed()) {
        setStepError('review', 'Please tick the box to agree to the Vendor Terms & Conditions.');
        return;
    }

    // Say what is missing beside the pay button as well as on its step, then go there.
    const missing = firstIncomplete();
    if (missing) {
        const label = (SECTIONS.find((sec) => sec.id === missing) || {}).label || 'an earlier step';
        setStepError('review', 'Finish ' + label + ' first - we have highlighted what is missing.');
        goToSection(missing);
        return;
    }

    setStepError('review', '');
    collectForm();
    setBusy('review', true);

    try {
        await saveDraft();

        const res = await callFunction('createCheckout', {
            bookingId: state.bookingId,
            termsAccepted: true,
            termsVersion: VENDOR_TERMS_VERSION
        });

        if (res.data.free || res.data.alreadyConfirmed) {
            await refreshConfirmed();
            return;
        }

        if (res.data.url) {
            window.location.assign(res.data.url);
            return;
        }

        setStepError('review', 'Could not start checkout. Please try again.');
    } catch (err) {
        setStepError('review', friendlyError(err));
    } finally {
        setBusy('review', false);
    }
}

/* Back from Stripe, paid or cancelled. The redirect is only a hint: the
   booking is not treated as paid until the webhook has written it. The
   event is read off the booking first so its sites and categories load. */
async function handleReturnFromStripe() {
    const params = new URLSearchParams(window.location.search);
    const bookingId = params.get('booking');

    if (!bookingId) return;

    state.bookingId = bookingId;
    localStorage.setItem('sg-vendor-booking', bookingId);

    if (fb) {
        try {
            const snap = await readBooking(bookingId);
            if (snap.exists()) {
                const b = snap.data();
                if (b.eventId) state.eventId = b.eventId;
            }
        } catch (err) {
            console.error('could not read the booking on return', err);
        }
    }

    if (params.get('cancelled')) {
        setStepError('review', 'Checkout was cancelled. Your site is still held for a few minutes.');
        goToSection('review');
        return;
    }

    if (params.get('paid')) {
        showWaitingForPayment();
        pollForConfirmation(bookingId);
    }
}

/* Hide the form sections and the side column. */
function hideFlow() {
    document.querySelectorAll('.vs-sec').forEach((el) => {
        el.hidden = true;
    });
    document.querySelector('.vs-side')?.setAttribute('hidden', '');
}

function showWaitingForPayment() {
    const el = document.getElementById('vs-confirming');
    if (el) el.hidden = false;
    hideFlow();
}

/* Poll every 3 s; after about a minute, say it is safe to leave. */
async function pollForConfirmation(bookingId, attempt = 0) {
    if (!fb) return;

    try {
        const snap = await readBooking(bookingId);
        const status = snap.exists() ? snap.data().status : null;

        if (status === 'confirmed') {
            state.confirmed = { id: snap.id, ...snap.data() };
            showConfirmation();
            return;
        }

        if (status === 'needs_attention') {
            const el = document.getElementById('vs-confirming');
            if (el) {
                el.innerHTML = `
          <h2>We need to sort something out</h2>
          <p>Your payment went through, but the site was taken while you were
             paying. Nothing further is needed from you right now - we will be
             in touch to move you to another site or refund you.</p>
          <p><a class="btn" href="/contact">Contact SoundzGood</a></p>`;
            }
            return;
        }
    } catch (err) {
        console.warn('Still waiting on the webhook', err);
    }

    if (attempt < 20) {
        setTimeout(() => pollForConfirmation(bookingId, attempt + 1), 3000);
        return;
    }

    const note = document.querySelector('#vs-confirming [data-confirming-note]');
    if (note) {
        note.textContent =
            'This is taking longer than usual. Your payment is safe and your ' +
            'booking will be confirmed by email. You can close this page.';
    }
}

async function refreshConfirmed() {
    const snap = await readBooking(state.bookingId);
    if (snap.exists()) {
        state.confirmed = { id: snap.id, ...snap.data() };
        showConfirmation();
    }
}

function paidLabel(b) {
    if (b.amountPaidCents != null) return '$' + (b.amountPaidCents / 100).toFixed(2);
    return b.paymentStatus === 'free' ? 'Free' : '-';
}

function showConfirmation() {
    const wrap = document.getElementById('vs-confirmed');
    const confirming = document.getElementById('vs-confirming');

    if (confirming) confirming.hidden = true;
    hideFlow();

    if (!wrap) return;
    const b = state.confirmed || {};

    wrap.hidden = false;
    wrap.innerHTML = `
    <div class="vs-confirm-card">
      <p class="vs-eyebrow">Booking confirmed</p>
      <h2>You're in.</h2>
      <p class="vs-confirm-ref">Reference <strong>${escapeHtml(b.reference || b.id || '')}</strong></p>

      <dl class="vs-summary-list">
        <div><dt>Vendor</dt><dd>${escapeHtml(b.business?.name || '')}</dd></div>
        <div><dt>Type</dt><dd>${escapeHtml(VENDOR_LABEL[b.vendorType] || b.vendorType || '')}</dd></div>
        ${b.categoryName ? `<div><dt>Category</dt><dd>${escapeHtml(b.categoryName)}</dd></div>` : ''}
        <div><dt>Site</dt><dd>${escapeHtml(b.siteLabel || '')}</dd></div>
        <div><dt>Paid</dt><dd>${paidLabel(b)}</dd></div>
      </dl>

      <p class="vs-confirm-note">
        Eatz &amp; Beatz Halloween Edition &middot; Saturday 31 October 2026 &middot;
        Bowen Sports Complex. We'll email your bump-in time and site details closer
        to the date.
      </p>

      <div class="buttons">
        <a class="btn" href="/events">Back to Events</a>
        <a class="btn btn-outline" href="/contact">Contact Us</a>
      </div>
    </div>
  `;
}

/* ----------------------------------------------------------------- 17. Helpers */

function val(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
}

/* A Firestore timestamp or a number -> ms, or null. */
function timeInMs(t) {
    if (t && typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t === 'number') return t;
    return null;
}

/* Show (or clear) the message in [data-error="<step>"]; warn if the slot is missing. */
function setStepError(step, message) {
    const el = document.querySelector(`[data-error="${step}"]`);

    if (!el) {
        if (message) console.warn(`No [data-error="${step}"] to show: ${message}`);
        return;
    }

    el.textContent = message || '';
    el.hidden = !message;
}

/* Show the section's spinner and disable its buttons, so nothing starts twice. */
function setBusy(step, busy) {
    const el = document.querySelector(`[data-busy="${step}"]`);
    if (el) el.hidden = !busy;

    const sec = document.querySelector(`.vs-sec[data-sec="${step}"]`);
    if (sec) {
        sec.querySelectorAll('button').forEach((b) => {
            b.disabled = busy;
        });
    }
}

function friendlyError(err) {
    const code = (err && (err.code || err.message)) || '';

    if (code.includes('already-exists')) return err.message;
    if (code.includes('resource-exhausted')) return err.message;
    if (code.includes('invalid-email')) return 'That email address does not look right.';
    if (code.includes('permission-denied')) return 'You do not have permission to do that.';

    // The silent anonymous sign-in has not landed, so the advice is to refresh.
    if (code.includes('unauthenticated') || code.includes('admin-restricted-operation')) {
        return 'Lost your place for a moment. Please refresh the page and try again.';
    }

    return (err && err.message) || 'Something went wrong. Please try again.';
}

function formatSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* The shared escape helper from js/main.js (loaded first on this page). */
function escapeHtml(value) {
    return window.SG.esc(value);
}

/* Tidy up listeners if the page is left. */
window.addEventListener('beforeunload', () => {
    stopEventListeners();
    stopHoldCountdown();
});
