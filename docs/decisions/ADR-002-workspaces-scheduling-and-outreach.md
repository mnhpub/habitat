# ADR-002: Workspaces, recurring sessions, outreach and team recording

Status: Accepted

Date: 2026-10-09

Habitat was one tenant with events as its only top-level object. Organizations need separate teams, recurring programs, followers who receive mail, guest lists and recordings, and these must not leak between organizations.

## Decision

**Workspaces are tenants in D1.** `organizations` and `org_members` (owner, admin, member) hold identity and roles. Every event has an `org_id`. Event-level roles stay in each event's `members` table, so a workspace admin does not automatically become an event organizer. Authorization for workspace data (campaigns, recordings listing, team) checks the workspace role on every request. Public workspace pages expose only the name and public sessions.

**Recurring sessions are materialized, not expanded on read.** A series stores a rule in one IANA time zone and creates real events for the next eight weeks. The `(series_id, starts_at)` unique index makes creation idempotent, so the cron job and the creation request can race safely. Each session is an ordinary event with its own Durable Object, its clock starting at its start time. Occurrences are computed with Intl offsets, with a second pass to handle daylight-saving changes.

**Events keep their live state in the Durable Object.** Sign-up, the guest roster extensions, surveys and the session recording indicator are event state, so they use the existing command path: validation, authorization, the journal and broadcast. D1 holds only what must be queried across events. Commands are validated in `src/shared/command.ts` and authorized in `src/shared/reducer.ts`.

**Outreach uses one adapter and signed links.** Email goes through `src/worker/mail.ts` (Cloudflare Email Sending, via the `send_email` binding). Recipients are fixed when a campaign is sent and stored one row each, so sends survive restarts and retries stop after three attempts. Unsubscribe links are HMAC-signed with a server secret and carry only an address and a workspace. Opt-outs are checked for every campaign and are recorded per recipient as suppressed. A campaign to an event's roster can only be created and sent by that event's organizers.

**Public endpoints are token-scoped.** `/api/public/*` skips sign-in because mail clients and calendar apps cannot sign in. Access must bypass that path. Each endpoint checks its own token. Calendar feeds contain only sessions with `join_open = 1`, and a private session is never sent to a follower.

**Team recording happens in the browser.** The room is composed on a canvas and mixed in a Web Audio graph, and MediaRecorder slices it every ten seconds. Parts are uploaded in strict order (the server rejects gaps and repeats), stored as R2 objects, and streamed in order on download. The Durable Object holds the active recording per session, so everyone in the room sees it. Server-side SFU recording is not used here because it needs a separate recording service.

## Consequences

- Events created before this change were moved into a workspace named after their creator (`0002_workspaces.sql`). Nothing needed a data copy beyond that.
- Open events remain visible to any signed-in person, as before. Workspace isolation covers management, not the public listing of join-open events. A private event is visible only to its members.
- Survey dedupe keeps a SHA-256 of the event id and the address. It is not keyed, so anyone who can read stored state could test known addresses against it.
- Campaign audiences are capped at 5,000. A larger list needs a dedicated marketing provider.
- Browser recordings depend on the starter's device staying connected. A failed upload after retries stops the recording and keeps the parts already stored.
- Surveys and sign-up answers share the event state budget (8 MiB). Large events will need the collection-specific storage already noted in ADR-001.

## Validation

`npm test` covers recurrence across daylight-saving changes, CSV and calendar output, sign-up capacity and waitlisting, the roster, survey privacy, recording authorization, workspace isolation and roles, series idempotence, feed visibility, unsubscribe tokens (including tampering), campaign suppression and retries, ordered recording uploads and deletion of recordings with their event. A wrangler dev smoke test ran the Worker, Durable Object, D1 and R2 bindings over HTTP, and the local D1 applied both migrations with the legacy events backfilled.
Not verified here: a real Cloudflare Email Sending send, Access bypass behavior on the deployed hostname, and a recording made with two real cameras in a browser.
