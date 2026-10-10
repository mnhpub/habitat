import type { Hono } from 'hono';
import type { AppEnv } from '../app-types';
import type { Env } from '../env';
import { orgRole, canManage, ORG_ROLES, type OrgRole } from '../tenancy';
import { readJson } from '../request';
import { parseSeriesInput, materializeSeries, type SeriesRow } from '../series';
import { randomToken } from '../tokens';

const MAX_WORKSPACES_PER_PERSON = 25;

/** Workspaces (tenants): who they are, who runs them, their recurring series, and who follows them. */
export function mountWorkspaces(app: Hono<AppEnv>) {
  app.get('/api/orgs', async (c) => {
    const email = c.get('identity').email;
    const { results } = await c.env.DB.prepare(
      `SELECT o.id, o.name, o.created_at, m.role FROM org_members m JOIN organizations o ON o.id = m.org_id
       WHERE m.email = ? ORDER BY o.name`,
    ).bind(email).all<{ id: string; name: string; created_at: number; role: OrgRole }>();
    return c.json(results.map((r) => ({ id: r.id, name: r.name, role: r.role, createdAt: r.created_at })));
  });

  /** Self-serve sign-up: any signed-in person can open a workspace and becomes its owner. */
  app.post('/api/orgs', async (c) => {
    const email = c.get('identity').email;
    const body = await readJson(c.req.raw);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) return c.json({ error: 'Give the workspace a name (up to 120 characters)' }, 400);
    const owned = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM org_members WHERE email = ? AND role = 'owner'").bind(email).first<{ n: number }>();
    if ((owned?.n ?? 0) >= MAX_WORKSPACES_PER_PERSON) return c.json({ error: 'You have reached the workspace limit for one account' }, 409);
    const id = `ws-${crypto.randomUUID()}`;
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO organizations (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').bind(id, name, email, now),
      c.env.DB.prepare("INSERT INTO org_members (org_id, email, role, added_by, added_at) VALUES (?, ?, 'owner', ?, ?)").bind(id, email, email, now),
    ]);
    return c.json({ id }, 201);
  });

  /**
   * A workspace page. Everyone signed in can see its name and public sessions (so they can follow it).
   * Members also get the team, the series and the list of every session.
   */
  app.get('/api/orgs/:id', async (c) => {
    const orgId = c.req.param('id');
    const org = await c.env.DB.prepare('SELECT id, name, created_at FROM organizations WHERE id = ?').bind(orgId).first<{ id: string; name: string; created_at: number }>();
    if (!org) return c.json({ error: 'Workspace not found' }, 404);
    const email = c.get('identity').email;
    const role = await orgRole(c.env, email, orgId);
    const series = await c.env.DB.prepare('SELECT * FROM series WHERE org_id = ? AND active = 1 AND join_open = 1 ORDER BY created_at').bind(orgId).all<SeriesRow>();
    const sessions = await c.env.DB.prepare(
      `SELECT id, name, venue, starts_at, duration_min, series_id FROM events
       WHERE org_id = ? AND join_open = 1 AND starts_at >= ? ORDER BY starts_at LIMIT 50`,
    ).bind(orgId, Date.now() - 86_400_000).all<{ id: string; name: string; venue: string; starts_at: number; duration_min: number; series_id: string | null }>();
    const body: Record<string, unknown> = {
      id: org.id,
      name: org.name,
      createdAt: org.created_at,
      role,
      series: series.results.map(seriesJson),
      sessions: sessions.results.map((e) => ({ id: e.id, name: e.name, venue: e.venue, startsAt: e.starts_at, durationMin: e.duration_min, seriesId: e.series_id })),
    };
    if (role) {
      const members = await c.env.DB.prepare('SELECT email, role, added_at FROM org_members WHERE org_id = ? ORDER BY added_at').bind(orgId).all<{ email: string; role: OrgRole; added_at: number }>();
      body.members = members.results.map((m) => ({ email: m.email, role: m.role, addedAt: m.added_at }));
      body.canManage = canManage(role);
    }
    return c.json(body);
  });

  app.patch('/api/orgs/:id', async (c) => {
    const orgId = c.req.param('id');
    if (!canManage(await orgRole(c.env, c.get('identity').email, orgId))) return c.json({ error: 'Workspace admins only' }, 403);
    const body = await readJson(c.req.raw);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) return c.json({ error: 'Give the workspace a name (up to 120 characters)' }, 400);
    await c.env.DB.prepare('UPDATE organizations SET name = ? WHERE id = ?').bind(name, orgId).run();
    return c.json({ ok: true });
  });

  app.put('/api/orgs/:id/members', async (c) => {
    const orgId = c.req.param('id');
    const actorRole = await orgRole(c.env, c.get('identity').email, orgId);
    if (!canManage(actorRole)) return c.json({ error: 'Workspace admins only' }, 403);
    const body = await readJson(c.req.raw);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || !email.includes('@') || email.length > 254) return c.json({ error: 'Valid email required' }, 400);
    if (!ORG_ROLES.includes(body.role as OrgRole)) return c.json({ error: 'Choose owner, admin or member' }, 400);
    const role = body.role as OrgRole;
    if (role === 'owner' && actorRole !== 'owner') return c.json({ error: 'Only owners can make someone an owner' }, 403);
    const current = await orgRole(c.env, email, orgId);
    if (current === 'owner' && role !== 'owner' && actorRole !== 'owner') return c.json({ error: 'Only owners can change an owner' }, 403);
    if (current === 'owner' && role !== 'owner' && (await ownerCount(c.env, orgId)) <= 1) return c.json({ error: 'A workspace needs at least one owner' }, 400);
    await c.env.DB.prepare(
      `INSERT INTO org_members (org_id, email, role, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(org_id, email) DO UPDATE SET role = ?3`,
    ).bind(orgId, email, role, c.get('identity').email, Date.now()).run();
    return c.json({ ok: true });
  });

  app.delete('/api/orgs/:id/members/:email', async (c) => {
    const orgId = c.req.param('id');
    const me = c.get('identity').email;
    const actorRole = await orgRole(c.env, me, orgId);
    if (!canManage(actorRole)) return c.json({ error: 'Workspace admins only' }, 403);
    const email = decodeURIComponent(c.req.param('email')).toLowerCase();
    const target = await orgRole(c.env, email, orgId);
    if (!target) return c.json({ ok: true });
    if (target === 'owner') {
      if (actorRole !== 'owner') return c.json({ error: 'Only owners can remove an owner' }, 403);
      if ((await ownerCount(c.env, orgId)) <= 1) return c.json({ error: 'A workspace needs at least one owner' }, 400);
    }
    await c.env.DB.prepare('DELETE FROM org_members WHERE org_id = ? AND email = ?').bind(orgId, email).run();
    return c.json({ ok: true });
  });

  app.post('/api/orgs/:id/series', async (c) => {
    const orgId = c.req.param('id');
    const me = c.get('identity').email;
    if (!(await orgRole(c.env, me, orgId))) return c.json({ error: 'Workspace members only' }, 403);
    let input;
    try {
      input = parseSeriesInput(await readJson(c.req.raw));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid series' }, 400);
    }
    const id = crypto.randomUUID();
    const rule = input.rule;
    await c.env.DB.prepare(
      `INSERT INTO series (id, org_id, name, kind, venue, duration_min, timezone, time_of_day, freq, interval_n, by_day, day_of_month,
        starts_on, ends_on, max_occurrences, join_open, active, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 1, ?17, ?18)`,
    ).bind(id, orgId, input.name, input.kind, input.venue, input.durationMin, rule.timezone, rule.timeOfDay, rule.freq,
      rule.interval, JSON.stringify(rule.byDay), rule.dayOfMonth, rule.startsOn, rule.endsOn, rule.maxOccurrences,
      input.joinOpen, me, Date.now()).run();
    const row = await c.env.DB.prepare('SELECT * FROM series WHERE id = ?').bind(id).first<SeriesRow>();
    const created = await materializeSeries(c.env, row!);
    return c.json({ id, sessions: created }, 201);
  });

  app.get('/api/orgs/:id/series', async (c) => {
    const orgId = c.req.param('id');
    if (!(await orgRole(c.env, c.get('identity').email, orgId))) return c.json({ error: 'Workspace members only' }, 403);
    const { results } = await c.env.DB.prepare('SELECT * FROM series WHERE org_id = ? ORDER BY created_at DESC').bind(orgId).all<SeriesRow>();
    return c.json(results.map(seriesJson));
  });

  /** Stop a series: no new sessions are created. Sessions already scheduled are kept. */
  app.delete('/api/orgs/:id/series/:sid', async (c) => {
    const orgId = c.req.param('id');
    const me = c.get('identity').email;
    const role = await orgRole(c.env, me, orgId);
    const row = await c.env.DB.prepare('SELECT created_by FROM series WHERE id = ? AND org_id = ?').bind(c.req.param('sid'), orgId).first<{ created_by: string }>();
    if (!row) return c.json({ error: 'Series not found' }, 404);
    if (!canManage(role) && row.created_by !== me) return c.json({ error: 'Only the series creator or a workspace admin can stop it' }, 403);
    await c.env.DB.prepare('UPDATE series SET active = 0 WHERE id = ?').bind(c.req.param('sid')).run();
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ following

  app.get('/api/subscriptions', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT s.target_kind AS kind, s.target_id AS id, s.token, COALESCE(o.name, se.name) AS name
       FROM subscriptions s
       LEFT JOIN organizations o ON s.target_kind = 'org' AND o.id = s.target_id
       LEFT JOIN series se ON s.target_kind = 'series' AND se.id = s.target_id
       WHERE s.email = ?`,
    ).bind(c.get('identity').email).all<{ kind: string; id: string; token: string; name: string | null }>();
    const origin = new URL(c.req.url).origin;
    return c.json(results.map((r) => ({ kind: r.kind, id: r.id, name: r.name ?? 'Removed', feedUrl: `${origin}/api/public/feeds/${r.token}.ics` })));
  });

  /** Follow a workspace or a public series. Only public sessions are ever shared with followers. */
  app.put('/api/subscriptions/:kind/:id', async (c) => {
    const kind = c.req.param('kind');
    const id = c.req.param('id');
    const email = c.get('identity').email;
    if (kind === 'org') {
      if (!(await c.env.DB.prepare('SELECT id FROM organizations WHERE id = ?').bind(id).first())) return c.json({ error: 'Workspace not found' }, 404);
    } else if (kind === 'series') {
      if (!(await c.env.DB.prepare('SELECT id FROM series WHERE id = ? AND active = 1 AND join_open = 1').bind(id).first())) return c.json({ error: 'That series is not open to followers' }, 404);
    } else {
      return c.json({ error: 'Follow a workspace or a series' }, 400);
    }
    await c.env.DB.prepare('INSERT OR IGNORE INTO subscriptions (email, target_kind, target_id, token, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(email, kind, id, randomToken(), Date.now()).run();
    return c.json({ ok: true });
  });

  app.delete('/api/subscriptions/:kind/:id', async (c) => {
    await c.env.DB.prepare('DELETE FROM subscriptions WHERE email = ? AND target_kind = ? AND target_id = ?')
      .bind(c.get('identity').email, c.req.param('kind'), c.req.param('id')).run();
    return c.json({ ok: true });
  });
}

export function seriesJson(r: SeriesRow) {
  return {
    id: r.id, name: r.name, venue: r.venue, kind: r.kind, durationMin: r.duration_min, timezone: r.timezone,
    timeOfDay: r.time_of_day, freq: r.freq, interval: r.interval_n, byDay: JSON.parse(r.by_day) as number[],
    dayOfMonth: r.day_of_month, startsOn: r.starts_on, endsOn: r.ends_on, maxOccurrences: r.max_occurrences,
    joinOpen: !!r.join_open, active: !!r.active, createdBy: r.created_by,
  };
}

async function ownerCount(env: Env, orgId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND role = 'owner'").bind(orgId).first<{ n: number }>();
  return row?.n ?? 0;
}
