import { resolveColumn } from "./dataProcessing.js";

/**
 * Prefer a monetary column when the user says revenue / sales / income.
 * @param {string[]} headers
 */
function pickRevenueLikeMetric(headers) {
  const lowerHeaders = headers.map((h) => h.toLowerCase());
  const exactOrder = ["revenue", "sales", "income", "amount", "total", "net", "balance", "price", "value"];
  for (const key of exactOrder) {
    const idx = lowerHeaders.indexOf(key);
    if (idx !== -1) return headers[idx];
  }
  return (
    headers.find((h) => /revenue|sales|income|amount|total|net|balance|price|value/i.test(h)) ?? null
  );
}

/**
 * Prefer a geographic bucket when the user says region.
 * @param {string[]} headers
 */
function pickRegionLikeGroup(headers) {
  const exact = headers.find((h) => h.toLowerCase() === "region");
  if (exact) return { col: exact, note: null };
  const fuzzy = headers.find((h) => /region|territory|geo|zone|area/i.test(h));
  if (fuzzy) return { col: fuzzy, note: null };
  const country = headers.find((h) => /country|nation/i.test(h));
  if (country) {
    return {
      col: country,
      note: `No “region” column in this file; grouped by “${country}” instead`,
    };
  }
  return { col: null, note: null };
}

/**
 * Align plan columns with words in the natural-language question (revenue → total, region → country, etc.).
 * @param {string} message
 * @param {string[]} headers
 * @param {object} plan
 */
export function applyTermMapping(message, headers, plan) {
  if (!plan || typeof plan !== "object") return plan;
  const op = String(plan.operation || "");
  if (op === "lookup" || op === "group_count_filter") return plan;

  const lower = String(message)
    .toLowerCase()
    .replace(/\bwich\b/g, "which");

  const out = { ...plan };
  if (!Array.isArray(out.aliasNotes)) out.aliasNotes = [];

  if (/\b(revenue|sales|income|profit|earnings)\b/.test(lower)) {
    const best = pickRevenueLikeMetric(headers);
    const cur = resolveColumn(headers, out.metric);
    const curLooksMoney =
      cur && /revenue|sales|amount|total|income|price|value|balance|tax|discount|net|fee|cost/i.test(cur);
    if (best && (!cur || !curLooksMoney)) {
      out.metric = best;
    }
    if (/\brevenue\b/.test(lower) && best && !/^revenue$/i.test(String(best))) {
      const msg = `Mapped “revenue” → column “${best}”`;
      if (!out.aliasNotes.includes(msg)) out.aliasNotes.push(msg);
    }
  }

  if (/\bregions?\b/.test(lower)) {
    const { col, note } = pickRegionLikeGroup(headers);
    if (col) {
      out.groupBy = col;
      out.column = col;
      if (note) out.aliasNotes.push(note);
    }
  }

  if (/\brank\b/.test(lower) && (!Number.isFinite(Number(out.limit)) || Number(out.limit) <= 0)) {
    out.limit = 15;
  }

  return out;
}
