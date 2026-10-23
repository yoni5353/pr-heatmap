// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { findToolbarAnchor } from "../src/dom";

function anchorFor(html: string): string | undefined {
  document.body.innerHTML = html;
  return findToolbarAnchor()?.getAttribute("data-test") ?? undefined;
}

describe("findToolbarAnchor", () => {
  beforeEach(() => (document.body.innerHTML = ""));

  it("finds a single-element counter", () => {
    expect(anchorFor(`<div><button>x</button><span data-test="hit">0 / 4 files viewed</span></div>`)).toBe("hit");
  });

  it("finds a counter whose numbers are in separate elements, with its progress icon", () => {
    expect(
      anchorFor(`<div class="toolbar"><button>a</button><button>b</button><button>c</button><button>d</button>
        <div data-test="hit"><svg></svg><span><span>2</span> / <span>4</span> <span>files viewed</span></span></div></div>`),
    ).toBe("hit");
  });

  it("lands before a progress circle that is a separate sibling", () => {
    expect(
      anchorFor(`<div><button>Review</button><svg data-test="hit" role="progressbar"></svg><span>2 / 4 files viewed</span><button>x</button></div>`),
    ).toBe("hit");
  });

  it("stops at a sibling with text", () => {
    expect(anchorFor(`<div><button>Review</button><span data-test="hit">2 / 4 files viewed</span></div>`)).toBe("hit");
  });

  it("accepts 'of' and capitalised wording", () => {
    expect(anchorFor(`<p><span data-test="hit">1 of 3 Files Viewed</span><span>other</span></p>`)).toBe("hit");
  });

  it("ignores code lines and labels that merely mention 'viewed'", () => {
    expect(anchorFor(`<td>if (files.viewed) { count = 2 / 4 }</td><label>Viewed</label>`)).toBeUndefined();
  });
});

describe("findWordHighlights", () => {
  it("returns spans with their own background, skipping whole-line wrappers", async () => {
    const { findWordHighlights } = await import("../src/dom");
    document.body.innerHTML = `<table><tr><td id="code"><span id="line" style="background: rgb(1, 2, 3)">extends <span id="word" style="background-color: rgb(0, 128, 0)">FlowBolt</span>'s <span id="syntax" style="color: red">r</span></span></td></tr></table>`;
    const words = findWordHighlights([document.getElementById("code")!]);
    expect(words.map((w) => w.id)).toEqual(["word"]);
  });
});

describe("findLineCells", () => {
  const H = "abc";
  async function codeIds(html: string, side: "L" | "R") {
    const { findLineCells } = await import("../src/dom");
    document.body.innerHTML = `<table>${html}</table>`;
    return Object.fromEntries([...findLineCells(H, side)].map(([line, c]) => [line, c.cells.map((x) => x.id)]));
  }

  it("classic unified: skips the other side's number cell", async () => {
    const row = `<tr><td class="blob-num" id="diff-${H}L4" data-line-number="4"></td><td class="blob-num empty-cell"></td><td id="code" class="blob-code blob-code-deletion"><span>x</span></td></tr>`;
    expect(await codeIds(row, "L")).toEqual({ 4: ["code"] });
  });

  it("classic split: tints only that side's code, even for a blank line", async () => {
    const row = `<tr><td class="blob-num" id="diff-${H}L4" data-line-number="4"></td><td id="lcode" class="blob-code"></td><td class="blob-num" id="diff-${H}R5" data-line-number="5"></td><td id="rcode" class="blob-code">y</td></tr>`;
    expect(await codeIds(row, "L")).toEqual({ 4: ["lcode"] });
    expect(await codeIds(row, "R")).toEqual({ 5: ["rcode"] });
  });

  it("unknown classes: recognizes number cells by digits and the code cell by content", async () => {
    const row = `<tr><td class="a">4</td><td class="b" data-line-anchor="diff-${H}R5">5</td><td id="code" class="c">let x = 1;</td></tr>`;
    expect(await codeIds(row, "R")).toEqual({ 5: ["code"] });
  });

  it("uses the anchor itself when the anchor is the code cell", async () => {
    const row = `<tr><td>5</td><td id="code" class="diff-text-cell" data-line-anchor="diff-${H}R5">let x = 1;</td></tr>`;
    expect(await codeIds(row, "R")).toEqual({ 5: ["code"] });
  });
});
