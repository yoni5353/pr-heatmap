import { describe, expect, it } from "vitest";
import { parseGitDiff, parsePatchSeries } from "../src/patch-series";

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

const SERIES = `From ${SHA1} Mon Sep 17 00:00:00 2001
From: "Ada L." <ada@example.com>
Date: Mon, 19 Oct 2026 14:26:40 +0100
Subject: [PATCH 1/2] feat: add a very long subject that git folded onto
 a second line

Body text.
---
 a.txt | 2 ++
 1 file changed, 2 insertions(+)
 create mode 100644 a.txt

diff --git a/a.txt b/a.txt
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/a.txt
@@ -0,0 +1,2 @@
+one
+two

From ${SHA2} Mon Sep 17 00:00:00 2001
From: =?UTF-8?q?Ren=C3=A9?= <rene@example.com>
Date: Tue, 20 Oct 2026 09:00:00 +0000
Subject: [PATCH 2/2] =?UTF-8?q?caf=C3=A9=20fix?=

---
 diff --git a/in/message b/not/a/diff

diff --git a/a.txt b/b.txt
similarity 80%
rename from a.txt
rename to b.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/b.txt
@@ -1,2 +1,2 @@
 one
-two
+TWO
diff --git a/img.png b/img.png
index 3333333..4444444 100644
Binary files a/img.png and b/img.png differ
diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
deleted file mode 100644
index 5555555..0000000
--- "a/caf\\303\\251.txt"
+++ /dev/null
@@ -1 +0,0 @@
-gone
`;

describe("parsePatchSeries", () => {
  const commits = parsePatchSeries(SERIES);

  it("splits commits and reads their headers", () => {
    expect(commits.map((c) => c.sha)).toEqual([SHA1, SHA2]);
    expect(commits[0]).toMatchObject({
      author: "Ada L.",
      date: "2026-10-19T13:26:40.000Z",
      message: "feat: add a very long subject that git folded onto a second line",
    });
  });

  it("decodes RFC 2047 encoded names and subjects", () => {
    expect(commits[1]).toMatchObject({ author: "René", message: "café fix" });
  });

  it("parses added, renamed, binary and deleted files", () => {
    expect(commits[0]!.files).toEqual([{ filename: "a.txt", status: "added", patch: "@@ -0,0 +1,2 @@\n+one\n+two" }]);
    expect(commits[1]!.files).toEqual([
      { filename: "b.txt", previous_filename: "a.txt", status: "renamed", patch: "@@ -1,2 +1,2 @@\n one\n-two\n+TWO" },
      { filename: "img.png", status: "modified" },
      { filename: "café.txt", status: "removed", patch: "@@ -1 +0,0 @@\n-gone" },
    ]);
  });
});

describe("parseGitDiff", () => {
  it("treats a pure rename as a renamed file without a patch", () => {
    const diff = "diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n";
    expect(parseGitDiff(diff)).toEqual([{ filename: "y", previous_filename: "x", status: "renamed" }]);
  });
});
