import { maxBlobBytes } from "@meetsanctum/app-sdk";
import {
  AirPlayConnection,
  AppleTV,
  CompanionPairSetup,
  encodeFrame,
  FrameType,
  PlaybackState,
  opackEncode,
} from "node-appletv-remote";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodeExpired,
  createBoxes,
  errorOf,
  NotAllowed,
  PairingLost,
  Unreachable,
  WrongCode,
} from "../src/boxes.js";
import { kindOf, modelName } from "../src/models.js";
import { FakeBox } from "./fake-boxes.js";

afterEach(() => vi.restoreAllMocks());

// The library's errors, which are plain messages, as the app's own, in the
// words node-appletv-remote 0.5.0 uses and those seen from the TVs.

describe("errorOf", () => {
  it.each([
    ["M4 missing Proof (error=2)", WrongCode],
    ["Companion PS M4 missing Proof (error=2)", WrongCode],
    ["Companion pair-verify M4 error: 2", PairingLost],
    ["Companion server signature verification failed", PairingLost],
    [
      "Apple TV ended pairing: the PIN expired (it shows for about 35 seconds); start pairing again",
      CodeExpired,
    ],
    ["HTTP 470 from /pair-pin-start", NotAllowed],
    ["HTTP 403 from /pair-pin-start", NotAllowed],
    ["Companion PS timeout waiting for response frame", Unreachable],
  ])("reads %j", (message, kind) => {
    expect(errorOf(new Error(message))).toBeInstanceOf(kind);
  });

  it("reads a socket that can't connect as unreachable", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    expect(errorOf(error)).toBeInstanceOf(Unreachable);
  });

  it("leaves an error it doesn't know as it is", () => {
    const error = new Error("M4 missing Proof (error=6)");
    expect(errorOf(error)).toBe(error);
  });

  it("leaves an AirPlay verification refusal retryable", () => {
    const error = new Error("Pair-verify M4 error: 2");
    expect(errorOf(error)).toBe(error);
  });
});

async function remote(protocol: "airplay" | "companion") {
  const box = new FakeBox({ deviceId: "6E:D2:21:38:B4:95", name: "TV" });
  const keys = await box.pair(protocol).finish(box.code(protocol));
  const endpoint = {
    deviceId: box.deviceId,
    name: box.name,
    model: box.model,
    address: box.address,
    airplayPort: 7000,
    companionAddress: box.address,
    companionPort: 49153,
  };
  return { endpoint, keys };
}

describe("Companion connection", () => {
  async function connect() {
    const { endpoint, keys } = await remote("companion");
    return createBoxes().connect(endpoint, keys);
  }

  it("keeps the link usable when optional requests fail", async () => {
    vi.spyOn(AppleTV.prototype, "connectCompanion").mockImplementation(
      async function (this: AppleTV) {
        this.emit("companionError", new Error("Text input unavailable"));
      },
    );
    vi.spyOn(AppleTV.prototype, "subscribePowerState").mockImplementation(
      () => {},
    );
    vi.spyOn(AppleTV.prototype, "fetchPowerState").mockRejectedValue(
      new Error("No request handler"),
    );
    const wake = vi
      .spyOn(AppleTV.prototype, "wake")
      .mockResolvedValue(undefined);
    const link = await connect();
    try {
      expect(link.power).toBe("unknown");
      await link.wake();
      expect(wake).toHaveBeenCalledOnce();
    } finally {
      link.close();
    }
  });

  it("rejects setup if Companion closes while fetching power", async () => {
    vi.spyOn(AppleTV.prototype, "connectCompanion").mockResolvedValue(
      undefined,
    );
    vi.spyOn(AppleTV.prototype, "subscribePowerState").mockImplementation(
      () => {},
    );
    vi.spyOn(AppleTV.prototype, "fetchPowerState").mockImplementation(
      async function (this: AppleTV) {
        this.emit("companionClose");
        throw new Error("Companion connection closed");
      },
    );

    await expect(connect()).rejects.toBeInstanceOf(Unreachable);
  });
});

describe("AirPlay player", () => {
  const idle = () =>
    Object.assign(new Error("No now-playing client"), { errorCode: 35 });

  async function open() {
    const { endpoint, keys } = await remote("airplay");
    return createBoxes().play(endpoint, keys);
  }

  it("rejects a timeout on the initial snapshot", async () => {
    vi.spyOn(AirPlayConnection.prototype, "connect").mockResolvedValue(
      undefined,
    );
    vi.spyOn(AppleTV.prototype, "getState").mockRejectedValue(
      new Error("MRP response timed out"),
    );
    await expect(open()).rejects.toBeInstanceOf(Unreachable);
  });

  it("opens an idle TV without an active player", async () => {
    vi.spyOn(AirPlayConnection.prototype, "connect").mockResolvedValue(
      undefined,
    );
    vi.spyOn(AppleTV.prototype, "getState").mockRejectedValue(idle());
    const player = await open();
    try {
      expect(player.playing.state).toBe("unknown");
    } finally {
      player.close();
    }
  });

  it.each([
    ["com.apple.TVWatchList", "playing"],
    ["com.plexapp.plex", "paused"],
  ])(
    "reads zero-rate Playing from %s as %s",
    async (bundleIdentifier, state) => {
      vi.spyOn(AirPlayConnection.prototype, "connect").mockImplementation(
        async function (this: AirPlayConnection) {
          this.emit("mrp-message", {
            type: 47, // SetNowPlayingPlayer
            ".setNowPlayingPlayerMessage": {
              playerPath: {
                client: { bundleIdentifier },
                player: { identifier: "player" },
              },
            },
          });
          this.emit("mrp-message", {
            type: 4, // SetState
            ".setStateMessage": {
              playerPath: {
                client: { bundleIdentifier },
                player: { identifier: "player" },
              },
              playbackState: PlaybackState.Playing,
              nowPlayingInfo: { title: "Episode", playbackRate: 0 },
            },
          });
        },
      );
      const player = await open();
      try {
        expect(player.playing).toMatchObject({ title: "Episode", state });
      } finally {
        player.close();
      }
    },
  );

  it("reports artwork from the selected player and queue item", async () => {
    let transport!: AirPlayConnection;
    vi.spyOn(AirPlayConnection.prototype, "connect").mockImplementation(
      async function (this: AirPlayConnection) {
        transport = this;
      },
    );
    vi.spyOn(AppleTV.prototype, "getState").mockRejectedValue(idle());
    const player = await open();
    const client = { bundleIdentifier: "com.apple.TVWatchList" };
    const path = { client, player: { identifier: "foreground" } };
    try {
      transport.emit("mrp-message", {
        type: 47, // SetNowPlayingPlayer
        ".setNowPlayingPlayerMessage": { playerPath: path },
      });
      transport.emit("mrp-message", {
        type: 4, // SetState
        ".setStateMessage": {
          playerPath: path,
          playbackState: PlaybackState.Playing,
          playbackQueue: {
            location: 1,
            contentItems: [
              {
                identifier: "first",
                metadata: { title: "First", artworkAvailable: false },
              },
              {
                identifier: "second",
                metadata: {
                  title: "Second",
                  artworkAvailable: true,
                  artworkIdentifier: "original",
                },
              },
            ],
          },
        },
      });
      expect(player.playing).toMatchObject({
        title: "Second",
        artwork: true,
        artworkId: "original",
      });
      transport.emit("mrp-message", {
        type: 4, // SetState
        ".setStateMessage": {
          playerPath: { client, player: { identifier: "background" } },
          playbackQueue: {
            contentItems: [{ metadata: { artworkAvailable: false } }],
          },
        },
      });
      transport.emit("mrp-message", {
        type: 56, // UpdateContentItem
        ".updateContentItemMessage": {
          playerPath: path,
          contentItems: [
            { identifier: "first", metadata: { artworkAvailable: false } },
            {
              identifier: "second",
              metadata: { artworkIdentifier: "updated" },
            },
          ],
        },
      });
      expect(player.playing).toMatchObject({
        title: "Second",
        artwork: true,
        artworkId: "updated",
      });
    } finally {
      player.close();
    }
  });

  it("signals a sleep close separately from other closes", async () => {
    let transport!: AirPlayConnection;
    vi.spyOn(AirPlayConnection.prototype, "connect").mockImplementation(
      async function (this: AirPlayConnection) {
        transport = this;
      },
    );
    vi.spyOn(AppleTV.prototype, "getState").mockRejectedValue(idle());
    const player = await open();
    const closed = vi.fn();
    player.on("close", closed);
    transport.emit("mrp-message", {
      type: 38, // SetConnectionState
      ".setConnectionStateMessage": { state: 3 },
    });
    expect(closed).toHaveBeenCalledExactlyOnceWith("sleep");
  });

  it("accepts artwork at the blob limit and discards larger replies", async () => {
    vi.spyOn(AirPlayConnection.prototype, "connect").mockResolvedValue(
      undefined,
    );
    vi.spyOn(AppleTV.prototype, "getState").mockRejectedValue(idle());
    const image = Buffer.alloc(maxBlobBytes + 1);
    image.set([0xff, 0xd8]);
    vi.spyOn(AppleTV.prototype, "requestArtwork")
      .mockResolvedValueOnce(image.subarray(0, maxBlobBytes))
      .mockResolvedValueOnce(image);
    const player = await open();
    try {
      expect((await player.picture())?.data.byteLength).toBe(maxBlobBytes);
      expect(await player.picture()).toBeNull();
    } finally {
      player.close();
    }
  });
});

it("starts Companion pairing when an empty acknowledgement precedes M2", async () => {
  // Stand in for the socket while running the library's real frame reader.
  type Reader = {
    buffer: Buffer;
    openSocket(): Promise<void>;
    writeFrame(): void;
    processFrames(): void;
  };
  const reader = CompanionPairSetup.prototype as unknown as Reader;
  vi.spyOn(reader, "openSocket").mockResolvedValue(undefined);
  vi.spyOn(reader, "writeFrame").mockImplementation(function (this: Reader) {
    const tlv = Buffer.concat([
      Buffer.from([6, 1, 2]),
      Buffer.from([2, 16]),
      Buffer.alloc(16, 1),
      Buffer.from([3, 255]),
      Buffer.alloc(255, 2),
      Buffer.from([3, 129]),
      Buffer.alloc(129, 2),
    ]);
    queueMicrotask(() => {
      this.buffer = encodeFrame(0x01 as FrameType, Buffer.alloc(0));
      this.processFrames();
      this.buffer = encodeFrame(
        FrameType.PS_Next,
        opackEncode(new Map([["_pd", tlv]])),
      );
      this.processFrames();
    });
  });

  const pairing = new CompanionPairSetup("127.0.0.1", 49153);
  try {
    await expect(pairing.start()).resolves.toBeUndefined();
  } finally {
    pairing.destroy();
  }
});

describe("models", () => {
  it("tells Apple TVs and HomePods from other AirPlay devices", () => {
    expect(kindOf("AppleTV14,1")).toBe("tv");
    expect(kindOf("AppleTV5,3")).toBe("tv");
    expect(kindOf("AppleTV3,2")).toBeNull();
    expect(kindOf("AudioAccessory5,1")).toBe("homepod");
    expect(kindOf("Mac16,10")).toBeNull();
  });

  it("names models as Apple sells them", () => {
    expect(modelName("AppleTV6,2")).toBe("Apple TV 4K");
    expect(modelName("AppleTV99,1")).toBe("Apple TV");
    expect(modelName("AudioAccessory6,1")).toBe("HomePod (2nd generation)");
  });
});
