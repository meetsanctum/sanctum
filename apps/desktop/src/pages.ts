import {
  BrowserWindow,
  session,
  type Certificate,
  type Session,
  type WebContents,
} from "electron";
import { X509Certificate } from "node:crypto";

import {
  clientOrigin,
  clientScheme,
  isClientUrl,
  serveClient,
} from "./client-files.js";
import { channels } from "./shell.js";
import { refuse, type HostTrust } from "./trust.js";
import {
  createWindowLights,
  trafficLights,
  type WindowLights,
} from "./window-lights.js";

// The window on the client and the session it runs in. The session is the
// page's own, in memory, apart from the default one, and its verify proc
// checks every HTTPS request and WebSocket against the host trust. Chromium
// caches every decision for the life of a session, and neither
// re-registering the proc nor closing connections clears them, so when trust
// changes, a page whose session has decided anything moves to a fresh
// session, in a new window where the old one was. It gets back the view it
// asked for (`resume`). Nothing the page stores itself outlives its
// session, so the client keeps its preferences through the bridge
// (preferences.ts).

// The chain a server presented, leaf first, as PEM.
function chainOf(certificate: Certificate) {
  const chain: string[] = [];
  for (
    let current: Certificate | undefined = certificate;
    current && chain.length < 4;
    current = current.issuerCert
  ) {
    chain.push(current.data);
    if (current.issuerCert?.fingerprint === current.fingerprint) {
      break;
    }
  }
  return chain;
}

type Page = {
  window: BrowserWindow;
  // The traffic lights, on macOS only.
  lights?: WindowLights;
  session: Session;
  decided: boolean;
  verifying: number;
  isRetired: boolean;
  decisions: Map<string, CertificateDecision>;
};

type CertificateDecision = {
  notBefore: number;
  notAfter: number;
  isAccepted: boolean;
};

function isWithinDates(dates: CertificateDecision, at: number) {
  return at >= dates.notBefore && at < dates.notAfter;
}

function readCertificateDecision(certificates: string[], isAccepted: boolean) {
  try {
    if (!certificates.length) return undefined;
    const parsed = certificates.map((pem) => new X509Certificate(pem));
    return {
      notBefore: Math.max(...parsed.map((cert) => Date.parse(cert.validFrom))),
      notAfter: Math.min(...parsed.map((cert) => Date.parse(cert.validTo))),
      isAccepted,
    };
  } catch {
    // A malformed chain cannot become valid after a clock correction.
    return undefined;
  }
}

export function createPages(options: {
  clientRoot: string;
  preload: string;
  allowPlainHttp: boolean;
  trust: () => HostTrust;
  // Denies the session every permission.
  lockDown: (session: Session) => void;
}) {
  const { trust } = options;
  let current: Page | undefined;
  let sessions = 0;
  let resume: unknown = null;

  function pageSession(page: Page) {
    sessions += 1;
    const own = session.fromPartition(`sanctum-client-${sessions}`);
    options.lockDown(own);
    own.protocol.handle(clientScheme, (request) =>
      serveClient(options.clientRoot, request.url, {
        allowPlainHttp: options.allowPlainHttp,
      }),
    );
    own.setCertificateVerifyProc((request, callback) => {
      page.verifying += 1;
      const verdict = trust().verify(
        request.hostname,
        chainOf(request.certificate),
        (certificates, isAccepted) => {
          const decision = readCertificateDecision(certificates, isAccepted);
          if (
            decision &&
            (isAccepted || !isWithinDates(decision, Date.now()))
          ) {
            page.decisions.set(certificates.join("\n"), decision);
          }
        },
      );
      void verdict.then(
        (result) => {
          page.verifying -= 1;
          // A decision Chromium keeps, for this session only.
          page.decided = true;
          callback(result);
        },
        () => {
          page.verifying -= 1;
          page.decided = true;
          callback(refuse);
        },
      );
    });
    // Chromium also caches acceptance beyond the certificate's expiry.
    // Before another request or WebSocket can reuse it, retire this session
    // if any accepted leaf or anchor is outside its dates. This checks the
    // wall clock too, so a clock correction cannot retain stale trust or a
    // cached date refusal after those dates become valid.
    own.webRequest.onBeforeRequest((details, callback) => {
      if (isClientUrl(details.url)) {
        callback({ cancel: false });
        return;
      }
      const at = Date.now();
      const hasStaleDecision = [...page.decisions.values()].some(
        (decision) => isWithinDates(decision, at) !== decision.isAccepted,
      );
      callback({ cancel: page.isRetired || hasStaleDecision });
      if (hasStaleDecision && !page.isRetired) {
        void refresh();
      }
    });
    // While a first contact is checked, nothing carries a token.
    own.webRequest.onBeforeSendHeaders((details, callback) => {
      const carriesToken = Object.keys(details.requestHeaders).some(
        (name) => name.toLowerCase() === "authorization",
      );
      callback({ cancel: carriesToken && trust().isChecking() });
    });
    return own;
  }

  function open(bounds?: Electron.Rectangle) {
    const page = {
      decided: false,
      verifying: 0,
      isRetired: false,
      decisions: new Map(),
    } as Page;
    page.session = pageSession(page);
    page.window = new BrowserWindow({
      ...(bounds ?? { width: 1100, height: 760 }),
      minWidth: 420,
      minHeight: 560,
      // On macOS the window is the system's sidebar material, which the
      // client's frame lets through around its page; elsewhere it starts as
      // the client's Day background.
      ...(process.platform === "darwin"
        ? {
            vibrancy: "sidebar",
            visualEffectState: "followWindow",
            backgroundColor: "#00000000",
          }
        : { backgroundColor: "#ffffff" }),
      // On macOS the window draws no title bar: the traffic lights sit in
      // the sidebar's top row (window-lights.ts), and the client shows them
      // only with the sidebar (setWindowControls). The sidebar's top row
      // and the top bar move the window (the client's src/styles.css), and
      // other screens keep a strip along the top to move it by.
      titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
      trafficLightPosition: trafficLights,
      show: false,
      webPreferences: {
        session: page.session,
        preload: options.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    if (process.platform === "darwin") {
      page.lights = createWindowLights(page.window);
    }
    void page.window.loadURL(`${clientOrigin}/`);
    page.window.on("closed", () => {
      page.lights?.stop();
      if (current === page) current = undefined;
    });
    return page;
  }

  // Trust changed, or a cached certificate decision reached its date
  // boundary. The old page stops reaching anything immediately.
  async function refresh(next: unknown = null) {
    const old = current;
    // An unfinished check can still cache a decision under the old
    // trust, even if no decision has completed yet.
    if (!old || old.isRetired || (!old.decided && old.verifying === 0)) {
      return;
    }
    old.isRetired = true;
    await old.session.closeAllConnections();
    if (current !== old) return;
    resume = next;
    const page = open(old.window.getBounds());
    current = page;
    page.window.once("ready-to-show", () => {
      page.window.show();
      if (old.window.isFocused()) page.window.focus();
      old.window.destroy();
    });
  }

  return {
    open() {
      current = open();
      current.window.once("ready-to-show", () => current?.window.show());
    },

    hasWindow: () => current !== undefined,

    // Only the current page may use the bridge: one being replaced may not
    // store anything or change trust.
    isCurrent: (contents: WebContents) =>
      current?.isRetired === false && current.window.webContents === contents,

    // Trust changed: a page whose session decided nothing keeps it; any
    // other moves to a fresh one. The old page stops reaching anything at
    // once and goes when the new one is ready.
    refresh,

    // The view a refreshed page asked to come back to, once.
    resumed() {
      const view = resume;
      resume = null;
      return view;
    },

    // The traffic lights go with the client's sidebar, sliding `by` px with
    // it: hidden while it is collapsed, back as it docks or floats in. An
    // overlay in the client hides them too, at once.
    setWindowControls(visible: boolean, by: number) {
      current?.lights?.set(visible, by);
    },

    // The View menu's Show sidebar or Hide sidebar, for the page to act on.
    toggleSidebar() {
      current?.window.webContents.send(channels.toggleSidebar);
    },
  };
}

export type Pages = ReturnType<typeof createPages>;
