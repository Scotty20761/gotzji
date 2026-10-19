import { CoreError } from './types.js';

/** Decode whole characters while advancing only consumed source bytes. */
export function decodeUtf8LogPage(buffer: Buffer, limit: number, final: boolean): { text: string; byteLength: number } {
  let byteLength = 0;
  const end = Math.min(buffer.length, limit);
  while (byteLength < end) {
    const lead = buffer[byteLength]!;
    let width = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
    const available = Math.min(width, buffer.length - byteLength);
    for (let index = 1; index < available; index++) {
      if ((buffer[byteLength + index]! & 0xc0) !== 0x80) { width = 1; break; }
    }
    if (width > buffer.length - byteLength) {
      // A live producer may still finish this character. A terminal producer
      // retains the existing replacement behavior for genuinely incomplete bytes.
      if (final) byteLength = end;
      break;
    }
    if (byteLength + width > limit) {
      if (byteLength === 0) throw new CoreError('LOG_LIMIT_TOO_SMALL', 'Choose a log page limit of at least 4 bytes', 'limit');
      break;
    }
    byteLength += width;
  }
  return { text: buffer.subarray(0, byteLength).toString('utf8'), byteLength };
}
