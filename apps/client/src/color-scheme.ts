import { useEffect, useState } from "react";

// Whether the device is set to dark, which an app's page follows: Evening
// where it is, Day where it is not. Dashboards and room and category pages
// stay in Evening over their background.

const dark = "(prefers-color-scheme: dark)";

function query() {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(dark)
    : undefined;
}

export function usePrefersDark() {
  const [prefersDark, setPrefersDark] = useState(
    () => query()?.matches ?? true,
  );
  useEffect(() => {
    const media = query();
    if (!media) return;
    const change = () => setPrefersDark(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return prefersDark;
}
