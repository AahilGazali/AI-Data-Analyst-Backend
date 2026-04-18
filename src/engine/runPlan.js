import { aggregateData, filterData, groupBy, resolveColumn } from "../utils/dataProcessing.js";

function toNumber(v) {
  if (v == null || v === "") return NaN;
  const n = Number(String(v).replace(/,/g, ""));
  return isFinite(n) ? n : NaN;
}

export function applyFilters(rows, plan, headers) {
  if (!plan || !plan.filters || plan.filters.length === 0) return rows;

  return filterData(rows, (row) => {
    for (let i = 0; i < plan.filters.length; i++) {
      const f = plan.filters[i];
      const col = resolveColumn(headers, f.column);
      if (!col) continue;

      const val = row[col];
      const t = f.value;

      if (f.op === "eq") {
        if (String(val).toLowerCase() !== String(t).toLowerCase()) return false;
      } else if (f.op === "contains") {
        if (!String(val).toLowerCase().includes(String(t).toLowerCase())) return false;
      } else if (f.op === "gt") {
        if (!(toNumber(val) > toNumber(t))) return false;
      } else if (f.op === "lt") {
        if (!(toNumber(val) < toNumber(t))) return false;
      }
    }
    return true;
  });
}

export function executePlan(rows, headers, plan) {
  const data = applyFilters(rows, plan, headers);
  const total = data.length;

  const op = (plan && plan.operation) || "top";
  let limit = plan && plan.limit ? plan.limit : 10;
  if (limit < 1) limit = 1;
  if (limit > 50) limit = 50;

  if (op === "lookup") {
    if (!plan.filters || !plan.filters.length) {
      return { chartType: "none", title: "Lookup", series: [], contextSummary: "Need filters", filteredRowCount: total };
    }

    let cols = [];
    if (plan.selectColumns && plan.selectColumns.length) {
      for (const c of plan.selectColumns) {
        const rc = resolveColumn(headers, c);
        if (rc) cols.push(rc);
      }
    }

    if (!cols.length) cols = headers.slice(0, 5);

    const out = [];
    for (let i = 0; i < data.length && i < 50; i++) {
      const r = data[i];
      const obj = {};
      for (let j = 0; j < cols.length; j++) {
        const c = cols[j];
        obj[c] = r[c];
      }
      out.push(obj);
    }

    return {
      chartType: "table",
      title: `Matches (${total})`,
      series: [],
      tableColumns: cols,
      tableRows: out,
      contextSummary: `Found ${total} rows`,
      filteredRowCount: total
    };
  }

  if (op === "aggregate") {
    const metricCol = resolveColumn(headers, plan.metric);
    if (!metricCol) {
      return { chartType: "none", title: "Aggregate", series: [], contextSummary: "Missing metric", filteredRowCount: total };
    }

    let val = 0;
    if (plan.aggregate === "count") {
      val = total;
    } else {
      const type = plan.aggregate === "avg" ? "avg" : "sum";
      val = aggregateData(data, metricCol, type);
    }

    return {
      chartType: "none",
      title: `${plan.aggregate || "sum"}(${metricCol})`,
      series: [{ name: metricCol, value: val || 0 }],
      contextSummary: "Computed value",
      filteredRowCount: total
    };
  }

  const groupCol = resolveColumn(headers, plan.groupBy || plan.column);
  if (!groupCol) {
    return { chartType: "none", title: "Top", series: [], contextSummary: "Missing group", filteredRowCount: total };
  }

  const map = groupBy(data, groupCol);
  const arr = [];

  for (const [k, grp] of map) {
    let v = grp.length;

    if (plan.metric) {
      const m = resolveColumn(headers, plan.metric);
      if (m) {
        const type = plan.aggregate === "avg" ? "avg" : "sum";
        v = aggregateData(grp, m, type);
      }
    }

    arr.push({ name: k, value: v || 0 });
  }

  arr.sort((a, b) => b.value - a.value);

  return {
    chartType: "bar",
    title: "Top results",
    series: arr.slice(0, limit),
    contextSummary: "Showing top groups",
    filteredRowCount: total
  };
}