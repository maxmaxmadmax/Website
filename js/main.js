/* --------------------------------------------------------------------------
   SoundzGood - shared page script

   1. Loads components/navbar.html into  <div id="navbar"></div>
   2. Loads components/footer.html into  <div id="footer"></div>
   3. Highlights the menu link for the page you are currently on

   You normally do not need to edit this file.
   To change the menu or footer, edit the files in the components folder.
   -------------------------------------------------------------------------- */

/*  The asset version, read off this script's own src (js/main.js?v=N,
    see tools/bump-assets.js). Used on the menu and footer fetches so they
    don't stay cached after a deploy. Empty if there is no ?v=. */
var SG_VERSION = (function () {
    var el = document.currentScript ||
             document.querySelector('script[src*="main.js"]');
    var found = el && el.src.match(/[?&]v=([^&]+)/);
    return found ? found[1] : '';
}());

/*  ALWAYS THE LATEST PAGE
    GitHub Pages caches each page for ten minutes. Every page checks
    version.json (written by tools/bump-assets.js, never cached); if it is
    newer, the page reloads under ?_v=N so it comes fresh, then the ?_v=N is
    tidied off the address bar. Once per version, so it can never loop. */
(function freshPage() {
    try {
        var params = new URLSearchParams(location.search);
        var landed = params.get('_v');
        if (landed) {
            // we came here to get the fresh copy - tidy the address bar
            params.delete('_v');
            var clean = location.pathname + (params.toString() ? '?' + params : '') + location.hash;
            history.replaceState(history.state, '', clean);
        }
        if (!SG_VERSION || !window.fetch) return;
        fetch('/version.json?t=' + Date.now(), { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                if (!d || !(Number(d.v) > Number(SG_VERSION))) return;
                if (landed === String(d.v)) return;          // already tried this version
                var p = new URLSearchParams(location.search);
                p.set('_v', d.v);
                location.replace(location.pathname + '?' + p + location.hash);
            })
            .catch(function () { /* offline - keep what we have */ });
    } catch (e) { /* very old browser - no harm done */ }
}());

function versioned(url) {
    return SG_VERSION ? url + '?v=' + encodeURIComponent(SG_VERSION) : url;
}

/* Turn the scrapbook scroll animation on. This runs straight away (before the
   page is painted) so nothing flashes into view first. If the browser is too
   old, or the visitor prefers less motion, the class is removed again below
   and everything simply shows normally. */
if (supportsScrollAnimation()) {
    document.documentElement.classList.add('has-scroll-anim');
}

document.addEventListener('DOMContentLoaded', function () {
    /* Absolute paths, so a page in a subfolder - an archived event, for
       example - still finds the menu and footer. */
    loadComponent('navbar', versioned('/components/navbar.html'), function () {
        highlightCurrentPage();
        initSubmenus();
        initBurger();
        initHomeNav();
        trackNavHeight();
    });
    loadComponent('footer', versioned('/components/footer.html'));
    initScrapbookAnimation();
    initTicketBar();
    initEnquiryPrefill();
});

/* Carries an artist's name from the entertainment page into the contact
   form. Needs both the ?about= parameter and a contact form on the page. */
function initEnquiryPrefill() {
    var form = document.querySelector('.contact-form');
    if (!form) return;

    var params = new URLSearchParams(window.location.search);
    var about = params.get('about');
    var note = params.get('note');
    var email = params.get('email');

    var message = form.querySelector('[name="message"]');

    /*  ?about= is an artist's name from the entertainment page; ?note= is a
        full sentence from another page (e.g. the gig guide). Only fills a
        box the visitor has not typed in. */
    if (message && message.value.trim() === '') {
        if (note) {
            message.value = note;
        } else if (about) {
            message.value = 'I would like to enquire about booking ' + about + '.';
        }
    }

    if (email) {
        var box = form.querySelector('[name="email"]');
        if (box && box.value.trim() === '') box.value = email;
    }
}

/* The phone menu.

   Opens and closes the panel, and closes it on a link, on Escape, on a tap
   outside it, and when the window grows past the breakpoint (e.g. a tablet
   turned sideways). */
function initBurger() {
    var navEl = document.querySelector('#navbar nav');
    var burger = document.getElementById('nav-burger');
    if (!navEl || !burger) return;

    var setOpen = function (open) {
        navEl.classList.toggle('is-open', open);
        burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    };

    burger.addEventListener('click', function (ev) {
        ev.stopPropagation();
        setOpen(!navEl.classList.contains('is-open'));
    });

    /* A link means they are going somewhere, so the panel has done its job. */
    var links = navEl.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
        links[i].addEventListener('click', function () { setOpen(false); });
    }

    document.addEventListener('click', function (ev) {
        if (!navEl.contains(ev.target)) setOpen(false);
    });

    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') setOpen(false);
    });

    window.addEventListener('resize', function () {
        if (window.innerWidth > 900) setOpen(false);
    });
}

/* Publishes the real height of the menu as --sg-nav-height, so every hero
   starts below the menu even when the bar wraps onto a second row. */
function trackNavHeight() {
    var navEl = document.querySelector('#navbar nav');
    if (!navEl) return;

    var apply = function () {
        var height = Math.ceil(navEl.getBoundingClientRect().height);
        if (height > 0) {
            document.documentElement.style.setProperty('--sg-nav-height', height + 'px');
        }
    };

    apply();

    // Re-measure when the bar rewraps: rotation, resize, or a late font.
    if ('ResizeObserver' in window) {
        new ResizeObserver(apply).observe(navEl);
    } else {
        window.addEventListener('resize', apply);
    }

    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(apply).catch(function () {});
    }
}

/* Menu dropdowns.

   On a computer CSS opens them on hover. On a touch screen the little arrow
   beside the menu item opens and closes it - a separate button, so tapping
   "Events" still goes to the events page. */
function initSubmenus() {
    var parents = document.querySelectorAll('#navbar .has-sub');

    if (parents.length === 0) {
        return;
    }

    var closeAll = function (except) {
        for (var i = 0; i < parents.length; i++) {
            if (parents[i] === except) {
                continue;
            }
            parents[i].classList.remove('is-open');
            var btn = parents[i].querySelector('.sub-toggle');
            if (btn) {
                btn.setAttribute('aria-expanded', 'false');
            }
        }
    };

    for (var i = 0; i < parents.length; i++) {
        (function (parent) {
            var toggle = parent.querySelector('.sub-toggle');
            if (!toggle) {
                return;
            }

            toggle.addEventListener('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();

                var open = parent.classList.toggle('is-open');
                toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
                closeAll(parent);
            });
        }(parents[i]));
    }

    /* Tapping or clicking anywhere else puts them away again. */
    document.addEventListener('click', function (ev) {
        for (var i = 0; i < parents.length; i++) {
            if (parents[i].contains(ev.target)) {
                return;
            }
        }
        closeAll(null);
    });

    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') {
            closeAll(null);
        }
    });
}

/* Home page only: keep the menu out of the way over the hero, then slide
   it in once the next event section is reached. Runs straight after the
   menu is inserted, so it never flashes into view first. */
function initHomeNav() {
    var trigger = document.getElementById('next-event');
    var navEl = document.querySelector('#navbar nav');

    if (!trigger || !navEl || !('IntersectionObserver' in window)) {
        return; // not the home page, or no support - leave the menu showing
    }

    navEl.classList.add('is-tucked');

    var observer = new IntersectionObserver(function (entries) {
        var entry = entries[0];

        // showing once the section is reached, and staying shown past it
        if (entry.isIntersecting || entry.boundingClientRect.top < 0) {
            navEl.classList.remove('is-tucked');
        } else {
            navEl.classList.add('is-tucked'); // scrolled back up to the hero
        }
    }, {
        /* Trimming most of the viewport off the bottom means the menu waits
           until the section is genuinely arriving, rather than appearing
           while the hero is still filling the screen. */
        threshold: 0,
        rootMargin: '0px 0px -60% 0px'
    });

    observer.observe(trigger);
}

/* Hide the sticky ticket bar while the checkout section is on screen -
   the real ticket form is right there, so the bar is just in the way. */
function initTicketBar() {
    var bar = document.querySelector('.ticket-bar');
    var checkout = document.getElementById('tickets');

    if (!bar || !checkout || !('IntersectionObserver' in window)) {
        return;
    }

    var observer = new IntersectionObserver(function (entries) {
        // rootMargin below trims the bottom of the viewport, so this only
        // counts once the checkout reaches the top strip of the screen.
        if (entries[0].isIntersecting) {
            bar.classList.add('is-hidden');
        } else {
            bar.classList.remove('is-hidden');
        }
    }, {
        threshold: 0,
        rootMargin: '0px 0px -80% 0px'
    });

    observer.observe(checkout);
}

function supportsScrollAnimation() {
    return 'IntersectionObserver' in window &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* Paste each act onto the page as it scrolls into view */
function initScrapbookAnimation() {
    if (!supportsScrollAnimation()) {
        document.documentElement.classList.remove('has-scroll-anim');
        return;
    }

    var items = document.querySelectorAll('.act, .act-wave');

    if (items.length === 0) {
        return; // not the events page
    }

    var observerHasFired = false;

    var observer = new IntersectionObserver(function (entries) {
        observerHasFired = true;

        for (var i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting) {
                entries[i].target.classList.add('is-visible');
                observer.unobserve(entries[i].target); // only animate once
            }
        }
    }, {
        /* threshold 0: fires as soon as the top edge of an act comes into
           view (the acts are tall). */
        threshold: 0,
        rootMargin: '0px 0px -10% 0px'
    });

    for (var i = 0; i < items.length; i++) {
        observer.observe(items[i]);
    }

    /* Safety net for a browser where the observer never runs at all.
       If it has fired even once it is working, so leave it alone. */
    setTimeout(function () {
        if (observerHasFired) {
            return;
        }

        for (var i = 0; i < items.length; i++) {
            items[i].classList.add('is-visible');
        }
    }, 5000);
}

/* Fetch an HTML snippet and drop it into the element with the given id */
function loadComponent(id, url, onLoaded) {
    var target = document.getElementById(id);

    if (!target) {
        return; // this page doesn't use that component
    }

    fetch(url)
        .then(function (response) {
            return response.text();
        })
        .then(function (html) {
            target.innerHTML = html;

            if (onLoaded) {
                onLoaded();
            }
        })
        .catch(function () {
            /* If the snippet can't load, the page still works - it just
               shows without the menu or footer. */
        });
}

/* Add class="active" to the menu link matching the current page */
function highlightCurrentPage() {
    var here = tidyPath(window.location.pathname);

    /* Only the menu links - not the logo, which also points home */
    var links = document.querySelectorAll('#navbar ul a');

    for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href');

        /* skip anything off-site, such as the ticket link */
        if (!href || href.charAt(0) !== '/') {
            continue;
        }

        if (tidyPath(href) === here) {
            links[i].classList.add('active');
            links[i].setAttribute('aria-current', 'page');

            /* A page inside a dropdown also marks the item it sits under,
               so the menu still shows where you are while it is shut. */
            var parent = links[i].closest ? links[i].closest('.has-sub') : null;
            if (parent) {
                parent.classList.add('has-active');
            }
        }
    }
}

/* Treats /events.html and /events as the same page, so an older bookmark
   or shared link still highlights the right menu item.

   Anything filed under /events/ - an archived event, say - counts as the
   events page too, so the menu still shows where you are. */
function tidyPath(path) {
    path = path.replace(/\/index\.html$/, '/').replace(/\.html$/, '');

    if (path.indexOf('/events/') === 0) {
        return '/events';
    }

    return path === '' ? '/' : path;
}
