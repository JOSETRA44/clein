import fs from 'node:fs/promises';
import path from 'node:path';
import { ValidationError } from '../../domain/errors.js';
import { isValidJobId, type Job } from '../../domain/job.js';
import type { JobRepository } from '../../application/ports.js';

/** One JSON file per job, written atomically (temp file + rename). */
export class FileJobRepository implements JobRepository {
  constructor(private readonly directory: string) {}

  private fileFor(id: string): string {
    // Ids become file names; rejecting anything but a UUID rules out path traversal.
    if (!isValidJobId(id)) throw new ValidationError(`Invalid job id: ${id}`);
    return path.join(this.directory, `${id}.json`);
  }

  async save(job: Job): Promise<void> {
    const file = this.fileFor(job.id);
    await fs.mkdir(this.directory, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(job, null, 2), 'utf8');
    await fs.rename(temp, file);
  }

  async find(id: string): Promise<Job | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.fileFor(id), 'utf8')) as Job;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}
