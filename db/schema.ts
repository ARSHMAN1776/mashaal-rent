import { pgTable, serial, text, integer, boolean, timestamp, unique } from "drizzle-orm/pg-core";

export const cars = pgTable("cars", {
  id: serial().primaryKey(),
  name: text().notNull(),
  number: text().notNull().unique(),
  owner: text().notNull().default(""),
  monthlyRent: integer("monthly_rent").notNull().default(0),
  startMonth: text("start_month").notNull(),
  active: boolean().notNull().default(true),
  notes: text().notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

export const payments = pgTable("payments", {
  id: serial().primaryKey(),
  carId: integer("car_id").notNull().references(() => cars.id, { onDelete: "cascade" }),
  month: text().notNull(),
  amount: integer().notNull(),
  paidOn: text("paid_on").notNull(),
  note: text().notNull().default(""),
}, (table) => [
  unique("payments_car_id_month_unique").on(table.carId, table.month),
]);

export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(),
});
