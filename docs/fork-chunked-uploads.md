# Chunked uploads in this fork

The Web UI automatically uses chunked uploads for files larger than 8 MiB. Smaller files continue to use the upstream multipart upload. Official mobile applications, the CLI, and existing API integrations continue using the unchanged `POST /assets` endpoint. No mobile application update or database migration is required.

The Web client first discovers the fork protocol. Only HTTP 404, 405, or 501 during discovery permits fallback to the original upload. Authentication errors, size limits, and failed transfers surface as upload failures. The existing UI still handles hashing, duplicate notifications, locked asset visibility, album assignment, and progress.

## Deployment

Deploy this fork's server and Web UI together. API workers must share the same media/upload filesystem and PostgreSQL database. Temporary sessions are stored under `upload/.chunks/<user-id>/<session-id>` inside the configured media location. Session locks use PostgreSQL transaction advisory locks and are released automatically if a worker exits.

Allow `GET`, `POST`, `PUT`, and `DELETE` requests under `/api/uploads/chunked`. Configure the reverse proxy to allow request bodies of at least 8 MiB and allow the standard `application/octet-stream` content type. Each chunk has a two-minute server timeout. Disable proxy caching for this authenticated path. Finalization hashes the complete file on disk, so its response timeout should accommodate large files on your storage.

Each account may have ten unfinished sessions. Session creation checks available quota, including reservations for other unfinished sessions; final registration also runs the upstream quota check. Sessions expire 24 hours after creation. The server removes expired sessions at startup and hourly thereafter. Successful uploads and failed transfers request immediate session deletion; interrupted cleanup is handled by expiration. Finished session deletion removes temporary hard links and metadata, preserving registered originals.

Resumption covers transient connection failures during the current Web upload. A page reload or browser restart starts a new session. Session metadata and confirmed offsets survive API worker restarts. Clients retry each transient failure up to three times, query the saved offset, and avoid resending chunks whose acknowledgements were lost. Completion is idempotent while the session exists. A crash between asset registration and persisting the result is recovered by the upstream checksum duplicate handling.

## Private protocol, version 1

All routes require upstream authentication and `asset.upload` API key permission. Shared links must allow uploads and pass their normal key/slug credentials on every request. Sessions belong to one user and, if applicable, one shared link; another link belonging to the same user cannot access them. These fork-private endpoints are excluded from upstream-generated OpenAPI and mobile SDK files.

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /api/uploads/chunked` | None | `{ version: 1, chunkSize: 8388608 }` |
| `POST /api/uploads/chunked` | JSON: `filename`, positive integer `size`, ISO `fileCreatedAt` and `fileModifiedAt`; optional hexadecimal SHA-1 `checksum`, boolean `isFavorite`, `visibility` | HTTP 201: `{ id, offset: 0, chunkSize }` |
| `GET /api/uploads/chunked/:id` | None | `{ id, offset, chunkSize }` |
| `PUT /api/uploads/chunked/:id?offset=N` | Raw bytes, `Content-Type: application/octet-stream` | `{ id, offset, chunkSize }` with the new committed offset |
| `POST /api/uploads/chunked/:id/complete` | None | HTTP 200: upstream asset upload response, including created/duplicate status |
| `DELETE /api/uploads/chunked/:id` | None | HTTP 204 |

Chunks must match the advertised size, except the final chunk, which must match the remaining file length. Invalid offsets, concurrent operations, and incomplete finalization return HTTP 409. Expired sessions return HTTP 410 when accessed before cleanup, then HTTP 404. Partial or oversized chunks do not advance the committed offset. The server streams to a staging file, commits bytes and metadata, computes the final SHA-1, checks any supplied checksum, and passes the assembled file to the upstream asset upload service. Original filenames never determine session paths.

## Validation and upstream updates

The fork workflow `.github/workflows/fork-chunked-upload.yml` uses the repository token and needs no upstream organization secrets. It checks the server and Web types, upload regressions, and fork formatting/lint. The upstream workflows currently reference Immich organization secrets and may need separate configuration in a fork; inspect those failures independently.

Follow the upstream merge and commit/push/CI policy in the root `AGENTS.md`. For local verification, install with the committed lockfile, build `@immich/sdk` and `@immich/plugin-sdk`, and run:

```sh
pnpm --filter immich check
pnpm --filter immich exec vitest --config test/vitest.config.mjs --run
pnpm --filter immich-web check:typescript
pnpm --filter immich-web exec vitest run
```

Before deploying an upstream merge, exercise large Web uploads through the deployment's actual proxy and storage, shared-link uploads, and a normal mobile backup. Keep the original upload controller, DTOs, OpenAPI, and SDK behavior compatible.
