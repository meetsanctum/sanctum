// What a problem notice says: its title, then its line, when it has one.
export function problemLines(alert: Element | null | undefined) {
  if (!alert) return [];
  return [
    ...alert.querySelectorAll(
      "[data-slot=alert-title], [data-slot=alert-description]",
    ),
  ].map((line) => line.textContent);
}
