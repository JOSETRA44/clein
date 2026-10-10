import { toolPath } from './config.js';
import { run } from './process.js';

export interface FileTransport { list(deviceId: string, remotePath: string): Promise<unknown>; pull(deviceId: string, remotePath: string, localPath: string): Promise<void>; push(deviceId: string, localPath: string, remotePath: string): Promise<void>; }
export const adbTransport: FileTransport = {
  async list(id, p) { const r = await run(toolPath('adb'), ['-s', id, 'shell', 'ls', '-la', '--', p]); if (r.code) throw new Error(r.stderr); return r.stdout; },
  async pull(id, remote, local) { const r = await run(toolPath('adb'), ['-s', id, 'pull', remote, local], 0x7fffffff); if (r.code) throw new Error(r.stderr); },
  async push(id, local, remote) { const r = await run(toolPath('adb'), ['-s', id, 'push', local, remote], 0x7fffffff); if (r.code) throw new Error(r.stderr); }
};
export const mtpTransport: FileTransport = { async list() { throw new Error('MTP adapter requires Windows Portable Device integration; not available in this build'); }, async pull() { throw new Error('MTP adapter unavailable'); }, async push() { throw new Error('MTP adapter unavailable'); } };
export async function startScrcpy(deviceId: string, args: string[] = []) { return run(process.env.SCRCPY_PATH || 'scrcpy', ['-s', deviceId, ...args]); }
