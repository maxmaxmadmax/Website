/* =========================================================================
   SETUP & PACK-DOWN LABOUR RATES (Max, 15 Oct 2026)

   KEEP IN STEP with the copy in js/admin-app.js (search "LABOUR RATES").

   - $75/hr base.  Saturday x1.25.  Sunday x1.5.  Public holiday x1.5.
   - Pack-down = 50% of setup time. Setup is charged on the FIRST hire day,
     pack-down on the LAST hire day,
     each at that day's rate.
   - Each part: minimum 1 hour, then rounded UP to the half hour.
   - Public holidays: Queensland list below (from qld.gov.au, checked
     15 Oct 2026), plus local show holidays, which only count in their own
     district (matched on the delivery town; pickup = Bowen). Add each new
     year's dates when the Government publishes them.
   ========================================================================= */
const LABOUR_RATE_CENTS = 7500;   // $75/hr (Max, 17 Oct 2026 - was $85) - KEEP IN STEP with js/admin-app.js
const PACKDOWN_PCT = 0.5;   // pack-down = 50% of setup time (Max, 15 Oct 2026)
const LOADING = { saturday: 1.25, sunday: 1.5, holiday: 1.5 };

const QLD_PUBLIC_HOLIDAYS = {
  '2026-01-01': "New Year's Day", '2026-01-26': 'Australia Day',
  '2026-04-03': 'Good Friday', '2026-04-04': 'Easter Saturday', '2026-04-05': 'Easter Sunday', '2026-04-06': 'Easter Monday',
  '2026-04-25': 'Anzac Day', '2026-05-04': 'Labour Day', '2026-10-05': "King's Birthday",
  '2026-12-25': 'Christmas Day', '2026-12-26': 'Boxing Day', '2026-12-28': 'Boxing Day (additional)',
  '2027-01-01': "New Year's Day", '2027-01-26': 'Australia Day',
  '2027-03-26': 'Good Friday', '2027-03-27': 'Easter Saturday', '2027-03-28': 'Easter Sunday', '2027-03-29': 'Easter Monday',
  '2027-04-26': 'Anzac Day', '2027-05-03': 'Labour Day', '2027-10-04': "King's Birthday",
  '2027-12-25': 'Christmas Day', '2027-12-27': 'Christmas Day (additional)',
  '2027-12-26': 'Boxing Day', '2027-12-28': 'Boxing Day (additional)',
  '2028-01-01': "New Year's Day", '2028-01-03': "New Year's Day (additional)", '2028-01-26': 'Australia Day',
  '2028-04-14': 'Good Friday', '2028-04-15': 'Easter Saturday', '2028-04-16': 'Easter Sunday', '2028-04-17': 'Easter Monday',
  '2028-04-25': 'Anzac Day', '2028-05-01': 'Labour Day', '2028-10-02': "King's Birthday",
  '2028-12-25': 'Christmas Day', '2028-12-26': 'Boxing Day',
};

/*  Local show holidays - only in their own district. home: true = also
    applies to pickup / no-delivery jobs (we're in Bowen).               */
const SHOW_HOLIDAYS = [
  { date: '2026-06-19', name: 'Whitsunday Show holiday', towns: ['proserpine', 'airlie', 'cannonvale'] },
  { date: '2026-06-23', name: 'Bowen Show holiday', towns: ['bowen', 'guthalungra', 'gumlu', 'bogie'], home: true },
  { date: '2026-11-03', name: 'Collinsville Show holiday', towns: ['collinsville'] },
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isoOk(iso) { return /^\d{4}-\d{2}-\d{2}$/.test(String(iso || '')); }

/*  { mult, label } for one day. forceHoliday = the "public holiday" tick. */
function labourDayRate(iso, town, forceHoliday) {
  if (forceHoliday) return { mult: LOADING.holiday, label: 'public holiday surcharge' };
  if (!isoOk(iso)) return { mult: 1, label: '' };
  if (QLD_PUBLIC_HOLIDAYS[iso]) return { mult: LOADING.holiday, label: 'public holiday surcharge (' + QLD_PUBLIC_HOLIDAYS[iso] + ')' };
  const t = String(town || '').toLowerCase();
  const show = SHOW_HOLIDAYS.find((s) => s.date === iso && (t ? s.towns.some((w) => t.includes(w)) : s.home));
  if (show) return { mult: LOADING.holiday, label: 'public holiday surcharge (' + show.name + ')' };
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 0) return { mult: LOADING.sunday, label: 'Sunday weekend surcharge' };
  if (dow === 6) return { mult: LOADING.saturday, label: 'Saturday weekend surcharge' };
  return { mult: 1, label: '' };
}

/*  Minimum 1 hour, then up to the next half hour. */
function labourHours(mins) {
  if (!mins || mins <= 0) return 0;
  if (mins <= 60) return 1;
  return Math.ceil(mins / 30) / 2;
}

function shortDate(iso) {
  if (!isoOk(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return DAY_NAMES[dt.getUTCDay()].slice(0, 3) + ' ' + d + ' ' + mon;
}

/*  The two parts for a job. setupMins = total setup man-minutes.
    opts: { startDate, endDate, town, holidaySetup, holidayPack }       */
function labourParts(setupMins, opts) {
  const o = opts || {};
  const setup = Math.max(0, Math.round(setupMins || 0));
  if (!setup) return [];
  const pack = Math.round(setup * PACKDOWN_PCT);
  const start = o.startDate || '';
  const end = o.endDate || o.startDate || '';
  return [
    { key: 'setup', name: 'Setup', date: start, mins: setup, force: !!o.holidaySetup },
    { key: 'pack', name: 'Pack-down', date: end, mins: pack, force: !!o.holidayPack },
  ].filter((p) => p.mins > 0).map((p) => {
    const hours = labourHours(p.mins);
    const rate = labourDayRate(p.date, o.town, p.force);
    const cents = Math.round(hours * LABOUR_RATE_CENTS * rate.mult);
    const hrs = hours + ' hr' + (hours === 1 ? '' : 's');
    const loading = rate.mult === 1 ? '' : ' + ' + Math.round((rate.mult - 1) * 100) + '% ' + rate.label;
    return {
      ...p, hours, mult: rate.mult, rateLabel: rate.label, cents,
      // what the client reads, e.g. "Setup - Sat 31 Oct" / "3 hrs @ $75/hr + 25% Saturday weekend surcharge"
      lineName: p.name + (shortDate(p.date) ? ' – ' + shortDate(p.date) : ''),
      lineDesc: `${hrs} @ $${LABOUR_RATE_CENTS / 100}/hr${loading}`,
    };
  });
}

module.exports = { LABOUR_RATE_CENTS, PACKDOWN_PCT, LOADING, labourParts, labourDayRate, labourHours };
