# Blockers and open decisions

Status as of 2026-10-09, after the workspaces, recurring sessions, sign-up, roster, surveys, following, email campaigns and team recording work. Nothing here is committed.

## Blocks deployment

| # | Blocker | What unblocks it |
|---|---|---|
| 1 | R2 bucket `habitat-recordings` does not exist yet. Recording uploads fail without it. | `npx wrangler r2 bucket create habitat-recordings` |
| 2 | Migrations `0002` and `0003` are applied only to local D1. | `npm run db:migrate:remote` |
| 3 | `UNSUBSCRIBE_SECRET` is not set. Campaign sends return 503 until it is. | `npx wrangler secret put UNSUBSCRIBE_SECRET` |
| 4 | `MAIL_FROM` is the placeholder `events@100ms.site`. Email Sending rejects sends from a domain that is not onboarded. | Onboard the real sender domain with `wrangler email sending enable`, then set `MAIL_FROM` in `wrangler.jsonc` |
| 5 | Access does not yet bypass `/api/public/*`. Unsubscribe links and calendar feeds will be blocked by the sign-in gate. | Add a Bypass policy for that path in the Zero Trust dashboard (needs dashboard access) |
| 6 | The cron trigger (`*/10 * * * *`) is untested on a deployed Worker. The local smoke test invoked the handler by hand. | Confirm the trigger appears after deploy and watch the first runs in logs |

## Not verified

- **A real Cloudflare Email Sending send.** Tests use a fake `EMAIL` binding. Nothing has left the platform.
- **The Access bypass** on the deployed hostname.
- **The new screens in a browser.** Typecheck and the Vite build pass, and the API is verified over HTTP, but nobody has clicked through the signup, roster, survey, workspace, or recording screens.
- **A real recording** with two or more cameras, including a dropped connection and the upload retries.
- **Recordings on a deployed R2 bucket.** Local R2 is simulated by miniflare.

## Blocked by something outside the repo

- **Local dev sign-in does not work under `wrangler dev`.** This predates my changes. The `routes` custom-domain entry in `wrangler.jsonc` makes the Worker see the request host as `app.100ms.site`, and the localhost-only check in `src/worker/auth.ts` then refuses dev sign-in. I worked around it with a temporary config without the route, which I removed afterwards. Fix options: a separate dev config without `routes`, or relaxing the host check for `wrangler dev` only. I have not changed either.
- **Email is sent through Cloudflare Email Sending** (the `send_email` binding). Its product guidance is aimed at transactional mail, so bulk or newsletter volume may need a marketing provider. The swap point is `src/worker/mail.ts`.

## Limits I chose, which you may want to change

- **Session recording is browser-side.** A recording stops if the starter's connection drops past the upload retries. Breakouts are not recorded. Server-side recording needs a separate service.
- **Campaigns are capped at 5,000 recipients**, and each recipient is one send.
- **Event sign-up, guest roster, and survey state live in the event's Durable Object**, inside its 8 MiB budget.

## Decisions (resolved)

1. Event roster campaigns are limited to that event's organizers. Workspace admins who don't organize the event cannot email its guests. Checked when a campaign is created and again when it is sent.
2. Survey dedupe stores a SHA-256 of the event id and the address, not the address. Named surveys still record the author for crew. The hash is unkeyed, so someone with access to stored state could test known addresses against it.
3. Join-open events stay visible across workspaces, as before.
4. Later series sessions keep copying the team of the first session.

## Test-harness gaps

- The test D1 adapter runs `batch` in order without a real transaction. Atomicity of the recording part upload is therefore checked by design, not by test.
- Date-dependent tests use the current date. They have been stable over repeated runs, but they have not been run across a daylight-saving boundary or a month-end.
