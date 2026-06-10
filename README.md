# 🌍 Worldsong

**The music of where you are.** Every place on Earth grows its own song, shaped by
everyone who has ever listened there.

Worldsong plays AI-generated music that is tied to your physical location, like
the zone music in a video game. Each place gets its own full ~2-3 minute area
theme (intro, recurring melodies, a variation, a sparse bridge, an outro) that
then loops, in the spirit of a RuneScape town soundtrack. Two people standing in
the same place hear the same track.
You steer it by voting: skip (⏭) a track to teach the place what it should *not* sound like,
go back (⏮) to reward what it should. Over time, each location on Earth evolves its own
distinct sound profile.

This is a complete, self-contained MVP with **zero external dependencies and zero API keys** —
it runs on Node's built-ins alone.

---

## How it maps to the idea

| Requirement | How Worldsong does it |
|---|---|
| **AI-generated music** | A procedural generative audio engine (Web Audio API) composes a full ~2-3 minute piece, with structure (intro, themes, variation, bridge, outro) that loops, from a parameter set called a *genome*. No samples, no streaming. The default palette is a calm RuneScape-style fantasy feel: **flute & recorder, harp, pizzicato strings, glockenspiel** over **warm pads**, soft **plucked / sub bass**, **light hand percussion**, mid tempos and lush hall reverb. The older aggressive voices (wobble / Reese bass, drum-and-bass kits, super-saw / screech leads) are still in the vocabulary, so a zone can drift there if its listeners vote it that way. |
| **Machine learning from votes** | Each zone runs a **per-dimension Thompson-sampling multi-armed bandit**. Every musical choice (scale, tempo, instruments, drums, space, tone…) is an arm with a Beta(α,β) posterior. Upvotes bump α, downvotes bump β. The next track is sampled from the learned posteriors, so the zone exploits what's liked while still exploring. |
| **Voting via next / previous** | ⏭ Forward = upvote the current track *and* advance to a freshly sampled one. ⏮ Back = downvote the current track *and* return to the previous one. Explicit 👍 / 👎 are also wired in. |
| **Location-dependent, shared** | Your latitude/longitude is reverse-geocoded to the **real suburb / postcode** you're standing in (OpenStreetMap via Photon, no API key). That place *is* the zone: everyone in the same suburb hears the same track, and the song changes the moment you cross into the next suburb. Lookups are cached and rate-limited; if geocoding is unavailable it falls back to a coarse grid so the app still works everywhere on Earth. |
| **Unique sound profiles worldwide** | Because the bandit state is per-zone and persisted, every suburb drifts toward its own local taste. The in-app world map plots every discovered place, coloured by its dominant mood. |

---

## Run it

```bash
cd worldsong
npm start          # node server.js  -> http://localhost:5577
```

Open <http://localhost:5577>, allow location (or use **✈ Explore** / click the world map to
travel), and press play.

> Requires Node ≥ 22.5 (uses the built-in `node:sqlite`). Tested on Node 24.
>
> Zones are real suburbs/postcodes via free OpenStreetMap reverse geocoding (no key). The
> default provider is **Photon** (Komoot), because the public Nominatim instance blocks
> datacenter IPs and silently fails on cloud hosts; Nominatim is kept as a secondary that
> works from a home IP. The server is a polite client: one request at a time, ≥1.1s apart,
> every resolved lookup cached in the DB (the coarse "Uncharted" fallback is never cached,
> so a transient outage can't poison a cell). Set `GEOCODE_CONTACT="you@example.com"` to
> identify your instance; `GEOCODE_PROVIDER=mock` forces a fully offline deterministic
> geocoder (used by the tests), or set it to `photon`/`nominatim` to pin one provider.

---

## Verify it

```bash
npm run sim        # proves the bandit learns a hidden crowd taste from votes
node verify.mjs    # headless Playwright run of the full UI (needs Playwright installed)
```

`npm run sim` invents a hidden preference for a zone, has a noisy crowd vote on generated
tracks, and confirms the zone's learned profile converges on that preference (it reaches
5/5 targeted dimensions with the match-rate of new tracks climbing to ~1.0).

`verify.mjs` boots the server on a throwaway DB, loads the page in headless Chromium,
asserts the zone loads, audio starts, next/prev change the vote counts, and there are no
JavaScript errors. It also writes `verify-shot.png`.

---

## Architecture

```
server.js        HTTP server (node:http) + JSON API, serves ./public
db.js            Persistence (node:sqlite): zones, per-arm Beta stats, vote log, history, geocache
bandit.js        The ML core: dimensions/arms, Thompson sampling, vote updates, profile
geocode.js       lat/lon -> real suburb/postcode zone (OSM Nominatim, cached + rate-limited)
zones.js         hashStr helper + (legacy) grid zone id / poetic name
sim.js           Offline proof that the bandit learns
verify.mjs       Headless end-to-end UI check
verify-travel.mjs  Headless proof the song auto-changes as you travel between places
gtest.mjs        Live reverse-geocode sanity check (hits OSM; proves real suburb resolution)
public/
  index.html     UI
  style.css      Ambient dark theme
  app.js         Geolocation, fetch, transport, visualizer, world map
  audio-engine.js  Generative Web Audio engine (drums/bass/pad/lead, reverb, brightness)
```

### API

- `GET /api/zone?lat=&lon=` → `{ zoneId, name, label, center, currentTrack:{seed,genome}, stats, profile, maturity, global }` (`name` = suburb, `label` = postcode · locality · country)
- `POST /api/vote` `{ zoneId, action:'next'|'prev'|'like'|'dislike' }` → updated zone payload
- `GET /api/world` → `{ zones:[…], global }` for the map
- `GET /api/dimensions` → the full arm space

### The genome

One arm chosen per dimension: `scale, root, tempo, lead, pad, bass, drums, density, reverb,
brightness`. The audio engine reads the genome and the seed (the seed makes the melody
reproducible so a zone sounds identical for every listener).

**House style (RuneScape-flavoured fantasy).** A fresh zone would otherwise sample a random
genome, so the bandit ships with a *style prior* (`STYLE_PRIOR` in `bandit.js`): an alpha
head-start on the arms that make a cosy medieval/fantasy area theme (flute & recorder, harp,
pizzicato strings, glockenspiel, warm pads, soft plucked/sub bass, light hand percussion,
72-110 BPM, major/modal scales, lush hall reverb). It's a *prior*, not a lock: real votes
still accumulate on top, so a zone whose listeners want something harder drifts elsewhere over
time (the aggressive bass-music arms are still available to drift toward). Edit or empty that
one object to re-style the whole planet without touching any stored votes.

**Long-form, looping compositions.** The engine doesn't loop a single bar forever. On each new
track it composes the whole ~2-3 minute piece up front from the seed: a main theme (A), a
contrasting theme (B), and a form that states them, varies them with ornamentation, drops to a
sparse bridge, and resolves before looping seamlessly. The melody is a real, repeatable,
hummable line (pregenerated as note events), not a fresh random arpeggio each bar.

> **Note on `_concurrent-alt-backend/`** — during the build, a second process produced a
> parallel, more granular backend (modular `server/` + `test/`). It works, but its genome
> vocabulary doesn't fully line up with this client's audio engine, so it's preserved under
> `_concurrent-alt-backend/` rather than wired in. The canonical, verified app is the
> root `server.js` + `public/` pair you get from `npm start`.

---

## Roadmap / how to take it further

- Real generative-audio models (e.g. a hosted MusicGen) per genome instead of synthesis.
- Accounts + per-user taste so the crowd model can de-bias brigading.
- Hex/H3 zones with adjustable resolution and zone blending as you move.
- Persisted history scrubbing and a "lineage" view of how a zone's sound evolved.
- Deploy: any Node host. Point `DB_PATH` at a persistent volume.
