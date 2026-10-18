# Fork maintenance policy

## Compatibility and implementation

- This fork adds chunked uploads to the Immich Web UI. Preserve compatibility with the unmodified upstream mobile applications and API clients.
- Keep all existing API routes, request fields, response bodies, authentication rules, and status codes backward compatible. In particular, retain the existing multipart `POST /assets` upload unchanged.
- Implement chunked uploads through separate, authenticated, fork-specific endpoints and an isolated Web transport. Keep these private endpoints out of generated upstream SDKs and OpenAPI documents; do not require mobile changes.
- Reuse the existing asset upload service for final registration, including duplicate detection, quota checks, metadata extraction, shared-link association, and storage processing.
- Bound request sizes and memory use. Validate upload ownership, offsets, lengths, file types, and checksums. Handle retries, interrupted requests, concurrent workers, cancellation, and expiration of abandoned temporary files.
- Preserve Web upload progress, duplicate reporting, locked asset visibility, and album assignment. Fall back to the original upload only when the server explicitly lacks the chunked upload capability, before starting a session.
- Add focused regression tests for the new protocol and its Web integration, and continue running existing upload compatibility tests.
- Keep legacy `.sdv` phone videos registered as `video/3gpp` in the shared server format registry. Let Web clients discover the extension through the existing supported-media endpoint and reuse upstream video processing; preserve original files and the configured transcoding policy when tracking upstream changes.

## Tracking upstream

- Keep `origin` pointing to this fork and add `upstream` as `https://github.com/immich-app/immich.git` when needed.
- Fetch upstream tags and branches regularly. Inspect release notes and changes to upload controllers/services, authentication, storage, Web uploading, and CI before integrating an upstream release.
- Integrate a selected upstream release into a temporary integration branch using a merge, preserving published fork history. Resolve conflicts there, keeping fork changes in separate modules and minimizing edits to upstream files.
- Run the server and Web checks, the chunked upload regression suite, and legacy upload tests. Verify ordinary mobile multipart uploads and shared-link uploads before updating the deployed fork.
- Keep upstream-generated API/SDK files unchanged unless an upstream update requires regeneration. Review API changes for backward compatibility.
- Record deployment constraints and protocol changes in `docs/fork-chunked-uploads.md`. Review upstream support for chunked uploads periodically and retire fork-specific code when a compatible upstream implementation is available.

## Commits, pushes, and CI

- Work in small, reviewable increments and make frequent conventional Git commits: policy/documentation, server protocol, Web integration, and subsequent fixes should be independently understandable.
- Push each completed increment to the fork. Never force-push published history or include unrelated local changes.
- Inspect the CI runs for the pushed commit SHA. Follow failures to their logs, fix failures caused by the change, commit and push the fixes, and inspect the replacement runs.
- Provide fork-owned CI that runs without upstream organization secrets. Do not mistake a missing or skipped workflow for successful validation.
- Keep upstream-only container publishing and documentation deployment scoped to the upstream repository. Maintain independent fork validation; configure fork publication explicitly when needed.
- Publish only `ghcr.io/nexryai/immich-server:latest` from validated `main` revisions. Build native Linux amd64 and arm64 images and publish their combined manifest only when both builds succeed. Do not publish fork ML/CLI images, release tags, commit tags, or registry cache tags. Keep Docker build metadata pointing to this fork.
- Finish only after checking the final pushed revision, reporting the commit, CI results, and any checks that could not run with their concrete cause.
