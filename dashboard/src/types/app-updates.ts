/** Payload from gateway `rc.app.check_updates`. */
export interface CheckUpdatesPayload {
  current: string;
  latest: string | null;
  latestTag: string | null;
  upToDate: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  repoRoot: string;
  shellUpdateHint: string;
  error?: string;
}
