// A FLAC encoder for speech as it is made: 16-bit mono PCM in, FLAC out a
// block at a time, so a speaker can start playing while the rest is still
// being spoken. Smart speakers such as the Voice PE play announcements only
// as FLAC or MP3, and FLAC needs no codec library: each block takes the
// best of the format's fixed predictors and Rice-codes what they miss.
// The stream's length isn't known when it starts, so its STREAMINFO leaves
// the total, the frame sizes and the MD5 unset, as the format allows.

const blockSize = 4096;
const bitsPerSample = 16;
const maxRiceParameter = 14;
const maxPartitionOrder = 8;

/** Sample rates a frame header can name itself, by their codes. */
const rateCodes = new Map([
  [88_200, 1],
  [176_400, 2],
  [192_000, 3],
  [8_000, 4],
  [16_000, 5],
  [22_050, 6],
  [24_000, 7],
  [32_000, 8],
  [44_100, 9],
  [48_000, 10],
  [96_000, 11],
]);

const crc8Table = new Uint8Array(256);
const crc16Table = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c8 = i;
  let c16 = i << 8;
  for (let bit = 0; bit < 8; bit++) {
    c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff;
    c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff;
  }
  crc8Table[i] = c8;
  crc16Table[i] = c16;
}

function crc8(bytes: Uint8Array, end: number) {
  let crc = 0;
  for (let i = 0; i < end; i++) crc = crc8Table[crc ^ bytes[i]!]!;
  return crc;
}

function crc16(bytes: Uint8Array, end: number) {
  let crc = 0;
  for (let i = 0; i < end; i++) {
    crc = ((crc << 8) & 0xffff) ^ crc16Table[(crc >> 8) ^ bytes[i]!]!;
  }
  return crc;
}

/** Writes bits most significant first, growing as it goes. */
class BitWriter {
  bytes = new Uint8Array(16_384);
  length = 0;
  private acc = 0;
  private held = 0;

  private room(more: number) {
    if (this.length + more <= this.bytes.length) return;
    const grown = new Uint8Array(
      Math.max(this.bytes.length * 2, this.length + more),
    );
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  /** Writes the low `count` bits of `value`, at most 24 at a time. */
  write(value: number, count: number) {
    if (count === 0) return;
    this.acc = (this.acc << count) | (value & ((1 << count) - 1));
    this.held += count;
    this.room(4);
    while (this.held >= 8) {
      this.held -= 8;
      this.bytes[this.length++] = (this.acc >>> this.held) & 0xff;
    }
    this.acc &= (1 << this.held) - 1;
  }

  /** Writes `zeros` zero bits and then a one. */
  unary(zeros: number) {
    while (zeros >= 24) {
      this.write(0, 24);
      zeros -= 24;
    }
    this.write(1, zeros + 1);
  }

  /** Pads with zero bits to the next byte. */
  align() {
    if (this.held > 0) this.write(0, 8 - this.held);
  }

  take() {
    const out = this.bytes.slice(0, this.length);
    this.length = 0;
    return out;
  }
}

/** The stream's start: its marker and a STREAMINFO block, the last. */
function streamHeader(sampleRate: number) {
  const out = new BitWriter();
  for (const byte of [0x66, 0x4c, 0x61, 0x43]) out.write(byte, 8);
  out.write(1, 1);
  out.write(0, 7);
  out.write(34, 24);
  out.write(blockSize, 16);
  out.write(blockSize, 16);
  out.write(0, 24);
  out.write(0, 24);
  out.write(sampleRate, 20);
  out.write(0, 3);
  out.write(bitsPerSample - 1, 5);
  // The total samples, unknown while the stream is made.
  out.write(0, 4);
  out.write(0, 16);
  out.write(0, 16);
  for (let i = 0; i < 16; i++) out.write(0, 8);
  return out.take();
}

/** The residual of fixed predictor `order` for sample `i`. */
function residualAt(x: Int32Array, i: number, order: number) {
  switch (order) {
    case 0:
      return x[i]!;
    case 1:
      return x[i]! - x[i - 1]!;
    case 2:
      return x[i]! - 2 * x[i - 1]! + x[i - 2]!;
    case 3:
      return x[i]! - 3 * x[i - 1]! + 3 * x[i - 2]! - x[i - 3]!;
    default:
      return x[i]! - 4 * x[i - 1]! + 6 * x[i - 2]! - 4 * x[i - 3]! + x[i - 4]!;
  }
}

function zigzag(value: number) {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

type Residual = {
  order: number;
  folded: Uint32Array;
  partitionOrder: number;
  parameters: number[];
  bits: number;
};

/**
 * The fixed predictor and Rice partitioning that code a block in fewest
 * bits. Each predictor's residuals are summed once per Rice parameter over
 * the finest partitions, and coarser ones add those sums up, so the search
 * costs a few passes over the block, not one per partitioning.
 */
function bestResidual(x: Int32Array, n: number): Residual {
  let best: Residual | null = null;
  for (let order = 0; order <= 4 && order < n; order++) {
    const folded = new Uint32Array(n);
    for (let i = order; i < n; i++) folded[i] = zigzag(residualAt(x, i, order));
    let finest = 0;
    while (
      finest < maxPartitionOrder &&
      n % (1 << (finest + 1)) === 0 &&
      n >> (finest + 1) > order
    ) {
      finest++;
    }
    const parts = 1 << finest;
    const size = n >> finest;
    // sums[k * parts + j]: the quotients at parameter k in finest partition j.
    const sums = new Float64Array((maxRiceParameter + 1) * parts);
    for (let j = 0; j < parts; j++) {
      const from = j === 0 ? order : j * size;
      for (let i = from; i < (j + 1) * size; i++) {
        const u = folded[i]!;
        for (let k = 0; k <= maxRiceParameter; k++) {
          sums[k * parts + j]! += u >>> k;
        }
      }
    }
    for (let p = finest; p >= 0; p--) {
      const span = 1 << (finest - p);
      const parameters: number[] = [];
      let bits = order * bitsPerSample + 2 + 4;
      for (let part = 0; part < 1 << p; part++) {
        const count = (n >> p) - (part === 0 ? order : 0);
        let partBest = Infinity;
        let parameter = 0;
        for (let k = 0; k <= maxRiceParameter; k++) {
          let partBits = count * (k + 1);
          for (let j = part * span; j < (part + 1) * span; j++) {
            partBits += sums[k * parts + j]!;
          }
          if (partBits < partBest) {
            partBest = partBits;
            parameter = k;
          }
        }
        parameters.push(parameter);
        bits += 4 + partBest;
      }
      if (!best || bits < best.bits) {
        best = { order, folded, partitionOrder: p, parameters, bits };
      }
    }
  }
  return best!;
}

/** Codes one block as a frame, its header and CRCs included. */
function encodeFrame(
  out: BitWriter,
  x: Int32Array,
  n: number,
  frame: number,
  sampleRate: number,
) {
  const start = out.length;
  out.write(0b11111111111110, 14);
  out.write(0, 1);
  out.write(0, 1);
  const sizeCode = n === blockSize ? 12 : n <= 256 ? 6 : 7;
  out.write(sizeCode, 4);
  out.write(rateCodes.get(sampleRate) ?? 0, 4);
  out.write(0, 4);
  out.write(0b100, 3);
  out.write(0, 1);
  writeFrameNumber(out, frame);
  if (sizeCode === 6) out.write(n - 1, 8);
  if (sizeCode === 7) out.write(n - 1, 16);
  out.write(crc8(out.bytes.subarray(start), out.length - start), 8);

  let constant = true;
  for (let i = 1; i < n && constant; i++) constant = x[i] === x[0];
  if (constant) {
    out.write(0, 8);
    out.write(x[0]!, bitsPerSample);
  } else {
    const residual = bestResidual(x, n);
    if (residual.bits >= n * bitsPerSample) {
      out.write(0b00000010, 8);
      for (let i = 0; i < n; i++) out.write(x[i]!, bitsPerSample);
    } else {
      out.write((0b001000 | residual.order) << 1, 8);
      for (let i = 0; i < residual.order; i++) out.write(x[i]!, bitsPerSample);
      out.write(0, 2);
      out.write(residual.partitionOrder, 4);
      const size = n >> residual.partitionOrder;
      residual.parameters.forEach((k, part) => {
        out.write(k, 4);
        const from = part === 0 ? residual.order : part * size;
        for (let i = from; i < (part + 1) * size; i++) {
          const u = residual.folded[i]!;
          out.unary(u >>> k);
          out.write(u, k);
        }
      });
    }
  }
  out.align();
  const end = out.length;
  out.write(crc16(out.bytes.subarray(start), end - start), 16);
}

/** A frame's number in FLAC's UTF-8-like coding. */
function writeFrameNumber(out: BitWriter, frame: number) {
  if (frame < 0x80) {
    out.write(frame, 8);
    return;
  }
  let continuation = 1;
  while (frame >= 2 ** (6 * continuation + (6 - continuation))) continuation++;
  const lead = (0xff << (7 - continuation)) & 0xff;
  out.write(lead | Math.floor(frame / 2 ** (6 * continuation)), 8);
  for (let i = continuation - 1; i >= 0; i--) {
    out.write(0x80 | (Math.floor(frame / 2 ** (6 * i)) & 0x3f), 8);
  }
}

/**
 * Encodes 16-bit mono PCM at `sampleRate` as FLAC while it comes: `push`
 * returns the bytes for every block it completes, the stream's header
 * first, and `end` the rest.
 */
export function createFlacEncoder(sampleRate: number) {
  const out = new BitWriter();
  const pending = new Int32Array(blockSize);
  let filled = 0;
  let frame = 0;
  let encodedSamples = 0;
  let started = false;
  let ended = false;

  function header() {
    if (started) return new Uint8Array(0);
    started = true;
    return streamHeader(sampleRate);
  }

  function concat(head: Uint8Array, body: Uint8Array) {
    if (head.length === 0) return body;
    const joined = new Uint8Array(head.length + body.length);
    joined.set(head);
    joined.set(body, head.length);
    return joined;
  }

  function writeBlock() {
    encodeFrame(out, pending, filled, frame++, sampleRate);
    encodedSamples += filled;
    filled = 0;
  }

  return {
    encodedSamples: () => encodedSamples,
    push(samples: Int16Array) {
      if (ended) throw new Error("The stream has ended");
      const head = header();
      for (let i = 0; i < samples.length; i++) {
        pending[filled++] = samples[i]!;
        if (filled === blockSize) writeBlock();
      }
      return concat(head, out.take());
    },
    end() {
      if (ended) return new Uint8Array(0);
      ended = true;
      const head = header();
      if (filled > 0) writeBlock();
      return concat(head, out.take());
    },
  };
}
