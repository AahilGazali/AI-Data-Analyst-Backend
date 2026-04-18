import { resolveColumn } from "./dataProcessing.js";

/**
 * @param {string[]} headers
 * @param {object} plan
 */
export function sanitizePlan(headers, plan) {
  if (!plan || typeof plan !== "object") return {};
  const out = { ...plan };
  const r = (name) => resolveColumn(headers, name);
  out.groupBy = r(out.groupBy);
  out.metric = r(out.metric);
  out.column = r(out.column);
  out.dateColumn = r(out.dateColumn);
  out.distinctColumn = r(out.distinctColumn);
  const mc = Number(out.matchCount);
  out.matchCount = Number.isFinite(mc) ? mc : null;
  if (Array.isArray(out.filters)) {
    out.filters = out.filters
      .map((f) => ({
        ...f,
        column: r(f.column),
      }))
      .filter((f) => f.column && f.op && f.value !== undefined && f.value !== "");
  } else {
    out.filters = [];
  }
  if (Array.isArray(out.selectColumns)) {
    out.selectColumns = out.selectColumns.map((c) => r(c)).filter(Boolean);
  } else {
    out.selectColumns = [];
  }
  const lim = Number(out.limit);
  if (out.operation === "lookup" || out.operation === "group_count_filter") {
    out.limit = Number.isFinite(lim) && lim > 0 ? Math.min(100, lim) : 50;
  } else {
    out.limit = Number.isFinite(lim) && lim > 0 ? lim : 10;
  }
  return out;
}
