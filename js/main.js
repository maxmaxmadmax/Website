/* --------------------------------------------------------------------------
   SoundzGood - shared page script

   1. Loads components/navbar.html into  <div id="navbar"></div>
   2. Loads components/footer.html into  <div id="footer"></div>
   3. Highlights the menu link for the page you are currently on

   You normally do not need to edit this file.
   To change the menu or footer, edit the files in the components folder.
   -------------------------------------------------------------------------- */

/* Turn the scrapbook scroll animation on. This runs straight away (before the
   page is painted) so nothing flashes into view first. If the browser is too
   old, or the visitor prefers less motion, the class is removed again below
   and everything simply shows normally. */
if (supportsScrollAnimation()) {
    document.documentElement.classList.add('has-scroll-anim');
}

document.addEventListener('DOMContentLoaded', function () {
    loadComponent('navbar', 'components/navbar.html', function () {
        highlightCurrentPage();
        initHomeNav();
    });
    loadComponent('footer', 'components/footer.html');
    initScrapbookAnimation();
    initTicketBar();
});

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
        /* threshold 0, not a percentage of the element. Each act is tall
           now that it carries a biography, so asking for a percentage of
           it meant scrolling a long way in before anything appeared. This
           fires as soon as the top edge comes into view. */
        threshold: 0,
        rootMargin: '0px 0px -10% 0px'
    });

    for (var i = 0; i < items.length; i++) {
        observer.observe(items[i]);
    }

    /* Safety net for a browser where the observer never runs at all.
       If it has fired even once it is working, so we leave the animation
       alone - otherwise this would reveal every act at the same time and
       wreck the effect. */
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
        }
    }
}

/* Treats /events.html and /events as the same page, so an older bookmark
   or shared link still highlights the right menu item. */
function tidyPath(path) {
    path = path.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
    return path === '' ? '/' : path;
}
