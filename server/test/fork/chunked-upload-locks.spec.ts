import { ConflictException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { ChunkedUploadRepository } from 'src/repositories/chunked-upload.repository.js';
import { DB } from 'src/schema/index.js';

describe('chunked upload locks with PostgreSQL', () => {
  let database: Kysely<DB>;
  let first: ChunkedUploadRepository;
  let second: ChunkedUploadRepository;

  beforeAll(() => {
    const connectionString = process.env.FORK_TEST_DB_URL;
    if (!connectionString) {
      throw new Error('Set FORK_TEST_DB_URL to a disposable PostgreSQL database to run fork integration tests');
    }
    database = new Kysely<DB>({ dialect: new PostgresJSDialect({ postgres: postgres(connectionString, { max: 4 }) }) });
    first = new ChunkedUploadRepository(database);
    second = new ChunkedUploadRepository(database);
  });

  afterAll(() => database?.destroy());

  it('excludes another worker from the same session while allowing independent uploads', async () => {
    const key = randomUUID();
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ready = new Promise<void>((resolve) => (acquired = resolve));
    const pending = first.withLock(key, async () => {
      acquired();
      await gate;
    });
    await ready;
    try {
      await expect(second.withLock(key, () => Promise.resolve('conflicting'))).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(await second.withLock(randomUUID(), () => Promise.resolve('independent'))).toBe('independent');
    } finally {
      release();
      await pending;
    }
    expect(await second.withLock(key, () => Promise.resolve('released'))).toBe('released');
  });

  it('releases the session after a failed operation rolls back', async () => {
    const key = randomUUID();
    await expect(first.withLock(key, () => Promise.reject(new Error('interrupted operation')))).rejects.toThrow(
      'interrupted operation',
    );
    expect(await second.withLock(key, () => Promise.resolve('retry succeeds'))).toBe('retry succeeds');
  });
});
