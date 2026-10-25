# Chunked uploads in this fork

The Web UI automatically uses chunked uploads for files larger than 8 MiB. Smaller files continue to use the upstream multipart upload. Official mobile applications, the CLI, and existing API integrations continue using the unchanged `POST /assets` endpoint. No mobile application update or database migration is required.

The Web client first discovers the fork protocol. Only HTTP 404, 405, or 501 during discovery permits fallback to the original upload. Authentication errors, size limits, and failed transfers surface as upload failures. The existing UI still handles hashing, duplicate notifications, locked asset visibility, album assignment, and progress.

## Deployment

### Legacy SDV phone videos

This fork accepts `.sdv` (including uppercase `.SDV`) as `video/3gpp` for legacy phone recordings containing 3GPP-compatible video. The server advertises the extension to the Web file picker and drag-and-drop upload filter. Uploads also work when the browser reports an empty or generic MIME type. Both multipart and chunked uploads use the same server format registry; existing API schemas and mobile upload behavior remain compatible.

The original file is preserved. Metadata extraction, thumbnails, and playback conversion use the existing video processing jobs and FFmpeg settings. Keep video transcoding enabled (for example, the default policy) to convert older codecs such as H.263 for browser playback, and allow the queued jobs to finish. There is no need to rename files to `.3gp` or convert them before uploading. Reload the Web UI after deploying the updated server so it fetches the new extension list.

Validation includes server format/asset classification and upload acceptance tests, server extension discovery, and Web uploads of uppercase `.SDV` with empty, generic, and 3GPP MIME types. A generated 176x144 H.263/AAC 3GPP sample named `MOVIE.SDV` was also successfully probed and converted to H.264/AAC MP4 using the pinned production base image's FFmpeg. This synthetic sample does not verify every handset variant; malformed recordings or different formats sharing the extension still depend on FFmpeg's ability to read their contents.

### Server and proxy configuration

Deploy this fork's server and Web UI together. API workers must share the same media/upload filesystem and PostgreSQL database. Temporary sessions are stored under `upload/.chunks/<user-id>/<session-id>` inside the configured media location. Session locks use PostgreSQL transaction advisory locks and are released automatically if a worker exits.

Allow `GET`, `POST`, `PUT`, and `DELETE` requests under `/api/uploads/chunked`. Configure the reverse proxy to allow request bodies of at least 8 MiB and allow the standard `application/octet-stream` content type. Each chunk has a two-minute server timeout. Disable proxy caching for this authenticated path. Finalization hashes the complete file on disk, so its response timeout should accommodate large files on your storage.

Each account may have ten unfinished sessions. Session creation checks available quota, including reservations for other unfinished sessions; final registration also runs the upstream quota check. Sessions expire 24 hours after creation. The server removes expired sessions at startup and hourly thereafter. Successful uploads and failed transfers request immediate session deletion; interrupted cleanup is handled by expiration. Finished session deletion removes temporary hard links and metadata, preserving registered originals.

Resumption covers transient connection failures during the current Web upload. A page reload or browser restart starts a new session. Session metadata and confirmed offsets survive API worker restarts. Clients retry each transient failure up to three times, query the saved offset, and avoid resending chunks whose acknowledgements were lost. Completion is idempotent while the session exists. A crash between asset registration and persisting the result is recovered by the upstream checksum duplicate handling.

## Private protocol, version 1

All routes require upstream authentication and `asset.upload` API key permission. Shared links must allow uploads and pass their normal key/slug credentials on every request. Sessions belong to one user and, if applicable, one shared link; another link belonging to the same user cannot access them. These fork-private endpoints are excluded from upstream-generated OpenAPI and mobile SDK files.

| Method and path                          | Request                                                                                                                                                        | Response                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/uploads/chunked`               | None                                                                                                                                                           | `{ version: 1, chunkSize: 8388608 }`                                         |
| `POST /api/uploads/chunked`              | JSON: `filename`, positive integer `size`, ISO `fileCreatedAt` and `fileModifiedAt`; optional hexadecimal SHA-1 `checksum`, boolean `isFavorite`, `visibility` | HTTP 201: `{ id, offset: 0, chunkSize }`                                     |
| `GET /api/uploads/chunked/:id`           | None                                                                                                                                                           | `{ id, offset, chunkSize }`                                                  |
| `PUT /api/uploads/chunked/:id?offset=N`  | Raw bytes, `Content-Type: application/octet-stream`                                                                                                            | `{ id, offset, chunkSize }` with the new committed offset                    |
| `POST /api/uploads/chunked/:id/complete` | None                                                                                                                                                           | HTTP 200: upstream asset upload response, including created/duplicate status |
| `DELETE /api/uploads/chunked/:id`        | None                                                                                                                                                           | HTTP 204                                                                     |

Chunks must match the advertised size, except the final chunk, which must match the remaining file length. Invalid offsets, concurrent operations, and incomplete finalization return HTTP 409. Expired sessions return HTTP 410 when accessed before cleanup, then HTTP 404. Partial or oversized chunks do not advance the committed offset. The server streams to a staging file, commits bytes and metadata, computes the final SHA-1, checks any supplied checksum, and passes the assembled file to the upstream asset upload service. Original filenames never determine session paths.

## Validation and upstream updates

The fork workflow `.github/workflows/fork-chunked-upload.yml` uses the repository token and needs no upstream organization secrets. It checks server and Web types, all unit tests, concurrent-worker locking against PostgreSQL, production builds, unchanged upstream OpenAPI generation, and fork formatting/lint. Upstream container/CLI image publishing and documentation deployment run only in `immich-app/immich`. Other upstream validation workflows remain enabled.

After fork validation succeeds on a push to `main` or a manual run on `main`, native amd64 and arm64 runners build `server/Dockerfile` and push untagged manifests to the server package. Only after both builds succeed does the workflow update **`ghcr.io/nexryai/immich-server:latest`** with their combined manifest. This is the fork's only published container tag; no ML or CLI images or registry cache tags are published. Pull requests run validation without publishing. Builds use GitHub Actions cache storage, and image metadata links back to this fork and its exact source commit.

To deploy the published Web UI and server, set the server service's image to `ghcr.io/nexryai/immich-server:latest` in your Compose configuration, then pull and recreate that service. Continue using matching upstream database, Redis/Valkey, and machine-learning images. This fork's server and Web UI are packaged together.

Follow the upstream merge and commit/push/CI policy in the root `AGENTS.md`. For local verification, install with the committed lockfile, build `@immich/sdk` and `@immich/plugin-sdk`, and run:

```sh
pnpm --filter immich check
pnpm --filter immich exec vitest --config test/vitest.config.mjs --run
pnpm --filter immich-web check:typescript
pnpm --filter immich-web exec vitest run
```

Run the additional PostgreSQL integration suite with a disposable test database:

```sh
FORK_TEST_DB_URL=postgres://postgres:password@localhost:5432/postgres \
  pnpm --filter immich exec vitest --config test/vitest.config.fork.mjs --run
```

Before deploying an upstream merge, exercise large Web uploads through the deployment's actual proxy and storage, shared-link uploads, and a normal mobile backup. Keep fork-specific modifications compatible with the integrated upstream upload controller, DTOs, OpenAPI, and SDK. Upstream's own API changes are accepted as part of tracking upstream; this fork does not retain removed upstream APIs for older releases.

### Upstream integration: 2026-10-23

Merged upstream `main` at `1cf5bb41153478c180b65c6d93106fce5802b474`, including passkeys, upload permission checks, shared-link privacy fixes, storage symlink handling, and Web album query changes. The fork retains its private chunked upload protocol, SDV registration, and server-only `latest` publication. The upstream removal of the deprecated password field from `PUT /users/me` is accepted; clients should follow upstream's change-password endpoint. Fork CI reads the Node version from `.nvmrc` so it follows upstream toolchain updates.

### Upstream integration: 2026-10-25

Merged upstream `main` at `256eb55dbe92ac77e02794442f9487e88ffed2b1`, including Web API key/passkey/session query refactoring, more efficient recently-added timeline buckets, mobile JPEG XL decoding and request cancellation fixes, and machine-learning dependency updates. No fork upload, SDV, or publication changes were needed. The fork still publishes only the server `latest` image; upstream machine-learning changes do not add a fork ML image.
