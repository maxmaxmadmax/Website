/* --------------------------------------------------------------------------
   Firebase settings for the SoundzGood vendor signup.

   These values are NOT secrets. A Firebase web config is meant to be public -
   what protects your data is the Firestore and Storage rules, plus the Cloud
   Functions, not hiding these keys. This repository is public, so:

       SAFE HERE          apiKey, authDomain, projectId, appId, etc
       NEVER HERE         the Stripe secret key, any service account file,
                          the Stripe webhook signing secret

   Those live only in Firebase Functions secrets:
       firebase functions:secrets:set STRIPE_SECRET_KEY
       firebase functions:secrets:set STRIPE_WEBHOOK_SECRET

   ---------------------------------------------------------------------------
   TO GO LIVE, replace the placeholder values below with the ones from
   Firebase console -> Project settings -> Your apps -> Web app -> Config.
   Until then the page runs in preview mode: everything is browsable, but
   nothing is saved and no payment can be taken.
   -------------------------------------------------------------------------- */

export const firebaseConfig = {
  apiKey: 'AIzaSyCVWdD7fE24MuN-v5XQLObJbSHYRUbPlPY',
  authDomain: 'soundzgood-8c86f.firebaseapp.com',
  projectId: 'soundzgood-8c86f',
  storageBucket: 'soundzgood-8c86f.firebasestorage.app',
  messagingSenderId: '188284062614',
  appId: '1:188284062614:web:5e9f6f64713fb2e02dabb7',
};

/* The region the Cloud Functions are deployed to. Matches
   setGlobalOptions in functions/index.js. */
export const functionsRegion = 'australia-southeast1';

/* The event being sold. Matches the document id created by seedEvent. */
export const eventId = 'eatz-beatz-halloween-2026';

/* True once the placeholders above have been filled in. The page checks this
   and, if false, runs in preview mode rather than throwing errors at people. */
export const isFirebaseConfigured =
  !Object.values(firebaseConfig).some(
    (value) => typeof value === 'string' && value.startsWith('REPLACE_WITH')
  );
