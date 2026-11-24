import {
  AppleTV,
  CompanionPairSetup,
  encodeFrame,
  FrameType,
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
    ["Pair-verify M4 error: 2", PairingLost],
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
});

describe("Companion connection", () => {
  async function connect() {
    const box = new FakeBox({ deviceId: "6E:D2:21:38:B4:95", name: "TV" });
    const keys = await box.pair("companion").finish(box.code("companion"));
    return createBoxes().connect(
      {
        deviceId: box.deviceId,
        name: box.name,
        model: box.model,
        address: box.address,
        airplayPort: 7000,
        companionAddress: box.address,
        companionPort: 49153,
      },
      keys,
    );
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
