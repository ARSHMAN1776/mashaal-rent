import type { Config, Context } from "@netlify/functions";
import crypto from "node:crypto";
import { and, asc, desc, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { cars, payments, settings } from "../../db/schema.js";

const SESSION_COOKIE = "mrc_session";
const SESSION_DAYS = 30;
const MIN_PASSWORD = 6;
const MAX_AMOUNT = 100_000_000;
const PAKISTAN_OFFSET_MINUTES = 5 * 60; // Pakistan has no daylight saving

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type Body = Record<string, unknown>;

// ---------------------------------------------------------------- helpers

function today(): string {
  const now = new Date(Date.now() + PAKISTAN_OFFSET_MINUTES * 60_000);
  return now.toISOString().slice(0, 10);
}

function thisMonth(): string {
  return today().slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split("-").map(Number);
  const index = year * 12 + (mon - 1) + delta;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toId(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new ApiError("Invalid id");
  return n;
}

function toAmount(value: unknown, label: string): number {
  const text = String(value ?? "").replace(/[,\s]/g, "");
  if (!text) throw new ApiError(`${label} is required`);
  const amount = Number(text);
  if (!Number.isFinite(amount)) throw new ApiError(`${label} must be a number`);
  if (amount < 0 || amount > MAX_AMOUNT || amount !== Math.trunc(amount)) {
    throw new ApiError(`${label} must be a whole number of rupees`);
  }
  return amount;
}

function monthArg(url: URL): string {
  const month = url.searchParams.get("m") || thisMonth();
  if (!MONTH_RE.test(month)) throw new ApiError("Invalid month");
  return month;
}

async function readJson(req: Request): Promise<Body> {
  const text = await req.text();
  if (!text) return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError("Invalid request");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ApiError("Invalid request");
  }
  return data as Body;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------- login

async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  return row ? row.value : null;
}

async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

async function secretKey(): Promise<string> {
  let key = await getSetting("secret_key");
  if (!key) {
    key = crypto.randomBytes(32).toString("hex");
    await setSetting("secret_key", key);
  }
  return key;
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const rounds = 240_000;
  const digest = crypto.pbkdf2Sync(password, Buffer.from(salt, "hex"), rounds, 32, "sha256").toString("hex");
  return `pbkdf2$${rounds}$${salt}$${digest}`;
}

function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4) return false;
  const [, roundsText, salt, digest] = parts;
  const rounds = Number(roundsText);
  if (!Number.isInteger(rounds)) return false;
  const check = crypto.pbkdf2Sync(password, Buffer.from(salt, "hex"), rounds, 32, "sha256").toString("hex");
  const a = Buffer.from(check, "hex");
  const b = Buffer.from(digest, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function checkNewPassword(value: unknown): string {
  const password = String(value ?? "");
  if (password.length < MIN_PASSWORD) throw new ApiError(`Password must be at least ${MIN_PASSWORD} characters`);
  return password;
}

async function sign(expires: number, passwordHash: string | null): Promise<string> {
  const key = await secretKey();
  return crypto.createHmac("sha256", key).update(`${expires}:${passwordHash ?? ""}`).digest("hex");
}

function isHttps(req: Request): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  return (req.headers.get("x-forwarded-proto") || "").toLowerCase() === "https";
}

async function setSessionCookie(context: Context, req: Request, passwordHash: string): Promise<void> {
  const maxAge = SESSION_DAYS * 86400;
  const expires = Math.floor(Date.now() / 1000) + maxAge;
  const sig = await sign(expires, passwordHash);
  context.cookies.set({
    name: SESSION_COOKIE,
    value: `${expires}.${sig}`,
    path: "/",
    maxAge,
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttps(req),
  });
}

function clearSessionCookie(context: Context): void {
  context.cookies.delete({ name: SESSION_COOKIE, path: "/" });
}

async function isLoggedIn(context: Context, passwordHash: string | null): Promise<boolean> {
  const token = context.cookies.get(SESSION_COOKIE);
  if (!token || !passwordHash) return false;
  const [expiresText, sig] = token.split(".");
  if (!expiresText || !/^\d+$/.test(expiresText) || !sig) return false;
  const expires = Number(expiresText);
  if (expires < Math.floor(Date.now() / 1000)) return false;
  const expected = await sign(expires, passwordHash);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- cars

type CarRow = typeof cars.$inferSelect;

function carJson(row: CarRow) {
  return {
    id: row.id,
    name: row.name,
    number: row.number,
    owner: row.owner,
    monthly_rent: row.monthlyRent,
    start_month: row.startMonth,
    active: row.active,
    notes: row.notes,
  };
}

function cleanCar(body: Body) {
  const name = String(body.name ?? "").replace(/\s+/g, " ").trim();
  const number = String(body.number ?? "").replace(/\s+/g, " ").trim().toUpperCase();
  const owner = String(body.owner ?? "").trim();
  const notes = String(body.notes ?? "").trim();
  const start = String(body.start_month || thisMonth());
  if (!name) throw new ApiError("Please enter the car name");
  if (!number) throw new ApiError("Please enter the car number");
  if (!MONTH_RE.test(start)) throw new ApiError("Please choose a valid start month");
  const monthlyRent = toAmount(body.monthly_rent, "Monthly rent");
  return { name, number, owner, notes, startMonth: start, monthlyRent };
}

async function getCar(carId: number): Promise<CarRow> {
  const [row] = await db.select().from(cars).where(eq(cars.id, carId));
  if (!row) throw new ApiError("Car not found", 404);
  return row;
}

async function listCars() {
  const rows = await db
    .select()
    .from(cars)
    .orderBy(desc(cars.active), asc(sql`lower(${cars.name})`), asc(cars.number));
  return { cars: rows.map(carJson) };
}

async function createCar(body: Body) {
  const car = cleanCar(body);
  try {
    const [inserted] = await db.insert(cars).values(car).returning();
    return { car: carJson(inserted) };
  } catch (err: any) {
    if (err?.code === "23505") throw new ApiError(`A car with number ${car.number} is already added`);
    throw err;
  }
}

async function updateCar(carId: number, body: Body) {
  await getCar(carId);
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === "active") {
    await db.update(cars).set({ active: Boolean(body.active) }).where(eq(cars.id, carId));
    return { car: carJson(await getCar(carId)) };
  }
  const car = cleanCar(body);
  try {
    await db.update(cars).set(car).where(eq(cars.id, carId));
  } catch (err: any) {
    if (err?.code === "23505") throw new ApiError(`A car with number ${car.number} is already added`);
    throw err;
  }
  return { car: carJson(await getCar(carId)) };
}

async function deleteCar(carId: number) {
  await getCar(carId);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(payments)
    .where(eq(payments.carId, carId));
  if (count > 0) {
    // Keep rent history safe: hide the car instead of deleting it.
    await db.update(cars).set({ active: false }).where(eq(cars.id, carId));
    return { archived: true };
  }
  await db.delete(cars).where(eq(cars.id, carId));
  return { archived: false };
}

async function carHistory(carId: number) {
  const car = await getCar(carId);
  const pays = await db.select().from(payments).where(eq(payments.carId, carId));
  const payMap = new Map(pays.map((p) => [p.month, p]));
  const monthKeys = [...payMap.keys()];
  const start = [car.startMonth, ...monthKeys].reduce((a, b) => (a < b ? a : b));
  const end = car.active
    ? [thisMonth(), ...monthKeys].reduce((a, b) => (a > b ? a : b))
    : monthKeys.length
      ? monthKeys.reduce((a, b) => (a > b ? a : b))
      : start;

  const months: { month: string; paid: boolean; amount: number | null; paid_on: string | null; note: string }[] = [];
  let month = end;
  while (month >= start && months.length < 240) {
    const pay = payMap.get(month);
    months.push({
      month,
      paid: !!pay,
      amount: pay ? pay.amount : null,
      paid_on: pay ? pay.paidOn : null,
      note: pay ? pay.note : "",
    });
    month = shiftMonth(month, -1);
  }
  return {
    car: carJson(car),
    months,
    total: pays.reduce((s, p) => s + p.amount, 0),
    paid_months: pays.length,
    pending_months: months.filter((m) => !m.paid).length,
  };
}

// ---------------------------------------------------------------- rent

type MonthRow = {
  id: number;
  name: string;
  number: string;
  owner: string;
  monthly_rent: number;
  active: boolean;
  start_month: string;
  amount: number | null;
  paid_on: string | null;
  pay_note: string | null;
  paid: boolean;
};

async function monthRows(month: string): Promise<MonthRow[]> {
  const rows = await db
    .select({
      id: cars.id,
      name: cars.name,
      number: cars.number,
      owner: cars.owner,
      monthlyRent: cars.monthlyRent,
      active: cars.active,
      startMonth: cars.startMonth,
      amount: payments.amount,
      paidOn: payments.paidOn,
      payNote: payments.note,
    })
    .from(cars)
    .leftJoin(payments, and(eq(payments.carId, cars.id), eq(payments.month, month)))
    .where(or(and(eq(cars.active, true), lte(cars.startMonth, month)), isNotNull(payments.id)))
    .orderBy(asc(sql`lower(${cars.name})`), asc(cars.number));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    number: r.number,
    owner: r.owner,
    monthly_rent: r.monthlyRent,
    active: r.active,
    start_month: r.startMonth,
    amount: r.amount,
    paid_on: r.paidOn,
    pay_note: r.payNote,
    paid: r.amount !== null,
  }));
}

function summarize(rows: MonthRow[]) {
  const paid = rows.filter((r) => r.paid);
  const unpaid = rows.filter((r) => !r.paid);
  const collected = paid.reduce((s, r) => s + (r.amount ?? 0), 0);
  const pending = unpaid.reduce((s, r) => s + r.monthly_rent, 0);
  return {
    total_cars: rows.length,
    paid_cars: paid.length,
    unpaid_cars: unpaid.length,
    collected,
    pending,
    expected: collected + pending,
  };
}

async function monthSheet(month: string) {
  const rows = await monthRows(month);
  return { month, rows, summary: summarize(rows) };
}

async function dashboard(month: string) {
  const rows = await monthRows(month);
  const trend = [];
  for (let back = 11; back >= 0; back--) {
    const m = shiftMonth(month, -back);
    trend.push({ month: m, ...summarize(await monthRows(m)) });
  }
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(cars)
    .where(eq(cars.active, true));
  return { month, rows, summary: summarize(rows), trend, active_cars: count };
}

async function savePayment(body: Body) {
  const carId = toId(body.car_id);
  const car = await getCar(carId);
  const month = String(body.month ?? "");
  if (!MONTH_RE.test(month)) throw new ApiError("Invalid month");
  const amount = toAmount(body.amount, "Amount");
  if (amount <= 0) throw new ApiError("Amount must be more than zero");
  const paidOn = String(body.paid_on || today());
  if (!DATE_RE.test(paidOn)) throw new ApiError("Invalid date");
  const note = String(body.note ?? "").trim();
  await db
    .insert(payments)
    .values({ carId, month, amount, paidOn, note })
    .onConflictDoUpdate({ target: [payments.carId, payments.month], set: { amount, paidOn, note } });
  return { ok: true, car: car.number, month, amount };
}

async function deletePayment(url: URL) {
  const carId = toId(url.searchParams.get("car_id"));
  const month = monthArg(url);
  await db.delete(payments).where(and(eq(payments.carId, carId), eq(payments.month, month)));
  return { ok: true };
}

function csvField(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(fields: unknown[]): string {
  return fields.map(csvField).join(",") + "\r\n";
}

async function exportCsv(month: string): Promise<Response> {
  const rows = await monthRows(month);
  let csv = "﻿"; // BOM so Excel reads it as UTF-8
  csv += csvRow(["#", "Car", "Number", "Owner / Driver", "Monthly Rent", "Status", "Amount Received", "Received On", "Note"]);
  rows.forEach((r, i) => {
    csv += csvRow([
      i + 1,
      r.name,
      r.number,
      r.owner,
      r.monthly_rent,
      r.paid ? "Received" : "Pending",
      r.paid ? r.amount : "",
      r.paid_on || "",
      r.pay_note || "",
    ]);
  });
  const s = summarize(rows);
  csv += csvRow([]);
  csv += csvRow(["", "Total received", "", "", "", "", s.collected]);
  csv += csvRow(["", "Cars paid", "", "", "", "", s.paid_cars]);
  csv += csvRow(["", "Cars pending", "", "", "", "", s.unpaid_cars]);
  csv += csvRow(["", "Pending amount", "", "", "", "", s.pending]);
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rent-${month}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

async function backupFile(): Promise<Response> {
  const allCars = await db.select().from(cars);
  const allPayments = await db.select().from(payments);
  const data = {
    exported_at: new Date().toISOString(),
    cars: allCars.map(carJson),
    payments: allPayments.map((p) => ({
      car_id: p.carId,
      month: p.month,
      amount: p.amount,
      paid_on: p.paidOn,
      note: p.note,
    })),
  };
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="mashaal-rent-backup-${today()}.json"`,
      "Cache-Control": "no-store",
    },
  });
}

// ---------------------------------------------------------------- routing

export default async (req: Request, context: Context): Promise<Response> => {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const method = req.method.toUpperCase();
    const path = (m: string, p: string[]) => method === m && parts.length === p.length && p.every((seg, i) => seg === "*" || seg === parts[i]);

    if (path("GET", ["session"])) {
      const passwordHash = await getSetting("password");
      return jsonResponse({ setup_needed: passwordHash === null, logged_in: await isLoggedIn(context, passwordHash) });
    }

    if (path("POST", ["setup"])) {
      const existing = await getSetting("password");
      if (existing) throw new ApiError("A password is already set. Please log in.", 403);
      const body = await readJson(req);
      const newHash = hashPassword(checkNewPassword(body.password));
      await setSetting("password", newHash);
      await setSessionCookie(context, req, newHash);
      return jsonResponse({ ok: true });
    }

    if (path("POST", ["login"])) {
      const stored = await getSetting("password");
      const body = await readJson(req);
      if (!verifyPassword(String(body.password ?? ""), stored)) {
        await sleep(1000); // slows down password guessing
        throw new ApiError("Wrong password", 401);
      }
      await setSessionCookie(context, req, stored as string);
      return jsonResponse({ ok: true });
    }

    if (path("POST", ["logout"])) {
      clearSessionCookie(context);
      return jsonResponse({ ok: true });
    }

    const passwordHash = await getSetting("password");
    if (!(await isLoggedIn(context, passwordHash))) {
      throw new ApiError("Please log in", 401);
    }

    if (path("POST", ["password"])) {
      const body = await readJson(req);
      if (!verifyPassword(String(body.current ?? ""), passwordHash)) {
        await sleep(1000);
        throw new ApiError("Current password is wrong");
      }
      const newHash = hashPassword(checkNewPassword(body.new));
      await setSetting("password", newHash);
      await setSessionCookie(context, req, newHash);
      return jsonResponse({ ok: true });
    }

    if (path("GET", ["cars"])) return jsonResponse(await listCars());
    if (path("POST", ["cars"])) return jsonResponse(await createCar(await readJson(req)));
    if (path("PUT", ["cars", "*"])) return jsonResponse(await updateCar(toId(parts[1]), await readJson(req)));
    if (path("DELETE", ["cars", "*"])) return jsonResponse(await deleteCar(toId(parts[1])));
    if (path("GET", ["cars", "*", "history"])) return jsonResponse(await carHistory(toId(parts[1])));
    if (path("GET", ["month"])) return jsonResponse(await monthSheet(monthArg(url)));
    if (path("GET", ["dashboard"])) return jsonResponse(await dashboard(monthArg(url)));
    if (path("POST", ["payments"])) return jsonResponse(await savePayment(await readJson(req)));
    if (path("DELETE", ["payments"])) return jsonResponse(await deletePayment(url));
    if (path("GET", ["export"])) return await exportCsv(monthArg(url));
    if (path("GET", ["backup"])) return await backupFile();

    throw new ApiError("Not found", 404);
  } catch (err) {
    if (err instanceof ApiError) return jsonResponse({ error: err.message }, err.status);
    console.error(err);
    return jsonResponse({ error: "Something went wrong on the server" }, 500);
  }
};

export const config: Config = {
  path: "/api/*",
};
