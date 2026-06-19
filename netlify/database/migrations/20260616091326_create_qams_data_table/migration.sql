CREATE TABLE "qams_data" (
	"bucket" text PRIMARY KEY,
	"data" jsonb,
	"updated_at" timestamp DEFAULT now()
);
