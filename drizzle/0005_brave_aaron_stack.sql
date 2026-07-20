ALTER TABLE "llm_cost_log" ADD COLUMN "usd_micro_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Carry existing rows over: the old column counted whole cents, rounded
-- up per call, so this preserves the recorded (pessimistic) totals
-- rather than zeroing history. 1 cent = 10_000 micro-cents.
UPDATE "llm_cost_log" SET "usd_micro_cents" = "usd_cents" * 10000 WHERE "usd_cents" > 0;
