import type { Hono } from 'hono';
import type { AppEnv } from '../app-types';
import type { Env } from '../env';
import { orgRole, canManage } from '../tenancy';
import { readJson } from '../request';
import { prepareRecipients, processCampaign, isEventOrganizer, type Audience, type CampaignRow } from '../campaigns';
import { verifyUnsubscribe } from '../tokens';
import { escapeHtml } from '../mail';
import { icsCalendar } from '../../shared/ics';

const MAX_BODY = 10_000;

/** Email campaigns (workspace admins), public unsubscribe, and public calendar feeds. */
export function mountMarketing(app: Hono<AppEnv>) {
  app.get('/api/orgs/:id/campaigns', async (c) => {
    const orgId = c.req.param('id');
    if (!canManage(await orgRole(c.env, c.get('identity').email, orgId))) return c.json({ error: 'Workspace admins only' }, 403);
    const { results } = await c.env.DB.prepare('SELECT * FROM campaigns WHERE org_id = ? ORDER BY created_at DESC LIMIT 100')
      .bind(orgId).all<CampaignRow>();
    return c.json(results.map(campaignJson));
  });

  app.post('/api/orgs/:id/campaigns', async (c) => {
    const orgId = c.req.param('id');
    if (!canManage(await orgRole(c.env, c.get('identity').email, orgId))) return c.json({ error: 'Workspace admins only' }, 403);
    const body = await readJson(c.req.raw);
    const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!subject || subject.length > 150) return c.json({ error: 'Give the email a subject (up to 150 characters)' }, 400);
    if (!text || text.length > MAX_BODY) return c.json({ error: `Write the message (up to ${MAX_BODY.toLocaleString('en-US')} characters)` }, 400);
    let audience: Audience;
    try {
      audience = await parseAudience(c.env, orgId, body.audience);
      if (audience.kind === 'event' && !(await isEventOrganizer(c.env, c.get('identity').email, audience.eventId))) {
        return c.json({ error: "Only that event's organizers can email its guest roster" }, 403);
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Choose who receives this' }, 400);
    }
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO campaigns (id, org_id, kind, subject, body, audience, status, created_by, created_at)
       VALUES (?1, ?2, 'campaign', ?3, ?4, ?5, 'draft', ?6, ?7)`,
    ).bind(id, orgId, subject, text, JSON.stringify(audience), c.get('identity').email, Date.now()).run();
    return c.json({ id }, 201);
  });

  /**
   * Start sending a draft. Recipients are fixed at this moment; opted-out people are recorded as suppressed.
   * Sending continues in the background and in the scheduled job if it does not finish.
   */
  app.post('/api/orgs/:id/campaigns/:cid/send', async (c) => {
    const orgId = c.req.param('id');
    if (!canManage(await orgRole(c.env, c.get('identity').email, orgId))) return c.json({ error: 'Workspace admins only' }, 403);
    const missing = ['EMAIL', 'MAIL_FROM', 'UNSUBSCRIBE_SECRET', 'PUBLIC_URL'].filter((k) => !c.env[k as keyof Env]);
    if (missing.length) return c.json({ error: `Email is not set up yet (missing ${missing.join(', ')})` }, 503);
    const campaign = await c.env.DB.prepare('SELECT * FROM campaigns WHERE id = ? AND org_id = ?').bind(c.req.param('cid'), orgId).first<CampaignRow>();
    if (!campaign) return c.json({ error: 'Campaign not found' }, 404);
    if (campaign.status !== 'draft') return c.json({ error: 'This campaign has already been sent' }, 409);
    const audience = JSON.parse(campaign.audience) as Audience;
    if (audience.kind === 'event' && !(await isEventOrganizer(c.env, c.get('identity').email, audience.eventId))) {
      return c.json({ error: "Only that event's organizers can email its guest roster" }, 403);
    }
    let total: number;
    try {
      total = await prepareRecipients(c.env, campaign.id, orgId, audience);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Could not prepare the audience' }, 400);
    }
    c.executionCtx.waitUntil(processCampaign(c.env, campaign.id).catch((err) => console.error('Campaign send failed', err)));
    return c.json({ total }, 202);
  });

  // ------------------------------------------------------------ public (no sign-in; see README for the Access bypass)

  app.get('/api/public/unsubscribe', async (c) => {
    const token = c.req.query('t') ?? '';
    const ok = !!(c.env.UNSUBSCRIBE_SECRET && await verifyUnsubscribe(c.env.UNSUBSCRIBE_SECRET, token));
    return c.html(ok ? confirmPage(token) : page('This link is not valid', 'Check the email you received, or ask the sender to send it again.'), ok ? 200 : 400);
  });

  /** Opts out of one workspace's email and stops following it and its series. Works as a one-click unsubscribe. */
  app.post('/api/public/unsubscribe', async (c) => {
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const token = c.req.query('t') ?? (typeof form.t === 'string' ? form.t : '');
    const verified = c.env.UNSUBSCRIBE_SECRET ? await verifyUnsubscribe(c.env.UNSUBSCRIBE_SECRET, token) : null;
    if (!verified) return c.html(page('This link is not valid', 'Check the email you received, or ask the sender to send it again.'), 400);
    const { email, orgId } = verified;
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT OR REPLACE INTO email_optouts (email, org_id, at) VALUES (?1, ?2, ?3)').bind(email, orgId, Date.now()),
      c.env.DB.prepare("DELETE FROM subscriptions WHERE email = ?1 AND target_kind = 'org' AND target_id = ?2").bind(email, orgId),
      c.env.DB.prepare(
        "DELETE FROM subscriptions WHERE email = ?1 AND target_kind = 'series' AND target_id IN (SELECT id FROM series WHERE org_id = ?2)",
      ).bind(email, orgId),
    ]);
    return c.html(page("You're unsubscribed", 'You will no longer receive email from this workspace.'));
  });

  /** A calendar subscription: upcoming public sessions of a workspace or series, as an .ics file. */
  app.get('/api/public/feeds/:file', async (c) => {
    const file = c.req.param('file');
    if (!file.endsWith('.ics')) return c.notFound();
    const token = file.slice(0, -4);
    const sub = await c.env.DB.prepare('SELECT target_kind, target_id FROM subscriptions WHERE token = ?')
      .bind(token).first<{ target_kind: string; target_id: string }>();
    if (!sub) return c.notFound();
    const scope = sub.target_kind === 'org' ? 'org_id' : 'series_id';
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, venue, starts_at, duration_min FROM events WHERE ${scope} = ? AND join_open = 1 AND starts_at >= ? ORDER BY starts_at LIMIT 200`,
    ).bind(sub.target_id, Date.now() - 86_400_000).all<{ id: string; name: string; venue: string; starts_at: number; duration_min: number }>();
    const origin = c.env.PUBLIC_URL ?? new URL(c.req.url).origin;
    const calendarName = sub.target_kind === 'org'
      ? (await c.env.DB.prepare('SELECT name FROM organizations WHERE id = ?').bind(sub.target_id).first<{ name: string }>())?.name
      : (await c.env.DB.prepare('SELECT name FROM series WHERE id = ?').bind(sub.target_id).first<{ name: string }>())?.name;
    const ics = icsCalendar(calendarName ?? 'Habitat', results.map((e) => ({
      uid: `${e.id}@habitat`, title: e.name, start: e.starts_at, durationMin: e.duration_min, location: e.venue, url: `${origin}/e/${e.id}/lobby`,
    })), Date.now());
    return new Response(ics, { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=900' } });
  });
}

/** An audience can only name sessions and series that belong to this workspace. */
async function parseAudience(env: Env, orgId: string, input: unknown): Promise<Audience> {
  const a = input as { kind?: unknown; eventId?: unknown; seriesId?: unknown } | undefined;
  if (!a || typeof a !== 'object') throw new Error('Choose who receives this');
  if (a.kind === 'subscribers') return { kind: 'subscribers' };
  if (a.kind === 'event' && typeof a.eventId === 'string') {
    const row = await env.DB.prepare('SELECT org_id FROM events WHERE id = ?').bind(a.eventId).first<{ org_id: string }>();
    if (!row || row.org_id !== orgId) throw new Error('That session is not in this workspace');
    return { kind: 'event', eventId: a.eventId };
  }
  if (a.kind === 'series' && typeof a.seriesId === 'string') {
    const row = await env.DB.prepare('SELECT id FROM series WHERE id = ? AND org_id = ?').bind(a.seriesId, orgId).first();
    if (!row) throw new Error('That series is not in this workspace');
    return { kind: 'series', seriesId: a.seriesId };
  }
  throw new Error('Choose who receives this: subscribers, a session roster, or a series');
}

function campaignJson(r: CampaignRow) {
  return {
    id: r.id, kind: r.kind, subject: r.subject, body: r.body, audience: JSON.parse(r.audience) as Audience,
    status: r.status, total: r.total, sent: r.sent, failed: r.failed, createdBy: r.created_by, createdAt: r.created_at, sentAt: r.sent_at,
  };
}

function confirmPage(token: string): string {
  return page('Unsubscribe from this workspace?', 'You will stop receiving email from this workspace.',
    `<form method="post" action="/api/public/unsubscribe?t=${encodeURIComponent(token)}"><button type="submit" style="font:inherit;padding:10px 16px;border-radius:6px;border:0;background:#1d232b;color:#fff;cursor:pointer">Unsubscribe</button></form>`);
}

function page(title: string, detail: string, extra = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#1d232b"><h1 style="font-size:22px">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>${extra}</body></html>`;
}
