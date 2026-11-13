// Shared by both hosts: a stable, local-calendar-day selection, independent of input order.
export function reviewCards<T extends { id: string }>(cards: T[], day: string, limit = 8): T[] {
  const hash = (text: string) => { let value = 2166136261; for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619); return value >>> 0; };
  return [...cards].sort((a, b) => hash(day + a.id) - hash(day + b.id) || a.id.localeCompare(b.id)).slice(0, limit);
}
