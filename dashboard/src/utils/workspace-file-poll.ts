/**
 * Poll workspace files without noisy rc.ws.read errors when the file is missing.
 * Falls back to rc.ws.read when rc.ws.exists is unavailable (older gateway build).
 */

type GatewayRequest = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export function isWorkspaceFileNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /file not found/i.test(msg) || /ENOENT/i.test(msg);
}

export function isUnknownGatewayMethodError(err: unknown, method: string): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /unknown method/i.test(msg) && msg.includes(method);
}

export async function readWorkspaceFileIfReady(
  request: GatewayRequest,
  path: string,
  minChars: number,
): Promise<string | null> {
  if (minChars > 0) {
    try {
      const exists = await request('rc.ws.exists', { path }) as { exists: boolean };
      if (!exists.exists) return null;
    } catch (err) {
      if (!isUnknownGatewayMethodError(err, 'rc.ws.exists') && !isWorkspaceFileNotFoundError(err)) {
        throw err;
      }
    }
  }

  try {
    const read = await request('rc.ws.read', { path }) as { content: string };
    const content = read.content?.trim() ?? '';
    if (content.length < minChars) return null;
    return content;
  } catch (err) {
    if (isWorkspaceFileNotFoundError(err)) return null;
    throw err;
  }
}

export async function workspaceFileMeetsMinChars(
  request: GatewayRequest,
  path: string,
  minChars: number,
): Promise<boolean> {
  const content = await readWorkspaceFileIfReady(request, path, minChars);
  return content != null;
}
