# ADR-001: Persist event changes atomically and enforce command boundaries

Status: Accepted

Date: 2026-10-08

The initial event model stored its entire state in one SQLite row. Growing Q&A could exceed the platform's 2 MB row limit, and a failed snapshot write left memory ahead of storage. Socket attachments also retained membership and device trust indefinitely, and private chat labels had no group identity.

## Decision

Keep the event reducer and one Durable Object per event. Store serialized state in ordered chunks of at most 128 Ki characters, preserving UTF-16 surrogate pairs before SQLite encodes them as UTF-8. Each row remains below 512 KiB. Commit the journal, all snapshot chunks and any metadata synchronization task in one synchronous SQLite transaction. Publish the new in-memory state only after that transaction succeeds. Load existing legacy single-row snapshots and migrate them transactionally, preserving sequence numbers and journal history.

Cap serialized state at 8 MiB and reject growing submissions at 7 MiB with a 409 response. The reserved capacity allows production and moderation commands to continue near the submission limit. Full serialization and fanout still cost work proportional to state size; large events should move growing collections into independent rows and expose paginated views. Chunking is chosen here to preserve the existing reducer and all current event data while fixing the row limit without a domain-wide schema rewrite.

The Durable Object owns names and venues. Event listings read that metadata. A rename includes a durable, sequence-tagged D1 outbox record in the event transaction. Serialized D1 updates consume that record; failures retry on an alarm. Cue deadlines and metadata retries share the Object's single alarm, choosing the earliest deadline. Cue firing precedes external metadata I/O. D1 and Durable Objects have no shared transaction, so catalog synchronization is eventually consistent while listings remain current.

Production commands use HTTP to re-run Access authentication, bypass the identity posture cache and read current D1 roles. When WARP is required, the Object refuses these commands over WebSocket. Audience socket commands re-read D1 membership. Membership removal marks existing attachments revoked and closes sockets. Socket leases expire after five minutes or the Access token expiry, whichever comes first; attachments predating this contract must reconnect. Open events still allow removed crew to reconnect as attendees.

Chat commands specify a channel, while the server derives its scope from current seating or registration. Table messages carry a table ID; party messages carry the registered party ID; room messages require in-person check-in. Posting and projection both enforce scope membership. Leaving a table revokes its chat access. Moderators, producers and organizers retain cross-channel review. Self-serve watch-party identifiers establish groups, not invitation-only access. Legacy unscoped private messages remain stored but are visible only to moderators.

## Command contract

HTTP bodies are JSON objects limited to 16 KiB. Incoming commands are validated against a complete command schema before authorization or mutation. Strings, booleans, enums, finite numbers and integer monetary values are checked. Unknown command names are rejected, including object prototype keys. Extra fields are discarded so they do not grow journal payloads.

Responses preserve `{ ok, seq?, error? }` and add `status?` on failures. HTTP uses 400 for invalid commands, 403 for authorization/device failures, 404 for unknown domain records, 409 for event capacity, and 413 for oversized bodies. WebSocket acknowledgements carry the same command result. Storage failures are server errors and never publish an uncommitted state.

`REGISTER` adds optional `partyId`; it is required for `watch_party` attendance and uses 1–64 lowercase letters, digits, underscores or hyphens. Attendance mode changes reconcile check-in, verification, seating and party membership. Order IDs use random UUIDs and cannot collide with seeded display IDs.

The client guards every socket callback and asynchronous probe against its originating connection. Stop cancels reconnect and command timers. Store revisions trigger React subscriptions even when role-only snapshots share a sequence number and timestamp.

## Validation

Regression tests cover the original failures, HTTP response semantics, cryptographically verified JWT posture refresh, SQLite transaction rollback, legacy migration, Unicode chunk boundaries, capacity headroom, metadata retries and stale socket callbacks. The Node adapter exercises application code with real SQLite but does not simulate Workers input/output gates or the complete Access edge; local or staging Workers tests remain a separate verification step.
