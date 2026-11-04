/* SOUNDZGOOD ADMIN - events.js
   Events and the Event hub.
   A plain script: every admin file shares one page scope, loaded in order by admin.html. */
'use strict';

/* =========================================================================
   EVENTS
   Every event the site has run or will run; everything else in admin is
   about the active one. Signup open / closed lives here too - holdSite
   refuses a site unless the event is open.
   ========================================================================= */

/*  What the desk calls each status. The vendor signup page has its own
    wording for the four it shows - EVENT_STATUS in js/site/vendor-signup.js.

    draft and archived never appear on the signup page at all. They are
    how an event is worked on before it opens, or put away afterwards. */
const EVENT_WORD = {
    draft: ['ad-pill-grey', 'Draft (hidden)'],
    soon: ['ad-pill-blue', 'Coming soon'],
    open: ['ad-pill-green', 'Accepting vendors'],
    limited: ['ad-pill-amber', 'Limited spots'],
    closed: ['ad-pill-amber', 'Applications closed'],
    archived: ['ad-pill-grey', 'Archived (hidden)']
};

function eventPill(status) {
    const [cls, label] = EVENT_WORD[status] || ['ad-pill-grey', status || '—'];
    return `<span class="ad-pill ${cls}">${esc(label)}</span>`;
}

VIEWS.events = {
    html() {
        return `
      <div class="ad-page-head">
        <div>
          <h1>Events</h1>
          <p>Every event in one place - open one for its vendors, sites, money and messages.</p>
        </div>
        <div class="ad-page-actions">
          <button type="button" class="ad-btn ad-btn-orange" id="ad-ev-new">New event</button>
        </div>
      </div>

      ${
          state.events.length
              ? (() => {
                    const card = (ev) =>
                        eventCardHtml({
                            ev,
                            active: ev.id === state.activeEventId,
                            eventPill,
                            h: H,
                            figures:
                                ev.id === state.activeEventId
                                    ? eventFigures({
                                          ev,
                                          bookings: state.bookings || [],
                                          sites: state.sites || [],
                                          sponsors: state.sponsors || [],
                                          waitlist: state.waitlist || [],
                                          programme: state.programmeFor === ev.id ? state.programme || [] : []
                                      })
                                    : null,
                            budget: state.budgetFor === ev.id ? state.budget || [] : [],
                            programme: state.programmeFor === ev.id ? state.programme || [] : []
                        });

                    const groups = [
                        ['today', 'Today'],
                        ['upcoming', 'Upcoming'],
                        ['past', 'Past events']
                    ];
                    return (
                        timelineHtml(state.events, state.activeEventId, { esc, attr }) +
                        groups
                            .map(([g, label]) => {
                                const list = state.events.filter((ev) => eventGroup(ev) === g);
                                if (!list.length) return '';
                                return `<h2 class="ev-group${g === 'past' ? ' is-past' : ''}">${label}</h2><div class="ad-ev-list${g === 'past' ? ' is-past' : ''}">${(g === 'past' ? list.slice().reverse() : list).map(card).join('')}</div>`;
                            })
                            .join('')
                    );
                })()
              : `<p class="ad-empty">No events yet.</p>`
      }

      <p class="ad-action-msg" id="ad-action-msg" hidden></p>

      ${eventForm()}`;
    },

    wire() {
        if (state.budgetFor !== state.activeEventId) loadBudget(state.activeEventId);
        if (state.programmeFor !== state.activeEventId) loadProgramme(state.activeEventId);
        document.querySelectorAll('[data-open-hub]').forEach((el) => {
            el.addEventListener('click', (e) => {
                if (el.tagName !== 'BUTTON' && e.target.closest('button, a')) return; // the card's own buttons
                location.hash = '#/event?id=' + encodeURIComponent(el.getAttribute('data-open-hub'));
            });
        });

        wireEventButtons(document);

        const newBtn = document.getElementById('ad-ev-new');
        if (newBtn)
            newBtn.addEventListener('click', () => {
                state.editingEvent = { creating: true };
                render();
            });

        wireEventForm();
    }
};

/*  Edit / open signup / close signup buttons on an event card or the hub. */
function wireEventButtons(root) {
    root.querySelectorAll('[data-edit-ev]').forEach((el) =>
        el.addEventListener('click', () => {
            state.editingEvent = { id: el.getAttribute('data-edit-ev') };
            render();
        })
    );
    root.querySelectorAll('[data-open-ev]').forEach((el) =>
        guarded(el, () => runAction(el, 'adminSaveEvent', { eventId: el.getAttribute('data-open-ev'), fields: { status: 'open' } }))
    );
    root.querySelectorAll('[data-close-ev]').forEach((el) =>
        guarded(el, () => runAction(el, 'adminSaveEvent', { eventId: el.getAttribute('data-close-ev'), fields: { status: 'closed' } }))
    );
}

/* =========================================================================
   EVENT HUB - the look lives in js/admin/event-hub.js. Vendors, Sites & Map,
   Entertainment, Messages and Sponsors are the existing pages drawn
   inside the hub's tabs. The budget is events/{id}/budget/ (admin only).
   ========================================================================= */
const HUB_SUB = { map: 'map', messages: 'vendorEmail', sponsors: 'vendorEmail' };
VIEWS.event = {
    html() {
        const ev = state.events.find((e) => e.id === state.activeEventId);
        if (!ev) return '<p class="ad-empty">Pick an event on the <a href="#/events">Events</a> page.</p>';
        const tab = state.eventTab || 'overview';
        if (tab === 'sponsors') {
            state.msgTab = 'sponsors';
            loadAllSponsors();
        } else if (tab === 'messages' && state.msgTab === 'sponsors') state.msgTab = 'vendors';
        const sub = HUB_SUB[tab] ? VIEWS[HUB_SUB[tab]] : null;
        return (
            eventHubHtml({
                ev,
                tab,
                inner: sub ? sub.html() : '',
                eventPill,
                bookings: state.bookings || [],
                sites: state.sites || [],
                sponsors: state.sponsors || [],
                waitlist: state.waitlist || [],
                budget: state.budgetFor === ev.id ? state.budget || [] : [],
                programme: state.programmeFor === ev.id ? state.programme || [] : [],
                talent: state.talent || [],
                categories: state.categories || [],
                progOpen: state.progOpen || '',
                volunteers: state.volunteersFor === ev.id ? state.volunteers || [] : [],
                h: H
            }) + eventForm()
        );
    },
    wire() {
        const tab = state.eventTab || 'overview';
        const sub = HUB_SUB[tab] ? VIEWS[HUB_SUB[tab]] : null;
        if (sub && sub.wire) sub.wire();
        const desk = document.getElementById('ad-desk');
        wireEventButtons(desk);
        desk.querySelectorAll('[data-notice]').forEach((b) =>
            b.addEventListener('click', () => eventNotice(b.getAttribute('data-notice')))
        );
        const pv = document.querySelector('[data-preview-reload]');
        if (pv)
            pv.addEventListener('click', () => {
                const fr = document.getElementById('ev-preview');
                if (fr) fr.src = fr.src.split('&r=')[0] + '&r=' + Date.now();
            });
        wireEventForm();

        // BUDGET: amounts save as you type
        const seed = document.getElementById('ev-bud-seed');
        if (seed)
            seed.addEventListener('click', async () => {
                seed.disabled = true;
                try {
                    await budgetStore.seed();
                } catch (e) {
                    window.alert(friendly(e));
                    seed.disabled = false;
                }
            });
        // Enter / arrows move down and up the column, like a sheet
        const cells = [...desk.querySelectorAll('[data-bud]')];
        cells.forEach((inp) => {
            inp.addEventListener('keydown', (e) => {
                if (!['Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
                const col = inp.getAttribute('data-bud');
                const same = cells.filter((x) => x.getAttribute('data-bud') === col);
                const i = same.indexOf(inp) + (e.key === 'ArrowUp' ? -1 : 1);
                if (same[i]) {
                    e.preventDefault();
                    same[i].focus();
                    same[i].select();
                }
            });
            let timer = null;
            inp.addEventListener('input', () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    const field = inp.getAttribute('data-bud');
                    const value = field === 'name' ? inp.value.trim().slice(0, 80) : toCents(inp.value);
                    budgetStore.update(inp.getAttribute('data-id'), { [field]: value }, inp).catch((e) => window.alert(friendly(e)));
                }, 500);
            });
        });
        // INVOICES / RECEIPTS on a budget line
        desk.querySelectorAll('[data-bud-file]').forEach((inp) =>
            inp.addEventListener('change', async () => {
                const file = inp.files && inp.files[0];
                if (!file) return;
                const id = inp.getAttribute('data-bud-file');
                const line = (state.budget || []).find((l) => l.id === id) || {};
                try {
                    const url = await uploadFile(file, 'event-files/' + state.activeEventId + '/budget/' + id + '/');
                    await budgetStore.update(id, { files: (line.files || []).concat([{ name: file.name, url, at: Date.now() }]) });
                } catch (e) {
                    window.alert('Upload failed - ' + (e.message || 'try again'));
                }
            })
        );
        desk.querySelectorAll('[data-bud-unfile]').forEach((b) =>
            b.addEventListener('click', async () => {
                const id = b.getAttribute('data-bud-unfile'),
                    i = +b.getAttribute('data-i');
                const line = (state.budget || []).find((l) => l.id === id) || {};
                const f = (line.files || [])[i];
                if (!f || !window.confirm('Remove "' + f.name + '" from this line? The file stays in storage.')) return;
                try {
                    await budgetStore.update(id, { files: (line.files || []).filter((_, k) => k !== i) });
                } catch (e) {
                    window.alert(friendly(e));
                }
            })
        );
        desk.querySelectorAll('[data-bud-del]').forEach((b) =>
            b.addEventListener('click', async () => {
                const row = b.closest('tr');
                const name = ((row && row.querySelector('[data-bud="name"]')) || {}).value || 'this line';
                if (!window.confirm('Remove "' + name + '" from the budget?')) return;
                try {
                    await budgetStore.remove(b.getAttribute('data-bud-del'));
                } catch (e) {
                    window.alert(friendly(e));
                }
            })
        );
        // PROGRAMME: same idea - edit in place, saves as you type
        desk.querySelectorAll('[data-prog]').forEach((inp) => {
            let timer = null;
            const save = () => {
                const field = inp.getAttribute('data-prog');
                let value;
                if (field === 'costCents') value = toCents(inp.value);
                else if (inp.type === 'checkbox') value = inp.checked;
                else
                    value = String(inp.value || '')
                        .trim()
                        .slice(0, field === 'blurb' ? 400 : 300);
                programmeStore.update(inp.getAttribute('data-id'), { [field]: value }, inp).catch((e) => window.alert(friendly(e)));
            };
            inp.addEventListener('input', () => {
                clearTimeout(timer);
                timer = setTimeout(save, inp.tagName === 'SELECT' ? 0 : 500);
            });
            inp.addEventListener('change', () => {
                clearTimeout(timer);
                save();
            });
        });
        desk.querySelectorAll('[data-prog-del]').forEach((b) =>
            b.addEventListener('click', async () => {
                const row = b.closest('tr');
                const name = ((row && row.querySelector('[data-prog="title"]')) || {}).value || 'this';
                if (!window.confirm('Take "' + name + '" off the programme?')) return;
                try {
                    await programmeStore.remove(b.getAttribute('data-prog-del'));
                } catch (e) {
                    window.alert(friendly(e));
                }
            })
        );
        desk.querySelectorAll('[data-prog-more]').forEach((b) =>
            b.addEventListener('click', () => {
                const id = b.getAttribute('data-prog-more');
                state.progOpen = state.progOpen === id ? '' : id;
                render();
            })
        );
        desk.querySelectorAll('[data-prog-photo]').forEach((inp) =>
            inp.addEventListener('change', async () => {
                const file = inp.files && inp.files[0];
                if (!file) return;
                try {
                    const url = await uploadImage(file, 'event-images/' + state.activeEventId + '/programme/', 1200);
                    await programmeStore.update(inp.getAttribute('data-prog-photo'), { photo: url });
                } catch (e) {
                    window.alert('Upload failed - ' + (e.message || 'try again'));
                }
            })
        );
        // FAQs
        const faqSave = document.getElementById('ev-faq-save');
        if (faqSave)
            faqSave.addEventListener('click', async () => {
                const lines = String(document.getElementById('ev-faq').value || '')
                    .split('\n')
                    .map((l) => l.trim())
                    .filter(Boolean);
                const faq = lines
                    .map((l) => {
                        const i = l.indexOf('|');
                        return i > 0 ? { q: l.slice(0, i).trim(), a: l.slice(i + 1).trim() } : null;
                    })
                    .filter((x) => x && x.q && x.a);
                faqSave.disabled = true;
                try {
                    await call('adminSaveEvent', { eventId: state.activeEventId, fields: { faq } });
                    await loadEvents();
                    render();
                } catch (e) {
                    window.alert(friendly(e));
                    faqSave.disabled = false;
                }
            });
        const faqStd = document.getElementById('ev-faq-std');
        if (faqStd)
            faqStd.addEventListener('click', () => {
                document.getElementById('ev-faq').value = FAQ_STANDARD.map(([q, a]) => q + ' | ' + a).join('\n');
            });
        // VOLUNTEERS
        desk.querySelectorAll('[data-vol-status]').forEach((sel) =>
            sel.addEventListener('change', async () => {
                const { doc, updateDoc } = fb.f;
                try {
                    await updateDoc(doc(fb.db, 'events', state.activeEventId, 'volunteers', sel.getAttribute('data-vol-status')), {
                        status: sel.value
                    });
                    await loadVolunteers(state.activeEventId);
                } catch (e) {
                    window.alert(friendly(e));
                }
            })
        );
        desk.querySelectorAll('[data-vol-del]').forEach((b) =>
            b.addEventListener('click', async () => {
                if (!window.confirm('Remove this person from the volunteer list?')) return;
                const { doc, deleteDoc } = fb.f;
                try {
                    await deleteDoc(doc(fb.db, 'events', state.activeEventId, 'volunteers', b.getAttribute('data-vol-del')));
                    await loadVolunteers(state.activeEventId);
                } catch (e) {
                    window.alert(friendly(e));
                }
            })
        );
        const padd = document.getElementById('ev-prog-add');
        if (padd)
            padd.addEventListener('submit', async (e) => {
                e.preventDefault();
                const fd = new FormData(padd);
                try {
                    await programmeStore.add({
                        start: String(fd.get('start') || ''),
                        title: String(fd.get('title') || '')
                            .trim()
                            .slice(0, 120),
                        who: String(fd.get('who') || '')
                            .trim()
                            .slice(0, 120),
                        kind: String(fd.get('kind') || 'activity'),
                        costCents: toCents(fd.get('cost'))
                    });
                } catch (err) {
                    window.alert(friendly(err));
                }
            });

        const add = document.getElementById('ev-bud-add');
        if (add)
            add.addEventListener('submit', async (e) => {
                e.preventDefault();
                const fd = new FormData(add);
                try {
                    await budgetStore.add({
                        name: String(fd.get('name') || '')
                            .trim()
                            .slice(0, 80),
                        kind: fd.get('kind') === 'income' ? 'income' : 'cost',
                        plannedCents: toCents(fd.get('planned'))
                    });
                } catch (err) {
                    window.alert(friendly(err));
                }
            });
    }
};
/*  THE NOTICE: venue change, postponed, cancelled, update. Saves on the
    event (the public page, guide and signup show it within a minute), then
    offers a draft email to the vendors - sent from the Messages tab.     */
async function eventNotice(kind) {
    const ev = state.events.find((e) => e.id === state.activeEventId);
    if (!ev) return;
    const name = ev.name || 'the event';
    let fields,
        title = '',
        text = '';
    if (kind === 'clear') {
        if (!window.confirm('Take the notice down?')) return;
        fields = { notice: { kind: '' } };
    } else if (kind === 'venue') {
        const venue = window.prompt('New venue:', ev.venue || '');
        if (venue == null || !venue.trim()) return;
        title = 'Venue change - now at ' + venue.trim();
        text = window.prompt(
            'Message for everyone:',
            'Due to the weather, ' + name + ' has moved to ' + venue.trim() + '. Same date and times.'
        );
        if (text == null) return;
        fields = { venue: venue.trim(), notice: { kind: 'venue', title, text: text.trim(), was: ev.venue || '' } };
    } else if (kind === 'postponed') {
        const label = window.prompt('New date, as people should read it (e.g. Saturday 14 November 2026):', ev.dateLabel || '');
        if (label == null || !label.trim()) return;
        const iso = window.prompt('The same date as YYYY-MM-DD:', ev.dateISO || '');
        if (iso == null || !/^\d{4}-\d{2}-\d{2}$/.test(iso.trim())) {
            window.alert('That date needs to look like 2026-11-14.');
            return;
        }
        title = 'Postponed to ' + label.trim();
        text = window.prompt(
            'Message for everyone:',
            name + ' has been postponed to ' + label.trim() + '. Bookings carry over - same site, nothing to do.'
        );
        if (text == null) return;
        fields = {
            dateLabel: label.trim(),
            dateISO: iso.trim(),
            notice: { kind: 'postponed', title, text: text.trim(), was: ev.dateLabel || '' }
        };
    } else if (kind === 'cancelled') {
        if (!window.confirm('Mark ' + name + ' as CANCELLED? It shows on the public page and closes signup. Refunds are done by you.'))
            return;
        title = name + ' is cancelled';
        text = window.prompt(
            'Message for everyone:',
            'Unfortunately ' + name + ' will not go ahead. Vendors - we will be in touch about your booking.'
        );
        if (text == null) return;
        fields = { status: 'closed', notice: { kind: 'cancelled', title, text: text.trim() } };
    } else {
        title = window.prompt('Headline:', 'Update');
        if (title == null || !title.trim()) return;
        text = window.prompt('Message for everyone:', '');
        if (text == null) return;
        fields = { notice: { kind: 'info', title: title.trim(), text: text.trim() } };
    }
    try {
        await call('adminSaveEvent', { eventId: ev.id, fields });
        await loadEvents();
        render();
    } catch (e) {
        window.alert(friendly(e));
        return;
    }
    if (kind === 'clear') return;
    if (
        !window.confirm(
            'Saved - it is on the public page now.\n\nMake a draft email to the vendors as well? You press Send now on the Messages tab.'
        )
    )
        return;
    try {
        const today = isoDay(new Date());
        await call('adminMessageSave', {
            id: null,
            eventId: ev.id,
            name: title,
            subject: title + ' - {{event_name}}',
            body: 'Hi {{vendor_name}},\n\n' + text.trim() + '\n\nAny questions, call Max on 0422 393 022.\n\nThanks,\nThe SoundzGood team',
            who: 'all',
            promo: false,
            trigger: { type: 'date', date: today, days: 0 }
        });
        location.hash = '#/event?id=' + encodeURIComponent(ev.id) + '&tab=messages';
        window.alert('Draft made - open "' + title + '" and press Send now.');
    } catch (e) {
        window.alert(friendly(e));
    }
}
async function loadBudget(eventId) {
    if (!eventId) return;
    try {
        const { collection, getDocs } = fb.f;
        const snap = await getDocs(collection(fb.db, 'events', eventId, 'budget'));
        state.budget = snapRows(snap).sort((a, b) => (a.order || 0) - (b.order || 0));
        state.budgetFor = eventId;
        if (state.view === 'events' || (state.view === 'event' && ['overview', 'budget'].includes(state.eventTab || 'overview'))) render();
    } catch (e) {
        console.warn('budget', e);
    }
}
const budgetStore = {
    col() {
        const { collection } = fb.f;
        return collection(fb.db, 'events', state.activeEventId, 'budget');
    },
    async add(p) {
        const { addDoc } = fb.f;
        await addDoc(this.col(), { name: '', kind: 'cost', plannedCents: 0, actualCents: 0, auto: '', order: Date.now(), ...p });
        await loadBudget(state.activeEventId);
    },
    async update(id, p, inp) {
        const { doc, updateDoc } = fb.f;
        await updateDoc(doc(fb.db, 'events', state.activeEventId, 'budget', id), p);
        const line = (state.budget || []).find((l) => l.id === id);
        if (line) Object.assign(line, p);
        if (!inp || document.activeElement !== inp) render(); // keep the cursor where it is while typing
    },
    async remove(id) {
        const { doc, deleteDoc } = fb.f;
        await deleteDoc(doc(fb.db, 'events', state.activeEventId, 'budget', id));
        await loadBudget(state.activeEventId);
    },
    async seed() {
        const { addDoc } = fb.f;
        let n = 0;
        for (const l of BUDGET_STARTER) await addDoc(this.col(), { plannedCents: 0, actualCents: 0, auto: '', ...l, order: ++n });
        await loadBudget(state.activeEventId);
    }
};

/*  Volunteers: events/{id}/volunteers/ - written by the public form. */
async function loadVolunteers(eventId) {
    if (!eventId) return;
    try {
        const { collection, getDocs } = fb.f;
        const snap = await getDocs(collection(fb.db, 'events', eventId, 'volunteers'));
        state.volunteers = snapRows(snap);
        state.volunteersFor = eventId;
        if (state.view === 'event' && state.eventTab === 'volunteers') render();
    } catch (e) {
        console.warn('volunteers', e);
    }
}
/*  The programme: events/{id}/programme/ - what happens on the night. */
async function loadProgramme(eventId) {
    if (!eventId) return;
    try {
        const { collection, getDocs } = fb.f;
        const snap = await getDocs(collection(fb.db, 'events', eventId, 'programme'));
        state.programme = snapRows(snap);
        state.programmeFor = eventId;
        if (
            state.view === 'events' ||
            (state.view === 'event' && ['overview', 'budget', 'programme'].includes(state.eventTab || 'overview'))
        )
            render();
    } catch (e) {
        console.warn('programme', e);
    }
}
const programmeStore = {
    col() {
        const { collection } = fb.f;
        return collection(fb.db, 'events', state.activeEventId, 'programme');
    },
    async add(p) {
        const { addDoc } = fb.f;
        await addDoc(this.col(), {
            start: '',
            finish: '',
            title: '',
            who: '',
            kind: 'activity',
            costCents: 0,
            notes: '',
            order: Date.now(),
            ...p
        });
        await loadProgramme(state.activeEventId);
    },
    async update(id, p, inp) {
        const { doc, updateDoc } = fb.f;
        await updateDoc(doc(fb.db, 'events', state.activeEventId, 'programme', id), p);
        const line = (state.programme || []).find((l) => l.id === id);
        if (line) Object.assign(line, p);
        if (p.headline === true) {
            // one headline per event
            for (const o of (state.programme || []).filter((l) => l.id !== id && l.headline)) {
                await updateDoc(doc(fb.db, 'events', state.activeEventId, 'programme', o.id), { headline: false });
                o.headline = false;
            }
            if (!line.featured) {
                await updateDoc(doc(fb.db, 'events', state.activeEventId, 'programme', id), { featured: true });
                line.featured = true;
            }
        }
        if (!inp || document.activeElement !== inp || inp.type === 'time' || inp.type === 'checkbox') render();
    },
    async remove(id) {
        const { doc, deleteDoc } = fb.f;
        await deleteDoc(doc(fb.db, 'events', state.activeEventId, 'programme', id));
        await loadProgramme(state.activeEventId);
    }
};

/*  Switching event means new subscriptions and none of the old view's
    scratch state, which was about a different event's vendors. */
function setActiveEvent(id) {
    state.activeEventId = id;
    state.openBookingId = null;
    state.openSiteId = null;

    /*  Drop the old event's vendors and sites now rather than leaving them on
      screen until the new subscription's first snapshot lands - a moment of
      the wrong event's numbers is worse than a moment of none. */
    state.bookings = [];
    state.sites = [];
    state.categories = [];

    render();
    subscribeToEvent();
}

function eventForm() {
    const edit = state.editingEvent;
    if (!edit) return '';

    const ev = edit.creating ? {} : state.events.find((e) => e.id === edit.id) || {};

    const price = ev.pricing || {};
    const dollars = (c) => (c == null ? '' : (c / 100).toFixed(2));

    return `
    <div class="ad-scrim" id="ad-ev-scrim"></div>
    <div class="ad-modal" role="dialog" aria-label="Event details">
      <form id="ad-ev-form">
        <header class="ad-modal-head">
          <h2>${edit.creating ? 'New event' : 'Edit event'}</h2>
          <button type="button" class="ad-drawer-close" id="ad-ev-close"
                  aria-label="Close">&times;</button>
        </header>

        <div class="ad-modal-body">
          ${
              edit.creating
                  ? `
            <label for="ad-ev-id">Id</label>
            <input id="ad-ev-id" required maxlength="60"
                   placeholder="eatz-beatz-halloween-2027"
                   pattern="[a-z0-9][a-z0-9-]{1,60}">
            <p class="ad-seat-hint">
              Lower case, numbers and dashes. It never changes, so make it one
              you will still recognise in two years.
            </p>`
                  : ''
          }

          <label for="ad-ev-name">Name</label>
          <input id="ad-ev-name" required maxlength="120" value="${attr(ev.name || '')}">

          <label for="ad-ev-subtitle">Subtitle</label>
          <input id="ad-ev-subtitle" maxlength="200" value="${attr(ev.subtitle || '')}">

          <label for="ad-ev-dateiso">Date</label>
          <input id="ad-ev-dateiso" type="date" value="${attr((ev.dateISO || '').slice(0, 10))}">

          <label for="ad-ev-datelabel">Date as written on the site</label>
          <input id="ad-ev-datelabel" maxlength="120"
                 placeholder="Saturday 31 October 2026"
                 value="${attr(ev.dateLabel || '')}">

          <label for="ad-ev-venue">Venue</label>
          <input id="ad-ev-venue" maxlength="120" value="${attr(ev.venue || '')}">

          <!--  Shown on the event card on the vendor signup page. A path
                to a file in the site, like images/events/eatz-beatz.jpg.
                Left blank, the card shows its gradient.            -->
          <label for="ad-ev-image">Poster</label>
          <div class="ad-ev-poster">
            <div class="ad-ev-poster-pic" id="ad-ev-poster-pic"${ev.image ? ` style="background-image:url('${attr(ev.image)}')"` : ''}></div>
            <div>
              <label class="ad-btn ad-btn-small">&#128444; ${ev.image ? 'Change poster' : 'Upload poster'}<input type="file" accept="image/*" id="ad-ev-poster-file" hidden></label>
              <span class="ad-seat-hint" id="ad-ev-poster-msg">Shown on the Events page, the vendor guide and the website.</span>
            </div>
          </div>
          <input id="ad-ev-image" type="hidden" maxlength="600" value="${attr(ev.image || '')}">

          <div class="ad-ev-2col">
            <div><label for="ad-ev-start">Starts</label><input id="ad-ev-start" type="time" value="${attr(ev.startTime || '')}"></div>
            <div><label for="ad-ev-finish">Finishes</label><input id="ad-ev-finish" type="time" value="${attr(ev.finishTime || '')}"></div>
          </div>
          <label for="ad-ev-intro">Intro (the public page)</label>
          <textarea id="ad-ev-intro" rows="3" maxlength="400" placeholder="A free community night market for the whole family. Amazing food, local makers, live music.">${esc(ev.intro || '')}</textarea>
          <label for="ad-ev-entry">Entry line</label>
          <input id="ad-ev-entry" maxlength="80" placeholder="Free · Family event" value="${attr(ev.entryText || '')}">

          <label for="ad-ev-location">Location</label>
          <input id="ad-ev-location" maxlength="200" value="${attr(ev.location || '')}">

          <label for="ad-ev-status">Vendor signup</label>
          <select id="ad-ev-status">
            ${Object.keys(EVENT_WORD)
                .map(
                    (k) => `
              <option value="${attr(k)}"${(ev.status || 'draft') === k ? ' selected' : ''}>${esc(EVENT_WORD[k][1])}</option>`
                )
                .join('')}
          </select>

          <label for="ad-ev-food">Food stall price</label>
          <input id="ad-ev-food" type="number" min="0" step="0.01"
                 value="${attr(dollars(price.food))}">

          <label for="ad-ev-market">Market bay price</label>
          <input id="ad-ev-market" type="number" min="0" step="0.01"
                 value="${attr(dollars(price.marketPerBay))}">

          <label for="ad-ev-bays">Most bays one market vendor may take</label>
          <input id="ad-ev-bays" type="number" min="1" max="20"
                 value="${attr(ev.maxMarketBays == null ? 8 : ev.maxMarketBays)}">

          <label for="ad-ev-hold">Minutes a site is held during checkout</label>
          <input id="ad-ev-hold" type="number" min="1" max="240"
                 value="${attr(ev.holdMinutes == null ? 10 : ev.holdMinutes)}">

          ${
              edit.creating
                  ? `
            <p class="ad-seat-hint" style="margin-top:14px">
              This creates the event only. Laying out its sites is a separate
              step - a new event usually wants a different map, and stamping
              the Bowen layout on it would be a guess.
            </p>`
                  : ''
          }

          <p class="ad-action-msg" id="ad-ev-msg" hidden></p>
        </div>

        <footer class="ad-modal-foot">
          <button type="button" class="ad-btn" id="ad-ev-cancel">Cancel</button>
          <button type="submit" class="ad-btn ad-btn-orange">
            ${edit.creating ? 'Create event' : 'Save changes'}
          </button>
        </footer>
      </form>
    </div>`;
}

function wireEventForm() {
    const edit = state.editingEvent;
    if (!edit) return;

    const close = () => {
        state.editingEvent = null;
        render();
    };
    ['ad-ev-close', 'ad-ev-cancel', 'ad-ev-scrim'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', close);
    });

    const form = document.getElementById('ad-ev-form');
    if (!form) return;

    // POSTER UPLOAD: shrunk, into event-images/<id>/, the link goes in the hidden field
    const file = document.getElementById('ad-ev-poster-file');
    if (file)
        file.addEventListener('change', async () => {
            const f = file.files && file.files[0];
            if (!f) return;
            const idEl = document.getElementById('ad-ev-id');
            const evId = edit.creating ? idEl && idEl.value.trim() : edit.id;
            const msg = document.getElementById('ad-ev-poster-msg');
            if (!evId) {
                msg.textContent = 'Type the event id first, then upload.';
                return;
            }
            msg.textContent = 'Uploading…';
            try {
                const { ref, uploadBytes, getDownloadURL } = fb.st;
                const small = await shrinkPhoto(f, 1600);
                const path = 'event-images/' + evId + '/poster-' + Date.now() + (small.type === 'image/webp' ? '.webp' : '');
                await uploadBytes(ref(fb.storage, path), small, { contentType: small.type || f.type });
                const url = await getDownloadURL(ref(fb.storage, path));
                document.getElementById('ad-ev-image').value = url;
                document.getElementById('ad-ev-poster-pic').style.backgroundImage = "url('" + url.replace(/'/g, '%27') + "')";
                msg.textContent = 'Uploaded - press ' + (edit.creating ? 'Create event' : 'Save changes') + ' to keep it.';
            } catch (e) {
                msg.textContent = 'Upload failed - ' + (e.message || 'try again');
            }
        });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const val = (id) => {
            const el = document.getElementById(id);
            return el ? el.value.trim() : '';
        };
        // Money is entered in dollars and stored in cents, as everywhere else.
        const cents = (id) => Math.round(Number(val(id) || 0) * 100);

        const msg = document.getElementById('ad-ev-msg');
        const submit = form.querySelector('[type="submit"]');

        submit.disabled = true;
        msg.hidden = false;
        msg.className = 'ad-action-msg';
        msg.textContent = 'Saving…';

        const id = edit.creating ? val('ad-ev-id') : edit.id;

        try {
            await call('adminSaveEvent', {
                eventId: id,
                create: !!edit.creating,
                fields: {
                    name: val('ad-ev-name'),
                    subtitle: val('ad-ev-subtitle'),
                    dateISO: val('ad-ev-dateiso'),
                    dateLabel: val('ad-ev-datelabel'),
                    venue: val('ad-ev-venue'),
                    image: val('ad-ev-image'),
                    location: val('ad-ev-location'),
                    startTime: val('ad-ev-start'),
                    finishTime: val('ad-ev-finish'),
                    intro: val('ad-ev-intro'),
                    entryText: val('ad-ev-entry'),
                    status: val('ad-ev-status'),
                    maxMarketBays: Number(val('ad-ev-bays')) || 8,
                    holdMinutes: Number(val('ad-ev-hold')) || 10,
                    pricing: { food: cents('ad-ev-food'), marketPerBay: cents('ad-ev-market') }
                }
            });

            state.editingEvent = null;
            await loadEvents();
            if (edit.creating) setActiveEvent(id);
            else render();
        } catch (err) {
            msg.className = 'ad-action-msg is-bad';
            msg.textContent = friendly(err);
            submit.disabled = false;
        }
    });
}
