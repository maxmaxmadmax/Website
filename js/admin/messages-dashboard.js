/* SOUNDZGOOD ADMIN - messages.js
   Messages, Dashboard and Sponsors directory: the glue for js/admin/messages.js, js/admin/dashboard.js and js/admin/sponsor-directory.js.
   A plain script: every admin file shares one page scope, loaded in order by admin.html. */
'use strict';

/* =========================================================================
   MESSAGES - the page lives in js/admin/messages.js. The view key stays
   'vendorEmail' so old links still land here.
   ========================================================================= */
function msgCtx() {
    return { state, h: { esc, attr }, call, render, loadLog, sponsors: sponsorStore, biz: bizStore, upload: uploadImage };
}
/*  Any file into our Storage, as is. Returns the download link. */
async function uploadFile(file, folder) {
    const { ref, uploadBytes, getDownloadURL } = fb.st;
    const safe = String(file.name || 'file')
        .replace(/[^\w.-]+/g, '-')
        .slice(0, 80);
    const path = folder + Date.now() + '-' + safe;
    await uploadBytes(ref(fb.storage, path), file, { contentType: file.type || 'application/octet-stream' });
    return getDownloadURL(ref(fb.storage, path));
}
/*  A picture into our Storage (shrunk first). Returns the download link. */
async function uploadImage(file, folder, max = 800) {
    const { ref, uploadBytes, getDownloadURL } = fb.st;
    const small = await shrinkPhoto(file, max);
    const path = folder + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + (small.type === 'image/webp' ? '.webp' : '');
    await uploadBytes(ref(fb.storage, path), small, { contentType: small.type || file.type });
    return getDownloadURL(ref(fb.storage, path));
}
/*  The sponsor directory: one record per business, across events. */
function newBizDoc(p) {
    const { serverTimestamp } = fb.f;
    return { business: '', industry: '', stage: 'idea', stars: 0, ...p, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
}
const bizStore = {
    async add(p) {
        const { collection, addDoc } = fb.f;
        const ref = await addDoc(collection(fb.db, 'sponsorBiz'), newBizDoc(p));
        return ref.id;
    },
    async update(id, p) {
        const { doc, updateDoc, serverTimestamp } = fb.f;
        await updateDoc(doc(fb.db, 'sponsorBiz', id), { ...p, updatedAt: serverTimestamp() });
    },
    /* many at once (imports) - 400 a batch */
    async addMany(list) {
        const { collection, doc, writeBatch } = fb.f;
        for (let i = 0; i < list.length; i += 400) {
            const batch = writeBatch(fb.db);
            list.slice(i, i + 400).forEach((p) => batch.set(doc(collection(fb.db, 'sponsorBiz')), newBizDoc(p)));
            await batch.commit();
        }
    },
    async remove(id) {
        const { doc, deleteDoc } = fb.f;
        await deleteDoc(doc(fb.db, 'sponsorBiz', id));
    }
};
const sponsorStore = {
    async add(p) {
        const { collection, addDoc, serverTimestamp } = fb.f;
        await addDoc(collection(fb.db, 'sponsors'), {
            business: '',
            contactName: '',
            email: '',
            phone: '',
            source: 'manual',
            ...p,
            eventId: p.eventId || state.activeEventId,
            status: 'todo',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
    },
    async update(id, p) {
        const { doc, updateDoc, serverTimestamp } = fb.f;
        await updateDoc(doc(fb.db, 'sponsors', id), { ...p, updatedAt: serverTimestamp() });
    },
    async remove(id) {
        const { doc, deleteDoc } = fb.f;
        await deleteDoc(doc(fb.db, 'sponsors', id));
    }
};
/*  The last 150 emails the system sent (Messages > Sent emails). */
async function loadLog() {
    const { collection, getDocs, query, orderBy, limit } = fb.f;
    const snap = await getDocs(query(collection(fb.db, 'emailLog'), orderBy('at', 'desc'), limit(150)));
    return snapRows(snap);
}
/*  DASHBOARD - the look lives in js/admin/dashboard.js. The email log is not
    live, so it is read when the dashboard opens (the "emails that failed" to-do). */
let dashLog = null;
let dashLogAt = 0;

/*  The crew picker: a small box over the dashboard with every active staff
    member. Save -> confirm who'll be emailed -> adminAssignCrew.          */
function openCrewPicker(jobId, isGig) {
    const g = isGig && (state.schedule || []).find((x) => x.id === jobId);
    const q = isGig
        ? g && {
              ...(state.gigCrew[jobId] || {}),
              customer: { business: 'Setup', eventName: String(g.venue || '').split(',')[0] },
              hire: { startDate: g.date }
          }
        : (state.quoteDocs || []).find((x) => x.id === jobId);
    if (!q) return;
    const staff = (state.resources || []).filter((r) => (r.type || 'staff') === 'staff' && r.active !== false);
    const on = new Set((q.crewAssigned || []).map((x) => x.id));
    const c = q.customer || {};
    const box = document.createElement('div');
    box.className = 'db-modal';
    box.innerHTML =
        '<div class="db-modal-card" role="dialog" aria-label="Assign crew">' +
        '<h3>Who\'s working this job?</h3><p class="db-modal-sub">' +
        esc((c.business || c.name || 'Job') + (c.eventName ? ' · ' + c.eventName : '') + ' · ' + ((q.hire && q.hire.startDate) || '')) +
        '</p>' +
        (staff.length
            ? '<ul class="db-modal-list">' +
              staff
                  .map(
                      (s) =>
                          '<li><label><input type="checkbox" value="' +
                          attr(s.id) +
                          '"' +
                          (on.has(s.id) ? ' checked' : '') +
                          '> <b>' +
                          esc(s.name) +
                          '</b>' +
                          (s.role ? ' <span>' + esc(s.role) + '</span>' : '') +
                          (s.email ? '' : ' <em>no email</em>') +
                          '</label></li>'
                  )
                  .join('') +
              '</ul>'
            : '<p>No staff yet - add them in <a href="#/resources">Crew &amp; Vehicles</a>.</p>') +
        '<p class="db-modal-note">Anyone newly ticked gets an email with the job details and their pick list.</p>' +
        '<div class="db-modal-acts"><button type="button" class="ad-btn" data-x>Cancel</button><button type="button" class="ad-btn ad-btn-primary" data-save>Save</button></div></div>';
    document.body.appendChild(box);
    const close = () => box.remove();
    box.addEventListener('click', (e) => {
        if (e.target === box || e.target.closest('[data-x]')) close();
    });
    box.querySelector('[data-save]').addEventListener('click', async () => {
        const ids = [...box.querySelectorAll('input:checked')].map((i) => i.value);
        const fresh = staff.filter((s) => ids.includes(s.id) && !on.has(s.id));
        const mailable = fresh.filter((s) => s.email);
        if (
            mailable.length &&
            !window.confirm(
                'Email the job details + pick list to:\n\n' + mailable.map((s) => s.name + ' (' + s.email + ')').join('\n') + '\n\nOK?'
            )
        )
            return;
        const btn = box.querySelector('[data-save]');
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
            const r = await call('adminAssignCrew', isGig ? { bookingId: jobId, staffIds: ids } : { id: jobId, staffIds: ids });
            if (isGig)
                state.gigCrew[jobId] = { crewAssigned: staff.filter((s) => ids.includes(s.id)).map((s) => ({ id: s.id, name: s.name })) };
            close();
            if (isGig) render();
            const bits = [];
            if (r.sent && r.sent.length) bits.push('Emailed: ' + r.sent.join(', '));
            if (r.noEmail && r.noEmail.length) bits.push('No email on file (add it in Crew & Vehicles): ' + r.noEmail.join(', '));
            if (r.failed && r.failed.length) bits.push('Could not email: ' + r.failed.join(', '));
            if (bits.length) window.alert(bits.join('\n'));
        } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Save';
            window.alert(friendly(err));
        }
    });
}

/*  EVENT-DAY WEATHER: rain and wind for each job in the
    next 30 days, from Open-Meteo (free, no account, no key). Only the town
    and the date are sent - never a customer's details. Forecasts reach ~16
    days ahead; further out the job just says when the forecast will show.
    Kept in memory for an hour so the dashboard doesn't keep asking.     */
const dashWeather = {}; // jobId -> { day } | { later: true }
const geoCache = {}; // place -> { lat, lon } | null
async function geocode(place) {
    const key = String(place || '').toLowerCase();
    if (key in geoCache) return geoCache[key];
    geoCache[key] = null;
    try {
        const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=10&country_code=AU&name=' + encodeURIComponent(place));
        const d = await r.json();
        // only somewhere within ~250 km of Bowen, so a same-named town elsewhere isn't picked
        const near = (x) => Math.hypot(x.latitude + 20.01, (x.longitude - 148.25) * 0.94) < 2.3;
        const hit = d && d.results && d.results.find(near);
        if (hit) geoCache[key] = { lat: hit.latitude, lon: hit.longitude };
    } catch (e) {
        /* no place found */
    }
    return geoCache[key];
}
/*  where to forecast: the delivery town, else the venue, else Bowen */
async function jobPlace(q) {
    const town = String((q.delivery && q.delivery.town) || '')
        .replace(/\(.*?\)/g, '')
        .trim();
    // each part of the venue ("Grand View Hotel, Bowen" -> "Grand View", "Bowen"), building words taken out
    const venueParts = String((q.customer && q.customer.eventVenue) || '')
        .split(',')
        .map((x) =>
            x
                .replace(
                    /\b(resort|hotel|club|hall|showgrounds?|park|centre|center|tavern|pub|bowls|sports?|complex|beach house|queensland|qld)\b/gi,
                    ''
                )
                .replace(/\d+/g, '')
                .trim()
        )
        .filter(Boolean);
    for (const p of [town].concat(venueParts, ['Bowen'])) {
        if (p && p.toLowerCase() !== 'other') {
            const g = await geocode(p);
            if (g) return g;
        }
    }
    return null;
}
async function loadDashWeather(jobs) {
    const today = new Date();
    const limit = new Date(today.getTime() + 15 * 86400000).toISOString().slice(0, 10);
    let changed = false;
    for (const q of jobs) {
        const day = q.hire && q.hire.startDate;
        const have = dashWeather[q.id];
        if (!day || (have && have.date === day && Date.now() - have.at < 3600000)) continue;
        if (day > limit) {
            dashWeather[q.id] = { date: day, at: Date.now(), later: true };
            changed = true;
            continue;
        }
        const g = await jobPlace(q);
        if (!g) continue;
        try {
            const r = await fetch(
                'https://api.open-meteo.com/v1/forecast?latitude=' +
                    g.lat +
                    '&longitude=' +
                    g.lon +
                    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max' +
                    '&timezone=Australia%2FBrisbane&start_date=' +
                    day +
                    '&end_date=' +
                    day
            );
            const d = (await r.json()).daily || {};
            dashWeather[q.id] = {
                date: day,
                at: Date.now(),
                code: (d.weather_code || [])[0],
                temp: (d.temperature_2m_max || [])[0],
                low: (d.temperature_2m_min || [])[0],
                rain: (d.precipitation_probability_max || [])[0],
                mm: (d.precipitation_sum || [])[0],
                wind: (d.wind_speed_10m_max || [])[0],
                gust: (d.wind_gusts_10m_max || [])[0]
            };
            changed = true;
        } catch (e) {
            /* leave it blank */
        }
    }
    if (changed && state.view === 'dashboard') render();
}
VIEWS.dashboard = {
    html() {
        return dashboardHtml({
            quotes: state.quoteDocs || [],
            bookings: state.bookings || [],
            sites: state.sites || [],
            sponsors: state.sponsors || [],
            waitlist: state.waitlist || [],
            messages: state.messages || [],
            events: state.events || [],
            activeEventId: state.activeEventId,
            emailLog: dashLog || [],
            reminders: state.reminders || [],
            weather: dashWeather,
            fyWeek: (() => {
                const t = new Date();
                t.setHours(0, 0, 0, 0);
                t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
                return leadFyWeek(t);
            })(),
            schedule: state.scheduleLoaded ? state.schedule : null,
            talent: state.talent || [],
            gigCrew: state.gigCrew,
            customers: state.customers || [],
            h: H
        });
    },
    wire() {
        const desk = document.getElementById('ad-desk');
        // PUB INVOICES: send with Max's OK; text the DJ their times link
        desk.querySelectorAll('[data-pub-send]').forEach((b) =>
            b.addEventListener('click', () => sendPubInvoice(b.getAttribute('data-pub-send')))
        );
        desk.querySelectorAll('[data-pub-times]').forEach((b) =>
            b.addEventListener('click', () => textDjTimes(b.getAttribute('data-pub-times')))
        );
        // ASSIGN CREW: tick who's working, they get emailed
        desk.querySelectorAll('[data-crew]').forEach((b) => b.addEventListener('click', () => openCrewPicker(b.getAttribute('data-crew'))));
        desk.querySelectorAll('[data-gig-crew]').forEach((b) =>
            b.addEventListener('click', () => openCrewPicker(b.getAttribute('data-gig-crew'), true))
        );
        // copy a share link (waitlist / vendor signup)
        desk.querySelectorAll('[data-copy]').forEach((b) =>
            b.addEventListener('click', async () => {
                const url = b.getAttribute('data-copy');
                try {
                    await navigator.clipboard.writeText(url);
                    const old = b.textContent;
                    b.textContent = 'Copied!';
                    setTimeout(() => {
                        b.textContent = old;
                    }, 1500);
                } catch (e) {
                    window.prompt('Copy this link:', url);
                }
            })
        );
        desk.querySelectorAll('[data-rem-done]').forEach((box) =>
            box.addEventListener('change', () => {
                box.closest('li').classList.add('is-done');
                reminderStore.done(box.getAttribute('data-rem-done')).catch((e) => {
                    window.alert(friendly(e));
                    box.checked = false;
                });
            })
        );
        const form = desk.querySelector('[data-rem-add]');
        if (form)
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                const inp = form.querySelector('input');
                const text = inp.value.trim();
                if (!text) return;
                inp.value = '';
                reminderStore.add(text).catch((err) => window.alert(friendly(err)));
            });
        loadDashWeather(
            dashboardData({
                quotes: state.quoteDocs || [],
                bookings: state.bookings || [],
                events: state.events || [],
                schedule: state.scheduleLoaded ? state.schedule : null,
                talent: state.talent || []
            }).upcoming
        ).catch(() => {});
        if (Date.now() - dashLogAt < 5 * 60000) return; // at most every 5 minutes
        dashLogAt = Date.now();
        loadLog()
            .then((log) => {
                dashLog = log;
                if (state.view === 'dashboard') render();
            })
            .catch(() => {});
    }
};

VIEWS.vendorEmail = {
    html() {
        return messagesHtml(msgCtx());
    },
    wire() {
        wireMessages(msgCtx());
    }
};

/*  SPONSORS DIRECTORY - every business across every event. Reads the whole
    sponsors collection once, kept live while the admin is open.          */
let sponsorsAllUnsub = null;
function loadAllSponsors() {
    if (sponsorsAllUnsub) return;
    const { collection, onSnapshot } = fb.f;
    onSnapshot(
        collection(fb.db, 'sponsorBiz'),
        (snap) => {
            state.sponsorBiz = snapRows(snap);
            if (state.view === 'sponsorDir' || (state.view === 'event' && state.eventTab === 'sponsors')) render();
        },
        (err) => console.error('sponsorBiz', err)
    );
    sponsorsAllUnsub = onSnapshot(
        collection(fb.db, 'sponsors'),
        (snap) => {
            state.sponsorsAll = snapRows(snap);
            if (state.view === 'sponsorDir') render();
        },
        (err) => console.error('sponsorsAll', err)
    );
}
VIEWS.sponsorDir = {
    html() {
        return sponsorDirHtml(msgCtx());
    },
    wire() {
        wireSponsorDir(msgCtx());
    }
};

/*  A value safe to drop inside a CSS attribute selector. Ids are Firestore's
    own, so this is belt and braces rather than a real threat.             */
function cssEsc(v) {
    return String(v == null ? '' : v).replace(/["\\]/g, '\\$&');
}
