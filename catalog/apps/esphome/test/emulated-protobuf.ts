export type FieldValue = number | boolean | string;

// Protocol buffers, as far as the API needs them.
export function varint(value: number) {
  const bytes: number[] = [];
  let rest = value >>> 0;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

export type Spec = { fieldNumber: number; valueType: string };

// As ESPHome does, a field at its default (zero, false, empty) is left out.
export function field(spec: Spec, value: FieldValue): Buffer {
  if (value === 0 || value === false || value === "") return Buffer.alloc(0);
  const tag = (wire: number) => varint((spec.fieldNumber << 3) | wire);
  if (spec.valueType === "float") {
    const out = Buffer.alloc(4);
    out.writeFloatLE(Number(value));
    return Buffer.concat([tag(5), out]);
  }
  if (spec.valueType === "fixed32") {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(Number(value) >>> 0);
    return Buffer.concat([tag(5), out]);
  }
  if (spec.valueType === "string" || spec.valueType === "bytes") {
    const text = Buffer.from(String(value));
    return Buffer.concat([tag(2), varint(text.length), text]);
  }
  return Buffer.concat([tag(0), varint(Number(value))]);
}

export function decode(payload: Buffer) {
  const fields = new Map<number, (number | Buffer)[]>();
  let at = 0;
  const read = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = payload[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
    }
  };
  while (at < payload.length) {
    const tag = read();
    const number = Math.floor(tag / 8);
    const wire = tag & 7;
    let value: number | Buffer;
    if (wire === 0) value = read();
    else if (wire === 5) {
      value = payload.subarray(at, at + 4);
      at += 4;
    } else if (wire === 2) {
      const length = read();
      value = payload.subarray(at, at + length);
      at += length;
    } else throw new Error(`wire type ${wire}`);
    fields.set(number, [...(fields.get(number) ?? []), value]);
  }
  return fields;
}

export function valueOf(
  raw: number | Buffer | undefined,
  valueType: string,
): FieldValue | undefined {
  if (raw === undefined) return undefined;
  if (valueType === "float") return (raw as Buffer).readFloatLE(0);
  if (valueType === "string") return (raw as Buffer).toString();
  if (valueType === "bool") return raw === 1;
  return raw as number;
}

export function nestedMessage(
  name: string,
  spec: { fieldNumber: number; fields: Record<string, Spec> },
  message: Record<string, FieldValue>,
) {
  const inner = Buffer.concat(
    Object.entries(message).map(([key, value]) => {
      const inside = spec.fields[key];
      if (!inside) throw new Error(`${name} has no field ${key}`);
      return field(inside, value);
    }),
  );
  return Buffer.concat([
    varint((spec.fieldNumber << 3) | 2),
    varint(inner.length),
    inner,
  ]);
}
