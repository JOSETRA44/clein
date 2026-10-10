import os from 'node:os';
import path from 'node:path';

export const defaultDataDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'androidctl');
export const defaultSdk = path.join(process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'), 'platform-tools');

export function toolPath(name: string): string {
  const env = process.env[`ANDROIDCTL_${name.toUpperCase()}_PATH`];
  if (env) return env;
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return path.join(defaultSdk, exe);
}

export const paths = {
  data: process.env.ANDROIDCTL_DATA_DIR || defaultDataDir,
  jobs: path.join(process.env.ANDROIDCTL_DATA_DIR || defaultDataDir, 'jobs'),
  keys: path.join(process.env.ANDROIDCTL_DATA_DIR || defaultDataDir, 'keys')
};
