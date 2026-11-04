/* SOUNDZGOOD ADMIN - settings.js
   Settings: category limits and laying out an event's ground.
   A plain script: every admin file shares one page scope, loaded in order by admin.html. */
'use strict';

/* =========================================================================
   SETTINGS
   Category limits and laying out an event's ground - per event, rarely
   changed, so kept apart from the daily work.
   ========================================================================= */
/* -------------------------------------------------------------------------
   ENTERTAINMENT - DJ BOOKINGS
   Who is playing where, a month at a glance, with the roster underneath.

   WHERE IT IS KEPT
     talent/{slug}                  an act (merged with js/roster.js)
     talentSchedule/{date__slug}    one booking. Same act + same night =
                                    same id, so it edits, not duplicates.

   The events page reads the same schedule for its Friday Nights cards.
   ------------------------------------------------------------------------- */
VIEWS.settings = {
    html() {
        const ev = state.events.find((e) => e.id === state.activeEventId) || {};

        /*  Food and market categories share one table, so the list says which
        is which rather than leaving you to guess from the name. */
        const ordered = [...state.categories].sort(
            (a, b) => (a.appliesTo || '').localeCompare(b.appliesTo || '') || (a.name || '').localeCompare(b.name || '')
        );

        return `
      <div class="ad-page-head">
        <div>
          <h1>Settings</h1>
          <p>${esc(ev.name || state.activeEventId || 'No event selected')}</p>
        </div>
      </div>

      <section class="ad-card ad-panel" style="margin-bottom:16px">
        <header class="ad-panel-head">
          <h2>Vendor categories</h2>
        </header>

        <div class="ad-panel-intro">
          <p>
            How many of each kind of vendor may come. Raise a limit and the
            category reopens on its own - the signup page compares the live
            count against the limit, so there is nothing else to switch back on.
          </p>
        </div>

        ${
            ordered.length
                ? `
          <div class="ad-table-wrap">
            <table class="ad-table">
              <thead><tr>
                <th>Category</th><th>For</th><th>Booked</th><th>Limit</th><th></th>
              </tr></thead>
              <tbody>
                ${ordered
                    .map((c) => {
                        const count = c.count || 0;
                        const full = c.limit != null && count >= c.limit;
                        return `
                    <tr>
                      <td class="ad-cell-strong">${esc(c.name)}</td>
                      <td>${typePill(c.appliesTo)}</td>
                      <td class="ad-cell-muted">${count}</td>
                      <td>
                        <input type="number" min="0" class="ad-limit"
                               value="${attr(c.limit == null ? '' : c.limit)}"
                               data-limit="${attr(c.id)}"
                               aria-label="Limit for ${attr(c.name)}">
                      </td>
                      <td>
                        <span class="ad-pill ${full ? 'ad-pill-red' : 'ad-pill-green'}">
                          ${full ? 'Full' : 'Open'}
                        </span>
                      </td>
                    </tr>`;
                    })
                    .join('')}
              </tbody>
            </table>
          </div>`
                : `
          <p class="ad-empty">
            No categories yet. Lay out the event below and they come with it.
          </p>`
        }
      </section>

      <section class="ad-card ad-panel">
        <header class="ad-panel-head">
          <h2>Event layout</h2>
        </header>

        <div class="ad-panel-intro">
          <p>
            Creates this event's sites and food categories from the default
            Bowen Sports Complex layout. Safe to run more than once - it adds
            what is missing and never overwrites what is there, so it cannot
            wipe a site somebody is already booked on.
          </p>
          <p class="ad-cell-muted">
            Currently ${state.sites.length} site${state.sites.length === 1 ? '' : 's'}
            and ${state.categories.length}
            categor${state.categories.length === 1 ? 'y' : 'ies'}.
          </p>

          <div class="ad-actions-row" style="margin-top:12px">
            <button type="button" class="ad-btn ad-btn-primary" id="ad-seed">
              Lay out this event
            </button>
          </div>

          <p class="ad-action-msg" id="ad-action-msg" hidden></p>
        </div>
      </section>

      <section class="ad-card ad-panel" style="margin-top:16px">
        <header class="ad-panel-head">
          <h2>Gig guide</h2>
        </header>

        <div class="ad-panel-intro">
          <p>
            The gig guide finds what is on around Bowen and the Whitsundays
            by itself, at four every morning, by reading the event data other
            listing sites publish for machines. This button does that run now
            rather than waiting for the morning - worth pressing after adding
            a source, or when something has just been announced.
          </p>
          <p class="ad-cell-muted">
            It reads only the pages that have changed since the last run, so
            it usually takes a few seconds. The very first run has nothing to
            compare against and takes about five minutes.
          </p>

          <div class="ad-actions-row" style="margin-top:12px">
            <button type="button" class="ad-btn ad-btn-primary" id="ad-sync-gigs">
              Refresh the gig guide
            </button>
          </div>

          <p class="ad-action-msg" id="ad-gig-msg" hidden></p>
        </div>
      </section>`;
    },

    wire() {
        /*  A limit is saved on change rather than behind a Save button - there
        is one number per row and no way to get it half right. */
        document.querySelectorAll('[data-limit]').forEach((input) => {
            input.addEventListener('change', async () => {
                const bar = document.getElementById('ad-action-msg');
                input.disabled = true;

                try {
                    await call('adminSetCategoryLimit', {
                        eventId: state.activeEventId,
                        categoryId: input.getAttribute('data-limit'),
                        limit: Number(input.value)
                    });
                    showMsg(bar, 'Limit saved.', 'is-ok');
                } catch (err) {
                    showMsg(bar, friendly(err), 'is-bad');
                }

                input.disabled = false;
            });
        });

        /*  A cold gig guide run takes about five minutes, so the button says so
        rather than looking stuck. */
        const sync = document.getElementById('ad-sync-gigs');
        if (sync) {
            sync.addEventListener('click', async () => {
                const bar = document.getElementById('ad-gig-msg');
                sync.disabled = true;
                showMsg(bar, 'Looking… this can take a few minutes the first time.', '');

                try {
                    const d = await call('syncGigGuideNow', {});
                    bar.className = 'ad-action-msg is-ok';
                    bar.textContent =
                        `${d.events} event${d.events === 1 ? '' : 's'} listed` +
                        ` (${d.pagesRead} page${d.pagesRead === 1 ? '' : 's'} read,` +
                        ` ${d.fromCache} unchanged` +
                        `${d.removed ? `, ${d.removed} removed` : ''}).` +
                        `${d.errors && d.errors.length ? ` ${d.errors.length} source problem${d.errors.length === 1 ? '' : 's'}: ${d.errors[0]}` : ''}`;
                } catch (err) {
                    bar.className = 'ad-action-msg is-bad';
                    bar.textContent = friendly(err);
                }

                sync.disabled = false;
            });
        }

        const seed = document.getElementById('ad-seed');
        if (!seed) return;

        seed.addEventListener('click', async () => {
            if (!window.confirm('Lay out this event from the default layout? Nothing already there is overwritten.')) return;

            const bar = document.getElementById('ad-action-msg');
            seed.disabled = true;
            showMsg(bar, 'Working…', '');

            try {
                const d = await call('seedEvent', { eventId: state.activeEventId });
                bar.className = 'ad-action-msg is-ok';
                bar.textContent =
                    `${d.eventCreated ? 'Event created. ' : 'Event already existed. '}` +
                    `Added ${d.addedSites} site${d.addedSites === 1 ? '' : 's'} and ` +
                    `${d.addedCats} categor${d.addedCats === 1 ? 'y' : 'ies'}.`;
            } catch (err) {
                bar.className = 'ad-action-msg is-bad';
                bar.textContent = friendly(err);
            }

            seed.disabled = false;
        });
    }
};
