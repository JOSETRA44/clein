import { listDevices, capabilities } from './devices.js';
import { createBackup, backupStatus } from './backup.js';

const args = process.argv.slice(2); const command = args[0];
const flag = (name: string, fallback?: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] || fallback : fallback; };
async function main() {
  if (!command || command === '--help') { console.log('androidctl devices | capabilities --device ID | diagnose --device ID | backup create --device ID --source PATH --destination DIR --secret VALUE | backup status --job ID'); return; }
  if (command === 'devices') return console.log(JSON.stringify(await listDevices(), null, 2));
  if (command === 'capabilities') return console.log(JSON.stringify(await capabilities(flag('--device')!), null, 2));
  if (command === 'diagnose') return console.log(JSON.stringify({ device: await capabilities(flag('--device')!), tools: 'adb/fastboot discovery enabled', note: 'MTP and scrcpy adapters are capability-gated' }, null, 2));
  if (command === 'backup' && args[1] === 'status') return console.log(JSON.stringify(await backupStatus(flag('--job')!), null, 2));
  if (command === 'backup' && args[1] === 'create') { const secret = flag('--secret'); if (!secret) throw new Error('--secret is required'); return console.log(JSON.stringify(await createBackup(flag('--device')!, flag('--source', '/sdcard')!, flag('--destination', './backups')!, secret), null, 2)); }
  throw new Error(`Unknown command: ${args.join(' ')}`);
}
main().catch(e => { console.error(JSON.stringify({ success: false, error: e instanceof Error ? e.message : String(e) })); process.exitCode = 1; });
