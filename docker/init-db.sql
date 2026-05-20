-- Enable required extensions for CodeGraph on the dev database.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Provision a separate test database with the same extensions, so
-- `pnpm test` never touches the dev data. The vitest helper
-- (tests/helpers/test-db.ts) refuses to run against any DB whose name
-- does not end in _test, but having the DB pre-provisioned saves a
-- manual step on a fresh clone.
SELECT 'CREATE DATABASE repobuddy_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'repobuddy_test')\gexec

\c repobuddy_test
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
\c repobuddy
