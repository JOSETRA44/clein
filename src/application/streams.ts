/**
 * Regroups an arbitrary chunk stream into fixed-size blocks; only the final
 * block may be shorter. Keeps memory bounded to one block.
 */
export async function* fixedSizeBlocks(source: AsyncIterable<Uint8Array>, blockSize: number): AsyncGenerator<Uint8Array> {
  let block = new Uint8Array(blockSize);
  let filled = 0;
  for await (const chunk of source) {
    let read = 0;
    while (read < chunk.length) {
      const take = Math.min(blockSize - filled, chunk.length - read);
      block.set(chunk.subarray(read, read + take), filled);
      filled += take;
      read += take;
      if (filled === blockSize) {
        yield block;
        block = new Uint8Array(blockSize);
        filled = 0;
      }
    }
  }
  if (filled > 0) yield block.subarray(0, filled);
}
