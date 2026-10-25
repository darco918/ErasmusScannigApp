import os from 'node:os';

// IPv4 addresses phones can reach, e.g. the hotspot's 192.168.x.1.
// Some Android versions hide interfaces from apps, hence the fallback.
export function lanAddresses() {
  try {
    return Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address);
  } catch {
    return [];
  }
}

export function isLoopback(address = '') {
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}
