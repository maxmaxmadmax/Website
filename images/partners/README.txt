PARTNER LOGOS
=============

The "Trusted Across North Queensland" strip on the services page. One file
per partner, named after them in lower case with dashes. All seven are in
place:

    whitsunday-regional-council.png      19.0 KB
    grand-view-hotel.webp                 3.8 KB
    cape-gloucester-eco-resort.jpg        5.9 KB
    stonka-fishing-challenge.png         29.6 KB
    don-river-dash.png                   15.2 KB
    bowen-state-high-school.png          24.4 KB
    girudala.jpg                          7.1 KB
                                        --------
                                        105.0 KB for the strip

They are lazy loaded, so none of this is fetched until somebody scrolls
down to them.

ADDING ONE
Copy an <li class="sgs-logo"> block in services.html, change the file name
and the two bits of text, and put the file here. Until the file exists that
logo shows the partner's name as text instead, so a missing one reads as a
name rather than a broken image.

SIZE IT FIRST

    powershell -File tools/fit-logo.ps1 -In "C:\path\to\whatever.png" -Name grand-view-hotel

The strip draws every logo inside a box no bigger than 170 x 60 CSS pixels.
Logos arrive nowhere near that - the council one came through at 2534px
wide and 80.5 KB for a mark drawn 170px across. The page still looked
right, because the CSS fits whatever it is given into the same box, but the
visitor downloaded the whole file to see a fraction of it.

The script scales to fit 400 x 120, which is twice the biggest drawn size,
so it stays sharp on a phone or a retina screen with nothing wasted. What
it saved on these:

    stonka        249.8 -> 29.6 KB   (88%)
    council        80.5 -> 19.0 KB   (76%)
    girudala       31.0 ->  7.1 KB   (77%)
    don river      26.7 -> 15.2 KB   (43%)
    school         33.8 -> 24.4 KB   (28%)
    cape gloucester 7.7 ->  5.9 KB   (23%)

TWO SWITCHES WORTH KNOWING

    -Trim       cuts off a uniform white or transparent border. Logos often
                arrive floating in a square of padding, which the box counts
                as part of the logo - so the mark is drawn smaller than its
                neighbours and the row looks uneven.

    -KeepTop    keeps only the top fraction of the height. Don River Dash
                came with "9-11 SEPTEMBER 2022" under the wordmark, which
                would be four pixels tall and out of date. -KeepTop 0.74
                cut it, and the tagline under it, which is equally
                unreadable at this size.

FORMAT IS CHOSEN, NOT ASSUMED
A logo with transparency is saved as PNG. JPG cannot hold transparency and
would fill it with white - fine on today's white band, broken the moment
that band changes colour.

A logo that arrived on a solid background has nothing to preserve, and PNG
is the wrong tool for it - forcing Cape Gloucester to PNG turned 7.7 KB
into 27 KB. Those are saved as JPG.

Grand View arrived as a 3.8 KB WebP and was left exactly as it was. There
is no WebP decoder on the machine this was set up on, and at 3.8 KB there
was nothing to gain.
