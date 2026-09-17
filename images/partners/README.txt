PARTNER AND SPONSOR LOGOS
=========================

One file per organisation, named after them in lower case with dashes.
Two different strips draw from this folder.

THE PARTNER STRIP
"Trusted Across North Queensland", on the services page. People we have
worked for.

    whitsunday-regional-council.png      19.0 KB
    grand-view-hotel.webp                 3.8 KB
    cape-gloucester-eco-resort.jpg        5.9 KB
    stonka-fishing-challenge.png         29.6 KB
    don-river-dash.png                   15.2 KB
    bowen-state-high-school.png          24.4 KB
    girudala.jpg                          7.1 KB
    life-publishing-group.png            10.7 KB

THE SPONSOR STRIP
"Proudly Supported By", in the shared footer. People who put money into an
event. The footer is on every page, but the strip is hidden on most of
them - see the display:none rules in the page stylesheets.

    port-denison-motor-inn.webp          18.0 KB
    lowcock-builders.png                 15.8 KB
    evolution-beauty.jpg                  4.4 KB
    ms-sippi.jpg                          7.3 KB

All twelve are lazy loaded, so none of it is fetched until somebody
scrolls down to it.

ADDING ONE
Partner strip: copy an <li class="sgs-logo"> block in services.html,
change the file name and the two bits of text, and put the file here.
Until the file exists that logo shows the partner's name as text instead,
so a missing one reads as a name rather than a broken image.

Sponsor strip: copy an <a> block in components/footer.html.

SIZE IT FIRST

    powershell -ExecutionPolicy Bypass -File tools/fit-logo.ps1 `
               -In "C:\path\to\whatever.png" -Name grand-view-hotel -Trim

The -ExecutionPolicy Bypass is needed on this machine; PowerShell refuses
to run the script without it.

WHY IT MATTERS
The four sponsor logos arrived here at their original size and were being
drawn at 46 pixels wide:

    ms-sippi          2048px, 218 KB   ->  105px, 7.3 KB
    evolution-beauty  2000px,  80 KB   ->  128px, 4.4 KB
    lowcock-builders  2625px,  58 KB   ->  389px, 15.8 KB

That is 356 KB replaced by 28 KB for pictures nobody could tell apart.
The tool saves at twice the drawn size, which stays sharp on a retina
screen and throws the rest away.

port-denison-motor-inn.webp was left alone: System.Drawing cannot read
WebP, and at 18 KB it was not worth converting to find out.
