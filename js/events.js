/* --------------------------------------------------------------------------
   EVENTS PAGE - the countdown on the featured event

   The whole file stops immediately if the countdown is not on the page, so
   it can never touch another page even though it sits in the shared js
   folder.

   One value drives everything: the data-doors attribute on the countdown in
   events.html. The ticking numbers and the line of text underneath are both
   worked out from it, so changing the doors time in one place changes both.

   The date carries the Queensland offset (+10:00), which means the count is
   to the right moment no matter where the visitor is reading from.
   -------------------------------------------------------------------------- */
(function () {
    'use strict';

    var box = document.getElementById('ev-countdown');
    if (!box) {
        return; // not the events page, or no countdown on it
    }

    var doors = new Date(box.getAttribute('data-doors'));
    if (isNaN(doors.getTime())) {
        // a date we cannot read is worse than none at all
        box.hidden = true;
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

    /*  The doors time written out, in Bowen's time rather than the
        visitor's - the event happens when it happens. */
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
            // an old browser without time zone support still gets a date
            return doors.toDateString();
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
            if (label) { label.textContent = 'Doors are open'; }

            var units = box.querySelector('.ev-countdown-units');
            if (units) { units.hidden = true; }
            return;
        }

        var secs = Math.floor(left / 1000);
        var days = Math.floor(secs / 86400);
        var hours = Math.floor((secs % 86400) / 3600);
        var mins = Math.floor((secs % 3600) / 60);

        if (fields.days) { fields.days.textContent = days; }
        if (fields.hours) { fields.hours.textContent = pad(hours); }
        if (fields.mins) { fields.mins.textContent = pad(mins); }
        if (fields.secs) { fields.secs.textContent = pad(secs % 60); }
    }

    function start() {
        if (timer) { return; }
        tick();
        timer = setInterval(tick, 1000);
    }

    function stop() {
        clearInterval(timer);
        timer = null;
    }

    if (when) {
        when.textContent = describeDoors();
    }

    /* Nothing to count while the tab is in the background. */
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) { stop(); } else { start(); }
    });

    start();
}());

/*  The reel behind the Friday Nights banner. Separate from the countdown
    block above, which stops early on pages without a countdown.
    Respects "reduce motion": paused, so the poster frame still shows.   */
(function () {
    'use strict';

    var video = document.getElementById('ev-res-video');
    if (!video) return;

    if (window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        video.removeAttribute('autoplay');
        video.pause();
    }
}());


/* ==========================================================================
   THE FRIDAY NIGHTS LINE UP

   Who is playing comes from Admin -> Entertainment, falling back to
   SG_FRIDAY_SEED in js/roster.js. A Friday in neither says the DJ is still
   to be announced.

   The dates are worked out from today, four Fridays ahead, so the list
   rolls itself forward every week.
   ========================================================================== */
(function () {
    'use strict';

    var grid = document.getElementById('ev-fri-grid');
    if (!grid) return;

    var HOW_MANY = 4;
    var roster = window.SG_ROSTER_BY_SLUG || {};

    function esc(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /*  The next four Fridays, today included if today is a Friday - the
        night is still ahead of you at breakfast.                        */
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
        return d.getFullYear() + '-' +
               String(d.getMonth() + 1).padStart(2, '0') + '-' +
               String(d.getDate()).padStart(2, '0');
    }

    function label(d) {
        var W = window.SGWeekend;
        return 'Fri ' + d.getDate() + ' ' + (W ? W.MONTHS[d.getMonth()] : '');
    }

    function card(d, booked) {
        var act = booked && roster[booked.slug];
        var name = (act && act.name) || (booked && booked.name) || 'DJ To Be Announced';
        var art = act && act.photo
            ? ' style="--ev-art:url(\'' + esc(act.photo) + '\')"'
            : '';

        return '' +
            '<article class="ev-fri"' + art + '>' +
              '<div class="ev-fri-art" aria-hidden="true">' +
                '<span class="ev-fri-date">' + esc(label(d)) + '</span>' +
              '</div>' +
              '<div class="ev-fri-body">' +
                /*  The name and nothing else. */
                '<h3>' + esc(name) + '</h3>' +
              '</div>' +
            '</article>';
    }

    var nights = fridays();

    function draw(booked) {
        grid.innerHTML = nights.map(function (d) {
            return card(d, booked[key(d)]);
        }).join('');
    }

    /*  Drawn once straight away so the dates are right, then again when
        Firestore answers. A failed call leaves the DJs unnamed.         */
    /*  Which wins: the booked map starts as SG_FRIDAY_SEED (js/roster.js)
        and is replaced date by date by anything set in Admin ->
        Entertainment. The schedule and the roster arrive separately; each
        updates what it knows and asks for a redraw.                    */
    var booked = {};
    var seed = window.SG_FRIDAY_SEED || {};
    Object.keys(seed).forEach(function (k) {
        booked[k] = { slug: seed[k] };
    });

    function redraw() { draw(booked); }

    redraw();

    /*  The roster carries the names and the photographs, so a card can
        only be finished once it has landed.                            */
    if (window.SG_ROSTER_READY) {
        window.SG_ROSTER_READY.then(function () {
            roster = window.SG_ROSTER_BY_SLUG || roster;
            redraw();
        });
    }

    if (!window.SGWeekend) return;

    /*  The schedule is every booked act on every date, not only Fridays -
        it is what Admin -> Entertainment writes. The Fridays are picked
        out of it here.                                                 */
    window.SGWeekend.loadCollection('talentSchedule').then(function (rows) {
        rows.forEach(function (row) {
            if (!row.date || !row.slug) return;
            if (row.status === 'unconfirmed') return;   // held, not paid yet - not public

            /*  A night can hold more than one booking. The Grand View wins for
                these cards; anything else only fills a night the pub
                hasn't claimed.                                         */
            var mine = /grand view/i.test(row.venue || '');
            if (!mine && booked[row.date] && booked[row.date].fromVenue) return;

            booked[row.date] = {
                slug: row.slug,
                fromVenue: mine
            };
        });

        redraw();
    }).catch(function (err) {
        if (window.console) console.warn('friday nights schedule unavailable', err);
    });
}());


/* --------------------------------------------------------------------------
   WHAT'S ON THIS WEEK

   The strip under Friday Nights: the next seven days of listings, four on
   screen with an arrow for the rest.

   Listings and cards come from js/weekend.js, the same as /gig-guide.

   The section starts hidden and only appears once there is something in
   it. A failed network call leaves the page as it was.
   -------------------------------------------------------------------------- */
(function () {
    'use strict';

    var section = document.getElementById('ev-weekend');
    var view = document.getElementById('ev-weekend-view');
    var track = document.getElementById('ev-weekend-grid');
    var when = document.getElementById('ev-weekend-when');

    if (!section || !track || !window.SGWeekend) return;

    var W = window.SGWeekend;
    var DAYS_AHEAD = 7;

    var from = W.today();
    var to = new Date(from);
    to.setDate(to.getDate() + DAYS_AHEAD - 1);

    var page = 0;
    var arrows = Array.prototype.slice.call(section.querySelectorAll('[data-ev-wk]'));

    /*  "Sunday 13 - Saturday 19 September", with both months named when
        the week straddles the end of one.                               */
    function saying() {
        var same = from.getMonth() === to.getMonth();
        var short = { weekday: 'long', day: 'numeric' };
        var full = { weekday: 'long', day: 'numeric', month: 'long' };

        return from.toLocaleDateString('en-AU', same ? short : full) +
               ' \u2013 ' + to.toLocaleDateString('en-AU', full);
    }

    function perView() {
        if (!view) return 1;
        var n = parseInt(
            window.getComputedStyle(view).getPropertyValue('--ev-wk-per'), 10
        );
        return n > 0 ? n : 1;
    }

    function pages(count) {
        return Math.max(1, Math.ceil(count / perView()));
    }

    function paint(count) {
        var last = pages(count) - 1;

        /*  A wider window can leave us past the last page. */
        if (page > last) page = last;
        if (page < 0) page = 0;

        track.style.setProperty('--ev-wk-page', page);

        arrows.forEach(function (btn) {
            var dir = parseInt(btn.getAttribute('data-ev-wk'), 10);
            btn.disabled = dir < 0 ? page === 0 : page === last;
        });

        /*  Both arrows off means one page, so hide them. */
        arrows.forEach(function (btn) {
            btn.closest('.ev-wk-arrows').hidden = last === 0;
        });
    }

    W.loadGigs().then(function (rows) {
        var soon = rows.filter(function (ev) {
            return ev.day && ev.day >= from && ev.day <= to;
        });

        if (!soon.length) return;

        track.innerHTML = soon.map(W.card).join('');
        if (when) when.textContent = saying();
        section.hidden = false;

        arrows.forEach(function (btn) {
            btn.addEventListener('click', function () {
                page += parseInt(btn.getAttribute('data-ev-wk'), 10) || 0;
                paint(soon.length);
            });
        });

        window.addEventListener('resize', function () { paint(soon.length); });
        paint(soon.length);
    }).catch(function (err) {
        /*  Left hidden. Nothing on the page depends on it.             */
        if (window.console) console.warn('this week strip unavailable', err);
    });
}());
