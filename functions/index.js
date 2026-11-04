/* SOUNDZGOOD SERVER
   The Cloud Functions, one file per feature in features/. Helpers they share are in shared.js
   (which also starts Firebase); lib/ holds the email builders and other parts.
   Firebase reads the function list from this file's exports. */
Object.assign(exports, require('./features/vendor-booking'));
Object.assign(exports, require('./features/vendor-admin'));
Object.assign(exports, require('./features/gig-guide'));
Object.assign(exports, require('./features/quotes'));
Object.assign(exports, require('./features/quote-bot'));
Object.assign(exports, require('./features/tell'));
Object.assign(exports, require('./features/event-pages'));
Object.assign(exports, require('./features/vendor-invoices'));
Object.assign(exports, require('./features/messages'));
Object.assign(exports, require('./features/waitlist'));
Object.assign(exports, require('./features/sponsors'));
Object.assign(exports, require('./features/customer-details'));
Object.assign(exports, require('./features/gear-crew'));
Object.assign(exports, require('./features/dj-gigs'));
Object.assign(exports, require('./features/inventory-photos'));
