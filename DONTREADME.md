# PR Heatmap: technical details

## Sign-in

There are two ways to read pull requests:

- **Session (default, no setup):** the extension reads the PR's
  `github.com/…/pull/{n}.patch` and `.diff` with your existing GitHub login, so any PR you
  can open works, including private repositories where you're a collaborator.
- **Token (optional, set in the popup from the extension's toolbar icon):** the extension uses the GitHub REST
  API instead. See [Why the API is still worth having](#why-the-api-is-still-worth-having).
  - **Fine-grained token**: read-only *Contents* and *Pull requests* access to the
    repositories you review.
  - **Classic token with `repo`**: use this for private repositories owned by another
    user where you are a collaborator, if a fine-grained token can't reach them.

  The token stays in `chrome.storage.local`. Only the background worker sends it, and
  only to `api.github.com`.

## How it works (layer 1: commit recency)

1. The extension gets the PR's commits with their patches, and the overall PR diff
   ([src/background.ts](src/background.ts)).
   - **Session:** `pull/{n}.patch` is a `git format-patch` series of the PR's commits and
     `pull/{n}.diff` is the PR diff. Both are parsed in
     [src/patch-series.ts](src/patch-series.ts). They redirect to
     `patch-diff.githubusercontent.com`, which sends no CORS headers, so the background
     worker fetches them with host permissions
     ([src/github-session.ts](src/github-session.ts)).
   - **Token:** `GET /pulls/{n}` (head SHA), `/pulls/{n}/commits`, `/pulls/{n}/files`,
     and `GET /commits/{sha}` for each commit on the first-parent chain from head
     ([src/github-api.ts](src/github-api.ts)).
2. Each commit's patch is replayed onto a per-file `line → commit` map
   ([src/attribution.ts](src/attribution.ts)). Each hunk shifts the lines after it,
   keeps context lines, drops deleted lines and assigns added lines to the commit.
   Renames are followed.
3. Deleted lines are tracked the other way round. Each `-` line of the PR diff starts at
   its base position and is carried through the same patches until the commit that
   deletes it.
4. The final maps are intersected with the PR diff's `+` and `-` lines. Per-commit diffs
   can align repeated lines differently from the overall diff. When that leaves a line
   without an owner, it takes the commit of the nearest attributed line in the same
   block of changed lines.
5. Each attribution is checked against the line's text: the commit's patch for that file
   (under any name it had earlier in the PR) must add (or delete) exactly that text, or
   the line stays untinted ([src/heat.ts](src/heat.ts)). This catches drift, for example
   when the `.patch` series skips a merge commit.
6. Results are cached and the cache keeps the 30 most recent results. With a token the
   key is the head SHA. In session mode it's the last commit SHA plus the diff size,
   because merge commits aren't in the series and the diff size catches a pushed merge.
   Commit patches from the API are also kept in memory for the worker's lifetime.

The content script ([src/content.ts](src/content.ts)) finds line cells through GitHub's
`diff-<sha256(path)>R<line>` (head) and `diff-<sha256(path)>L<line>` (base) anchors. The
tint replaces GitHub's own green and red backgrounds. All selectors live in
[src/dom.ts](src/dom.ts). A MutationObserver repaints lazily loaded or virtualized rows.
A small control shows the status and toggles the heatmap. It sits to the left of the
"N / M files viewed" counter, which it finds by text. If the counter isn't on the page
(for example when logged out), the control floats in the bottom-right corner.

## Why the API is still worth having

The session route covers commit recency well, but it reads files and pages that GitHub
doesn't promise to keep stable, and some information isn't in them at all.

### Edits made inside merge commits

`git format-patch`, which produces `pull/{n}.patch`, leaves out merge commits. Commits from
a branch merged into the PR are still in the series, so their lines get the real commit.
But a line whose text only appears in a merge's own diff, typically a conflict resolution,
has no commit in the series that added it. It fails the text check and stays untinted.

The API returns every commit with its parents, so the extension can walk the first-parent
chain and replay each merge's diff against its first parent. Those lines are then
attributed to the merge commit.

### Viewed state and review baselines (layer 2)

The planned "unseen by you" layer needs, per file, what the current user last saw:

- **Viewed state:** GraphQL `PullRequest.files { path viewerViewedState }`, which is
  `VIEWED`, `UNVIEWED` or `DISMISSED` ("new changes since last viewed").
- **Last review commit:** `GET /pulls/{n}/reviews`, filtered to the current user, gives
  each review's `commit_id`. That's the baseline GitHub's own "changes since your last
  review" uses.
- **Baseline-to-head diff:** `GET /compare/{base}...{head}` for a stored Viewed-click SHA
  or review commit.

Without the API these have to be read from the PR page, which breaks whenever GitHub
changes its markup and can't see files that haven't been rendered yet.

### Other things the API makes possible

- **When commits were pushed:** the `.patch` only has author dates, which survive rebases.
  The API has committer dates, and the timeline (`GET /issues/{n}/timeline`) has
  `head_ref_force_pushed` events with the old and new head SHAs. That allows heat by
  push time instead of commit order, and gives layer 2 a way to recover baselines that a
  force-push made unreachable.
- **Review comments:** `GET /pulls/{n}/comments` and GraphQL review threads, with their
  resolved state. Lines with unresolved threads, or lines changed after a comment was
  left, could be highlighted.
- **CI per commit:** check runs and statuses (`GET /commits/{sha}/check-runs`), for example
  to mark lines that came in after the last green build.
- **Stability:** the REST API is documented and versioned, and errors come back as status
  codes. The session route depends on `.patch`/`.diff` URLs and, for some workarounds
  below, on page markup.

### What the API is worse at

- **Very large files:** GitHub omits the `patch` field for very large file diffs, in both
  `/pulls/{n}/files` and `/commits/{sha}`. On `cli/cli#13541` a 3,842-line file stayed
  untinted with a token but was fully tinted through the session route. A future
  improvement would be to use the API and fill in files without a patch from the
  session's `.diff`.
- **Rate limits:** 5,000 requests per hour with a token, and one request per PR commit.
  The session route makes two requests per PR and has no API rate limit.
- **Setup:** a token has to be created, and an organization may need to approve it.

## Working without the API (private repos included)

Everything below uses the browser's GitHub login, so it reaches whatever the user can
open, including private repositories owned by someone else. None of it is built yet,
except the `.patch`/`.diff` route itself.

### Covering edits inside merge commits

1. **Find the merges.** The PR's commits page (`github.com/{o}/{r}/pull/{n}/commits`)
   lists every commit, merges included, in order. On `cli/cli#13541` it listed the 45
   commits of the `.patch` in the same order, plus the 2 merges. The merges are the SHAs
   on the page that aren't in the series.
2. **Fetch each merge's diff.** `github.com/{o}/{r}/commit/{sha}.diff` works with the
   login, and for a merge it's exactly the diff against the first parent. This was
   checked byte for byte against the API's first-parent compare.
3. **Use it as a fallback, not in the replay.** Inserting merge diffs into the replay
   would be wrong for merges of other branches: their commits are already in the series,
   so their changes would be applied twice. Instead, keep the replay as it is, and for
   lines that would otherwise stay untinted, check whether a merge's diff added (or
   deleted) exactly that text in that file. If so, tint the line with the merge's
   position in the commit order.
4. **Exact replay, if needed later.** Telling base-branch merges from side-branch merges
   requires each merge's parents. They're on the commit's page (`/commit/{sha}`), one
   extra page per merge. With them, base-branch merges could be inserted into the replay
   and only side-branch merges handled by the fallback.

Cost: one page fetch for the commit list plus one diff per merge. PRs without merges cost
nothing extra. Risks: the commit list is read from page markup, the logged-in page may be
structured differently from the logged-out one that was checked, and very long PRs may
paginate their commit list. No real PR with conflict-resolution edits has been tested.

### Layer 2 without the API

- **Viewed state:** each file's Viewed checkbox is in the page, and GitHub marks files
  that changed after being viewed. These can be read from the DOM, but only for files
  that are rendered.
- **Viewed clicks:** recording clicks happens in the page in either mode.
- **Baseline-to-head diff:** `github.com/{o}/{r}/compare/{base}...{head}.diff` should work
  with the login, the same way as `pull/{n}.diff`. Not yet tested.
- **Last review commit:** the PR's commit picker offers "changes since your last review",
  which implies the baseline is in the page data. It would have to be located and
  scraped.

## Verified so far

- Attribution was checked with a test script against the GitHub API on four `cli/cli`
  PRs with 8, 14, 23 and 40 commits. All 3,252 added lines matched a `+` line of their
  attributed commit, and 1,057 of 1,058 deleted lines matched a `-` line.
- Session and API results were compared on seven `cli/cli` PRs, three of which merged
  their base branch in. After the text check, every tinted added line from either source
  matched a `+` line of its commit's patch for that file. The session route tinted
  everything the API route did, plus the 3,842-line file on `cli/cli#13541` whose patch
  the API omits.
- Session mode was only tested on public repos, without a login. Private repos depend on
  the browser sending the GitHub session cookie with the background fetch.
- The classic diff markup (logged-out view) uses `id="diff-<sha256(path)>R<n>"`, which
  matches the hashes the extension computes.
- GraphQL `PullRequestChangedFile.viewerViewedState` exists, and `FileViewedState` is
  `VIEWED | UNVIEWED | DISMISSED`. DISMISSED means "new changes since last viewed".

## Known gaps

- **New "Files changed" UI (logged-in)**: the `data-line-anchor` selector in
  `src/dom.ts` has not been checked against the live page. If nothing is shaded while
  the control reports commits, inspect a right-side line-number cell and update
  `findLineCells`.
- **Session mode, edits inside merge commits:** stay untinted, see
  [Covering edits inside merge commits](#covering-edits-inside-merge-commits).
- **Token mode, very large files:** stay untinted because the API omits their patch.
- **Long PRs:** the API lists at most 250 commits, and very large `.patch` files may be
  truncated. Lines from missing commits stay untinted.
- If a commit's patch is missing (binary or very large diff), earlier attribution for
  that file is lost. Only later commits shade it.
- Commit-range views (`/files/<a>..<b>`) are skipped on purpose, because their line
  numbers don't refer to head.
- The heatmap doesn't refresh after a new push until you reload or navigate.

## Next: layer 2 ("unseen by you")

Planned, not started: record Viewed-checkbox clicks with head and blob SHAs, fall back
to the user's latest review `commit_id`, and pre-filter files with `viewerViewedState`.
