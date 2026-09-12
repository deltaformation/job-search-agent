import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { resolveArtifactPath } from "../security/paths";
import { describeArtifacts, sha256HexBytes } from "../resumes/artifacts";

/**
 * Resume artifact file publishing (architecture section 3 protocol).
 *
 * For each of Markdown/DOCX/PDF: reserve the content-named path, write a
 * temporary file on the same filesystem, fsync it, hash the bytes,
 * atomically rename over nothing (existing identical bytes are reused;
 * a conflicting different file aborts loudly), then return metadata for
 * the database transaction. Files are content-addressed by version stem,
 * so a rerun converges instead of duplicating.
 */

export interface PublishInputs {
  artifactsDir: string;
  jobKey: string;
  versionNumber: number;
  contentHash: string;
  markdown: Buffer;
  docx: Buffer;
  pdf: Buffer;
}

export interface PublishedArtifacts {
  stem: string;
  records: Array<{
    kind: string;
    relativePath: string;
    mediaType: string;
    byteSize: number;
    sha256: string;
  }>;
}

function publishOneFile(absolutePath: string, bytes: Buffer): { byteSize: number; sha256: string } {
  const sha256 = sha256HexBytes(bytes);
  if (existsSync(absolutePath)) {
    const current = sha256HexBytes(readFileSync(absolutePath));
    if (current === sha256) {
      return { byteSize: bytes.length, sha256 };
    }
    throw new Error(
      `artifact path collision with different bytes: ${JSON.stringify(absolutePath)}`,
    );
  }
  mkdirSync(dirname(absolutePath), { recursive: true });
  const nonce = createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 12);
  const tempPath = `${absolutePath}.tmp-${process.pid}-${nonce}`;
  writeFileSync(tempPath, bytes);
  const fd = openSync(tempPath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, absolutePath);
  return { byteSize: bytes.length, sha256 };
}

export function publishArtifacts(input: PublishInputs): PublishedArtifacts {
  const described = describeArtifacts({
    jobKey: input.jobKey,
    versionNumber: input.versionNumber,
    contentHash: input.contentHash,
    markdown: input.markdown,
    docx: input.docx,
    pdf: input.pdf,
  });
  const byKind: Record<string, Buffer> = {
    MARKDOWN: input.markdown,
    DOCX: input.docx,
    PDF: input.pdf,
  };
  const records = described.records.map((record) => {
    const absolute = resolveArtifactPath(input.artifactsDir, record.relativePath);
    const written = publishOneFile(absolute, byKind[record.kind] as Buffer);
    if (written.sha256 !== record.sha256 || written.byteSize !== record.byteSize) {
      throw new Error(`artifact hash drift for ${record.relativePath}`);
    }
    return {
      kind: record.kind,
      relativePath: record.relativePath,
      mediaType: record.mediaType,
      byteSize: record.byteSize,
      sha256: record.sha256,
    };
  });
  return { stem: described.stem, records };
}
