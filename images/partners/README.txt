PARTNER LOGOS
=============

The "Trusted Across North Queensland" strip on the services page. One file
per partner, named after them in lower case with dashes:

    whitsunday-regional-council.png     in place
    grand-view-hotel.png
    cape-gloucester-eco-resort.png
    stonka-fishing-challenge.png
    don-river-dash.png
    merinda-village-hotel.png

Until a file is here that logo shows the partner's name as text instead, so
a missing one reads as a name rather than a broken image.

ADDING ONE
Put the file in this folder with the matching name and it appears. To add a
partner who is not on the list, copy one <li class="sgs-logo"> block in
services.html and change the file name and the two bits of text.

SIZE THEM BEFORE COMMITTING THEM
Logos usually arrive enormous - the council one came through at 2534px wide
for a mark the site draws about 170px across. The page still looks right,
because the CSS gives every logo the same box and fits it inside, but the
visitor downloads the whole file to see a sixth of it.

There is a script for this:

    powershell -File tools/fit-logo.ps1 -In "C:\path\to\whatever.png" -Name grand-view-hotel

It scales the logo down to fit 400 x 120, saves it here under that name,
and tells you what it saved. The council logo went 80.5 KB -> 19 KB.

400 x 120 is twice the biggest box the site draws a logo in (170 x 60), so
it still looks sharp on a phone or a retina screen with nothing wasted.

WHY PNG AND NOT JPG
These have transparent backgrounds. JPG cannot hold transparency and would
fill it with white - which looks fine on the white band today and breaks
the moment that band changes colour.

WebP would be smaller again, but there is no WebP encoder on the machine
this was set up on. If you ever install one, converting these is worthwhile
and only the file names in services.html need changing to match.
