# GS1/UDI Enterprise Hub (Clean Deploy)

## What this repo includes
- Node.js (Express) API + static UI (served from `/public`)
- Supabase Postgres schema (`/database/bootstrap.sql`)
- Dockerfile for Northflank

## Required environment variables (Northflank Secrets)
- DATABASE_URL
- JWT_SECRET_EFFECTIVE
- SEED_ADMIN_PASS
- SEED_OPERATOR_PASS
- AUTO_SCHEMA=true (recommended for first deploy)
- CORS_ORIGINS (optional; comma-separated)

## Quick local run
1) Copy `.env.example` → `.env` and fill values
2) `npm install`
3) `npm start`
