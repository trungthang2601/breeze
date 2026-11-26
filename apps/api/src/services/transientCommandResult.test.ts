import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const { updateMock, withSystemMock, captureExceptionMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  withSystemMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  captureExceptionMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { update: updateMock },
  withSystemDbAccessContext: withSystemMock,
}));

vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));

import {
  TRANSIENT_STDOUT_SWEEP_BATCH,
  eraseDeliveredCommandStdout,
  eraseStaleTransientStdout,
  isTransientStdoutCommandType,
} from './transientCommandResult';

function updateChain(returned: Array<{ id: string }>) {
  const chain = {
    set: vi.fn(() => chain),
    where: vi.fn(() => chain),
    returning: vi.fn(async () => returned),
  };
  updateMock.mockReturnValueOnce(chain);
  return chain;
}

function compile(fragment: unknown) {
  return new PgDialect().sqlToQuery(fragment as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  withSystemMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
});

describe('isTransientStdoutCommandType', () => {
  it('covers exactly the File Browser reads', () => {
    expect(isTransientStdoutCommandType('file_read')).toBe(true);
    expect(isTransientStdoutCommandType('file_read_chunk')).toBe(true);
    expect(isTransientStdoutCommandType('file_write_chunk')).toBe(false);
    expect(isTransientStdoutCommandType('script')).toBe(false);
  });
});

describe('eraseDeliveredCommandStdout', () => {
  it('does nothing for other command types', async () => {
    expect(await eraseDeliveredCommandStdout('cmd-1', 'script')).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('drops stdout from the one delivered row, in a system context', async () => {
    const chain = updateChain([{ id: 'cmd-1' }]);

    expect(await eraseDeliveredCommandStdout('cmd-1', 'file_read_chunk')).toBe(true);

    expect(withSystemMock).toHaveBeenCalledTimes(1);
    const setArg = (chain.set.mock.calls[0] as unknown as [{ result: unknown }])[0];
    const setSql = compile(setArg.result).sql;
    expect(setSql).toContain("- 'stdout'::text");
    expect(setSql).toContain("jsonb_build_object('stdoutErased', true)");
    const where = compile((chain.where.mock.calls[0] as unknown[])[0]);
    expect(where.params).toContain('cmd-1');
    expect(where.sql).toContain("type IN ('file_read', 'file_read_chunk') AND result ? 'stdout'");
  });

  it('never throws — a failed erase must not fail the transfer', async () => {
    withSystemMock.mockRejectedValueOnce(new Error('db down'));

    expect(await eraseDeliveredCommandStdout('cmd-1', 'file_read')).toBe(false);
    expect(captureExceptionMock).toHaveBeenCalled();
  });
});

describe('eraseStaleTransientStdout', () => {
  it('erases a bounded batch of old file-read rows using the partial-index predicate', async () => {
    const chain = updateChain([{ id: 'a' }, { id: 'b' }]);

    expect(await eraseStaleTransientStdout()).toBe(2);

    const where = compile((chain.where.mock.calls[0] as unknown[])[0]);
    // Literal (not bound) so Postgres can match the partial index.
    expect(where.sql).toContain("type IN ('file_read', 'file_read_chunk') AND result ? 'stdout'");
    expect(where.sql).toContain('completed_at <');
    expect(where.sql).toContain('LIMIT');
    expect(where.params).toContain(TRANSIENT_STDOUT_SWEEP_BATCH);
    const cutoff = where.params.find((p) => p instanceof Date || typeof p === 'string' && /^\d{4}-/.test(p));
    expect(cutoff).toBeDefined();
  });
});
