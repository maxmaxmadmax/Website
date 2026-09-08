/* --------------------------------------------------------------------------
   SERVICES PAGE - slider behaviour

   Everything here is looked up inside #sg-services-page and the whole file
   stops immediately if that element is not on the page, so this script can
   never touch another page even though it sits in the shared js folder.

   The slider itself is a plain horizontally scrolling element with CSS snap
   points (see services.css). Swiping, trackpad gestures, dragging the
   scrollbar and the keyboard all work without any of this. What is added
   here is the polish on top:

     - stepping the banner along on its own every couple of seconds
     - arrows, and disabling them at either end
     - the active label, the compact "03 / 09" line and the progress bar
     - the hero video, given a source only on a big screen

   The page scrolls normally. Nothing here touches the vertical wheel or
   pins anything - the banner is an ordinary block at the top of the page
   and you scroll straight past it.
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
    function goTo(index, instant) {
        var i = Math.max(0, Math.min(slides.length - 1, index));
        track.scrollTo({
            left: slides[i].offsetLeft,
            behavior: (instant || reduceMotion) ? 'auto' : 'smooth'
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

        /*  The bar sits under the label it belongs to.

            Even eighths look wrong here: the labels are different widths, so
            a fixed slice drifts away from the word it is meant to be marking
            - far enough by the sixth slide that the bar sits under the next
            label along. Measured against the bar's own box rather than using
            offsetLeft, which is relative to a different element.

            When the labels are hidden and the compact "06 / 08" line is
            showing instead, there is nothing to line up with, so it goes
            back to even slices as a plain progress meter.                 */
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

    /*  Scroll fires in bursts, and paint measures elements, so it is held to
        one run per frame. Doing it on a timer instead meant the labels
        lagged behind the picture; doing it on every event meant measuring
        the page dozens of times a second while it was moving. */
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

       The banner steps to the right every 2.5 seconds and starts again from
       the first slide after the last.

       It stops when it should:
         - while the pointer is over it, or something inside it has keyboard
           focus, so it never moves out from under someone reading it or
           about to click a button;
         - for a spell after any manual move, so pressing an arrow does not
           get overruled a moment later;
         - while the tab is in the background, or the banner is scrolled off
           screen, so it is not animating to nobody;
         - entirely, if the visitor has asked for reduced motion.

       The wrap back to the first slide is instant rather than a smooth
       sweep. Gliding back across eight slides reads as a glitch, and it is
       over in a frame.
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

    /* Called whenever the visitor moves the banner themselves. */
    function holdAuto() {
        heldUntil = Date.now() + DWELL * 2;
    }

    if (!reduceMotion) {
        var stageEl = page.querySelector('#sgs-stage');

        ['pointerenter', 'focusin'].forEach(function (name) {
            stageEl.addEventListener(name, function () { paused = true; });
        });

        ['pointerleave', 'focusout'].forEach(function (name) {
            stageEl.addEventListener(name, function () { paused = false; });
        });

        // a swipe or a drag of the track counts as taking over
        stageEl.addEventListener('pointerdown', holdAuto);
        stageEl.addEventListener('touchstart', holdAuto, { passive: true });

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
       The menu button

       Every page carries the same menu, and its button sells tickets. On
       this page there is nothing to buy - someone here is pricing an event
       - so it asks for a quote instead.

       Done from this file rather than by editing components/navbar.html,
       because that file is shared: changing it would change the button on
       the homepage, the events page and everywhere else. This script only
       ever runs on the services page, so the change cannot reach them.

       The menu is fetched and dropped in by js/main.js after this runs, so
       there may be nothing to change yet - hence watching for it to arrive
       and giving up quietly if it never does.
       --------------------------------------------------------------------- */
    (function swapMenuButton() {
        var host = document.getElementById('navbar');
        if (!host) { return; }

        var apply = function () {
            var btn = host.querySelector('.nav-ticket');
            if (!btn) { return false; }

            btn.textContent = 'Get a Quote';
            btn.setAttribute('href', '/contact');
            btn.removeAttribute('target');
            btn.removeAttribute('rel');
            return true;
        };

        if (apply()) { return; }

        if (!('MutationObserver' in window)) { return; }

        var watcher = new MutationObserver(function () {
            if (apply()) { watcher.disconnect(); }
        });
        watcher.observe(host, { childList: true, subtree: true });

        // the menu is a small local file; if it has not arrived by now it
        // is not coming, and the page is fine without the change
        setTimeout(function () { watcher.disconnect(); }, 8000);
    }());

    /* ---------------------------------------------------------------------
       The hero video

       Real event footage, and a large file, so it is only fetched on a wide
       screen and never when the visitor has asked for less motion. Every
       slide still reads correctly without it.

       Checked again on resize rather than only at startup, because a window
       that begins narrow and is widened should still end up with it.
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

    /* First run. Painted again once everything has loaded, because the very
       first measurement can happen before the track has been laid out - and
       a track that has no width yet looks like it is already at its end,
       which would leave the next arrow greyed out on arrival. */
    paint();
    setUpVideo();

    window.addEventListener('load', function () {
        paint();
        setUpVideo();
    });
}());
