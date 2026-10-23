import { describe, expect, it } from "vitest";
import { addedLines, applyPatch, attributeCommits, attributeLines, deletedLines, parsePatch } from "../src/attribution";

/** Builds a unified diff patch between two arrays of lines (single hunk, full context). */
function fullPatch(oldLines: string[], newLines: string[]): string {
  // Trivial LCS-based diff, good enough for small test fixtures.
  const m = oldLines.length;
  const n = newLines.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      lcs[i]![j] = oldLines[i] === newLines[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const body: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      body.push(" " + oldLines[i++]);
      j++;
    } else if (j < n && (i === m || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      body.push("+" + newLines[j++]);
    } else {
      body.push("-" + oldLines[i++]);
    }
  }
  return `@@ -${m === 0 ? 0 : 1},${m} +${n === 0 ? 0 : 1},${n} @@\n${body.join("\n")}`;
}

function toObject(map: Map<number, number>): Record<number, number> {
  return Object.fromEntries([...map.entries()].sort((a, b) => a[0] - b[0]));
}

describe("parsePatch", () => {
  it("parses headers with omitted lengths and ignores no-newline markers", () => {
    const hunks = parsePatch("@@ -3 +3,2 @@ fn()\n-a\n+b\n+c\n\\ No newline at end of file");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2 });
    expect(hunks[0]!.lines).toEqual(["-a", "+b", "+c"]);
  });

  it("reports added lines in new-file coordinates", () => {
    const hunks = parsePatch("@@ -1,3 +1,5 @@\n a\n+x\n b\n-c\n+y\n+z");
    expect([...addedLines(hunks)]).toEqual([2, 4, 5]);
    expect([...deletedLines(hunks)]).toEqual([3]);
  });
});

describe("applyPatch", () => {
  it("shifts attributions below an insertion", () => {
    const prev = new Map([[10, 0], [20, 0]]);
    // Insert two lines after line 5.
    const next = applyPatch(prev, parsePatch("@@ -5,0 +6,2 @@\n+a\n+b"), 1);
    expect(toObject(next)).toEqual({ 6: 1, 7: 1, 12: 0, 22: 0 });
  });

  it("keeps context, drops deletions and shifts after multiple hunks", () => {
    const prev = new Map([[2, 0], [3, 0], [50, 0]]);
    const patch = "@@ -1,3 +1,2 @@\n x\n-y\n z\n@@ -10,1 +9,3 @@\n-p\n+q\n+r\n+s";
    expect(toObject(applyPatch(prev, parsePatch(patch), 1))).toEqual({ 2: 0, 9: 1, 10: 1, 11: 1, 51: 0 });
  });
});

describe("attributeCommits", () => {
  it("attributes each line to the last commit that touched it", () => {
    const v0 = ["a", "b", "c"];
    const v1 = ["a", "B", "c", "d"];
    const v2 = ["new", "a", "B", "c", "D"];
    const result = attributeCommits([
      { files: [{ filename: "f.txt", status: "modified", patch: fullPatch(v0, v1) }] },
      { files: [{ filename: "f.txt", status: "modified", patch: fullPatch(v1, v2) }] },
    ]);
    expect(toObject(result.added.get("f.txt")!)).toEqual({ 1: 1, 3: 0, 5: 1 });
  });

  it("follows renames and forgets removed files", () => {
    const result = attributeCommits([
      { files: [
        { filename: "old.txt", status: "added", patch: "@@ -0,0 +1,2 @@\n+a\n+b" },
        { filename: "gone.txt", status: "added", patch: "@@ -0,0 +1 @@\n+x" },
      ] },
      { files: [
        { filename: "new.txt", previous_filename: "old.txt", status: "renamed" },
        { filename: "gone.txt", status: "removed", patch: "@@ -1 +0,0 @@\n-x" },
      ] },
      { files: [{ filename: "new.txt", status: "modified", patch: "@@ -2,0 +3 @@\n+c" }] },
    ]);
    expect([...result.added.keys()]).toEqual(["new.txt"]);
    expect(toObject(result.added.get("new.txt")!)).toEqual({ 1: 0, 2: 0, 3: 2 });
  });

  it("drops prior attribution when a patch is missing", () => {
    const result = attributeCommits([
      { files: [{ filename: "big.txt", status: "added", patch: "@@ -0,0 +1,2 @@\n+a\n+b" }] },
      { files: [{ filename: "big.txt", status: "modified" }] },
      { files: [{ filename: "big.txt", status: "modified", patch: "@@ -1,0 +2 @@\n+z" }] },
    ]);
    expect(toObject(result.added.get("big.txt")!)).toEqual({ 2: 2 });
  });
});

describe("attributeLines", () => {
  it("fills gaps from the nearest attributed line in the same added run", () => {
    const attr = new Map([[10, 2], [14, 5], [30, 1]]);
    const added = [10, 11, 12, 13, 14, 20, 21, 30];
    // 20-21 is a run with no attribution at all, so it stays unshaded.
    expect(attributeLines(added, attr)).toEqual([[10, 2], [11, 2], [12, 2], [13, 5], [14, 5], [30, 1]]);
  });
});

describe("deletion tracking", () => {
  it("attributes base lines to the commit that deleted them, through shifts and renames", () => {
    const base = ["a", "b", "c", "d", "e"];
    const v1 = ["new", "a", "c", "d", "e"]; // commit 0 deletes b (base 2)
    const v2 = ["new", "a", "c", "e"]; // commit 1 (after rename) deletes d (base 4)
    const result = attributeCommits(
      [
        { files: [{ filename: "f.txt", status: "modified", patch: fullPatch(base, v1) }] },
        { files: [{ filename: "g.txt", previous_filename: "f.txt", status: "renamed", patch: fullPatch(v1, v2) }] },
        { files: [{ filename: "h.txt", status: "removed", patch: "@@ -1 +0,0 @@\n-x" }] },
      ],
      new Map([["f.txt", [2, 4]], ["h.txt", [1]]]),
    );
    expect(toObject(result.deleted.get("f.txt")!)).toEqual({ 2: 0, 4: 1 });
    expect(toObject(result.deleted.get("h.txt")!)).toEqual({ 1: 2 });
  });
});
