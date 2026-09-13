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

/*  The reel behind the Friday Nights banner.

    Its own block rather than part of the countdown above - that one bails
    out early when there is no countdown on the page, which would take this
    with it.

    Somebody who has asked their system for less motion should not get a
    looping clip behind a headline. Pausing rather than hiding leaves the
    poster frame showing, so the banner still has a picture in it.       */
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

   ==========================================================================
   NAMING A DJ - two ways, and the first one wins
   ==========================================================================

   1. ADMIN -> ENTERTAINMENT. Book the act against the date and it saves.
      This is the one to use: no deploy, no code, and it is there for
      whoever is on the desk rather than for whoever has the repository.

   2. THE LIST BELOW, for a Friday somebody wants locked in before the
      admin page is next opened. Anything set in admin overrides it.

   Both are optional. A Friday named in neither says the DJ is still to be
   announced, which is true, and the card still looks finished.

   THE DATES ARE NOT IN EITHER. They are worked out from today, four
   Fridays ahead, so the list rolls itself forward every week. It used to
   be four dates typed into the HTML, which is why it sat there showing a
   Friday that had already been.
   ========================================================================== */
var EV_FRIDAYS = {
    '2026-09-18': 'kriss-kross',
    '2026-09-25': 'dj-charly-templar'
};

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
                /*  The name and nothing else. Every card used to carry
                    'SoundzGood DJs on rotation' underneath, which said
                    the same thing four times and said it loudest on the
                    cards that had a name on them.                    */
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

    /*  Drawn once from the list above so the dates are right immediately,
        then again if Firestore has anything to say. A failed call leaves
        the dates correct and the DJs unnamed, which is the honest state
        rather than a broken one.                                        */
    /*  THE TWO SOURCES, AND WHICH WINS

        The booked map is what is drawn. It starts as the short list in
        EV_FRIDAYS above and is replaced, date by date, by anything set in
        Admin -> Entertainment.

        Kept here rather than passed about because two things arrive at
        their own pace - the schedule and the roster - and whichever lands
        second must not undo the first. Each of them updates what it knows
        and asks for a redraw.                                          */
    var booked = {};
    Object.keys(EV_FRIDAYS).forEach(function (k) {
        booked[k] = { slug: EV_FRIDAYS[k] };
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

            /*  A night can hold more than one booking now - two acts, or
                two venues. The Grand View wins for these cards, because
                that is what Friday Nights is; anything else only fills a
                night nothing at the pub has claimed.                   */
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

   Seven days rather than the weekend. On a Sunday afternoon a weekend-only
   strip is down to whatever is left of today, which is a thin thing to put
   on the page - and somebody reading on Sunday is mostly wondering about
   the week ahead anyway.

   The listings and the cards come from js/weekend.js, the same as
   /gig-guide, so the two pages can never draw the same gig differently.

   THE SECTION STARTS HIDDEN and only appears once there is something in
   it. This is a bonus on the events page, not the point of it, and a
   heading with an apology under it is worse than no heading. A failed
   network call leaves the page exactly as it was.
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

        /*  A window that has just got wider can leave us past the end, on
            a page that no longer exists.                                */
        if (page > last) page = last;
        if (page < 0) page = 0;

        track.style.setProperty('--ev-wk-page', page);

        arrows.forEach(function (btn) {
            var dir = parseInt(btn.getAttribute('data-ev-wk'), 10);
            btn.disabled = dir < 0 ? page === 0 : page === last;
        });

        /*  Both arrows off means one page, and two dead controls say
            nothing worth the space.                                     */
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
