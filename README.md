# 🌍 Worldsong

**The music of where you are.** Every place on Earth grows its own song, shaped by
everyone who has ever listened there.

Worldsong plays endless, AI-generated music that is tied to your physical location, like
the zone music in a video game. Two people standing in the same place hear the same track.
You steer it by voting: skip (⏭) a track to teach the place what it should *not* sound like,
go back (⏮) to reward what it should. Over time, each location on Earth evolves its own
distinct sound profile.

This is a complete, self-contained MVP with **zero external dependencies and zero API keys** —
it runs on Node's built-ins alone.

---

## How it maps to the idea

| Requirement | How Worldsong does it |
|---|---|
| **AI-generated music** | A procedural generative audio engine (Web Audio API) synthesises drums, bass, pads and lead from a parameter set called a *genome*. No samples, no streaming. |
| **Machine learning from votes** | Each zone runs a **per-dimension Thompson-sampling multi-armed bandit**. Every musical choice (scale, tempo, instruments, drums, space, tone…) is an arm with a Beta(α,β) posterior. Upvotes bump α, downvotes bump β. The next track is sampled from the learned posteriors, so the zone exploits what's liked while still exploring. |
| **Voting via next / previous** | ⏭ Next = downvote + skip to a freshly sampled track. ⏮ Previous = restore the prior track *and* upvote it. Explicit 👍 / 👎 are also wired in. |
| **Location-dependent, shared** | Your browser's latitude/longitude is quantised to a ~1 km grid cell (a *zone*). The server holds the current track per zone, so everyone in that cell hears the same thing. |
| **Unique sound profiles worldwide** | Because the bandit state is per-zone and persisted, every location drifts toward its own local taste. The in-app world map plots every discovered zone, coloured by its dominant mood. |

---

## Run it

```bash
cd worldsong
npm start          # node server.js  -> http://localhost:5577
```

Open <http://localhost:5577>, allow location (or use **✈ Explore** / click the world map to
travel), and press play.

> Requires Node ≥ 22.5 (uses the built-in `node:sqlite`). Tested on Node 24.

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
db.js            Persistence (node:sqlite): zones, per-arm Beta stats, vote log, history
bandit.js        The ML core: dimensions/arms, Thompson sampling, vote updates, profile
zones.js         lat/lon -> grid zone id + deterministic poetic zone name
sim.js           Offline proof that the bandit learns
verify.mjs       Headless end-to-end UI check
public/
  index.html     UI
  style.css      Ambient dark theme
  app.js         Geolocation, fetch, transport, visualizer, world map
  audio-engine.js  Generative Web Audio engine (drums/bass/pad/lead, reverb, brightness)
```

### API

- `GET /api/zone?lat=&lon=` → `{ zoneId, name, center, currentTrack:{seed,genome}, stats, profile, maturity, global }`
- `POST /api/vote` `{ zoneId, action:'next'|'prev'|'like'|'dislike' }` → updated zone payload
- `GET /api/world` → `{ zones:[…], global }` for the map
- `GET /api/dimensions` → the full arm space

### The genome

One arm chosen per dimension: `scale, root, tempo, lead, pad, bass, drums, density, reverb,
brightness`. The audio engine reads the genome and the seed (the seed makes the melody
reproducible so a zone sounds identical for every listener).

---

## Roadmap / how to take it further

- Real generative-audio models (e.g. a hosted MusicGen) per genome instead of synthesis.
- Accounts + per-user taste so the crowd model can de-bias brigading.
- Hex/H3 zones with adjustable resolution and zone blending as you move.
- Persisted history scrubbing and a "lineage" view of how a zone's sound evolved.
- Deploy: any Node host. Point `DB_PATH` at a persistent volume.
