import { getBaseUrl, type AssetMediaResponseDto, type AssetVisibility } from '@immich/sdk';
import { AbortError, ApiError, sleep, trackUpload, uploadRequest } from '$lib/utils';

export const CHUNKED_UPLOAD_THRESHOLD = 8 * 1024 * 1024;

type UploadSession = { id: string; offset: number; chunkSize: number };
type UploadOptions = {
  file: File;
  query: string;
  checksum?: string;
  visibility?: AssetVisibility;
  onProgress: (loaded: number, total: number) => void;
};

const canRetry = (error: unknown) =>
  !(error instanceof AbortError) &&
  (!(error instanceof ApiError) || [408, 409, 429].includes(error.statusCode) || error.statusCode >= 500);

// Only explicit absence of the protocol permits a legacy upload fallback.
export const uploadInChunks = async ({ file, query, checksum, visibility, onProgress }: UploadOptions) => {
  if (file.size <= CHUNKED_UPLOAD_THRESHOLD) {
    return;
  }

  const controller = new AbortController();
  const untrack = trackUpload(() => controller.abort());
  const { signal } = controller;
  const base = `${getBaseUrl()}/uploads/chunked`;
  const url = (path = '', offset?: number) => {
    const params = new URLSearchParams(query);
    if (offset !== undefined) {
      params.set('offset', String(offset));
    }
    const search = params.toString();
    return `${base}${path}${search ? `?${search}` : ''}`;
  };
  const retry = async <T>(action: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) {
        throw new AbortError();
      }
      try {
        return await action();
      } catch (error) {
        if (!canRetry(error) || attempt >= 3) {
          throw error;
        }
        await sleep(250 * 2 ** attempt);
      }
    }
  };

  let sessionPath: string | undefined;
  try {
    let capability: { version: number; chunkSize: number };
    try {
      const response = await retry(() =>
        uploadRequest<typeof capability>({ url: url(), method: 'GET', signal, timeout: 30_000 }),
      );
      capability = response.data;
    } catch (error) {
      if (error instanceof ApiError && [404, 405, 501].includes(error.statusCode)) {
        return;
      }
      throw error;
    }
    if (
      capability?.version !== 1 ||
      !Number.isSafeInteger(capability.chunkSize) ||
      capability.chunkSize <= 0 ||
      capability.chunkSize > CHUNKED_UPLOAD_THRESHOLD
    ) {
      throw new Error('Unsupported chunked upload protocol');
    }

    const { data: session } = await uploadRequest<UploadSession>({
      url: url(),
      data: JSON.stringify({
        filename: file.name,
        size: file.size,
        fileCreatedAt: new Date(file.lastModified).toISOString(),
        fileModifiedAt: new Date(file.lastModified).toISOString(),
        isFavorite: false,
        visibility,
        checksum,
      }),
      headers: { 'Content-Type': 'application/json' },
      signal,
      timeout: 30_000,
    });
    if (!session?.id || session.offset !== 0 || session.chunkSize !== capability.chunkSize) {
      throw new Error('Invalid upload session');
    }
    sessionPath = `/${encodeURIComponent(session.id)}`;

    for (let offset = 0; offset < file.size;) {
      const end = Math.min(offset + session.chunkSize, file.size);
      await retry(async () => {
        // A previous request may have committed its chunk before its response was lost.
        const { data: state } = await uploadRequest<UploadSession>({
          url: url(sessionPath),
          method: 'GET',
          signal,
          timeout: 30_000,
        });
        if (state.offset === end) {
          return;
        }
        if (state.offset !== offset) {
          throw new Error('Unexpected upload offset');
        }
        const { data: updated } = await uploadRequest<UploadSession>({
          url: url(sessionPath, offset),
          method: 'PUT',
          data: file.slice(offset, end),
          headers: { 'Content-Type': 'application/octet-stream' },
          signal,
          timeout: 120_000,
          onUploadProgress: (event) => onProgress(Math.min(offset + event.loaded, file.size), file.size),
        });
        if (updated.offset !== end) {
          throw new Error('Unexpected upload offset');
        }
      });
      offset = end;
      onProgress(offset, file.size);
    }

    const response = await retry(() =>
      uploadRequest<AssetMediaResponseDto>({ url: url(`${sessionPath}/complete`), signal }),
    );
    return response.data;
  } finally {
    if (sessionPath) {
      await uploadRequest({ url: url(sessionPath), method: 'DELETE', timeout: 10_000 }).catch(() => undefined);
    }
    untrack();
  }
};
