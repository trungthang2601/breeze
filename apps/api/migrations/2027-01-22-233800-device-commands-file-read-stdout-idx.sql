-- @no-transaction
-- Sweep index for File Browser read results whose file bytes are still stored.
--
-- `file_read` / `file_read_chunk` results carry the file's contents as base64
-- in result->'stdout' (up to ~2.8MB per chunk row). The caller erases that
-- copy as soon as it has read the result, and the stale-command reaper's
-- `transientResults` domain sweeps whatever was missed (a result that arrived
-- after the caller timed out, a crash between read and erase, rows from before
-- this change) — see services/transientCommandResult.ts.
--
-- Partial on "still holds stdout", so the index only ever contains the rows
-- that sweep has yet to erase and stays near-empty in steady state; without it
-- the sweep would sequentially scan device_commands every two minutes.
--
-- No data change, no tenancy change: device_commands stays system-scoped (no
-- org_id column), so no RLS policy, cascade or export-policy entry applies.
--
-- CONCURRENTLY (autoMigrate's @no-transaction lane): device_commands is
-- written on the agent hot path, and a non-concurrent build would take a
-- SHARE lock and stall fleet-wide agent writes for the build's duration
-- (same reasoning as 2026-12-27-090000-device-commands-set-log-level-idx.sql).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_commands_file_read_stdout_completed
  ON device_commands (completed_at)
  WHERE type IN ('file_read', 'file_read_chunk') AND result ? 'stdout';
