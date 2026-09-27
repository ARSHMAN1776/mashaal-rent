// Rent calculations and input checks. No database code here, so it is easy to test.

import type {
  BackupFile, Car, CarFields, CarHistory, Dashboard, HistoryMonth, MonthRow, MonthSheet, Payment, Summary,
} from "./types";

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_AMOUNT = 100_000_000;

const pad = (n: number) => String(n).padStart(2, "0");

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const thisMonth = () => todayISO().slice(0, 7);

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const i = y * 12 + (m - 1) + delta;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}

const text = (value: unknown) => String(value ?? "").trim();

export function toAmount(value: unknown, label: string): number {
  const raw = String(value ?? "").replace(/[,\s]/g, "");
  if (!raw) throw new Error(`${label} is required`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
  if (n < 0 || n > MAX_AMOUNT || !Number.isInteger(n)) throw new Error(`${label} must be a whole number of rupees`);
  return n;
}

/* ---------------- checks before saving ---------------- */

export function cleanCar(input: Record<string, unknown>): CarFields {
  const name = text(input.name).replace(/\s+/g, " ");
  const number = text(input.number).replace(/\s+/g, " ").toUpperCase();
  const start = text(input.start_month) || thisMonth();
  if (!name) throw new Error("Please enter the car name");
  if (!number) throw new Error("Please enter the car number");
  if (!MONTH_RE.test(start)) throw new Error("Please choose a valid start month");
  return {
    name,
    number,
    owner: text(input.owner),
    notes: text(input.notes),
    monthly_rent: toAmount(input.monthly_rent, "Monthly rent"),
    start_month: start,
  };
}

export function cleanPayment(input: Record<string, unknown>): Payment {
  const carId = Number(input.car_id);
  if (!Number.isInteger(carId) || carId <= 0) throw new Error("Invalid car");
  const month = text(input.month);
  if (!MONTH_RE.test(month)) throw new Error("Invalid month");
  const amount = toAmount(input.amount, "Amount");
  if (amount <= 0) throw new Error("Amount must be more than zero");
  const paidOn = text(input.paid_on) || todayISO();
  if (!DATE_RE.test(paidOn)) throw new Error("Please choose a valid date");
  return { car_id: carId, month, amount, paid_on: paidOn, note: text(input.note) };
}

/** Checks a backup file before it is restored. */
export function checkBackup(file: unknown): BackupFile {
  const b = file as Partial<BackupFile> | null;
  if (!b || b.app !== "mashaal-rent" || !Array.isArray(b.cars) || !Array.isArray(b.payments)) {
    throw new Error("This is not a Mashaal Rent backup file");
  }
  const ids = new Set<number>();
  const numbers = new Set<string>();
  const cars: Car[] = b.cars.map(raw => {
    const fields = cleanCar(raw as unknown as Record<string, unknown>);
    const id = Number(raw.id);
    if (!Number.isInteger(id) || id <= 0 || ids.has(id)) throw new Error("The backup file is damaged (car id)");
    if (numbers.has(fields.number)) throw new Error(`The backup file has car ${fields.number} twice`);
    ids.add(id);
    numbers.add(fields.number);
    return { ...fields, id, active: raw.active !== false, created_at: raw.created_at || new Date().toISOString() };
  });
  const seen = new Set<string>();
  const payments: Payment[] = [];
  for (const raw of b.payments) {
    const p = cleanPayment(raw as unknown as Record<string, unknown>);
    if (!ids.has(p.car_id)) throw new Error("The backup file is damaged (rent entry for a missing car)");
    const key = `${p.car_id}:${p.month}`;
    if (!seen.has(key)) payments.push(p);
    seen.add(key);
  }
  return { app: "mashaal-rent", version: 1, exported_at: String(b.exported_at ?? ""), cars, payments };
}

/* ---------------- calculations ---------------- */

const byName = (a: Car, b: Car) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.number.localeCompare(b.number);

/** Every car that owes rent for the month, plus any car that has a payment in it. */
export function monthRows(cars: Car[], payments: Payment[], month: string): MonthRow[] {
  const pays = new Map(payments.filter(p => p.month === month).map(p => [p.car_id, p]));
  return cars
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

export function summarize(rows: MonthRow[]): Summary {
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

export function monthSheet(cars: Car[], payments: Payment[], month: string): MonthSheet {
  const rows = monthRows(cars, payments, month);
  return { month, rows, summary: summarize(rows) };
}

/** `payments` must cover the 12 months ending with `month`. */
export function dashboard(cars: Car[], payments: Payment[], month: string): Dashboard {
  const trend = [];
  for (let back = 11; back >= 0; back--) {
    const m = shiftMonth(month, -back);
    trend.push({ month: m, ...summarize(monthRows(cars, payments, m)) });
  }
  return { ...monthSheet(cars, payments, month), trend, active_cars: cars.filter(c => c.active).length };
}

/** `payments` are all payments of this car. */
export function carHistory(car: Car, payments: Payment[]): CarHistory {
  const pays = new Map(payments.map(p => [p.month, p]));
  const paidMonths = [...pays.keys()].sort();
  const start = [car.start_month, ...paidMonths].sort()[0];
  const end = car.active ? [thisMonth(), ...paidMonths].sort().at(-1)! : paidMonths.at(-1) ?? start;
  const months: HistoryMonth[] = [];
  for (let m = end; m >= start && months.length < 240; m = shiftMonth(m, -1)) {
    const p = pays.get(m);
    months.push({ month: m, paid: !!p, amount: p?.amount ?? null, paid_on: p?.paid_on ?? null, note: p?.note ?? "" });
  }
  return {
    car,
    months,
    total: payments.reduce((sum, p) => sum + p.amount, 0),
    paid_months: pays.size,
    pending_months: months.filter(m => !m.paid).length,
  };
}

/* ---------------- files ---------------- */

function csvCell(value: unknown): string {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function monthCsv(sheet: MonthSheet): string {
  const s = sheet.summary;
  const lines: unknown[][] = [
    ["#", "Car", "Number", "Owner / Driver", "Monthly Rent", "Status", "Amount Received", "Received On", "Note"],
    ...sheet.rows.map((r, i) => [i + 1, r.name, r.number, r.owner, r.monthly_rent, r.paid ? "Received" : "Pending",
      r.paid ? r.amount : "", r.paid_on ?? "", r.pay_note ?? ""]),
    [],
    ["", "Total received", "", "", "", "", s.collected],
    ["", "Cars paid", "", "", "", "", s.paid_cars],
    ["", "Cars pending", "", "", "", "", s.unpaid_cars],
    ["", "Pending amount", "", "", "", "", s.pending],
  ];
  return "﻿" + lines.map(l => l.map(csvCell).join(",")).join("\r\n") + "\r\n"; // BOM so Excel reads UTF-8
}
