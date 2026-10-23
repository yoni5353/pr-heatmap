// Parses GitHub's `pull/{n}.patch` (a `git format-patch` series) and `pull/{n}.diff` into
// the same shapes the REST API returns, so the session-based source can reuse the
// attribution pipeline. Pure functions, no browser APIs.

import type { CommitFileChange } from "./attribution";

export interface SeriesCommit {
  sha: string;
  author: string;
  date: string;
  message: string;
  files: CommitFileChange[];
}

const COMMIT_START = /^From ([0-9a-f]{40}) Mon Sep 17 00:00:00 2001$/;

/** Decodes RFC 2047 encoded words (`=?UTF-8?q?...?=`), which git uses for non-ASCII headers. */
function decodeHeader(value: string): string {
  return value.replace(/=\?([^?]+)\?([qQbB])\?([^?]*)\?=\s*/g, (_, charset: string, encoding: string, text: string) => {
    let bytes: Uint8Array;
    if (encoding.toLowerCase() === "b") {
      bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    } else {
      const raw = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    }
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return text;
    }
  });
}

/** Unquotes git's C-style quoted paths (`"a/caf\303\251.txt"`) and strips the a/ or b/ prefix. */
function diffPath(raw: string): string | undefined {
  let path = raw.trim();
  if (path === "/dev/null") return undefined;
  if (path.startsWith('"') && path.endsWith('"')) {
    const bytes: number[] = [];
    const body = path.slice(1, -1);
    for (let i = 0; i < body.length; i++) {
      const c = body[i]!;
      if (c !== "\\") {
        bytes.push(...new TextEncoder().encode(c));
        continue;
      }
      const next = body[++i]!;
      if (/[0-7]/.test(next)) {
        bytes.push(parseInt(body.slice(i, i + 3), 8));
        i += 2;
      } else {
        bytes.push(({ n: 10, t: 9, '"': 34, "\\": 92 } as Record<string, number>)[next] ?? next.charCodeAt(0));
      }
    }
    path = new TextDecoder().decode(new Uint8Array(bytes));
  }
  return path.replace(/^[ab]\//, "");
}

/** Parses a multi-file git diff (the part after `diff --git` lines) into per-file changes. */
export function parseGitDiff(text: string): CommitFileChange[] {
  const files: CommitFileChange[] = [];
  const sections = text.split(/^(?=diff --git )/m).filter((s) => s.startsWith("diff --git "));
  for (const section of sections) {
    const lines = section.split("\n");
    let oldPath: string | undefined;
    let newPath: string | undefined;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let isNew = false;
    let isDeleted = false;
    let hunkStart = -1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith("@@")) {
        hunkStart = i;
        break;
      }
      if (line.startsWith("--- ")) oldPath = diffPath(line.slice(4));
      else if (line.startsWith("+++ ")) newPath = diffPath(line.slice(4));
      else if (line.startsWith("rename from ")) renameFrom = diffPath(line.slice(12));
      else if (line.startsWith("rename to ")) renameTo = diffPath(line.slice(10));
      else if (line.startsWith("new file mode")) isNew = true;
      else if (line.startsWith("deleted file mode")) isDeleted = true;
    }
    if (!oldPath && !newPath && !renameTo) {
      // Binary or mode-only change: take the path from the header (ambiguous with spaces).
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0]!);
      oldPath = m?.[1];
      newPath = m?.[2];
    }
    const filename = renameTo ?? newPath ?? oldPath;
    if (!filename) continue;
    const change: CommitFileChange = {
      filename,
      status: isDeleted ? "removed" : isNew ? "added" : renameTo ? "renamed" : "modified",
    };
    if (renameFrom) change.previous_filename = renameFrom;
    if (hunkStart >= 0) change.patch = lines.slice(hunkStart).join("\n").replace(/\n+$/, "");
    files.push(change);
  }
  return files;
}

/** Splits a `format-patch` series into commits, oldest first. Merge commits aren't included. */
export function parsePatchSeries(text: string): SeriesCommit[] {
  const commits: SeriesCommit[] = [];
  const lines = text.split("\n");
  const starts: number[] = [];
  lines.forEach((line, i) => COMMIT_START.test(line) && starts.push(i));

  starts.forEach((start, k) => {
    const end = starts[k + 1] ?? lines.length;
    const sha = COMMIT_START.exec(lines[start]!)![1]!;
    const headers = new Map<string, string>();
    let i = start + 1;
    let last = "";
    for (; i < end && lines[i] !== ""; i++) {
      const line = lines[i]!;
      if (/^\s/.test(line) && last) {
        headers.set(last, `${headers.get(last)} ${line.trim()}`);
      } else {
        const colon = line.indexOf(":");
        last = line.slice(0, colon).toLowerCase();
        headers.set(last, line.slice(colon + 1).trim());
      }
    }
    const from = decodeHeader(headers.get("from") ?? "");
    const subject = decodeHeader(headers.get("subject") ?? "").replace(/^\[PATCH[^\]]*\]\s*/, "");
    // The diff starts at the first `diff --git` after the `---` separator ending the message.
    const body = lines.slice(i, end);
    const separator = body.indexOf("---");
    const diffStart = body.findIndex((l, j) => j > separator && l.startsWith("diff --git "));
    const date = new Date(headers.get("date") ?? "");
    commits.push({
      sha,
      author: from.replace(/\s*<[^>]*>$/, "").replace(/^"(.*)"$/, "$1"),
      date: Number.isNaN(date.getTime()) ? "" : date.toISOString(),
      message: subject,
      files: diffStart < 0 ? [] : parseGitDiff(body.slice(diffStart).join("\n")),
    });
  });
  return commits;
}
