/* ==========================================================================
   EVENTS PAGE - events.html. Each part stops at once if its element is not
   on the page.

   COUNTDOWN   ticks down to the doors time (data-doors on #ev-countdown)
   REEL        the Friday Nights video respects reduced motion
   FRIDAYS     the next four Friday Nights, from Admin > Entertainment
   WEEK        the what's-on strip (cards from js/site/weekend.js, slider from main.js)
   ========================================================================== */

/* ==========================================================================
   COUNTDOWN - data-doors carries the Queensland offset (+10:00), so the
   count is right wherever the visitor is
   ========================================================================== */
(function () {
    'use strict';

    var box = document.getElementById('ev-countdown');
    if (!box) return;

    var doors = new Date(box.getAttribute('data-doors'));
    if (isNaN(doors.getTime())) {
        box.hidden = true; // a date we cannot read is worse than none
        return;
    }

    var fields = {
        days: box.querySelector('[data-cd="days"]'),
        hours: box.querySelector('[data-cd="hours"]'),
        mins: box.querySelector('[data-cd="mins"]'),
        secs: box.querySelector('[data-cd="secs"]')
    };
    var label = box.querySelector('.ev-countdown-label');
    var when = box.querySelector('[data-cd="when"]');
    var timer = null;

    /* The doors time written out in Bowen's time, not the visitor's */
    function describeDoors() {
        try {
            return doors.toLocaleString('en-AU', {
                timeZone: 'Australia/Brisbane',
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit'
            });
        } catch (err) {
            return doors.toDateString(); // no time zone support
        }
    }

    function pad(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function tick() {
        var left = doors.getTime() - Date.now();

        if (left <= 0) {
            stop();
            box.classList.add('is-open');
            if (label) label.textContent = 'Doors are open';
            var units = box.querySelector('.ev-countdown-units');
            if (units) units.hidden = true;
            return;
        }

        var secs = Math.floor(left / 1000);
        if (fields.days) fields.days.textContent = Math.floor(secs / 86400);
        if (fields.hours) fields.hours.textContent = pad(Math.floor((secs % 86400) / 3600));
        if (fields.mins) fields.mins.textContent = pad(Math.floor((secs % 3600) / 60));
        if (fields.secs) fields.secs.textContent = pad(secs % 60);
    }

    function start() {
        if (timer) return;
        tick();
        timer = setInterval(tick, 1000);
    }

    function stop() {
        clearInterval(timer);
        timer = null;
    }

    if (when) when.textContent = describeDoors();

    /* Nothing to count while the tab is in the background */
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) stop();
        else start();
    });

    start();
})();

/* ==========================================================================
   REEL
   ========================================================================== */
(function () {
    'use strict';

    var video = document.getElementById('ev-res-video');
    if (!video) return;

    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        video.removeAttribute('autoplay');
        video.pause(); // the poster frame still shows
    }
})();

/* ==========================================================================
   FRIDAYS - who is playing comes from Admin > Entertainment (gigNights),
   falling back to SG_FRIDAY_SEED in js/site/roster.js. The dates roll forward
   from today, four Fridays ahead.
   ========================================================================== */
(function () {
    'use strict';

    var grid = document.getElementById('ev-fri-grid');
    if (!grid) return;

    var HOW_MANY = 4;
    var W = window.SGWeekend;
    var roster = window.SG_ROSTER_BY_SLUG || {};
    var esc = window.SG.esc;

    /* The next four Fridays, today included if today is a Friday */
    function fridays() {
        var out = [];
        var d = new Date();
        d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7));
        for (var i = 0; i < HOW_MANY; i++) {
            out.push(new Date(d));
            d.setDate(d.getDate() + 7);
        }
        return out;
    }

    function key(d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function label(d) {
        return 'Fri ' + d.getDate() + ' ' + (W ? W.MONTHS[d.getMonth()] : '');
    }

    function card(d, booked) {
        var act = booked && roster[booked.slug];
        var name = (act && act.name) || (booked && booked.name) || 'DJ To Be Announced';
        var art =
            act && act.photo
                ? ' style="--ev-art:url(\'' + esc(/^(https?:|\/|data:)/.test(act.photo) ? act.photo : '/' + act.photo) + '\')"'
                : '';

        return (
            '<article class="ev-fri"' +
            art +
            '>' +
            '<div class="ev-fri-art" aria-hidden="true"><span class="ev-fri-date">' +
            esc(label(d)) +
            '</span></div>' +
            '<div class="ev-fri-body"><h3>' +
            esc(name) +
            '</h3></div>' +
            '</article>'
        );
    }

    var nights = fridays();
    var booked = {};
    var seed = window.SG_FRIDAY_SEED || {};
    Object.keys(seed).forEach(function (k) {
        booked[k] = { slug: seed[k] };
    });

    function redraw() {
        grid.innerHTML = nights
            .map(function (d) {
                return card(d, booked[key(d)]);
            })
            .join('');
    }

    /* Drawn at once so the dates are right, then again as the roster and
       the schedule each arrive */
    redraw();

    if (window.SG_ROSTER_READY) {
        window.SG_ROSTER_READY.then(function () {
            roster = window.SG_ROSTER_BY_SLUG || roster;
            redraw();
        });
    }

    if (!W) return;

    W.loadCollection('gigNights')
        .then(function (rows) {
            rows.forEach(function (row) {
                if (!row.date || !row.slug) return;
                if (row.status === 'unconfirmed' || row.status === 'cancelled') return; // not public

                /* A night can hold more than one booking: the Grand View wins */
                var mine = /grand view/i.test(row.venue || '');
                if (!mine && booked[row.date] && booked[row.date].fromVenue) return;
                booked[row.date] = { slug: row.slug, fromVenue: mine };
            });
            redraw();
        })
        .catch(function (err) {
            if (window.console) console.warn('friday nights schedule unavailable', err);
        });
})();

/* ==========================================================================
   WEEK - the next seven days of listings. Starts hidden and only appears
   once there is something in it.
   ========================================================================== */
(function () {
    'use strict';

    var section = document.getElementById('ev-weekend');
    var track = document.getElementById('ev-weekend-grid');
    var when = document.getElementById('ev-weekend-when');
    if (!section || !track || !window.SGWeekend || !window.SGSlider) return;

    var W = window.SGWeekend;
    var DAYS_AHEAD = 7;

    var from = W.today();
    var to = new Date(from);
    to.setDate(to.getDate() + DAYS_AHEAD - 1);

    /* "Sunday 13 - Saturday 19 September", both months named across a month end */
    function saying() {
        var same = from.getMonth() === to.getMonth();
        var short = { weekday: 'long', day: 'numeric' };
        var full = { weekday: 'long', day: 'numeric', month: 'long' };
        return from.toLocaleDateString('en-AU', same ? short : full) + ' – ' + to.toLocaleDateString('en-AU', full);
    }

    W.loadGigs()
        .then(function (rows) {
            var soon = rows.filter(function (ev) {
                return ev.day && ev.day >= from && ev.day <= to;
            });
            if (!soon.length) return;

            track.innerHTML = soon.map(W.card).join('');
            if (when) when.textContent = saying();
            section.hidden = false;

            var arrows = Array.prototype.slice.call(section.querySelectorAll('[data-slide]'));
            window
                .SGSlider(track, arrows, {
                    onPaint: function (page, total) {
                        /* one page needs no arrows */
                        arrows.forEach(function (btn) {
                            btn.closest('.slide-arrows').hidden = total === 1;
                        });
                    }
                })
                .paint();
        })
        .catch(function (err) {
            if (window.console) console.warn('this week strip unavailable', err); // left hidden
        });
})();
