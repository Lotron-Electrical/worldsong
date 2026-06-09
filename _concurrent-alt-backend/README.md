# Concurrent alternate backend (preserved, not wired in)

During the initial build a second process produced this parallel backend at the same time
as the canonical one. It is a complete, modular Node implementation (`server/index.js` on
port 7080, with `bandit.js`, `dimensions.js`, `rng.js`, `store.js`, `zones.js`) and it boots
and serves the shared `public/` client.

It is kept here for reference because:
- its genome vocabulary (e.g. `drums:"breakbeat"`, `lead:"sine"`, extra arms) does not fully
  match `public/audio-engine.js`, so some tracks would lose drums/voices if you ran it with
  the current client;
- the canonical, end-to-end-verified app is the repo-root `server.js` + `public/` pair
  (`npm start`), proven by `sim.js` (bandit convergence) and `verify.mjs` (headless UI).

To try it anyway: `node _concurrent-alt-backend/server/index.js` then open http://localhost:7080
(its `PUBLIC` path resolves two levels up to the repo's `public/`).
