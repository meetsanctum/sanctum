import postcss from "postcss";
import semver from "semver";

export const hasMotionVariants = (version: string) =>
  semver.satisfies(version, ">=0.1.28", { includePrerelease: true });

// Older builds put Tailwind's motion utilities under an OS media query.
// Give those same rules the frame's preference without changing specificity.
export function pageMotionCss(css: string): string | undefined {
  if (!css.includes("prefers-reduced-motion")) return undefined;
  let stylesheet;
  try {
    stylesheet = postcss.parse(css);
  } catch (error) {
    if (error instanceof Error && error.name === "CssSyntaxError") {
      return undefined;
    }
    throw error;
  }
  let changed = false;
  stylesheet.walkAtRules("media", (media) => {
    const mode =
      /^\(\s*prefers-reduced-motion\s*:\s*(reduce|no-preference)\s*\)$/.exec(
        media.params,
      )?.[1];
    if (
      !mode ||
      !media.nodes?.every(
        (node) => node.type === "rule" || node.type === "comment",
      )
    )
      return;
    const scope =
      mode === "reduce"
        ? ':where(:root[data-motion="reduced"])'
        : ':where(:root:not([data-motion="reduced"]))';
    for (const node of media.nodes) {
      if (node.type === "rule") {
        node.selectors = node.selectors.map(
          (selector) => `${scope} ${selector}`,
        );
      }
    }
    media.replaceWith(...media.nodes);
    changed = true;
  });
  return changed ? stylesheet.toString() : undefined;
}
