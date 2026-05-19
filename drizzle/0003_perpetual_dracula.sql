CREATE TABLE "interest_pings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interest_pings_user_kind_unique" UNIQUE("user_id","kind")
);
--> statement-breakpoint
ALTER TABLE "interest_pings" ADD CONSTRAINT "interest_pings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interest_pings_created_idx" ON "interest_pings" USING btree ("created_at");