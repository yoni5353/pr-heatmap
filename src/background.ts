import type { CommitChanges, CommitFileChange } from "./attribution";
import { GitHubError, getJson, getPaginated, getToken, mapLimited } from "./github-api";
import { fetchPatchSeries, fetchPrDiff } from "./github-session";
import { buildResult } from "./heat";
import type { HeatCommit, HeatResponse, HeatResult, PrRef, Request } from "./messages";
import { parseGitDiff, parsePatchSeries } from "./patch-series";

const CACHE_PREFIX = "heat2:";
const CACHE_INDEX = "heatIndex";
const CACHE_LIMIT = 30;

interface ApiCommit {
  sha: string;
  parents: { sha: string }[];
  commit: { message: string; author: { name: string; date: string } | null };
}

// Commit contents are immutable, so they can be shared across PRs for the worker's lifetime.
const commitCache = new Map<string, Promise<CommitChanges>>();
const inFlight = new Map<string, Promise<HeatResult>>();

function cacheKey(pr: PrRef, version: string): string {
  return `${CACHE_PREFIX}${pr.owner}/${pr.repo}#${pr.number}@${version}`;
}

async function cacheGet(key: string): Promise<HeatResult | undefined> {
  return (await chrome.storage.local.get(key))[key] as HeatResult | undefined;
}

async function cachePut(key: string, result: HeatResult): Promise<void> {
  const index = ((await chrome.storage.local.get(CACHE_INDEX))[CACHE_INDEX] as string[] | undefined) ?? [];
  const next = [key, ...index.filter((k) => k !== key)];
  const evicted = next.splice(CACHE_LIMIT);
  await chrome.storage.local.set({ [key]: result, [CACHE_INDEX]: next });
  if (evicted.length) await chrome.storage.local.remove(evicted);
}

/** Returns the cached result for `key`, else computes it once even if asked concurrently. */
async function cachedOrCompute(key: string, compute: () => Promise<HeatResult>): Promise<HeatResult> {
  const cached = await cacheGet(key);
  if (cached) return cached;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = compute()
      .then(async (result) => {
        await cachePut(key, result);
        return result;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

function repoPath(pr: PrRef): string {
  return `/repos/${pr.owner}/${pr.repo}`;
}

function getCommitChanges(pr: PrRef, sha: string, token: string): Promise<CommitChanges> {
  let pending = commitCache.get(sha);
  if (!pending) {
    pending = getPaginated<CommitFileChange, { files: CommitFileChange[] }>(
      `${repoPath(pr)}/commits/${sha}?per_page=100`,
      token,
      (page) => page.files,
    ).then((files) => ({ files }));
    pending.catch(() => commitCache.delete(sha));
    commitCache.set(sha, pending);
  }
  return pending;
}

/** Walks first parents back from head, staying inside the PR's commits. Oldest first. */
function firstParentChain(commits: ApiCommit[], headSha: string): ApiCommit[] {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const chain: ApiCommit[] = [];
  for (let c = bySha.get(headSha); c; c = c.parents[0] && bySha.get(c.parents[0].sha)) {
    chain.push(c);
  }
  return chain.reverse();
}

/**
 * REST API source. Follows the first-parent chain, so edits made inside merge commits
 * (e.g. conflict resolutions) are attributed to the merge. GitHub omits patches for very
 * large files, which then stay untinted.
 */
async function getHeatWithToken(pr: PrRef, token: string): Promise<HeatResult> {
  const base = repoPath(pr);
  const pull = await getJson<{ head: { sha: string } }>(`${base}/pulls/${pr.number}`, token);
  const headSha = pull.head.sha;
  return cachedOrCompute(cacheKey(pr, headSha), async () => {
    const [prCommits, prFiles] = await Promise.all([
      getPaginated<ApiCommit>(`${base}/pulls/${pr.number}/commits?per_page=100`, token),
      getPaginated<CommitFileChange>(`${base}/pulls/${pr.number}/files?per_page=100`, token),
    ]);
    const chain = firstParentChain(prCommits, headSha);
    const changes = await mapLimited(chain, (c) => getCommitChanges(pr, c.sha, token));
    const commits: HeatCommit[] = chain.map((c) => ({
      sha: c.sha,
      message: c.commit.message.split("\n")[0] ?? "",
      date: c.commit.author?.date ?? "",
      author: c.commit.author?.name ?? "",
    }));
    return buildResult(headSha, commits, changes, prFiles);
  });
}

/**
 * Session source: reads `pull/{n}.patch` and `.diff` with the browser's GitHub login. The
 * series has no merge commits, so edits made inside a merge stay untinted.
 */
async function getHeatWithSession(pr: PrRef): Promise<HeatResult> {
  const [patchText, diffText] = await Promise.all([fetchPatchSeries(pr), fetchPrDiff(pr)]);
  const series = parsePatchSeries(patchText);
  const head = series.at(-1);
  if (!head) throw new Error("the PR's .patch has no commits");
  // The series omits merge commits, so a pushed merge leaves `head` unchanged; the diff
  // size catches that (and a merge that changes nothing in the diff changes no heat).
  return cachedOrCompute(cacheKey(pr, `${head.sha}:${diffText.length}`), async () => {
    const commits: HeatCommit[] = series.map(({ sha, message, date, author }) => ({ sha, message, date, author }));
    return buildResult(head.sha, commits, series, parseGitDiff(diffText));
  });
}

async function getHeat(pr: PrRef): Promise<HeatResult> {
  const token = await getToken();
  return token ? getHeatWithToken(pr, token) : getHeatWithSession(pr);
}

async function handleGetHeat(pr: PrRef): Promise<HeatResponse> {
  try {
    return { ok: true, result: await getHeat(pr) };
  } catch (e) {
    // A token that can't see the repo, or a session without access: point at the options.
    const needsToken = e instanceof GitHubError ? [401, 403, 404].includes(e.status) : !(await getToken());
    return { ok: false, error: e instanceof Error ? e.message : String(e), needsToken };
  }
}

chrome.runtime.onMessage.addListener((msg: Request, _sender, sendResponse) => {
  if (msg.type === "getHeat") {
    handleGetHeat(msg.pr).then(sendResponse);
    return true;
  }
  if (msg.type === "openOptions") {
    chrome.runtime.openOptionsPage();
  }
  return false;
});
