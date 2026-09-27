// Everything that talks to Supabase.

import { createClient, type PostgrestError } from "@supabase/supabase-js";
import { SUPABASE_KEY, SUPABASE_URL } from "./config";
import type { BackupFile, Car, CarFields, Payment, Receipt } from "./types";

export const isConfigured = /^https:\/\/.+/.test(SUPABASE_URL) && SUPABASE_KEY.length > 0;

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
  // The database row for each receipt is removed together with the payment
  // (see "on delete cascade" in schema.sql), but the file itself is not, so
  // it is deleted here first.
  const receipts = await receiptsFor(carId, month);
  if (receipts.length) await removeReceiptFiles(receipts.map(r => r.path));
  const { error } = await supabase.from("payments").delete().eq("car_id", carId).eq("month", month);
  if (error) fail(error);
}

/* ---------------- payment screenshots ---------------- */

const RECEIPTS_BUCKET = "receipts";
const MAX_RECEIPT_MB = 8;

export async function receiptsFor(carId: number, month: string): Promise<Receipt[]> {
  const { data, error } = await supabase.from("receipts").select("*").eq("car_id", carId).eq("month", month).order("uploaded_at");
  if (error) fail(error);
  return data as Receipt[];
}

/** Every screenshot of this car, across all months (used by the History popup). */
export async function receiptsForCar(carId: number): Promise<Receipt[]> {
  const { data, error } = await supabase.from("receipts").select("*").eq("car_id", carId).order("month");
  if (error) fail(error);
  return data as Receipt[];
}

/** How many screenshots each car has for one month (used by the Monthly Rent table). */
export async function receiptCountsForMonth(month: string): Promise<Map<number, number>> {
  const { data, error } = await supabase.from("receipts").select("car_id").eq("month", month);
  if (error) fail(error);
  const counts = new Map<number, number>();
  for (const { car_id } of data as { car_id: number }[]) counts.set(car_id, (counts.get(car_id) ?? 0) + 1);
  return counts;
}

/** Uploads a screenshot for a rent entry that has already been saved. */
export async function uploadReceipt(carId: number, month: string, file: File): Promise<Receipt> {
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? "jpg").toLowerCase();
  const path = `${carId}/${month}/${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await supabase.storage.from(RECEIPTS_BUCKET).upload(path, file, {
    contentType: file.type || undefined,
  });
  if (uploadError) {
    const msg = uploadError.message;
    if (/exceeded|maximum|size limit/i.test(msg)) throw new Error(`This file is larger than ${MAX_RECEIPT_MB} MB. Please choose a smaller one.`);
    if (/mime type|not allowed|not supported/i.test(msg)) throw new Error("Please choose an image (JPG, PNG, WEBP, HEIC) or a PDF.");
    if (/fetch|network/i.test(msg)) throw new Error("Can't reach the database. Check your internet connection and try again.");
    throw new Error(msg || "The screenshot could not be uploaded.");
  }
  const { data, error } = await supabase.from("receipts").insert({ car_id: carId, month, path }).select().single();
  if (error) {
    await removeReceiptFiles([path]); // the database row failed, so don't leave the file behind
    fail(error);
  }
  return data as Receipt;
}

/** A link to view or download one screenshot. Expires after a few minutes. */
export async function receiptUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(RECEIPTS_BUCKET).createSignedUrl(path, 300);
  if (error) throw new Error(error.message || "Could not open this screenshot.");
  return data.signedUrl;
}

export async function deleteReceipt(receipt: Pick<Receipt, "id" | "path">): Promise<void> {
  await removeReceiptFiles([receipt.path]);
  const { error } = await supabase.from("receipts").delete().eq("id", receipt.id);
  if (error) fail(error);
}

async function removeReceiptFiles(paths: string[]): Promise<void> {
  const { error } = await supabase.storage.from(RECEIPTS_BUCKET).remove(paths);
  // A file that is already gone should not block the rest of the action.
  if (error && !/not found/i.test(error.message)) throw new Error(error.message || "Could not remove the screenshot file.");
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
