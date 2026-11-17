// The frames the client shows apps' pages in. Each loads one page from the
// core, `/pages/<ticket>/apps/<app>/<digest>/`, with the code it says hello
// with after its #, and runs the app's code, which the desktop app doesn't
// trust. The client names each frame's address here before it loads it, and
// the main process holds every frame to it:
//
// - a frame goes only to an address the client named, which is its own
//   entry again when it reloads, whatever follows its #: never to another
//   app, another build, another origin or a scheme of the app's own;
// - a frame's requests reach only its own page's folder and the kit under
//   the same ticket, at the same origin;
// - a frame is never redirected, since the core never redirects one.

const entryPath =
  /^\/pages\/([A-Za-z0-9_-]+)\/apps\/([a-z0-9][a-z0-9.-]*)\/([0-9a-f]+)\/$/;

/** An app page's address, as the client names it: its entry and its code. */
export type FrameEntry = {
  url: string;
  origin: string;
  ticket: string;
  folder: string;
};

/** What an address the client names for a frame says, or none if it isn't one. */
export function entryOf(url: string): FrameEntry | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return undefined;
  }
  if (parsed.username || parsed.password || parsed.search) return undefined;
  if (!/^#hello=[0-9a-f]{32}$/.test(parsed.hash)) return undefined;
  const match = entryPath.exec(parsed.pathname);
  if (!match) return undefined;
  return {
    url: parsed.href,
    origin: parsed.origin,
    ticket: match[1]!,
    folder: parsed.pathname,
  };
}

const withoutHash = (url: string) => url.split("#")[0]!;

/** The frames one page of the client has named. */
export function createFrameList() {
  const named = new Map<string, FrameEntry>();
  return {
    /** Names a frame's address; false for one that isn't an app page's. */
    allow(url: string) {
      const entry = entryOf(url);
      if (!entry) return false;
      named.set(entry.url, entry);
      return true;
    },

    end(url: string) {
      named.delete(url);
    },

    /**
     * Whether a frame may go to `url`: a named address, whatever follows
     * its #. A page may move its own # and reload; only the hello code
     * lives there, and a code that isn't the frame's gets no port.
     */
    mayNavigate(url: string) {
      const target = withoutHash(url);
      return [...named.keys()].some((each) => withoutHash(each) === target);
    },

    /**
     * Whether a frame showing `frameUrl` may load `url`: the frame's own
     * entry as it loads, and its folder and the kit under its ticket.
     */
    mayLoad(frameUrl: string, url: string, isFrameLoad: boolean) {
      if (isFrameLoad) {
        const target = withoutHash(url);
        return [...named.keys()].some((each) => withoutHash(each) === target);
      }
      const frame = named.get(frameUrl) ?? entryOfLoaded(frameUrl);
      if (!frame) return false;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return false;
      }
      if (parsed.origin !== frame.origin || parsed.search) return false;
      return (
        parsed.pathname.startsWith(frame.folder) ||
        parsed.pathname.startsWith(`/pages/${frame.ticket}/kit/`)
      );
    },
  };

  // A frame whose address moved after its # is still the page it loaded.
  function entryOfLoaded(frameUrl: string) {
    const target = withoutHash(frameUrl);
    for (const entry of named.values()) {
      if (withoutHash(entry.url) === target) return entry;
    }
    return undefined;
  }
}

export type FrameList = ReturnType<typeof createFrameList>;
