import type { EventRoom } from './event-room';

export interface Env {
  DB: D1Database;
  EVENTS: DurableObjectNamespace<EventRoom>;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  REQUIRE_WARP_FOR_PRODUCTION: string;
  DEV_AUTH: string;
  /** Workers AI, used to translate chat. */
  AI: Ai;
  /** Anthropic key for breakout notes. Notes are unavailable without it. */
  ANTHROPIC_API_KEY?: string;
  NOTES_MODEL?: string;
  /** Cloudflare Realtime SFU app for the video room. The secret is set with `wrangler secret put`. */
  REALTIME_APP_ID?: string;
  REALTIME_APP_SECRET?: string;
  /** Email Service binding for sign-up notices and campaigns. Sends from MAIL_FROM, which must be onboarded. */
  EMAIL?: SendEmail;
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
  /** Signs unsubscribe links. Set with `wrangler secret put UNSUBSCRIBE_SECRET`. */
  UNSUBSCRIBE_SECRET?: string;
  /** Public origin used in links that go out by email, e.g. https://app.100ms.site */
  PUBLIC_URL?: string;
  /** Session recordings: one R2 object per uploaded part. */
  RECORDINGS?: R2Bucket;
}
