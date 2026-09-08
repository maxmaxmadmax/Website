/* --------------------------------------------------------------------------
   Vendor site map

   Draws the site plan as an SVG with a viewBox, so it scales to whatever
   width it is given and stays readable on a phone without any pixel maths.

   The layout is not hard coded here. Sites arrive from Firestore and are
   drawn from their x / y / w / h, so the plan can be rearranged from the
   admin dashboard without touching this file. The small layout at the
   bottom is only used for the offline preview.
   -------------------------------------------------------------------------- */

const STATUS_ORDER = ['available', 'held', 'booked', 'blocked'];

export class VendorMap {
  /**
   * @param {HTMLElement} host       element to draw into
   * @param {object}      options
   * @param {function}    options.onSelect  called with a site when chosen
   */
  constructor(host, options = {}) {
    this.host = host;
    this.onSelect = options.onSelect || function () {};

    this.sites = [];
    this.landmarks = [];
    this.mapSize = { width: 1000, height: 700 };

    this.vendorType = null;   // only sites of this type are selectable
    this.stallSize = null;    // market only: 3x3 or 3x6
    this.selectedId = null;
    this.myUid = null;        // so my own hold does not look unavailable

    this.svg = null;
  }

  setVendorType(type, stallSize) {
    this.vendorType = type;
    this.stallSize = stallSize || null;
    this.render();
  }

  setUid(uid) {
    this.myUid = uid;
  }

  setLayout({ sites, landmarks, mapSize }) {
    if (sites) this.sites = sites;
    if (landmarks) this.landmarks = landmarks;
    if (mapSize) this.mapSize = mapSize;
    this.render();
  }

  setSelected(siteId) {
    this.selectedId = siteId;
    this.render();
  }

  /* What a site looks like to *this* visitor. My own held site reads as
     mine, not as unavailable. */
  statusFor(site) {
    if (site.status === 'held') {
      if (this.myUid && site.heldBy === this.myUid) return 'mine';

      // A hold whose clock ran out is really available again; the scheduled
      // function will tidy the record shortly.
      const expiry = site.holdExpiresAt;
      const ms = expiry && expiry.toMillis ? expiry.toMillis()
        : (typeof expiry === 'number' ? expiry : null);
      if (ms !== null && ms <= Date.now()) return 'available';

      return 'held';
    }
    return site.status || 'available';
  }

  /* A site is only offered when it matches both the vendor type and, for
     market stalls, the marquee size they are paying for. */
  matchesVendor(site) {
    if (!this.vendorType) return false;
    if (site.type !== this.vendorType) return false;
    if (this.vendorType === 'market' && this.stallSize && site.size &&
        site.size !== this.stallSize) {
      return false;
    }
    return true;
  }

  isSelectable(site) {
    if (!this.matchesVendor(site)) return false;

    const status = this.statusFor(site);
    return status === 'available' || status === 'mine';
  }

  counts() {
    const out = { available: 0, held: 0, booked: 0, blocked: 0, mine: 0 };
    for (const site of this.sites) {
      if (this.vendorType && !this.matchesVendor(site)) continue;
      const s = this.statusFor(site);
      out[s] = (out[s] || 0) + 1;
    }
    return out;
  }

  render() {
    if (!this.host) return;

    const { width, height } = this.mapSize;
    const ns = 'http://www.w3.org/2000/svg';

    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', 'vmap-svg');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', 'Vendor site map');

    // ---- fixed furniture, drawn first so sites sit on top ----------------
    for (const mark of this.landmarks) {
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', `vmap-landmark vmap-landmark-${mark.kind || 'other'}`);

      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', mark.x);
      rect.setAttribute('y', mark.y);
      rect.setAttribute('width', mark.w);
      rect.setAttribute('height', mark.h);
      rect.setAttribute('rx', 8);
      g.appendChild(rect);

      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', mark.x + mark.w / 2);
      label.setAttribute('y', mark.y + mark.h / 2 + 6);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'vmap-landmark-text');
      label.textContent = mark.label;
      g.appendChild(label);

      svg.appendChild(g);
    }

    // ---- the bookable sites ---------------------------------------------
    for (const site of this.sites) {
      const status = this.statusFor(site);
      const selectable = this.isSelectable(site);
      const isSelected = site.id === this.selectedId;
      const wrongType = this.vendorType && !this.matchesVendor(site);

      const g = document.createElementNS(ns, 'g');
      g.setAttribute(
        'class',
        [
          'vmap-site',
          `is-${status}`,
          `type-${site.type}`,
          selectable ? 'is-selectable' : 'is-locked',
          isSelected ? 'is-selected' : '',
          wrongType ? 'is-wrong-type' : '',
        ].filter(Boolean).join(' ')
      );

      if (selectable) {
        g.setAttribute('tabindex', '0');
        g.setAttribute('role', 'button');
        g.setAttribute(
          'aria-label',
          `Site ${site.label}, ${site.type}, ${status === 'mine' ? 'your hold' : status}`
        );

        const choose = (ev) => {
          ev.preventDefault();
          this.onSelect(site);
        };
        g.addEventListener('click', choose);
        g.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') choose(ev);
        });
      } else {
        g.setAttribute('aria-hidden', 'true');
      }

      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', site.x);
      rect.setAttribute('y', site.y);
      rect.setAttribute('width', site.w);
      rect.setAttribute('height', site.h);
      rect.setAttribute('rx', 7);
      g.appendChild(rect);

      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', site.x + site.w / 2);
      label.setAttribute('y', site.y + site.h / 2 + 2);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'vmap-site-label');
      label.textContent = site.label;
      g.appendChild(label);

      // A short status word under the label, so the map is readable
      // without relying on colour alone.
      const sub = document.createElementNS(ns, 'text');
      sub.setAttribute('x', site.x + site.w / 2);
      sub.setAttribute('y', site.y + site.h / 2 + 20);
      sub.setAttribute('text-anchor', 'middle');
      sub.setAttribute('class', 'vmap-site-sub');
      sub.textContent = this.subLabel(site, status, wrongType);
      g.appendChild(sub);

      svg.appendChild(g);
    }

    this.host.innerHTML = '';
    this.host.appendChild(svg);
    this.svg = svg;
  }

  subLabel(site, status, wrongType) {
    // For a mismatch, say what it actually is - "3x6" is more use to a
    // market vendor than "market".
    if (wrongType) return site.size || site.type;
    if (status === 'mine') return 'YOURS';
    if (status === 'available') return 'FREE';
    if (status === 'held') return 'ON HOLD';
    if (status === 'booked') return 'TAKEN';
    if (status === 'blocked') return 'CLOSED';
    return '';
  }
}

/* --------------------------------------------------------------------------
   Offline preview layout

   Only used when Firebase has not been configured yet, so the page can be
   opened and reviewed before the backend exists. The real layout lives in
   Firestore and is seeded from functions/lib/layout.js.
   -------------------------------------------------------------------------- */
export function previewLayout() {
  const sites = [];

  const run = (prefix, type, count, startX, y, w, h, gap, size) => {
    for (let i = 0; i < count; i++) {
      sites.push({
        id: `${prefix}${i + 1}`,
        label: `${prefix}${i + 1}`,
        type,
        ...(size ? { size } : {}),
        x: startX + i * (w + gap),
        y, w, h,
        status: 'available',
      });
    }
  };

  run('F', 'food', 6, 90, 170, 110, 80, 26);
  run('G', 'food', 6, 90, 300, 110, 80, 26);
  run('M', 'market', 8, 70, 440, 90, 70, 18, '3x3');
  run('N', 'market', 4, 70, 530, 190, 70, 18, '3x6');
  run('C', 'community', 4, 70, 630, 120, 55, 24);

  // a couple of pre-set states so the legend means something in preview
  sites[2].status = 'booked';
  sites[7].status = 'blocked';

  return {
    mapSize: { width: 1000, height: 700 },
    sites,
    landmarks: [
      { id: 'stage', label: 'MAIN STAGE', kind: 'stage', x: 300, y: 30, w: 400, h: 90 },
      { id: 'bar', label: 'BAR (SoundzGood)', kind: 'bar', x: 760, y: 170, w: 170, h: 110 },
      { id: 'toilets', label: 'TOILETS', kind: 'facility', x: 760, y: 320, w: 170, h: 70 },
      { id: 'entry', label: 'ENTRY', kind: 'entry', x: 760, y: 610, w: 170, h: 70 },
      { id: 'walkway', label: 'MAIN WALKWAY', kind: 'path', x: 60, y: 262, w: 660, h: 28 },
    ],
  };
}

/* Mirrors functions/lib/layout.js so the preview shows the real list. */
export function previewCategories() {
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
      count: 0,
    }));

  const all = [
    ...build(food, 'food', 2, 4),
    ...build(market, 'market', 6, 10),
  ];

  // one of each full in preview, so the FULL state is visible
  all.find((c) => c.id === 'coffee').count = 2;
  all.find((c) => c.id === 'jewellery').count = 6;

  return all;
}

export { STATUS_ORDER };
