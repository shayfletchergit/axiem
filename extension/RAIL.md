# Axiem Bridge — Live RAIL (open P&L)

The extension already relays **fills** to your journal. This adds a second, read-only
path that streams **live open P&L** into Axiem's RAIL so the survival buffer moves
intra-trade — without any market-data licence (it reads what the platform already
computes).

## Setup
1. In Axiem → **Settings → Live-data token → Generate**, copy the `axm_…` token.
2. Note your Axiem **account id** (the `account_id` RAIL is configured for, e.g. `APEX-A`).
3. Open the extension popup and fill:
   - **Axiem URL** — e.g. `http://localhost:3000` (or your deployed URL).
   - **RAIL account** — the account id from step 2.
   - **Live-data token** — the `axm_…` token from step 1.
   - **Save**.
4. Open your trading platform. As P&L frames arrive, the extension POSTs
   `{ account, openPnl, dayRealizedPnl }` to `/api/rail/ingest` (throttled ~500 ms;
   the server batches to 250 ms). The dashboard Rail then moves in real time.

## ⚠ You must verify the P&L field per platform
`injected.ts` captures broker WebSocket frames whose `entityType` matches
`cashbalance|position|margin`, and `background.ts → extractOpenPnl()` pulls the value
by **heuristic** key match (`/open.*pnl|unrealized/i`, `/realized|daypnl/i`). Field
names differ per platform, so confirm:

1. Open the platform, F12 → **Network** → WS frames (or **Console** with the extension's
   `[Axiem]` logs).
2. Find the frame carrying your open P&L; note the exact key (e.g. `openPnl`, `unrealizedPnl`, `totalPnl`).
3. If the heuristic misses it, tighten the regex in `extractOpenPnl()` or read the
   displayed value from the DOM as a fallback.

## Notes
- **Read-only.** This path never places orders.
- **Deployed URL:** add your production domain to `host_permissions` in `manifest.json`
  so the service worker may POST cross-origin.
- **Build:** `npm install && npm run build` → load `dist/` as an unpacked extension.
- Respect your firm's/platform's terms on extensions before use.
