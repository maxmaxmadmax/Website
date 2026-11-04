/* SOUNDZGOOD SERVER - gig-guide
   The weekend gig guide: finding and storing gigs.
   Helpers shared with other features come from ../shared.js. */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { db } = require('../shared');

/* -------------------------------------------------------------------------
   THE GIG GUIDE

   Once a day, finds what is on around Bowen and the Whitsundays and writes
   it into Firestore for /gig-guide. The work is in lib/gig-sources.js
   (where events come from) and lib/gig-store.js (making the database match).

   Runs at 4am Queensland time. The nine minute timeout is for the first,
   uncached run (about 800 pages); later runs only read what changed.
   ------------------------------------------------------------------------- */
const { syncGigs } = require('../lib/gig-store');

exports.syncGigGuide = onSchedule(
    {
        schedule: '0 4 * * *',
        timeZone: 'Australia/Brisbane',
        timeoutSeconds: 540,
        memory: '512MiB'
    },
    async () => {
        await syncGigs(db);
    }
);

/* The same thing on demand, for an admin testing a new source. Admin only -
   it makes hundreds of outbound requests. */
exports.syncGigGuideNow = onCall({ timeoutSeconds: 540, memory: '512MiB' }, async (request) => {
    if (!request.auth || !request.auth.token || request.auth.token.admin !== true) {
        throw new HttpsError('permission-denied', 'Admins only.');
    }

    const status = await syncGigs(db);

    /* serverTimestamp() comes back as a placeholder, not a time, so it is
       dropped before sending to the browser. */
    delete status.ranAt;
    return status;
});
