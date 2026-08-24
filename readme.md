# GS&D Gauge Public Adapter

This is the public-facing deployment adapter for Gauge Systems & Diagnostics.
It is not Gauge's protected core or private controller.

## Public route

Public input is preserved, SHA-256 hashed, source-checked, assigned one route,
and returned with a proof reference. Unknown public sources remain on hold
until GS&D verifies them.

Routes:

- `/`, `/filter`, `/hub`, and `/intake` — controlled public intake
- `/api/gauge-intake` — governed proof-record adapter
- `/pay` and `/cashapp` — Gauge Systems payment route
- `/controller` and controller assets — private boundary

## Verification

```bash
npm install
npm test
npx netlify build --offline
```

Deploy to the existing Netlify project `gsd-gauge-master-control`. Do not
create a replacement project or publish private Gauge source.
