/* ==========================================================================
   WHERE THE GIG GUIDE'S EVENTS COME FROM

   One job: go and find what is on around Bowen and the Whitsundays, and
   hand back a plain list. Nothing in here writes to the database or knows
   the guide exists - that is index.js's half.

   ==========================================================================
   THE RULES THIS FOLLOWS, AND WHY
   ==========================================================================

   1. ONLY DATA A SITE PUBLISHES FOR MACHINES.
      Every source here is read through schema.org Event markup - the block
      of JSON a site puts in its own pages so that Google can show the event
      with a date on it. Reading that is reading something written to be
      read by programs. It also means that when they restyle their site,
      nothing here breaks.

   2. FACTS, NOT WRITING.
      What comes back is the name, the date, the venue, the link and the
      address of the event's picture. Not their description. A date and a
      venue are facts about the world; the paragraph somebody wrote about
      their gig is theirs.

      The picture is a link to where it already lives, never a copy on our
      server - the difference between pointing at somebody's poster and
      taking a copy of it. It also means an organiser who changes their
      artwork changes it here.

   3. EVERY EVENT KEEPS ITS SOURCE.
      Each one carries where it came from and a link back, and the guide
      shows both. A listing nobody can check is a rumour.

   4. NO BOT CHALLENGES, EVER.
      Bandsintown was the obvious second source - its Bowen page carries
      sixteen MusicEvent blocks - but it is behind Cloudflare and answered
      the second request with a challenge page. Working around that is not
      something this will ever do, so it is not in here.

   5. GENTLY.
      One run a day, a handful of requests at a time, and a user agent that
      says who we are and where to complain. If any of these sites would
      rather we did not, they can see us in their logs and say so.

   ==========================================================================
   ADDING A SOURCE
   ==========================================================================
   Write a function that returns an array of the shape below, and add it to
   SOURCES at the bottom. Everything else - the dates, the de-duplicating,
   the writing - is handled for you.

       {
         name:   'Bowen Parkrun',
         start:  '2026-09-12',           YYYY-MM-DD, local date
         time:   '7:00 AM',              '' if the source does not say
         venue:  'Barker Park',
         suburb: 'Bowen',
         url:    'https://...',          the event's own page
         image:  'https://...',          '' if they publish none
         source: 'Events on the Horizon'
       }
   ========================================================================== */

'use strict';

const USER_AGENT =
    'SoundzGoodGigGuide/1.0 (+https://www.soundzgood.com.au; events@soundzgood.com.au)';

/*  Long enough for a slow page, short enough that one unresponsive site
    cannot hold the whole run open.                                      */
const TIMEOUT_MS = 15000;

/*  How many pages are read at once. Six is brisk without being a load on
    anybody's server - a full run is a few dozen requests spread over
    about half a minute, once a day.                                     */
const CONCURRENCY = 6;

/*  Bump when the shape of what is taken off a page changes. See the note
    where it is used.                                                    */
const CACHE_VERSION = 2;


/* --------------------------------------------------------------------------
   THE DATE

   Queensland, always. At ten in the morning in Bowen it is still yesterday
   in UTC, and a guide built on UTC drops tonight's gig off the front page
   for the first ten hours of every day. This was a real bug in the first
   version of this file, caught by the fact that the probe printed both.
   -------------------------------------------------------------------------- */
function todayInQueensland() {
    /* en-CA formats as YYYY-MM-DD, which is what everything here compares */
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });
}


/* --------------------------------------------------------------------------
   FETCHING
   -------------------------------------------------------------------------- */
async function fetchText(url) {
    const stop = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json' },
        signal: stop,
    });

    if (!res.ok) {
        const err = new Error('HTTP ' + res.status + ' from ' + url);
        err.status = res.status;
        throw err;
    }

    return res.text();
}

async function fetchJson(url) {
    return JSON.parse(await fetchText(url));
}

/*  A small worker pool. Promise.all over everything at once would be a
    burst of a hundred requests at one small site, which is rude and is
    also how you get blocked.                                            */
async function pool(items, size, work) {
    const out = [];
    let next = 0;

    await Promise.all(
        Array.from({ length: Math.min(size, items.length) }, async () => {
            while (next < items.length) {
                const item = items[next++];
                try {
                    const got = await work(item);
                    if (got) out.push(got);
                } catch (err) {
                    /*  One page failing is not the run failing. The caller
                        reports how many were lost.                       */
                    out.push({ __error: (err && err.message) || 'unknown' });
                }
            }
        })
    );

    return out;
}


/* --------------------------------------------------------------------------
   READING SCHEMA.ORG OUT OF A PAGE

   Handles the three shapes a page can use: a bare object, an array, and
   the @graph wrapper. Anything it cannot parse is skipped rather than
   throwing - one malformed block should not lose the page.
   -------------------------------------------------------------------------- */
const LD_BLOCK = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function eventsInHtml(html) {
    const found = [];
    let match;

    LD_BLOCK.lastIndex = 0;

    while ((match = LD_BLOCK.exec(html))) {
        let parsed;
        try {
            parsed = JSON.parse(match[1].trim());
        } catch (err) {
            continue;
        }

        const nodes = Array.isArray(parsed)
            ? parsed
            : (Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed]);

        nodes.forEach((node) => {
            if (!node || typeof node !== 'object') return;

            /*  Event, MusicEvent, Festival, TheaterEvent and the rest all
                end in Event and all carry the same fields.               */
            const type = Array.isArray(node['@type']) ? node['@type'][0] : node['@type'];
            if (typeof type === 'string' && /Event$/.test(type)) found.push(node);
        });
    }

    return found;
}

/*  Turns a schema.org Event into our shape. Returns null for anything
    without the two things a listing cannot do without: a name and a date. */
function normalise(node, source, url) {
    const name = String(node.name || '').replace(/\s+/g, ' ').trim();
    const startsAt = String(node.startDate || '');
    const start = startsAt.slice(0, 10);

    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;

    const place = node.location || {};
    const address = place.address || {};

    /*  A start time only if the source gave one. '2026-09-12' on its own
        means they published a date and no time, and inventing 12:00 AM
        from that would put "12:00 AM" on the card.                      */
    let time = '';
    const clock = startsAt.match(/T(\d{2}):(\d{2})/);
    if (clock) {
        let hour = parseInt(clock[1], 10);
        const mins = clock[2];
        const ampm = hour >= 12 ? 'PM' : 'AM';
        hour = hour % 12 || 12;
        time = hour + (mins === '00' ? '' : ':' + mins) + ' ' + ampm;
    }

    return {
        name: name,
        start: start,
        time: time,
        venue: String(place.name || '').replace(/\s+/g, ' ').trim(),
        suburb: String(address.addressLocality || '').replace(/\s+/g, ' ').trim(),
        url: String(node.url || url || ''),
        image: pictureFrom(node),
        source: source,
    };
}

/*  THE EVENT'S OWN PICTURE.

    Kept as a link to where it already lives rather than copied onto our
    server. That is the difference between pointing at somebody's poster
    and taking a copy of it, and it is also why an organiser who changes
    their artwork changes it here too.

    schema.org allows three shapes for this - a string, a list of strings,
    or an ImageObject - so all three are unwrapped. Anything that is not a
    plain https link is dropped: a card with no picture looks fine, and a
    broken one does not.                                                 */
function pictureFrom(node) {
    let raw = node.image;

    if (Array.isArray(raw)) raw = raw[0];
    if (raw && typeof raw === 'object') raw = raw.url || raw.contentUrl;
    if (typeof raw !== 'string') return '';

    raw = raw.trim();
    return /^https:\/\//.test(raw) ? raw : '';
}


/* ==========================================================================
   SOURCE: EVENTS ON THE HORIZON
   https://eventsonthehorizon.com

   A WordPress site with a public REST endpoint listing events, and proper
   schema.org Event markup on every event page - checked across a hundred
   of them without a single miss. Its robots.txt disallows only /wp-admin/.

   The listing endpoint gives us links but no dates, so the dates come from
   reading the pages. That is the expensive half of the run: about a
   hundred pages for Bowen, half a minute, once a day.
   ========================================================================== */
const EOTH = 'https://eventsonthehorizon.com';

/*  Their locality terms, with how many events each had when it was added -
    a rough sense of what the run costs. Find a new one with:

        /wp-json/wp/v2/whats-on?slug=airlie-beach-qld                     */
const EOTH_AREAS = [
    { term: 100625, area: 'bowen' },          /* ~100 */
    { term: 100110, area: 'airlie' },         /* ~430 */
    { term: 100182, area: 'proserpine' },     /* ~190 */
    { term: 100129, area: 'cannonvale' },     /* ~50, filed under whitsundays */
    { term: 101537, area: 'collinsville' },   /* ~25 */
    { term: 101498, area: 'whitsundays' },    /* Hamilton Island */
];

/*  Cannonvale and Hamilton Island are their own places to the people who
    live there, but the guide's filter only offers six, so they land under
    the nearest one it does offer.                                       */
const AREA_MAP = { cannonvale: 'whitsundays' };

async function eventsOnTheHorizon(area, report, cache, nextCache) {
    const posts = [];

    for (let page = 1; page <= 6; page++) {
        const url = EOTH + '/wp-json/wp/v2/event?whats-on=' + area.term +
                    '&per_page=100&page=' + page + '&_fields=id,link,modified';

        let batch;
        try {
            batch = await fetchJson(url);
        } catch (err) {
            /*  Asking for a page past the end is a 400, which is how we
                find out where the end was.                              */
            break;
        }

        if (!Array.isArray(batch) || !batch.length) break;
        posts.push.apply(posts, batch);
        if (batch.length < 100) break;
    }

    report.listed += posts.length;

    /*  THE CACHE IS THE WHOLE TRICK.

        Listing the six areas costs about ten requests and tells us when
        each event was last edited. Only the ones that have changed since
        the last run need their page read. Without this the guide would
        ask this site for eight hundred pages every single day to learn
        that almost none of them had changed, which is a lot to take from
        somebody who is doing us a favour by publishing the markup at
        all. In the steady state a run reads a handful of pages.        */
    const stale = posts.filter((post) => {
        const had = cache[post.id];

        /*  CACHE_VERSION is bumped whenever what we take off a page
            changes - the pictures were added after the first run, and
            without this every cached event would have kept the shape it
            was read in and no picture would ever have appeared. Bumping
            it costs one slow run and then it is warm again.           */
        if (had && had.m === post.modified && had.v === CACHE_VERSION) {
            nextCache[post.id] = had;
            if (had.e) report.cached++;
            return false;
        }

        return true;
    });

    report.fetched += stale.length;

    const results = await pool(stale, CONCURRENCY, async (post) => {
        const html = await fetchText(post.link);
        const nodes = eventsInHtml(html);

        const event = nodes.length
            ? normalise(nodes[0], 'Events on the Horizon', post.link)
            : null;

        /*  A page with nothing usable on it is remembered as nothing
            usable, so it is not read again tomorrow for the same
            answer.                                                    */
        nextCache[post.id] = { m: post.modified, v: CACHE_VERSION, e: event };

        return event || { __skipped: true };
    });

    /*  Everything the cache already knew about, alongside what was just
        read. The cached half costs nothing.                            */
    posts.forEach((post) => {
        const had = cache[post.id];
        if (had && had.m === post.modified && had.v === CACHE_VERSION && had.e) results.push(had.e);
    });

    results.forEach((row) => {
        if (row && row.name) row.area = AREA_MAP[area.area] || area.area;
    });

    return results;
}


/* ==========================================================================
   THE RUN
   ========================================================================== */

/*  Sources that are known to work, in the order they are asked. Adding one
    is a line here and a function above.

    NOT IN THIS LIST, AND WHY - so nobody spends an afternoon rediscovering
    it:

      Bandsintown       Cloudflare. Answered the second request with a
                        challenge page. Its city page does carry sixteen
                        MusicEvent blocks, so if they ever allow a plain
                        request it is worth ten minutes.
      Eventbrite        Public event search was withdrawn from their API in
                        2019, and their terms do not allow scraping the
                        search pages that replaced it.
      Facebook groups   There is no public API for group or page events any
                        more, and reading them needs a logged in account,
                        which is against their terms. The live music group
                        is the best source in town and the only way to use
                        it is a person reading it.
      Tourism           Allowed, and says so in its robots.txt, but its
      Whitsundays       event pages carry no Event markup - only WebPage.
                        It would have to be parsed out of the HTML, which
                        breaks every time they restyle. Worth revisiting
                        if they ever add the markup.
      Whitsunday        Fetches fine and has no Event markup either. Same
      Regional Council  problem, same answer - but a council calendar is
                        worth the parsing if you want it, because it is
                        the one place the carols and the citizenship
                        ceremonies turn up.                              */
const SOURCES = [
    { name: 'Events on the Horizon', areas: EOTH_AREAS, run: eventsOnTheHorizon },
];

/*  A stable id for an event, so that running twice does not make two of
    everything, and so an event whose time changes updates rather than
    duplicates. Name and date, flattened - the same gig listed by two
    sources with slightly different punctuation still lands on one id.  */
function idFor(event) {
    const slug = (event.name + '-' + event.start)
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 120);

    return slug || null;
}

/*  Goes and gets everything. Returns the events plus a report of what
    happened, which the caller logs - a run that quietly finds nothing is
    indistinguishable from a run that worked, and that is how a broken
    feed goes unnoticed for a month.                                     */
async function collect(cache) {
    const today = todayInQueensland();
    const report = {
        listed: 0, fetched: 0, cached: 0,
        parsed: 0, future: 0, past: 0, skipped: 0, errors: [],
    };

    const events = [];
    const seen = new Set();

    const was = cache || {};
    const now = {};

    for (const source of SOURCES) {
        for (const area of source.areas) {
            let rows;

            try {
                rows = await source.run(area, report, was, now);
            } catch (err) {
                report.errors.push(source.name + '/' + area.area + ': ' +
                                   ((err && err.message) || 'unknown'));
                continue;
            }

            rows.forEach((row) => {
                if (row.__error) { report.errors.push(row.__error); return; }
                if (row.__skipped) { report.skipped++; return; }

                report.parsed++;

                if (row.start < today) { report.past++; return; }

                const id = idFor(row);
                if (!id || seen.has(id)) return;

                seen.add(id);
                row.id = id;
                events.push(row);
                report.future++;
            });
        }
    }

    events.sort((a, b) => a.start.localeCompare(b.start));

    /*  Only the errors worth reading. Fifty identical timeouts is not
        fifty pieces of information.                                     */
    report.errors = Array.from(new Set(report.errors)).slice(0, 10);

    /*  The new cache is built only from what is in the listings now, so an
        event they delete drops out of it rather than being remembered
        forever.                                                         */
    return { events: events, report: report, today: today, cache: now };
}

module.exports = {
    collect,
    todayInQueensland,
    /* exported for testing rather than for use */
    eventsInHtml,
    normalise,
    idFor,
};
