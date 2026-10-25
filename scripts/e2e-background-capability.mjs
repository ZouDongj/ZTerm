import { createReadStream } from 'node:fs';

export const BACKGROUND_PROTOCOL_MARKER = 'ZTERM_E2E_BACKGROUND_PROTOCOL_V1_WINDOWS_BOOT_MS';

// This detects protocol compatibility only; it does not attest the executable.
export async function requireBackgroundCapability(executable) {
  const marker = Buffer.from(BACKGROUND_PROTOCOL_MARKER);
  let tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(executable, { highWaterMark: 64 * 1024 })) {
    const bytes = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    if (bytes.includes(marker)) return;
    tail = bytes.subarray(Math.max(0, bytes.length - marker.length + 1));
  }
  throw new Error('E2E executable lacks the supported background protocol. Rebuild with npm run build:release and use that executable; refusing to launch.');
}
