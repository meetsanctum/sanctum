// `pnpm dev:display` (deploy/dev/stack.sh): a bridge on the home network to
// the client's dev server, for a wall display that shows a web page in the
// slot its own app keeps for Home Assistant. That app accepts an address
// only once it answers Home Assistant's first sign-in step, so the bridge
// answers that step and passes everything else to the dev server, the live
// updates' and Vite's WebSockets too. It listens on every interface: anything
// on the network reaches the stack through it, with the seed's login.
//
// SANCTUM_DISPLAY_PORT sets its port (8123, Home Assistant's, by default),
// SANCTUM_DISPLAY_TARGET the dev server's port (5173), and
// SANCTUM_DISPLAY_TOUCHES=true has the page post each touch gesture's
// pointer and touch events, which the bridge appends to
// .sanctum-display-touches.jsonl in the worktree.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const port = Number(process.env.SANCTUM_DISPLAY_PORT || 8123);
const target = {
  // Vite listens on localhost, which can be IPv6 alone.
  host: "localhost",
  port: Number(process.env.SANCTUM_DISPLAY_TARGET || 5173),
};
const touches =
  process.env.SANCTUM_DISPLAY_TOUCHES === "true"
    ? path.join(root, ".sanctum-display-touches.jsonl")
    : null;

// Home Assistant's answer to the first step of its sign-in, a form asking
// for a username and password: what the display's app checks for.
const loginFlow = JSON.stringify({
  type: "form",
  flow_id: "0".repeat(32),
  handler: ["homeassistant", null],
  step_id: "init",
  data_schema: [
    { type: "string", name: "username", required: true },
    { type: "string", name: "password", required: true },
  ],
  errors: {},
  description_placeholders: null,
  last_step: null,
  preview: null,
});

// Records a gesture from its first pointer or touch event to its last, and
// posts it once the finger lifts or the gesture is cancelled.
const touchScript = `(() => {
  let gesture = null;
  const describe = (el) =>
    el instanceof Element
      ? el.tagName + "[" + (el.closest("[data-slot]")?.getAttribute("data-slot") ?? "") + "]"
      : String(el);
  const types = ["pointerdown", "pointermove", "pointerup", "pointercancel",
    "gotpointercapture", "lostpointercapture",
    "touchstart", "touchmove", "touchend", "touchcancel"];
  for (const type of types) {
    document.addEventListener(type, (event) => {
      const now = Math.round(performance.now());
      gesture ??= { start: now, target: describe(event.target), events: [] };
      const point = event.touches?.[0] ?? event.changedTouches?.[0] ?? event;
      gesture.events.push([now - gesture.start, type,
        Math.round(point.clientX ?? -1), Math.round(point.clientY ?? -1)]);
      if (type !== "touchend" && type !== "touchcancel") return;
      setTimeout(() => {
        if (!gesture) return;
        const body = JSON.stringify({ end: type, ...gesture });
        gesture = null;
        fetch("/__display/touches", { method: "POST", body, keepalive: true })
          .catch(() => {});
      }, 300);
    }, { capture: true, passive: true });
  }
})();`;

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
  });
}

function forward(request, response) {
  const upstream = http.request(
    {
      ...target,
      method: request.method,
      path: request.url,
      headers: request.headers,
    },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on("error", () => {
    response.writeHead(502, { "content-type": "text/plain" });
    response.end(`The client's dev server isn't answering on ${target.port}.`);
  });
  request.pipe(upstream);
}

// The shell's page with the touch recorder ahead of its own scripts.
function pageWithTouches(request, response) {
  const headers = { ...request.headers };
  // Plain text to edit, and never a 304 for a page that changed here.
  delete headers["accept-encoding"];
  delete headers["if-none-match"];
  delete headers["if-modified-since"];
  const upstream = http.request(
    { ...target, method: "GET", path: request.url, headers },
    async (answer) => {
      const html = (await readBody(answer)).replace(
        "<head>",
        `<head><script src="/__display/touches.js"></script>`,
      );
      const out = { ...answer.headers };
      delete out["content-length"];
      delete out.etag;
      response.writeHead(answer.statusCode ?? 502, out);
      response.end(html);
    },
  );
  upstream.on("error", () => {
    response.writeHead(502);
    response.end();
  });
  upstream.end();
}

const server = http.createServer(async (request, response) => {
  const route = `${request.method} ${request.url?.split("?")[0]}`;
  if (route === "POST /auth/login_flow") {
    await readBody(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(loginFlow);
    console.log(
      `Display bridge: ${request.socket.remoteAddress} checked the address`,
    );
    return;
  }
  if (touches && route === "GET /__display/touches.js") {
    response.writeHead(200, {
      "content-type": "text/javascript",
      "cache-control": "no-store",
    });
    response.end(touchScript);
    return;
  }
  if (touches && route === "POST /__display/touches") {
    fs.appendFileSync(touches, (await readBody(request)) + "\n");
    response.writeHead(204);
    response.end();
    return;
  }
  if (touches && route === "GET /") {
    pageWithTouches(request, response);
    return;
  }
  forward(request, response);
});

server.on("upgrade", (request, socket, head) => {
  const upstream = net.connect(target.port, target.host, () => {
    const lines = [
      `${request.method} ${request.url} HTTP/${request.httpVersion}`,
    ];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

// The Mac's addresses on the home network, for the display to be given.
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((each) => each && each.family === "IPv4" && !each.internal)
    .map((each) => each.address);
}

server.listen(port, "0.0.0.0", () => {
  const addresses = lanAddresses();
  console.log(
    `Display bridge on port ${port}: give the display's Home Assistant page ${
      addresses.map((address) => `http://${address}:${port}`).join(" or ") ||
      `this Mac's address and port ${port}`
    }`,
  );
  if (touches) console.log(`Display bridge: touches go to ${touches}`);
});
