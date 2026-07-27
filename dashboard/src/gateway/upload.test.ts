import { afterEach, describe, expect, it, vi } from 'vitest';

import { uploadFileToWorkspace } from './upload';

function mockFetch(impl: (url: string, init: RequestInit) => { ok: boolean; status: number; json: unknown }) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const { ok, status, json } = impl(url, init);
    return { ok, status, json: async () => json } as unknown as Response;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadFileToWorkspace', () => {
  const file = new File([new Uint8Array([1, 2, 3])], 'paper.pdf', { type: 'application/pdf' });

  it('POSTs multipart to /rc/upload and returns the file descriptor', async () => {
    const fetchSpy = mockFetch(() => ({
      ok: true,
      status: 200,
      json: { ok: true, file: { name: 'paper.pdf', path: 'uploads/paper.pdf', type: 'file', size: 3, mime_type: 'application/pdf', modified_at: '', git_status: '' } },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await uploadFileToWorkspace(file, 'uploads');
    expect(result.path).toBe('uploads/paper.pdf');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/rc/upload');
    expect((init as RequestInit).method).toBe('POST');
    const body = (init as RequestInit).body as FormData;
    expect(body.get('destination')).toBe('uploads');
    expect((body.get('file') as File).name).toBe('paper.pdf');
  });

  it('applies fileNameOverride to the uploaded payload', async () => {
    const fetchSpy = mockFetch(() => ({
      ok: true,
      status: 200,
      json: { ok: true, file: { name: '123-paper.pdf', path: 'uploads/123-paper.pdf', type: 'file', size: 3, mime_type: 'application/pdf', modified_at: '', git_status: '' } },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await uploadFileToWorkspace(file, 'uploads', '123-paper.pdf');
    const body = (fetchSpy.mock.calls[0][1] as RequestInit).body as FormData;
    expect((body.get('file') as File).name).toBe('123-paper.pdf');
  });

  it('serializes onConflict into the FormData when provided', async () => {
    const fetchSpy = mockFetch(() => ({
      ok: true,
      status: 200,
      json: { ok: true, file: { name: 'paper (2).pdf', path: 'sources/paper (2).pdf', type: 'file', size: 3, mime_type: 'application/pdf', modified_at: '', git_status: '', renamed: true } },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await uploadFileToWorkspace(file, 'sources', undefined, 'rename');
    expect(result.renamed).toBe(true);
    const body = (fetchSpy.mock.calls[0][1] as RequestInit).body as FormData;
    expect(body.get('onConflict')).toBe('rename');
  });

  it('omits onConflict from the FormData by default (fail-closed on the gateway)', async () => {
    const fetchSpy = mockFetch(() => ({
      ok: true,
      status: 200,
      json: { ok: true, file: { name: 'paper.pdf', path: 'sources/paper.pdf', type: 'file', size: 3, mime_type: 'application/pdf', modified_at: '', git_status: '' } },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await uploadFileToWorkspace(file, 'sources');
    const body = (fetchSpy.mock.calls[0][1] as RequestInit).body as FormData;
    expect(body.get('onConflict')).toBeNull();
  });

  it('surfaces 409 UPLOAD_FILE_EXISTS as an UploadError', async () => {
    const fetchSpy = mockFetch(() => ({
      ok: false,
      status: 409,
      json: { ok: false, error: { code: 'UPLOAD_FILE_EXISTS', message: 'Already exists: sources/paper.pdf' } },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(uploadFileToWorkspace(file, 'sources')).rejects.toMatchObject({
      code: 'UPLOAD_FILE_EXISTS',
      status: 409,
    });
  });

  it('throws an UploadError carrying status/code on non-2xx', async () => {
    const fetchSpy = mockFetch(() => ({
      ok: false,
      status: 413,
      json: { ok: false, error: { code: 'too_large', message: 'File too large' } },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(uploadFileToWorkspace(file, 'uploads')).rejects.toMatchObject({
      message: 'File too large',
      code: 'too_large',
      status: 413,
    });
  });

  it('throws when the body reports ok:false even with 200', async () => {
    const fetchSpy = mockFetch(() => ({ ok: true, status: 200, json: { ok: false } }));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(uploadFileToWorkspace(file, 'uploads')).rejects.toThrow();
  });
});
