export type MessagePosition = { id: string; createdAt: string };
function subMillis(iso: string) { return Number((iso.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0").slice(3, 6)); }
export function compareMessagePosition(a: MessagePosition, b: MessagePosition) {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || subMillis(a.createdAt) - subMillis(b.createdAt) || a.id.localeCompare(b.id);
}
