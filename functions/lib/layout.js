/* --------------------------------------------------------------------------
   Site layout for Bowen Sports Complex - Eatz & Beatz Halloween Edition.

   Drawn from the event site plan: stage at the top, ten food vans flanking
   the central walkway (four each side plus two on the angle), the bar in the
   middle, and forty market stalls in four columns of ten.

   This is a SEED only. Once written to Firestore the layout lives there and
   can be changed from the admin dashboard - moving a stall, changing a type,
   adding a row - without touching this file or redeploying.

   Coordinates are in an arbitrary 760 x 1420 space, portrait to match the
   real ground. The map scales that to whatever width it is drawn at, so the
   numbers below are not pixels.

   MARKET STALLS AND THE 3x6 OPTION
   Every stall on the plan is one 3 m frontage bay. A 3x3 booking takes one
   bay; a 3x6 booking takes that bay and the one directly below it, which is
   why each stall carries `neighbourId`. Both bays are allocated in a single
   transaction, so a 3x6 can never end up with only half its space.
   -------------------------------------------------------------------------- */

const MAP_WIDTH = 760;
const MAP_HEIGHT = 1420;

/* A vertical run of sites. */
function column({ ids, type, x, y, w, h, gap, rotate }) {
  return ids.map((id, i) => ({
    id,
    label: id,
    type,
    x,
    y: y + i * (h + gap),
    w,
    h,
    ...(rotate ? { rotate } : {}),
    status: 'available',
    notes: '',
  }));
}

/* Numbers 1..n with a prefix: M1, M2, ... */
function ids(prefix, from, to) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(`${prefix}${i}`);
  return out;
}

/* Ten food vans: four down each side of the walkway, plus two on the
   angle at the bottom of the run, as drawn on the plan. */
function foodSites() {
  const w = 74;
  const h = 92;
  const gap = 22;

  const left = column({ ids: ids('F', 1, 4), type: 'food', x: 118, y: 132, w, h, gap });
  const right = column({ ids: ids('F', 5, 8), type: 'food', x: 568, y: 132, w, h, gap });

  // The two angled vans closing off the bottom of the food run
  const angled = [
    { id: 'F9', label: 'F9', type: 'food', x: 96, y: 592, w, h, rotate: -38, status: 'available', notes: '' },
    { id: 'F10', label: 'F10', type: 'food', x: 590, y: 592, w, h, rotate: 38, status: 'available', notes: '' },
  ];

  return [...left, ...right, ...angled];
}

/* Forty market stalls: four columns of ten.
   Each stall knows the one below it, so a 3x6 booking can take a pair. */
function marketSites() {
  const w = 84;
  const h = 56;
  const gap = 12;
  const top = 726;

  const columns = [
    { ids: ids('M', 1, 10), x: 68 },
    { ids: ids('M', 11, 20), x: 272 },
    { ids: ids('M', 21, 30), x: 372 },
    { ids: ids('M', 31, 40), x: 576 },
  ];

  const sites = [];

  for (const col of columns) {
    const built = column({ ids: col.ids, type: 'market', x: col.x, y: top, w, h, gap });

    built.forEach((site, i) => {
      // The stall directly below, in the same column. The last one in a
      // column has no partner, so it can only ever be a 3x3.
      site.neighbourId = i < built.length - 1 ? built[i + 1].id : null;
      site.column = col.ids[0];
    });

    sites.push(...built);
  }

  return sites;
}

function defaultSites() {
  return [...foodSites(), ...marketSites()];
}

/* Fixed furniture drawn for orientation. Not bookable.
   The bar is ours, which is why there are no bar vendor sites. */
function defaultLandmarks() {
  return [
    { id: 'stage', label: 'STAGE', kind: 'stage', x: 296, y: 24, w: 168, h: 74 },
    { id: 'front-barrier', label: '', kind: 'barrier', x: 150, y: 112, w: 460, h: 8 },

    { id: 'bar', label: 'BAR', kind: 'bar', x: 306, y: 566, w: 148, h: 104 },

    { id: 'walkway', label: 'WALKWAY', kind: 'path', x: 368, y: 130, w: 24, h: 420 },

    { id: 'barrier-left', label: '', kind: 'barrier', x: 40, y: 660, w: 8, h: 300 },
    { id: 'barrier-right', label: '', kind: 'barrier', x: 712, y: 660, w: 8, h: 300 },

    { id: 'entry', label: 'ENTRY', kind: 'entry', x: 296, y: 1360, w: 168, h: 46 },
  ];
}

/* Categories a vendor picks from, and how many of each are allowed.
   When a category reaches its limit it closes off, both on screen and in
   the transaction that allocates the site.

   The limits below are only a starting point. Change any of them in the
   admin dashboard - raising one reopens the category straight away,
   because the page compares the live count against the limit rather than
   storing a "full" flag. Food is capped tighter than market stalls so the
   food mix stays varied; the catch-all "Other" rows are looser. */
function defaultCategories() {
  const food = [
    ['burgers-fries-american', 'Burgers / Loaded Fries / American'],
    ['pizza-italian', 'Pizza / Italian'],
    ['mexican-tacos', 'Mexican / Tacos / Nachos'],
    ['asian-noodles', 'Asian / Noodles / Dumplings'],
    ['indian-curry', 'Indian / Curry'],
    ['bbq-smoked-meats', 'BBQ / Smoked Meats'],
    ['seafood', 'Seafood'],
    ['chicken-wings', 'Chicken / Wings'],
    ['hot-dogs-sausages', 'Hot Dogs / Sausages'],
    ['donuts-churros', 'Donuts / Churros'],
    ['ice-cream-gelato', 'Ice Cream / Gelato / Frozen Desserts'],
    ['cakes-baked-sweets', 'Cakes / Cupcakes / Baked Sweets'],
    ['lollies-fairy-floss', 'Lollies / Fairy Floss / Sweet Treats'],
    ['coffee', 'Coffee'],
    ['drinks-juice-smoothies', 'Non-Alcoholic Drinks / Juice / Smoothies'],
    ['healthy-salads-acai', 'Healthy / Salads / Acai'],
    ['vegetarian-vegan', 'Vegetarian / Vegan Specialty'],
    ['other-food', 'Other Food'],
  ];

  const market = [
    ['clothing-fashion', 'Clothing / Fashion'],
    ['jewellery', 'Jewellery'],
    ['candles-home-fragrance', 'Candles / Home Fragrance'],
    ['arts-prints-photography', 'Arts / Prints / Photography'],
    ['handmade-crafts', 'Handmade Crafts'],
    ['homewares-decor', 'Homewares / Decor'],
    ['beauty-skincare', 'Beauty / Skincare'],
    ['plants-garden', 'Plants / Garden'],
    ['toys-kids-products', 'Toys / Kids Products'],
    ['pet-products', 'Pet Products'],
    ['local-produce-packaged', 'Local Produce / Packaged Food'],
    ['gifts-novelty', 'Gifts / Novelty Products'],
    ['spiritual-crystals', 'Spiritual / Crystals'],
    ['services-promotional', 'Services / Promotional Stall'],
    ['community-charity-club', 'Community / Charity / Club'],
    ['other-market', 'Other Market Stall'],
  ];

  const build = (rows, appliesTo, limit, otherLimit) =>
    rows.map(([id, name]) => ({
      id,
      name,
      appliesTo,
      limit: id.startsWith('other-') ? otherLimit : limit,
    }));

  return [
    ...build(food, 'food', 2, 4),
    ...build(market, 'market', 6, 10),
  ];
}

/* The first event. */
function defaultEvent() {
  return {
    name: 'Eatz & Beatz',
    subtitle: 'Halloween Edition',
    dateISO: '2026-10-31',
    dateLabel: 'Saturday 31 October 2026',
    venue: 'Bowen Sports Complex',
    location: 'Bowen, Queensland',
    status: 'open',
    holdMinutes: 10,
    currency: 'aud',

    /* Prices in cents so there is no floating point money anywhere.
       Market stalls are priced by frontage: 3x3 takes one bay, 3x6 takes
       two adjoining bays. See priceKeyFor() in functions/index.js. */
    pricing: {
      food: 10000,
      'market-3x3': 5000,
      'market-3x6': 8000,
      community: 0,
    },

    map: {
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
    },

    landmarks: defaultLandmarks(),
  };
}

module.exports = {
  MAP_WIDTH,
  MAP_HEIGHT,
  defaultEvent,
  defaultSites,
  defaultCategories,
  defaultLandmarks,
};
