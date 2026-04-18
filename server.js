import "./loadEnv.js";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import multer from "multer";
import Papa from "papaparse";
import { v4 as uuidv4 } from "uuid";
import { planQuery, generateInsight } from "./src/services/openaiService.js";
import { heuristicPlan, summarizeLocally, tryHeuristicLookup, tryHeuristicGroupCountFilter } from "./src/services/heuristicPlanner.js";
import { executePlan } from "./src/engine/runPlan.js";
import { sanitizePlan } from "./src/utils/planSanitizer.js";
import { applyTermMapping } from "./src/utils/termMapping.js";
import { registerAuthRoutes, requireAuth } from "./src/authSetup.js";

const app = express();
const PORT = Number(process.env.PORT) || 5000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || "").toLowerCase();
    const ok = file.mimetype === "text/csv" || name.endsWith(".csv");
    cb(null, ok);
  },
});

const datasets = new Map();

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
registerAuthRoutes(app);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasAI: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    provider: "gemini",
  });
});

app.post("/api/upload", requireAuth, upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No CSV file provided (field name: file)" });
    }

    const text = req.file.buffer.toString("utf8");
    const parsed = Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
    });

    if (parsed.errors && parsed.errors.length) {
      let fatal = null;
      for (let i = 0; i < parsed.errors.length; i++) {
        const e = parsed.errors[i];
        if (e.type === "Quotes" || e.type === "Delimiter") {
          fatal = e;
          break;
        }
      }
      if (fatal) {
        return res.status(400).json({ error: `CSV parse error: ${fatal.message}` });
      }
    }

    const rows = parsed.data || [];
    const headers = (parsed.meta && parsed.meta.fields ? parsed.meta.fields : []).filter(Boolean);

    if (!headers.length || !rows.length) {
      return res.status(400).json({ error: "CSV has no rows or headers" });
    }

    const uploadId = uuidv4();

    datasets.set(uploadId, {
      headers,
      rows,
      name: req.file.originalname || "dataset.csv",
      uploadedAt: Date.now(),
      ownerId: req.user.id,
    });

    const previewRows = rows.slice(0, 150);

    return res.json({
      uploadId,
      fileName: req.file.originalname,
      rowCount: rows.length,
      columnCount: headers.length,
      columns: headers,
      previewRows,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Upload failed" });
  }
});

function applyKeywordHints(q, plan) {
  if (!plan) return plan;
  if (plan.operation === "lookup" || plan.operation === "group_count_filter") return plan;

  const lower = String(q || "").toLowerCase();
  const next = { ...plan };

  if (lower.indexOf("trend") !== -1 || lower.indexOf("over time") !== -1) {
    next.operation = "trend";
  } else if (lower.indexOf("distribution") !== -1 || lower.indexOf("breakdown") !== -1 || lower.indexOf("share") !== -1) {
    next.operation = "distribution";
  } else if (lower.indexOf("top") !== -1 || lower.indexOf("rank") !== -1 || lower.indexOf("highest") !== -1) {
    next.operation = "top";
  }

  return next;
}

app.post("/api/query", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const uploadId = body.uploadId;
    const message = body.message;
    const history = body.history;

    if (!uploadId || typeof uploadId !== "string") {
      return res.status(400).json({ error: "uploadId is required" });
    }
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }

    const ds = datasets.get(uploadId);
    if (!ds || ds.ownerId !== req.user.id) {
      return res.status(404).json({ error: "Dataset not found. Upload a CSV again." });
    }

    let chatHistory = [];
    if (Array.isArray(history)) {
      for (let i = 0; i < history.length; i++) {
        const h = history[i];
        chatHistory.push({
          role: h.role,
          content: typeof h.content === "string" ? h.content : "",
        });
      }
    }

    let planFallback = false;
    let aiPlan;

    try {
      aiPlan = await planQuery(message, ds.headers, ds.rows.length, chatHistory);
    } catch (e) {
      planFallback = true;
      console.warn("[query] Gemini plan failed, using local heuristics:", e && e.message ? e.message : e);
      aiPlan = heuristicPlan(message, ds.headers, ds.rows);
    }

    const countPlan = tryHeuristicGroupCountFilter(message, ds.headers, ds.rows);
    if (countPlan && countPlan.matchCount != null && countPlan.groupBy) {
      const weak = !aiPlan || ["top", "aggregate", "filter"].indexOf(String(aiPlan.operation)) !== -1;
      if (planFallback || weak) {
        aiPlan = countPlan;
      }
    }

    const lookupCandidate = tryHeuristicLookup(message, ds.headers, ds.rows);
    if (lookupCandidate && lookupCandidate.filters && lookupCandidate.filters.length) {
      const low = message.toLowerCase();
      const looksRowLevel = /\b(client|customer|company|vendor|who|which|invoice)\b/.test(low) ||
        (/\b(show|list|records?|rows?|entries)\b/.test(low) && /\b(where|for|of)\b/.test(low));

      const notRanking = !/\btop\s+\d+\b/.test(low) && !/\b(highest|lowest|ranking|distribution|trend|over time)\b/.test(low);

      const weakOp = !planFallback && aiPlan && ["top", "aggregate", "filter"].indexOf(String(aiPlan.operation)) !== -1;

      if (looksRowLevel && notRanking && (planFallback || weakOp)) {
        aiPlan = lookupCandidate;
      }
    }

    aiPlan = sanitizePlan(ds.headers, aiPlan);

    if (aiPlan.operation === "lookup" && (!aiPlan.filters || !aiPlan.filters.length)) {
      const fixed = tryHeuristicLookup(message, ds.headers, ds.rows);
      if (fixed) aiPlan = sanitizePlan(ds.headers, fixed);
    }

    if (planFallback) {
      aiPlan = applyKeywordHints(message, aiPlan);
    }

    aiPlan = applyTermMapping(message, ds.headers, aiPlan);

    const result = executePlan(ds.rows, ds.headers, aiPlan);

    const localSummary = summarizeLocally(result, message);

    let insightFallback = false;
    let insight;

    try {
      insight = await generateInsight({
        userQuery: message,
        contextSummary: result.contextSummary,
        chartType: result.chartType,
        chartTitle: result.title,
        series: result.series,
        plan: aiPlan,
        filteredRowCount: result.filteredRowCount != null ? result.filteredRowCount : ds.rows.length,
        tableRows: result.tableRows,
        tableColumns: result.tableColumns,
      });
    } catch (e) {
      insightFallback = true;
      console.warn("[query] Gemini insight failed:", e && e.message ? e.message : e);
      insight = localSummary;
    }

    return res.json({
      plan: aiPlan,
      chartType: result.chartType,
      chartTitle: result.title,
      series: result.series,
      tableRows: result.tableRows || [],
      tableColumns: result.tableColumns || [],
      filteredRowCount: result.filteredRowCount != null ? result.filteredRowCount : ds.rows.length,
      insight,
      rowCount: ds.rows.length,
      usedFallback: planFallback || insightFallback,
      planFallback,
      insightFallback,
      warning: planFallback || insightFallback ? "AI fallback mode enabled due to provider error." : null,
    });
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : "Query failed";
    return res.status(500).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`AI Data Analyst API listening on http://localhost:${PORT}`);
});
