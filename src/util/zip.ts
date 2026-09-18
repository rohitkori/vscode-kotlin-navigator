import * as fs from 'fs';
import * as zlib from 'zlib';

/**
 * A minimal, dependency-free reader for the parts of the ZIP format a
 * `-sources.jar` needs.
 *
 * Only the central directory is read up front - a few kilobytes per jar even
 * for large artifacts - and individual entries are inflated on demand. That
 * keeps "index 300 sources jars" cheap enough to do on the extension host.
 */

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function readChunk(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buf, read, length - read, position + read);
    if (n <= 0) {
      break;
    }
    read += n;
  }
  return read === length ? buf : buf.subarray(0, read);
}

/** Lists every entry in the archive. Throws on a file that is not a zip. */
export function listZipEntries(zipPath: string): ZipEntry[] {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLength = Math.min(size, 66560); // 64 KiB comment + EOCD
    const tail = readChunk(fd, size - tailLength, tailLength);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) {
      throw new Error(`not a zip archive: ${zipPath}`);
    }

    let entryCount = tail.readUInt16LE(eocd + 10);
    let centralSize = tail.readUInt32LE(eocd + 12);
    let centralOffset = tail.readUInt32LE(eocd + 16);

    // Zip64 - used by very large artifacts such as the Android SDK jars.
    if (entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
      for (let i = eocd - 20; i >= 0; i--) {
        if (tail.readUInt32LE(i) === EOCD64_LOCATOR_SIG) {
          const eocd64Offset = Number(tail.readBigUInt64LE(i + 8));
          const rec = readChunk(fd, eocd64Offset, 56);
          if (rec.length >= 56 && rec.readUInt32LE(0) === EOCD64_SIG) {
            entryCount = Number(rec.readBigUInt64LE(32));
            centralSize = Number(rec.readBigUInt64LE(40));
            centralOffset = Number(rec.readBigUInt64LE(48));
          }
          break;
        }
      }
    }

    const central = readChunk(fd, centralOffset, centralSize);
    const entries: ZipEntry[] = [];
    let p = 0;
    while (p + 46 <= central.length && entries.length < entryCount + 8) {
      if (central.readUInt32LE(p) !== CENTRAL_SIG) {
        break;
      }
      const compressionMethod = central.readUInt16LE(p + 10);
      const compressedSize = central.readUInt32LE(p + 20);
      const uncompressedSize = central.readUInt32LE(p + 24);
      const nameLen = central.readUInt16LE(p + 28);
      const extraLen = central.readUInt16LE(p + 30);
      const commentLen = central.readUInt16LE(p + 32);
      let localHeaderOffset = central.readUInt32LE(p + 42);
      const name = central.toString('utf8', p + 46, p + 46 + nameLen);

      if (localHeaderOffset === 0xffffffff && extraLen > 0) {
        localHeaderOffset = readZip64Offset(central, p + 46 + nameLen, extraLen) ?? localHeaderOffset;
      }

      if (!name.endsWith('/')) {
        entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

function readZip64Offset(buf: Buffer, start: number, length: number): number | undefined {
  let p = start;
  const end = start + length;
  while (p + 4 <= end) {
    const headerId = buf.readUInt16LE(p);
    const dataSize = buf.readUInt16LE(p + 2);
    if (headerId === 0x0001) {
      // Fields appear in a fixed order, each present only when its 32-bit
      // counterpart was 0xffffffff. The local header offset is the third.
      let q = p + 4;
      const values: bigint[] = [];
      while (q + 8 <= p + 4 + dataSize) {
        values.push(buf.readBigUInt64LE(q));
        q += 8;
      }
      if (values.length > 0) {
        return Number(values[values.length - 1]);
      }
    }
    p += 4 + dataSize;
  }
  return undefined;
}

/** Inflates a single entry to a string. */
export function readZipEntry(zipPath: string, entry: ZipEntry): string {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const header = readChunk(fd, entry.localHeaderOffset, 30);
    if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIG) {
      throw new Error(`bad local header for ${entry.name} in ${zipPath}`);
    }
    const nameLen = header.readUInt16LE(26);
    const extraLen = header.readUInt16LE(28);
    const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
    const raw = readChunk(fd, dataStart, entry.compressedSize);
    if (entry.compressionMethod === 0) {
      return raw.toString('utf8');
    }
    if (entry.compressionMethod === 8) {
      return zlib.inflateRawSync(raw).toString('utf8');
    }
    throw new Error(`unsupported compression method ${entry.compressionMethod} for ${entry.name}`);
  } finally {
    fs.closeSync(fd);
  }
}
