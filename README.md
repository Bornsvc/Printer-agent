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
4. **Acknowledge.** The agent reports back via
   `PATCH {API_URL}/api/print-jobs/:id` with `status: PRINTED` or
   `status: FAILED` (plus an error message on failure), so the job isn't
   picked up again next poll.

A `pollInProgress` guard skips a tick if the previous one is still running
(e.g. a slow print job), so the same job never gets fetched and printed twice.
On startup, the agent waits for the printer config to load once (see
`printer.js`) before it starts polling, so the very first tick doesn't race an
empty printer cache.

## Files

### `index.js`
The entry point and the poll loop described above. Owns:
- Reading `API_URL` / `AGENT_SECRET` / `POLL_INTERVAL_MS` from `.env`.
- The `setInterval` poll loop and the `pollInProgress` guard.
- `handleJob(job)` — dispatches a job to the right renderer + printer function
  based on `job.type` (`RECEIPT` or `KOT`), then acks it as `PRINTED`/`FAILED`.
- `ackJob(id, status, error)` — the `PATCH` call back to the web app.

Run with `node index.js` (or `npm start`).

### `printer.js`
Everything about talking to physical printers:
- `refreshPrinterConfig()` — fetches `GET {API_URL}/api/printer-config` (the
  IP/port for each station) and caches it in memory. Runs once on startup and
  then every 60 seconds, so changing a printer's IP in the admin web UI
  (`/admin/printers`) takes effect without restarting the agent.
- `ready` — a promise that resolves once that first config fetch has settled
  (success or failure). `index.js` awaits this before its first poll.
- `printReceiptImage(buffer)` / `printKotImage(station, buffer)` — write the
  PNG to a temp file and send it to the station's printer over
  `tcp://ip:port` using `node-thermal-printer`, then cut the paper.
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
- `AGENT_SECRET` — must match `PRINT_AGENT_SECRET` in the web app's env, sent
  as the `x-agent-key` header on every request.
- `POLL_INTERVAL_MS` — optional, defaults to `3000`.

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
