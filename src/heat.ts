import {
  addedLines,
  attributeCommits,
  attributeLines,
  deletedLines,
  parsePatch,
  type CommitChanges,
  type CommitFileChange,
  type Hunk,
} from "./attribution";
import type { HeatCommit, HeatResult } from "./messages";

/** Text of each added (`+`, keyed by new line) or deleted (`-`, keyed by old line) line. */
function lineTexts(hunks: Hunk[], marker: "+" | "-"): Map<number, string> {
  const texts = new Map<number, string>();
  for (const hunk of hunks) {
    let line = marker === "+" ? hunk.newStart : hunk.oldStart;
    for (const l of hunk.lines) {
      if (l[0] === marker) texts.set(line, l.slice(1));
      // Count only lines that exist on the side we're numbering.
      if (l[0] === marker || l[0] === " ") line++;
    }
  }
  return texts;
}

/** The `+` or `-` line texts of a commit's patch for one file (under either of its paths). */
function commitTexts(change: CommitChanges, paths: string[], marker: "+" | "-"): Set<string> {
  const texts = new Set<string>();
  for (const file of change.files) {
    if (!paths.includes(file.filename) && !(file.previous_filename && paths.includes(file.previous_filename))) continue;
    for (const l of file.patch?.split("\n") ?? []) if (l[0] === marker) texts.add(l.slice(1));
  }
  return texts;
}

/**
 * Attributes the PR diff's added and deleted lines to `commits` (oldest first), whose
 * per-commit changes are `changes`. A line is only kept if its commit really added (or
 * deleted) that text, which drops attributions that drifted, e.g. when the commit series
 * skips a merge.
 */
export function buildResult(
  headSha: string,
  commits: HeatCommit[],
  changes: CommitChanges[],
  prFiles: CommitFileChange[],
): HeatResult {
  // Old path of each PR file, which is where its deleted lines live.
  const basePath = (file: CommitFileChange) => (file.status === "renamed" && file.previous_filename) || file.filename;
  const prHunks = new Map(prFiles.flatMap((f) => (f.patch === undefined ? [] : [[f.filename, parsePatch(f.patch)] as const])));
  const trackDeleted = new Map(
    prFiles.flatMap((f) => {
      const hunks = prHunks.get(f.filename);
      return hunks ? [[basePath(f), deletedLines(hunks)] as const] : [];
    }),
  );
  const attribution = attributeCommits(changes, trackDeleted);

  const verified = (lines: [number, number][], texts: Map<number, string>, paths: string[], marker: "+" | "-") => {
    const cache = new Map<number, Set<string>>();
    return lines.filter(([line, index]) => {
      const text = texts.get(line);
      if (text === undefined) return false;
      let commitLines = cache.get(index);
      if (!commitLines) cache.set(index, (commitLines = commitTexts(changes[index] ?? { files: [] }, paths, marker)));
      return commitLines.has(text);
    });
  };

  const files: HeatResult["files"] = {};
  for (const file of prFiles) {
    const hunks = prHunks.get(file.filename);
    if (!hunks) continue;
    const paths = [file.filename, basePath(file)];
    const added = verified(
      attributeLines(addedLines(hunks), attribution.added.get(file.filename) ?? new Map()),
      lineTexts(hunks, "+"),
      paths,
      "+",
    );
    const deleted = verified(
      attributeLines(deletedLines(hunks), attribution.deleted.get(basePath(file)) ?? new Map()),
      lineTexts(hunks, "-"),
      paths,
      "-",
    );
    if (added.length || deleted.length) files[file.filename] = { added, deleted };
  }
  return { headSha, commits, files };
}
