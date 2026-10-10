# Habitat

An event operating system: control room, stream bus, bridge, green rooms, audience participation, check-in, guest services and organizer governance. It runs entirely on Cloudflare, and people sign in through Cloudflare One (Access + WARP).

Every screen from the design is live, persisted and shared in real time. Two people on different devices see the same take, the same vote count and the same cue firing at the same moment on the event clock.

## How it's built

```
Browser / iPhone / iPad / Mac (React)
        │  HTTPS + WebSocket, behind Cloudflare Access
        ▼
Worker (Hono)  ── verifies the Access JWT, reads WARP status, looks up roles in D1
        │  Durable Object RPC (commands, snapshots, journal) + WebSocket hand-off
        ▼
EventRoom Durable Object  — one per event
  • event clock: epoch + monotonically increasing sequence number (τ = now − epoch)
  • authoritative state (bounded SQLite chunks) + append-only journal (SQLite table)
  • authorizes, applies, journals and broadcasts every command
  • hibernating WebSockets; each viewer gets their own projection of the state
  • alarms fire auto cues on the event clock, even with nobody connected
D1  — workspaces (tenants), events, team memberships, recurring series, followers, email campaigns, recording index
R2  — session recording parts (one object per upload)
Cloudflare Email Sending (send_email binding) — sign-up notices and campaigns
Cron trigger — creates recurring sessions ahead of time and keeps campaigns sending
Static assets — the React app (Workers assets, SPA routing)
```

| Path | What it is |
|---|---|
| `src/shared/types.ts` | Domain model, commands, roles |
| `src/shared/reducer.ts` | Permissions table, WARP-only commands, the reducer |
| `src/shared/command.ts` | Runtime validation of every incoming command |
| `src/shared/view.ts` | Per-viewer projection: hides who voted for what, anonymous authors, other guests' details, budget, held chat |
| `src/shared/seed.ts` | Demo content every new event starts with |
| `src/worker/index.ts` | API routes (events, team, snapshot, commands, journal, WebSocket) and the cron handler |
| `src/worker/routes/workspaces.ts` | Workspaces, their members and roles, recurring series, following |
| `src/worker/routes/marketing.ts` | Email campaigns, unsubscribe, calendar feeds |
| `src/worker/routes/recordings.ts` | Team session recording: start, ordered part upload, stop, download |
| `src/worker/series.ts`, `src/shared/recurrence.ts` | Recurring sessions: time-zone-aware occurrences and materialization |
| `src/worker/campaigns.ts`, `src/worker/mail.ts`, `src/worker/tokens.ts` | Audiences, opt-outs, sending with retries, signed unsubscribe links |
| `src/shared/survey.ts`, `src/shared/csv.ts`, `src/shared/ics.ts` | Survey projection, CSV import/export, calendar files |
| `src/client/recorder.ts` | Browser recorder for the video room |
| `src/worker/auth.ts` | Cloudflare Access JWT verification and WARP detection; localhost-only dev sign-in |
| `src/worker/event-room.ts` | The EventRoom Durable Object |
| `src/client/` | React app; `pages/` holds all the screens |
| `migrations/` | D1 schema |
| `tests/` | Reducer, API, authentication, socket and SQLite persistence regression tests |

### Screens

Each screen shows up in the left navigation for the roles that use it. Organizers see everything.

- **Production:** control room, simple control room, event clock & devices (with the full journal), stream bus, bridge
- **Talent & backstage:** green room (real camera/mic preflight in the browser), talent iPhone view, stage manager, camera operator
- **Audience:** how to attend (registration, .ics calendar), sign up, lobby & stage, engage, vote, surveys, Q&A + chat, my event (pass, seat orders, valet), networking tables, watch party, video room (with team recording)
- **Moderation:** moderator console, host iPad view
- **Operations:** organizer (lifecycle, gates, workstreams, budget, incidents), team & setup (small-team role bundles, members), attendee types, sign-up form, guest roster (CSV import and export), check-in (with Verify with Wallet flow), orders & valet
- **Workspace** (from the home page): sessions, recurring series, following and calendar links, email campaigns, team recordings, team

### Workspaces, sign-up and sessions

- **Workspaces** are tenants. Anyone signed in can create one and becomes its owner. Owners and admins manage the team (owner, admin, member), campaigns and recordings. Members create events and recurring series. An event belongs to exactly one workspace. Events that already existed were moved into a workspace named after their creator.
- **Recurring sessions** repeat weekly or monthly in a named time zone, so 18:00 stays 18:00 across daylight-saving changes. Sessions are created up to eight weeks ahead, each in its own room. Later sessions copy the team of the first. Stopping a series creates no more sessions.
- **Event sign-up** is a public form with questions, an optional capacity and an open/closed switch. People who arrive after capacity are waitlisted, and an organizer approves them when there is room.
- **Guest roster** lists registrations with sign-up answers, filters by waitlist, and exports and imports CSV (name, email, attendance). Duplicate emails are skipped on import.
- **Surveys** have rating, choice and written questions. Drafts stay hidden until opened. Each person answers once. Anonymous surveys record nothing that names the respondent (only a hash is kept to block a second answer), and attendees see only summaries.
- **Following**: people follow a workspace or a public series. They get an email when a session is scheduled and a calendar subscription (`.ics`) of public sessions. Private sessions are never shared.
- **Email campaigns** go to followers, to the registered guests of one session (only that session's organizers can send to it), or to a series' followers. Every message carries a signed one-click unsubscribe link and a `List-Unsubscribe` header. Opt-outs are checked at send time, and failed sends are retried three times before they are marked failed.
- **Team session recording** records the video room in the browser and uploads it in ten-second parts. Everyone in the room sees a recording indicator, and only the person who started it, or crew, can stop it. Recordings are private to crew, the starter, and workspace admins.

### Roles

`organizer`, `producer`, `audio`, `stage_manager`, `moderator`, `talent`, `foh`, `vendor`, `attendee`.

- Whoever creates an event becomes its organizer, and adds the team by email in **Team & setup**.
- Anyone else who signs in through Access joins open events as an attendee.
- Role changes reach people's open screens immediately.
- Removing a team member closes their existing sockets. Private events deny reconnection; open events allow reconnection as an attendee.
- Production controls (take, cut, cues, audio, stream bus routing) also require a WARP device when `REQUIRE_WARP_FOR_PRODUCTION` is `"true"`.
- Production controls go through authenticated HTTP so device posture and event roles are checked for each request. Audience commands use WebSockets, with membership checked per command. Socket sessions reconnect for authentication at least every five minutes and never outlive the Access token.

Chat scopes are enforced by the server: Everyone is event-wide; In the room requires in-person check-in; My table requires current seating at that table; Watch party requires registration with the same party code. Organizers, producers and moderators can review all channels. Party codes identify self-serve groups; they are not invitation or authorization secrets. Legacy table/party messages without a scope are hidden from attendees.

## Run it locally

Requires Node 22.13+ (the persistence tests use Node's SQLite API).

```bash
npm install
cp .dev.vars.example .dev.vars        # turns on localhost-only dev sign-in
npm run db:migrate:local
npm run dev                           # builds the app, starts wrangler on http://localhost:8787
```

Open http://localhost:8787. You'll get a local sign-in page with a set of sample people.

1. Sign in as **Rosa Alvarez (organizer)** and create an event.
2. In **Team & setup**, add `director@example.com` as Producer, `host@example.com` as Host / moderator, and so on.
3. Open a second browser (or a private window), sign in as someone else, and watch changes appear live.
4. Untick "Pretend this device is on WARP" to see production controls refused.

For hot reload on the UI, run `npx wrangler dev` in one terminal and `npm run dev:ui` in another (Vite proxies `/api` and WebSockets to :8787).

```bash
npm test          # domain, API, auth, sockets, real SQLite storage and privacy tests
npm run typecheck
```

## Deploy to Cloudflare

**1. Create the database**

```bash
npx wrangler login
npx wrangler d1 create habitat
```

Paste the printed `database_id` into `wrangler.jsonc`, then run:

```bash
npm run db:migrate:remote
```

**2. Deploy once to get the Worker's URL**

```bash
npm run deploy
```

Or attach a custom domain, such as `events.yourcompany.com`, under Workers → Settings → Domains.

**2b. Create the recording bucket and the email sender**

```bash
npx wrangler r2 bucket create habitat-recordings
npx wrangler email sending enable 100ms.site        # or your own domain
npx wrangler secret put UNSUBSCRIBE_SECRET          # any long random string; signs unsubscribe links
npm run db:migrate:remote                            # applies migrations 0002 and 0003
```

Set `MAIL_FROM` (a sender on that domain), `MAIL_FROM_NAME` and `PUBLIC_URL` (the public origin, used in email links) in `wrangler.jsonc`. Until `UNSUBSCRIBE_SECRET` is set, campaign sends are refused with a clear message. Sign-up notices are sent the same way.

Email goes out through Cloudflare Email Sending (the `send_email` binding). Its guidance is aimed at transactional mail, so moderate lists work, but large newsletters should go through a dedicated marketing provider. Swap `src/worker/mail.ts` to do it.

**3. Protect it with Cloudflare Access** (Zero Trust dashboard → Access → Applications → Add → Self-hosted)

- **Domain:** the Worker's hostname.
- **Identity providers:** your IdP. Add one-time PIN or another IdP for attendees if they aren't in your directory.
- **Policies:**
  - **Crew:** Allow → Emails ending in `@yourcompany.com` (or a group), **Require → Gateway** so the device must be on WARP.
  - **Attendees** (optional, if guests use the same hostname): Allow → your attendee IdP or one-time PIN, without the Gateway requirement. Production commands are still refused to non-WARP devices by the Worker.
- **Bypass** for `/api/public/*` (Access → Applications → Add → Bypass, or a second application with Bypass policy). Unsubscribe links and calendar feeds are opened from email and calendar apps, which cannot sign in. Each of those routes checks its own signed or random token, and nothing else is exposed there.
- Copy the application's **Audience (AUD) tag**.

**4. Configure the Worker**

In `wrangler.jsonc` (or as dashboard variables), set:
- `ACCESS_TEAM_DOMAIN`: e.g. `yourteam.cloudflareaccess.com`
- `ACCESS_AUD`: the AUD tag
- `REQUIRE_WARP_FOR_PRODUCTION`: `"true"`
- `DEV_AUTH`: must stay `"false"`. Dev sign-in only ever works on localhost anyway.

Then run `npm run deploy` again.

**5. Enroll crew devices in WARP**

Zero Trust → Settings → WARP Client. Enroll producer and stage-manager Macs, Windows and Linux machines, iPhones and iPads with the Cloudflare One Agent. A device counts as WARP when Access's identity reports `is_warp` or `is_gateway`.

- Check this once: sign in on an enrolled device and the top bar should say **WARP**.
- If your account reports posture differently, adjust `accessIdentity()` in `src/worker/auth.ts`.

## What's real and what's simulated

**Real:**
- authentication, roles and permissions
- the event clock, journal and sequencing
- persistence, live sync across devices, and auto cues on Durable Object alarms
- polls, word clouds, ratings, Q&A, chat and moderation
- hands, check-in, orders, valet, networking tables, the bridge log and mic state
- the organizer's gates, lifecycle, budget and incidents
- browser camera/mic preflight, the camera operator's viewfinder, and calendar files

**Simulated, with where the real thing plugs in:**
- **Video and audio media.** Monitors show placeholders and meters are animated. Program state, tally and routing are real. The media layer is Cloudflare Realtime (SFU) for contribution and the bridge, plus Cloudflare Stream (WHIP/WHEP) for delivery. Publish tracks per source id and let `production.programId` drive the composer.
- **Apple Wallet passes and Verify with Wallet.** These need your Pass Type ID certificate and Apple's entitlement. The check-in screen walks through the flow with a simulated consent step.
- **Session recording is browser-side.** The video room's own tiles and mixed audio are recorded in each recording person's browser and uploaded in parts. Server-side (SFU) recording is not wired, so a recording stops if the person who started it loses their connection for longer than the upload retries. Breakouts are chat-only and are not recorded.
- **Email campaigns** send through Cloudflare Email Sending, which is aimed at transactional mail. See the note under Deploy.
- **Apple Pay and vendor payouts.** Orders are recorded and settled in the event state. Connect Apple Pay through your payment processor (e.g. Stripe with Connect for multiple vendors) where the `ORDER` command is handled.
- **OSC / Avid / MIDI control surfaces.** They issue the same commands over the event WebSocket through a gateway enrolled in WARP.

## Notes for scale

- Workspaces, series and campaigns live in D1. Each event's live state stays in its Durable Object. The two are not transactional with each other; an event is created in D1 first and then initialized, and a retry cannot duplicate a series session because the database enforces one event per series start time.
- Campaign recipients are fixed at send time and capped at 5,000 per campaign. Each recipient is a separate send, so large audiences take several cron runs.
- Survey responses live in the event's Durable Object within the same 8 MiB state budget as the rest of the event. Large surveys should move to their own storage.

- Each command writes a transaction containing the journal entry and the event state in chunks below 512 KiB, then updates memory and broadcasts viewer projections, coalesced every 60 ms. Existing single-row snapshots migrate automatically on first load.
- Event state has an 8 MiB budget. New submissions stop at 7 MiB, leaving headroom for production controls and moderation. Capacity failures return a structured 409 and leave the previous state intact. This is a bounded prototype storage model; large events need collection-specific storage and paginated views.
- For very large audiences, split audience-facing counters (reactions, votes) into their own Durable Object, or send diffs instead of full snapshots.
- The journal is append-only and keeps every command with its sequence number, τ and actor, so the show can be audited or replayed.
- The Durable Object is authoritative for event names and venues. Renames atomically record a D1 synchronization task, retry failures using alarms, and event listings read the authoritative metadata while retries are pending.

See [ADR-001](docs/decisions/ADR-001-event-state-and-command-boundaries.md) for the persistence, authentication and API contracts. Tests use a small Workers base-class adapter and real SQLite in Node; Cloudflare runtime behavior also needs local or staging smoke testing before deployment.
