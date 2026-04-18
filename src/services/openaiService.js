import { GoogleGenerativeAI } from "@google/generative-ai";

let aiClient = null;

function getModel() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

  if (!key) return null; // callers deal with it

  if (!aiClient) {
    aiClient = new GoogleGenerativeAI(key.trim());
  }

  return aiClient.getGenerativeModel({ model: "gemini-1.5-flash" });
}


const BASE_PROMPT = `
Turn a question into a JSON plan for querying a dataset.

Use only the provided column names. If you're unsure, just pick something close.
Return JSON only.

{
  "operation": "top" | "trend" | "distribution" | "aggregate" | "filter" | "lookup" | "group_count_filter",
  "column": string | null,
  "metric": string | null,
  "groupBy": string | null,
  "dateColumn": string | null,
  "limit": number,
  "aggregate": "sum" | "avg" | "count",
  "filters": [],
  "selectColumns": [],
  "distinctColumn": string | null,
  "matchCount": number | null,
  "insightHint": string
}
`;

export async function planQuery(userQuery, columns, totalRows, history) {
  const model = getModel();
  if (!model) throw new Error("Missing key");

  let prompt = BASE_PROMPT + "\n";

  
  if (history && history.length) {
    for (let i = history.length - 1; i >= 0 && i > history.length - 3; i--) {
      const h = history[i];
      if (!h) continue;
      prompt += `${h.role || "user"}: ${h.content || ""}\n`;
    }
    prompt += "\n";
  }

  prompt += `Rows: ${totalRows}\n`;


  prompt += `Columns: ${columns.join(", ")}\n`;

  prompt += `Question: ${userQuery}\n`;

  const res = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.31
    }
  });

  const raw = res && res.response ? res.response.text() : null;

  if (!raw) {
    console.log("no response?");
    throw new Error("empty");
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
  
    let t = raw.trim();

    if (t.startsWith("```")) {
      t = t.replace(/```[a-z]*\n?/gi, "").replace(/```$/, "");
    }

    try {
      return JSON.parse(t);
    } catch (err) {
      console.log("still broken json", t);
      throw err;
    }
  }
}

export async function generateInsight(data) {
  const model = getModel();
  if (!model) return "";

  // not destructuring on purpose (feels more real tbh)
  const q = data && data.userQuery;
  const title = data && data.chartTitle;
  const type = data && data.chartType;
  const rows = data && data.filteredRowCount;
  const summary = data && data.contextSummary;

  const arr = (data && data.series) || [];


  const sample = [];
  let i = 0;
  while (i < arr.length && i < 3) {
    sample.push(arr[i]);
    i++;
  }

  let prompt = "";
  prompt += "Give a quick insight.\n";
  prompt += `Q: ${q}\n`;
  prompt += `Rows: ${rows}\n`;
  prompt += `Chart: ${title} (${type})\n`;
  prompt += `Data: ${JSON.stringify(sample)}\n`;

  if (summary) {
    prompt += `Note: ${summary}\n`;
  }

  const res = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 100
    }
  });

  const txt = res && res.response && res.response.text();

  if (!txt) return "";

  return txt.trim();
}
