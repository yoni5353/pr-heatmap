import { describe, expect, it } from "vitest";
import { buildResult } from "../src/heat";

const commit = (sha: string) => ({ sha, message: "", date: "", author: "" });

describe("buildResult", () => {
  it("drops lines whose attributed commit didn't add that text", () => {
    // The series claims commit 0 added "x" at line 1, but the PR diff shows "y" there
    // (e.g. a skipped merge shifted things), plus a correctly attributed "z" at line 2.
    const result = buildResult(
      "head",
      [commit("c0")],
      [{ files: [{ filename: "f", status: "added", patch: "@@ -0,0 +1,2 @@\n+x\n+z" }] }],
      [{ filename: "f", status: "added", patch: "@@ -0,0 +1,2 @@\n+y\n+z" }],
    );
    expect(result.files).toEqual({ f: { added: [[2, 0]], deleted: [] } });
  });
});

describe("buildResult with renames", () => {
  it("verifies lines added under a file's earlier name", () => {
    const result = buildResult(
      "head",
      [commit("c0"), commit("c1")],
      [
        { files: [{ filename: "old", status: "added", patch: "@@ -0,0 +1,2 @@\n+a\n+b" }] },
        { files: [{ filename: "new", previous_filename: "old", status: "renamed" }] },
      ],
      [{ filename: "new", status: "added", patch: "@@ -0,0 +1,2 @@\n+a\n+b" }],
    );
    expect(result.files).toEqual({ new: { added: [[1, 0], [2, 0]], deleted: [] } });
  });
});
