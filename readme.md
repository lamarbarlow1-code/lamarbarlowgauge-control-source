# GS&D Gauge Master Control

This is the connected operating source for the existing Netlify project
`gsd-gauge-master-control`. It preserves the public GS&D adapter and joins its
governed intake records to the owner-only Master Control API.

## Operating chain

`Public GS&D → Gauge Hub Intake → source check → owner route → paid boundary → proof record`

- Public wording is preserved and SHA-256 hashed.
- Unknown sources are held with no external action.
- Master Control reads the same `gauge-public-ingress` records; it does not copy
  them into a second intake system.
- Owner route, work state, service lane, and payment state append an
  `owner_control` event to the original proof chain.
- Raw-input changes, proof-entry changes, and broken hash links fail verification.
- Conditional Blob writes prevent an owner decision from overwriting a newer
  record version.
- Corrections remain owner-only, governed, hash-deduplicated, and proof-backed.

## Routes

- `/`, `/filter`, `/hub`, `/intake` — public controlled intake
- `/api/gauge-intake` — public proof-record ingress
- `/controller` and `/gauge-stack-controller.html` — Master Control shell
- `/api/gauge-stack-agent` — owner-key authenticated control API
- `/pay`, `/cashapp` — `$GaugeSystems` payment route

## Stores

- `gauge-public-ingress` — original public intake and its complete proof chain
- `gauge-stack-control` — asset registry, next actions, correction log, and
  registry proof log

## Verification

```bash
npm ci
npm test
npx netlify build --offline
```

Deploy only to the existing Netlify project `gsd-gauge-master-control`. Do not
create a replacement project, delete existing Blob records, or publish protected
customer data.
