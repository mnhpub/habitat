import type { Env } from './env';
import type { Identity } from './auth';

export type AppVars = { identity: Identity };
export type AppEnv = { Bindings: Env; Variables: AppVars };
