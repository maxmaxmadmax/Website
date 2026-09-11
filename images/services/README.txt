SERVICES PAGE PHOTOGRAPHY
=========================

One photo per slide. The name each slide looks for is set on the slide
itself in services.html, so if you swap in a different name or format,
change it there to match.

In the order the slides run:

    weddings.webp             Weddings slide
    corporate-functions.webp  Corporate Functions slide
    dj-entertainment.webp     DJ Entertainment slide
    private-functions.webp    Private Functions slide   <- still to come
    community-events.webp     Community Events slide
    festivals.webp            Festivals slide
    sporting-events.webp      Sporting Events slide
    big-screens.webp          Big Screens slide
    trailer-stage.webp        Trailer Stage slide

Eight of the nine are in place. Private Functions is a new slide and has no
photo yet, so it shows its own gradient - which looks deliberate rather
than broken. Drop a file at that name and it picks it up. The Intro slide has no photo - it runs
videos/hero.mp4 on a large screen and a gradient everywhere else.

REPLACING ONE WITH A SHARPER COPY
Several of these came through at around 900-1200px wide, and
community-events is only 638px. That is fine on a phone and passable on
a laptop, but it softens on a large desktop screen. If you have the
originals, save them over the top using the same names, around 2000px
wide - nothing in the code needs changing.

Widths as they stand:
    weddings 1672   trailer-stage 1536   corporate-functions 1218
    festivals 1077  sporting-events 1059  big-screens 913
    community-events 638   <- the one most worth replacing

Until a file is here, that slide shows its own dark gradient instead, so a
missing photo looks deliberate rather than broken.

WHAT MAKES A GOOD ONE
  - Landscape, around 2000px wide. Bigger than that is just a slower page.
  - Save as JPG, quality 70-80. Aim to keep each file under about 400KB.
  - The words sit over the left of the picture on a computer and over the
    bottom of it on a phone, so pick shots where those areas are darker or
    less busy. A bright sky or a face in those spots will fight the text.

CHANGING A FILE NAME
The name each slide looks for is set on the slide itself in services.html:

    style="--sgs-img:url('images/services/festivals.jpg')"

Change that line if you would rather use a different name, or .webp / .png.
