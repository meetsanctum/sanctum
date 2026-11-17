import { createContext, useContext } from "react";

// Where an overlay goes and whom it tells that it covers the window, for the
// shell's pages that open one from deep inside, such as Add devices from
// Settings → Devices. The signed-in screen provides them; outside it an
// overlay covers the document and tells nobody.

export type OverlayHost = {
  container: HTMLElement | null;
  onCovering: (covering: boolean) => void;
};

const OverlayHostContext = createContext<OverlayHost>({
  container: null,
  onCovering: () => undefined,
});

export const OverlayHostProvider = OverlayHostContext.Provider;

export const useOverlayHost = () => useContext(OverlayHostContext);
