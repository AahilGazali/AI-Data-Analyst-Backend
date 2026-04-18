function clean(text) {
  const t = text == null ? "" : String(text);
  let s = t.toLowerCase();
  s = s.replace(/\bwich\b/g, "which");
  s = s.replace(/[^a-z0-9 ]/g, " ");
  while (s.includes("  ")) s = s.replace(/  /g, " ");
  return s.trim();
}

function toNum(v) {
  if (v == null || v === "") return NaN;
  const str = String(v).replace(/,/g, "");
  const n = Number(str);
  return isFinite(n) ? n : NaN;
}

function inferColumns(headers, rows) {
  const numeric = [];
  const text = [];
  const sample = rows && rows.length > 300 ? rows.slice(0, 300) : rows;

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    let numCount = 0;
    let total = 0;

    for (let j = 0; j < sample.length; j++) {
      const r = sample[j];
      const v = r ? r[h] : undefined;
      if (v == null || v === "") continue;
      total++;
      if (!isNaN(toNum(v))) numCount++;
    }

    if (total && numCount / total > 0.5) numeric.push(h);
    else text.push(h);
  }

  return { numeric, text };
}

function headerInMessage(message, headers) {
  const msg = clean(message);
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const hs = clean(h);
    if (hs && msg.indexOf(hs) !== -1) return h;
  }
  return null;
}

function detectFilters(message, headers, rows, textCols) {
  const msg = clean(message);
  const sample = rows && rows.length > 500 ? rows.slice(0, 500) : rows;
  const filters = [];

  for (let i = 0; i < textCols.length && i < 8; i++) {
    const col = textCols[i];
    const values = new Set();

    for (let j = 0; j < sample.length; j++) {
      const raw = sample[j][col];
      if (raw == null || raw === "") continue;
      values.add(String(raw).trim());
    }

    for (const v of values) {
      const vc = clean(v);
      if (vc.length >= 3 && msg.indexOf(vc) !== -1) {
        filters.push({ column: col, op: "eq", value: v });
        break;
      }
    }
  }

  return filters;
}

export function tryHeuristicGroupCountFilter(message, headers, rows) {
  const msg = clean(message);
  if (!/\bclients?\b/.test(msg)) return null;

  let matchCount = null;
  if (/\bonly 1 client\b|\b1 client\b|\bone client\b/.test(msg)) {
    matchCount = 1;
  } else {
    const m = msg.match(/\b(?:only|exactly|just) (\d+) clients?\b/);
    if (m) matchCount = parseInt(m[1], 10);
  }

  if (!Number.isFinite(matchCount)) return null;

  let groupBy = null;
  for (let i = 0; i < headers.length; i++) {
    if (/country|region|nation/i.test(headers[i])) { groupBy = headers[i]; break; }
  }
  if (!groupBy) {
    for (let i = 0; i < headers.length; i++) {
      if (/city|state|zone|territory/i.test(headers[i])) { groupBy = headers[i]; break; }
    }
  }
  if (!groupBy) return null;

  let distinctColumn = null;
  for (let i = 0; i < headers.length; i++) {
    if (/client|customer|company/i.test(headers[i])) { distinctColumn = headers[i]; break; }
  }

  return {
    operation: "group_count_filter",
    groupBy,
    distinctColumn,
    matchCount,
    limit: 100,
    filters: [],
    selectColumns: [],
    metric: null,
    column: null,
    dateColumn: null,
    aggregate: "count",
    insightHint: "filter groups by client count"
  };
}

export function tryHeuristicLookup(message, headers, rows) {
  const msg = clean(message);

  const asksRows = /\b(show|list|which|who|find|display)\b/.test(msg) || /\bclient|customer|company|invoice|rows?|records?\b/.test(msg);
  if (!asksRows) return null;
  if (/\btop \d+\b|\btrend\b|\bdistribution\b|\brank\b/.test(msg)) return null;

  const cols = inferColumns(headers, rows).text;
  const filters = detectFilters(message, headers, rows, cols.length ? cols : headers);
  if (!filters.length) return null;

  let selectColumns = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const hs = clean(h);
    if (hs && (msg.indexOf(hs) !== -1 || /client|customer|company|invoice|country|service|status/i.test(h))) {
      selectColumns.push(h);
    }
  }

  if (!selectColumns.length) {
    const set = new Set();
    for (let i = 0; i < filters.length; i++) set.add(filters[i].column);
    for (let i = 0; i < 4 && i < headers.length; i++) set.add(headers[i]);
    selectColumns = Array.from(set);
  }

  return {
    operation: "lookup",
    filters,
    selectColumns: selectColumns.slice(0, 12),
    limit: 50,
    metric: null,
    column: null,
    groupBy: null,
    dateColumn: null,
    aggregate: "sum",
    insightHint: "lookup rows"
  };
}

export function heuristicPlan(message, headers, rows) {
  const a = tryHeuristicGroupCountFilter(message, headers, rows);
  if (a) return a;

  const b = tryHeuristicLookup(message, headers, rows);
  if (b) return b;

  const msg = clean(message);
  const cols = inferColumns(headers, rows);

  let operation = "top";
  if (/\b(trend|over time|time series|monthly|daily)\b/.test(msg)) operation = "trend";
  else if (/\b(distribution|breakdown|share|split|pie)\b/.test(msg)) operation = "distribution";
  else if (/\b(sum|total|average|avg|mean|count)\b/.test(msg) && !/\btop\b/.test(msg)) operation = "aggregate";

  let metric = headerInMessage(message, headers);
  if (!metric || cols.numeric.indexOf(metric) === -1) {
    metric = null;
    for (let i = 0; i < cols.numeric.length; i++) {
      if (/total|amount|revenue|sales|balance|tax|discount/i.test(cols.numeric[i])) {
        metric = cols.numeric[i];
        break;
      }
    }
    if (!metric) metric = cols.numeric[0] || null;
  }

  let groupBy = null;
  const m = msg.match(/\bby ([a-z0-9 ]+?)(?:\bfor\b|\bwhere\b|$)/);
  if (m) {
    const phrase = clean(m[1]);
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (phrase.indexOf(clean(h)) !== -1 || clean(h).indexOf(phrase) !== -1) {
        groupBy = h;
        break;
      }
    }
  }

  if (!groupBy) {
    groupBy = headerInMessage(message, headers);
    if (groupBy === metric) groupBy = null;
  }

  if (!groupBy) {
    for (let i = 0; i < cols.text.length; i++) {
      if (cols.text[i] !== metric) { groupBy = cols.text[i]; break; }
    }
    if (!groupBy) {
      for (let i = 0; i < headers.length; i++) {
        if (headers[i] !== metric) { groupBy = headers[i]; break; }
      }
    }
    if (!groupBy) groupBy = headers[0] || null;
  }

  const filters = detectFilters(message, headers, rows, cols.text.length ? cols.text : headers);

  let limit = 10;
  const lm = msg.match(/\btop (\d+)\b|\bfirst (\d+)\b/);
  if (lm) limit = Math.min(50, Math.max(1, parseInt(lm[1] || lm[2], 10)));

  let aggregate = "sum";
  if (/\b(avg|average|mean)\b/.test(msg)) aggregate = "avg";
  else if (/\bcount\b/.test(msg)) aggregate = "count";

  return {
    operation,
    column: groupBy,
    groupBy,
    metric,
    dateColumn: headers.find(h => /date|time|month|year|period/i.test(h)) || null,
    limit,
    aggregate,
    filters,
    insightHint: "heuristic fallback"
  };
}

export function summarizeLocally(result, message) {
  if (Array.isArray(result.tableRows) && result.tableRows.length) {
    return `For "${message}", found ${result.filteredRowCount || result.tableRows.length} matching row(s).`;
  }

  const pts = Array.isArray(result.series) ? result.series : [];
  if (!pts.length) {
    return `For "${message}", no matching values were found with current columns/filters.`;
  }

  const arr = pts.slice();
  arr.sort((a, b) => Number(b.value) - Number(a.value));

  const top = [];
  for (let i = 0; i < arr.length && i < 3; i++) top.push(arr[i]);

  return `${result.title || "Result"}: ${top.map(x => `${x.name} (${x.value})`).join(", ")}.`;
}
