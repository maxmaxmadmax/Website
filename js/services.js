/* --------------------------------------------------------------------------
   SERVICES PAGE - slider behaviour

   Only runs inside #sg-services-page, so it never touches another page.

   The slider is overflow:hidden: it moves only when this file animates it
   (auto-step, arrows, labels, keyboard). Page scrolling is left alone.

   Also: the active label, the "03 / 09" counter, the progress bar, and
   the hero video (big screens only).
   -------------------------------------------------------------------------- */
(function () {
    'use strict';

    var page = document.getElementById('sg-services-page');
    if (!page) {
        return; // not the services page - do nothing at all
    }

    var track = page.querySelector('#sgs-track');
    if (!track) {
        return;
    }

    var slides = Array.prototype.slice.call(track.querySelectorAll('.sgs-slide'));
    var prevBtn = page.querySelector('#sgs-prev');
    var nextBtn = page.querySelector('#sgs-next');
    var navButtons = Array.prototype.slice.call(page.querySelectorAll('[data-sgs-go]'));
    var navList = page.querySelector('#sgs-nav-list');
    var compact = page.querySelector('#sgs-compact');
    var progress = page.querySelector('#sgs-progress-bar');
    var startBtn = page.querySelector('[data-sgs-start]');

    var names = navButtons.map(function (b) { return b.textContent.trim(); });
    var current = 0;

    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* How long each slide is shown before the banner moves on. */
    var DWELL = 2500;

    /* ---------------------------------------------------------------------
       Moving between slides
       --------------------------------------------------------------------- */
    /*  Animated frame by frame: smooth scrollTo is ignored on an
        overflow:hidden box. Each move cancels the one before it. */
    var SLIDE_MS = 420;
    var gliding = null;
    var glideTo = null;

    /*  No animation frames in a background tab, so land the move at once
        rather than freezing half-way. */
    document.addEventListener('visibilitychange', function () {
        if (document.hidden && gliding !== null) {
            window.cancelAnimationFrame(gliding);
            gliding = null;
            if (glideTo !== null) { track.scrollLeft = glideTo; }
        }
    });

    function goTo(index, instant) {
        var i = Math.max(0, Math.min(slides.length - 1, index));
        var to = slides[i].offsetLeft;

        if (gliding) {
            window.cancelAnimationFrame(gliding);
            gliding = null;
        }
        glideTo = to;

        if (instant || reduceMotion) {
            track.scrollLeft = to;
            paint();
            return;
        }

        var from = track.scrollLeft;
        var travel = to - from;
        if (!travel) { return; }

        var started = window.performance.now();

        gliding = window.requestAnimationFrame(function frame(now) {
            var p = Math.min(1, (now - started) / SLIDE_MS);

            /* ease in out - slow at both ends, quick through the middle */
            var eased = p < 0.5
                ? 2 * p * p
                : 1 - Math.pow(-2 * p + 2, 2) / 2;

            track.scrollLeft = from + travel * eased;

            if (p < 1) {
                gliding = window.requestAnimationFrame(frame);
            } else {
                gliding = null;
                track.scrollLeft = to;   /* land exactly, not a fraction off */
            }

            /*  Repaint here, not on the scroll event - a background tab may never
                fire it. */
            paint();
        });
    }

    /* Which slide sits in front of a given scroll position of the track. */
    function indexAt(scrollLeft) {
        var mid = scrollLeft + track.clientWidth / 2;
        for (var i = 0; i < slides.length; i++) {
            if (mid >= slides[i].offsetLeft && mid < slides[i].offsetLeft + slides[i].offsetWidth) {
                return i;
            }
        }
        return scrollLeft > 0 ? slides.length - 1 : 0;
    }

    /* Which slide is in front of us right now. Read from the scroll
       position, so a swipe, an arrow, a label and the timer all agree. */
    function currentIndex() {
        return indexAt(track.scrollLeft);
    }

    function atStart() { return currentIndex() === 0; }
    function atEnd() { return currentIndex() === slides.length - 1; }

    /* ---------------------------------------------------------------------
       Keeping the labels, arrows and bar in step
       --------------------------------------------------------------------- */
    function paint() {
        var i = currentIndex();
        current = i;

        navButtons.forEach(function (btn, n) {
            if (n === i) {
                btn.setAttribute('aria-current', 'true');
            } else {
                btn.removeAttribute('aria-current');
            }
        });

        if (compact) {
            compact.innerHTML = '<b>' + pad(i + 1) + '</b> / ' + pad(slides.length) +
                ' &mdash; ' + (names[i] || '');
        }

        /*  Line the bar up under its label (labels differ in width). When the
            labels are hidden, fall back to even slices. */
        if (progress) {
            var active = navButtons[i];
            /* offsetParent is null when an element is display:none, so this
               says whether the labels are showing without the cost of
               asking for computed styles on every frame. */
            var labelsShown = navList && navList.offsetParent !== null;

            if (labelsShown && active) {
                var barBox = progress.parentNode.getBoundingClientRect();
                var labelBox = active.getBoundingClientRect();
                progress.style.width = labelBox.width + 'px';
                progress.style.transform =
                    'translateX(' + (labelBox.left - barBox.left) + 'px)';
            } else {
                progress.style.width = (100 / slides.length) + '%';
                progress.style.transform = 'translateX(' + (i * 100) + '%)';
            }
        }

        if (prevBtn) { prevBtn.disabled = atStart(); }
        if (nextBtn) { nextBtn.disabled = atEnd(); }
    }

    function pad(n) {
        return (n < 10 ? '0' : '') + n;
    }

    /*  Held to one run per frame - scroll fires in bursts and paint
        measures elements. */
    var painting = false;
    track.addEventListener('scroll', function () {
        if (painting) { return; }
        painting = true;
        window.requestAnimationFrame(function () {
            painting = false;
            paint();
        });
    }, { passive: true });

    var resizeTimer;
    window.addEventListener('resize', function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            paint();
            setUpVideo();
        }, 120);
    });

    /* ---------------------------------------------------------------------
       Controls
       --------------------------------------------------------------------- */
    if (prevBtn) {
        prevBtn.addEventListener('click', function () { holdAuto(); goTo(currentIndex() - 1); });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', function () { holdAuto(); goTo(currentIndex() + 1); });
    }

    navButtons.forEach(function (btn) {
        btn.addEventListener('click', function () {
            holdAuto();
            goTo(parseInt(btn.getAttribute('data-sgs-go'), 10) || 0);
        });
    });

    if (startBtn) {
        startBtn.addEventListener('click', function () { holdAuto(); goTo(1); });
    }

    /* Left and right move between slides while the slider has the focus.
       Home and End jump to either end. Up and down are deliberately left
       alone so the page still scrolls with the keyboard. */
    track.addEventListener('keydown', function (ev) {
        holdAuto();

        if (ev.key === 'ArrowRight') {
            ev.preventDefault();
            goTo(currentIndex() + 1);
        } else if (ev.key === 'ArrowLeft') {
            ev.preventDefault();
            goTo(currentIndex() - 1);
        } else if (ev.key === 'Home') {
            ev.preventDefault();
            goTo(0);
        } else if (ev.key === 'End') {
            ev.preventDefault();
            goTo(slides.length - 1);
        }
    });

    /* ---------------------------------------------------------------------
       Moving along on its own

       Steps right every 2.5 seconds, wrapping instantly to the first slide.
       Pauses while it has keyboard focus, for 5 seconds after a manual move,
       while the tab is hidden or the banner is off screen, and entirely for
       reduced motion.
       --------------------------------------------------------------------- */
    var timer = null;
    var paused = false;
    var heldUntil = 0;

    function step() {
        if (paused || Date.now() < heldUntil) { return; }

        var i = currentIndex();
        if (i >= slides.length - 1) {
            goTo(0, true);          // straight back to the start
        } else {
            goTo(i + 1);
        }
    }

    function startAuto() {
        if (reduceMotion || timer) { return; }
        timer = setInterval(step, DWELL);
    }

    function stopAuto() {
        clearInterval(timer);
        timer = null;
    }

    /*  Called when the visitor moves the banner themselves. Pauses
        auto-step for five seconds. */
    var HOLD = 5000;

    function holdAuto() {
        heldUntil = Date.now() + HOLD;
    }

    if (!reduceMotion) {
        var stageEl = page.querySelector('#sgs-stage');

        /*  Keyboard focus parks it so people tabbing through can read.
            Hover does not. */
        stageEl.addEventListener('focusin', function () { paused = true; });
        stageEl.addEventListener('focusout', function () { paused = false; });

        document.addEventListener('visibilitychange', function () {
            if (document.hidden) { stopAuto(); } else { startAuto(); }
        });

        /*  Only runs while the banner is actually on screen. */
        if ('IntersectionObserver' in window) {
            new IntersectionObserver(function (entries) {
                if (entries[0].isIntersecting) { startAuto(); } else { stopAuto(); }
            }, { threshold: 0.35 }).observe(stageEl);
        } else {
            startAuto();
        }
    }

    /* ---------------------------------------------------------------------
       The hero video

       Large file: only loaded on a wide screen and not for reduced motion.
       Re-checked on resize so a widened window still gets it.
       --------------------------------------------------------------------- */
    var video = page.querySelector('#sgs-hero-video');

    function setUpVideo() {
        if (!video || reduceMotion) { return; }
        if (video.getAttribute('src')) { return; }          // already running
        if (!window.matchMedia('(min-width: 901px)').matches) { return; }

        var src = video.getAttribute('data-src');
        if (!src) { return; }

        video.setAttribute('src', src);
        video.load();

        var playing = video.play();
        if (playing && typeof playing.catch === 'function') {
            // autoplay refused - the gradient behind it is enough
            playing.catch(function () {});
        }
    }

    /* Fades the "scroll on for more" hint out once the page starts moving. */
    window.addEventListener('scroll', function () {
        page.classList.toggle('is-scrolled', window.scrollY > 40);
    }, { passive: true });

    /* First run. Painted again after load - the track may have no width
       yet, which would grey out the next arrow. */
    paint();
    setUpVideo();

    window.addEventListener('load', function () {
        paint();
        setUpVideo();
    });
}());

/* --------------------------------------------------------------------------
   THE REGION SPLIT

   Two photos in one band (coast left, outback right) joined at
   --sgs-split. The first time the band is seen the split sweeps across
   once; after that it eases toward the cursor. Does nothing for reduced
   motion. Kept separate from the slider, which exits early when there is
   no slider on the page.
   -------------------------------------------------------------------------- */
(function () {
    'use strict';

    var band = document.querySelector('#sg-services-page .sgs-region');
    if (!band) return;

    var mq = window.matchMedia;
    if (mq && mq('(prefers-reduced-motion: reduce)').matches) return;

    var canHover = !mq || !mq('(hover: none)').matches;

    var INTRO_FROM = 12;
    var INTRO_TO = 88;
    var INTRO_MS = 2600;

    /*  How hard the split is pulled toward the cursor each frame. Low
        enough to read as easing, high enough that it is clearly following
        you rather than wandering off on its own. */
    var CHASE = 0.14;

    var current = 50;
    var target = 50;
    var frame = null;
    var introUntil = 0;          /* while set, the intro owns the split */

    function paint() {
        band.style.setProperty('--sgs-split', current.toFixed(2) + '%');
    }

    function run() {
        if (frame === null) frame = window.requestAnimationFrame(step);
    }

    function step(now) {
        frame = null;

        if (introUntil) {
            var left = introUntil - now;

            if (left <= 0) {
                introUntil = 0;
                current = INTRO_TO;
                target = INTRO_TO;   /* the cursor takes over from here */
                paint();
                return;
            }

            var p = 1 - (left / INTRO_MS);
            /* ease in out - slow at both ends, quicker through the middle */
            var eased = p < 0.5
                ? 2 * p * p
                : 1 - Math.pow(-2 * p + 2, 2) / 2;

            current = INTRO_FROM + (INTRO_TO - INTRO_FROM) * eased;
            paint();
            run();
            return;
        }

        var diff = target - current;

        if (Math.abs(diff) < 0.08) {
            current = target;
            paint();
            return;              /* settled - stop asking for frames */
        }

        current += diff * CHASE;
        paint();
        run();
    }

    /*  The intro waits until the band is on screen, or nobody would see it. */
    function startIntro() {
        current = INTRO_FROM;
        target = INTRO_TO;
        introUntil = window.performance.now() + INTRO_MS;
        paint();
        run();
    }

    if ('IntersectionObserver' in window) {
        var watcher = new IntersectionObserver(function (entries) {
            if (!entries[0].isIntersecting) return;
            watcher.disconnect();        /* once, not every time it scrolls past */
            startIntro();
        }, { threshold: 0.4 });
        watcher.observe(band);
    } else {
        startIntro();
    }

    if (!canHover) return;

    band.addEventListener('mousemove', function (ev) {
        /*  The cursor interrupts the intro rather than fighting it. Somebody
            who has already reached for the mouse does not need to be shown
            what the band does. */
        introUntil = 0;

        var box = band.getBoundingClientRect();
        var pct = ((ev.clientX - box.left) / box.width) * 100;

        target = Math.max(0, Math.min(100, pct));
        run();
    });
}());


/* --------------------------------------------------------------------------
   THE ANNUAL EVENTS ROW

   Pages the row of annual events. Counts the cards and sets a page number
   on the track; the CSS does the movement.

   How many fit per page comes from --sgs-an-per in events.css (set by its
   media queries), so new breakpoints need no change here. Without JS the
   row shows its first four cards.
   -------------------------------------------------------------------------- */
(function () {
    'use strict';

    var section = document.querySelector('.sgs-annual');
    if (!section) return;

    var track = document.getElementById('sgs-annual-track');
    var dots = document.getElementById('sgs-annual-dots');
    var count = document.getElementById('sgs-annual-count');
    if (!track) return;

    var cards = track.querySelectorAll('.sgs-an-card').length;
    if (!cards) return;

    var arrows = Array.prototype.slice.call(
        section.querySelectorAll('[data-sgs-annual]')
    );

    var page = 0;
    var built = 0;          /* how many dashes are in the DOM right now */

    function perView() {
        var raw = window.getComputedStyle(section)
            .getPropertyValue('--sgs-an-per');
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

        track.style.setProperty('--sgs-an-page', page);

        arrows.forEach(function (btn) {
            var dir = parseInt(btn.getAttribute('data-sgs-annual'), 10);
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
            page += parseInt(btn.getAttribute('data-sgs-annual'), 10) || 0;
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
