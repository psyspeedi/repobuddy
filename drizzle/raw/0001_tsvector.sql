-- Generated tsvector column for full-text search on chunks.
-- This cannot be expressed via Drizzle schema (GENERATED ALWAYS AS … STORED
-- with a function call is not supported by drizzle-orm/pg-core typed columns).

ALTER TABLE "chunks"
  ALTER COLUMN "text_tsv" TYPE tsvector
  USING to_tsvector('english', coalesce("text", ''));

ALTER TABLE "chunks"
  ALTER COLUMN "text_tsv" SET NOT NULL;

-- Drop the plain column and re-add as generated, since GENERATED cannot be
-- toggled on an existing column.
ALTER TABLE "chunks" DROP COLUMN "text_tsv";

ALTER TABLE "chunks"
  ADD COLUMN "text_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("text", ''))) STORED;

CREATE INDEX IF NOT EXISTS "chunks_text_tsv_gin_idx"
  ON "chunks" USING GIN ("text_tsv");
