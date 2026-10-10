import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from './config.js';
import type { BackupManifest } from './types.js';
import { ensureDataDirs } from './security.js';

export interface Job { id: string; type: string; status: string; createdAt: string; updatedAt: string; manifest?: BackupManifest; error?: string; }
const file = (id: string) => path.join(paths.jobs, `${id}.json`);

export async function createJob(type: string): Promise<Job> { await ensureDataDirs(); const now = new Date().toISOString(); const job = { id: crypto.randomUUID(), type, status: 'queued', createdAt: now, updatedAt: now }; await saveJob(job); return job; }
export async function saveJob(job: Job) { await ensureDataDirs(); await fs.writeFile(file(job.id), JSON.stringify(job, null, 2), 'utf8'); }
export async function getJob(id: string): Promise<Job> { return JSON.parse(await fs.readFile(file(id), 'utf8')); }
