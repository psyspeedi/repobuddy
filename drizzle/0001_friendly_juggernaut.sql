CREATE TABLE "user_quotas" (
	"user_id" uuid NOT NULL,
	"day" text NOT NULL,
	"workspaces_created" integer DEFAULT 0 NOT NULL,
	"messages_sent" integer DEFAULT 0 NOT NULL,
	"tokens_used" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_quotas_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "byok_base_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "byok_model" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "byok_embedding_model" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "encrypted_byok_api_key" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_quotas" ADD CONSTRAINT "user_quotas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspaces_public_idx" ON "workspaces" USING btree ("is_public");