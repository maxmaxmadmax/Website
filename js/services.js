/* --------------------------------------------------------------------------
   SERVICES PAGE - slider behaviour

   Everything here is looked up inside #sg-services-page and the whole file
   stops immediately if that element is not on the page, so this script can
   never touch another page even though it sits in the shared js folder.

   The slider itself is a plain horizontally scrolling element with CSS snap
   points (see services.css). Swiping, trackpad gestures, dragging the
   scrollbar and the keyboard all work without any of this. What is added
   here is the polish on top:

     - arrows, and disabling them at either end
     - the active label, the compact "03 / 07" line and the progress bar
     - dragging with a mouse, which a scroll container does not do for free
     - the hero video, given a source only on a big screen

   Nothing here traps the page, and the vertical wheel is left entirely
   alone: it scrolls the page, as it does everywhere else on the site.
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

    /*  Pinned mode is for pointer devices with room for it. A phone or a
        tablet keeps the plain sideways scroller, where a swipe and the
        browser's own momentum are already better than anything here.    */
    var pinned = window.matchMedia('(min-width: 901px) and (pointer: fine)').matches;

    /*  How much of each screenful holds the slide still before it starts
        moving. A quarter each end, so it settles rather than drifting. */
    var HOLD = 0.25;

    var pinnedIndex = 0;

    /* ---------------------------------------------------------------------
       Moving between slides

       In pinned mode a slide is a position on the page, so going to one is
       an ordinary page scroll - which means the browser animates it, the
       same as clicking any other link on the site. Otherwise it is a scroll
       of the track itself.
       --------------------------------------------------------------------- */
    function goTo(index) {
        var i = Math.max(0, Math.min(slides.length - 1, index));

        if (pinned && page.classList.contains('is-pinned')) {
            var stageEl = page.querySelector('#sgs-stage');
            var runway = stageEl.offsetHeight - window.innerHeight;
            // the middle of that slide's held stretch
            var p = i / (slides.length - 1);
            window.scrollTo({
                top: Math.round(stageEl.offsetTop + runway * p),
                behavior: reduceMotion ? 'auto' : 'smooth'
            });
            return;
        }

        track.scrollTo({
            left: slides[i].offsetLeft,
            behavior: reduceMotion ? 'auto' : 'smooth'
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

    /* Which slide is in front of us right now. Read from whatever is doing
       the scrolling, so the labels, the arrows and the picture always
       agree however you got there. */
    function currentIndex() {
        return pinned && page.classList.contains('is-pinned')
            ? pinnedIndex
            : indexAt(track.scrollLeft);
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
        prevBtn.addEventListener('click', function () { goTo(currentIndex() - 1); });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', function () { goTo(currentIndex() + 1); });
    }

    navButtons.forEach(function (btn) {
        btn.addEventListener('click', function () {
            goTo(parseInt(btn.getAttribute('data-sgs-go'), 10) || 0);
        });
    });

    if (startBtn) {
        startBtn.addEventListener('click', function () { goTo(1); });
    }

    /* Left and right move between slides while the slider has the focus.
       Home and End jump to either end. Up and down are deliberately left
       alone so the page still scrolls with the keyboard. */
    track.addEventListener('keydown', function (ev) {
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
       PINNED MODE - the page scroll drives the picture

       On a computer the stage becomes a tall block of page, one screenful
       per slide, and the viewport inside it sticks to the top. How far down
       that block you have scrolled decides how far sideways the track is
       moved. So the picture glides across as you scroll normally, and the
       browser is doing all of the scrolling itself.

       That is the whole point. The two earlier attempts both intercepted
       the wheel and then moved the track in code, which meant fighting the
       browser's own momentum - it kept delivering events after a gesture
       had been declared finished, so the script would set a position while
       the browser was still animating to another one. That fight is what
       felt clunky and stuck. Nothing is intercepted now.

       LOCKING IN
       The movement is not a flat mapping. Inside each screenful the slide
       is held still for the first and last quarter and slides across the
       middle, so it settles on each one rather than drifting continuously.

       Touch keeps the plain sideways scroller with snap points instead -
       swiping is already the right gesture and native momentum there is
       better than anything worth writing.
       --------------------------------------------------------------------- */
    var stage = page.querySelector('#sgs-stage');
    var viewport = page.querySelector('#sgs-viewport');

    if (pinned && stage && viewport) {
        page.classList.add('is-pinned');

        var lastX = null;

        /*  How much page you scroll to cross one slide, as a fraction of the
            window. A whole screenful each felt like wading - nine slides
            meant nine screens before the reading below came into view. At
            0.7 the run is a little over six screens and each slide still
            gets a moment of its own, because a quarter of that at each end
            is a hold rather than movement.                               */
        var SEGMENT = 0.7;

        var measure = function () {
            var w = viewport.clientWidth;
            page.style.setProperty('--sgs-w', w + 'px');
            stage.style.height =
                Math.round(window.innerHeight * (1 + (slides.length - 1) * SEGMENT)) + 'px';
            return w;
        };

        var slideWidth = measure();

        var applyPin = function () {
            var vh = window.innerHeight;
            var top = stage.offsetTop;
            var runway = stage.offsetHeight - vh;      // scrollable distance
            if (runway <= 0) { return; }

            var p = (window.pageYOffset - top) / runway;
            p = Math.max(0, Math.min(1, p));

            var raw = p * (slides.length - 1);
            var i = Math.floor(raw);
            var f = raw - i;

            /*  Held, then across, then held. The clamp either side is what
                makes it land on a slide instead of drifting.             */
            var t = Math.max(0, Math.min(1, (f - HOLD) / (1 - HOLD * 2)));
            var eased = t * t * (3 - 2 * t);           // ease in and out

            var x = -(i + eased) * slideWidth;

            if (x !== lastX) {
                lastX = x;
                track.style.transform = 'translate3d(' + x + 'px,0,0)';
            }

            pinnedIndex = Math.min(slides.length - 1, i + (eased >= 0.5 ? 1 : 0));

            // let the buttons and hint out of the way once we are past
            page.classList.toggle('is-past', p >= 1 &&
                window.pageYOffset > top + runway + 4);
        };

        var ticking = false;
        var onScroll = function () {
            if (ticking) { return; }
            ticking = true;
            window.requestAnimationFrame(function () {
                ticking = false;
                applyPin();
                paint();
            });
        };

        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', function () {
            slideWidth = measure();
            lastX = null;
            applyPin();
        });

        applyPin();
    }

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
