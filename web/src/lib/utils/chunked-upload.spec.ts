import { AssetMediaStatus, AssetVisibility } from '@immich/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as utils from '$lib/utils';
import { CHUNKED_UPLOAD_THRESHOLD, uploadInChunks } from '$lib/utils/chunked-upload';

describe('chunked upload transport', () => {
  const file = new File([new Uint8Array(CHUNKED_UPLOAD_THRESHOLD + 7)], 'video.mp4', { lastModified: 123_456 });
  const result = { id: 'asset-id', status: AssetMediaStatus.Created };
  let offset = 0;
  let signal: AbortSignal | undefined;
  const progress = vi.fn();
  const request = vi.spyOn(utils, 'uploadRequest');

  beforeEach(() => {
    offset = 0;
    signal = undefined;
    progress.mockReset();
    request.mockReset();
    vi.spyOn(utils, 'sleep').mockResolvedValue(undefined);
    request.mockImplementation((options) => {
      const url = new URL(options.url, 'http://localhost');
      signal = options.signal ?? signal;
      let data: unknown;
      switch (options.method) {
        case 'GET': {
          data = url.pathname.endsWith('/chunked')
            ? { version: 1, chunkSize: CHUNKED_UPLOAD_THRESHOLD }
            : { id: 'session-id', offset, chunkSize: CHUNKED_UPLOAD_THRESHOLD };
          break;
        }
        case 'PUT': {
          expect(Number(url.searchParams.get('offset'))).toBe(offset);
          const blob = options.data as Blob;
          offset += blob.size;
          options.onUploadProgress?.(
            new ProgressEvent('progress', {
              loaded: blob.size,
              total: blob.size,
            }) as ProgressEvent<XMLHttpRequestEventTarget>,
          );
          data = { id: 'session-id', offset, chunkSize: CHUNKED_UPLOAD_THRESHOLD };
          break;
        }
        case 'DELETE': {
          data = undefined;
          break;
        }
        default: {
          data = url.pathname.endsWith('/complete')
            ? result
            : { id: 'session-id', offset: 0, chunkSize: CHUNKED_UPLOAD_THRESHOLD };
        }
      }
      return Promise.resolve({ data: data as never, status: 200 });
    });
  });

  const upload = () =>
    uploadInChunks({
      file,
      query: 'key=shared-key&slug=shared-slug',
      checksum: 'a'.repeat(40),
      visibility: AssetVisibility.Locked,
      onProgress: progress,
    });

  it('keeps small files on the existing multipart upload path', async () => {
    expect(
      await uploadInChunks({ file: new File(['small'], 'small.jpg'), query: '', onProgress: progress }),
    ).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('slices large files, preserves metadata and shared-link credentials, and reports whole-file progress', async () => {
    expect(await upload()).toEqual(result);
    const calls = request.mock.calls.map(([options]) => options);
    const chunks = calls.filter((options) => options.method === 'PUT');
    expect(chunks.map((options) => (options.data as Blob).size)).toEqual([CHUNKED_UPLOAD_THRESHOLD, 7]);
    expect(chunks.every((options) => options.headers?.['Content-Type'] === 'application/octet-stream')).toBe(true);
    const creation = calls.find((options) => !options.method && !options.url.includes('/complete'))!;
    expect(JSON.parse(creation.data as string)).toEqual({
      filename: file.name,
      size: file.size,
      fileCreatedAt: new Date(file.lastModified).toISOString(),
      fileModifiedAt: new Date(file.lastModified).toISOString(),
      isFavorite: false,
      visibility: AssetVisibility.Locked,
      checksum: 'a'.repeat(40),
    });
    for (const options of calls) {
      const url = new URL(options.url, 'http://localhost');
      expect(url.searchParams.get('key')).toBe('shared-key');
      expect(url.searchParams.get('slug')).toBe('shared-slug');
    }
    expect(progress).toHaveBeenLastCalledWith(file.size, file.size);
    expect(calls.at(-1)?.method).toBe('DELETE');
  });

  it.each([404, 405, 501])('allows legacy fallback when discovery explicitly returns %i', async (status) => {
    request.mockRejectedValue(new utils.ApiError('Unsupported', status, ''));
    expect(await upload()).toBeUndefined();
    expect(request.mock.calls.every(([options]) => options.method === 'GET')).toBe(true);
  });

  it.each([401, 403, 413, 503])('propagates discovery error %i without falling back', async (status) => {
    request.mockRejectedValue(new utils.ApiError('Request failed', status, ''));
    await expect(upload()).rejects.toMatchObject({ statusCode: status });
    expect(request.mock.calls.every(([options]) => options.method === 'GET')).toBe(true);
  });

  it('rejects invalid protocol capabilities before starting a session', async () => {
    request.mockResolvedValueOnce({ status: 200, data: { version: 1, chunkSize: 0 } });
    await expect(upload()).rejects.toThrow('Unsupported chunked upload protocol');
    expect(request).toHaveBeenCalledOnce();
  });

  it('recovers when the server committed a chunk but its response was lost', async () => {
    const normal = request.getMockImplementation()!;
    let interrupted = false;
    request.mockImplementation(async (options) => {
      const response = await normal(options);
      if (options.method === 'PUT' && !interrupted) {
        interrupted = true;
        throw new TypeError('Connection closed before acknowledgement');
      }
      return response;
    });
    expect(await upload()).toEqual(result);
    expect(request.mock.calls.filter(([options]) => options.method === 'PUT')).toHaveLength(2);
  });

  it('retries an interrupted chunk from the last confirmed offset', async () => {
    const normal = request.getMockImplementation()!;
    let interrupted = false;
    request.mockImplementation((options) => {
      if (options.method === 'PUT' && !interrupted) {
        interrupted = true;
        return Promise.reject(new TypeError('Connection lost'));
      }
      return normal(options);
    });
    expect(await upload()).toEqual(result);
    const offsets = request.mock.calls
      .filter(([options]) => options.method === 'PUT')
      .map(([options]) => new URL(options.url, 'http://localhost').searchParams.get('offset'));
    expect(offsets).toEqual(['0', '0', String(CHUNKED_UPLOAD_THRESHOLD)]);
  });

  it('cleans up failed sessions without retrying a permanent error', async () => {
    const normal = request.getMockImplementation()!;
    request.mockImplementation((options) =>
      options.method === 'PUT' ? Promise.reject(new utils.ApiError('Request too large', 413, '')) : normal(options),
    );
    await expect(upload()).rejects.toMatchObject({ statusCode: 413 });
    expect(request.mock.calls.filter(([options]) => options.method === 'PUT')).toHaveLength(1);
    expect(request.mock.calls.at(-1)?.[0].method).toBe('DELETE');
    expect(request.mock.calls.some(([options]) => options.url.includes('/complete'))).toBe(false);
  });

  it('retries completion safely after a transient failure', async () => {
    const normal = request.getMockImplementation()!;
    let attempts = 0;
    request.mockImplementation((options) => {
      if (options.url.includes('/complete') && attempts++ === 0) {
        return Promise.reject(new TypeError('Response lost'));
      }
      return normal(options);
    });
    expect(await upload()).toEqual(result);
    expect(attempts).toBe(2);
  });

  it('stops all pending upload work on logout', async () => {
    const normal = request.getMockImplementation()!;
    request.mockImplementation(async (options) => {
      const response = await normal(options);
      if (options.method === 'PUT') {
        utils.cancelUploadRequests();
        throw new utils.AbortError();
      }
      return response;
    });
    await expect(upload()).rejects.toBeInstanceOf(utils.AbortError);
    expect(signal?.aborted).toBe(true);
    expect(request.mock.calls.some(([options]) => options.url.includes('/complete'))).toBe(false);
  });
});
