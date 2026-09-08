/* --------------------------------------------------------------------------
   Default site layout for Bowen Sports Complex.

   This is a SEED only. Once it has been written to Firestore the layout lives
   there and can be changed from the admin dashboard - moving a site, changing
   its type, adding rows - without touching this file or redeploying.

   Coordinates are in an arbitrary 1000 x 700 space. The map scales that to
   whatever width it is drawn at, so the numbers below are not pixels.
   -------------------------------------------------------------------------- */

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 700;

/* Builds a straight run of sites.
   `size` only applies to market stalls, which come in 3x3 and 3x6. */
function row({ prefix, type, count, startX, y, w, h, gap, size }) {
  const sites = [];

  for (let i = 0; i < count; i++) {
    sites.push({
      id: `${prefix}${i + 1}`,
      label: `${prefix}${i + 1}`,
      type,
      ...(size ? { size } : {}),
      x: startX + i * (w + gap),
      y,
      w,
      h,
      status: 'available',
      notes: '',
    });
  }

  return sites;
}

/* The schematic: stage at the top, food along both sides of the main
   thoroughfare, market stalls across the middle, community groups near the
   entry. Adjust freely in the admin dashboard afterwards. */
function defaultSites() {
  return [
    // Food vendors - the two runs flanking the main walkway
    ...row({ prefix: 'F', type: 'food', count: 6, startX: 90, y: 170, w: 110, h: 80, gap: 26 }),
    ...row({ prefix: 'G', type: 'food', count: 6, startX: 90, y: 300, w: 110, h: 80, gap: 26 }),

    // Market stalls - 3x3 marquees on the first row, 3x6 on the second.
    // The 3x6 sites are drawn twice as wide so the plan reads true to
    // the ground.
    ...row({ prefix: 'M', type: 'market', size: '3x3', count: 8, startX: 70, y: 440, w: 90, h: 70, gap: 18 }),
    ...row({ prefix: 'N', type: 'market', size: '3x6', count: 4, startX: 70, y: 530, w: 190, h: 70, gap: 18 }),

    // Community groups - near the entry
    ...row({ prefix: 'C', type: 'community', count: 4, startX: 70, y: 630, w: 120, h: 55, gap: 24 }),
  ];
}

/* Fixed furniture drawn on the map for orientation. Not bookable. */
function defaultLandmarks() {
  return [
    { id: 'stage', label: 'MAIN STAGE', kind: 'stage', x: 300, y: 30, w: 400, h: 90 },
    { id: 'bar', label: 'BAR (SoundzGood)', kind: 'bar', x: 760, y: 170, w: 170, h: 110 },
    { id: 'toilets', label: 'TOILETS', kind: 'facility', x: 760, y: 320, w: 170, h: 70 },
    { id: 'entry', label: 'ENTRY', kind: 'entry', x: 760, y: 610, w: 170, h: 70 },
    { id: 'walkway', label: 'MAIN WALKWAY', kind: 'path', x: 60, y: 262, w: 660, h: 28 },
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
       Market stalls are priced by marquee size, so the key for a market
       booking is market-<size>. See priceKeyFor() in functions/index.js. */
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
