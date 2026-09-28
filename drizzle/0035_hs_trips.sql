CREATE TABLE "hs_trips" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"server_id" text NOT NULL,
	"trigger_id" text,
	"rule" text NOT NULL,
	"steam_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"mode" text NOT NULL,
	"repeat" boolean DEFAULT false NOT NULL,
	"alerted" boolean DEFAULT false NOT NULL,
	"verdict" text DEFAULT '' NOT NULL,
	"kill_ids" jsonb NOT NULL,
	"evidence" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hs_trips" ADD CONSTRAINT "hs_trips_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hs_trips_server_ts_idx" ON "hs_trips" USING btree ("server_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "hs_trips_player_idx" ON "hs_trips" USING btree ("steam_id","ts" DESC NULLS LAST);