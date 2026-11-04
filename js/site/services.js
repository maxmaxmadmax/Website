/* ==========================================================================
   SERVICES PAGE - only runs inside #sg-services-page.

   SLIDER     the services banner: glide, labels, counter, progress bar,
              keyboard, auto-step, the hero video
   REGION     the coast / outback split that sweeps once, then follows the cursor
   ANNUAL     the annual events row (window.SGSlider from js/site/main.js) with
              a dash per page and a "1-4 of 9" count
   ========================================================================== */
(function () {
    'use strict';

    /* Slow at both ends, quick through the middle (p from 0 to 1) */
    function easeInOut(p) {
        return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    }

    initSlider();
    initRegion();
    initAnnual();

    /* ======================================================================
       SLIDER - overflow:hidden, so it moves only when this code animates it
       (auto-step, arrows, labels, keyboard). Page scrolling is left alone.
       ====================================================================== */
    function initSlider() {
        var page = document.getElementById('sg-services-page');
        if (!page) return;

        var track = page.querySelector('#sgs-track');
        if (!track) return;

        var slides = Array.prototype.slice.call(track.querySelectorAll('.sgs-slide'));
        var prevBtn = page.querySelector('#sgs-prev');
        var nextBtn = page.querySelector('#sgs-next');
        var navButtons = Array.prototype.slice.call(page.querySelectorAll('[data-sgs-go]'));
        var navList = page.querySelector('#sgs-nav-list');
        var compact = page.querySelector('#sgs-compact');
        var progress = page.querySelector('#sgs-progress-bar');
        var startBtn = page.querySelector('[data-sgs-start]');
        var video = page.querySelector('#sgs-hero-video');

        var names = navButtons.map(function (b) {
            return b.textContent.trim();
        });

        var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        var DWELL = 2500; // each slide is shown this long before auto-step
        var SLIDE_MS = 420; // one glide
        var HOLD = 5000; // auto-step pauses this long after a manual move

        /* ---- moving between slides ---- */

        // Frame by frame: smooth scrollTo is ignored on an overflow:hidden box
        var gliding = null;
        var glideTo = null;

        // No animation frames in a background tab, so land the move at once
        document.addEventListener('visibilitychange', function () {
            if (document.hidden && gliding !== null) {
                window.cancelAnimationFrame(gliding);
                gliding = null;
                if (glideTo !== null) track.scrollLeft = glideTo;
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
            if (!travel) return;

            var started = window.performance.now();

            gliding = window.requestAnimationFrame(function frame(now) {
                var p = Math.min(1, (now - started) / SLIDE_MS);
                track.scrollLeft = from + travel * easeInOut(p);

                if (p < 1) {
                    gliding = window.requestAnimationFrame(frame);
                } else {
                    gliding = null;
                    track.scrollLeft = to; // land exactly, not a fraction off
                }

                // Repaint here, not on scroll - a background tab may never fire it
                paint();
            });
        }

        /* The slide in front, read from the scroll position, so a swipe, an
           arrow, a label and the timer all agree */
        function currentIndex() {
            var mid = track.scrollLeft + track.clientWidth / 2;
            for (var i = 0; i < slides.length; i++) {
                if (mid >= slides[i].offsetLeft && mid < slides[i].offsetLeft + slides[i].offsetWidth) return i;
            }
            return track.scrollLeft > 0 ? slides.length - 1 : 0;
        }

        /* ---- labels, counter, bar and arrows ---- */
        function pad(n) {
            return (n < 10 ? '0' : '') + n;
        }

        function paint() {
            var i = currentIndex();

            navButtons.forEach(function (btn, n) {
                if (n === i) btn.setAttribute('aria-current', 'true');
                else btn.removeAttribute('aria-current');
            });

            if (compact) {
                compact.innerHTML = '<b>' + pad(i + 1) + '</b> / ' + pad(slides.length) + ' &mdash; ' + (names[i] || '');
            }

            // The bar sits under its label (labels differ in width), or in even slices when labels are hidden
            if (progress) {
                var active = navButtons[i];
                // offsetParent is null under display:none - cheaper than computed styles every frame
                var labelsShown = navList && navList.offsetParent !== null;

                if (labelsShown && active) {
                    var barBox = progress.parentNode.getBoundingClientRect();
                    var labelBox = active.getBoundingClientRect();
                    progress.style.width = labelBox.width + 'px';
                    progress.style.transform = 'translateX(' + (labelBox.left - barBox.left) + 'px)';
                } else {
                    progress.style.width = 100 / slides.length + '%';
                    progress.style.transform = 'translateX(' + i * 100 + '%)';
                }
            }

            if (prevBtn) prevBtn.disabled = currentIndex() === 0;
            if (nextBtn) nextBtn.disabled = currentIndex() === slides.length - 1;
        }

        // Once per frame at most - scroll fires in bursts and paint measures elements
        var painting = false;
        track.addEventListener(
            'scroll',
            function () {
                if (painting) return;
                painting = true;
                window.requestAnimationFrame(function () {
                    painting = false;
                    paint();
                });
            },
            { passive: true }
        );

        var resizeTimer;
        window.addEventListener('resize', function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function () {
                paint();
                setUpVideo();
            }, 120);
        });

        /* ---- controls ---- */
        function onClick(btn, target) {
            if (!btn) return;
            btn.addEventListener('click', function () {
                holdAuto();
                goTo(target());
            });
        }

        onClick(prevBtn, function () {
            return currentIndex() - 1;
        });
        onClick(nextBtn, function () {
            return currentIndex() + 1;
        });
        navButtons.forEach(function (btn) {
            onClick(btn, function () {
                return parseInt(btn.getAttribute('data-sgs-go'), 10) || 0;
            });
        });
        onClick(startBtn, function () {
            return 1;
        });

        // Left / right step, Home / End jump; up and down still scroll the page
        track.addEventListener('keydown', function (ev) {
            holdAuto();

            var to = null;
            if (ev.key === 'ArrowRight') to = currentIndex() + 1;
            else if (ev.key === 'ArrowLeft') to = currentIndex() - 1;
            else if (ev.key === 'Home') to = 0;
            else if (ev.key === 'End') to = slides.length - 1;

            if (to !== null) {
                ev.preventDefault();
                goTo(to);
            }
        });

        /* ---- auto-step ----
           Steps right every DWELL, wrapping straight back to the first slide.
           Paused while it has keyboard focus, for HOLD after a manual move,
           while the tab is hidden or the banner is off screen, and entirely
           for reduced motion. */
        var timer = null;
        var paused = false;
        var heldUntil = 0;

        function step() {
            if (paused || Date.now() < heldUntil) return;

            var i = currentIndex();
            if (i >= slides.length - 1) goTo(0, true);
            else goTo(i + 1);
        }

        function startAuto() {
            if (reduceMotion || timer) return;
            timer = setInterval(step, DWELL);
        }

        function stopAuto() {
            clearInterval(timer);
            timer = null;
        }

        function holdAuto() {
            heldUntil = Date.now() + HOLD;
        }

        if (!reduceMotion) {
            var stageEl = page.querySelector('#sgs-stage');

            // Keyboard focus parks it so people tabbing through can read; hover does not
            stageEl.addEventListener('focusin', function () {
                paused = true;
            });
            stageEl.addEventListener('focusout', function () {
                paused = false;
            });

            document.addEventListener('visibilitychange', function () {
                if (document.hidden) stopAuto();
                else startAuto();
            });

            // Only while the banner is on screen
            if ('IntersectionObserver' in window) {
                new IntersectionObserver(
                    function (entries) {
                        if (entries[0].isIntersecting) startAuto();
                        else stopAuto();
                    },
                    { threshold: 0.35 }
                ).observe(stageEl);
            } else {
                startAuto();
            }
        }

        /* ---- hero video ----
           A large file: wide screens only, never for reduced motion.
           Re-checked on resize so a widened window still gets it. */
        function setUpVideo() {
            if (!video || reduceMotion) return;
            if (video.getAttribute('src')) return; // already running
            if (!window.matchMedia('(min-width: 901px)').matches) return;

            var src = video.getAttribute('data-src');
            if (!src) return;

            video.setAttribute('src', src);
            video.load();

            var playing = video.play();
            if (playing && typeof playing.catch === 'function') {
                playing.catch(function () {}); // autoplay refused - the gradient behind it is enough
            }
        }

        // Fades the "scroll on for more" hint once the page moves
        window.addEventListener(
            'scroll',
            function () {
                page.classList.toggle('is-scrolled', window.scrollY > 40);
            },
            { passive: true }
        );

        // Painted again after load - before then the track may have no width, greying out Next
        paint();
        setUpVideo();

        window.addEventListener('load', function () {
            paint();
            setUpVideo();
        });
    }

    /* ======================================================================
       REGION - two photos joined at --sgs-split. The first time the band is
       seen the split sweeps across once; after that it eases toward the
       cursor. Nothing for reduced motion.
       ====================================================================== */
    function initRegion() {
        var band = document.querySelector('#sg-services-page .sgs-region');
        if (!band) return;

        var mq = window.matchMedia;
        if (mq && mq('(prefers-reduced-motion: reduce)').matches) return;

        var canHover = !mq || !mq('(hover: none)').matches;

        var INTRO_FROM = 12;
        var INTRO_TO = 88;
        var INTRO_MS = 2600;
        var CHASE = 0.14; // pull toward the cursor per frame: eases, but clearly follows

        var current = 50;
        var target = 50;
        var frame = null;
        var introUntil = 0; // while set, the intro owns the split

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
                    target = INTRO_TO; // the cursor takes over from here
                    paint();
                    return;
                }

                var p = 1 - left / INTRO_MS;
                current = INTRO_FROM + (INTRO_TO - INTRO_FROM) * easeInOut(p);
                paint();
                run();
                return;
            }

            var diff = target - current;

            if (Math.abs(diff) < 0.08) {
                current = target;
                paint();
                return; // settled - stop asking for frames
            }

            current += diff * CHASE;
            paint();
            run();
        }

        function startIntro() {
            current = INTRO_FROM;
            target = INTRO_TO;
            introUntil = window.performance.now() + INTRO_MS;
            paint();
            run();
        }

        // The intro waits until the band is on screen, once
        if ('IntersectionObserver' in window) {
            var watcher = new IntersectionObserver(
                function (entries) {
                    if (!entries[0].isIntersecting) return;
                    watcher.disconnect();
                    startIntro();
                },
                { threshold: 0.4 }
            );
            watcher.observe(band);
        } else {
            startIntro();
        }

        if (!canHover) return;

        band.addEventListener('mousemove', function (ev) {
            introUntil = 0; // the cursor interrupts the intro rather than fighting it

            var box = band.getBoundingClientRect();
            var pct = ((ev.clientX - box.left) / box.width) * 100;

            target = Math.max(0, Math.min(100, pct));
            run();
        });
    }

    /* ======================================================================
       ANNUAL
       ====================================================================== */
    function initAnnual() {
        var section = document.querySelector('.sgs-annual');
        var track = document.getElementById('sgs-annual-track');
        var dots = document.getElementById('sgs-annual-dots');
        var count = document.getElementById('sgs-annual-count');
        if (!section || !track) return;

        var cards = track.querySelectorAll('.sgs-an-card').length;
        if (!cards) return;

        var built = 0; // how many dashes are in the DOM

        // Rebuilt only when the number of pages changes; one page needs none
        function buildDots(total) {
            if (!dots || built === total) return;
            built = total;
            dots.innerHTML = '';
            if (total < 2) return;

            for (var i = 0; i < total; i++) {
                var b = document.createElement('button');
                b.type = 'button';
                b.setAttribute('role', 'tab');
                b.setAttribute('data-page', i);
                b.setAttribute('aria-label', 'Page ' + (i + 1) + ' of ' + total);
                dots.appendChild(b);
            }
        }

        var slider = window.SGSlider(track, Array.prototype.slice.call(section.querySelectorAll('[data-slide]')), {
            onPaint: function (page, total, per) {
                buildDots(total);

                if (dots) {
                    Array.prototype.forEach.call(dots.children, function (b, i) {
                        b.setAttribute('aria-selected', i === page ? 'true' : 'false');
                    });
                }

                if (count) {
                    var first = page * per + 1;
                    var lastCard = Math.min(cards, first + per - 1);
                    count.textContent = first === lastCard ? first + ' of ' + cards : first + '–' + lastCard + ' of ' + cards;
                }
            }
        });

        // One listener on the strip, so the dashes can be rebuilt freely
        if (dots) {
            dots.addEventListener('click', function (ev) {
                var b = ev.target.closest('[data-page]');
                if (b) slider.goTo(parseInt(b.getAttribute('data-page'), 10) || 0);
            });
        }

        slider.paint();
    }
})();
