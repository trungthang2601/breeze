/**
 * File Browser reads (`file_read`, `file_read_chunk`) return the file's bytes
 * as base64 in the command result's stdout. `executeCommand` can only hand that
 * result to its caller by reading it back from `device_commands.result`, so it
 * has to be written there first — but once the caller has it, the stored copy
 * is dead weight: a 100MB chunked download would otherwise leave ~133MB of
 * base64 in the table forever, and the copy is tenant file content sitting in
 * command history.
 *
 * Two erasers, same SQL:
 *  - `eraseDeliveredCommandStdout` — called by commandQueue right after the
 *    waiting caller has read a terminal result. Best-effort: a failure here
 *    must never fail the transfer the user is waiting on.
 *  - `eraseStaleTransientStdout` — a stale-command-reaper domain that sweeps
 *    what the first one missed: a result that arrived after the caller timed
 *    out (the agent's late result is still accepted), a process that died
 *    between read and erase, and rows from before this existed.
 *
 * Erasure drops `stdout` and sets `stdoutErased: true`; status, exitCode,
 * error and timing survive for history and forensics.
 *
 * Note: stdout of these types is stored WITHOUT secret redaction
 * (commandAudit.isStdoutRedactionExempt) because redaction corrupts base64 of
 * binary files. Erasing it after delivery is what keeps that unredacted file
 * content out of long-lived storage.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { deviceCommands } from '../db/schema';
import { captureException } from './sentry';

/**
 * String literals (not CommandTypes) to stay import-cycle free with
 * commandQueue, and because the sweep predicate below must be literal SQL to
 * match the partial index
 * (2027-01-22-233800-device-commands-file-read-stdout-idx.sql).
 */
export const TRANSIENT_STDOUT_COMMAND_TYPES: ReadonlySet<string> = new Set(['file_read', 'file_read_chunk']);

/** How long a delivered-or-orphaned result may keep its stdout before the sweep erases it. */
export const TRANSIENT_STDOUT_GRACE_MS = 10 * 60 * 1000;

/**
 * Rows per reaper cycle. Each row can hold ~2.8MB, so this bounds the rewrite
 * a single two-minute cycle does; a backlog drains over a few cycles.
 */
export const TRANSIENT_STDOUT_SWEEP_BATCH = 200;

export function isTransientStdoutCommandType(type: string): boolean {
  return TRANSIENT_STDOUT_COMMAND_TYPES.has(type);
}

// Literal, not bound: Postgres only uses a partial index when it can prove the
// query's predicate implies the index's, which needs constants. Module-owned
// values, no caller input.
const TRANSIENT_PREDICATE = sql.raw(
  "type IN ('file_read', 'file_read_chunk') AND result ? 'stdout'",
);

function erasedResult(): SQL {
  return sql`(${deviceCommands.result} - 'stdout'::text) || jsonb_build_object('stdoutErased', true)`;
}

/**
 * Erase the stored stdout of one command the caller has just read. Returns
 * whether a row was erased; never throws.
 */
export async function eraseDeliveredCommandStdout(commandId: string, type: string): Promise<boolean> {
  if (!isTransientStdoutCommandType(type)) return false;
  try {
    const rows = await withSystemDbAccessContext(
      () =>
        db
          .update(deviceCommands)
          .set({ result: erasedResult() })
          .where(and(
            eq(deviceCommands.id, commandId),
            sql`jsonb_typeof(${deviceCommands.result}) = 'object'`,
            TRANSIENT_PREDICATE,
          ))
          .returning({ id: deviceCommands.id }),
      'transientCommandResult.eraseDelivered',
    );
    return rows.length > 0;
  } catch (err) {
    // The sweep will retry it; the transfer itself already succeeded.
    console.error('[TransientCommandResult] Failed to erase delivered stdout', { commandId, type, err });
    captureException(err instanceof Error ? err : new Error(String(err)));
    return false;
  }
}

/**
 * Stale-command-reaper domain: erase stdout from terminal file-read rows older
 * than the grace period. Runs inside the reaper's system context.
 */
export async function eraseStaleTransientStdout(): Promise<number> {
  const cutoff = new Date(Date.now() - TRANSIENT_STDOUT_GRACE_MS);
  const rows = await db
    .update(deviceCommands)
    .set({ result: erasedResult() })
    .where(sql`${deviceCommands.id} IN (
      SELECT id FROM device_commands
      WHERE ${TRANSIENT_PREDICATE}
        AND completed_at < ${cutoff}
        AND jsonb_typeof(result) = 'object'
      ORDER BY completed_at
      LIMIT ${TRANSIENT_STDOUT_SWEEP_BATCH}
    )`)
    .returning({ id: deviceCommands.id });
  return rows.length;
}
