/** ESPHome normalizes RGB channels against the strongest channel. */
export function ringRgb(colour: string) {
  const r = parseInt(colour.slice(1, 3), 16);
  const g = parseInt(colour.slice(3, 5), 16);
  const b = parseInt(colour.slice(5, 7), 16);
  const strongest = Math.max(r, g, b);
  return strongest === 0
    ? { r: 1, g: 1, b: 1 }
    : { r: r / strongest, g: g / strongest, b: b / strongest };
}

export function ringColourDistance(a: string, b: string) {
  const first = ringRgb(a);
  const second = ringRgb(b);
  return (
    (Math.abs(first.r - second.r) +
      Math.abs(first.g - second.g) +
      Math.abs(first.b - second.b)) *
    255
  );
}
