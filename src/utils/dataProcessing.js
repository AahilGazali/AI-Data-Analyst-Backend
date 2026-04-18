export function filterData(rows, predicate) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (predicate(r)) out.push(r);
  }
  return out;
}

export function groupBy(rows, keyColumn) {
  const map = new Map();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const key = String(row && row[keyColumn] != null ? row[keyColumn] : "");
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(row);
  }
  return map;
}

function toNumber(v) {
  if (v == null || v === "") return NaN;
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  const s = String(v).replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export function aggregateData(rows, metricColumn, op) {
  if (op === "count") return rows.length;

  const nums = [];
  for (let i = 0; i < rows.length; i++) {
    const n = toNumber(rows[i] && rows[i][metricColumn]);
    if (!Number.isNaN(n)) nums.push(n);
  }

  if (!nums.length) return 0;

  let sum = 0;
  for (let i = 0; i < nums.length; i++) sum += nums[i];

  if (op === "sum") return sum;
  if (op === "avg") return sum / nums.length;
  return 0;
}

export function resolveColumn(headers, name) {
  if (!name) return null;

  for (let i = 0; i < headers.length; i++) {
    if (headers[i] === name) return headers[i];
  }

  const lower = String(name).toLowerCase();

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (h && h.toLowerCase() === lower) return h;
  }

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (h && h.toLowerCase().indexOf(lower) !== -1) return h;
  }

  return null;
}
