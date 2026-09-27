// Rows as they are stored in Supabase (see supabase/schema.sql).

export interface Car {
  id: number;
  name: string;
  number: string;
  owner: string;
  monthly_rent: number;
  start_month: string; // YYYY-MM
  active: boolean;
  notes: string;
  created_at: string;
}

export interface Payment {
  car_id: number;
  month: string; // YYYY-MM
  amount: number;
  paid_on: string; // YYYY-MM-DD
  note: string;
}

/** The fields you type in when adding or editing a car. */
export type CarFields = Pick<Car, "name" | "number" | "owner" | "notes" | "monthly_rent" | "start_month">;

/** A payment screenshot or PDF, stored in the "receipts" Supabase Storage bucket. */
export interface Receipt {
  id: number;
  car_id: number;
  month: string; // YYYY-MM
  path: string;
  uploaded_at: string;
}

/** One car's line for a given month. */
export interface MonthRow {
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
}

export interface Summary {
  total_cars: number;
  paid_cars: number;
  unpaid_cars: number;
  collected: number;
  pending: number;
  expected: number;
}

export interface MonthSheet {
  month: string;
  rows: MonthRow[];
  summary: Summary;
}

export interface Dashboard extends MonthSheet {
  trend: (Summary & { month: string })[];
  active_cars: number;
}

export interface HistoryMonth {
  month: string;
  paid: boolean;
  amount: number | null;
  paid_on: string | null;
  note: string;
}

export interface CarHistory {
  car: Car;
  months: HistoryMonth[];
  total: number;
  paid_months: number;
  pending_months: number;
}

/** The file made by "Download backup". */
export interface BackupFile {
  app: "mashaal-rent";
  version: 1;
  exported_at: string;
  cars: Car[];
  payments: Payment[];
}
