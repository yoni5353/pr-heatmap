// Pure line-attribution logic: replays per-commit patches to find, for each line
// of the PR head, which PR commit last introduced it. No browser APIs here.

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw hunk body lines, each starting with ' ', '+' or '-'. */
  lines: string[];
}

/** Maps a 1-based line number in a file version to the index of the commit that introduced it. */
export type LineAttribution = Map<number, number>;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
    } else if (current && (line[0] === " " || line[0] === "+" || line[0] === "-")) {
      current.lines.push(line);
    } else if (current && line === "") {
      // GitHub trims trailing whitespace off blank context lines in some patches.
      current.lines.push(" ");
    }
    // "\ No newline at end of file" and anything else is ignored.
  }
  // A trailing "" from a final newline would add a bogus context line; trim hunks to
  // their declared size.
  for (const hunk of hunks) {
    let oldSeen = 0;
    let newSeen = 0;
    let keep = 0;
    for (const l of hunk.lines) {
      if (oldSeen >= hunk.oldLines && newSeen >= hunk.newLines) break;
      if (l[0] !== "+") oldSeen++;
      if (l[0] !== "-") newSeen++;
      keep++;
    }
    hunk.lines.length = keep;
  }
  return hunks;
}

/** Lines (1-based, in the new version) that a patch adds. */
export function addedLines(hunks: Hunk[]): Set<number> {
  const added = new Set<number>();
  for (const hunk of hunks) {
    let n = hunk.newStart;
    for (const l of hunk.lines) {
      if (l[0] === "+") added.add(n);
      if (l[0] !== "-") n++;
    }
  }
  return added;
}

/** Lines (1-based, in the old version) that a patch deletes. */
export function deletedLines(hunks: Hunk[]): Set<number> {
  const deleted = new Set<number>();
  for (const hunk of hunks) {
    let o = hunk.oldStart;
    for (const l of hunk.lines) {
      if (l[0] === "-") deleted.add(o);
      if (l[0] !== "+") o++;
    }
  }
  return deleted;
}

/**
 * Carries per-line values through one patch: lines outside hunks shift by the
 * preceding hunks' size delta, context lines keep their value, deleted lines are
 * dropped (reported to `onDelete`) and added lines get `added`, if given.
 */
export function applyPatch<V>(
  prev: Map<number, V>,
  hunks: Hunk[],
  added?: V,
  onDelete?: (value: V) => void,
): Map<number, V> {
  const next = new Map<number, V>();
  const sorted = [...prev.entries()].sort((a, b) => a[0] - b[0]);
  let i = 0;
  let delta = 0;

  for (const hunk of hunks) {
    // With a zero-length old side, oldStart is the line *after which* the insertion goes.
    const hunkOldFirst = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    while (i < sorted.length && sorted[i]![0] < hunkOldFirst) {
      const [line, value] = sorted[i++]!;
      next.set(line + delta, value);
    }

    let o = hunk.oldStart;
    let n = hunk.newStart;
    for (const l of hunk.lines) {
      if (l[0] === "+") {
        if (added !== undefined) next.set(n, added);
        n++;
        continue;
      }
      // Skip values for old lines before o (shouldn't happen with well-formed hunks).
      while (i < sorted.length && sorted[i]![0] < o) i++;
      const carried = i < sorted.length && sorted[i]![0] === o ? sorted[i++]![1] : undefined;
      if (l[0] === " ") {
        if (carried !== undefined) next.set(n, carried);
        n++;
      } else if (carried !== undefined) {
        onDelete?.(carried);
      }
      o++;
    }
    delta += hunk.newLines - hunk.oldLines;
  }

  while (i < sorted.length) {
    const [line, value] = sorted[i++]!;
    next.set(line + delta, value);
  }
  return next;
}

/**
 * Attributes the lines a PR diff adds or deletes. Per-commit diffs can align repeated
 * lines differently from the overall diff, leaving some lines without an owner; those
 * inherit from the nearest attributed line in the same run of consecutive lines.
 */
export function attributeLines(changed: Iterable<number>, attr: LineAttribution): [number, number][] {
  const lines = [...changed].sort((a, b) => a - b);
  const result: [number, number][] = [];
  let runStart = 0;
  while (runStart < lines.length) {
    let runEnd = runStart + 1;
    while (runEnd < lines.length && lines[runEnd] === lines[runEnd - 1]! + 1) runEnd++;
    const run = lines.slice(runStart, runEnd);
    const known = run.flatMap((line) => {
      const idx = attr.get(line);
      return idx === undefined ? [] : [[line, idx] as [number, number]];
    });
    if (known.length) {
      for (const line of run) {
        let best = known[0]!;
        for (const k of known) if (Math.abs(k[0] - line) < Math.abs(best[0] - line)) best = k;
        result.push([line, attr.get(line) ?? best[1]]);
      }
    }
    runStart = runEnd;
  }
  return result;
}

export interface CommitFileChange {
  filename: string;
  previous_filename?: string;
  status: string;
  /** Missing for binary files and diffs GitHub considers too large. */
  patch?: string;
}

export interface CommitChanges {
  files: CommitFileChange[];
}

export interface CommitAttribution {
  /** Path at the last commit -> head line -> index of the commit that added it. */
  added: Map<string, LineAttribution>;
  /** Base path -> base line -> index of the commit that deleted it. */
  deleted: Map<string, LineAttribution>;
}

/**
 * Replays `commits` (oldest first, each diffed against its first parent). Tracks which
 * commit added each line, and which commit deleted each base line in `trackDeleted`
 * (base path -> base line numbers). Lines whose file patch was ever unavailable lose
 * their history up to that point.
 */
export function attributeCommits(
  commits: CommitChanges[],
  trackDeleted: Map<string, Iterable<number>> = new Map(),
): CommitAttribution {
  const added = new Map<string, LineAttribution>();
  const deleted = new Map<string, LineAttribution>();
  // Current path -> current line -> index into `refs` (the base line it still is).
  const tracked = new Map<string, Map<number, number>>();
  const refs: { path: string; line: number }[] = [];
  for (const [path, lines] of trackDeleted) {
    const positions = new Map<number, number>();
    for (const line of lines) positions.set(line, refs.push({ path, line }) - 1);
    tracked.set(path, positions);
    deleted.set(path, new Map());
  }

  commits.forEach((commit, index) => {
    const markDeleted = (ref: number) => {
      const { path, line } = refs[ref]!;
      deleted.get(path)!.set(line, index);
    };
    for (const file of commit.files) {
      const sourcePath = file.status === "renamed" && file.previous_filename ? file.previous_filename : file.filename;
      const prevAdded = added.get(sourcePath) ?? new Map<number, number>();
      const prevTracked = tracked.get(sourcePath) ?? new Map<number, number>();
      added.delete(sourcePath);
      tracked.delete(sourcePath);
      if (file.status === "removed") {
        prevTracked.forEach(markDeleted);
        continue;
      }
      if (file.patch === undefined) {
        // Pure renames have no patch but keep content; anything else loses positions.
        if (file.status === "renamed") {
          added.set(file.filename, prevAdded);
          tracked.set(file.filename, prevTracked);
        } else {
          added.set(file.filename, new Map());
        }
        continue;
      }
      const hunks = parsePatch(file.patch);
      added.set(file.filename, applyPatch(prevAdded, hunks, index));
      tracked.set(file.filename, applyPatch(prevTracked, hunks, undefined, markDeleted));
    }
  });
  return { added, deleted };
}
