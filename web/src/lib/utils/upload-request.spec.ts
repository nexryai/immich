import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortError, cancelUploadRequests, uploadRequest } from '$lib/utils';

describe('upload request lifecycle', () => {
  class Request extends EventTarget {
    static current: Request;
    upload = new EventTarget();
    open = vi.fn();
    send = vi.fn();
    setRequestHeader = vi.fn();
    readyState = 4;
    status = 200;
    response = { ok: true };

    constructor() {
      super();
      Request.current = this;
    }

    abort() {
      this.dispatchEvent(new Event('abort'));
    }
  }

  beforeEach(() => vi.stubGlobal('XMLHttpRequest', Request));
  afterEach(() => {
    cancelUploadRequests();
    vi.unstubAllGlobals();
  });

  it('rejects when logout cancels the current request', async () => {
    const uploading = uploadRequest({ url: '/api/assets', data: new FormData() });
    const assertion = expect(uploading).rejects.toBeInstanceOf(AbortError);
    cancelUploadRequests();
    await assertion;
  });

  it('rejects an already-cancelled request without sending data', async () => {
    await expect(uploadRequest({ url: '/api/assets', signal: AbortSignal.abort() })).rejects.toBeInstanceOf(AbortError);
    expect(Request.current.send).not.toHaveBeenCalled();
  });

  it('uses the supplied abort signal and removes its listener after success', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const uploading = uploadRequest({
      url: '/api/uploads/chunked/id',
      method: 'PUT',
      data: new Blob(['bytes']),
      headers: { 'Content-Type': 'application/octet-stream' },
      signal: controller.signal,
    });
    expect(Request.current.open).toHaveBeenCalledWith('PUT', '/api/uploads/chunked/id');
    expect(Request.current.setRequestHeader).toHaveBeenCalledWith('Content-Type', 'application/octet-stream');
    Request.current.dispatchEvent(new Event('load'));
    expect(await uploading).toEqual({ status: 200, data: { ok: true } });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
  });

  it('rejects timeouts so the transport can retry', async () => {
    const uploading = uploadRequest({ url: '/api/uploads/chunked/id', timeout: 10 });
    const assertion = expect(uploading).rejects.toMatchObject({ statusCode: 408 });
    Request.current.dispatchEvent(new Event('timeout'));
    await assertion;
  });
});
