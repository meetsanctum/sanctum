import favicon from "@meetsanctum/brand/sanctum-favicon.svg?raw";

// The brand's favicon at the path Starlight links, taken from
// @meetsanctum/brand rather than kept as a copy in public/.
export function GET() {
  return new Response(favicon, {
    headers: { "Content-Type": "image/svg+xml" },
  });
}
