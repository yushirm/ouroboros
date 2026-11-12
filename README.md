# ouroboros

A living ring fed by the real world, right now.

The ring is the whole Earth seen from above the north pole and opened out:
the inner edge is the Arctic, the outer edge is Antarctica, and the angle is
longitude. The Sun is always at the top, so the planet turns beneath it — one
slow lap a day. Day chases night around the ring and never catches it.

Six things that have nothing to do with each other share that one body:

| What you see | What it is | Source | Terms |
|---|---|---|---|
| **Embers** | Every earthquake of the past 24 h. Size = magnitude, colour = depth. New ones arrive with a shockwave. | [USGS GeoJSON feeds](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php) | Public domain. Polled once a minute (the feed's own cadence). |
| **Drifting threads** | Wind at 10 m on a 144-point global grid. | [Open-Meteo](https://open-meteo.com/) | CC BY 4.0; free for non-commercial use under 10,000 calls/day. One 144-point call every 2 h per visitor, cached in `localStorage`. |
| **Coloured motes** | A plant, bird, insect, fungus… that someone just noticed and shared. Colour = kingdom/class. Over time the continents draw themselves out of attention alone. | [iNaturalist API v2](https://api.inaturalist.org/v2/docs/) | Free; they ask for ≤ 60 req/min and ≤ 10,000/day. One request every 40 s per visitor. |
| **The seed-head at the centre** | Each stalk is a page being created on a Wikimedia project this second. Each wiki grows in its own direction; longer pages reach further. Gold = written by a person, blue diamond = by a bot. | [Wikimedia EventStreams](https://wikitech.wikimedia.org/wiki/Event_Platform/EventStreams_HTTP_Service) (`mediawiki.page-create`) | Public stream, no key. |
| **The white traveller** | The International Space Station and its crew. | [wheretheiss.at](https://wheretheiss.at/w/developer) | Free, ~1 req/s limit. Polled every 10 s. |
| **Falling dust & glowing edges** | Solar-wind speed (the dust falls at the true speed, to the scale of the planet) and NOAA's OVATION aurora model (the green fire at the poles). | [NOAA SWPC](https://services.swpc.noaa.gov/) | Public domain. |

Touch the ring to ask what is there. The speaker button turns on sound; every
note is an event (a pluck for a living thing, a tick for a page, a low drop
for an earthquake).

## Honesty

- **Nothing is simulated.** There is no fallback data and no filler animation.
  If a source goes quiet, its layer goes dark until it comes back. The `?`
  panel shows which sources are live and what they are saying.
- **Nothing sits in the middle.** There is no backend. Each visitor's browser
  talks straight to the sources, so there is nowhere for a fake to hide.
- **The layers share a canvas, not a cause.** Nothing is drawn *between*
  sources. Any pattern across them is for the viewer to wonder about.
- **What is artistic licence:** the ring projection, the colours, the sounds;
  the wind's *speed* (direction and relative strength are real, the pace is
  exaggerated so it can be seen); and which wiki grows in which direction (a
  fixed hash of its name — a language has no longitude).
- **Small delays, stated:** living things arrive about a minute behind (they
  are fetched in batches and replayed with their true rhythm); the ISS coasts
  on its last measured velocity between fixes; the aurora is NOAA's 30–90
  minute forecast model, not a photograph.
- The notch on the outer edge is "roughly your meridian", guessed from your
  clock's timezone. No location is requested; nothing about visitors is
  collected, stored or sent.
- Page titles and place names are shown exactly as the world wrote them, so
  they are as unfiltered as the world is.

## Running it

It is a folder of static files: no build step, no dependencies, no keys.

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

## Layout

```
public/
  index.html, style.css      the page and the "what am I looking at" panel
  js/main.js                 the creature: projection, layers, touch, whispers
  js/sources.js              the six listeners (polling, backoff, pause/resume)
  js/astro.js                where the Sun is, from the clock
  js/audio.js                event-driven sound
  _headers                   CSP and caching for Cloudflare
```

MIT licensed. Data belongs to its sources and the people who made it.
