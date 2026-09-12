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


/* --------------------------------------------------------------------------
   WHAT'S ON THIS WEEKEND

   The strip under the featured event. It asks js/weekend.js for the
   listings and for which days count as this weekend, so it can never
   disagree with /gig-guide about either.

   THE SECTION STARTS HIDDEN and is only shown once there is something to
   put in it. That way round on purpose: this is a bonus on the events
   page, not the point of it, and a heading with an apology under it is
   worse than no heading. A failed network call leaves the page exactly as
   it was.
   -------------------------------------------------------------------------- */
(function () {
    'use strict';

    var section = document.getElementById('ev-weekend');
    var grid = document.getElementById('ev-weekend-grid');
    var when = document.getElementById('ev-weekend-when');

    if (!section || !grid || !window.SGWeekend) return;

    var W = window.SGWeekend;
    var range = W.weekendRange();

    /*  "Friday 12 - Sunday 14 September", or with both months named when
        the weekend straddles the end of one.                            */
    function saying() {
        var same = range.start.getMonth() === range.end.getMonth();
        var day = { weekday: 'long', day: 'numeric' };
        var full = { weekday: 'long', day: 'numeric', month: 'long' };

        return range.start.toLocaleDateString('en-AU', same ? day : full) +
               ' \u2013 ' +
               range.end.toLocaleDateString('en-AU', full);
    }

    W.loadGigs().then(function (rows) {
        var onNow = rows.filter(function (ev) {
            return W.isThisWeekend(ev.day, range);
        });

        if (!onNow.length) return;

        grid.innerHTML = onNow.map(W.card).join('');
        if (when) when.textContent = saying();
        section.hidden = false;
    }).catch(function (err) {
        /*  Left hidden. Nothing on the page depends on it.             */
        if (window.console) console.warn('weekend strip unavailable', err);
    });
}());
