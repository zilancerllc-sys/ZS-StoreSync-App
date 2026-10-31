// app/lib/csv.js
// One CSV cell. A leading = + - @ is neutralised so a value copied from a store
// can't run as a formula when the file is opened in a spreadsheet.
export function csvCell(v) {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
