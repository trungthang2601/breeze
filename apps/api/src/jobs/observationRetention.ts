/**
 * Observation Retention Worker
 *
 * Daily prune of the two append-only evidence tables that had no retention at
 * all and grew without bound:
 *
 *   - agent_health_observations       (one row per agent health report)
 *   - software_inventory_observations (one row per inventory report, with the
 *                                      full item list as jsonb)
 *
 * Only the CURRENT observation of each device is read by the product: health
 * through device_agent_health_latest, inventory through
 * device_software_inventory_state (latest / latest accepted / visible), and the
 * row lineage through software_inventory.observation_id and
 * device_vulnerabilities.resolved_observation_id. A row past the window is
 * deleted only when none of those still points at it, so:
 *
 *   - a device that stopped reporting keeps its last health and inventory
 *     however old they are (the latest FK on device_agent_health_latest is
 *     ON DELETE CASCADE — deleting a pointed-to row would erase the device's
 *     current health);
 *   - the observation behind the current software_inventory rows and every
 *     vulnerability-resolution proof is kept (those FKs are ON DELETE SET NULL
 *     and would silently drop the lineage).
 *
 * The tables' immutability triggers guard UPDATE only; DELETE is granted to
 * breeze_app and allowed by the org-isolation DELETE policy (system scope here).
 *
 * Windows: AGENT_HEALTH_OBSERVATION_RETENTION_DAYS and
 * SOFTWARE_INVENTORY_OBSERVATION_RETENTION_DAYS (default 30, clamped to
 * 1..3650). Batch bounds: OBSERVATION_RETENTION_BATCH_SIZE /
 * OBSERVATION_RETENTION_MAX_BATCHES. Deleted rows free space for reuse inside
 * the table; returning it to the filesystem needs a one-off VACUUM FULL.
 */

import { Queue, Worker, Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { captureException } from '../services/sentry';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';
import {
  parsePositiveIntEnv,
  pruneInCtidBatches,
  resolveRetentionDays,
  warnOnRetentionBacklog,
} from './retentionBatch';

const LOG_PREFIX = '[ObservationRetention]';
const QUEUE_NAME = 'observation-retention';
const MAX_RETENTION_DAYS = 3650;
const DEFAULT_AGENT_HEALTH_DAYS = resolveRetentionDays(
  process.env.AGENT_HEALTH_OBSERVATION_RETENTION_DAYS, 30, MAX_RETENTION_DAYS, LOG_PREFIX,
);
const DEFAULT_SOFTWARE_INVENTORY_DAYS = resolveRetentionDays(
  process.env.SOFTWARE_INVENTORY_OBSERVATION_RETENTION_DAYS, 30, MAX_RETENTION_DAYS, LOG_PREFIX,
);
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'OBSERVATION_RETENTION_BATCH_SIZE', 5000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'OBSERVATION_RETENTION_MAX_BATCHES', 200);

const DAY_MS = 24 * 60 * 60 * 1000;

let retentionQueue: Queue | null = null;

export function getObservationRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, {
      connection: getBullMQConnection()
    });
  }
  return retentionQueue;
}

interface RetentionJobData {
  agentHealthDays?: number;
  softwareInventoryDays?: number;
  batchSize?: number;
  maxBatches?: number;
}

function cutoffIso(days: number): string {
  // postgres-js does not coerce JS Date in template-literal params; pass an ISO string.
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/** Old agent health rows that are not any device's current health. */
export function agentHealthPrunePredicate(cutoff: string) {
  return sql`received_at < ${cutoff}
    AND NOT EXISTS (
      SELECT 1 FROM device_agent_health_latest latest
      WHERE latest.observation_id = agent_health_observations.id
    )`;
}

/** Old inventory rows that no state pointer, inventory row or resolution proof references. */
export function softwareInventoryPrunePredicate(cutoff: string) {
  return sql`received_at < ${cutoff}
    AND NOT EXISTS (
      SELECT 1 FROM device_software_inventory_state st
      WHERE st.latest_observation_id = software_inventory_observations.id
         OR st.latest_accepted_observation_id = software_inventory_observations.id
         OR st.visible_observation_id = software_inventory_observations.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM software_inventory si
      WHERE si.observation_id = software_inventory_observations.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM device_vulnerabilities dv
      WHERE dv.resolved_observation_id = software_inventory_observations.id
    )`;
}

export function createObservationRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    // No context wrapper here: pruneInCtidBatches opens one per batch, so that
    // each batch commits and releases its locks (see retentionBatch.ts).
    async (job: Job<RetentionJobData>) => {
      const startTime = Date.now();
      const agentHealthDays = resolveRetentionDays(job.data.agentHealthDays, DEFAULT_AGENT_HEALTH_DAYS, MAX_RETENTION_DAYS);
      const softwareInventoryDays = resolveRetentionDays(
        job.data.softwareInventoryDays, DEFAULT_SOFTWARE_INVENTORY_DAYS, MAX_RETENTION_DAYS,
      );
      const batchSize = Math.max(1, job.data.batchSize ?? BATCH_SIZE);
      const maxBatches = Math.max(1, job.data.maxBatches ?? MAX_BATCHES);

      const health = await pruneInCtidBatches({
        table: 'agent_health_observations',
        where: agentHealthPrunePredicate(cutoffIso(agentHealthDays)),
        batchSize,
        maxBatches,
        label: 'observationRetention.agentHealth',
      });
      warnOnRetentionBacklog(LOG_PREFIX, 'agent_health_observations', health);
      recordRetentionRun('agent_health_observation_retention', {
        rowsDeleted: health.deleted,
        incomplete: health.hasMore,
      });

      const inventory = await pruneInCtidBatches({
        table: 'software_inventory_observations',
        where: softwareInventoryPrunePredicate(cutoffIso(softwareInventoryDays)),
        batchSize,
        maxBatches,
        label: 'observationRetention.softwareInventory',
      });
      warnOnRetentionBacklog(LOG_PREFIX, 'software_inventory_observations', inventory);
      recordRetentionRun('software_inventory_observation_retention', {
        rowsDeleted: inventory.deleted,
        incomplete: inventory.hasMore,
      });

      const durationMs = Date.now() - startTime;
      console.log(
        `${LOG_PREFIX} Pruned ${health.deleted} agent health observations older than ${agentHealthDays} days `
        + `(batches=${health.batches}) and ${inventory.deleted} software inventory observations older than `
        + `${softwareInventoryDays} days (batches=${inventory.batches}) in ${durationMs}ms`,
      );

      return {
        durationMs,
        agentHealth: { ...health, retentionDays: agentHealthDays },
        softwareInventory: { ...inventory, retentionDays: softwareInventoryDays },
      };
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1
    }
  );
}

let retentionWorker: Worker<RetentionJobData> | null = null;

export async function initializeObservationRetention(): Promise<void> {
  try {
    retentionWorker = createObservationRetentionWorker();
    attachWorkerObservability(retentionWorker, 'observationRetention');

    retentionWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });

    retentionWorker.on('failed', (job, err) => {
      console.error(`${LOG_PREFIX} job ${job?.id} failed:`, err);
      captureException(err);
    });

    const queue = getObservationRetentionQueue();

    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    await queue.add(
      'cleanup',
      {
        agentHealthDays: DEFAULT_AGENT_HEALTH_DAYS,
        softwareInventoryDays: DEFAULT_SOFTWARE_INVENTORY_DAYS,
        batchSize: BATCH_SIZE,
        maxBatches: MAX_BATCHES,
      },
      {
        // Daily at a registry-allocated slot (see jobs/scheduleRegistry.ts).
        repeat: { pattern: jobSchedule('observation-retention') },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 }
      }
    );

    console.log(`${LOG_PREFIX} Retention worker initialized`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownObservationRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}

export const __testOnly = {
  QUEUE_NAME,
  DEFAULT_AGENT_HEALTH_DAYS,
  DEFAULT_SOFTWARE_INVENTORY_DAYS,
  BATCH_SIZE,
  MAX_BATCHES,
};
