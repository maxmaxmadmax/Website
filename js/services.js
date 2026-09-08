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
     - the mouse wheel moving sideways instead of down while the slider is
       filling the screen
     - the hero video, given a source only on a big screen

   Nothing here traps the page. The wheel is only borrowed while the slider
   is genuinely on screen and has somewhere left to go; at either end the
   event is left alone and the page scrolls on as normal.
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

    /* ---------------------------------------------------------------------
       Moving between slides
       --------------------------------------------------------------------- */
    function goTo(index) {
        var i = Math.max(0, Math.min(slides.length - 1, index));
        track.scrollTo({
            left: slides[i].offsetLeft,
            behavior: reduceMotion ? 'auto' : 'smooth'
        });
    }

    /* Which slide is in front of us right now. Worked out from the scroll
       position rather than tracked separately, so a swipe, a keypress and an
       arrow click all end up agreeing. */
    function currentIndex() {
        var mid = track.scrollLeft + track.clientWidth / 2;
        for (var i = 0; i < slides.length; i++) {
            if (mid >= slides[i].offsetLeft && mid < slides[i].offsetLeft + slides[i].offsetWidth) {
                return i;
            }
        }
        return track.scrollLeft > 0 ? slides.length - 1 : 0;
    }

    function atStart() { return track.scrollLeft <= 2; }
    function atEnd() {
        return track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
    }

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
       Mouse wheel

       The picture glides sideways with the wheel, one to one, and settles
       onto the nearest slide when you stop. It is not stepped: an earlier
       version moved a whole slide per gesture and then ignored the wheel for
       half a second so it would not run away on trackpad inertia, which made
       the page feel like it was lagging behind the hand. Following the
       gesture directly and letting it land afterwards is both smoother and
       more responsive.

       Snapping is switched off while the wheel is turning - with it left on,
       the browser drags the track back to a slide edge between every event
       and the movement stutters. It goes back on when the gesture ends,
       which is what locks the slide into place.

       The moment there is no next slide the event is left alone, so the
       visitor carries straight on down the page and can scroll back up the
       same way. Touch is never touched - swiping is already right there.
       --------------------------------------------------------------------- */
    var finePointer = window.matchMedia('(pointer: fine)').matches;

    if (finePointer) {
        var gliding = false;
        var settleTimer;
        var glideFrom = 0;      // slide we set off from
        var glideBy = 0;        // how far the gesture pushed, in pixels

        var endGlide = function () {
            gliding = false;
            track.style.scrollSnapType = '';          // back to snapping

            var landOn = currentIndex();

            /*  A short flick still counts. Landing purely on whichever slide
                is nearest means a small deliberate nudge slides the picture
                a little and then puts it back, which feels like the page
                ignored you - and on a mouse with notched wheel it takes
                eight of them to get anywhere. So if the gesture had a clear
                direction but has not carried far enough to change slide,
                it goes one that way.                                     */
            if (landOn === glideFrom && Math.abs(glideBy) > track.clientWidth * 0.07) {
                landOn = glideFrom + (glideBy > 0 ? 1 : -1);
            }

            glideBy = 0;
            goTo(landOn);
        };

        track.addEventListener('wheel', function (ev) {
            // a genuine sideways gesture already does the right thing
            if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
                return;
            }

            var rect = track.getBoundingClientRect();
            var mostlyOnScreen = rect.top <= 4 && rect.bottom >= window.innerHeight - 4;
            if (!mostlyOnScreen) {
                return; // the slider is only passing through - leave the page alone
            }

            var goingDown = ev.deltaY > 0;

            // nothing left that way? let the page have the scroll
            if ((goingDown && atEnd()) || (!goingDown && atStart())) {
                if (gliding) { endGlide(); }
                return;
            }

            ev.preventDefault();

            if (!gliding) {
                gliding = true;
                glideFrom = currentIndex();
                glideBy = 0;
                track.style.scrollSnapType = 'none';
            }

            /*  A notched mouse wheel reports lines rather than pixels - 3 of
                them per notch - so it is scaled to roughly what the browser
                itself treats a line as.                                   */
            var step = ev.deltaMode === 1 ? ev.deltaY * 40 : ev.deltaY;
            track.scrollLeft += step;
            glideBy += step;

            clearTimeout(settleTimer);
            settleTimer = setTimeout(endGlide, 110);
        }, { passive: false });
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
