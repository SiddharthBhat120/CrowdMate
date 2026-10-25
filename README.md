# CrowdMate

**One QR code for crowded places.** Virtual queues and lost-person safety tags, as an offline-first, real-time web app (PWA).

- **Virtual queues:** a visitor scans a QR code at a counter and gets a live token on their phone. They can walk away, watch their place in line update in real time, and their phone buzzes when it's almost their turn. Staff call the next person with one key.
- **Safety tags:** a family prints a QR tag for a child or an elderly relative. If they get separated, whoever finds them scans the tag and the family is alerted instantly, with a private chat and optional location sharing. No phone numbers are ever shown.

No app to install. Works on slow and dropping networks.

---

## Run it

### 1. Install Node.js

Install **Node.js 24 LTS** (or Node 22.22.2 or newer) from https://nodejs.org. Check it in a terminal:

```bash
node -v
```

### 2. Install and start

Open a terminal **in this folder** (the one with `package.json`), then:

```bash
npm install
npm run dev
```

Open **http://localhost:5173** in your browser. That's it.

`npm run dev` starts two things together: the Node server (port 8080) and the Vite dev server (port 5173), which forwards API and WebSocket traffic to the server. Press `Ctrl + C` to stop.

### 3. Try the whole flow on one computer

1. On the home screen, **create an event**, for example "College Fest".
2. Add a queue: "Food court", 2 minutes per person.
3. Open a **private/incognito window** (that acts as a second phone), go to http://localhost:5173 and enter the event code. Tap **Get a token**.
4. Back in the first window, click **Open counter screen** and press **N**. Watch the second window flip to "It's your turn".
5. For safety tags: in the visitor window create a tag and click **Copy tag link**. Open that link in another private window (the stranger who found them) and tap **Alert their family**. The family window switches to a chat instantly.

### 4. Try it on real phones (same Wi-Fi)

The terminal prints an address like `http://192.168.1.5:5173`. Phones on the same Wi-Fi can open it, and the organizer's QR codes automatically use this address.

> **Important:** browsers only enable service workers (offline mode), notifications and location on **HTTPS** pages (or localhost). Over plain `http://192.168…` the queue and chat work live, but offline mode, notifications and location sharing are switched off. To get everything on real phones, use an HTTPS address. Two free options:
> - Deploy it (any Node host that supports WebSockets).
> - Run a temporary HTTPS tunnel to your laptop: install `cloudflared`, run `npm run build && npm start`, then `cloudflared tunnel --url http://localhost:8080` and open the `https://…trycloudflare.com` address it prints.

### Production mode

```bash
npm run build     # typecheck + build the app into dist/
npm start         # one server on http://localhost:8080 serving app + API + WebSocket
```

Settings via environment variables: `PORT` (default 8080), `HOST` (default 0.0.0.0), `DATA_FILE` (default `data/crowdmate.json`).

---

## Tests

```bash
npm test                          # 59 unit + integration tests (Vitest)
npx playwright install chromium   # once, downloads a test browser
npm run test:e2e                  # 10 end-to-end tests in a real browser (Playwright)
npm run check                     # typecheck + unit tests + production build
```

What they cover:

| Suite | What it proves |
|---|---|
| `tests/unit/store.test.ts` | Queue rules (order, no-shows, pause/close), permissions, **idempotent ops**, privacy of views, safety-tag lifecycle |
| `tests/unit/server.test.ts` | Real HTTP + WebSocket server with simulated phones: live push, ETag/304, cache headers, Brotli, path-traversal blocking, re-sent ops applied once, persistence across restart |
| `tests/unit/sync.test.ts` | Client sync engine with a fake socket: **offline outbox** survives reload, re-send with same op id, **exponential backoff with jitter**, heartbeat replaces a dead "zombie" socket, IndexedDB cache |
| `tests/unit/components.test.tsx` | Tabs keyboard pattern, form field accessibility, ticket screen live updates and screen-reader announcements |
| `tests/e2e/*.spec.ts` | Two browsers at once (counter + visitor), network drop and recovery, joining while offline, **app opening with no network via the service worker**, lost-child flow with three phones, keyboard-only use, **axe WCAG 2.2 AA scan** in light and dark mode, phone layout |

---

## How it works

```
 Visitor phone            Counter / organizer           Finder phone
 (React PWA)              (React PWA)                   (React PWA)
      │  ▲                      │  ▲                          │  ▲
  ops │  │ snapshots        ops │  │ snapshots            ops │  │ snapshots
      ▼  │                      ▼  │                          ▼  │
 ┌──────────────────────── WebSocket /ws ──────────────────────────┐
 │  Node server: validate → apply op (once per opId) → version + 1  │
 │  → push a personalised snapshot to every subscribed phone        │
 │  HTTP: create event, public event data (ETag), static files      │
 │  Storage: data/crowdmate.json (debounced, atomic writes)         │
 └──────────────────────────────────────────────────────────────────┘
```

**On each phone** (`src/sync/client.ts`):

1. Every change ("op") is written to an **IndexedDB outbox** first, then sent with a unique `opId`.
2. It stays in the outbox until the server acknowledges it. After a dropped connection or a page reload, the outbox is re-sent. The server remembers `opId`s, so nothing is applied twice.
3. The last snapshot of each event is cached in IndexedDB, so screens render instantly and keep working offline.
4. The WebSocket reconnects with **exponential backoff + full jitter**. A heartbeat detects "zombie" connections that phones on bad networks often keep open.
5. On reconnect, the phone sends the version it has; the server replies `upToDate` or a fresh snapshot.

---

## Where each skill shows up

| Skill | Where to look |
|---|---|
| **TypeScript** (strict, discriminated unions) | `shared/protocol.ts` (the whole wire protocol is typed and shared by client and server) |
| **Closures, async patterns** | `src/sync/client.ts` (promise per op resolved by a later ack, reconnect timers, heartbeat), `src/lib/idb.ts` (promise wrapper over IndexedDB events) |
| **Component-driven UI** | React 19, `src/components/` (Field, Tabs, Dialog, Toast, ChatThread, QRCode) |
| **Critical rendering path** | `index.html` (inline critical CSS, app-shell placeholder, system fonts so no font blocks first paint); staff screens and the QR library are **lazy-loaded** so a QR scan downloads only visitor code |
| **Reflows, compositor layers** | `src/lib/useFlip.ts`: FLIP list animation with all reads batched before writes (one layout pass) and only `transform`/`opacity` animated |
| **HTTP caching headers** | `server/static.ts`: hashed assets `max-age=31536000, immutable`, HTML and `sw.js` `no-cache` + ETag; `server/app.ts`: event data ETag = version number → `304 Not Modified` |
| **Service Worker** | `src/sw/sw.js` + build plugin in `vite.config.ts`: precaches only what the visitor path needs, cache-first shell, network-first API with fallback, update prompt instead of a silent swap |
| **IndexedDB** | `src/lib/idb.ts`: events cache, offline outbox, saved places, organizer keys |
| **Web Storage** | `src/lib/storage.ts`: device id, name, text size and contrast, wrapped for private modes |
| **WebSockets, real-time** | `server/app.ts`, `src/sync/client.ts` |
| **Offline tolerance** | Outbox + cache + service worker; counter disables "Call next" while offline so nobody is skipped |
| **Accessibility (WCAG)** | Semantic landmarks, skip link, focus moved to the new page heading, `aria-live` announcements, native `<dialog>`, WAI-ARIA tabs, 44px targets, large text and high-contrast modes, reduced motion respected |
| **Automated tests** | Vitest + Testing Library, Playwright + axe-core |

### Measured numbers (production build)

- **Visitor page download: about 75 kB** (Brotli): our app code 13.8 kB, styles 3.9 kB, React 56.7 kB. React is in its own long-cached file, so app updates don't re-download it.
- Staff screens (organizer, counter) and the QR library load only when used.
- 59 unit/integration tests and 10 end-to-end tests, all passing.

---

## Project structure

```
shared/         protocol types and pure logic shared by server and browser
server/         Node HTTP + WebSocket server, store, validation, static caching
src/
  sync/         SyncClient (WebSocket, outbox, cache) and React hooks
  lib/          IndexedDB, Web Storage, router, FLIP, alerts, service worker registration
  components/   accessible UI kit
  pages/        Home, Event, Join queue, Ticket, Finder, Organizer, Counter, Tag owner
  sw/sw.js      service worker template (filled in at build time)
tests/unit      Vitest
tests/e2e       Playwright
```

## Security and privacy decisions

- The organizer key travels in the URL **#fragment** (never sent to servers or in `Referer`), is removed from the address bar after use, and only its **SHA-256 hash** is stored on the server, compared in constant time.
- Visitors never receive other people's names or device ids. Finders see a tag's private note only after they commit to helping.
- When a family is reunited, the chat and location are **deleted**.
- Every network message is validated by hand-written validators; text is cleaned; payload size and op rate are limited per connection.
- Content-Security-Policy, `nosniff`, `no-referrer` and a geolocation-only Permissions-Policy are sent with the page.

## Known limits (honest list)

- One server process with a JSON file for storage. Fine for an event of thousands of people; a large deployment would move to a database and share WebSocket state across servers (for example with Redis pub/sub).
- Alerts fire while the page is open (including in the background). Alerts with the browser fully closed would need **Web Push** with a push server.
- Tickets and tags belong to the phone that created them (its random device id). Clearing browser data loses that link.
