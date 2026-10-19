import { InvalidStateError } from './errors.js';
import type { BackupManifest } from './backup.js';

export type JobType = 'backup';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface Job {
  readonly id: string;
  readonly type: JobType;
  readonly status: JobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly manifest?: BackupManifest;
  readonly manifestPath?: string;
  readonly error?: string;
}

/** Job ids double as file names, so they are restricted to UUIDs. */
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidJobId(id: string): boolean {
  return JOB_ID_PATTERN.test(id);
}

export function newJob(id: string, type: JobType, now: Date): Job {
  const at = now.toISOString();
  return { id, type, status: 'queued', createdAt: at, updatedAt: at };
}

function transition(job: Job, from: JobStatus, to: JobStatus, now: Date, extra: Partial<Job> = {}): Job {
  if (job.status !== from) throw new InvalidStateError(`Job ${job.id} cannot move from ${job.status} to ${to}`);
  return { ...job, ...extra, status: to, updatedAt: now.toISOString() };
}

export function startJob(job: Job, now: Date): Job {
  return transition(job, 'queued', 'running', now);
}

export function completeJob(job: Job, result: { manifest: BackupManifest; manifestPath: string }, now: Date): Job {
  return transition(job, 'running', 'completed', now, result);
}

export function failJob(job: Job, error: string, now: Date): Job {
  if (job.status === 'completed' || job.status === 'failed') {
    throw new InvalidStateError(`Job ${job.id} is already ${job.status}`);
  }
  return { ...job, status: 'failed', error, updatedAt: now.toISOString() };
}
