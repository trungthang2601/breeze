import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  withSystemDbAccessContextMock,
  dbExecuteMock,
  captureExceptionMock,
  recordRetentionRunMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>, _label?: string) => fn()),
  dbExecuteMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  recordRetentionRunMock: vi.fn(),
  capturedWorkerProcessor: { current: null as null | ((job: { data: Record<string, unknown> }) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => addMock(...(args as []));
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...(args as []));
    close = () => queueCloseMock();
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: Record<string, unknown> }) => Promise<unknown>) {
      capturedWorkerProcessor.current = processor;
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: {
    execute: (...args: unknown[]) => dbExecuteMock(...(args as [])),
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>, label?: string) => withSystemDbAccessContextMock(fn, label),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
  captureMessage: vi.fn(),
}));

vi.mock('../services/retentionMetrics', () => ({
  recordRetentionRun: (...args: unknown[]) => recordRetentionRunMock(...(args as [])),
}));

import {
  __testOnly,
  agentHealthPrunePredicate,
  createObservationRetentionWorker,
  initializeObservationRetention,
  shutdownObservationRetention,
  softwareInventoryPrunePredicate,
} from './observationRetention';

const dialect = new PgDialect();
function toQuery(call: unknown[]) {
  return dialect.sqlToQuery(call[0] as SQL);
}

describe('observation retention worker', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    getRepeatableJobsMock.mockResolvedValue([]);
    removeRepeatableByKeyMock.mockResolvedValue(undefined);
    addMock.mockResolvedValue(undefined);
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    dbExecuteMock.mockResolvedValue({ rowCount: 0 });
    capturedWorkerProcessor.current = null;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await shutdownObservationRetention();
  });

  it('defaults both windows to 30 days', () => {
    expect(__testOnly.DEFAULT_AGENT_HEALTH_DAYS).toBe(30);
    expect(__testOnly.DEFAULT_SOFTWARE_INVENTORY_DAYS).toBe(30);
  });

  it('registers one daily repeatable job carrying both windows and the batch bounds', async () => {
    await initializeObservationRetention();

    expect(addMock).toHaveBeenCalledWith(
      'cleanup',
      {
        agentHealthDays: __testOnly.DEFAULT_AGENT_HEALTH_DAYS,
        softwareInventoryDays: __testOnly.DEFAULT_SOFTWARE_INVENTORY_DAYS,
        batchSize: __testOnly.BATCH_SIZE,
        maxBatches: __testOnly.MAX_BATCHES,
      },
      expect.objectContaining({ repeat: { pattern: '33 8 * * *' } }),
    );
  });

  it('prunes agent health first, then software inventory, each in bounded batches', async () => {
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 3 }) // health batch 1 (full)
      .mockResolvedValueOnce({ rowCount: 1 }) // health batch 2 (short -> done)
      .mockResolvedValueOnce({ rowCount: 2 }); // inventory batch 1 (short -> done)
    createObservationRetentionWorker();

    const result = await capturedWorkerProcessor.current!({
      data: { agentHealthDays: 30, softwareInventoryDays: 60, batchSize: 3, maxBatches: 5 },
    });

    expect(dbExecuteMock).toHaveBeenCalledTimes(3);
    expect(toQuery(dbExecuteMock.mock.calls[0]!).sql).toContain('DELETE FROM agent_health_observations');
    expect(toQuery(dbExecuteMock.mock.calls[2]!).sql).toContain('DELETE FROM software_inventory_observations');
    expect(withSystemDbAccessContextMock.mock.calls.map((c) => c[1])).toEqual([
      'observationRetention.agentHealth',
      'observationRetention.agentHealth',
      'observationRetention.softwareInventory',
    ]);
    expect(result).toMatchObject({
      agentHealth: { deleted: 4, batches: 2, hasMore: false, retentionDays: 30 },
      softwareInventory: { deleted: 2, batches: 1, hasMore: false, retentionDays: 60 },
    });
    expect(recordRetentionRunMock).toHaveBeenCalledWith('agent_health_observation_retention', { rowsDeleted: 4, incomplete: false });
    expect(recordRetentionRunMock).toHaveBeenCalledWith('software_inventory_observation_retention', { rowsDeleted: 2, incomplete: false });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('uses a cutoff N days in the PAST for each table', async () => {
    createObservationRetentionWorker();
    const before = Date.now();

    await capturedWorkerProcessor.current!({
      data: { agentHealthDays: 10, softwareInventoryDays: 45, batchSize: 5, maxBatches: 1 },
    });

    const ages = dbExecuteMock.mock.calls.map((call) => {
      const iso = toQuery(call).params.find((p) => typeof p === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(p)) as string;
      return (before - new Date(iso).getTime()) / 86_400_000;
    });
    expect(ages[0]).toBeGreaterThan(9.9);
    expect(ages[0]).toBeLessThan(10.1);
    expect(ages[1]).toBeGreaterThan(44.9);
    expect(ages[1]).toBeLessThan(45.1);
  });

  it('falls back to the defaults when the payload asks for zero retention or omits it', async () => {
    createObservationRetentionWorker();

    const result = await capturedWorkerProcessor.current!({ data: { agentHealthDays: 0 } });

    expect(result).toMatchObject({
      agentHealth: { retentionDays: __testOnly.DEFAULT_AGENT_HEALTH_DAYS },
      softwareInventory: { retentionDays: __testOnly.DEFAULT_SOFTWARE_INVENTORY_DAYS },
    });
    expect(toQuery(dbExecuteMock.mock.calls[0]!).params).toContain(__testOnly.BATCH_SIZE);
  });

  it('reports a backlog when a table hits maxBatches', async () => {
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 0 });
    createObservationRetentionWorker();

    const result = await capturedWorkerProcessor.current!({
      data: { agentHealthDays: 30, softwareInventoryDays: 30, batchSize: 2, maxBatches: 1 },
    });

    expect(result).toMatchObject({ agentHealth: { hasMore: true }, softwareInventory: { hasMore: false } });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain('agent_health_observations');
  });
});

describe('prune predicates keep every observation that current state references', () => {
  it('agent health: never deletes a device\'s current health row', () => {
    const { sql } = dialect.sqlToQuery(agentHealthPrunePredicate('2026-01-01T00:00:00.000Z'));
    expect(sql).toContain('received_at <');
    expect(sql).toMatch(/NOT EXISTS[\s\S]*device_agent_health_latest[\s\S]*observation_id = agent_health_observations\.id/);
  });

  it('software inventory: keeps state pointers, inventory lineage and resolution proofs', () => {
    const { sql } = dialect.sqlToQuery(softwareInventoryPrunePredicate('2026-01-01T00:00:00.000Z'));
    expect(sql).toContain('received_at <');
    for (const ref of [
      'latest_observation_id = software_inventory_observations.id',
      'latest_accepted_observation_id = software_inventory_observations.id',
      'visible_observation_id = software_inventory_observations.id',
      'si.observation_id = software_inventory_observations.id',
      'dv.resolved_observation_id = software_inventory_observations.id',
    ]) {
      expect(sql).toContain(ref);
    }
    expect(sql.match(/NOT EXISTS/g)).toHaveLength(3);
  });
});
