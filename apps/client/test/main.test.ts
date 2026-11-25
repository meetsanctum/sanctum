// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

const { render } = vi.hoisted(() => ({ render: vi.fn() }));
const { readPreference } = vi.hoisted(() => ({ readPreference: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render }) }));
vi.mock("../src/App", () => ({ App: () => null }));
vi.mock("../src/module-reload", () => ({ reloadOnFailedImports: () => {} }));
vi.mock("../src/shell", () => ({
  getShell: () => ({ preferences: { get: readPreference } }),
}));

it("applies the address and saved drawing choices before rendering the client", async () => {
  const address = location.href;
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  history.replaceState(null, "", "?effects=reduced");
  let finishRead!: (value: string) => void;
  const preference = new Promise<string>((resolve) => {
    finishRead = resolve;
  });
  readPreference.mockReturnValue(preference);
  render.mockImplementation(() => {
    expect(document.documentElement.dataset.effects).toBe("reduced");
    expect(document.documentElement.dataset.motion).toBe("reduced");
  });

  try {
    await import("../src/main");
    expect(readPreference).toHaveBeenCalledWith("drawing");
    expect(render).not.toHaveBeenCalled();
    finishRead(JSON.stringify({ effects: "off", motion: "on" }));
    await preference;
    await Promise.resolve();
    expect(render).toHaveBeenCalledOnce();
  } finally {
    delete document.documentElement.dataset.effects;
    delete document.documentElement.dataset.motion;
    history.replaceState(null, "", address);
    root.remove();
  }
});
