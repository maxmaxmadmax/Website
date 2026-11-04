/* ==========================================================================
   MAIN - loaded by every public page (with defer).

   HELPERS      window.SG - esc() for text going into HTML
   FRESH PAGE   reloads the page once when a newer version has been deployed
   COMPONENTS   drops the menu and footer in, highlights the current page
   MENU         burger, dropdowns, the home page tuck, the measured height
   CONTACT      pre-fills the contact form from ?about= / ?note=
   SLIDER       pages a row of cards (window.SGSlider, used by other scripts)
   ========================================================================== */

/* ==========================================================================
   HELPERS
   ========================================================================== */
window.SG = {
    /* Text into HTML: never let a name or a note become markup */
    esc: function (s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
};

/* ==========================================================================
   FRESH PAGE
   GitHub Pages caches each page for ten minutes. Every page checks
   version.json (written by tools/bump-assets.js, never cached); if it is
   newer, the page reloads under ?_v=N so it comes fresh, then the ?_v=N is
   tidied off the address bar. Once per version, so it can never loop.
   ========================================================================== */

/* The asset version, read off this script's own src (js/main.js?v=N) */
var SG_VERSION = (function () {
    var el = document.currentScript || document.querySelector('script[src*="main.js"]');
    var found = el && el.src.match(/[?&]v=([^&]+)/);
    return found ? found[1] : '';
})();

(function freshPage() {
    try {
        var params = new URLSearchParams(location.search);
        var landed = params.get('_v');
        if (landed) {
            params.delete('_v');
            var clean = location.pathname + (params.toString() ? '?' + params : '') + location.hash;
            history.replaceState(history.state, '', clean);
        }
        if (!SG_VERSION || !window.fetch) return;
        fetch('/version.json?t=' + Date.now(), { cache: 'no-store' })
            .then(function (r) {
                return r.ok ? r.json() : null;
            })
            .then(function (d) {
                if (!d || !(Number(d.v) > Number(SG_VERSION))) return;
                if (landed === String(d.v)) return; // already tried this version
                var p = new URLSearchParams(location.search);
                p.set('_v', d.v);
                location.replace(location.pathname + '?' + p + location.hash);
            })
            .catch(function () {
                /* offline - keep what we have */
            });
    } catch (e) {
        /* very old browser - no harm done */
    }
})();

function versioned(url) {
    return SG_VERSION ? url + '?v=' + encodeURIComponent(SG_VERSION) : url;
}

/* ==========================================================================
   COMPONENTS
   ========================================================================== */
document.addEventListener('DOMContentLoaded', function () {
    /* Absolute paths, so a page in a subfolder still finds the menu and footer */
    loadComponent('navbar', versioned('/components/navbar.html'), function () {
        highlightCurrentPage();
        initSubmenus();
        initBurger();
        initHomeNav();
        trackNavHeight();
    });
    loadComponent('footer', versioned('/components/footer.html'));
    initEnquiryPrefill();
});

/* Fetch an HTML snippet and drop it into the element with that id */
function loadComponent(id, url, onLoaded) {
    var target = document.getElementById(id);
    if (!target) return; // this page does not use that component

    fetch(url)
        .then(function (response) {
            return response.text();
        })
        .then(function (html) {
            target.innerHTML = html;
            if (onLoaded) onLoaded();
        })
        .catch(function () {
            /* the page still works, just without the menu or footer */
        });
}

/* Marks the menu link for the page you are on (and the dropdown it sits in) */
function highlightCurrentPage() {
    var here = tidyPath(window.location.pathname);
    var links = document.querySelectorAll('#navbar ul a'); // not the logo, which also points home

    for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href');
        if (!href || href.charAt(0) !== '/') continue; // off-site links

        if (tidyPath(href) === here) {
            links[i].classList.add('active');
            links[i].setAttribute('aria-current', 'page');
            var parent = links[i].closest ? links[i].closest('.has-sub') : null;
            if (parent) parent.classList.add('has-active');
        }
    }
}

/* /events.html and /events are the same page; anything under /events/ counts as events too */
function tidyPath(path) {
    path = path.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
    if (path.indexOf('/events/') === 0) return '/events';
    return path === '' ? '/' : path;
}

/* ==========================================================================
   MENU
   ========================================================================== */

/* The phone menu: opens and closes, and closes on a link, Escape, a tap
   outside, or when the window grows past the breakpoint */
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

    var links = navEl.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
        links[i].addEventListener('click', function () {
            setOpen(false);
        });
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

/* Dropdowns: hover opens them on a computer (CSS); on a touch screen the
   little arrow beside the item is a separate button, so a tap on "Events"
   still goes to the events page */
function initSubmenus() {
    var parents = document.querySelectorAll('#navbar .has-sub');
    if (parents.length === 0) return;

    var closeAll = function (except) {
        for (var i = 0; i < parents.length; i++) {
            if (parents[i] === except) continue;
            parents[i].classList.remove('is-open');
            var btn = parents[i].querySelector('.sub-toggle');
            if (btn) btn.setAttribute('aria-expanded', 'false');
        }
    };

    for (var i = 0; i < parents.length; i++) {
        (function (parent) {
            var toggle = parent.querySelector('.sub-toggle');
            if (!toggle) return;

            toggle.addEventListener('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                var open = parent.classList.toggle('is-open');
                toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
                closeAll(parent);
            });
        })(parents[i]);
    }

    document.addEventListener('click', function (ev) {
        for (var i = 0; i < parents.length; i++) {
            if (parents[i].contains(ev.target)) return;
        }
        closeAll(null);
    });

    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') closeAll(null);
    });
}

/* Home page only: the menu stays out of the way over the hero, then slides
   in once the next-event section is reached (site.css .is-tucked) */
function initHomeNav() {
    var trigger = document.getElementById('next-event');
    var navEl = document.querySelector('#navbar nav');
    if (!trigger || !navEl || !('IntersectionObserver' in window)) return;

    navEl.classList.add('is-tucked');

    new IntersectionObserver(
        function (entries) {
            var entry = entries[0];
            if (entry.isIntersecting || entry.boundingClientRect.top < 0) {
                navEl.classList.remove('is-tucked');
            } else {
                navEl.classList.add('is-tucked'); // scrolled back up to the hero
            }
        },
        /* most of the viewport trimmed off the bottom, so the menu waits
           until the section is genuinely arriving */
        { threshold: 0, rootMargin: '0px 0px -60% 0px' }
    ).observe(trigger);
}

/* Publishes the menu's real height as --sg-nav-height, so every hero
   starts below it even when the bar wraps onto two rows */
function trackNavHeight() {
    var navEl = document.querySelector('#navbar nav');
    if (!navEl) return;

    var apply = function () {
        var height = Math.ceil(navEl.getBoundingClientRect().height);
        if (height > 0) document.documentElement.style.setProperty('--sg-nav-height', height + 'px');
    };

    apply();

    if ('ResizeObserver' in window) {
        new ResizeObserver(apply).observe(navEl);
    } else {
        window.addEventListener('resize', apply);
    }

    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(apply).catch(function () {});
    }
}

/* ==========================================================================
   CONTACT - ?about= is an artist's name, ?note= a full sentence from
   another page. Only fills boxes that are empty.
   ========================================================================== */
function initEnquiryPrefill() {
    var form = document.querySelector('.contact-form');
    if (!form) return;

    var params = new URLSearchParams(window.location.search);
    var about = params.get('about');
    var note = params.get('note');

    var message = form.querySelector('[name="message"]');
    if (message && message.value.trim() === '') {
        if (note) {
            message.value = note;
        } else if (about) {
            message.value = 'I would like to enquire about booking ' + about + '.';
        }
    }
}

/* ==========================================================================
   SLIDER - pages a .slide-track inside a .slide-view (site.css SLIDER).
   The CSS does the movement: the script sets --page on the track and reads
   --per (cards across) from the view, so breakpoints need no JS changes.

   window.SGSlider(track, arrows, options) -> { paint, goTo }
     track    the .slide-track
     arrows   the [data-slide="-1|1"] buttons
     options.count()           how many cards (default: the track's children)
     options.onPaint(page, total, per)   extra drawing, e.g. dots or a count
   ========================================================================== */
window.SGSlider = function (track, arrows, options) {
    var opts = options || {};
    var view = track.parentElement;
    var page = 0;

    function count() {
        return opts.count ? opts.count() : track.children.length;
    }

    function perView() {
        var n = parseInt(window.getComputedStyle(view).getPropertyValue('--per'), 10);
        return n > 0 ? n : 1;
    }

    function pages() {
        return Math.max(1, Math.ceil(count() / perView()));
    }

    function paint() {
        var total = pages();
        var last = total - 1;
        if (page > last) page = last; // a wider window can leave us past the end
        if (page < 0) page = 0;

        track.style.setProperty('--page', page);

        arrows.forEach(function (btn) {
            var dir = parseInt(btn.getAttribute('data-slide'), 10);
            btn.disabled = dir < 0 ? page === 0 : page === last;
        });

        if (opts.onPaint) opts.onPaint(page, total, perView());
    }

    arrows.forEach(function (btn) {
        btn.addEventListener('click', function () {
            page += parseInt(btn.getAttribute('data-slide'), 10) || 0;
            paint();
        });
    });

    window.addEventListener('resize', paint);

    return {
        paint: paint,
        goTo: function (n) {
            page = n;
            paint();
        }
    };
};
