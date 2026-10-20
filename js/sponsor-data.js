/* ==========================================================================
   SPONSORSHIP - levels and past sponsors   (Max, 20 Oct 2026)

   Used by the public sponsor page (sponsor.html) and the admin Messages >
   Sponsors tab. KEEP IN STEP with SPONSOR_LEVELS in functions/index.js
   (the server counts spots left from the same keys).

   Prices are EX GST. Max: "lets go with that for now" - the event needs to
   make $10k minimum to be run properly. Change a price or a perk here, run
   node tools/bump-assets.js, and push.
   ========================================================================== */

export const SPONSOR_GOAL_CENTS = 1000000;   // $10,000

export const SPONSOR_LEVELS = [
  { key: 'platinum', name: 'Platinum - Presenting Partner', priceCents: 500000, spots: 1, perks: [
    'Event name: "Eatz & Beatz presented by [your business]"',
    'Biggest logo on the poster, banners, stage, event page and socials',
    'Your own branded spot on stage',
    '5 thank-yous from the stage on the night',
    'A free premium stall',
    'A social media feature on your business',
  ] },
  { key: 'gold', name: 'Gold', priceCents: 200000, spots: 2, perks: [
    'Large logo on the poster, event page and stage banner',
    '3 thank-yous from the stage',
    'A free stall',
    'A social media thank-you post',
  ] },
  { key: 'silver', name: 'Silver', priceCents: 100000, spots: 3, perks: [
    'Medium logo on the poster and event page',
    '2 thank-yous from the stage',
    'A social media thank-you post',
  ] },
  { key: 'bronze', name: 'Bronze', priceCents: 50000, spots: 5, perks: [
    'Small logo on the event page and poster',
    'A thank-you from the stage',
  ] },
  { key: 'supporter', name: 'Supporter - name your support', priceCents: 0, spots: 0, perks: [
    'Help with cash, prizes, services or gear - whatever suits your business',
    'Your name or logo on the event page',
    'A thank-you post on our socials',
    'We work out the details together',
  ] },
];

/*  Businesses on the Halloween poster - the "ask again" list. */
export const PAST_SPONSORS = [
  'Evolution Beauty', 'Bowen Barracudas', 'Lehmann Print Solutions', 'Bottoms on the Grass',
  'Whitsunday Autos', 'Taylamaid Whitsundays', 'Bowen Party Hire', 'Ms Sippi',
];

/*  Where the money goes - shown honestly on the sponsor page. */
export const EVENT_COSTS = [
  'Stage, sound and lighting', 'Security and first aid', 'Toilets, power and waste',
  'Permits and insurance', 'Marketing and posters', 'Kids activities and prizes',
];

/*  BIG BOWEN BUSINESSES to ask (researched 20 Oct 2026 - Max: "go after big
    business in Bowen", not our vendors). Emails only where one was published
    for community / sponsorship enquiries - the rest need an email added.  */
export const SUGGESTED_SPONSORS = [
  { business: 'Abbot Point Operations (Bravus)', email: 'Abbotpoint.community@apt1.com.au', note: 'Runs the NQXT port near Bowen - one of the biggest local employers. Their Community Support Program email (07 4786 0300).' },
  { business: 'North Queensland Bulk Ports (NQBP)', email: 'AJulian@nqbp.com.au', note: 'Community Relationship Advisor Angela Julian (07 4969 0705). Their Community Fund is for non-profits - pitch this as a sponsorship.' },
  { business: 'RATCH-Australia (Collinsville Solar Farm)', email: 'enquiries@ratchaustralia.com', note: 'Their published email for sponsorship enquiries.' },
  { business: 'Whitsunday Regional Council', email: 'info@whitsundayrc.qld.gov.au', note: 'General inbox (1300 972 753). Their Community Sponsorship Program runs in rounds.' },
  { business: 'North Queensland Farmers (Bowen Gumlu Growers)', email: 'ceo@nqfarmers.com.au', note: 'The old Bowen Gumlu Growers Association - represents the big local growers. CEO inbox (no info@).' },
  { business: 'Mulgowie Farming Company', email: 'info@mulgowie.com.au', note: 'Large family-owned grower with a Bowen packhouse (07 5465 9222).' },
  { business: 'Hillery Group', email: 'info@hillerygroup.com.au', note: 'Bowen civil and mining contractor, 167 Richmond Rd (07 4786 5100).' },
];

/*  WORTH ASKING, BUT NO PUBLIC EMAIL YET - shown at the bottom of the Sponsors
    tab with an email box, so Max can find it and add them (20 Oct 2026).  */
export const NEEDS_EMAIL = [
  { business: 'Koorelah Farms', tip: 'Big Bowen tomato grower, Inveroona Rd. Call (07) 4785 1999 and ask who handles sponsorship.' },
  { business: "McDonald's Bowen", tip: 'Backs local community awards. Ask the store manager for the franchisee\'s email.' },
  { business: 'Queensland Country Bank', tip: 'Runs "Good For Good" community grants. Ask the local branch manager for the sponsorship contact.' },
];
