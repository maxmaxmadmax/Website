/* ==========================================================================
   SOUNDZGOOD 2.0 (2025) - the old poster-style event page only.
   Pastes each act onto the page as it scrolls into view (legacy-event.css
   SCROLL ANIMATIONS). With no support, or reduced motion, everything shows.
   ========================================================================== */
(function () {
    'use strict';

    var supported = 'IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!supported) return;

    var items = document.querySelectorAll('.act, .act-wave');
    if (items.length === 0) return;

    /* On before anything paints, so nothing flashes into view first */
    document.documentElement.classList.add('has-scroll-anim');

    var fired = false;
    var observer = new IntersectionObserver(
        function (entries) {
            fired = true;
            for (var i = 0; i < entries.length; i++) {
                if (entries[i].isIntersecting) {
                    entries[i].target.classList.add('is-visible');
                    observer.unobserve(entries[i].target); // only once
                }
            }
        },
        { threshold: 0, rootMargin: '0px 0px -10% 0px' }
    );

    for (var i = 0; i < items.length; i++) observer.observe(items[i]);

    /* Safety net: if the observer never fires, show everything */
    setTimeout(function () {
        if (fired) return;
        for (var j = 0; j < items.length; j++) items[j].classList.add('is-visible');
    }, 5000);
})();
