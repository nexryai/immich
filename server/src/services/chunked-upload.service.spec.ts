import { BadRequestException, ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import request from 'supertest';
import { ChunkedUploadController } from 'src/controllers/chunked-upload.controller.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { ChunkedUploadCreateDto } from 'src/dtos/chunked-upload.dto.js';
import { AssetVisibility } from 'src/enum.js';
import {
  CHUNKED_UPLOAD_CHUNK_SIZE,
  CHUNKED_UPLOAD_TTL,
  ChunkedUploadRepository,
} from 'src/repositories/chunked-upload.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { ChunkedUploadService } from 'src/services/chunked-upload.service.js';
import { factory } from 'test/small.factory.js';
import { type ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

describe(ChunkedUploadService.name, () => {
  let folder: string;
  let repository: ChunkedUploadRepository;
  let service: ChunkedUploadService;
  let ctx: ControllerContext;
  const media = mockBaseService(AssetMediaService);
  const auth = factory.auth();
  const contents = Buffer.from('chunked upload contents');
  const body = {
    filename: 'photo.jpg',
    fileCreatedAt: new Date().toISOString(),
    fileModifiedAt: new Date().toISOString(),
    size: contents.length,
    checksum: createHash('sha1').update(contents).digest('hex'),
    visibility: AssetVisibility.Locked,
    isFavorite: false,
  };
  const create = (overrides = {}) =>
    service.create(auth, ChunkedUploadCreateDto.schema.parse({ ...body, ...overrides }));

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'immich-chunked-'));
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(folder);
    // Exercise real filesystem persistence; emulate only PostgreSQL's lock primitive.
    repository = new ChunkedUploadRepository(undefined!);
    const locks = new Set<string>();
    vi.spyOn(repository, 'withLock').mockImplementation(async (key, callback) => {
      if (locks.has(key)) {
        throw new ConflictException();
      }
      locks.add(key);
      try {
        return await callback();
      } finally {
        locks.delete(key);
      }
    });
    media.resetAllMocks();
    media.canUploadFile.mockReturnValue(true);
    media.getUploadFolder.mockImplementation(({ file }) => {
      const destination = join(folder, 'originals', file.uuid);
      mkdirSync(destination, { recursive: true });
      return destination;
    });
    media.getUploadFilename.mockReturnValue('original.jpg');
    media.uploadAsset.mockResolvedValue({ id: factory.uuid(), status: AssetMediaStatus.CREATED });
    service = new ChunkedUploadService(repository, media, automock(LoggingRepository, { strict: false }));
    ctx = await controllerSetup(ChunkedUploadController, [{ provide: ChunkedUploadService, useValue: service }]);
    ctx.authenticate.mockResolvedValue(auth);
  });

  afterEach(async () => {
    await ctx.close();
    vi.restoreAllMocks();
    await rm(folder, { recursive: true, force: true });
  });

  it('streams chunks through HTTP and registers the original with the upstream service', async () => {
    const http = ctx.getHttpServer();
    const { body: session } = await request(http).post('/uploads/chunked').send(body).expect(201);
    await request(http)
      .put(`/uploads/chunked/${session.id}?offset=0`)
      .set('Content-Type', 'application/octet-stream')
      .send(contents)
      .expect(200);
    const first = await request(http).post(`/uploads/chunked/${session.id}/complete`).expect(200);
    const retry = await request(http).post(`/uploads/chunked/${session.id}/complete`).expect(200);
    expect(retry.body).toEqual(first.body);
    expect(media.uploadAsset).toHaveBeenCalledOnce();
    const [, dto, file] = media.uploadAsset.mock.calls[0];
    expect(dto).toMatchObject({ visibility: AssetVisibility.Locked, fileCreatedAt: new Date(body.fileCreatedAt) });
    expect(file.checksum.toString('hex')).toBe(body.checksum);
    expect(await readFile(file.originalPath)).toEqual(contents);
    await request(http).delete(`/uploads/chunked/${session.id}`).expect(204);
    expect(await readFile(file.originalPath)).toEqual(contents);
  });

  it('persists offsets across service instances and accepts the final short chunk', async () => {
    const data = Buffer.alloc(CHUNKED_UPLOAD_CHUNK_SIZE + 3, 42);
    const session = await create({ size: data.length, checksum: undefined });
    await service.write(auth, session.id, 0, Readable.from([data.subarray(0, CHUNKED_UPLOAD_CHUNK_SIZE)]));
    const restarted = new ChunkedUploadService(repository, media, automock(LoggingRepository, { strict: false }));
    expect(await restarted.get(auth, session.id)).toMatchObject({ offset: CHUNKED_UPLOAD_CHUNK_SIZE });
    await restarted.write(auth, session.id, CHUNKED_UPLOAD_CHUNK_SIZE, Readable.from([data.subarray(-3)]));
    await restarted.complete(auth, session.id);
    const uploaded = await readFile(media.uploadAsset.mock.calls[0][2].originalPath);
    expect(uploaded.length).toBe(data.length);
    expect(createHash('sha1').update(uploaded).digest('hex')).toBe(createHash('sha1').update(data).digest('hex'));
  });

  it('rejects replayed offsets and incomplete completion without changing data', async () => {
    const session = await create();
    await expect(service.complete(auth, session.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.write(auth, session.id, 1, Readable.from([contents]))).rejects.toBeInstanceOf(
      ConflictException,
    );
    await service.write(auth, session.id, 0, Readable.from([contents]));
    await expect(service.write(auth, session.id, 0, Readable.from([contents]))).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await service.get(auth, session.id)).toMatchObject({ offset: contents.length });
  });

  it('discards short, oversized, and interrupted chunks and permits retry', async () => {
    const session = await create();
    await expect(service.write(auth, session.id, 0, Readable.from([contents.subarray(1)]))).rejects.toThrow();
    await expect(
      service.write(auth, session.id, 0, Readable.from([Buffer.alloc(contents.length + 1)])),
    ).rejects.toThrow();
    const interrupted = Readable.from(
      (function* () {
        yield contents.subarray(0, 2);
        throw new Error('connection interrupted');
      })(),
    );
    await expect(service.write(auth, session.id, 0, interrupted)).rejects.toThrow('connection interrupted');
    expect(await service.get(auth, session.id)).toMatchObject({ offset: 0 });
    await service.write(auth, session.id, 0, Readable.from([contents]));
    await service.complete(auth, session.id);
    const entries = await readdir(join(folder, 'upload', '.chunks', auth.user.id, session.id));
    expect(entries.toSorted()).toEqual(['data', 'session.json']);
  });

  it('verifies the complete checksum before registering an asset', async () => {
    const session = await create({ checksum: '0'.repeat(40) });
    await service.write(auth, session.id, 0, Readable.from([contents]));
    await expect(service.complete(auth, session.id)).rejects.toBeInstanceOf(BadRequestException);
    expect(media.uploadAsset).not.toHaveBeenCalled();
  });

  it('isolates users and shared links, even links belonging to the same owner', async () => {
    const session = await create();
    await expect(service.get(factory.auth(), session.id)).rejects.toBeInstanceOf(NotFoundException);
    const shared = factory.auth({ user: auth.user, sharedLink: { allowUpload: true } });
    await expect(service.get(shared, session.id)).rejects.toBeInstanceOf(NotFoundException);
    const sharedSession = await service.create(shared, ChunkedUploadCreateDto.schema.parse(body));
    await service.write(shared, sharedSession.id, 0, Readable.from([contents]));
    await service.complete(shared, sharedSession.id);
    expect(media.uploadAsset.mock.calls[0][0]).toEqual(shared);
    await expect(service.get(auth, sharedSession.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.create({ ...shared, sharedLink: { ...shared.sharedLink!, allowUpload: false } }, body as never),
    ).rejects.toThrow();
  });

  it('reserves quota for unfinished sessions and limits their number', async () => {
    const limited = { ...auth, user: { ...auth.user, quotaSizeInBytes: contents.length, quotaUsageInBytes: 0 } };
    await service.create(limited, ChunkedUploadCreateDto.schema.parse(body));
    await expect(service.create(limited, ChunkedUploadCreateDto.schema.parse(body))).rejects.toThrow('Quota');
    for (let i = 1; i < 10; i++) {
      await create();
    }
    await expect(create()).rejects.toThrow('Too many unfinished uploads');
  });

  it('expires abandoned sessions and cleans up their files', async () => {
    const first = await create();
    const second = await create();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + CHUNKED_UPLOAD_TTL + 1);
    await expect(service.get(auth, first.id)).rejects.toBeInstanceOf(GoneException);
    await repository.cleanup();
    await expect(service.get(auth, second.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects concurrent writes and cancellation while a request owns the session', async () => {
    const session = await create();
    const input = new Readable({ read() {} });
    const writing = service.write(auth, session.id, 0, input);
    await vi.waitFor(() => expect(input.listenerCount('data')).toBeGreaterThan(0));
    await expect(service.remove(auth, session.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.write(auth, session.id, 0, Readable.from([contents]))).rejects.toBeInstanceOf(
      ConflictException,
    );
    input.push(contents);
    input.push(null);
    await writing;
  });

  it('validates session creation, offsets, UUIDs, and chunk content types', async () => {
    const http = ctx.getHttpServer();
    for (const invalid of [{ size: 0 }, { filename: '' }, { checksum: 'invalid' }, { fileCreatedAt: 'invalid' }]) {
      await request(http)
        .post('/uploads/chunked')
        .send({ ...body, ...invalid })
        .expect(400);
    }
    const session = await create();
    await request(http).put(`/uploads/chunked/${session.id}?offset=-1`).expect(400);
    await request(http).get('/uploads/chunked/invalid').expect(400);
    await request(http).put(`/uploads/chunked/${session.id}?offset=0`).send({ data: 'no' }).expect(415);
  });
});
