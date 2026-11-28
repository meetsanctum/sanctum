// Only Sanctum's docs open from a page, in the browser; nothing else leaves
// the app.
export function isDocsUrl(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.origin === "https://docs.meetsanctum.com"
    );
  } catch {
    return false;
  }
}

export function createDocsWindowOpenHandler(
  openExternal: (url: string) => Promise<void>,
  showOpenError: () => void,
) {
  return ({ url }: { url: string }) => {
    if (isDocsUrl(url)) void openExternal(url).catch(showOpenError);
    return { action: "deny" } as const;
  };
}
