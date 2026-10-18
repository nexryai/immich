import { ConflictException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, readFile, readdir, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetMediaResponseDto } from 'src/dtos/asset-media-response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ChunkedUploadCreateDto } from 'src/dtos/chunked-upload.dto.js';
import { StorageFolder } from 'src/enum.js';
import { DB } from 'src/schema/index.js';

export const CHUNKED_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
export const CHUNKED_UPLOAD_TTL = 24 * 60 * 60 * 1000;

export type ChunkedUploadSession = {
  id: string;
  userId: string;
  sharedLinkId: string | null;
  dto: ChunkedUploadCreateDto;
  offset: number;
  expiresAt: number;
  response?: AssetMediaResponseDto;
};

@Injectable()
export class ChunkedUploadRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  // Transaction-scoped advisory locks are released even if an API worker crashes.
  // The namespace keeps these locks separate from upstream's integer lock IDs.
  async withLock<T>(key: string, callback: () => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (transaction) => {
      const { rows } = await sql<{ locked: boolean }>`
        SELECT pg_try_advisory_xact_lock(1129664588, hashtext(${key})) AS locked
      `.execute(transaction);
      if (!rows[0].locked) {
        throw new ConflictException('Upload is busy; retry the request');
      }
      return callback();
    });
  }

  async create(session: ChunkedUploadSession) {
    const folder = this.getFolder(session.userId, session.id);
    await mkdir(folder, { recursive: true });
    try {
      await writeFile(join(folder, 'data'), '', { flag: 'wx' });
      await this.save(session);
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    }
  }

  async read(userId: string, id: string): Promise<ChunkedUploadSession> {
    try {
      return JSON.parse(await readFile(join(this.getFolder(userId, id), 'session.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException('Upload session not found');
      }
      throw error;
    }
  }

  async withSession<T>(auth: AuthDto, id: string, callback: (session: ChunkedUploadSession) => Promise<T>) {
    return this.withLock(`${auth.user.id}/${id}`, async () => {
      const session = await this.read(auth.user.id, id);
      if (session.sharedLinkId !== (auth.sharedLink?.id ?? null)) {
        throw new NotFoundException('Upload session not found');
      }
      if (session.expiresAt <= Date.now()) {
        await this.remove(session);
        throw new GoneException('Upload session expired');
      }
      return callback(session);
    });
  }

  async save(session: ChunkedUploadSession) {
    const folder = this.getFolder(session.userId, session.id);
    const temporary = join(folder, 'session.json.pending');
    await writeFile(temporary, JSON.stringify(session), { flush: true });
    await rename(temporary, join(folder, 'session.json'));
  }

  async writeChunk(session: ChunkedUploadSession, input: Readable, length: number) {
    const folder = this.getFolder(session.userId, session.id);
    const temporary = join(folder, `chunk-${randomUUID()}`);
    let received = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        callback(received > length ? new ConflictException('Chunk exceeds expected length') : null, chunk);
      },
    });

    try {
      await pipeline(input, limit, createWriteStream(temporary, { flags: 'wx' }), {
        signal: AbortSignal.timeout(120_000),
      });
      if (received !== length) {
        throw new ConflictException('Chunk does not match expected length');
      }

      const data = join(folder, 'data');
      // Discard any bytes written before a worker stopped without committing its offset.
      await truncate(data, session.offset);
      await pipeline(
        createReadStream(temporary),
        createWriteStream(data, { flags: 'r+', start: session.offset, flush: true }),
      );
      session.offset += received;
      await this.save(session);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async checksum(session: ChunkedUploadSession) {
    const hash = createHash('sha1');
    await pipeline(createReadStream(join(this.getFolder(session.userId, session.id), 'data')), hash);
    return hash.digest();
  }

  link(session: ChunkedUploadSession, destination: string) {
    return link(join(this.getFolder(session.userId, session.id), 'data'), destination);
  }

  remove(session: ChunkedUploadSession) {
    return rm(this.getFolder(session.userId, session.id), { recursive: true, force: true });
  }

  async list(userId: string) {
    const sessions: ChunkedUploadSession[] = [];
    for (const id of await this.listDirectories(join(this.getRoot(), userId))) {
      try {
        sessions.push(await this.read(userId, id));
      } catch (error) {
        if (!(error instanceof NotFoundException)) {
          throw error;
        }
      }
    }
    return sessions;
  }

  async cleanup() {
    for (const userId of await this.listDirectories(this.getRoot())) {
      for (const session of await this.list(userId)) {
        if (session.expiresAt > Date.now()) {
          continue;
        }
        try {
          await this.withLock(`${userId}/${session.id}`, async () => {
            await this.remove(session);
          });
        } catch (error) {
          if (!(error instanceof ConflictException)) {
            throw error;
          }
        }
      }
    }
  }

  private getRoot() {
    return join(StorageCore.getBaseFolder(StorageFolder.Upload), '.chunks');
  }

  private getFolder(userId: string, id: string) {
    if (!/^[\da-f-]{36}$/i.test(id)) {
      throw new NotFoundException('Upload session not found');
    }
    return join(this.getRoot(), userId, id);
  }

  private async listDirectories(folder: string) {
    try {
      const entries = await readdir(folder, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}
