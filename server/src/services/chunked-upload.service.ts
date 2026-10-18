import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { UploadRequest } from 'src/types.js';
import { OnEvent } from 'src/decorators.js';
import { UploadFieldName } from 'src/dtos/asset-media.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ChunkedUploadCreateDto } from 'src/dtos/chunked-upload.dto.js';
import { ImmichWorker } from 'src/enum.js';
import {
  CHUNKED_UPLOAD_CHUNK_SIZE,
  CHUNKED_UPLOAD_TTL,
  ChunkedUploadRepository,
  type ChunkedUploadSession,
} from 'src/repositories/chunked-upload.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { requireUploadAccess } from 'src/utils/access.js';

@Injectable()
export class ChunkedUploadService {
  private cleanupInterval?: NodeJS.Timeout;

  constructor(
    private repository: ChunkedUploadRepository,
    private assetMediaService: AssetMediaService,
    private logger: LoggingRepository,
  ) {}

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Api] })
  onBootstrap() {
    const cleanup = () => this.repository.cleanup().catch((error: Error) => this.logger.error(error));
    this.cleanupInterval = setInterval(() => void cleanup(), 60 * 60 * 1000).unref();
    return cleanup();
  }

  @OnEvent({ name: 'AppShutdown', workers: [ImmichWorker.Api] })
  onShutdown() {
    clearInterval(this.cleanupInterval);
  }

  async create(auth: AuthDto, dto: ChunkedUploadCreateDto) {
    requireUploadAccess(auth);
    this.assetMediaService.canUploadFile(this.asUploadRequest(auth, dto, randomUUID()));

    return this.repository.withLock(`${auth.user.id}/create`, async () => {
      const allSessions = await this.repository.list(auth.user.id);
      const sessions = allSessions.filter((session) => !session.response && session.expiresAt > Date.now());
      if (sessions.length >= 10) {
        throw new BadRequestException('Too many unfinished uploads');
      }
      const reserved = sessions.reduce((sum, session) => sum + session.dto.size, 0);
      const { quotaSizeInBytes, quotaUsageInBytes } = auth.user;
      if (quotaSizeInBytes !== null && dto.size + reserved + quotaUsageInBytes > quotaSizeInBytes) {
        throw new BadRequestException('Quota has been exceeded!');
      }

      const session: ChunkedUploadSession = {
        id: randomUUID(),
        userId: auth.user.id,
        sharedLinkId: auth.sharedLink?.id ?? null,
        dto,
        offset: 0,
        expiresAt: Date.now() + CHUNKED_UPLOAD_TTL,
      };
      await this.repository.create(session);
      return this.status(session);
    });
  }

  get(auth: AuthDto, id: string) {
    requireUploadAccess(auth);
    return this.repository.withSession(auth, id, (session) => Promise.resolve(this.status(session)));
  }

  write(auth: AuthDto, id: string, offset: number, input: Readable) {
    requireUploadAccess(auth);
    return this.repository.withSession(auth, id, async (session) => {
      if (session.response || offset !== session.offset || offset >= session.dto.size) {
        throw new ConflictException('Upload offset does not match; query session status before retrying');
      }
      await this.repository.writeChunk(session, input, Math.min(CHUNKED_UPLOAD_CHUNK_SIZE, session.dto.size - offset));
      return this.status(session);
    });
  }

  complete(auth: AuthDto, id: string) {
    requireUploadAccess(auth);
    return this.repository.withSession(auth, id, async (session) => {
      if (session.response) {
        return session.response;
      }
      if (session.offset !== session.dto.size) {
        throw new ConflictException('Upload is incomplete');
      }
      const checksum = await this.repository.checksum(session);
      if (session.dto.checksum && checksum.toString('hex') !== session.dto.checksum.toLowerCase()) {
        throw new BadRequestException('Upload checksum does not match');
      }

      // Re-parse dates serialized in session.json and apply upstream validation.
      const dto = ChunkedUploadCreateDto.schema.parse(session.dto);
      const request = this.asUploadRequest(auth, dto, randomUUID());
      this.assetMediaService.canUploadFile(request);
      const originalPath = join(
        this.assetMediaService.getUploadFolder(request),
        this.assetMediaService.getUploadFilename(request),
      );
      await this.repository.link(session, originalPath);
      session.response = await this.assetMediaService.uploadAsset(auth, dto, {
        uuid: request.file.uuid,
        originalPath,
        originalName: dto.filename,
        size: dto.size,
        checksum,
      });
      await this.repository.save(session);
      return session.response;
    });
  }

  remove(auth: AuthDto, id: string) {
    requireUploadAccess(auth);
    return this.repository.withSession(auth, id, (session) => this.repository.remove(session));
  }

  private status(session: ChunkedUploadSession) {
    return { id: session.id, offset: session.offset, chunkSize: CHUNKED_UPLOAD_CHUNK_SIZE };
  }

  private asUploadRequest(auth: AuthDto, body: ChunkedUploadCreateDto, uuid: string): UploadRequest {
    return {
      auth,
      body: { ...body },
      fieldName: UploadFieldName.ASSET_DATA,
      file: { uuid, originalName: body.filename, originalPath: '', size: body.size, checksum: Buffer.alloc(0) },
    };
  }
}
