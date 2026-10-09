import type { EventRoom } from './event-room';

export interface Env {
  DB: D1Database;
  EVENTS: DurableObjectNamespace<EventRoom>;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  REQUIRE_WARP_FOR_PRODUCTION: string;
  DEV_AUTH: string;
}
