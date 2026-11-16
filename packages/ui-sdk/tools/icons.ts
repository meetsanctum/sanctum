import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parseAst, type Plugin } from "vite";

// Lucide's icons, one module each in the kit. ui-sdk's `icons` holds all of
// them, 1,900 in all, which as one module would be most of the kit, so a
// page names each icon it uses, as `icons.Check`, and its build turns each
// into an import of that icon's own module, `@meetsanctum/ui-sdk/icons/check.js`.

const require = createRequire(import.meta.url);

export const sdkModule = "@meetsanctum/ui-sdk";
export const iconModules = `${sdkModule}/icons/`;

/** Where lucide-react's files are. */
export function lucideDir() {
  return dirname(require.resolve("lucide-react/package.json"));
}

/** Each of Lucide's icons by every name it exports, to the file that holds it. */
export function lucideIcons(): ReadonlyMap<string, string> {
  const index = readFileSync(
    join(lucideDir(), "dist/esm/lucide-react.mjs"),
    "utf8",
  );
  const icons = new Map<string, string>();
  for (const [, names, file] of index.matchAll(
    /export \{([^}]+)\} from '\.\/icons\/([a-z0-9-]+)\.mjs'/g,
  )) {
    for (const [, name] of names!.matchAll(/default as (\w+)/g)) {
      icons.set(name!, file!);
    }
  }
  if (icons.size === 0) {
    throw new Error("Found none of Lucide's icons in lucide-react");
  }
  return icons;
}

type Node = { type: string; start: number; end: number } & Record<
  string,
  unknown
>;

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Node).type === "string"
  );
}

// Every node with its parent and the key that holds it.
function* walk(
  node: Node,
  parent?: Node,
  key?: string,
): Generator<{ node: Node; parent?: Node; key?: string }> {
  yield { node, ...(parent ? { parent } : {}), ...(key ? { key } : {}) };
  for (const [childKey, child] of Object.entries(node)) {
    if (Array.isArray(child)) {
      for (const each of child) {
        if (isNode(each)) yield* walk(each, node, childKey);
      }
    } else if (isNode(child)) {
      yield* walk(child, node, childKey);
    }
  }
}

const nameOf = (node: Node) =>
  node.type === "Identifier" ? (node.name as string) : String(node.value);

/**
 * Turns each `icons.Name` in a module into an import of that icon's own
 * module. Anything else done with `icons`, such as `icons[name]`, can't
 * be served icon by icon, so it fails the build.
 */
export function transformIcons(
  code: string,
  id: string,
  icons: ReadonlyMap<string, string>,
): string | undefined {
  if (!code.includes(sdkModule)) return undefined;
  const program = parseAst(code) as unknown as Node;
  let local: string | undefined;
  let declaration: Node | undefined;
  for (const { node } of walk(program)) {
    const source = node.source as Node | undefined;
    if (source?.value !== sdkModule) continue;
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers as Node[]) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          throw new Error(
            `${id}: import what it uses from ${sdkModule} by name, so its icons can be found`,
          );
        }
        if (
          specifier.type === "ImportSpecifier" &&
          nameOf(specifier.imported as Node) === "icons"
        ) {
          local = nameOf(specifier.local as Node);
          declaration = node;
        }
      }
    } else if (
      (node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      code.slice(node.start, node.end).includes("icons")
    ) {
      throw new Error(`${id}: re-exports ui-sdk's icons, which pages can't`);
    }
  }
  if (!local || !declaration) return undefined;

  const used = new Set<string>();
  const edits: { start: number; end: number; text: string }[] = [];
  for (const { node, parent, key } of walk(program)) {
    if (node.type !== "Identifier" || node.name !== local) continue;
    if (!parent) continue;
    // The import itself, and property names that only look like it.
    if (parent.type === "ImportSpecifier") continue;
    if (
      parent.type === "MemberExpression" &&
      key === "property" &&
      !parent.computed
    ) {
      continue;
    }
    if (
      (parent.type === "Property" ||
        parent.type === "MethodDefinition" ||
        parent.type === "PropertyDefinition") &&
      key === "key" &&
      !parent.computed &&
      !parent.shorthand
    ) {
      continue;
    }
    const property = parent.property as Node | undefined;
    if (
      parent.type === "MemberExpression" &&
      key === "object" &&
      !parent.computed &&
      property?.type === "Identifier"
    ) {
      const name = property.name as string;
      if (!icons.has(name)) {
        throw new Error(`${id}: icons.${name} isn't one of Lucide's icons`);
      }
      used.add(name);
      edits.push({
        start: parent.start,
        end: parent.end,
        text: `__sanctum_icon_${name}`,
      });
      continue;
    }
    throw new Error(
      `${id}: name each icon it uses, as ${local}.Check, so the page loads only those`,
    );
  }

  // The import without `icons`, and one import per icon used.
  const kept = (declaration.specifiers as Node[]).filter(
    (specifier) =>
      !(
        specifier.type === "ImportSpecifier" &&
        nameOf(specifier.imported as Node) === "icons"
      ),
  );
  const named = kept.map((specifier) => {
    const imported = nameOf(specifier.imported as Node);
    const as = nameOf(specifier.local as Node);
    return imported === as ? as : `${imported} as ${as}`;
  });
  const iconImports = [...used]
    .sort()
    .map(
      (name) =>
        `import __sanctum_icon_${name} from "${iconModules}${icons.get(name)}.js";`,
    );
  edits.push({
    start: declaration.start,
    end: declaration.end,
    text: [
      ...(named.length > 0
        ? [`import { ${named.join(", ")} } from "${sdkModule}";`]
        : []),
      ...iconImports,
    ].join("\n"),
  });

  let out = code;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/** The page build's step that turns `icons.Name` into its icon's module. */
export function iconImports(
  icons: ReadonlyMap<string, string> = lucideIcons(),
): Plugin {
  return {
    name: "sanctum-icon-imports",
    enforce: "post",
    transform(code, id) {
      const path = id.split("?")[0]!;
      if (path.includes("/node_modules/") || !/\.[cm]?[jt]sx?$/.test(path)) {
        return null;
      }
      const out = transformIcons(code, id, icons);
      return out === undefined ? null : { code: out, map: null };
    },
  };
}
