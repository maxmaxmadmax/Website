/* ==========================================================================
   KEEPING THE GIG GUIDE UP TO DATE

   Runs once a day: finds what is on (lib/gig-sources.js), then makes the
   database match. Adds new events, updates changed ones, and removes past
   ones or ones the source has taken down.

   Three collections, all written only from here:

       gigs/{id}            one upcoming event. Public read.
       gigGuide/status      when it last ran and what it found. Public
                            read, so the page can say how fresh it is.
       gigGuide/cache       what each source page looked like last time,
                            so the next run only reads pages that changed.
                            Not public - it is working state.
   ========================================================================== */

'use strict';

const logger = require('firebase-functions/logger');
const { FieldValue } = require('firebase-admin/firestore');
const sources = require('./gig-sources');

/* Firestore allows at most 500 writes in one batch. */
const BATCH_LIMIT = 400;

async function syncGigs(db) {
    const started = Date.now();

    /* ------------------------------------------------------------------
       1. What did we know last time
       ------------------------------------------------------------------ */
    let cache = {};
    try {
        const snap = await db.doc('gigGuide/cache').get();
        if (snap.exists) cache = JSON.parse(snap.get('json') || '{}');
    } catch (err) {
        /*  A broken cache is a slow run, not a failed one.              */
        logger.warn('gig guide cache unreadable, running cold', {
            reason: (err && err.message) || 'unknown',
        });
        cache = {};
    }

    /* ------------------------------------------------------------------
       2. Go and look
       ------------------------------------------------------------------ */
    const found = await sources.collect(cache);
    const events = found.events;
    const report = found.report;

    /* ------------------------------------------------------------------
       3. Make the database say that

          Everything in gigs is read first to work out what to remove. It is
          a small collection, because past events are deleted.
       ------------------------------------------------------------------ */
    const existing = await db.collection('gigs').get();

    const wanted = new Map();
    events.forEach((ev) => wanted.set(ev.id, ev));

    const writes = [];

    existing.forEach((doc) => {
        if (!wanted.has(doc.id)) {
            writes.push({ ref: doc.ref, kind: 'delete' });
        }
    });

    wanted.forEach((ev, id) => {
        writes.push({
            ref: db.collection('gigs').doc(id),
            kind: 'set',
            data: {
                name: ev.name,
                start: ev.start,
                time: ev.time || '',
                venue: ev.venue || '',
                suburb: ev.suburb || '',
                area: ev.area || '',
                url: ev.url || '',
                image: ev.image || '',
                source: ev.source || '',
                updatedAt: FieldValue.serverTimestamp(),
            },
        });
    });

    let written = 0;
    for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
        const batch = db.batch();

        writes.slice(i, i + BATCH_LIMIT).forEach((job) => {
            if (job.kind === 'delete') batch.delete(job.ref);
            else batch.set(job.ref, job.data, { merge: true });
            written++;
        });

        await batch.commit();
    }

    /* ------------------------------------------------------------------
       4. Leave a note saying what happened

          Logged as well as stored, so a source that quietly finds nothing
          gets noticed.
       ------------------------------------------------------------------ */
    const status = {
        ranAt: FieldValue.serverTimestamp(),
        today: found.today,
        events: events.length,
        removed: writes.filter((w) => w.kind === 'delete').length,
        listed: report.listed,
        pagesRead: report.fetched,
        fromCache: report.cached,
        past: report.past,
        skipped: report.skipped,
        errors: report.errors,
        tookMs: Date.now() - started,
    };

    await db.doc('gigGuide/status').set(status, { merge: true });

    await db.doc('gigGuide/cache').set({
        json: JSON.stringify(found.cache),
        entries: Object.keys(found.cache).length,
        savedAt: FieldValue.serverTimestamp(),
    });

    logger.info('gig guide synced', {
        events: events.length,
        pagesRead: report.fetched,
        fromCache: report.cached,
        removed: status.removed,
        errors: report.errors.length,
        tookMs: status.tookMs,
    });

    return status;
}

module.exports = { syncGigs };
