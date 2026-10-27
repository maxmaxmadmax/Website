// SOUNDZGOOD DJ BOOKING TERMS & CONDITIONS
// Shown on DJ / entertainment quotes
// (js/quote-view.js) and the /dj-terms page. Production quotes keep the
// main terms in js/terms-data.js.
//
// How to edit - same as terms-data.js:
//   - each clause is [title, [lines]]
//   - a line starting with "• " is a bullet point
//   - a line starting with "## " is a small bold sub-heading
//   - every other line is a normal paragraph
// After editing, run: node tools/bump-assets.js

export const DJ_TERMS_UPDATED = 'October 2026';

export const DJ_TERMS_INTRO = [
  "These DJ Booking Terms & Conditions apply when SoundzGood (“SoundzGood”, “we”, “us” or “our”) supplies a DJ or other entertainer to a venue or client.",
  "By accepting a quote, paying a deposit or invoice, clicking “Accept”, or instructing SoundzGood to proceed, the venue or client (“you” or “your”) agrees to these Terms & Conditions.",
  "The accepted quote and these Terms & Conditions together form the agreement between SoundzGood and you. Where SoundzGood also supplies sound, lighting or other equipment, our main Terms & Conditions (soundzgood.com.au/terms) apply to that equipment as well.",
];

export const DJ_TERMS = [
  ["Bookings & payment", [
    "Quotes are valid for the period stated on the quote and remain subject to DJ availability until the required payment has been received.",
    "## New venues and clients:",
    "• Payment in full is required to confirm the booking. Until then the DJ is held for you, but the booking is not confirmed.",
    "## Existing venues and clients:",
    "• A 50% deposit is required to secure the booking.",
    "• The remaining balance is due 7 days before the booking unless otherwise agreed in writing.",
    "A booking is not confirmed until the required deposit or payment has been received.",
  ]],
  ["What the quote includes", [
    "The quote lists the DJ’s performance fee for the booked hours, and may also include travel, a booking and coordination fee, and performer superannuation.",
    "## Performer superannuation:",
    "Australian law requires superannuation to be paid for performers. Where shown on the quote, SoundzGood charges it and pays it into the DJ’s super fund.",
    "## Travel:",
    "Where the DJ travels from another town, the quoted travel charge covers the return trip.",
  ]],
  ["Overdue payments", [
    "If an invoice remains unpaid for more than 28 days after its due date, SoundzGood may apply a late payment charge equal to 2% of the outstanding balance.",
    "A further 2% of the outstanding balance may be charged for each additional full month that the amount remains unpaid.",
    "SoundzGood may also recover reasonable costs incurred in recovering overdue amounts, to the extent permitted by law.",
    "SoundzGood may suspend future bookings while an account remains overdue.",
  ]],
  ["Cancellation by the venue", [
    "We understand that plans sometimes change and will always try to deal with genuine circumstances reasonably.",
    "Unless otherwise agreed:",
    "## More than 30 days before the booking:",
    "Payments may be refunded less any reasonable costs or commitments already incurred by SoundzGood.",
    "## Between 8 and 30 days before the booking:",
    "The deposit may be non-refundable.",
    "## 7 days or less before the booking:",
    "Up to the full booking amount may be payable.",
    "Where practical, SoundzGood may allow payments to be transferred to a rescheduled date.",
    "Nothing in this clause limits any rights available under Australian Consumer Law.",
  ]],
  ["If your DJ can’t make it", [
    "If the booked DJ is unable to perform because of illness, emergency or other circumstances outside their control, SoundzGood will supply a replacement DJ of a similar style and standard.",
    "A change of DJ under this clause is not a reason to cancel the booking.",
    "If SoundzGood cannot supply a suitable replacement, you will receive a full refund of the amounts paid for that booking, and SoundzGood will have no further liability for it.",
  ]],
  ["What the venue supplies", [
    "Unless the quote says SoundzGood is supplying them, the venue must provide, ready and working at the booked start time:",
    "• a working PA / sound system suitable for the room",
    "• DJ decks to at least this standard: a Pioneer XDJ-RX3, or 2 × Pioneer CDJ-3000 with a Pioneer DJM-A9 mixer",
    "• a sturdy table or DJ booth, with power right next to it",
    "• a safe, dry place to set up, out of the way of patrons",
    "• drinks and a meal for the DJ during the booking.",
    "## Accommodation:",
    "Where the DJ has to travel away from their home town for the booking, the venue must provide reasonable accommodation for the DJ for that night.",
  ]],
  ["Set times, late starts & extra time", [
    "The DJ will be ready to play at the booked start time.",
    "If the set starts late for a reason caused by the venue (for example, equipment not ready, no power, or the room not open), the full booked hours remain payable.",
    "If the venue asks the DJ to play past the booked finish time and the DJ agrees, the extra time is charged at the DJ’s hourly rate in 15-minute blocks and added to the invoice.",
  ]],
  ["Music & requests", [
    "The DJ will read the room and play to the crowd.",
    "The DJ will follow reasonable instructions from the venue, such as music style, volume or no explicit lyrics before a set time.",
    "The DJ welcomes requests from patrons and staff, but may decline requests that don’t suit the room or the night.",
  ]],
  ["Music licensing & noise", [
    "The venue is responsible for holding its own licence to play music to the public (for example, a OneMusic Australia licence). Licensing is not included in the SoundzGood quote.",
    "The venue is responsible for any noise limits, curfews and other conditions that apply to the venue, and must tell the DJ about them before the set.",
  ]],
  ["Safety & conduct", [
    "The venue must provide a safe working environment for the DJ, including reasonable security and protection of the DJ area from patrons.",
    "The DJ will keep playing for the booked hours unless the venue manager agrees to stop the set.",
    "Nothing in these Terms requires the DJ to keep working where there is a serious and immediate risk to their health or safety, as allowed under work health and safety laws.",
  ]],
  ["Damage to the DJ’s equipment", [
    "If the DJ’s own equipment (for example, headphones, USB drives or a controller) is damaged by patrons, venue staff or venue conditions during the booking, the venue will pay the reasonable cost of repairing or replacing it.",
  ]],
  ["Recording & streaming", [
    "The venue may film short clips of the DJ for its own social media.",
    "Full recordings, livestreams or broadcasts of a DJ set need SoundzGood’s written approval first.",
    "SoundzGood and the DJ may photograph and film the booking for their own promotion, websites and social media.",
  ]],
  ["Booking our DJs directly", [
    "SoundzGood introduces you to our DJs. For 12 months after your last booking with SoundzGood, you agree not to book a SoundzGood DJ directly, or through anyone else, without going through SoundzGood.",
    "If you do, you agree to pay SoundzGood an amount equal to the DJ booking fee that would have applied to each of those bookings.",
  ]],
  ["Weather & events outside our control", [
    "SoundzGood is not responsible for delay or inability to perform caused by circumstances reasonably outside our control.",
    "This may include severe weather, natural disasters, fire or flood, venue closures, power failures, emergencies, government restrictions, road closures or the acts of third parties.",
    "Where practical, SoundzGood will work with you to find a reasonable solution or reschedule the booking. Reasonable costs already incurred may remain payable.",
  ]],
  ["Liability", [
    "SoundzGood will provide its services with reasonable care and skill.",
    "To the extent permitted by law, SoundzGood is not responsible for loss or damage caused by circumstances outside our reasonable control, the venue or its patrons, venue-supplied equipment, or information withheld from or incorrectly supplied to SoundzGood.",
    "To the extent permitted by law, SoundzGood is not liable for indirect or consequential loss that was not reasonably foreseeable, including loss of business opportunity or profit.",
  ]],
  ["Australian Consumer Law", [
    "Nothing in these Terms is intended to exclude or limit rights or guarantees available under the Australian Consumer Law where those rights or guarantees cannot legally be excluded or limited.",
    "Where Australian Consumer Law applies, these Terms operate subject to those rights.",
  ]],
  ["Governing law", [
    "These Terms are governed by the laws of Queensland, Australia.",
    "The parties submit to the jurisdiction of the courts and tribunals of Queensland, subject to any rights that cannot legally be restricted.",
  ]],
  ["Acceptance", [
    "You confirm acceptance of the quote and these Terms & Conditions by clicking an online acceptance button, ticking an acceptance checkbox, signing the quote, making any payment, or instructing SoundzGood to proceed with the booking.",
    "You confirm that you have had a reasonable opportunity to review these Terms before accepting the booking.",
  ]],
  ["SoundzGood discretion", [
    "Where these Terms give SoundzGood discretion, SoundzGood will exercise that discretion reasonably and in good faith.",
    "Nothing prevents SoundzGood from waiving a fee, charge or contractual right where we consider it reasonable to do so.",
  ]],
];
