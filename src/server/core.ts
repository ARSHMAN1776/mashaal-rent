import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AppData, BackupFile, Car, CarHistory, CarWithCount, Dashboard, HistoryMonth,
  MonthRow, MonthSheet, Payment, SessionInfo, Summary,
} from "../shared/types";
import type { KV } from "./kv";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_AMOUNT = 100_000_000;
const MIN_PASSWORD = 6;
const SESSION_COOKIE = "mrc_session";
const SESSION_DAYS = 30;
const KEEP_BACKUPS = 30;
const PBKDF2_ROUNDS = 240_000;

const DATA_KEY = "data";
const AUTH_KEY = "auth";
const BACKUP_PREFIX = "backup/";

interface Auth {
  secret: string;
  password?: string;
}

class ApiError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

type Body = Record<string, unknown>;

/* ---------------------------------------------------------------- helpers */

// Pakistan time: UTC+5, no daylight saving.
const today = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const i = y * 12 + (m - 1) + delta;
  return `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`;
}

function toId(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError("Invalid id");
  return n;
}

function toAmount(value: unknown, label: string): number {
  const text = String(value ?? "").replace(/[,\s]/g, "");
  if (!text) throw new ApiError(`${label} is required`);
  const n = Number(text);
  if (!Number.isFinite(n)) throw new ApiError(`${label} must be a number`);
  if (n < 0 || n > MAX_AMOUNT || !Number.isInteger(n)) throw new ApiError(`${label} must be a whole number of rupees`);
  return n;
}

function monthParam(value: string | null): string {
  const month = value || thisMonth();
  if (!MONTH_RE.test(month)) throw new ApiError("Invalid month");
  return month;
}

const text = (value: unknown) => String(value ?? "").trim();
const byName = (a: Car, b: Car) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.number.localeCompare(b.number);

function findCar(data: AppData, id: number): Car {
  const car = data.cars.find(c => c.id === id);
  if (!car) throw new ApiError("Car not found", 404);
  return car;
}

/* ---------------------------------------------------------------- responses */

function json(payload: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(payload), { status, headers });
}

function download(body: string, type: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

/* ---------------------------------------------------------------- storage */

const emptyData = (): AppData => ({ version: 1, next_id: 1, cars: [], payments: [] });

async function loadData(kv: KV) {
  const { value, etag } = await kv.read<AppData>(DATA_KEY);
  return { data: value ?? emptyData(), etag };
}

/** Applies a change and saves it. Retries if another save happened at the same moment. */
async function change<T>(kv: KV, apply: (data: AppData) => T): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, etag } = await loadData(kv);
    const before = structuredClone(data);
    const result = apply(data);
    if (await kv.write(DATA_KEY, data, etag)) {
      if (etag) await dailyBackup(kv, before);
      return result;
    }
  }
  throw new ApiError("Could not save because of another change at the same time. Please try again.", 409);
}

/** Before the first change of each day, keep a copy of the data. The newest 30 copies are kept. */
async function dailyBackup(kv: KV, snapshot: AppData) {
  try {
    const key = BACKUP_PREFIX + today();
    const keys = await kv.list(BACKUP_PREFIX);
    if (keys.includes(key)) return;
    await kv.put(key, snapshot);
    const all = [...keys, key].sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) await kv.remove(old);
  } catch (err) {
    console.error("Daily backup failed", err);
  }
}

/* ---------------------------------------------------------------- login */

async function loadAuth(kv: KV): Promise<{ auth: Auth; etag: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { value, etag } = await kv.read<Auth>(AUTH_KEY);
    if (value && etag) return { auth: value, etag };
    await kv.write(AUTH_KEY, { secret: randomBytes(32).toString("hex") }, null);
  }
  throw new ApiError("Could not load login settings. Please try again.", 500);
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const digest = pbkdf2Sync(password, salt, PBKDF2_ROUNDS, 32, "sha256");
  return `pbkdf2$${PBKDF2_ROUNDS}$${salt.toString("hex")}$${digest.toString("hex")}`;
}

function verifyPassword(password: string, stored: string | undefined): boolean {
  const [kind, rounds, salt, digest] = (stored ?? "").split("$");
  if (kind !== "pbkdf2" || !rounds || !salt || !digest) return false;
  const check = pbkdf2Sync(password, Buffer.from(salt, "hex"), Number(rounds), digest.length / 2, "sha256");
  return timingSafeEqual(check, Buffer.from(digest, "hex"));
}

function checkNewPassword(value: unknown): string {
  const password = String(value ?? "");
  if (password.length < MIN_PASSWORD) throw new ApiError(`Password must be at least ${MIN_PASSWORD} characters`);
  return password;
}

// The password hash is part of the signature, so changing the password logs out every device.
const sign = (auth: Auth, expires: number) =>
  createHmac("sha256", auth.secret).update(`${expires}:${auth.password ?? ""}`).digest("hex");

function sessionCookie(auth: Auth, secure: boolean): string {
  const maxAge = SESSION_DAYS * 86400;
  const expires = Math.floor(Date.now() / 1000) + maxAge;
  return `${SESSION_COOKIE}=${expires}.${sign(auth, expires)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`
    + (secure ? "; Secure" : "");
}

const logoutCookie = (secure: boolean) =>
  `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` + (secure ? "; Secure" : "");

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function isLoggedIn(req: Request, auth: Auth): boolean {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || !auth.password) return false;
  const [expires, signature = ""] = token.split(".");
  if (!/^\d+$/.test(expires) || Number(expires) < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(auth, Number(expires)));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/* ---------------------------------------------------------------- cars */

function cleanCar(body: Body) {
  const name = text(body.name).replace(/\s+/g, " ");
  const number = text(body.number).replace(/\s+/g, " ").toUpperCase();
  const start = text(body.start_month) || thisMonth();
  if (!name) throw new ApiError("Please enter the car name");
  if (!number) throw new ApiError("Please enter the car number");
  if (!MONTH_RE.test(start)) throw new ApiError("Please choose a valid start month");
  return {
    name,
    number,
    owner: text(body.owner),
    notes: text(body.notes),
    monthly_rent: toAmount(body.monthly_rent, "Monthly rent"),
    start_month: start,
  };
}

function checkUniqueNumber(data: AppData, number: string, exceptId?: number) {
  const taken = data.cars.some(c => c.id !== exceptId && c.number.toUpperCase() === number.toUpperCase());
  if (taken) throw new ApiError(`A car with number ${number} is already added`);
}

function listCars(data: AppData): { cars: CarWithCount[] } {
  const counts = new Map<number, number>();
  for (const p of data.payments) counts.set(p.car_id, (counts.get(p.car_id) ?? 0) + 1);
  const cars = [...data.cars]
    .sort((a, b) => Number(b.active) - Number(a.active) || byName(a, b))
    .map(c => ({ ...c, payment_count: counts.get(c.id) ?? 0 }));
  return { cars };
}

function carHistory(data: AppData, id: number): CarHistory {
  const car = findCar(data, id);
  const pays = new Map(data.payments.filter(p => p.car_id === id).map(p => [p.month, p]));
  const paidMonths = [...pays.keys()].sort();
  const start = [car.start_month, ...paidMonths].sort()[0];
  const end = car.active
    ? [thisMonth(), ...paidMonths].sort().at(-1)!
    : paidMonths.at(-1) ?? start;
  const months: HistoryMonth[] = [];
  for (let m = end; m >= start && months.length < 240; m = shiftMonth(m, -1)) {
    const p = pays.get(m);
    months.push({ month: m, paid: !!p, amount: p?.amount ?? null, paid_on: p?.paid_on ?? null, note: p?.note ?? "" });
  }
  return {
    car,
    months,
    total: [...pays.values()].reduce((sum, p) => sum + p.amount, 0),
    paid_months: pays.size,
    pending_months: months.filter(m => !m.paid).length,
  };
}

/* ---------------------------------------------------------------- rent */

/** Every car that owes rent for the month, plus any car that has a payment in it. */
function monthRows(data: AppData, month: string): MonthRow[] {
  const pays = new Map(data.payments.filter(p => p.month === month).map(p => [p.car_id, p]));
  return data.cars
    .filter(c => (c.active && c.start_month <= month) || pays.has(c.id))
    .sort(byName)
    .map(c => {
      const p = pays.get(c.id);
      return {
        id: c.id, name: c.name, number: c.number, owner: c.owner,
        monthly_rent: c.monthly_rent, active: c.active, start_month: c.start_month,
        amount: p?.amount ?? null, paid_on: p?.paid_on ?? null, pay_note: p?.note ?? null, paid: !!p,
      };
    });
}

function summarize(rows: MonthRow[]): Summary {
  const paid = rows.filter(r => r.paid);
  const unpaid = rows.filter(r => !r.paid);
  const collected = paid.reduce((sum, r) => sum + (r.amount ?? 0), 0);
  const pending = unpaid.reduce((sum, r) => sum + r.monthly_rent, 0);
  return {
    total_cars: rows.length,
    paid_cars: paid.length,
    unpaid_cars: unpaid.length,
    collected,
    pending,
    expected: collected + pending,
  };
}

function monthSheet(data: AppData, month: string): MonthSheet {
  const rows = monthRows(data, month);
  return { month, rows, summary: summarize(rows) };
}

function dashboard(data: AppData, month: string): Dashboard {
  const trend = [];
  for (let back = 11; back >= 0; back--) {
    const m = shiftMonth(month, -back);
    trend.push({ month: m, ...summarize(monthRows(data, m)) });
  }
  return { ...monthSheet(data, month), trend, active_cars: data.cars.filter(c => c.active).length };
}

function cleanPayment(data: AppData, body: Body): Payment {
  const car = findCar(data, toId(body.car_id));
  const month = text(body.month);
  if (!MONTH_RE.test(month)) throw new ApiError("Invalid month");
  const amount = toAmount(body.amount, "Amount");
  if (amount <= 0) throw new ApiError("Amount must be more than zero");
  const paidOn = text(body.paid_on) || today();
  if (!DATE_RE.test(paidOn)) throw new ApiError("Invalid date");
  return { car_id: car.id, month, amount, paid_on: paidOn, note: text(body.note) };
}

function csvCell(value: unknown): string {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function exportCsv(data: AppData, month: string): Response {
  const rows = monthRows(data, month);
  const s = summarize(rows);
  const lines: unknown[][] = [
    ["#", "Car", "Number", "Owner / Driver", "Monthly Rent", "Status", "Amount Received", "Received On", "Note"],
    ...rows.map((r, i) => [i + 1, r.name, r.number, r.owner, r.monthly_rent, r.paid ? "Received" : "Pending",
      r.paid ? r.amount : "", r.paid_on ?? "", r.pay_note ?? ""]),
    [],
    ["", "Total received", "", "", "", "", s.collected],
    ["", "Cars paid", "", "", "", "", s.paid_cars],
    ["", "Cars pending", "", "", "", "", s.unpaid_cars],
    ["", "Pending amount", "", "", "", "", s.pending],
  ];
  const csv = "﻿" + lines.map(l => l.map(csvCell).join(",")).join("\r\n") + "\r\n"; // BOM so Excel reads UTF-8
  return download(csv, "text/csv; charset=utf-8", `rent-${month}.csv`);
}

/* ---------------------------------------------------------------- backup & restore */

function backupFile(data: AppData): Response {
  const file: BackupFile = {
    app: "mashaal-rent", version: 1, exported_at: new Date().toISOString(),
    cars: data.cars, payments: data.payments,
  };
  return download(JSON.stringify(file, null, 1), "application/json; charset=utf-8",
    `mashaal-rent-backup-${today()}.json`);
}

function readBackup(body: Body): AppData {
  if (body.app !== "mashaal-rent" || !Array.isArray(body.cars) || !Array.isArray(body.payments)) {
    throw new ApiError("This is not a Mashaal Rent backup file");
  }
  const data = emptyData();
  for (const raw of body.cars as Body[]) {
    const car = cleanCar(raw);
    const id = toId(raw.id);
    if (data.cars.some(c => c.id === id)) throw new ApiError("The backup file is damaged (repeated car id)");
    checkUniqueNumber(data, car.number);
    data.cars.push({ ...car, id, active: raw.active !== false, created_at: text(raw.created_at) || new Date().toISOString() });
  }
  const seen = new Set<string>();
  for (const raw of body.payments as Body[]) {
    const p = cleanPayment(data, raw);
    const key = `${p.car_id}:${p.month}`;
    if (!seen.has(key)) data.payments.push(p);
    seen.add(key);
  }
  data.next_id = Math.max(0, ...data.cars.map(c => c.id)) + 1;
  return data;
}

/* ---------------------------------------------------------------- router */

async function readJson(req: Request): Promise<Body> {
  const raw = await req.text();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError("Invalid request");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError("Invalid request");
  return parsed as Body;
}

async function route(req: Request, kv: KV): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method.toUpperCase();
  const is = (m: string, ...path: string[]) =>
    method === m && parts.length === path.length && path.every((p, i) => p === "*" || p === parts[i]);
  const body = method === "POST" || method === "PUT" ? await readJson(req) : {};
  const secure = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

  // ---- login (open to everyone)
  const { auth, etag: authEtag } = await loadAuth(kv);

  if (is("GET", "session")) {
    const info: SessionInfo = { setup_needed: !auth.password, logged_in: isLoggedIn(req, auth) };
    return json(info);
  }
  if (is("POST", "setup")) {
    if (auth.password) throw new ApiError("A password is already set. Please log in.", 403);
    const next = { ...auth, password: hashPassword(checkNewPassword(body.password)) };
    if (!(await kv.write(AUTH_KEY, next, authEtag))) throw new ApiError("A password is already set. Please log in.", 403);
    return json({ ok: true }, 200, [sessionCookie(next, secure)]);
  }
  if (is("POST", "login")) {
    if (!verifyPassword(String(body.password ?? ""), auth.password)) {
      await sleep(1000); // slows down password guessing
      throw new ApiError("Wrong password", 401);
    }
    return json({ ok: true }, 200, [sessionCookie(auth, secure)]);
  }
  if (is("POST", "logout")) return json({ ok: true }, 200, [logoutCookie(secure)]);

  if (!isLoggedIn(req, auth)) throw new ApiError("Please log in", 401);

  // ---- everything below needs a login
  if (is("POST", "password")) {
    if (!verifyPassword(String(body.current ?? ""), auth.password)) {
      await sleep(1000);
      throw new ApiError("Current password is wrong");
    }
    const next = { ...auth, password: hashPassword(checkNewPassword(body.new)) };
    if (!(await kv.write(AUTH_KEY, next, authEtag))) throw new ApiError("Please try again", 409);
    return json({ ok: true }, 200, [sessionCookie(next, secure)]);
  }

  if (is("GET", "cars")) return json(listCars((await loadData(kv)).data));
  if (is("GET", "cars", "*", "history")) return json(carHistory((await loadData(kv)).data, toId(parts[1])));
  if (is("GET", "month")) return json(monthSheet((await loadData(kv)).data, monthParam(url.searchParams.get("m"))));
  if (is("GET", "dashboard")) return json(dashboard((await loadData(kv)).data, monthParam(url.searchParams.get("m"))));
  if (is("GET", "export")) return exportCsv((await loadData(kv)).data, monthParam(url.searchParams.get("m")));
  if (is("GET", "backup")) return backupFile((await loadData(kv)).data);

  if (is("POST", "cars")) {
    const car = await change(kv, data => {
      const fields = cleanCar(body);
      checkUniqueNumber(data, fields.number);
      const created: Car = { ...fields, id: data.next_id++, active: true, created_at: new Date().toISOString() };
      data.cars.push(created);
      return created;
    });
    return json({ car });
  }

  if (is("PUT", "cars", "*")) {
    const id = toId(parts[1]);
    const car = await change(kv, data => {
      const current = findCar(data, id);
      if (Object.keys(body).length === 1 && "active" in body) {
        current.active = Boolean(body.active);
      } else {
        const fields = cleanCar(body);
        checkUniqueNumber(data, fields.number, id);
        Object.assign(current, fields);
      }
      return { ...current };
    });
    return json({ car });
  }

  if (is("DELETE", "cars", "*")) {
    const id = toId(parts[1]);
    const archived = await change(kv, data => {
      const car = findCar(data, id);
      if (data.payments.some(p => p.car_id === id)) {
        car.active = false; // keep rent history safe: hide the car instead of deleting it
        return true;
      }
      data.cars = data.cars.filter(c => c.id !== id);
      return false;
    });
    return json({ archived });
  }

  if (is("POST", "payments")) {
    const saved = await change(kv, data => {
      const p = cleanPayment(data, body);
      const i = data.payments.findIndex(x => x.car_id === p.car_id && x.month === p.month);
      if (i >= 0) data.payments[i] = p;
      else data.payments.push(p);
      return p;
    });
    return json({ ok: true, ...saved });
  }

  if (is("DELETE", "payments")) {
    const carId = toId(url.searchParams.get("car_id"));
    const month = monthParam(url.searchParams.get("m") ?? url.searchParams.get("month"));
    await change(kv, data => {
      data.payments = data.payments.filter(p => !(p.car_id === carId && p.month === month));
    });
    return json({ ok: true });
  }

  if (is("POST", "restore")) {
    const restored = readBackup(body);
    await change(kv, data => Object.assign(data, restored));
    return json({ ok: true, cars: restored.cars.length, payments: restored.payments.length });
  }

  throw new ApiError("Not found", 404);
}

/** Handles every /api/... request. */
export async function handle(req: Request, kv: KV): Promise<Response> {
  try {
    return await route(req, kv);
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: "Something went wrong on the server" }, 500);
  }
}
