CREATE TABLE "cars" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL,
	"number" text NOT NULL UNIQUE,
	"owner" text DEFAULT '' NOT NULL,
	"monthly_rent" integer DEFAULT 0 NOT NULL,
	"start_month" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY,
	"car_id" integer NOT NULL,
	"month" text NOT NULL,
	"amount" integer NOT NULL,
	"paid_on" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	CONSTRAINT "payments_car_id_month_unique" UNIQUE("car_id","month")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY,
	"value" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_car_id_cars_id_fkey" FOREIGN KEY ("car_id") REFERENCES "cars"("id") ON DELETE CASCADE;