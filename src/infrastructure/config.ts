import os from 'node:os';
import path from 'node:path';

export interface AppConfig {
  adbPath: string;
  fastbootPath: string;
  scrcpyPath: string;
  dataDir: string;
  jobsDir: string;
  auditFile: string;
  /** read-only refuses every operation that changes the device or the PC. */
  policy: 'read-only' | 'standard';
}

type Env = Record<string, string | undefined>;

/** Pure: everything environment-dependent is passed in, so it can be tested. */
export function loadConfig(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): AppConfig {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const localAppData = env.LOCALAPPDATA || pathApi.join(home, 'AppData', 'Local');
  const sdkRoot = env.ANDROID_SDK_ROOT || env.ANDROID_HOME || pathApi.join(localAppData, 'Android', 'Sdk');
  const platformTools = pathApi.join(sdkRoot, 'platform-tools');
  const tool = (name: string) =>
    env[`ANDROIDCTL_${name.toUpperCase()}_PATH`] || pathApi.join(platformTools, platform === 'win32' ? `${name}.exe` : name);
  const dataDir = env.ANDROIDCTL_DATA_DIR || pathApi.join(localAppData, 'androidctl');

  return {
    adbPath: tool('adb'),
    fastbootPath: tool('fastboot'),
    scrcpyPath: env.ANDROIDCTL_SCRCPY_PATH || env.SCRCPY_PATH || 'scrcpy',
    dataDir,
    jobsDir: pathApi.join(dataDir, 'jobs'),
    auditFile: pathApi.join(dataDir, 'audit.jsonl'),
    policy: env.ANDROIDCTL_POLICY === 'read-only' ? 'read-only' : 'standard'
  };
}
