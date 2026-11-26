/**
 * Agent file-transfer caps — the single source of truth for the WEB layer.
 *
 * The authoritative values live in the Go agent
 * (`agent/internal/remote/tools/fileops.go`). These mirrors exist because the
 * browser needs to know the caps *before* it issues a request: the file
 * listing already carries each entry's size, so the File Browser can refuse an
 * over-cap download up front instead of spending a round trip to learn the
 * answer from the device.
 *
 * Both directions are pinned from Go so a one-sided edit fails CI:
 *   - read  → `TestMaxFileReadSizeMatchesSharedConstant` (agent/internal/remote/tools/limits_test.go),
 *             which parses THIS file's `AGENT_MAX_FILE_READ_BYTES` declaration.
 *   - write → `TestMaxMessageSizeCoversLargestLegitimateFrame` (agent/internal/websocket/limits_test.go),
 *             mirrored API-side by `AGENT_MAX_FILE_WRITE_BYTES` in
 *             `apps/api/src/routes/systemTools/schemas.ts`.
 *
 * Note the asymmetry is real, not a typo: the agent reads at most 1 MB but
 * accepts writes up to 4 MB. Raising the read cap is NOT a one-line change —
 * a file_read result is base64'd inline into `stdout`, which the API bounds at
 * `MAX_COMMAND_RESULT_BYTES` (5,000,000) in
 * `apps/api/src/routes/agents/schemas.ts`. 1 MB decoded is ~1.4 MB encoded and
 * fits; anything past ~3.6 MB decoded does not, and the agent's SendResult
 * sheds only the `result` field on overflow, never `stdout`. Larger files use
 * the chunked path below instead of a bigger single-shot cap.
 */

/**
 * Largest file the agent will read for a `file_read` command
 * (`maxFileReadSize` in agent/internal/remote/tools/fileops.go). Over this the
 * agent fails the command with `file too large: <size> bytes (max <cap> bytes)`.
 */
export const AGENT_MAX_FILE_READ_BYTES = 1024 * 1024;

/**
 * Largest decoded file_write payload the agent accepts in ONE command
 * (`MaxFileWriteSize` in fileops.go; the API mirrors it as
 * `AGENT_MAX_FILE_WRITE_BYTES` in apps/api/src/routes/systemTools/schemas.ts).
 * The File Browser uploads files up to this size single-shot, which every
 * agent version supports, and switches to the chunked path above it.
 */
export const AGENT_SINGLE_SHOT_WRITE_BYTES = 4 * 1024 * 1024;

/**
 * Chunked transfer (`file_write_chunk` / `file_read_chunk`,
 * agent/internal/remote/tools/fileops_chunked.go): the largest file the File
 * Browser moves in either direction, and the decoded size of each chunk.
 * Pinned from Go by `TestChunkedTransferConstantsMatchShared`.
 *
 * Agents that predate the chunked commands answer `unknown command type`; the
 * API turns that into a 409 `agent_update_required`, and the UI says to update
 * the agent. Files at or under the single-shot caps never take this path.
 */
export const AGENT_MAX_CHUNKED_TRANSFER_BYTES = 100 * 1024 * 1024;
export const AGENT_FILE_CHUNK_BYTES = 2 * 1024 * 1024;
