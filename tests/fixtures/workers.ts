// Node test adapter for the platform base class; storage uses real SQLite below.
export class DurableObject<Env> {
  constructor(protected ctx: DurableObjectState, protected env: Env) {}
}

// PartyServer reads the Worker env from here when routing by request; tests pass env explicitly.
export const env = {};
