-- Enable required extensions for CodeGraph on the application database.
-- Runs against whatever POSTGRES_DB names — no database name is
-- hardcoded here, so changing it in .env stays safe.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
