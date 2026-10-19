/**
 * Quotes one argument for the device-side POSIX shell. `adb shell` and
 * `adb exec-out` join their arguments into a single command line, so every
 * user-supplied value must be quoted before it reaches the device.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function splitDevicePath(devicePath: string): { parent: string; name: string } {
  const trimmed = devicePath.length > 1 ? devicePath.replace(/\/+$/, '') : devicePath;
  const index = trimmed.lastIndexOf('/');
  const parent = index <= 0 ? '/' : trimmed.slice(0, index);
  const name = trimmed.slice(index + 1) || '.';
  return { parent, name };
}
