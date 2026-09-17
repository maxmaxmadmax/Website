PARTNER LOGOS
=============

One file per organisation, named after them in lower case with dashes.

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

All eight are lazy loaded, so none of it is fetched until somebody
scrolls down to it.

ADDING ONE
Partner strip: copy an <li class="sgs-logo"> block in services.html,
change the file name and the two bits of text, and put the file here.
Until the file exists that logo shows the partner's name as text instead,
so a missing one reads as a name rather than a broken image.

SIZE IT FIRST

    powershell -ExecutionPolicy Bypass -File tools/fit-logo.ps1 `
               -In "C:\path\to\whatever.png" -Name grand-view-hotel -Trim

The -ExecutionPolicy Bypass is needed on this machine; PowerShell refuses
to run the script without it.

WHY SIZE THEM
A logo that arrives at 2000 pixels and is drawn at 46 costs a visitor the
whole file to do it. The tool saves at twice the drawn size, which stays
sharp on a retina screen and throws the rest away.
