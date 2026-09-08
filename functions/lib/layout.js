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

/* Builds a straight run of sites. */
function row({ prefix, type, count, startX, y, w, h, gap }) {
  const sites = [];

  for (let i = 0; i < count; i++) {
    sites.push({
      id: `${prefix}${i + 1}`,
      label: `${prefix}${i + 1}`,
      type,
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

    // Market stalls - centre rows
    ...row({ prefix: 'M', type: 'market', count: 8, startX: 70, y: 440, w: 90, h: 70, gap: 18 }),
    ...row({ prefix: 'N', type: 'market', count: 8, startX: 70, y: 530, w: 90, h: 70, gap: 18 }),

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

/* Food categories with their limits. A vendor picks one; when the limit is
   reached the category is closed off, both on screen and in the transaction
   that allocates the site. Change the limits in the admin dashboard. */
function defaultCategories() {
  return [
    { id: 'donuts', name: 'Donuts', limit: 1, appliesTo: 'food' },
    { id: 'burgers', name: 'Burgers', limit: 2, appliesTo: 'food' },
    { id: 'hot-chips', name: 'Hot Chips', limit: 1, appliesTo: 'food' },
    { id: 'coffee', name: 'Coffee', limit: 2, appliesTo: 'food' },
    { id: 'asian', name: 'Asian', limit: 2, appliesTo: 'food' },
    { id: 'mexican', name: 'Mexican', limit: 1, appliesTo: 'food' },
    { id: 'pizza', name: 'Pizza', limit: 1, appliesTo: 'food' },
    { id: 'bbq-meats', name: 'BBQ and Meats', limit: 2, appliesTo: 'food' },
    { id: 'seafood', name: 'Seafood', limit: 1, appliesTo: 'food' },
    { id: 'ice-cream', name: 'Ice Cream and Desserts', limit: 2, appliesTo: 'food' },
    { id: 'drinks-non-alc', name: 'Non-Alcoholic Drinks', limit: 2, appliesTo: 'food' },
    { id: 'vegan', name: 'Vegan and Vegetarian', limit: 2, appliesTo: 'food' },
    { id: 'other-food', name: 'Other Food', limit: 3, appliesTo: 'food' },
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
    // prices in cents so there is no floating point money anywhere
    pricing: {
      food: 10000,
      market: 5000,
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
