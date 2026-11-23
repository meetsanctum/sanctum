// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useEdgeFade } from "../src/edge-fade";

// A row that scrolls sideways fades each tile at an edge with more beyond
// it, the mask on the tile itself, and none once the row fits.

let root: Root;
let container: HTMLDivElement;

function Row(props: { tiles?: number; shown?: boolean }) {
  const row = useRef<HTMLDivElement>(null);
  useEdgeFade(row);
  if (props.shown === false) return null;
  return (
    <div ref={row}>
      {Array.from({ length: props.tiles ?? 2 }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}

// Lays the row out: 300 px wide, its tiles 200 px each, 12 px apart.
function layOut(row: HTMLElement, scrollLeft: number, scrollWidth: number) {
  const rect = (left: number, width: number) =>
    ({ left, right: left + width, width }) as DOMRect;
  Object.defineProperty(row, "clientWidth", { value: 300, configurable: true });
  Object.defineProperty(row, "scrollWidth", {
    value: scrollWidth,
    configurable: true,
  });
  row.scrollLeft = scrollLeft;
  row.getBoundingClientRect = () => rect(0, 300);
  [...row.children].forEach((tile, index) => {
    tile.getBoundingClientRect = () => rect(index * 212 - scrollLeft, 200);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (paint: FrameRequestCallback) => {
    paint(0);
    return 0;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("a row's edge fade", () => {
  it("fades only the edge with more beyond it, by where it crosses each tile", async () => {
    await act(async () => root.render(<Row />));
    const row = container.firstElementChild as HTMLElement;
    const [first, second] = [...row.children] as HTMLElement[];

    layOut(row, 0, 412);
    row.dispatchEvent(new Event("scroll"));
    expect(first!.style.maskImage).toBe(
      "linear-gradient(to right, black 0px, black 276px, transparent 300px)",
    );
    expect(second!.style.maskImage).toBe(
      "linear-gradient(to right, black 0px, black 64px, transparent 88px)",
    );

    layOut(row, 112, 412);
    row.dispatchEvent(new Event("scroll"));
    expect(first!.style.maskImage).toBe(
      "linear-gradient(to right, transparent 112px, black 136px, black 100%)",
    );

    layOut(row, 0, 300);
    row.dispatchEvent(new Event("scroll"));
    expect(first!.style.maskImage).toBe("");
    expect(second!.style.maskImage).toBe("");
  });

  it("follows a row from when it appears, and fades a tile added later", async () => {
    await act(async () => root.render(<Row shown={false} />));
    await act(async () => root.render(<Row />));
    const row = container.firstElementChild as HTMLElement;
    layOut(row, 0, 412);
    row.dispatchEvent(new Event("scroll"));
    expect((row.children[1] as HTMLElement).style.maskImage).toBe(
      "linear-gradient(to right, black 0px, black 64px, transparent 88px)",
    );

    await act(async () => root.render(<Row tiles={3} />));
    layOut(row, 0, 624);
    await act(async () => {
      row.append(document.createElement("i"));
      row.lastElementChild!.remove();
    });
    expect((row.children[2] as HTMLElement).style.maskImage).toBe(
      "linear-gradient(to right, black 0px, black -148px, transparent -124px)",
    );
  });

  it("sets nothing up again when the row draws again", async () => {
    const added = vi.spyOn(HTMLElement.prototype, "addEventListener");
    await act(async () => root.render(<Row />));
    await act(async () => root.render(<Row />));
    await act(async () => root.render(<Row />));
    expect(added.mock.calls.filter(([type]) => type === "scroll")).toHaveLength(
      1,
    );
  });
});
