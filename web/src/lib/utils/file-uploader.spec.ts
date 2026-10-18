import { AssetMediaStatus, type AssetMediaResponseDto, type UserAdminResponseDto } from '@immich/sdk';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { uploadManager } from '$lib/managers/upload-manager.svelte';
import { uploadAssetsStore } from '$lib/stores/upload';
import { UploadState } from '$lib/types';
import * as utils from '$lib/utils';
import * as chunkedUpload from '$lib/utils/chunked-upload';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { fileUploadHandler } from './file-uploader';

describe('fileUploader error handling', () => {
  const mockFile = new File(['content'], 'test.jpg', { type: 'image/jpeg' });
  const mockUserObject = { id: 'user-123', email: 'test@example.com' } as UserAdminResponseDto;
  const mockError = new Error('Upload failed');
  const mockUploadResponse = { id: 'mock-id', status: AssetMediaStatus.Created } as AssetMediaResponseDto;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(uploadManager, 'getExtensions').mockReturnValue(['.jpg']);
    uploadAssetsStore.reset();
    authManager.reset();
  });

  for (const [name, mockUser] of [
    ['logged-in users', true],
    ['anonymous users', false],
  ] as const) {
    describe(`for ${name}`, () => {
      beforeEach(() => {
        if (mockUser) {
          authManager.setUser(mockUserObject);
        }
      });

      it(`should transition successful uploads to done`, async () => {
        vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 200, data: mockUploadResponse });

        await fileUploadHandler({ files: [mockFile] });

        const items = get(uploadAssetsStore);
        expect(items.length).toBe(1);
        expect(items[0].state).toBe(UploadState.DONE);
      });

      it('should capture errors', async () => {
        vi.spyOn(utils, 'uploadRequest').mockRejectedValue(mockError);

        await fileUploadHandler({ files: [mockFile] });

        const items = get(uploadAssetsStore);
        expect(items.length).toBe(1);
        expect(items[0].state).toBe(UploadState.ERROR);
      });
    });
  }

  it('should suppress errors on logout', async () => {
    authManager.setUser(mockUserObject);
    authManager.setPreferences(preferencesFactory.build());
    vi.spyOn(utils, 'uploadRequest').mockImplementationOnce(() => {
      authManager.reset();
      return Promise.reject(mockError);
    });

    await fileUploadHandler({ files: [mockFile] });

    const items = get(uploadAssetsStore);
    expect(items.length).toBe(1);
    expect(items[0].state).toBe(UploadState.STARTED);
  });

  it.each(['', 'application/octet-stream', 'video/3gpp'])(
    'uploads uppercase SDV files using server extensions with MIME type "%s"',
    async (type) => {
      vi.mocked(uploadManager.getExtensions).mockRestore();
      const previous = uploadManager.mediaTypes;
      uploadManager.mediaTypes = { image: [], sidecar: [], video: ['.sdv'] };
      try {
        const file = new File(['legacy phone video'], 'MOVIE.SDV', { type });
        const upload = vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 201, data: mockUploadResponse });
        await fileUploadHandler({ files: [file] });
        expect(get(uploadAssetsStore)[0].state).toBe(UploadState.DONE);
        expect(upload).toHaveBeenCalledOnce();
        expect(upload.mock.calls[0][0].data).toBeInstanceOf(FormData);
        expect((upload.mock.calls[0][0].data as FormData).get('assetData')).toMatchObject({
          name: 'MOVIE.SDV',
          size: file.size,
        });
      } finally {
        uploadManager.mediaTypes = previous;
      }
    },
  );

  describe('chunked upload integration', () => {
    const largeFile = new File([new Uint8Array(chunkedUpload.CHUNKED_UPLOAD_THRESHOLD + 1)], 'large.jpg');

    afterEach(() => vi.mocked(chunkedUpload.uploadInChunks).mockRestore());

    it.each([
      [AssetMediaStatus.Created, UploadState.DONE],
      [AssetMediaStatus.Duplicate, UploadState.DUPLICATED],
    ])('reports %s through the existing UI state', async (status, state) => {
      vi.spyOn(chunkedUpload, 'uploadInChunks').mockResolvedValue({ ...mockUploadResponse, status });
      const legacy = vi.spyOn(utils, 'uploadRequest');
      await fileUploadHandler({ files: [largeFile], isLockedAssets: true });
      expect(get(uploadAssetsStore)[0].state).toBe(state);
      expect(legacy).not.toHaveBeenCalled();
      expect(chunkedUpload.uploadInChunks).toHaveBeenCalledWith(
        expect.objectContaining({ file: largeFile, visibility: 'locked' }),
      );
    });

    it('reports a failed chunked upload without starting a multipart upload', async () => {
      vi.spyOn(chunkedUpload, 'uploadInChunks').mockRejectedValue(mockError);
      const legacy = vi.spyOn(utils, 'uploadRequest');
      await fileUploadHandler({ files: [largeFile] });
      expect(get(uploadAssetsStore)[0].state).toBe(UploadState.ERROR);
      expect(legacy).not.toHaveBeenCalled();
    });
  });
});
