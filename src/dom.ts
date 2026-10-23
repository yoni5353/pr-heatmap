// Every GitHub DOM assumption lives here, so layout changes are fixed in one place.
//
// Both diff UIs anchor line numbers by `diff-<sha256(head path)><side><line>`, where side is
// "L" (base line numbers) or "R" (head line numbers):
// - classic table:  <td id="diff-<hash>R12" data-line-number="12" class="blob-num ...">
// - new React view: <td data-line-anchor="diff-<hash>R12" ...>  (unverified; logged-in only)
// Which lines are additions/deletions comes from the API, so we don't depend on diff classes.

import type { PrRef } from "./messages";

const DIFF_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:files|changes)\/?$/;

/** The PR whose full diff is shown at `location`, or undefined for any other page (incl. commit ranges). */
export function diffPagePr(location: Location): PrRef | undefined {
  const m = DIFF_PATH.exec(location.pathname);
  if (!m) return undefined;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

const hashCache = new Map<string, Promise<string>>();

export function pathHash(path: string): Promise<string> {
  let h = hashCache.get(path);
  if (!h) {
    h = crypto.subtle.digest("SHA-256", new TextEncoder().encode(path)).then((buf) =>
      [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    );
    hashCache.set(path, h);
  }
  return h;
}

export type Side = "L" | "R";

export interface LineCells {
  /** The line-number cell; gets the tooltip. */
  number: HTMLElement;
  /** Cells to tint: just the code cell (that side's, in split view); number cells keep GitHub's colors. */
  cells: HTMLElement[];
}

/**
 * Whether a row cell holds code rather than a line number. Classic: `blob-num` vs
 * `blob-code`. The new UI's classes are unverified, so fall back to the content: number
 * cells are empty or digits only.
 */
function isCodeCell(el: Element): boolean {
  const cls = typeof el.className === "string" ? el.className : "";
  if (/blob-num|line-number/i.test(cls)) return false;
  if (/code|text|content/i.test(cls)) return true;
  const text = el.textContent?.trim() ?? "";
  return text !== "" && !/^\d+$/.test(text);
}

/**
 * The code cell belonging to a line anchor: the anchor itself if it is one, else the first
 * code cell after it. In the unified view that skips the other side's number
 * ([L num][R num][code]); in the split view it's that side's [code]. Falls back to the next
 * cell (e.g. a blank line in a layout we don't recognize).
 */
function codeCellFor(anchor: HTMLElement): HTMLElement | undefined {
  if (isCodeCell(anchor)) return anchor;
  for (let el = anchor.nextElementSibling; el; el = el.nextElementSibling) {
    if (isCodeCell(el) && el instanceof HTMLElement) return el;
  }
  const next = anchor.nextElementSibling;
  return next instanceof HTMLElement ? next : undefined;
}

/** One side's line cells currently rendered for one file, keyed by line number. */
export function findLineCells(hash: string, side: Side): Map<number, LineCells> {
  const prefix = `diff-${hash}${side}`;
  const found = new Map<number, LineCells>();
  const anchors = document.querySelectorAll<HTMLElement>(`[id^="${prefix}"], [data-line-anchor^="${prefix}"]`);
  for (const el of anchors) {
    const anchor = el.id.startsWith(prefix) ? el.id : el.dataset.lineAnchor ?? "";
    const line = Number(anchor.slice(prefix.length));
    if (!Number.isInteger(line) || found.has(line)) continue;
    const code = codeCellFor(el);
    found.set(line, { number: el, cells: code ? [code] : [] });
  }
  return found;
}

/**
 * GitHub's changed-word highlights inside line cells. Their classes differ between UIs,
 * so they're found as descendants painting their own background (syntax highlighting
 * only sets text color). Must run before the cells get our tint.
 */
export function findWordHighlights(cells: HTMLElement[]): HTMLElement[] {
  const words: HTMLElement[] = [];
  for (const cell of cells) {
    const lineText = cell.textContent?.trim() ?? "";
    for (const el of cell.querySelectorAll<HTMLElement>("span, mark, ins, del")) {
      if (el.classList.contains("prh-word")) continue;
      // A wrapper around the whole line is line background, not a word highlight.
      if (el.textContent?.trim() === lineText) continue;
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(bg)) words.push(el);
    }
  }
  return words;
}

// "0 / 4 files viewed", "0 of 4 files viewed", "0/4 viewed", ...
const VIEWED_COUNTER = /^\d+\s*(?:\/|of)\s*\d+\s*(?:files?\s*)?viewed$/i;
let toolbarAnchor: Element | undefined;

function normalizedText(el: Element): string {
  return el.textContent?.trim().replace(/\s+/g, " ") ?? "";
}

/**
 * The "N / M files viewed" counter in the diff toolbar (or the wrapper holding it with its
 * progress icon); our control goes right before it. Found by text, since its classes differ
 * between the classic and new UIs, and the numbers may sit in their own elements.
 * Undefined if it isn't rendered (e.g. logged out).
 */
export function findToolbarAnchor(): Element | undefined {
  if (toolbarAnchor?.isConnected) return toolbarAnchor;
  toolbarAnchor = undefined;
  const candidates = document.evaluate(
    "//body//*[not(self::script or self::style)][text()[contains(translate(., 'VIEWD', 'viewd'), 'viewed')]]",
    document,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );
  for (let i = 0; i < candidates.snapshotLength; i++) {
    // The word "viewed" may be in its own span, so test the element and a few ancestors.
    let el: Element | null = candidates.snapshotItem(i) as Element;
    for (let depth = 0; el && depth < 4 && !VIEWED_COUNTER.test(normalizedText(el)); depth++) {
      el = normalizedText(el).length > 40 ? null : el.parentElement;
    }
    if (!el || !VIEWED_COUNTER.test(normalizedText(el))) continue;
    // Climb through wrappers that hold nothing but the counter (e.g. its progress pie),
    // but not far enough to swallow a toolbar of icon-only buttons.
    const text = normalizedText(el);
    for (let depth = 0; depth < 2; depth++) {
      const parent: Element | null = el.parentElement;
      if (!parent || parent.childElementCount > 3 || normalizedText(parent) !== text) break;
      el = parent;
    }
    // Step left over text-less siblings (the progress circle) so we sit before them too.
    for (let prev = el.previousElementSibling, steps = 0; prev && steps < 2; prev = prev.previousElementSibling, steps++) {
      if (prev.classList.contains("prh-control") || normalizedText(prev) !== "") break;
      el = prev;
    }
    toolbarAnchor = el;
    return el;
  }
  return undefined;
}

/** Where to observe for lazily loaded / virtualized diff content. */
export function observeRoot(): Node {
  return document.body;
}

/** GitHub's own soft-navigation events; we also re-check the URL on DOM mutations. */
export const NAVIGATION_EVENTS = ["turbo:load", "turbo:render", "popstate", "pjax:end"] as const;
