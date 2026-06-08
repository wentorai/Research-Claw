import type { Session } from '../stores/sessions';
import {
  paperReviewCronSessionMatchesRun,
  type PaperReviewCronSessionRow,
} from './paper-review-run';

type GatewayRequest = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** Remove ephemeral cron chat sessions after a paper review finishes (success or failure). */
export async function cleanupPaperReviewCronSessions(
  request: GatewayRequest,
  reviewId: string,
  fileName: string,
): Promise<number> {
  let removed = 0;
  try {
    const result = await request('sessions.list', { limit: 1000 }) as { sessions?: Session[] };
    const sessions = result.sessions ?? [];
    for (const session of sessions) {
      const row: PaperReviewCronSessionRow = session;
      if (!paperReviewCronSessionMatchesRun(row, reviewId, fileName)) continue;
      try {
        await request('sessions.delete', { key: session.key, deleteTranscript: true });
        removed += 1;
      } catch {
        // Session may already be gone.
      }
    }
  } catch {
    // Non-fatal — sidebar filter still hides rc-review rows.
  }
  return removed;
}
