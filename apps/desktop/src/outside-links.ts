// Only Sanctum's docs open from a page, in the browser; nothing else leaves
// the app.
export function isDocsUrl(url: string) {
  try {
    return new URL(url).origin === "https://docs.meetsanctum.com";
  } catch {
    return false;
  }
}
