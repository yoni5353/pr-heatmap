# PR Heatmap: technical details

## Sign-in

By default no setup is needed. The extension reads the PR's `github.com/…/pull/{n}.patch`
and `.diff` with your existing GitHub login, so any PR you can open works, including
private repositories where you're a collaborator.

A token is optional. With one, the extension uses the REST API instead, which also follows
merge commits. That colors a few more lines on PRs that merged their base branch in.

- **Fine-grained token**: read-only *Contents* and *Pull requests* access to the
  repositories you review.
- **Classic token with `repo`**: use this for private repositories owned by another
  user where you are a collaborator, if a fine-grained token can't reach them.

The token stays in `chrome.storage.local`. Only the background worker sends it, and only
to `api.github.com`.

## How it works (layer 1: commit recency)

1. The extension gets the PR's commits with their patches, and the overall PR diff.
   - **Session (no token):** `pull/{n}.patch` is a `git format-patch` series and
     `pull/{n}.diff` is the PR diff. Both are parsed in
     [src/patch-series.ts](src/patch-series.ts). They redirect to
     `patch-diff.githubusercontent.com`, which sends no CORS headers, so the background
     worker fetches them with host permissions.
   - **Token:** `GET /pulls/{n}` (head SHA), `/pulls/{n}/commits`, `/pulls/{n}/files`,
     and `GET /commits/{sha}` for each commit on the first-parent chain from head.
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
   must add (or delete) exactly that text, or the line stays untinted
   ([src/heat.ts](src/heat.ts)). This catches drift, for example when the `.patch`
   series skips a merge commit.
6. Results are cached per head SHA, and the cache keeps the 30 most recent results.
   In session mode the key also includes the diff size, because merge commits are
   invisible there. Commit patches from the API are kept in memory for the worker's
   lifetime.

The content script ([src/content.ts](src/content.ts)) finds line cells through GitHub's
`diff-<sha256(path)>R<line>` (head) and `diff-<sha256(path)>L<line>` (base) anchors. The tint replaces
GitHub's own green and red backgrounds. All selectors live in
[src/dom.ts](src/dom.ts). A MutationObserver repaints lazily loaded or virtualized rows.
A small control shows the status and toggles the heatmap. It sits to the left of the
"N / M files viewed" counter, which it finds by text. If the counter isn't on the page
(for example when logged out), the control floats in the bottom-right corner.

## Verified so far

- Attribution was checked against the live API on four `cli/cli` PRs with 8, 14, 23 and
  40 commits. All 3,252 added lines matched a `+` line of their attributed commit, and
  1,057 of 1,058 deleted lines matched a `-` line.
- Session and API results were compared on seven `cli/cli` PRs, three of which merged
  their base branch in. After the text check, every tinted added line from either source
  matched a `+` line of its commit's patch for that file. Both sources tinted the same
  lines, except that on #13541 (35 commits plus merges) a few lines whose exact text two
  commits both added went to different, equally valid commits.
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
- **Merges inside the PR**: with a token, lines from side branches are attributed to the
  merge commit. Without one, the `.patch` series has no merges, so lines it can't place
  correctly are left untinted (on #13541 that was about 30% of added lines). If the base
  branch was merged in, deleted lines may also be left untinted.
- The GitHub API caps PRs at 250 listed commits, and very large `.patch` files may be
  truncated. Lines from earlier commits stay
  unshaded.
- If a commit's patch is missing (binary or very large diff), earlier attribution for
  that file is lost. Only later commits shade it.
- Commit-range views (`/files/<a>..<b>`) are skipped on purpose, because their line
  numbers don't refer to head.
- The heatmap doesn't refresh after a new push until you reload or navigate.

## Next: layer 2 ("unseen by you")

Planned, not started: record Viewed-checkbox clicks with head and blob SHAs, fall back
to the user's latest review `commit_id`, and pre-filter files with `viewerViewedState`.
