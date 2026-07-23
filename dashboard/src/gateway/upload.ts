/**
 * Shared HTTP upload helper for the workspace.
 *
 * The gateway exposes `POST /rc/upload` (multipart) which accepts any file,
 * sanitizes the path/filename, enforces a server-side size cap, and returns
 * the resulting workspace-relative path. Used by both the Workspace panel
 * (explicit upload) and the composer (external-file ingest → reference).
 */

export interface UploadedWorkspaceFile {
  name: string;
  path: string;
  type: 'file';
  size: number;
  mime_type: string;
  modified_at: string;
  git_status: string;
  /** True when the file replaced nothing (older gateways omit this). */
  is_new?: boolean;
  /** True when onConflict:'rename' produced a "name (2).ext" final name. */
  renamed?: boolean;
}

/** How the gateway resolves a name collision at the destination. */
export type UploadConflictMode = 'fail' | 'overwrite' | 'rename';

export interface UploadError extends Error {
  code?: string;
  status?: number;
}

/**
 * Upload a single file into the workspace under `destination`.
 *
 * @param fileNameOverride optional new filename (e.g. timestamp-prefixed) used
 *        to avoid collisions up front.
 * @param onConflict how the gateway resolves a duplicate name at the target:
 *        'fail' (default) → 409 UPLOAD_FILE_EXISTS, 'overwrite' → replace,
 *        'rename' → save as "name (2).ext" (response carries the final name).
 * @throws UploadError on non-2xx / `{ ok: false }` responses (code/status set).
 */
export async function uploadFileToWorkspace(
  file: File,
  destination: string,
  fileNameOverride?: string,
  onConflict?: UploadConflictMode,
): Promise<UploadedWorkspaceFile> {
  const payload = fileNameOverride
    ? new File([file], fileNameOverride, { type: file.type })
    : file;

  const formData = new FormData();
  formData.append('file', payload);
  formData.append('destination', destination);
  if (onConflict) {
    formData.append('onConflict', onConflict);
  }

  const token = new URLSearchParams(window.location.search).get('token') || 'research-claw';
  const res = await fetch('/rc/upload', {
    method: 'POST',
    body: formData,
    headers: { Authorization: `Bearer ${token}` },
  });

  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok || !(body as { ok?: boolean }).ok) {
    const errObj = (body as { error?: { message?: string; code?: string } }).error;
    const err = new Error(errObj?.message ?? `Upload failed (${res.status})`) as UploadError;
    err.code = errObj?.code;
    err.status = res.status;
    throw err;
  }

  return (body as { file: UploadedWorkspaceFile }).file;
}
