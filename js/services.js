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

        if (progress) {
            progress.style.width = (100 / slides.length) + '%';
            progress.style.transform = 'translateX(' + (i * 100) + '%)';
        }

        if (prevBtn) { prevBtn.disabled = atStart(); }
        if (nextBtn) { nextBtn.disabled = atEnd(); }
    }

    function pad(n) {
        return (n < 10 ? '0' : '') + n;
    }

    /* Scroll events fire in bursts; only redraw once the run has settled. */
    var settle;
    track.addEventListener('scroll', function () {
        clearTimeout(settle);
        settle = setTimeout(paint, 60);
    }, { passive: true });

    window.addEventListener('resize', function () {
        clearTimeout(settle);
        settle = setTimeout(function () {
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

       While the slider fills the screen, a downward wheel moves to the next
       slide instead of scrolling the page. The moment there is no next slide
       the event is left alone, so the visitor carries straight on down to the
       rest of the page and can scroll back up again the same way.

       Only for mouse and trackpad. Touch is never touched - swiping is
       already the right gesture there.
       --------------------------------------------------------------------- */
    var finePointer = window.matchMedia('(pointer: fine)').matches;

    if (finePointer && !reduceMotion) {
        var wheelLock = false;

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
                return;
            }

            ev.preventDefault();

            // one slide per gesture, rather than flying through on inertia
            if (wheelLock) {
                return;
            }
            wheelLock = true;
            setTimeout(function () { wheelLock = false; }, 620);

            goTo(currentIndex() + (goingDown ? 1 : -1));
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
