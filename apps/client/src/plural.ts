/** A count and its noun, "1 light" or "3 lights": `several` where the plural isn't the noun and an s. */
export const plural = (count: number, one: string, several = `${one}s`) =>
  `${count} ${count === 1 ? one : several}`;
