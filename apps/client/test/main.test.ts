// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

const { render } = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render }) }));
vi.mock("../src/App", () => ({ App: () => null }));
vi.mock("../src/drawing", () => ({ followStoredDrawing: async () => {} }));
vi.mock("../src/module-reload", () => ({ reloadOnFailedImports: () => {} }));

it.each([
  ["development", true, "reduced"],
  ["display", false, "reduced"],
  ["production", false, undefined],
] as const)(
  "applies address overrides for the %s client as configured",
  async (mode, dev, effects) => {
    vi.resetModules();
    vi.stubEnv("MODE", mode);
    vi.stubEnv("DEV", dev);
    const address = location.href;
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    history.replaceState(null, "", "?effects=reduced");
    render.mockImplementation(() => {
      expect(document.documentElement.dataset.effects).toBe(effects);
    });

    try {
      await import("../src/main");
      expect(render).toHaveBeenCalledOnce();
    } finally {
      render.mockReset();
      vi.unstubAllEnvs();
      delete document.documentElement.dataset.effects;
      history.replaceState(null, "", address);
      root.remove();
    }
  },
);
