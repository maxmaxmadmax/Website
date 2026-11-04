/* SOUNDZGOOD ADMIN - core.js
   The page itself: state, sign-in, Firebase, the router, render() and the shared helpers.
   A plain script: every admin file shares one page scope, loaded in order by admin.html. */
'use strict';

/* --------------------------------------------------------------------------
   SOUNDZGOOD ADMIN
   One page, one script, no framework. Views are plain functions that return
   markup and then wire up their own listeners; the address bar hash
   remembers which view is open.

   SECURITY: only accounts with the admin custom claim get past the gate,
   and the Firestore rules and Cloud Functions check the same claim server
   side.

   Collections read (the same ones the public signup page writes):
       events/{eventId}                    the event
       events/{eventId}/sites/{siteId}     the 50 sites
       events/{eventId}/categories/{id}    limits and live counts
       bookings/{bookingId}                one per vendor application
   Allocation and money only change through the admin Cloud Functions.
   -------------------------------------------------------------------------- */

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

/* -------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */
const state = {
    user: null,
    view: 'vendors',

    activeEventId: defaultEventId,

    events: [],
    bookings: [],

    /*  The roster and the schedule, for the Entertainment view. Loaded on
      arrival there rather than kept in sync everywhere.             */
    talent: [],
    schedule: [],
    gigCrew: {}, // bookingId -> { crewAssigned } (private, gigCrew/)

    /*  The bookings desk: which month the calendar is on, which booking the
      panel is showing, whether it is being edited, and the filters under
      the table.                                                       */
    bookMonth: new Date(),
    bookingOpen: null,
    bookEditing: false,
    bookDraft: {},
    bookFilter: { text: '', tab: 'upcoming' },
    sites: [],
    categories: [],

    /* per-view scratch, kept here so switching away and back remembers it */
    filters: {
        search: '',
        status: 'all',
        vendorType: 'all',
        payment: 'all'
    },

    openBookingId: null,
    openSiteId: null,
    editingEvent: null,
    noteDraft: '',
    addingVendor: false,
    ready: false,

    /*  The equipment inventory / price list. Loaded live so the Inventory
      page and the bot never disagree. null until first load.            */
    inventory: null,
    openInvId: null, // which item's detail is open
    invFilter: { search: '', category: 'all', location: 'all', status: 'all' },
    invPage: 1,
    openSysId: null, // the Kit / Package builder: null | '__new__' | an inventory id
    invDates: null, // { from, to } 'yyyy-mm-dd' for the On hire / Left columns (null = today)
    invSort: { key: '', dir: 'asc' }, // '' = default (category, then name)

    /*  Quotes / invoices. quoteDocs streams in live; openQuoteId is null on
      the list, an id (or '__new__') when the builder is open.            */
    quoteDocs: [],
    openQuoteId: null,
    spFilter: { tab: 'all', search: '', dates: 'all', sort: 'created', sortDir: 'desc' }, // Sales Pipeline list

    /*  Packages - reusable bundles the bot will draw on. null until first
      load; openPackageId is null on the list, an id (or '__new__') in the
      editor.                                                              */
    packages: null,
    openPackageId: null,
    pkgFilter: 'all',
    pkgSearch: '',
    pkgTab: 'details',
    pkgTierSel: 0,

    /*  Crew & vehicles - staff / vehicle / trailer records, billable onto a
      quote. null until first load.                                        */
    resources: null,
    openResourceId: null,
    openCustomerId: null,
    custSearch: '',
    custType: 'all',
    resFilter: 'all',
    resSearch: '',

    /*  Leads - the gig lead generator. null until first load; openLeadId is
      null on the list, an id (or '__new__') in the editor. leadCompose holds
      the email draft while the composer is open.                          */
    leads: null,
    openLeadId: null,
    leadFilter: 'all',
    leadTypeFilter: 'all',
    leadCatFilter: 'all',
    leadGrokFilter: 'all',
    leadContactFilter: 'all',
    leadRegionFilter: 'all',
    leadSizeFilter: 'all',
    leadMonth: '', // 'YYYY-MM' picked on the calendar strip, '' = any
    leadWeek: '', // ISO week picked on the strip, e.g. '2026-W39', '' = any
    leadCalOffset: 0, // months the strip is scrolled from this month
    leadSearch: '',
    leadCompose: null,
    leadTab: 'overview', // side-panel tab: overview / details / contacts / outreach / notes
    leadChip: 'all', // quick-filter chip: all / high / medium / low / inplay / won / lost / needs
    leadRange: 'all', // Showing: all / next12 / next3 / month / nodate / past
    leadSort: 'date', // Sort column: date / priority / value / name / location / category / stage / last / updated
    leadSortDir: '', // 'asc' / 'desc'; '' = that column's natural direction
    leadPage: 1,
    leadPerPage: 10,
    quoteFromLeadId: '' // set while a quote started from a lead is unsaved
};

let fb = null;
const unsubscribes = [];

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', init);

async function init() {
    if (!isFirebaseConfigured) {
        showLoginError('Firebase is not connected. Fill in js/site/firebase-config.js.');
        return;
    }

    fb = await loadFirebase();
    wireChrome();

    fb.a.onAuthStateChanged(fb.auth, async (user) => {
        if (!user) return showGate();

        const token = await user.getIdTokenResult(true);
        if (token.claims.admin !== true) {
            showLoginError('That account is not an admin.');
            await fb.a.signOut(fb.auth);
            return;
        }

        state.user = user;
        showApp(user);
        await loadEvents();
        subscribeToEvent();
        subscribeToInventory();
        subscribeToQuoteDocs();
        subscribeToReminders();
        subscribeToPackages();
        subscribeToResources();
        subscribeToCustomers();
        subscribeToLeads();
        subscribeToScout();
        routeFromHash();
    });
}

async function loadFirebase() {
    const [{ initializeApp }, auth, firestore, functions, storage] = await Promise.all([
        import(`${SDK}/firebase-app.js`),
        import(`${SDK}/firebase-auth.js`),
        import(`${SDK}/firebase-firestore.js`),
        import(`${SDK}/firebase-functions.js`),
        import(`${SDK}/firebase-storage.js`)
    ]);

    const app = initializeApp(firebaseConfig);
    return {
        auth: auth.getAuth(app),
        db: firestore.getFirestore(app),
        fns: functions.getFunctions(app, functionsRegion),
        storage: storage.getStorage(app),
        a: auth,
        f: firestore,
        fn: functions,
        st: storage
    };
}

/*  The act types, in the order they are offered. Same keys the
    entertainment page uses.                                            */
const ACT_LABELS = {
    dj: 'DJ',
    solo: 'Solo Artist',
    band: 'Band',
    mc: 'MC / Host',
    kids: 'Kids Entertainment'
};

function prettyDate(iso) {
    const p = String(iso || '').split('-');
    if (p.length !== 3) return iso || '';
    return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString('en-AU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric'
    });
}

/*  The roster as the site sees it: the built-in list in js/data/roster.js with
    whatever is saved in Firestore merged over it. Read through roster.js
    rather than queried here, so the desk and the site can never disagree
    about who is on the books.                                          */
async function loadTalent() {
    try {
        /*  Re-fetched rather than reused, so an act added a minute ago appears. */
        const { collection, getDocs } = fb.f;
        const snap = await getDocs(collection(fb.db, 'talent'));

        const saved = {};
        snap.forEach((doc) => {
            saved[doc.id] = doc.data();
        });

        const bySlug = {};
        (window.SG_ROSTER_BUILT_IN || []).forEach((t) => {
            bySlug[t.slug] = { ...t };
        });

        Object.keys(saved).forEach((slug) => {
            const t = saved[slug];
            if (t.hidden) {
                delete bySlug[slug];
                return;
            }
            bySlug[slug] = {
                slug,
                name: t.name || slug,
                act: t.act || (bySlug[slug] || {}).act || 'dj',
                photo: t.photo || (bySlug[slug] || {}).photo || '',
                bio: t.bio || '', // shown on their gig quotes
                female: t.female === true // Female DJs filter on the website
            };
        });

        state.talent = Object.keys(bySlug).map((k) => bySlug[k]);
        // Lucas's bio - put in once, his to edit after
        const lucas = state.talent.find((x) => x.slug === 'lucas');
        if (lucas && !lucas.bio && !(saved.lucas && saved.lucas.bioSeeded) && !state.lucasSeeded) {
            state.lucasSeeded = true;
            const bio =
                'Bringing international party energy, this New Caledonian DJ blends Reggaeton, Baile Funk, Moombahton, Dancehall, Hip-Hop and R&B into vibrant, feel-good sets.\n\nNow based in Australia, his open-format style is a natural fit for backpacker bars, beach parties and Latin-inspired nights—bringing travellers and locals together on the dance floor.\n\n🇳🇨 New Caledonia roots • 🇦🇺 Australia based';
            fb.f
                .setDoc(fb.f.doc(fb.db, 'talent', 'lucas'), { bio, bioSeeded: true }, { merge: true })
                .then(() => {
                    lucas.bio = bio;
                })
                .catch(() => {});
        }
    } catch (err) {
        state.talent = (window.SG_ROSTER_BUILT_IN || []).slice();
    }
}

/*  PUB NIGHTS: DJ rates (private - talent/ is public) and the regular
    nights. Loaded with the roster. */
async function loadPubSettings() {
    try {
        const { collection, getDocs } = fb.f;
        const [rates, nights, fees, venues, accom] = await Promise.all([
            getDocs(collection(fb.db, 'actRates')),
            getDocs(collection(fb.db, 'regularNights')),
            getDocs(collection(fb.db, 'travelFees')),
            getDocs(collection(fb.db, 'venues')),
            fb.f.getDoc(fb.f.doc(fb.db, 'djSettings', 'accommodation'))
        ]);
        state.accomPlaces = accom.exists() && Array.isArray(accom.data().places) ? accom.data().places : [];
        /*  SAVED VENUES: each one gets its own tab on Gigs and shows in the
        booking form's venue list. Seeded with Arcadia Bar the first time. */
        state.venues = snapRows(venues);
        if (!venues.size && !state.venuesSeeded) {
            state.venuesSeeded = true;
            const { doc, setDoc } = fb.f;
            const v = { name: 'Arcadia Bar', town: 'Mackay', createdAt: Date.now() };
            await setDoc(doc(fb.db, 'venues', 'arcadia-bar-mackay'), v);
            state.venues.push({ id: 'arcadia-bar-mackay', ...v });
        }
        if (!state.venues.some((v) => /grand view/i.test(v.name || '')) && !state.gvSeeded) {
            state.gvSeeded = true;
            const { doc, setDoc } = fb.f;
            const gv = { name: 'Grand View Hotel', town: 'Bowen', createdAt: Date.now() };
            setDoc(doc(fb.db, 'venues', 'grand-view-hotel-bowen'), gv).catch(() => {});
            state.venues.push({ id: 'grand-view-hotel-bowen', ...gv });
        }
        state.venues.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        state.travelFees = snapRows(fees);
        // first-time default fees - then they're his to change
        if (!fees.size && !state.travelSeeded) {
            state.travelSeeded = true;
            const { doc, setDoc } = fb.f;
            const seed = [
                ['airlie-bowen', 'Airlie Beach', 'Bowen', 8000],
                ['mackay-bowen', 'Mackay', 'Bowen', 15000],
                ['townsville-bowen', 'Townsville', 'Bowen', 15000]
            ];
            await Promise.all(
                seed.map(([id, from, to, cents]) => setDoc(doc(fb.db, 'travelFees', id), { from, to, cents, createdAt: Date.now() }))
            );
            seed.forEach(([id, from, to, cents]) => state.travelFees.push({ id, from, to, cents }));
        }
        state.actRates = {};
        rates.forEach((d) => {
            state.actRates[d.id] = d.data();
        });
        // each DJ's town onto their public card, once a session
        if (!state.locSynced) {
            state.locSynced = true;
            Object.keys(state.actRates).forEach((slug) => {
                const loc = String(state.actRates[slug].location || '').trim();
                const g = publicStyles(state.actRates[slug].styles);
                if (loc || g.length)
                    fb.f
                        .setDoc(
                            fb.f.doc(fb.db, 'talent', slug),
                            { ...(loc ? { location: loc.slice(0, 80) } : {}), ...(g.length ? { genres: g } : {}) },
                            { merge: true }
                        )
                        .catch(() => {});
            });
        }
        try {
            const fs2 = await getDocs(collection(fb.db, 'djSettings'));
            state.djFee = {};
            fs2.forEach((d) => {
                if (d.id === 'fee') state.djFee = d.data();
            });
        } catch (e) {
            state.djFee = {};
        }
        // a fee saved with the old wording is moved over once
        if (state.djFee && /^Booking, coordination/.test(state.djFee.name || '') && !state.feeRenamed) {
            state.feeRenamed = true;
            state.djFee = {
                ...state.djFee,
                name: 'Booking & management',
                description: 'Sourcing, scheduling and managing your DJ, with backup cover',
                updatedAt: Date.now()
            };
            fb.f.setDoc(fb.f.doc(fb.db, 'djSettings', 'fee'), state.djFee).catch(() => {});
        }
        state.regularNights = snapRows(nights);
        state.regularNights.sort((a, b) => a.weekday - b.weekday || String(a.venue).localeCompare(String(b.venue)));
    } catch (err) {
        state.actRates = state.actRates || {};
        state.regularNights = state.regularNights || [];
    }
}
/*  KEEP IN STEP with pubCore() in functions/index.js - how a pub is matched */
const PUB_WORDS = /\b(hotel|tavern|pub|bar|club|the|inn|bowen|qld|queensland)\b/g;
function pubCore(v) {
    return String(v || '')
        .toLowerCase()
        .split(',')[0]
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(PUB_WORDS, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
const samePub = (a, b) => {
    const x = pubCore(a),
        y = pubCore(b);
    return !!x && !!y && (x.includes(y) || y.includes(x));
};
const regularNightFor = (venue) => (state.regularNights || []).find((n) => samePub(n.venue, venue)) || null;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ampmT = (t) => {
    const r = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    if (!r) return '';
    const h = +r[1];
    return (h % 12 || 12) + (r[2] === '00' ? '' : ':' + r[2]) + (h < 12 ? 'am' : 'pm');
};
/*  times every 15 minutes from midday round to 4am (DJs finish late) */
function timeOpts15(current, blank) {
    let out = '<option value="">' + (blank || '—') + '</option>';
    for (let m = 12 * 60; m < 28 * 60; m += 15) {
        const hh = String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
        out += '<option value="' + hh + '"' + (hh === current ? ' selected' : '') + '>' + ampmT(hh) + '</option>';
    }
    return out;
}
/*  DJ GIG INVOICES: make / update / cancel the invoice for each booking
    (template + customer + DJ hours x rate + travel). */
async function gigSyncBookings(ids) {
    const notes = [];
    for (const id of [...new Set(ids.filter(Boolean))]) {
        try {
            let r = await call('adminGigSync', { bookingId: id });
            // SENT BUT NOT ACCEPTED: ask, then update it - the venue's link shows the new version
            if (
                r.locked &&
                r.status === 'sent' &&
                window.confirm(
                    'This quote was already sent to the venue.\n\nUpdate it anyway? Their link will show the new times and price straight away (it is not emailed again).'
                )
            ) {
                r = await call('adminGigSync', { bookingId: id, force: true });
            }
            if (r.needTemplate) notes.push('That template is gone - pick another one on the booking.');
            if (r.noRate && r.noRate.length)
                notes.push('Add a rate / travel fee for ' + r.noRate.join(', ') + ' (Entertainment > The roster).');
            if (r.askPrice && r.askPrice.length)
                notes.push(
                    r.askPrice.join(', ') +
                        ' is price on request - ask them for their fee, then open the quote and type it in (Amount = per hour).'
                );
            if (r.locked)
                notes.push(
                    r.status === 'sent'
                        ? 'The quote was left as it was.'
                        : "That gig's quote has been accepted or paid, so it was not changed."
                );
        } catch (e) {
            notes.push('Invoice not updated: ' + friendly(e));
        }
    }
    return notes;
}

/*  Text the DJ the link to put in their real times (phone: sms, computer: copy) */
async function textDjTimes(bookingId) {
    try {
        const b = (state.schedule || []).find((x) => x.id === bookingId) || {};
        const act = (state.talent || []).find((t) => t.slug === b.slug) || {};
        const res = await call('adminPubTimesLink', { bookingId });
        const first = String(act.name || '').split(' ')[0];
        const hi = 'Hi' + (first ? ' ' + first : '');
        const on = b.date ? ' on ' + prettyDate(b.date) : '';
        const after = b.date && b.date <= isoDay(new Date());
        const text = after
            ? hi +
              ', thanks for playing ' +
              (b.venue || 'the pub').split(',')[0] +
              on +
              '! Can you pop your start and finish times in here: ' +
              res.url
            : hi +
              ", you're booked for " +
              (b.venue || 'the gig').split(',')[0] +
              on +
              (b.time ? ' (' + b.time + ')' : '') +
              ". Tap here to confirm you're in: " +
              res.url;
        await textTheDj(res.phone, text);
    } catch (err) {
        window.alert(friendly(err));
    }
}

/*  A text to the DJ: on a phone it opens Messages, on a computer it is copied. */
async function textTheDj(phoneRaw, text) {
    const phone = String(phoneRaw || '').replace(/[^0-9+]/g, '');
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
        location.href = 'sms:' + phone + '?&body=' + encodeURIComponent(text);
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        window.alert('Copied - paste it into a text to the DJ:\n\n' + text);
    } catch (e) {
        window.prompt('Copy this and text it to the DJ:', text);
    }
}
/*  Send a pub invoice - with Max's OK */
async function sendPubInvoice(id) {
    const q = (state.quoteDocs || []).find((x) => x.id === id);
    if (!q) return;
    const c = q.customer || {};
    if (
        !window.confirm(
            'Send the ' +
                (q.pubVenue || 'pub').split(',')[0] +
                ' invoice for ' +
                (c.eventDate || '') +
                ' (' +
                money(q.totalCents) +
                ') to ' +
                (c.email || 'NO EMAIL') +
                '?'
        )
    )
        return;
    try {
        const r = await call('adminSendPubInvoice', { id });
        window.alert(r.sent ? 'Sent - invoice ' + (r.invoiceNumber || '') + '.' : 'It did not send: ' + (r.error || r.reason || ''));
    } catch (err) {
        window.alert(friendly(err));
    }
}

async function loadSchedule() {
    try {
        const { collection, getDocs } = fb.f;
        const snap = await getDocs(collection(fb.db, 'talentSchedule'));

        const rows = snapRows(snap);

        /*  Everything, past included - the table can show past bookings and
        the calendar can be paged back into them. The filters decide what
        is on screen, not the loader.                                   */
        state.schedule = rows.filter((r) => r.date && r.status !== 'cancelled').sort((x, y) => x.date.localeCompare(y.date));
        try {
            const crew = await getDocs(collection(fb.db, 'gigCrew'));
            state.gigCrew = {};
            crew.forEach((d) => {
                state.gigCrew[d.id] = d.data();
            });
        } catch (e) {
            /* crew names just don't show */
        }
        state.scheduleLoaded = true; // the dashboard only flags DJ-less Fridays once it knows
    } catch (err) {
        state.schedule = [];
    }
}

/*  LOADING BAR: a thin orange bar across the top whenever admin is waiting
    on the server - shown after a moment so quick things don't flicker. */
let busyCount = 0,
    busyTimer = null;
function busyStart() {
    busyCount++;
    if (busyCount === 1)
        busyTimer = setTimeout(() => {
            const b =
                document.getElementById('ad-busy') ||
                Object.assign(document.body.appendChild(document.createElement('div')), { id: 'ad-busy' });
            b.className = 'is-on';
        }, 150);
}
function busyEnd() {
    busyCount = Math.max(0, busyCount - 1);
    if (busyCount) return;
    clearTimeout(busyTimer);
    const b = document.getElementById('ad-busy');
    if (b) b.className = '';
}
async function busy(p) {
    busyStart();
    try {
        return await p;
    } finally {
        busyEnd();
    }
}

/* Call an admin Cloud Function. */
async function call(name, data) {
    busyStart();
    try {
        const res = await fb.fn.httpsCallable(fb.fns, name)(data || {});
        return res.data;
    } finally {
        busyEnd();
    }
}

/* -------------------------------------------------------------------------
   Gate
   ------------------------------------------------------------------------- */
function showGate() {
    state.user = null;
    document.getElementById('ad-gate').hidden = false;
    document.getElementById('ad-shell').hidden = true;
}

function showApp(user) {
    document.getElementById('ad-gate').hidden = true;
    document.getElementById('ad-shell').hidden = false;

    const name = user.email || 'Admin';
    document.getElementById('ad-who-name').textContent = name;
    document.getElementById('ad-avatar').textContent = (name[0] || 'A').toUpperCase();
}

function showLoginError(message) {
    const el = document.getElementById('ad-login-error');
    el.textContent = message;
    el.hidden = !message;
}

/* -------------------------------------------------------------------------
   Chrome - login form, rail, event picker
   ------------------------------------------------------------------------- */
function wireChrome() {
    document.getElementById('ad-login').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        showLoginError('');

        const btn = document.getElementById('ad-login-submit');
        btn.disabled = true;
        btn.textContent = 'Signing in…';

        try {
            await fb.a.signInWithEmailAndPassword(
                fb.auth,
                document.getElementById('ad-email').value.trim(),
                document.getElementById('ad-password').value
            );
        } catch (err) {
            showLoginError(friendly(err));
        } finally {
            btn.disabled = false;
            btn.textContent = 'Sign In';
        }
    });

    document.getElementById('ad-signout').addEventListener('click', () => {
        fb.a.signOut(fb.auth);
    });

    document.querySelectorAll('[data-view]').forEach((btn) => {
        btn.addEventListener('click', () => {
            location.hash = '#/' + btn.getAttribute('data-view');
            document.getElementById('ad-rail').classList.remove('is-open');
        });
    });

    /*  The Vendors group opens and shuts. It is a button rather than a
      link because it goes nowhere - the items inside it do.        */
    document.querySelectorAll('[data-group-toggle]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const group = btn.closest('.ad-nav-group');
            if (!group) return;
            const open = group.classList.toggle('is-open');
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
    });

    const toggle = document.getElementById('ad-rail-toggle');
    if (toggle) {
        toggle.addEventListener('click', () => {
            document.getElementById('ad-rail').classList.toggle('is-open');
        });
    }

    window.addEventListener('hashchange', routeFromHash);
}

/* -------------------------------------------------------------------------
   Routing
   ------------------------------------------------------------------------- */
const BUILT = [
    'dashboard',
    'events',
    'vendors',
    'applications',
    'map',
    'entertainment',
    'settings',
    'vendorEmail',
    'inventory',
    'quoteDocs',
    'packages',
    'resources',
    'leads',
    'leadRate',
    'customers',
    'event',
    'sponsorDir'
];

/*  The Dashboard is what you land on. */
const HOME = 'dashboard';

/*  Sidebar shortcuts into the event hub: #/sponsors and #/volunteers open
    the current event on that tab.                                        */
const HUB_SHORTCUTS = ['volunteers'];

function routeFromHash() {
    const [want0, qs] = (location.hash.replace('#/', '') || HOME).split('?');
    if (HUB_SHORTCUTS.includes(want0)) {
        location.replace('#/event?id=' + encodeURIComponent(state.activeEventId || '') + '&tab=' + want0);
        return;
    }
    const want = want0 || HOME;
    state.view = want;
    state.openBookingId = null;
    if (want === 'sponsorDir') loadAllSponsors();

    // EVENT HUB: one event, in tabs. Opening another event switches the subscriptions.
    if (want === 'event') {
        const p = new URLSearchParams(qs || '');
        state.eventTab = p.get('tab') || 'overview';
        const id = p.get('id');
        if (id && id !== state.activeEventId && state.events.some((e) => e.id === id)) setActiveEvent(id);
        if (state.budgetFor !== state.activeEventId) loadBudget(state.activeEventId);
        if (state.programmeFor !== state.activeEventId) loadProgramme(state.activeEventId);
        if (state.volunteersFor !== state.activeEventId) loadVolunteers(state.activeEventId);
    }

    /*  SALES PIPELINE: an open quote lives at #/quoteDocs?q=<id> (or ?q=new),
      so the phone / browser Back button goes back to the list. */
    if (want === 'quoteDocs') {
        const q = new URLSearchParams(qs || '').get('q');
        if (!q && state.openQuoteId) {
            // leaving a quote: finish any auto-save first, then show the list
            Promise.race([flushQuoteAutosave(), new Promise((r) => setTimeout(r, 3000))])
                .catch(() => {})
                .then(() => {
                    if (new URLSearchParams(location.hash.split('?')[1] || '').get('q')) return; // moved on again
                    state.openQuoteId = null;
                    state.quoteLoadedId = null;
                    if (state.view === 'quoteDocs') render();
                });
            return;
        }
        if (q === 'new') {
            if (state.openQuoteId !== '__new__') {
                // a plain "+ New quote"
                quoteDraft = blankQuote();
                quoteCustomerId = '';
                state.quoteFromLeadId = '';
                if (new URLSearchParams(qs || '').get('template')) quoteDraft.isTemplate = true; // + New template
                state.openQuoteId = '__new__';
            }
        } else if (q && state.quoteLoadedId !== q) {
            const doc = (state.quoteDocs || []).find((x) => x.id === q);
            if (doc) {
                quoteDraft = quoteFromDoc(doc);
                rebuildAllKits();
                const cm = findCustomerMatch(doc.customer || {});
                quoteCustomerId = cm ? cm.id : '';
                state.openQuoteId = q;
                state.quoteLoadedId = q;
            } else {
                state.pendingQuoteId = q; // quotes not loaded yet - opened when they arrive
                state.openQuoteId = null;
            }
        }
    }

    const lit = want === 'event' && HUB_SHORTCUTS.includes(state.eventTab) ? state.eventTab : want;
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('is-active', b.getAttribute('data-view') === lit));

    render();

    /*  Only Settings needs the Friday line up, so it is fetched on arrival
      and the view is drawn again once it lands. */
    if (want === 'entertainment') {
        busy(Promise.all([loadTalent(), loadSchedule(), loadPubSettings()])).then(() => {
            if (state.view === 'entertainment') render();
        });
    }
    // the dashboard's "Next 30 days" shows the gigs too - fetched at most every 5 min
    if (want === 'dashboard' && Date.now() - (state.gigsLoadedAt || 0) > 5 * 60000) {
        state.gigsLoadedAt = Date.now();
        Promise.all([loadTalent(), loadSchedule(), loadPubSettings()]).then(() => {
            if (state.view === 'dashboard') render();
        });
    }
}

/* -------------------------------------------------------------------------
   Data
   ------------------------------------------------------------------------- */
async function loadEvents() {
    const { collection, getDocs } = fb.f;
    const snap = await getDocs(collection(fb.db, 'events'));

    state.events = snapRows(snap);
    state.events.sort((a, b) => (a.dateISO || '').localeCompare(b.dateISO || ''));

    if (!state.events.some((e) => e.id === state.activeEventId)) {
        state.activeEventId = state.events[0] ? state.events[0].id : null;
    }
}

/*  Live subscriptions for the active event. Everything on the page reads
    from these, so a change made here or by a vendor on the public page
    shows up without a refresh. */
function subscribeToEvent() {
    while (unsubscribes.length) unsubscribes.pop()();

    if (!state.activeEventId) {
        state.bookings = [];
        state.sites = [];
        state.categories = [];
        return;
    }

    const { collection, onSnapshot, query, where } = fb.f;
    const evId = state.activeEventId;

    unsubscribes.push(
        onSnapshot(
            query(collection(fb.db, 'bookings'), where('eventId', '==', evId)),
            (snap) => {
                state.bookings = snapRows(snap);
                state.bookings.sort((a, b) => secs(b.createdAt) - secs(a.createdAt));
                state.ready = true;
                render();
            },
            (err) => console.error('bookings', err)
        )
    );

    unsubscribes.push(
        onSnapshot(
            collection(fb.db, 'events', evId, 'sites'),
            (snap) => {
                state.sites = snapRows(snap);
                state.sites.sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true }));
                render();
            },
            (err) => console.error('sites', err)
        )
    );

    // sponsorship outreach
    state.sponsors = [];
    unsubscribes.push(
        onSnapshot(
            query(collection(fb.db, 'sponsors'), where('eventId', '==', evId)),
            (snap) => {
                state.sponsors = snapRows(snap);
                if ((state.view === 'vendorEmail' && !state.msgOpen && state.msgTab === 'sponsors') || state.view === 'dashboard') render();
            },
            (err) => console.error('sponsors', err)
        )
    );

    // vendor waitlist
    state.waitlist = [];
    unsubscribes.push(
        onSnapshot(
            query(collection(fb.db, 'waitlist'), where('eventId', '==', evId)),
            (snap) => {
                state.waitlist = snapRows(snap);
                if ((state.view === 'vendorEmail' && !state.msgOpen) || state.view === 'dashboard') render();
            },
            (err) => console.error('waitlist', err)
        )
    );

    // Messages page
    state.messages = [];
    state.messagesLoaded = false;
    state.msgOpen = null;
    state.msgDraft = null;
    unsubscribes.push(
        onSnapshot(
            query(collection(fb.db, 'messages'), where('eventId', '==', evId)),
            (snap) => {
                state.messages = snapRows(snap);
                state.messagesLoaded = true;
                if (state.view === 'vendorEmail' || state.view === 'dashboard') render();
            },
            (err) => console.error('messages', err)
        )
    );

    unsubscribes.push(
        onSnapshot(
            collection(fb.db, 'events', evId, 'categories'),
            (snap) => {
                state.categories = snapRows(snap);
                state.categories.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
                render();
            },
            (err) => console.error('categories', err)
        )
    );
}

/*  The equipment inventory, live. Feeds both the Equipment page and, once
    saved, the bot. Ordered by category then name so the page reads tidily. */
function subscribeToInventory() {
    const { collection, onSnapshot } = fb.f;
    unsubscribes.push(
        onSnapshot(
            collection(fb.db, 'inventory'),
            (snap) => {
                const items = snapRows(snap);
                //  Category first, then A-Z by name within it. Names starting with a
                //  letter come before ones starting with a number/symbol (so "A…"
                //  beats "18…"), matching the column-sort behaviour.
                const nameRank = (s) => (/^\s*[a-z]/i.test(s || '') ? 0 : 1);
                items.sort(
                    (a, b) =>
                        (a.category || '').localeCompare(b.category || '') ||
                        nameRank(a.name) - nameRank(b.name) ||
                        (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' })
                );
                state.inventory = items;
                /*  Never rebuild the whole view while a detail panel is open - that
          would wipe whatever the user is part-way through typing. Refresh
          only the table; the open panel is left exactly as it is.        */
                if (state.view === 'inventory') {
                    if (state.openInvId) {
                        renderInvRows();
                        refreshInvReqOptions();
                    } else render();
                }
            },
            (err) => console.error('inventory', err)
        )
    );
}

/*  A count badge on the Quotes & Invoices rail item for quotes the bot
    created and nobody has actioned yet (still draft). */
function updateBotBadge() {
    const n = (state.quoteDocs || []).filter((q) => q.source === 'bot' && q.status === 'draft').length;
    const btn = document.querySelector('.ad-nav-item[data-view="quoteDocs"]');
    if (!btn) return;
    let b = btn.querySelector('.ad-nav-badge');
    if (n > 0) {
        if (!b) {
            b = document.createElement('span');
            b.className = 'ad-nav-badge';
            btn.appendChild(b);
        }
        b.textContent = String(n);
    } else if (b) {
        b.remove();
    }
}

/*  ONE-OFF TIDY: only the website bot makes estimates, so any draft
    estimate not from the bot is turned into a quote. Once per session. */
let promotedMine = false;
function promoteMyEstimates() {
    if (promotedMine) return;
    promotedMine = true;
    const mine = (state.quoteDocs || []).filter((q) => q.status === 'draft' && q.source !== 'bot' && q.createdBy !== 'bot');
    mine.forEach((q) => {
        call('adminSetQuoteStatus', { id: q.id, status: 'approved' }).catch((e) => console.warn('promote', q.number, e));
    });
}

/*  DASHBOARD REMINDERS - Max's own to-do list at the top of the dashboard's
    To-dos. Seeded once when empty; the _seeded marker doc stops a re-seed. */
const REMINDER_SEED = [
    'Phone-test the vendor page: pick an event, hold a site, upload a document, stop before paying, release the site',
    'Send yourself a test email from Messages (checks the email upgrade)',
    'Turn on 2-step verification on the admin Google account',
    "Fix Dion's real quote (put his details back) and delete max@soundzgood.com.au from Customers",
    'Blog: check Daniel McDonald + Sue Tapp are happy to be quoted, photo permissions (Dash, Stonka), and the 2027 Dash booking',
    'Add crew emails in Crew & Vehicles (then crew emails can be switched on)',
    'Find the Register.com login (for SPF/DMARC - stops emails going to spam)',
    'Ideas for later: RSVP button, sponsor report, mailing list, client Google reviews (Messages step 2)'
];
function subscribeToReminders() {
    const { collection, onSnapshot, doc, setDoc, serverTimestamp } = fb.f;
    unsubscribes.push(
        onSnapshot(
            collection(fb.db, 'reminders'),
            (snap) => {
                const all = snapRows(snap);
                if (!all.length && !snap.metadata.fromCache && !state.remindersSeeding) {
                    state.remindersSeeding = true;
                    const t = Date.now();
                    Promise.all(
                        REMINDER_SEED.map((text, i) =>
                            setDoc(doc(fb.db, 'reminders', 'seed-' + (i + 1)), { text, done: false, createdAt: t + i })
                        )
                    )
                        .then(() => setDoc(doc(fb.db, 'reminders', '_seeded'), { at: serverTimestamp() }))
                        .catch((e) => console.warn('reminders seed', e));
                }
                state.reminders = all.filter((r) => r.id !== '_seeded' && !r.done).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
                if (state.view === 'dashboard') render();
            },
            (err) => console.error('reminders', err)
        )
    );
}
const reminderStore = {
    add(text) {
        const { collection, addDoc } = fb.f;
        return addDoc(collection(fb.db, 'reminders'), { text: String(text).slice(0, 300), done: false, createdAt: Date.now() });
    },
    done(id) {
        const { doc, updateDoc } = fb.f;
        return updateDoc(doc(fb.db, 'reminders', id), { done: true, doneAt: Date.now() });
    }
};

/*  Quotes / invoices, live. Only re-render the list when it is on screen;
    while the builder is open a snapshot must not repaint over the draft. */
function subscribeToQuoteDocs() {
    const { collection, onSnapshot, query, orderBy } = fb.f;
    unsubscribes.push(
        onSnapshot(
            query(collection(fb.db, 'quotes'), orderBy('createdAt', 'desc')),
            (snap) => {
                state.quoteDocs = snapRows(snap);
                updateBotBadge();
                promoteMyEstimates();
                if (state.pendingQuoteId && state.view === 'quoteDocs') {
                    state.pendingQuoteId = null;
                    routeFromHash();
                    render();
                    return;
                }
                if ((state.view === 'quoteDocs' && !state.openQuoteId) || state.view === 'dashboard') render();
            },
            (err) => console.error('quotes', err)
        )
    );
}

/* -------------------------------------------------------------------------
   Render
   ------------------------------------------------------------------------- */
function render() {
    const desk = document.getElementById('ad-desk');
    if (!desk || !state.user) return;

    const view = BUILT.includes(state.view) && VIEWS[state.view];
    if (!view) {
        desk.innerHTML = comingSoon(state.view);
        return;
    }

    desk.innerHTML = view.html();

    desk.classList.remove('is-bookings');
    desk.classList.remove('show-roster');

    /*  Leads works like an app: one screen tall, the top fixed, only the
      list scrolls (see "LEADS: one-screen app layout" in css/admin/leads.css).  */
    desk.classList.toggle('is-leads', state.view === 'leads');
    document.body.classList.toggle('ad-fit-leads', state.view === 'leads');
    // Inventory too: one screen tall, only the item list scrolls
    desk.classList.toggle('is-inv', state.view === 'inventory');
    document.body.classList.toggle('ad-fit-inv', state.view === 'inventory');
    // Lead Rating runs full-screen on a phone, like an app
    document.body.classList.toggle('ad-rate-app', state.view === 'leadRate');
    // ...and only there, pinch / double-tap zoom is locked so it feels like an app
    const vp = document.querySelector('meta[name="viewport"]');
    if (vp)
        vp.setAttribute(
            'content',
            'width=device-width, initial-scale=1.0, viewport-fit=cover' +
                (state.view === 'leadRate' ? ', maximum-scale=1.0, user-scalable=no' : '')
        );

    document.body.classList.remove('ad-fit');

    if (view.wire) view.wire();
}

/*  render() rebuilds a search box, so put focus and the caret back (at
    pos, or the end) or typing a second character would jump to the front. */
function renderKeepCaret(id, pos) {
    render();
    const el = document.getElementById(id);
    if (!el) return;
    el.focus();
    const at = pos == null ? el.value.length : pos;
    el.setSelectionRange(at, at);
}

function comingSoon(name) {
    const pretty = (name || '').replace(/(^|\s)\w/g, (m) => m.toUpperCase());
    return `
    <div class="ad-soon">
      <div class="ad-soon-inner">
        <div class="ad-soon-mark" aria-hidden="true">◷</div>
        <h1>${esc(pretty)}</h1>
        <p>Feature coming soon.</p>
      </div>
    </div>`;
}

/*  Views are registered here. Each is { html(), wire?() } - html returns
    the markup, wire hooks up whatever needs listeners afterwards. Adding
    a section means adding an entry and a rail button. */
const VIEWS = {};

/* -------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------- */
function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/*  A URL from the database, checked before it becomes a link.
    SECURITY: vendors write their own document urls, so a javascript: link
    could run here with admin rights. Only https to our own storage bucket
    becomes a link. */
const DOC_HOSTS = ['firebasestorage.googleapis.com', 'storage.googleapis.com', 'soundzgood-8c86f.firebasestorage.app'];

function safeUrl(value) {
    if (!value) return null;
    let u;
    try {
        u = new URL(String(value), location.origin);
    } catch (err) {
        return null;
    }
    if (u.protocol !== 'https:') return null;
    if (!DOC_HOSTS.includes(u.hostname)) return null;
    return u.href;
}

function attr(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/*  The markup helpers handed to the page modules (dashboard, event hub, kit builder, pipeline). */
const H = { esc, attr, money };

/*  A Firestore snapshot as plain rows: { id, ...fields }. */
function snapRows(snap) {
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    return rows;
}

function secs(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts / 1000;
    if (ts.seconds != null) return ts.seconds;
    if (typeof ts.toMillis === 'function') return ts.toMillis() / 1000;
    return 0;
}

function friendly(err) {
    const code = (err && err.code) || '';
    if (code.includes('wrong-password') || code.includes('invalid-credential')) {
        return 'Wrong email or password.';
    }
    if (code.includes('user-not-found')) return 'No account with that email.';
    if (code.includes('too-many-requests')) return 'Too many attempts. Wait a minute.';
    return (err && err.message) || String(err);
}

function money(cents) {
    if (cents == null) return '—';
    const dp = cents % 100 ? 2 : 0;
    return '$' + (cents / 100).toLocaleString('en-AU', { minimumFractionDigits: dp, maximumFractionDigits: dp }); // e.g. $1,095.60
}

/*  Dollars typed into a box, as whole cents (never below 0). */
function toCents(v) {
    return Math.max(0, Math.round(Number(v || 0) * 100));
}

/*  Like toCents, but reads a leading number ("12abc" = $12). */
function parseCents(v) {
    return Math.max(0, Math.round((parseFloat(v) || 0) * 100));
}

function dateShort(ts) {
    const s = secs(ts);
    if (!s) return '—';
    return new Date(s * 1000).toLocaleDateString('en-AU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
    });
}

/*  An event id turned into its name; falls back to the id. */
function eventNameOf(id) {
    if (!id) return 'No event';
    const ev = state.events.find((e) => e.id === id);
    return (ev && ev.name) || id;
}

/*  The vendor's own name, falling back through the fields most likely
    to be filled in on a half finished application. */
function vendorName(b) {
    return (b.business && (b.business.name || b.business.contactName)) || b.reference || 'Unnamed application';
}

function typePill(type) {
    const map = {
        food: ['ad-pill-red', 'Food'],
        market: ['ad-pill-blue', 'Market'],
        community: ['ad-pill-green', 'Community']
    };
    const [cls, label] = map[type] || ['ad-pill-grey', type || '—'];
    return `<span class="ad-pill ${cls}">${esc(label)}</span>`;
}

/*  Where an application is up to: the admin's reviewStatus if set, else
    where the booking itself has got to. */
function statusPill(b) {
    const review = b.reviewStatus;
    if (review === 'declined') return `<span class="ad-pill ad-pill-red">Declined</span>`;
    if (review === 'waitlisted') return `<span class="ad-pill ad-pill-amber">Waitlisted</span>`;
    if (review === 'approved') return `<span class="ad-pill ad-pill-green">Approved</span>`;

    const map = {
        confirmed: ['ad-pill-green', 'Confirmed'],
        pending_payment: ['ad-pill-amber', 'Pending'],
        draft: ['ad-pill-grey', 'Draft'],
        cancelled: ['ad-pill-red', 'Cancelled'],
        needs_attention: ['ad-pill-red', 'Needs attention']
    };
    const [cls, label] = map[b.status] || ['ad-pill-grey', b.status || '—'];
    return `<span class="ad-pill ${cls}">${esc(label)}</span>`;
}

function paymentPill(b) {
    const map = {
        paid: ['ad-pill-green', 'Paid'],
        free: ['ad-pill-blue', 'Free'],
        unpaid: ['ad-pill-amber', 'Unpaid'],
        none: ['ad-pill-grey', 'Not started']
    };
    const [cls, label] = map[b.paymentStatus] || ['ad-pill-grey', b.paymentStatus || '—'];
    return `<span class="ad-pill ${cls}">${esc(label)}</span>`;
}

/*  Applications worth counting. A draft is someone who opened the form and
    wandered off - it is not an application until they have at least chosen
    a site, so drafts are kept out of the totals and the lists by default. */
function realApplications() {
    return state.bookings.filter((b) => b.status !== 'draft' || b.siteId);
}

/*  Debug helper: __sgAdmin.state shows what the page holds, render()
    redraws. Exposes nothing a signed-in admin can't already see. */
window.__sgAdmin = { state, VIEWS, call, render };
