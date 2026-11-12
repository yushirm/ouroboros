# ouroboros

A living creature fed by the real world, right now.

Its skin is the whole Earth, bent into a ring and floating in open space. The
outer rim is the equator, its back is the northern hemisphere, its belly the
southern, and both poles meet in its throat. The Sun is where the Sun really
is, so the planet turns beneath it — one slow lap a day. Day chases night
around the body and never catches it.

Everything that moves on it moves because something real just happened:

| What you see | What it is | Source | Terms |
|---|---|---|---|
| **Fur** | Every hair is a plant, bird, insect, fungus… that someone just noticed and shared, growing where it was seen. Colour = kingdom/class. Over time the continents grow in, out of attention alone. | [iNaturalist API v2](https://api.inaturalist.org/v2/docs/) | Free; they ask for ≤ 60 req/min and ≤ 10,000/day. Ten requests at load, then one every 40 s per visitor. |
| **Sway and drifting threads** | The fur leans and sways with the real 10 m wind at that spot (144-point global grid); pale threads drift where the air is going. | [Open-Meteo](https://open-meteo.com/) | CC BY 4.0; free for non-commercial use under 10,000 calls/day. One 144-point call every 2 h per visitor, cached in `localStorage`. |
| **Embers and shivers** | Every earthquake of the past 24 h. Size = magnitude, colour = depth. A new one sends a ripple through the body's actual geometry; the last half hour still trembles. | [USGS GeoJSON feeds](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php) | Public domain. Polled once a minute (the feed's own cadence). |
| **Breath** | Each spore leaving the throat is a page being created on a Wikimedia project this second. Each wiki breathes out in its own direction; longer pages drift further. Gold = written by a person, blue diamond = by a bot. | [Wikimedia EventStreams](https://wikitech.wikimedia.org/wiki/Event_Platform/EventStreams_HTTP_Service) (`mediawiki.page-create`) | Public stream, no key. |
| **The white traveller** | The International Space Station and its crew. | [wheretheiss.at](https://wheretheiss.at/w/developer) | Free, ~1 req/s limit. Polled every 10 s. |
| **Dust and the glowing throat** | Solar-wind speed (the dust crosses the space at the true speed, to the scale of the body) and NOAA's OVATION aurora model (the green fire where the poles meet). | [NOAA SWPC](https://services.swpc.noaa.gov/) | Public domain. |

Drag to circle it, pinch or scroll to come close, tap anything to ask what it
is. Left alone, the view drifts slowly around it. The speaker button turns on
sound; every note is an event (a pluck for a living thing, a tick for a page,
a low drop for an earthquake).

## Honesty

- **Nothing is simulated.** There is no fallback data and no filler animation.
  If a source goes quiet, its layer goes dark until it comes back. The `?`
  panel shows which sources are live and what they are saying.
- **Nothing sits in the middle.** There is no backend. Each visitor's browser
  talks straight to the sources, so there is nowhere for a fake to hide.
- **The layers share a canvas, not a cause.** Nothing is drawn *between*
  sources. Any pattern across them is for the viewer to wonder about.
- **What is artistic licence:** the shape of the body, its scales, the colours,
  the sounds, and the drifting camera (that is the viewer moving, not the
  data); each hair's length; the wind's *pace* (direction and relative strength
  are real, the speed is exaggerated so it can be seen, and a hair with no wind
  data does not move at all); the size of a quake's ripple (scaled from its
  magnitude, not its physics); and which wiki breathes in which direction (a
  fixed hash of its name — a language has no longitude).
- **Small delays, stated:** living things arrive about a minute behind (they
  are fetched in batches and replayed with their true rhythm); the ISS coasts
  on its last measured velocity between fixes; the aurora is NOAA's 30–90
  minute forecast model, not a photograph.
- The faint band around the body is "roughly your meridian", guessed from your
  clock's timezone. No location is requested; nothing about visitors is
  collected, stored or sent.
- Page titles and place names are shown exactly as the world wrote them, so
  they are as unfiltered as the world is.

## Running it

It is a folder of static files: no build step, no dependencies, no keys. It
needs WebGL (every current browser has it).

```sh
npx serve public        # or: python3 -m http.server -d public
```

### Deploying to Cloudflare (free)

`wrangler.jsonc` describes a static-assets-only Worker. Static asset requests
are free and unlimited, and there is no Worker script to bill or break.

- **From the dashboard (auto-deploys on every push):** Workers & Pages →
  Create → Import a repository → pick this repo → Deploy. The defaults are
  right (`npx wrangler deploy`, no build command).
- **From a terminal:** `npx wrangler deploy`

`public/_headers` sets a strict Content-Security-Policy that only allows
connections to the six sources above. If you ever add a source, add its host
there too.

### Why no Worker code?

A caching proxy was the obvious design, and it would be worse here. Open-Meteo
and iNaturalist meter by IP: one shared Worker egress IP would hit their
limits, while visitors' own IPs never will. The Wikimedia stream is a
long-lived connection, which Workers bill for and browsers do for free. And a
proxy is one more thing that can rot. Without one, the site keeps working for
as long as the sources do, costs nothing at any traffic level, and each layer
fails independently.

## Cost to visitors

About 12 MB per hour of watching, most of it the page-birth stream. All
listening stops while the tab is hidden. (The full Wikipedia *edit* stream
would have been livelier but runs ~180 MB/h — not something to do to a phone.)

The screen is kept awake while the page is visible (Wake Lock, where the
browser supports it). If a device can't hold a steady frame rate the canvas
quietly drops its pixel density rather than stutter.

## Layout

```
public/
  index.html, style.css      the page and the "what am I looking at" panel
  js/main.js                 the creature: world, layers, camera, touch, whispers
  js/gl.js                   WebGL helpers and the three shaders (body, fur, light)
  js/sources.js              the six listeners (polling, backoff, pause/resume)
  js/astro.js                where the Sun is, from the clock
  js/audio.js                event-driven sound
  _headers                   CSP and caching for Cloudflare
```

MIT licensed. Data belongs to its sources and the people who made it.
