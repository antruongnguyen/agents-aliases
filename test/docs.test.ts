import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { renderDetectionMatrix, MATRIX_BEGIN, MATRIX_END } from "./docs-gen.js";

const featuresPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "features.md",
);

function extractRegion(doc: string): string {
  const start = doc.indexOf(MATRIX_BEGIN);
  const end = doc.indexOf(MATRIX_END);
  if (start === -1 || end === -1) throw new Error("detection-matrix markers not found in features.md");
  // Normalize CRLF → LF: on Windows CI the file is checked out with \r\n, but the
  // generator emits \n. We compare content, not line-ending bytes.
  return doc.slice(start + MATRIX_BEGIN.length, end).replace(/\r\n/g, "\n").trim();
}

describe("docs/features.md detection matrix", () => {
  it("matches PRESETS (regenerate with the block below on failure)", () => {
    const onDisk = extractRegion(readFileSync(featuresPath, "utf8"));
    const expected = renderDetectionMatrix();
    if (onDisk !== expected) {
      throw new Error(
        `detection matrix is stale. Replace the region between the markers in docs/features.md with:\n\n${expected}\n`,
      );
    }
    expect(onDisk).toBe(expected);
  });
});
