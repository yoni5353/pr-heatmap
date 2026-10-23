// Shapes exchanged between the content script and the background worker.

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface HeatCommit {
  sha: string;
  message: string;
  date: string;
  author: string;
}

export interface HeatResult {
  headSha: string;
  /** First-parent chain of PR commits, oldest first. */
  commits: HeatCommit[];
  /** Keyed by head path: [lineNumber, commitIndex] pairs for the lines the PR adds (head
   *  line numbers) and deletes (base line numbers). */
  files: Record<string, { added: [number, number][]; deleted: [number, number][] }>;
}

export type Request =
  | { type: "getHeat"; pr: PrRef }
  | { type: "openOptions" };

export type HeatResponse =
  | { ok: true; result: HeatResult }
  | { ok: false; error: string; needsToken?: boolean };
