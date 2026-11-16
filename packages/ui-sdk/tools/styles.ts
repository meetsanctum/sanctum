// A page's stylesheet loads after the kit's, in a frame where both apply.
// Each is Tailwind's output for the classes it found, in Tailwind's order,
// so a utility in both would come twice, and the page's copy, coming later,
// would undo the order the kit's has on ui-sdk's own elements: a page that
// uses `m-0` would take `mt-auto` off a card that has both. So a page's
// stylesheet leaves out every rule of its utilities that the kit's already
// has, word for word, and each utility comes once across the two.
//
// What two stylesheets can't keep is Tailwind's order between a page's own
// utility and a later one the kit has: on a page's element with
// `m-[13px] mt-auto`, the page's margin comes after the kit's `mt-auto` and
// wins. Carrying every utility ui-sdk uses in each page would keep it, at
// about 45 KB a page; pages avoid the mix instead.

type Item = { text: string; prelude?: string; body?: string };

// The items of a block of CSS: rules and at-rules with their blocks, and
// statements, as they stand.
function itemsOf(block: string): Item[] {
  const items: Item[] = [];
  let start = 0;
  let depth = 0;
  let open = -1;
  let quote: string | undefined;
  for (let at = 0; at < block.length; at++) {
    const character = block[at]!;
    if (character === "\\") {
      at++;
    } else if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      if (depth === 0) open = at;
      depth++;
    } else if (character === "}") {
      depth--;
      if (depth === 0) {
        items.push({
          text: block.slice(start, at + 1),
          prelude: block.slice(start, open).trim(),
          body: block.slice(open + 1, at),
        });
        start = at + 1;
      }
    } else if (character === ";" && depth === 0) {
      items.push({ text: block.slice(start, at + 1) });
      start = at + 1;
    }
  }
  const rest = block.slice(start);
  if (rest.trim()) items.push({ text: rest });
  return items;
}

// At-rules that group rules, whose rules are compared one by one. A layer
// without a name is a layer of its own in each stylesheet, so it's never
// the kit's: it stays as it is.
const isGroup = (item: Item) =>
  item.body !== undefined &&
  /^@(media|supports|container|layer\s+[\w.-])/.test(item.prelude!);
const isOwnLayer = (item: Item) =>
  item.body !== undefined && item.prelude === "@layer";

const utilities = (css: string) =>
  itemsOf(css).filter((item) => item.prelude === "@layer utilities");

// Each rule of a block, keyed by the groups it's in and its text.
function rulesOf(block: string, within: string, into: Set<string>) {
  for (const item of itemsOf(block)) {
    if (isOwnLayer(item)) continue;
    if (isGroup(item)) rulesOf(item.body!, `${within}${item.prelude}\n`, into);
    else into.add(`${within}${item.text}`);
  }
}

function leaveOut(block: string, within: string, kit: Set<string>): string {
  return itemsOf(block)
    .map((item) => {
      if (isOwnLayer(item)) return item.text;
      if (!isGroup(item))
        return kit.has(`${within}${item.text}`) ? "" : item.text;
      const body = leaveOut(item.body!, `${within}${item.prelude}\n`, kit);
      return body.trim() ? `${item.prelude}{${body}}` : "";
    })
    .join("");
}

/** A page's stylesheet without the utilities the kit's stylesheet already has. */
export function withoutKitRules(css: string, kitCss: string): string {
  const kit = new Set<string>();
  for (const layer of utilities(kitCss)) rulesOf(layer.body!, "", kit);
  return itemsOf(css)
    .map((item) => {
      if (item.prelude !== "@layer utilities") return item.text;
      const body = leaveOut(item.body!, "", kit);
      return body.trim() ? `${item.prelude}{${body}}` : "";
    })
    .join("");
}
