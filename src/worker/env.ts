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
}
