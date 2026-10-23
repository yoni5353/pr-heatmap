import {
  NAVIGATION_EVENTS,
  diffPagePr,
  findLineCells,
  findToolbarAnchor,
  findWordHighlights,
  observeRoot,
  pathHash,
  type LineCells,
} from "./dom";
import type { HeatCommit, HeatResponse, HeatResult, PrRef, Request } from "./messages";

const PAINTED = "prhHeat";
const OFF_CLASS = "prh-off";

let activeKey: string | undefined;
let heat: HeatResult | undefined;
let control: HTMLElement | undefined;
let refreshTimer: number | undefined;

function send<T>(msg: Request): Promise<T> {
  return chrome.runtime.sendMessage(msg);
}

function heatValue(index: number, count: number): number {
  return count <= 1 ? 1 : index / (count - 1);
}

type Change = "added" | "deleted";

// How much stronger the newest commit's tint is than the oldest's. Red reads stronger
// than green at the same opacity, so it gets a smaller range.
const HEAT_RANGE: Record<Change, number> = { added: 0.3, deleted: 0.2 };

/** Green for additions, red for deletions: a faint tint for the oldest commit, strong for the newest. */
function heatColor(change: Change, h: number): string {
  const hue = change === "added" ? 135 : 0;
  return `hsla(${hue}, 75%, 45%, ${(0.2 + HEAT_RANGE[change] * h).toFixed(2)})`;
}

/** GitHub's changed-word highlight, kept a fixed step stronger than its line's tint. */
function wordColor(change: Change, h: number): string {
  const hue = change === "added" ? 135 : 0;
  return `hsla(${hue}, 75%, 45%, ${(0.35 + HEAT_RANGE[change] * h).toFixed(2)})`;
}

function relativeDate(iso: string): string {
  const days = (Date.now() - Date.parse(iso)) / 86_400_000;
  if (!Number.isFinite(days)) return "";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (days < 1 / 24) return rtf.format(-Math.round(days * 1440), "minute");
  if (days < 1) return rtf.format(-Math.round(days * 24), "hour");
  return rtf.format(-Math.round(days), "day");
}

function tooltip(change: Change, commit: HeatCommit, index: number, count: number): string {
  return `Heatmap: ${change} in commit ${index + 1}/${count} ${commit.sha.slice(0, 7)} — ${commit.message}\n${commit.author}, ${relativeDate(commit.date)}`;
}

async function paint(): Promise<void> {
  if (!heat) return;
  const { commits, files } = heat;
  for (const [path, changes] of Object.entries(files)) {
    const hash = await pathHash(path);
    paintSide(findLineCells(hash, "R"), changes.added, "added", commits);
    paintSide(findLineCells(hash, "L"), changes.deleted, "deleted", commits);
  }
}

function paintSide(cells: Map<number, LineCells>, lines: [number, number][], change: Change, commits: HeatCommit[]): void {
  if (!cells.size) return;
  for (const [line, index] of lines) {
    const target = cells.get(line);
    const commit = commits[index];
    if (!target || !commit) continue;
    const sig = `${heat!.headSha}:${change}:${index}`;
    if (target.number.dataset[PAINTED] === sig) continue;
    const h = heatValue(index, commits.length);
    const color = heatColor(change, h);
    for (const word of findWordHighlights(target.cells)) word.classList.add("prh-word");
    for (const cell of target.cells) {
      cell.classList.add("prh-cell");
      cell.style.setProperty("--prh-color", color);
      cell.style.setProperty("--prh-word", wordColor(change, h));
    }
    target.number.dataset[PAINTED] = sig;
    target.number.title = tooltip(change, commit, index, commits.length);
  }
}

function scheduleRefresh(): void {
  if (refreshTimer !== undefined) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    mountControl();
    paint().catch((e) => console.warn("[PR Heatmap] paint failed", e));
  }, 150);
}

/** Puts the control next to the "files viewed" counter, or floats it if there is none. */
function mountControl(): void {
  if (!control) return;
  const anchor = findToolbarAnchor();
  control.classList.toggle("prh-floating", !anchor);
  if (anchor) {
    if (control.nextElementSibling !== anchor) anchor.before(control);
  } else if (control.parentElement !== document.body) {
    document.body.append(control);
  }
}

function showControl(content: (el: HTMLElement) => void): void {
  if (!control) {
    control = document.createElement("div");
    control.className = "prh-control";
  }
  control.replaceChildren();
  content(control);
  mountControl();
}

function removeControl(): void {
  control?.remove();
}

function showResult(result: HeatResult): void {
  showControl((el) => {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "prh-control-button";
    toggle.textContent = "Heatmap";
    const commits = `${result.commits.length} commit${result.commits.length === 1 ? "" : "s"}`;
    toggle.title = `Shade changes by commit recency (${commits})`;
    const sync = () => toggle.setAttribute("aria-pressed", String(!document.documentElement.classList.contains(OFF_CLASS)));
    sync();
    toggle.addEventListener("click", () => {
      document.documentElement.classList.toggle(OFF_CLASS);
      sync();
    });
    el.append(toggle);
  });
}

function showError(response: Extract<HeatResponse, { ok: false }>): void {
  showControl((el) => {
    const text = document.createElement("span");
    text.textContent = `Heatmap: ${response.error}`;
    el.append(text);
    if (response.needsToken) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "prh-control-button";
      button.textContent = "Set token";
      button.addEventListener("click", () => void send({ type: "openOptions" }));
      el.append(button);
    }
  });
}

async function activate(pr: PrRef, key: string): Promise<void> {
  showControl((el) => (el.textContent = "Heatmap: loading…"));
  let response: HeatResponse;
  try {
    response = await send<HeatResponse>({ type: "getHeat", pr });
  } catch (e) {
    // Typically "Extension context invalidated" after the extension reloads.
    response = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (activeKey !== key) return; // navigated away meanwhile
  if (!response.ok) {
    showError(response);
    return;
  }
  heat = response.result;
  showResult(heat);
  scheduleRefresh();
}

function onLocationChange(): void {
  const pr = diffPagePr(location);
  const key = pr && `${pr.owner}/${pr.repo}#${pr.number}`;
  if (key === activeKey) return;
  activeKey = key;
  heat = undefined;
  if (!pr || !key) {
    removeControl();
    return;
  }
  void activate(pr, key);
}

for (const event of NAVIGATION_EVENTS) window.addEventListener(event, onLocationChange);
new MutationObserver(() => {
  onLocationChange();
  if (activeKey) scheduleRefresh();
}).observe(observeRoot(), { childList: true, subtree: true });
onLocationChange();
