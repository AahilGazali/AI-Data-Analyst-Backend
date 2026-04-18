import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
export const SESSION_COOKIE = "ai_analyst_session";
const BCRYPT_ROUNDS = 12;

function getJwtSecret() {
  const s = process.env.AUTH_JWT_SECRET;
  if (s && String(s).length >= 16) return String(s);
  if (process.env.NODE_ENV === "production") {
    throw new Error("Set AUTH_JWT_SECRET in the environment (at least 16 characters) before running in production.");
  }
  return "dev-only-insecure-secret";
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readUsers() {
  ensureDataDir();
  if (!fs.existsSync(USERS_FILE)) return [];
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeUsers(users) {
  ensureDataDir();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

function cookieBaseOptions() {
  // Vercel (or any other origin) calling Render: browsers require SameSite=None for cross-site credentialed fetch.
  // Set SESSION_COOKIE_SAMESITE=none on the API host in production. Omit locally (defaults to lax + Vite proxy).
  const crossSite = String(process.env.SESSION_COOKIE_SAMESITE || "").toLowerCase() === "none";
  const sameSite = crossSite ? "none" : "lax";
  const secure = crossSite ? true : process.env.NODE_ENV === "production";
  return { httpOnly: true, sameSite, path: "/", secure };
}

function issueToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, getJwtSecret(), { expiresIn: "7d" });
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    ...cookieBaseOptions(),
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, cookieBaseOptions());
}

export function verifySessionToken(token) {
  return jwt.verify(token, getJwtSecret());
}

function getSessionTokenFromRequest(req) {
  const auth = req.headers.authorization;
  if (auth && typeof auth === "string" && auth.startsWith("Bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  const c = req.cookies?.[SESSION_COOKIE];
  return typeof c === "string" && c ? c : null;
}

export function requireAuth(req, res, next) {
  try {
    const raw = getSessionTokenFromRequest(req);
    if (!raw) {
      return res.status(401).json({ error: "Sign in required" });
    }
    const payload = verifySessionToken(raw);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch {
    clearSessionCookie(res);
    return res.status(401).json({ error: "Session expired or invalid" });
  }
}

export function registerAuthRoutes(app) {
  app.post("/api/auth/signup", async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || typeof email !== "string" || !password || typeof password !== "string") {
        return res.status(400).json({ error: "Email and password are required" });
      }
      const em = email.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
        return res.status(400).json({ error: "Invalid email address" });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      }

      const users = readUsers();
      if (users.some((u) => String(u.email).toLowerCase() === em.toLowerCase())) {
        return res.status(409).json({ error: "An account with this email already exists" });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const id = randomUUID();
      users.push({ id, email: em, passwordHash, createdAt: Date.now() });
      writeUsers(users);

      // Do not issue a session here — user signs in on the login step.
      return res.status(201).json({ user: { id, email: em } });
    } catch (err) {
      console.error("[auth signup]", err);
      return res.status(500).json({ error: "Could not create account" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || typeof email !== "string" || !password || typeof password !== "string") {
        return res.status(400).json({ error: "Email and password are required" });
      }
      const em = email.trim();
      const users = readUsers();
      const user = users.find((u) => String(u.email).toLowerCase() === em.toLowerCase());
      if (!user?.passwordHash) {
        return res.status(401).json({ error: "Invalid email or password" });
      }
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const token = issueToken({ id: user.id, email: user.email });
      setSessionCookie(res, token);
      return res.json({
        user: { id: user.id, email: user.email },
        token,
      });
    } catch (err) {
      console.error("[auth login]", err);
      return res.status(500).json({ error: "Could not sign in" });
    }
  });

  app.post("/api/auth/logout", (_req, res) => {
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  app.get("/api/auth/me", (req, res) => {
    try {
      const raw = getSessionTokenFromRequest(req);
      if (!raw) {
        return res.json({ user: null });
      }
      const payload = verifySessionToken(raw);
      return res.json({ user: { id: payload.sub, email: payload.email } });
    } catch {
      clearSessionCookie(res);
      return res.json({ user: null });
    }
  });
}
