# AI Data Analyst — Backend

Express API for CSV upload, auth (JWT cookie), and Gemini-powered query planning and insights.

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and set:

- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) — required for AI features
- `PORT` — optional (default `5000`)
- `AUTH_JWT_SECRET` — required in production (min 16 characters); optional in development

User accounts are stored under `data/` (created at runtime; not committed).

## Run

```bash
npm run dev
```

```bash
npm start
```

## API (overview)

- `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `POST /api/upload` — CSV (authenticated)
- `POST /api/query` — natural language analysis (authenticated)
- `GET /api/health`
