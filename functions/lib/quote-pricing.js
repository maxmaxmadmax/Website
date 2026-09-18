/* ==========================================================================
   QUOTE PRICING - the shared brain of the estimate bot

   ONE set of numbers, ONE formula, used in three places:

     - the bot on the services page (shows the visitor a live range)
     - this function on submit (recomputes it so a tampered browser cannot
       email itself a fake figure)
     - the admin "Quote Pricing" editor (what Max changes)

   The numbers live in Firestore at config/quotePricing so Max can edit them
   with no code change. DEFAULT below is only the starting point: it is what
   the bot shows until Max has saved once, and the fallback if the document
   is ever missing. The public bot mirrors this exact object in
   js/quote-bot.js - if you change the shape here, change it there too.

   Everything is in CENTS, the way the rest of the money on this site is, so
   there is never a floating-point dollar hiding a rounding bug.
   ========================================================================== */

/*  Sensible placeholder numbers. Max was clear these are his to change - see
    the chosen answer "Editable in admin" - so these only have to be in the
    right ballpark, not exact.                                            */
const DEFAULT_QUOTE_PRICING = {
  currency: 'AUD',

  // How wide the range is around the point estimate. 15 => "$X - $Y" where
  // X is 15% under and Y is 15% over. A range, not a promise.
  spreadPct: 15,

  // The point estimate and both ends of the range are rounded to this, so a
  // visitor sees "$2,600 - $3,500", never "$2,617 - $3,486".
  roundToCents: 5000,

  // Base price for the kind of event. The starting figure everything else
  // adds to.
  eventTypes: [
    { key: 'wedding', label: 'Wedding', baseCents: 120000 },
    { key: 'corporate', label: 'Corporate', baseCents: 150000 },
    { key: 'private', label: 'Private Function', baseCents: 80000 },
    { key: 'festival', label: 'Festival', baseCents: 250000 },
  ],

  // What they want on the day. Multi-select, each adds its amount. This one
  // list covers services, extras, setup, lighting-only and dry hire - the
  // things Max listed - so he can add or drop a line without new code.
  services: [
    { key: 'dj', label: 'DJ', addCents: 60000 },
    { key: 'pa', label: 'Live Sound / PA', addCents: 45000 },
    { key: 'lighting', label: 'Lighting', addCents: 40000 },
    { key: 'mc', label: 'MC / Host', addCents: 35000 },
    { key: 'staging', label: 'Staging', addCents: 50000 },
    { key: 'dryhire', label: 'Dry Hire Gear', addCents: 25000 },
    { key: 'setup', label: 'Setup & Pack-down', addCents: 30000 },
  ],

  // Guest count. A bigger crowd needs more of everything, so it scales the
  // whole subtotal rather than adding a flat amount.
  sizes: [
    { key: 's', label: 'Up to 50 guests', multiplier: 1 },
    { key: 'm', label: '50 to 150 guests', multiplier: 1.25 },
    { key: 'l', label: '150 to 400 guests', multiplier: 1.6 },
    { key: 'xl', label: '400+ guests', multiplier: 2.2 },
  ],

  // Where it is. Travel and time on the road, added as a flat amount.
  locations: [
    { key: 'bowen', label: 'Bowen', travelCents: 0 },
    { key: 'airlie', label: 'Airlie Beach', travelCents: 15000 },
    { key: 'whitsundays', label: 'Whitsundays', travelCents: 20000 },
    { key: 'other', label: 'Somewhere else', travelCents: 25000 },
  ],

  // Duration. hourlyCents is charged for every hour beyond freeHours, so at
  // the default of 0 it does nothing until Max turns it on - the hours are
  // still captured on the lead either way.
  freeHours: 4,
  hourlyCents: 0,
  durations: [
    { key: '3', label: 'A few hours', hours: 3 },
    { key: '5', label: 'Half a day', hours: 5 },
    { key: '7', label: 'A full evening', hours: 7 },
    { key: '10', label: 'All day', hours: 10 },
  ],
};

/*  Round to the nearest step, never below zero. Used for both ends of the
    range so the numbers a visitor sees are clean.                        */
function roundCents(cents, step) {
  const s = step && step > 0 ? step : 1;
  const r = Math.round(cents / s) * s;
  return r < 0 ? 0 : r;
}

function find(list, key) {
  return (Array.isArray(list) ? list : []).find((x) => x && x.key === key) || null;
}

/*  THE FORMULA - the one both the bot and the server run.

    (base + service add-ons + travel + duration overage) x size multiplier,
    then a band of +/- spread% around it, both ends rounded.

    answers is what the bot collected:
      { eventType, location, size, services: [keys], hours }

    Returns { pointCents, lowCents, highCents } plus the resolved labels, so
    the caller can store readable text without looking anything up again.
    Unknown keys are ignored rather than throwing - a stale bot on a cached
    page must still produce a number, just not a wrong-shaped crash.       */
function estimate(pricing, answers) {
  const p = pricing || DEFAULT_QUOTE_PRICING;
  const a = answers || {};

  const evt = find(p.eventTypes, a.eventType);
  const loc = find(p.locations, a.location);
  const size = find(p.sizes, a.size);
  const dur = find(p.durations, a.hours) || find(p.durations, String(a.hours));

  const pickedServices = (Array.isArray(a.services) ? a.services : [])
    .map((k) => find(p.services, k))
    .filter(Boolean);

  const base = evt ? evt.baseCents || 0 : 0;
  const addons = pickedServices.reduce((sum, s) => sum + (s.addCents || 0), 0);
  const travel = loc ? loc.travelCents || 0 : 0;

  const hours = dur ? dur.hours || 0 : 0;
  const freeHours = p.freeHours || 0;
  const overageHours = Math.max(0, hours - freeHours);
  const duration = overageHours * (p.hourlyCents || 0);

  const subtotal = base + addons + travel + duration;
  const multiplier = size ? size.multiplier || 1 : 1;

  const step = p.roundToCents || 5000;
  const point = roundCents(subtotal * multiplier, step);

  const spread = (p.spreadPct || 0) / 100;
  const low = roundCents(point * (1 - spread), step);
  const high = roundCents(point * (1 + spread), step);

  return {
    pointCents: point,
    lowCents: low,
    highCents: high,
    labels: {
      eventType: evt ? evt.label : '',
      location: loc ? loc.label : '',
      size: size ? size.label : '',
      duration: dur ? dur.label : '',
      services: pickedServices.map((s) => s.label),
    },
  };
}

module.exports = { DEFAULT_QUOTE_PRICING, estimate, roundCents };
