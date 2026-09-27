// Everything that talks to Supabase.

import { createClient, type PostgrestError } from "@supabase/supabase-js";
import { SUPABASE_KEY, SUPABASE_URL } from "./config";
import type { BackupFile, Car, CarFields, Payment } from "./types";

export const isConfigured = /^https:\/\/.+/.test(SUPABASE_URL) && !SUPABASE_KEY.startsWith("PASTE_");

export const supabase = createClient(
  isConfigured ? SUPABASE_URL : "https://not-configured.supabase.co",
  isConfigured ? SUPABASE_KEY : "not-configured",
);

const PAGE = 1000; // Supabase returns at most 1000 rows per request

/** Thrown when the login is missing or has expired. */
export class SessionError extends Error {}

/** Turns a Supabase error into a plain-English message. */
function fail(error: PostgrestError | Error | null, carNumber?: string): never {
  const e = error as (PostgrestError & Error) | null;
  if (e?.code === "23505") {
    throw new Error(carNumber ? `A car with number ${carNumber} is already added` : "This car number is already added");
  }
  if (e?.code === "42P01" || e?.code === "PGRST205") {
    throw new Error("The database tables are missing. Run supabase/schema.sql in the Supabase SQL Editor.");
  }
  if (e?.code === "PGRST301" || e?.code === "42501" || /JWT/i.test(e?.message ?? "")) {
    throw new SessionError("Your login has expired. Please log in again.");
  }
  if (/fetch|network/i.test(e?.message ?? "")) {
    throw new Error("Can't reach the database. Check your internet connection and try again.");
  }
  throw new Error(e?.message || "Something went wrong. Please try again.");
}

/* ---------------- cars ---------------- */

export async function listCars(): Promise<Car[]> {
  const { data, error } = await supabase.from("cars").select("*").order("name");
  if (error) fail(error);
  return data as Car[];
}

export async function addCar(fields: CarFields): Promise<Car> {
  const { data, error } = await supabase.from("cars").insert(fields).select().single();
  if (error) fail(error, fields.number);
  return data as Car;
}

export async function updateCar(id: number, fields: CarFields | { active: boolean }): Promise<void> {
  const { error } = await supabase.from("cars").update(fields).eq("id", id);
  if (error) fail(error, "number" in fields ? fields.number : undefined);
}

/** Deletes a car. A car with rent history is only hidden, so its history is kept. Returns true when hidden. */
export async function deleteCar(id: number): Promise<boolean> {
  const { count, error } = await supabase.from("payments").select("car_id", { count: "exact", head: true }).eq("car_id", id);
  if (error) fail(error);
  if (count) {
    await updateCar(id, { active: false });
    return true;
  }
  const { error: delError } = await supabase.from("cars").delete().eq("id", id);
  if (delError) fail(delError);
  return false;
}

/* ---------------- rent ---------------- */

export async function paymentsBetween(from: string, to: string): Promise<Payment[]> {
  return allRows(q => q.gte("month", from).lte("month", to));
}

export async function paymentsForCar(carId: number): Promise<Payment[]> {
  return allRows(q => q.eq("car_id", carId));
}

export async function savePayment(p: Payment): Promise<void> {
  const { error } = await supabase.from("payments").upsert(p, { onConflict: "car_id,month" });
  if (error) fail(error);
}

export async function deletePayment(carId: number, month: string): Promise<void> {
  const { error } = await supabase.from("payments").delete().eq("car_id", carId).eq("month", month);
  if (error) fail(error);
}

/* ---------------- backup ---------------- */

export async function exportAll(): Promise<BackupFile> {
  const [cars, payments] = await Promise.all([listCars(), allRows(q => q)]);
  return { app: "mashaal-rent", version: 1, exported_at: new Date().toISOString(), cars, payments };
}

/** Replaces all data with the backup, in one step on the database. */
export async function restoreAll(backup: BackupFile): Promise<void> {
  const { error } = await supabase.rpc("restore_backup", { backup });
  if (error) fail(error);
}

/* ---------------- helpers ---------------- */

type PaymentQuery = ReturnType<ReturnType<typeof supabase.from>["select"]>;

/** Reads payments page by page, so more than 1000 rows still come back complete. */
async function allRows(filter: (q: PaymentQuery) => PaymentQuery): Promise<Payment[]> {
  const rows: Payment[] = [];
  for (let from = 0; ; from += PAGE) {
    const query = filter(supabase.from("payments").select("car_id, month, amount, paid_on, note"))
      .order("month")
      .order("car_id")
      .range(from, from + PAGE - 1);
    const { data, error } = await query;
    if (error) fail(error);
    rows.push(...(data as Payment[]));
    if (!data || data.length < PAGE) return rows;
  }
}
