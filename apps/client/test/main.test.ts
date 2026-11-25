// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

const { render } = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render }) }));
vi.mock("../src/App", () => ({ App: () => null }));
vi.mock("../src/module-reload", () => ({ reloadOnFailedImports: () => {} }));

it("applies the address's effects setting before rendering the client", async () => {
  const address = location.href;
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  history.replaceState(null, "", "?effects=reduced");
  render.mockImplementation(() => {
    expect(document.documentElement.dataset.effects).toBe("reduced");
  });

  try {
    await import("../src/main");
    expect(render).toHaveBeenCalledOnce();
  } finally {
    delete document.documentElement.dataset.effects;
    history.replaceState(null, "", address);
    root.remove();
  }
});
