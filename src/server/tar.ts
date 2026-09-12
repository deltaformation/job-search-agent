import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Minimal strict ustar codec for settings backup/restore. The writer emits
 * plain ustar regular files only (names under 100 chars, fixed
 * ownership/mode); the reader accepts exactly that and rejects symlinks,
 * hardlinks, devices, pax/gnu extensions, absolute paths, traversal, bad
 * checksums, truncation, and oversized members. gzip via node:zlib.
 *
 * Closed loop: only archives this writer produces (plus a validated
 * manifest) are ever restored, but the reader still distrusts every byte
 * because restore input arrives as an untrusted upload.
 */

export const TAR_BLOCK = 512;
export const TAR_MAX_NAME = 100;

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

export interface TarMember {
  name: string;
  data: Buffer;
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const digits = value.toString(8);
  if (digits.length > length - 1) {
    throw new TarError(`tar numeric overflow: ${value}`);
  }
  target.write(digits.padStart(length - 1, "0"), offset, length - 1, "ascii");
  target[offset + length - 1] = 0;
}

function writeString(target: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length >= length) {
    throw new TarError(`tar string too long: ${value.slice(0, 40)}`);
  }
  bytes.copy(target, offset);
}

function headerChecksum(header: Buffer): number {
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (header[index] as number);
  }
  return sum;
}

function buildHeader(name: string, size: number, mtimeSeconds: number): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  if (nameBytes.length === 0 || nameBytes.length > TAR_MAX_NAME) {
    throw new TarError("tar member name must be 1-100 bytes");
  }
  const header = Buffer.alloc(TAR_BLOCK);
  nameBytes.copy(header, 0);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtimeSeconds);
  header[156] = 0x30; // '0': regular file
  header.write("ustar", 257, 5, "ascii");
  header[262] = 0;
  header.write("00", 263, 2, "ascii");
  writeString(header, 265, 32, "root");
  writeString(header, 297, 32, "root");
  const checksum = headerChecksum(header);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 32;
  return header;
}

export interface TarWriter {
  appendFile(name: string, data: Buffer): void;
  finish(): Buffer;
}

/** Deterministic writer: same members + mtime always yield same bytes. */
export function createTarWriter(mtimeSeconds: number): TarWriter {
  if (!Number.isInteger(mtimeSeconds) || mtimeSeconds < 0) {
    throw new TarError("tar mtime must be a non-negative integer");
  }
  const chunks: Buffer[] = [];
  const seen = new Set<string>();
  return {
    appendFile(name: string, data: Buffer): void {
      if (seen.has(name)) {
        throw new TarError(`duplicate tar member: ${name}`);
      }
      seen.add(name);
      chunks.push(buildHeader(name, data.length, mtimeSeconds));
      if (data.length > 0) {
        chunks.push(data);
        const padding = (TAR_BLOCK - (data.length % TAR_BLOCK)) % TAR_BLOCK;
        if (padding > 0) {
          chunks.push(Buffer.alloc(padding));
        }
      }
    },
    finish(): Buffer {
      chunks.push(Buffer.alloc(TAR_BLOCK));
      chunks.push(Buffer.alloc(TAR_BLOCK));
      return Buffer.concat(chunks);
    },
  };
}

function readOctal(header: Buffer, offset: number, length: number, what: string): number {
  const raw = header.subarray(offset, offset + length).toString("ascii").replace(/\0| /g, "");
  if (!/^[0-7]*$/.test(raw)) {
    throw new TarError(`tar header has invalid ${what}`);
  }
  const value = raw === "" ? 0 : Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value)) {
    throw new TarError(`tar header has invalid ${what}`);
  }
  return value;
}

function readCString(header: Buffer, offset: number, length: number): string {
  const slice = header.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString("utf8");
}

function validateMemberName(name: string): void {
  if (name === "" || name.length > TAR_MAX_NAME) {
    throw new TarError("tar member name must be 1-100 chars");
  }
  if (name.startsWith("/") || name.includes("\\")) {
    throw new TarError(`tar member escapes the archive root: ${name.slice(0, 60)}`);
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TarError(`tar member escapes the archive root: ${name.slice(0, 60)}`);
  }
  if (/[^\x20-\x7E]/.test(name)) {
    throw new TarError("tar member name must be printable ASCII");
  }
}

export interface ExtractLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const STRICT_EXTRACT_LIMITS: ExtractLimits = {
  maxFiles: 50_000,
  maxFileBytes: 2_147_483_648,
  maxTotalBytes: 4_294_967_296,
};

/**
 * Strict ustar extraction into memory. Regular files only; directory
 * entries are skipped; everything else (symlinks, hardlinks, devices,
 * pax/gnu extensions, bad magic/checksum, traversal, truncation, limit
 * breaches) throws `TarError` with no partial output.
 */
export function extractTarStrict(data: Buffer, limits: ExtractLimits): TarMember[] {
  const members: TarMember[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let offset = 0;
  while (true) {
    if (offset + TAR_BLOCK > data.length) {
      throw new TarError("tar archive is truncated");
    }
    const header = data.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    if (header.subarray(257, 262).toString("ascii") !== "ustar") {
      throw new TarError("tar member is not ustar format");
    }
    const stored = readOctal(header, 148, 8, "checksum");
    if (headerChecksum(header) !== stored) {
      throw new TarError("tar header checksum mismatch");
    }
    const typeflag = String.fromCharCode(header[156] as number);
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5") {
      throw new TarError(`tar member has unsupported typeflag: ${JSON.stringify(typeflag)}`);
    }
    const prefix = readCString(header, 345, 155);
    const shortName = readCString(header, 0, 100);
    const name = prefix === "" ? shortName : `${prefix}/${shortName}`;
    const size = readOctal(header, 124, 12, "size");
    const dataStart = offset + TAR_BLOCK;
    const dataEnd = dataStart + size;
    const blocks = Math.ceil(size / TAR_BLOCK);
    if (dataStart + blocks * TAR_BLOCK > data.length) {
      throw new TarError("tar member data is truncated");
    }
    if (typeflag !== "5") {
      validateMemberName(name);
      if (seen.has(name)) {
        throw new TarError(`duplicate tar member: ${name.slice(0, 60)}`);
      }
      seen.add(name);
      if (size > limits.maxFileBytes) {
        throw new TarError(`tar member exceeds the per-file limit: ${name.slice(0, 60)}`);
      }
      totalBytes += size;
      if (totalBytes > limits.maxTotalBytes) {
        throw new TarError("tar archive exceeds the total size limit");
      }
      members.push({ name, data: data.subarray(dataStart, dataEnd) });
      if (members.length > limits.maxFiles) {
        throw new TarError("tar archive exceeds the file count limit");
      }
    }
    offset = dataStart + blocks * TAR_BLOCK;
  }
  return members;
}

export function gzipTar(tarBytes: Buffer, mtimeSeconds: number): Buffer {
  void mtimeSeconds;
  return gzipSync(tarBytes, { level: 9 });
}

export function gunzipTar(archive: Buffer, maxBytes: number): Buffer {
  let out: Buffer;
  try {
    out = gunzipSync(archive, { maxOutputLength: maxBytes });
  } catch (error: unknown) {
    throw new TarError(`gzip payload rejected: ${(error as Error).message}`);
  }
  return out;
}
