-- Dev-only: provision a separate test database with the same
-- extensions, so `pnpm test` never touches the dev data. The vitest
-- helper (test/helpers/test-db.ts) refuses to run against any DB whose
-- name does not end in _test, but having it pre-provisioned saves a
-- manual step on a fresh clone.
--
-- Mounted by docker-compose.yml only. The production compose file
-- deliberately does not mount it: a prod cluster has no business
-- carrying a throwaway test database.
--
-- `\c` back to the original database at the end so any later init
-- script still runs where it expects to. :DBNAME is the psql built-in
-- holding the current connection's database, captured before switching.
\set app_db :DBNAME

SELECT 'CREATE DATABASE repobuddy_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'repobuddy_test')\gexec

\c repobuddy_test
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
\c :"app_db"
