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
   THE ANNUAL EVENTS ROW

   Pages the row of annual events four at a time. All it does is count the
   cards, work out how many pages that makes, and set a number on the track
   - the CSS turns that number into the movement. Nothing is measured, so
   nothing here depends on the row having been laid out or painted yet.

   HOW MANY FIT is not a number in here: it is --ev-an-per in events.css,
   which the media queries change with the window. Reading it back means the
   arrows agree with what is actually on screen at any width, and adding a
   breakpoint to the stylesheet needs no change to this file.

   The dashes are built here rather than sat in the markup because how many
   there are depends on how many fit, which depends on the window. Eleven
   cards is three pages on a desktop and eleven on a phone.

   WITHOUT JAVASCRIPT the row shows its first four cards, the arrows do
   nothing and there are no dashes. That is a smaller version of this
   section rather than a broken one, which is the right way round for
   something this far down the page.
   -------------------------------------------------------------------------- */
(function () {
    'use strict';

    var section = document.querySelector('.ev-annual');
    if (!section) return;

    var track = document.getElementById('ev-annual-track');
    var dots = document.getElementById('ev-annual-dots');
    var count = document.getElementById('ev-annual-count');
    if (!track) return;

    var cards = track.querySelectorAll('.ev-an-card').length;
    if (!cards) return;

    var arrows = Array.prototype.slice.call(
        section.querySelectorAll('[data-ev-annual]')
    );

    var page = 0;
    var built = 0;          /* how many dashes are in the DOM right now */

    function perView() {
        var raw = window.getComputedStyle(section)
            .getPropertyValue('--ev-an-per');
        var n = parseInt(raw, 10);
        return n > 0 ? n : 1;
    }

    function pages() {
        return Math.max(1, Math.ceil(cards / perView()));
    }

    /*  Rebuilt only when the number has actually changed - a resize that
        does not cross a breakpoint should not throw the dashes away and
        make new ones.                                                    */
    function buildDots(total) {
        if (!dots || built === total) return;
        built = total;
        dots.innerHTML = '';

        if (total < 2) return;   /* one page needs no page indicator */

        for (var i = 0; i < total; i++) {
            var b = document.createElement('button');
            b.type = 'button';
            b.setAttribute('role', 'tab');
            b.setAttribute('data-ev-page', i);
            b.setAttribute('aria-label', 'Page ' + (i + 1) + ' of ' + total);
            dots.appendChild(b);
        }
    }

    function paint() {
        var total = pages();
        var last = total - 1;

        /*  A window that has just got wider can leave us past the end, on a
            page that no longer exists. Pull back rather than showing a row
            of nothing.                                                    */
        if (page > last) page = last;
        if (page < 0) page = 0;

        track.style.setProperty('--ev-an-page', page);

        arrows.forEach(function (btn) {
            var dir = parseInt(btn.getAttribute('data-ev-annual'), 10);
            btn.disabled = dir < 0 ? page === 0 : page === last;
        });

        buildDots(total);

        if (dots) {
            Array.prototype.forEach.call(dots.children, function (b, i) {
                b.setAttribute('aria-selected', i === page ? 'true' : 'false');
            });
        }

        if (count) {
            var per = perView();
            var first = page * per + 1;
            var lastCard = Math.min(cards, first + per - 1);

            count.textContent = first === lastCard
                ? first + ' of ' + cards
                : first + '–' + lastCard + ' of ' + cards;
        }
    }

    arrows.forEach(function (btn) {
        btn.addEventListener('click', function () {
            page += parseInt(btn.getAttribute('data-ev-annual'), 10) || 0;
            paint();
        });
    });

    /*  One listener on the strip rather than one per dash, so the dashes
        can be thrown away and rebuilt without taking their handlers with
        them.                                                             */
    if (dots) {
        dots.addEventListener('click', function (ev) {
            var b = ev.target.closest('[data-ev-page]');
            if (!b) return;
            page = parseInt(b.getAttribute('data-ev-page'), 10) || 0;
            paint();
        });
    }

    /*  Resizing changes how many fit, which changes how many pages there
        are. Cheap enough to just redo the sums.                          */
    window.addEventListener('resize', paint);

    paint();
}());
