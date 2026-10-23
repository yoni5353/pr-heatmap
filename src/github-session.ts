// Fetches PR patch files from github.com using the browser's signed-in session (no token).
// `pull/{n}.patch` and `.diff` redirect to patch-diff.githubusercontent.com, which sends no
// CORS headers, so this must run in the background worker with host permissions.

import { GitHubError } from "./github-api";
import type { PrRef } from "./messages";

async function fetchText(pr: PrRef, ext: "patch" | "diff"): Promise<string> {
  const url = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}.${ext}`;
  const res = await fetch(url, { credentials: "include" });
  // Without access GitHub answers 404, or redirects to the HTML login page.
  if (!res.ok || !res.headers.get("content-type")?.startsWith("text/plain")) {
    const status = res.ok ? 401 : res.status;
    throw new GitHubError(`couldn't read the PR's .${ext} (HTTP ${res.status}); sign in to GitHub or set a token`, status);
  }
  return res.text();
}

export function fetchPatchSeries(pr: PrRef): Promise<string> {
  return fetchText(pr, "patch");
}

export function fetchPrDiff(pr: PrRef): Promise<string> {
  return fetchText(pr, "diff");
}
