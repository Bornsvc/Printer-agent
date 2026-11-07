# print-agent

A standalone Node.js process that runs on a PC inside the restaurant. It watches
the web app for new print jobs (receipts and kitchen order tickets), renders
them as images, and sends those images to the correct thermal printer over the
LAN. It's separate from the main Next.js app — the Next.js app only writes rows
to a `print_jobs` table / exposes a few API routes; this agent is what actually
talks to the printers.

## How it works (the loop)

1. **Poll.** Every `POLL_INTERVAL_MS` (default 3000ms), the agent calls
   `GET {API_URL}/api/print-jobs` to ask for pending jobs. No WebSocket, no
   Supabase Realtime — plain HTTP polling on a `setInterval`.
   > Earlier versions used Supabase Realtime to get jobs pushed instantly
   > instead of polling. It was dropped: the Realtime client was flaky inside
   > a plain Node.js process (transport failures, and it would sometimes stop
   > delivering events while still reporting itself as subscribed). Polling
   > every few seconds is simple, reliable, and a few seconds of latency
   > doesn't matter for kitchen tickets.
2. **Render.** For each job, its `payload` (JSON) is turned into a PNG image —
   a receipt layout or a kitchen ticket (KOT) layout.
3. **Print.** The PNG is sent over TCP to the thermal printer assigned to that
   job's station (`RECEIPT`, or a kitchen station like `HOT_KITCHEN`).
4. **Acknowledge.** The agent claims each job first (`PATCH
   {API_URL}/api/print-jobs/:id` with `status: PRINTING` — a 409 means another
   agent or staff already has it, so it's skipped), then reports the outcome:
   `PRINTED`; `RETRY_WAIT` (printer unreachable, nothing was sent — retried
   automatically); `UNKNOWN` (bytes were sent but the send didn't finish
   cleanly, so it may or may not have printed — never resent automatically,
   staff decide on `/admin/printers`); or `FAILED` (the job itself is broken).

### Automatic retry
Each physical printer has one lane that prints one job at a time, always the
oldest ready ticket. A ticket whose printer can't be reached waits 5s, 15s,
45s, then every 60s (`PRINT_RETRY_DELAYS_MS`) **without holding up the
tickets behind it**; when its wait is over it is again the oldest, so it goes
before anything newer. After 3 unreachable attempts in a row the printer is
paused (circuit breaker) until the 30s health check sees it again or
`BREAKER_PROBE_MS` passes; then one ticket is tried and, if it prints, the rest
follow oldest-first. Tickets that wait too long are expired by the web app
(kitchen tickets after 15 minutes) instead of printing late. Reprints made by
staff carry `reprint: true` and print a `*** REPRINT ***` banner with the
original time. `scripts/test-retry-lanes.js` exercises all of this against a
mock web app and fake printers. Full rationale: the web app's
`reports/POS print retry queue design.md`.

A `pollInProgress` guard skips a tick if the previous one is still running, so
a slow fetch never overlaps the next one.
On startup, the agent waits for the printer config to load once (see
`printer.js`) before it starts polling, so the very first tick doesn't race an
empty printer cache.

## Files

### `index.js`
The entry point and the poll loop described above. Owns:
- Reading `API_URL` / `AGENT_SECRET` / `POLL_INTERVAL_MS` from `.env`.
- The `setInterval` poll loop and the `pollInProgress` guard.
- The per-printer lanes, retry backoff and circuit breaker (see "Automatic
  retry" above). `buildSend(job)` picks the renderer + printer function by
  `job.type`:
  `RECEIPT`, `KOT`, `DRAWER` (cash drawer kick), `SESSION_QR` (per-session
  ordering QR slip, printed on the RECEIPT printer) and `TEST` (a test slip
  sent from `/admin/printers`' "Found printers" list straight to one scanned
  device — one attempt, no retries). Agents older than this version fail
  `SESSION_QR`/`TEST` jobs with "Unknown job type".
- Starts a printer scan on startup, and again whenever the job poll's
  `discoveryRequestedAt` changes (an admin pressed "Scan" — see `discovery.js`).
- `report(id, body)` — the `PATCH` call back to the web app (retried a few
  times, since a lost report would leave the job PRINTING on the server).

Run with `node index.js` (or `npm start`).

### `discovery.js`
Finds printers this PC can reach so admins can pick one on `/admin/printers`
instead of typing an IP: LAN hosts on this PC's own private `/24` network(s)
with port 9100 open (a ~2s sweep), plus Windows COM ports (via PowerShell /
`Win32_PnPEntity`). Results are POSTed to `{API_URL}/api/printer-discovery`.
`node scripts/test-discovery.js` runs the same scan and just prints the
result. Only RFC 1918 networks are scanned, and the sweep only opens and
closes a TCP connection per host — nothing is printed.

### `printer.js`
Everything about talking to physical printers:
- `refreshPrinterConfig()` — fetches `GET {API_URL}/api/printer-config` (the
  IP/port for each station) and caches it in memory. Runs once on startup and
  then every 60 seconds, so changing a printer's IP in the admin web UI
  (`/admin/printers`) takes effect without restarting the agent.
- `ready` — a promise that resolves once that first config fetch has settled
  (success or failure). `index.js` awaits this before its first poll.
- `printReceiptImage(buffer)` / `printKotImage(station, buffer)` — build the
  ESC/POS bytes with `node-thermal-printer` (image + cut), then send them with
  `sendRaw()`, which talks to the printer itself (TCP `ip:port`, or the
  Windows COM port) instead of `execute()`. That's what lets a failure say
  whether anything reached the printer: `SendError.notSent` is true only when
  the connection/COM port never opened (safe to retry). `node-thermal-printer`
  reports a connect timeout and a mid-send timeout identically, and its COM
  writer keeps retrying in the background after `execute()` has given up.
- `onPrinterHealth(listener)` — the 30s health ping results, used by
  `index.js`'s circuit breaker to resume a paused printer.
- Errors are wrapped with which station/IP failed
  (`Print failed for HOT_KITCHEN (192.168.1.50:9100): ...`) instead of surfacing
  a bare "Socket timeout", so a failed job's error message in the admin UI
  actually points at the offending printer.

### `render.js`
Turns job payloads into PNG images using `@napi-rs/canvas` (not the `canvas`
package — `canvas` needs native build tools that are painful to install on a
restaurant PC; `@napi-rs/canvas` ships prebuilt binaries).

- Registers `fonts/NotoSansThai-Regular.ttf` as a custom font family
  (`ThaiFont`) via `GlobalFonts.registerFromPath`. This is required because
  most thermal printers don't have a built-in Thai codepage — instead of
  sending raw text to the printer, the agent draws the receipt as an image.
- `renderReceiptImage(data)` — customer receipt: restaurant name, table
  number, line items, subtotal/service charge/total, thank-you line.
- `renderKotImage(data)` — kitchen order ticket: table number, station name,
  ordered items with quantities and notes.
- Both return a PNG buffer (`canvas.toBuffer('image/png')`) ready to hand to
  `printer.js`.

> **Font gotcha:** the font file must be the *full* glyph set, not a
> script-only subset. An earlier version used fonts downloaded as trimmed
> subsets (~100 glyphs, script letters + a space only) that were missing
> Basic Latin — digits, punctuation, everything — so prices, table numbers,
> and dates all printed as tofu boxes (□). The current font was pulled from
> the complete Noto Sans Thai family and includes full digit/punctuation
> coverage. If you ever swap fonts, verify digit coverage first.

### `package.json`
Dependencies are intentionally minimal:
- `@napi-rs/canvas` — image rendering (see above).
- `dotenv` — loads `.env`.
- `node-fetch` — HTTP calls to the web app's API.
- `node-thermal-printer` — sends images to printers over TCP.

No `@supabase/supabase-js`, no `ws` — those were only needed for the
abandoned Realtime approach.

### `.env.example`
Copy to `.env` and fill in:
- `API_URL` — the web app's URL (no trailing slash).
- `AGENT_SECRET` — this restaurant's agent key, must match its `Tenant.agentKey`
  row in the web app's database (per-tenant now, not a shared env var), sent
  as the `x-agent-key` header on every request.
- `POLL_INTERVAL_MS` — optional, defaults to `3000`.
- `DISCOVERY_PORTS` — optional, comma-separated raw-print ports the printer
  scan probes, defaults to `9100`.
- `DISCOVERY_TIMEOUT_MS` — optional, per-host connect timeout for the scan,
  defaults to `400`.

Printer IPs are **not** set here — they're managed from `/admin/printers` in
the web app and fetched automatically by `printer.js`.

### `fonts/`
- `NotoSansThai-Regular.ttf` — the full Noto Sans Thai font used by
  `render.js`. Required for Thai text (and digits/punctuation) to render on
  receipts and tickets.

### `prisma-addition.txt`
Not part of the agent itself — a copy-paste snippet of the `PrinterConfig`
Prisma model for the *web app's* schema, kept here as a reminder of what the
`/api/printer-config` endpoint this agent depends on is backed by.

## Running it

```bash
npm install
cp .env.example .env   # then fill in API_URL / AGENT_SECRET
node index.js
```

On startup you should see:
```
🖨️  Print agent starting — polling https://yourapp.com
🔄 Printer config refreshed: RECEIPT, HOT_KITCHEN, COLD_KITCHEN, DRINK_STATION
✅ Polling for new print jobs every 3s...
```

For a permanent restaurant PC, run it under a process manager (e.g. `pm2
start index.js --name print-agent`) so it survives reboots and restarts on
crash.
