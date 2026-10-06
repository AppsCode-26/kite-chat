// Small helpers shared by the backends and the UI.

/** Local calendar day as YYYY-MM-DD — the id of a usage document. */
export function dayKey(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
