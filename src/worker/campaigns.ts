import type { Env } from './env';
import { MailUnavailable, sendMail } from './mail';
import { signUnsubscribe } from './tokens';
import { roomFor } from './events-db';
import type { SeriesRow } from './series';

export type Audience =
  | { kind: 'subscribers' }
  | { kind: 'event'; eventId: string }
  | { kind: 'series'; seriesId: string }
  | { kind: 'notice'; seriesId: string };

export const MAX_RECIPIENTS = 5000;
const MAX_ATTEMPTS = 3;

export interface CampaignRow {
  id: string;
  org_id: string;
  kind: 'campaign' | 'notice';
  subject: string;
  body: string;
  audience: string;
  status: 'draft' | 'sending' | 'sent';
  total: number;
  sent: number;
  failed: number;
  created_by: string;
  created_at: number;
  sent_at: number | null;
}

/** Who should receive a campaign, before opt-outs are applied. Event audiences use the registered roster. */
export async function audienceEmails(env: Env, orgId: string, audience: Audience): Promise<string[]> {
  const emails = new Set<string>();
  const add = (rows: { email: string }[]) => rows.forEach((r) => emails.add(r.email));
  if (audience.kind === 'subscribers' || audience.kind === 'notice') {
    add((await env.DB.prepare("SELECT email FROM subscriptions WHERE target_kind = 'org' AND target_id = ?").bind(orgId).all<{ email: string }>()).results);
  }
  if (audience.kind === 'series' || audience.kind === 'notice') {
    add((await env.DB.prepare("SELECT email FROM subscriptions WHERE target_kind = 'series' AND target_id = ?").bind(audience.seriesId).all<{ email: string }>()).results);
  }
  if (audience.kind === 'event') {
    const event = await env.DB.prepare('SELECT org_id FROM events WHERE id = ?').bind(audience.eventId).first<{ org_id: string }>();
    if (!event || event.org_id !== orgId) throw new Error('That event is not in this workspace');
    for (const email of await roomFor(env, audience.eventId).rosterEmails()) emails.add(email);
  }
  return [...emails].map((e) => e.toLowerCase());
}

/** Create the recipient list for a campaign. Opted-out people are recorded as suppressed, not dropped silently. */
export async function prepareRecipients(env: Env, campaignId: string, orgId: string, audience: Audience): Promise<number> {
  const emails = await audienceEmails(env, orgId, audience);
  if (emails.length > MAX_RECIPIENTS) throw new Error(`An audience can have up to ${MAX_RECIPIENTS.toLocaleString('en-US')} people`);
  const optedOut = new Set((await env.DB.prepare('SELECT email FROM email_optouts WHERE org_id = ?').bind(orgId).all<{ email: string }>()).results.map((r) => r.email));
  const statements = emails.map((email) => env.DB.prepare(
    'INSERT OR IGNORE INTO campaign_recipients (campaign_id, email, status) VALUES (?1, ?2, ?3)',
  ).bind(campaignId, email, optedOut.has(email) ? 'suppressed' : 'pending'));
  for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
  await env.DB.prepare('UPDATE campaigns SET status = ?1, total = ?2 WHERE id = ?3')
    .bind('sending', emails.length, campaignId).run();
  return emails.length;
}

/** Send pending recipients of one campaign. Failed sends are retried by later runs, up to a limit. */
export async function processCampaign(env: Env, campaignId: string, batch = 200): Promise<void> {
  const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(campaignId).first<CampaignRow>();
  if (!campaign || campaign.status !== 'sending') return;
  const pending = await env.DB.prepare(
    "SELECT email FROM campaign_recipients WHERE campaign_id = ?1 AND status = 'pending' AND attempts < ?2 LIMIT ?3",
  ).bind(campaignId, MAX_ATTEMPTS, batch).all<{ email: string }>();

  if (pending.results.length) {
    if (!env.UNSUBSCRIBE_SECRET || !env.PUBLIC_URL) throw new MailUnavailable('UNSUBSCRIBE_SECRET and PUBLIC_URL must be set before sending.');
    for (const { email } of pending.results) {
      const token = await signUnsubscribe(env.UNSUBSCRIBE_SECRET, email, campaign.org_id);
      const unsubscribeUrl = `${env.PUBLIC_URL}/api/public/unsubscribe?t=${token}`;
      try {
        await sendMail(env, { to: email, subject: campaign.subject, body: campaign.body, unsubscribeUrl });
        await env.DB.prepare("UPDATE campaign_recipients SET status = 'sent', attempts = attempts + 1, error = NULL WHERE campaign_id = ? AND email = ?")
          .bind(campaignId, email).run();
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 300) : 'Send failed';
        await env.DB.prepare(
          "UPDATE campaign_recipients SET attempts = attempts + 1, error = ?3, status = CASE WHEN attempts + 1 >= ?4 THEN 'failed' ELSE 'pending' END WHERE campaign_id = ?1 AND email = ?2",
        ).bind(campaignId, email, message, MAX_ATTEMPTS).run();
      }
    }
  }

  const counts = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ? GROUP BY status')
    .bind(campaignId).all<{ status: string; n: number }>();
  const by = Object.fromEntries(counts.results.map((r) => [r.status, r.n]));
  // Opted-out recipients are neither sent nor failed: total - sent - failed is the number skipped.
  const done = (by.pending ?? 0) === 0;
  await env.DB.prepare('UPDATE campaigns SET sent = ?1, failed = ?2, status = ?3, sent_at = CASE WHEN ?3 = ?4 THEN ?5 ELSE sent_at END WHERE id = ?6')
    .bind(by.sent ?? 0, by.failed ?? 0, done ? 'sent' : 'sending', 'sent', Date.now(), campaignId).run();
}

/** Tell subscribers about a session that was just scheduled in a series. */
export async function announce(env: Env, series: SeriesRow, eventId: string, startsAt: number): Promise<void> {
  const audience: Audience = { kind: 'notice', seriesId: series.id };
  // Most series have no followers; don't create an empty notice for every session.
  if (!(await audienceEmails(env, series.org_id, audience)).length) return;
  const when = new Date(startsAt).toLocaleString('en-US', { timeZone: series.timezone, dateStyle: 'full', timeStyle: 'short' });
  const id = crypto.randomUUID();
  const body = `${series.name} is scheduled for ${when}${series.venue ? ` at ${series.venue}` : ''}.\n\nOpen the session: ${env.PUBLIC_URL ?? ''}/e/${eventId}/lobby`;
  await env.DB.prepare(
    `INSERT INTO campaigns (id, org_id, kind, subject, body, audience, status, created_by, created_at)
     VALUES (?1, ?2, 'notice', ?3, ?4, ?5, 'draft', ?6, ?7)`,
  ).bind(id, series.org_id, `New session: ${series.name}`, body, JSON.stringify(audience), series.created_by, Date.now()).run();
  await prepareRecipients(env, id, series.org_id, audience);
}

/** Only organizers of an event may email its guest roster. Workspace admins are not enough. */
export async function isEventOrganizer(env: Env, email: string, eventId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT roles FROM members WHERE event_id = ? AND email = ?')
    .bind(eventId, email).first<{ roles: string }>();
  return !!row && (JSON.parse(row.roles) as string[]).includes('organizer');
}
