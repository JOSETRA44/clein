import fs from 'node:fs/promises';
import path from 'node:path';
import { ValidationError } from '../../domain/errors.js';

/**
 * Streams chunks into a brand-new local file: refuses to overwrite, writes
 * under `.partial` and renames only when `finish` succeeds.
 */
export async function writeNewFile(
  target: string,
  chunks: AsyncIterable<Uint8Array>,
  options: { onChunk?: (doneBytes: number) => void; finish?: (bytes: number, head: Uint8Array) => Promise<void> | void } = {}
): Promise<{ path: string; bytes: number }> {
  const absolute = path.resolve(target);
  if (await fs.stat(absolute).then(() => true, () => false)) throw new ValidationError(`Refusing to overwrite existing file: ${absolute}`);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const partial = `${absolute}.partial`;
  const handle = await fs.open(partial, 'wx');
  let bytes = 0;
  let head = new Uint8Array(0);
  try {
    for await (const chunk of chunks) {
      if (head.length < 16) head = Uint8Array.from([...head, ...chunk.subarray(0, 16 - head.length)]);
      await handle.write(chunk);
      bytes += chunk.length;
      options.onChunk?.(bytes);
    }
    await options.finish?.(bytes, head);
    await handle.close();
    await fs.rename(partial, absolute);
    return { path: absolute, bytes };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(partial, { force: true });
    throw error;
  }
}
