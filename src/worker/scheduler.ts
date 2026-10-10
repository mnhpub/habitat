import type { Env } from './env';
import { materializeSeries, type SeriesRow } from './series';
import { processCampaign } from './campaigns';

/**
 * Cron: create sessions for active series, and keep sending campaigns that were still in progress.
 * Each step is isolated so one bad series or campaign cannot stop the others.
 */
export async function runScheduled(env: Env, now = Date.now()): Promise<void> {
  const series = await env.DB.prepare('SELECT * FROM series WHERE active = 1 LIMIT 200').all<SeriesRow>();
  for (const row of series.results) {
    try {
      await materializeSeries(env, row, now);
    } catch (err) {
      console.error('Series scheduling failed', row.id, err);
    }
  }
  const sending = await env.DB.prepare("SELECT id FROM campaigns WHERE status = 'sending' LIMIT 20").all<{ id: string }>();
  for (const { id } of sending.results) {
    try {
      await processCampaign(env, id);
    } catch (err) {
      console.error('Campaign send failed', id, err);
    }
  }
}
