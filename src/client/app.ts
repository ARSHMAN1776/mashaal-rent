import * as db from "./db";
import {
  carHistory, checkBackup, cleanCar, cleanPayment, dashboard, monthCsv, monthSheet, shiftMonth, thisMonth, todayISO,
} from "./rent";
import type { Car, MonthRow, MonthSheet, Receipt } from "./types";

/* ================= helpers ================= */

function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}
const $opt = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];

const nf = new Intl.NumberFormat("en-PK", { maximumFractionDigits: 0 });
const rs = (n: number | null | undefined) => "Rs " + nf.format(n || 0);
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const parseAmount = (v: unknown) => Number(String(v ?? "").replace(/[,\s]/g, ""));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function monthDate(m: string): Date {
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1);
}
const monthLabel = (m: string, month: "long" | "short" = "long") =>
  monthDate(m).toLocaleDateString("en-GB", { month, year: "numeric" });
const monthShort = (m: string) => monthDate(m).toLocaleDateString("en-GB", { month: "short" });

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// Short money labels for the chart: 45k, 4.5 L (lakh), 1.2 Cr (crore)
function compact(n: number): string {
  const cut = (x: number) => x.toFixed(1).replace(/\.0$/, "");
  if (n >= 1e7) return cut(n / 1e7) + " Cr";
  if (n >= 1e5) return cut(n / 1e5) + " L";
  if (n >= 1e3) return cut(n / 1e3) + "k";
  return String(n);
}

function formValues(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  new FormData(form).forEach((value, key) => { if (typeof value === "string") out[key] = value; });
  return out;
}

function saveFile(content: string, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const CAMERA_SVG = `<svg viewBox="0 0 24 24" class="ic-sm"><path d="M4 8h3l1.4-2.1a1 1 0 0 1 .8-.4h5.6a1 1 0 0 1 .8.4L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.2"/></svg>`;

/* ================= state ================= */

const state = {
  month: thisMonth(),
  rows: new Map<number, MonthRow>(), // car id -> row for the month on screen
  sheet: null as MonthSheet | null,  // Monthly Rent data
  cars: [] as Car[],
  receiptCounts: new Map<number, number>(), // car id -> screenshots for the month on screen
  rentFilter: "all" as "all" | "pending" | "paid",
  rentQuery: "",
  carQuery: "",
  showRemoved: false,
};

let toastTimer: number | undefined;
function toast(msg: string, kind: "ok" | "error" = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.className = "toast " + kind), 3400);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Shows the error; sends the user to the login screen if the login has expired. */
function handleError(err: unknown, show: (msg: string) => void = msg => toast(msg, "error")) {
  if (err instanceof db.SessionError) {
    showAuth();
    return;
  }
  show(errorText(err));
}

// Runs an action and shows any error as a message.
async function run(fn: () => Promise<unknown>) {
  try { await fn(); }
  catch (err) { handleError(err); }
}

function remember(rows: MonthRow[]) {
  state.rows = new Map(rows.map(r => [r.id, r]));
}

/* ================= login ================= */

const dlg = $<HTMLDialogElement>("#dlg");

function showAuth() {
  $("#app").hidden = true;
  $("#auth").hidden = false;
  if (dlg.open) dlg.close();
  $(".form-error", $("#auth-form")).textContent = "";
  $<HTMLInputElement>("#auth-form input[name=password]").value = "";
  const email = $<HTMLInputElement>("#auth-form input[name=email]");
  (email.value ? $<HTMLInputElement>("#auth-form input[name=password]") : email).focus();
}

function showApp(email: string | undefined) {
  $("#auth").hidden = true;
  $("#app").hidden = false;
  $("#user-email").textContent = email ?? "";
  void render();
}

$<HTMLFormElement>("#auth-form").addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const f = formValues(form);
  const err = $(".form-error", form);
  const btn = $<HTMLButtonElement>("#auth-btn");
  err.textContent = "";
  btn.disabled = true;
  try {
    const { data, error } = await db.supabase.auth.signInWithPassword({ email: f.email.trim(), password: f.password });
    if (error) {
      throw new Error(/invalid/i.test(error.message)
        ? "Wrong email or password."
        : /fetch|network/i.test(error.message)
          ? "Can't reach the database. Check your internet connection and try again."
          : error.message);
    }
    showApp(data.user?.email);
  } catch (ex) {
    err.textContent = errorText(ex);
    $<HTMLInputElement>("input[name=password]", form).select();
  } finally {
    btn.disabled = false;
  }
});

/* ================= month switch ================= */

function buildMonthSwitches() {
  $$(".month-switch").forEach(ms => {
    ms.innerHTML = `
      <button class="icon-btn" type="button" data-action="step-month" data-step="-1" aria-label="Previous month">
        <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
      <button class="month-text" type="button" data-action="pick-month" title="Choose a month"></button>
      <input class="month-picker" type="month" tabindex="-1" aria-hidden="true">
      <button class="icon-btn" type="button" data-action="step-month" data-step="1" aria-label="Next month">
        <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
      <button class="this-month" type="button" data-action="this-month">This month</button>`;
    $<HTMLInputElement>(".month-picker", ms).addEventListener("change", e => {
      const value = (e.target as HTMLInputElement).value;
      if (value) setMonth(value);
    });
  });
}

function syncMonthSwitches() {
  $$(".month-switch").forEach(ms => {
    $(".month-text", ms).textContent = monthLabel(state.month);
    $<HTMLInputElement>(".month-picker", ms).value = state.month;
    $(".this-month", ms).hidden = state.month === thisMonth();
  });
}

function setMonth(m: string) {
  if (!/^\d{4}-\d{2}$/.test(m) || m === state.month) return;
  state.month = m;
  void render();
}

/* ================= pages ================= */

const VIEWS = ["dashboard", "rent", "cars"] as const;
type View = (typeof VIEWS)[number];
const currentView = (): View => {
  const hash = location.hash.slice(1);
  return (VIEWS as readonly string[]).includes(hash) ? (hash as View) : "dashboard";
};

function render() {
  const view = currentView();
  $$(".view").forEach(s => (s.hidden = s.id !== "view-" + view));
  $$<HTMLAnchorElement>(".nav a").forEach(a => a.classList.toggle("active", a.dataset.view === view));
  syncMonthSwitches();
  const pages: Record<View, () => Promise<void>> = { dashboard: renderDashboard, rent: renderRent, cars: renderCars };
  return run(pages[view]);
}

/* ---------- dashboard ---------- */

function stat(label: string, value: string | number, sub: string, tone = "") {
  return `<div class="card stat ${tone}"><div class="label">${label}</div>
    <div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

async function renderDashboard() {
  const month = state.month;
  const [cars, payments] = await Promise.all([db.listCars(), db.paymentsBetween(shiftMonth(month, -11), month)]);
  if (month !== state.month) return; // the month changed while loading
  const d = dashboard(cars, payments, month);
  remember(d.rows);
  const s = d.summary;
  const noCars = d.active_cars === 0 && d.rows.length === 0;
  $("#dash-welcome").hidden = !noCars;
  $("#dash-content").hidden = noCars;
  if (noCars) return;

  const pct = s.total_cars ? Math.round((s.paid_cars / s.total_cars) * 100) : 0;
  const yearTotal = d.trend.reduce((a, t) => a + t.collected, 0);
  $("#dash-stats").innerHTML = [
    stat("Rent received", rs(s.collected), s.expected ? `out of ${rs(s.expected)}` : "No rent due this month", "hero"),
    stat("Cars paid", `${s.paid_cars}<small> / ${s.total_cars}</small>`, `${pct}% of cars have paid`),
    stat("Cars not paid", s.unpaid_cars,
      s.unpaid_cars ? `${rs(s.pending)} still to come` : "Everyone has paid", s.unpaid_cars ? "warn" : ""),
    stat("Last 12 months", rs(yearTotal),
      `${monthLabel(d.trend[0].month, "short")} to ${monthLabel(month, "short")}`),
  ].join("");

  $("#dash-progress").innerHTML = `
    <div class="progress-top">
      <span><strong>${s.paid_cars} of ${plural(s.total_cars, "car")}</strong> paid rent for ${monthLabel(month)}</span>
      <span class="pct">${pct}%</span>
    </div>
    <div class="bar"><span style="width:${pct}%"></span></div>`;

  const unpaid = d.rows.filter(r => !r.paid);
  const paid = d.rows.filter(r => r.paid);
  $("#unpaid-count").textContent = String(unpaid.length);
  $("#paid-count").textContent = String(paid.length);

  $("#dash-unpaid").innerHTML = unpaid.length
    ? unpaid.map(r => `
      <li>
        <div class="li-main"><strong>${esc(r.name)}</strong><span class="plate">${esc(r.number)}</span></div>
        <div class="li-side">
          <div class="li-amt"><strong>${rs(r.monthly_rent)}</strong><span>due</span></div>
          <button class="btn sm primary" type="button" data-action="receive" data-id="${r.id}">Mark paid</button>
        </div>
      </li>`).join("")
    : `<li class="empty">${d.rows.length ? "All cars have paid for this month." : "No cars for this month."}</li>`;

  $("#dash-paid").innerHTML = paid.length
    ? paid.map(r => `
      <li>
        <div class="li-main"><strong>${esc(r.name)}</strong><span class="plate">${esc(r.number)}</span></div>
        <div class="li-side">
          <div class="li-amt"><strong>${rs(r.amount)}</strong><span>${fmtDate(r.paid_on)}</span></div>
        </div>
      </li>`).join("")
    : `<li class="empty">No rent received yet for this month.</li>`;

  const max = Math.max(1, ...d.trend.map(t => Math.max(t.expected, t.collected)));
  const h = (v: number) => (v ? Math.max(2, (v / max) * 100) : 0);
  $("#dash-chart").innerHTML = d.trend.map(t => `
    <button class="col ${t.month === month ? "sel" : ""}" type="button" data-action="goto-month" data-month="${t.month}"
      title="${monthLabel(t.month)}: ${rs(t.collected)} received out of ${rs(t.expected)}. ${t.paid_cars} of ${t.total_cars} cars paid.">
      <span class="val">${t.collected ? compact(t.collected) : ""}</span>
      <span class="track">
        <span class="exp" style="height:${h(t.expected)}%"></span>
        <span class="fill" style="height:${h(t.collected)}%"></span>
      </span>
      <span class="lbl">${monthShort(t.month)}</span>
    </button>`).join("");
}

/* ---------- monthly rent ---------- */

async function renderRent() {
  const month = state.month;
  const [cars, payments, receiptCounts] = await Promise.all([
    db.listCars(), db.paymentsBetween(month, month), db.receiptCountsForMonth(month),
  ]);
  if (month !== state.month) return;
  const d = monthSheet(cars, payments, month);
  remember(d.rows);
  state.sheet = d;
  state.receiptCounts = receiptCounts;
  const s = d.summary;
  $("#rent-summary").innerHTML = `
    <div><span>Rent received</span><strong>${rs(s.collected)}</strong></div>
    <div><span>Cars paid</span><strong>${s.paid_cars} <small class="muted">/ ${s.total_cars}</small></strong></div>
    <div><span>Cars not paid</span><strong class="${s.unpaid_cars ? "warn-text" : ""}">${s.unpaid_cars}</strong></div>
    <div><span>Amount still to come</span><strong>${rs(s.pending)}</strong></div>`;
  drawRentTable();
}

function rentRow(r: MonthRow, i: number, receiptCounts: Map<number, number>): string {
  const car = `<div class="car-cell"><strong>${esc(r.name)}</strong>${r.owner ? `<span>${esc(r.owner)}</span>` : ""}</div>`;
  // data-label is shown as a small heading when the row turns into a card on phones
  const head = `<td class="num idx c-idx">${i + 1}</td><td class="c-car">${car}</td>
    <td class="c-plate"><span class="plate">${esc(r.number)}</span></td>
    <td class="num c-rent" data-label="Monthly rent">${rs(r.monthly_rent)}</td>`;
  if (r.paid) {
    const amount = r.amount ?? 0;
    const short = amount < r.monthly_rent ? `<span class="short-note">${rs(r.monthly_rent - amount)} less</span>` : "";
    const count = receiptCounts.get(r.id) ?? 0;
    const badge = count
      ? `<button type="button" class="receipt-badge" data-action="edit-pay" data-id="${r.id}" title="${plural(count, "screenshot")} attached — open to view">${CAMERA_SVG}${count > 1 ? count : ""}</button>`
      : "";
    return `<tr data-id="${r.id}">${head}
      <td class="num strong c-amt" data-label="Amount received">${rs(amount)}${short}</td>
      <td class="c-date" data-label="Date received">${fmtDate(r.paid_on)}${r.pay_note ? `<div class="small muted">${esc(r.pay_note)}</div>` : ""}</td>
      <td class="c-status"><span class="badge ok">Paid</span>${badge}</td>
      <td class="actions c-act">
        <button class="btn sm ghost" type="button" data-action="edit-pay" data-id="${r.id}">Edit</button>
        <button class="btn sm ghost danger" type="button" data-action="undo-pay" data-id="${r.id}">Undo</button>
      </td></tr>`;
  }
  return `<tr data-id="${r.id}">${head}
    <td class="num c-amt" data-label="Amount received"><input class="in-amt" data-money inputmode="numeric" value="${nf.format(r.monthly_rent)}" aria-label="Amount received"></td>
    <td class="c-date" data-label="Date received"><input class="in-date" type="date" value="${todayISO()}" aria-label="Date received"></td>
    <td class="c-status"><span class="badge warn">Not paid</span></td>
    <td class="actions c-act">
      <button class="btn sm primary" type="button" data-action="quick-receive" data-id="${r.id}">Mark paid</button>
      <button class="btn sm ghost icon-only" type="button" data-action="receive" data-id="${r.id}" title="Mark paid with a screenshot">${CAMERA_SVG}</button>
    </td>
  </tr>`;
}

function drawRentTable() {
  if (!state.sheet) return;
  const all = state.sheet.rows;
  const paidN = all.filter(r => r.paid).length;
  const filters: [typeof state.rentFilter, string, number][] =
    [["all", "All", all.length], ["pending", "Not paid", all.length - paidN], ["paid", "Paid", paidN]];
  $("#rent-filter").innerHTML = filters
    .map(([key, label, n]) => `<button type="button" class="${state.rentFilter === key ? "on" : ""}" data-action="filter" data-filter="${key}">${label}<span class="n">${n}</span></button>`)
    .join("");

  const body = $("#rent-body");
  if (!all.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty">No cars for ${monthLabel(state.month)}. <a href="#cars">Add a car</a> first.</td></tr>`;
    return;
  }
  const q = state.rentQuery.trim().toLowerCase();
  const rows = all.filter(r =>
    (state.rentFilter === "all" || (state.rentFilter === "paid") === r.paid) &&
    (!q || `${r.name} ${r.number} ${r.owner}`.toLowerCase().includes(q)));
  body.innerHTML = rows.length
    ? rows.map((r, i) => rentRow(r, i, state.receiptCounts)).join("")
    : `<tr><td colspan="8" class="empty">No cars match.</td></tr>`;
}

async function quickReceive(btn: HTMLButtonElement, row: MonthRow) {
  const tr = btn.closest("tr")!;
  const amountInput = $<HTMLInputElement>(".in-amt", tr);
  btn.disabled = true;
  try {
    const payment = cleanPayment({
      car_id: row.id, month: state.month, amount: amountInput.value,
      paid_on: $<HTMLInputElement>(".in-date", tr).value,
    });
    await db.savePayment(payment);
    toast(`Saved: ${row.name} (${row.number}) paid ${rs(payment.amount)}`);
    await render();
  } catch (err) {
    btn.disabled = false;
    handleError(err);
    amountInput.focus();
  }
}

async function undoPayment(row: MonthRow) {
  if (!confirm(`Remove the rent entry for ${row.name} (${row.number}) for ${monthLabel(state.month)}?\n\nThe car will show as "Not paid" again.`)) return;
  await db.deletePayment(row.id, state.month);
  toast("Rent entry removed.");
  await render();
}

async function exportMonth() {
  const month = state.month;
  const [cars, payments] = await Promise.all([db.listCars(), db.paymentsBetween(month, month)]);
  saveFile(monthCsv(monthSheet(cars, payments, month)), "text/csv;charset=utf-8", `rent-${month}.csv`);
}

/* ---------- cars ---------- */

function carFields(c: Partial<Car> = {}): string {
  return `
    <label class="field"><span>Car name</span>
      <input name="name" required placeholder="e.g. Toyota Corolla 2020" value="${esc(c.name)}"></label>
    <label class="field"><span>Car number</span>
      <input name="number" class="upper" required placeholder="e.g. LEA-1234" value="${esc(c.number)}"></label>
    <label class="field"><span>Monthly rent (Rs)</span>
      <input name="monthly_rent" data-money inputmode="numeric" required placeholder="e.g. 45,000"
        value="${c.monthly_rent != null ? nf.format(c.monthly_rent) : ""}"></label>
    <label class="field"><span>Owner or driver <em>(optional)</em></span>
      <input name="owner" placeholder="Name" value="${esc(c.owner)}"></label>
    <label class="field"><span>Rent starts from</span>
      <input name="start_month" type="month" required value="${esc(c.start_month || thisMonth())}"></label>
    <label class="field"><span>Notes <em>(optional)</em></span>
      <input name="notes" placeholder="Anything to remember" value="${esc(c.notes)}"></label>`;
}

async function renderCars() {
  state.cars = await db.listCars();
  drawCarsTable();
}

function drawCarsTable() {
  const active = state.cars.filter(c => c.active).length;
  const removed = state.cars.length - active;
  $("#cars-count").textContent = plural(active, "car");
  const toggle = $("#removed-toggle");
  toggle.hidden = !removed;
  $("span", toggle).textContent = `Show removed cars (${removed})`;
  if (!removed) state.showRemoved = false;
  $<HTMLInputElement>("input", toggle).checked = state.showRemoved;

  const q = state.carQuery.trim().toLowerCase();
  const list = state.cars
    .filter(c => (state.showRemoved || c.active) && (!q || `${c.name} ${c.number} ${c.owner}`.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.active) - Number(a.active)
      || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.number.localeCompare(b.number));

  const body = $("#cars-body");
  if (!state.cars.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">No cars yet. Use the form above to add your first car.</td></tr>`;
    return;
  }
  body.innerHTML = list.length ? list.map((c, i) => `
    <tr class="${c.active ? "" : "is-removed"}">
      <td class="num idx c-idx">${i + 1}</td>
      <td class="c-car"><div class="car-cell"><strong>${esc(c.name)}</strong>${c.notes ? `<span>${esc(c.notes)}</span>` : ""}</div></td>
      <td class="c-plate"><span class="plate">${esc(c.number)}</span></td>
      <td class="c-owner ${c.owner ? "" : "c-none"}" data-label="Owner or driver">${c.owner ? esc(c.owner) : '<span class="muted">—</span>'}</td>
      <td class="num c-rent" data-label="Monthly rent">${rs(c.monthly_rent)}</td>
      <td class="c-start" data-label="Rent from">${monthLabel(c.start_month, "short")}${c.active ? "" : ' <span class="badge muted">Removed</span>'}</td>
      <td class="actions c-act">
        <button class="btn sm ghost" type="button" data-action="history" data-id="${c.id}">History</button>
        ${c.active
          ? `<button class="btn sm ghost" type="button" data-action="edit-car" data-id="${c.id}">Edit</button>
             <button class="btn sm ghost danger" type="button" data-action="delete-car" data-id="${c.id}">Delete</button>`
          : `<button class="btn sm ghost" type="button" data-action="restore-car" data-id="${c.id}">Bring back</button>`}
      </td>
    </tr>`).join("")
    : `<tr><td colspan="7" class="empty">No cars match.</td></tr>`;
}

async function deleteCar(c: Car) {
  if (!confirm(`Delete ${c.name} (${c.number})?`)) return;
  const hidden = await db.deleteCar(c.id);
  toast(hidden
    ? `${c.number} has rent history, so it was moved to removed cars. Its history is kept.`
    : `${c.number} deleted.`);
  await renderCars();
}

async function restoreCar(c: Car) {
  await db.updateCar(c.id, { active: true });
  toast(`${c.number} is back in your car list.`);
  await renderCars();
}

/* ================= dialogs ================= */

// Opens the popup. onSave runs when its form is submitted; an error it throws is shown in the popup.
function openDialog(html: string, { wide = false, onSave }: { wide?: boolean; onSave?: (form: HTMLFormElement) => Promise<void> } = {}) {
  dlg.className = wide ? "wide" : "";
  dlg.innerHTML = html;
  dlg.showModal();
  const form = $opt<HTMLFormElement>("form", dlg);
  if (form && onSave) {
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const btn = $<HTMLButtonElement>("button[type=submit]", form);
      const err = $(".form-error", form);
      btn.disabled = true;
      err.textContent = "";
      try {
        await onSave(form);
        dlg.close();
      } catch (ex) {
        handleError(ex, msg => (err.textContent = msg));
      } finally {
        btn.disabled = false;
      }
    });
  }
  const first = $opt<HTMLInputElement>("[data-autofocus]", dlg);
  if (first) { first.focus(); first.select(); }
}

function receiptListHtml(receipts: Receipt[]): string {
  if (!receipts.length) return "";
  return `
    <div class="field"><span>Payment screenshot${receipts.length > 1 ? "s" : ""}</span>
      <div class="receipt-list">
        ${receipts.map(r => `
          <div class="receipt-item" data-receipt-id="${r.id}" data-receipt-path="${esc(r.path)}">
            <button type="button" class="btn sm ghost" data-action="view-receipt">${CAMERA_SVG} View</button>
            <span class="small muted">${fmtDate(r.uploaded_at.slice(0, 10))}</span>
            <button type="button" class="btn sm ghost danger" data-action="remove-receipt">Remove</button>
          </div>`).join("")}
      </div>
    </div>`;
}

async function openPaymentDialog(row: MonthRow) {
  const editing = row.paid;
  const month = state.month;
  const receipts = editing ? await db.receiptsFor(row.id, month) : [];
  openDialog(`
    <form class="dlg" autocomplete="off">
      <header>
        <h3>${editing ? "Edit rent entry" : "Mark rent as paid"}</h3>
        <p>${esc(row.name)} · <span class="plate">${esc(row.number)}</span> · ${monthLabel(month)}</p>
      </header>
      <div class="dlg-body">
        <label class="field"><span>Amount received (Rs)</span>
          <input name="amount" data-money data-autofocus inputmode="numeric" required
            value="${nf.format(editing ? row.amount ?? 0 : row.monthly_rent)}"></label>
        <label class="field"><span>Date received</span>
          <input name="paid_on" type="date" required value="${editing && row.paid_on ? row.paid_on : todayISO()}"></label>
        <label class="field"><span>Note <em>(optional)</em></span>
          <input name="note" placeholder="e.g. cash, bank transfer" value="${esc(editing ? row.pay_note : "")}"></label>
        ${receiptListHtml(receipts)}
        <label class="field"><span>${receipts.length ? "Add another screenshot" : "Payment screenshot"} <em>(optional)</em></span>
          <input name="receipt" type="file" accept="image/*,.pdf" capture="environment"></label>
        <p class="form-error" role="alert"></p>
      </div>
      <footer>
        <button class="btn ghost" type="button" data-action="close-dlg">Cancel</button>
        <button class="btn primary" type="submit">Save</button>
      </footer>
    </form>`, {
    onSave: async form => {
      const payment = cleanPayment({ ...formValues(form), car_id: row.id, month });
      await db.savePayment(payment);
      const file = $<HTMLInputElement>("input[name=receipt]", form).files?.[0];
      if (file) {
        try { await db.uploadReceipt(row.id, month, file); }
        catch (err) { toast(`Rent saved, but the screenshot was not uploaded: ${errorText(err)}`, "error"); }
      }
      toast(`Saved: ${row.name} (${row.number}) paid ${rs(payment.amount)}`);
      void render();
    },
  });
}

async function viewReceipt(el: HTMLElement) {
  const path = el.closest<HTMLElement>("[data-receipt-path]")!.dataset.receiptPath!;
  window.open(await db.receiptUrl(path), "_blank", "noopener");
}

async function removeReceiptClick(el: HTMLElement) {
  const item = el.closest<HTMLElement>("[data-receipt-id]")!;
  if (!confirm("Remove this screenshot? This cannot be undone.")) return;
  await db.deleteReceipt({ id: Number(item.dataset.receiptId), path: item.dataset.receiptPath! });
  item.remove();
  toast("Screenshot removed.");
  void render(); // updates the camera badge on the main table
}

function openCarDialog(c: Car) {
  openDialog(`
    <form class="dlg" autocomplete="off">
      <header><h3>Edit car</h3><p>Changing the monthly rent does not change rent already received.</p></header>
      <div class="dlg-body grid">${carFields(c)}<p class="form-error" role="alert"></p></div>
      <footer>
        <button class="btn ghost" type="button" data-action="close-dlg">Cancel</button>
        <button class="btn primary" type="submit">Save changes</button>
      </footer>
    </form>`, {
    wide: true,
    onSave: async form => {
      await db.updateCar(c.id, cleanCar(formValues(form)));
      toast("Car details saved.");
      void renderCars();
    },
  });
}

async function openHistory(car: Car) {
  const [payments, receipts] = await Promise.all([db.paymentsForCar(car.id), db.receiptsForCar(car.id)]);
  const d = carHistory(car, payments);
  const firstReceipt = new Map<string, Receipt>();
  const countByMonth = new Map<string, number>();
  for (const r of receipts) {
    countByMonth.set(r.month, (countByMonth.get(r.month) ?? 0) + 1);
    if (!firstReceipt.has(r.month)) firstReceipt.set(r.month, r);
  }
  const rows = d.months.map(m => {
    const first = firstReceipt.get(m.month);
    const count = countByMonth.get(m.month) ?? 0;
    const badge = first
      ? `<button type="button" class="receipt-badge" data-action="view-receipt" data-receipt-path="${esc(first.path)}"
          title="${count > 1 ? `View screenshot (1 of ${count})` : "View screenshot"}">${CAMERA_SVG}</button>`
      : "";
    return `
    <tr>
      <td>${monthLabel(m.month)}</td>
      <td>${m.paid ? '<span class="badge ok">Paid</span>' : '<span class="badge warn">Not paid</span>'}</td>
      <td class="num ${m.paid ? "strong" : "muted"}">${m.paid ? rs(m.amount) : "—"}${badge}</td>
      <td class="h-date">${m.paid ? fmtDate(m.paid_on) : ""}${m.note ? `<div class="small muted">${esc(m.note)}</div>` : ""}</td>
    </tr>`;
  }).join("");
  openDialog(`
    <div class="dlg">
      <header>
        <h3>${esc(car.name)} <span class="plate">${esc(car.number)}</span></h3>
        <p>Rent history · ${rs(car.monthly_rent)} per month${car.owner ? " · " + esc(car.owner) : ""}</p>
      </header>
      <div class="hist-stats">
        <div><span>Total received</span><strong>${rs(d.total)}</strong></div>
        <div><span>Months paid</span><strong>${d.paid_months}</strong></div>
        <div><span>Months not paid</span><strong class="${d.pending_months ? "warn-text" : ""}">${d.pending_months}</strong></div>
      </div>
      <div class="dlg-body flush">
        <table class="table">
          <thead><tr><th>Month</th><th>Status</th><th class="num">Amount</th><th class="h-date">Date received</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="4" class="empty">Rent starts from ${monthLabel(car.start_month)}.</td></tr>`}</tbody>
        </table>
      </div>
      <footer><button class="btn primary" type="button" data-action="close-dlg">Close</button></footer>
    </div>`, { wide: true });
}

function openPasswordDialog() {
  openDialog(`
    <form class="dlg" autocomplete="off">
      <header><h3>Change password</h3><p>Use at least 6 characters.</p></header>
      <div class="dlg-body">
        <label class="field"><span>Current password</span>
          <input name="current" type="password" required data-autofocus autocomplete="current-password"></label>
        <label class="field"><span>New password</span>
          <input name="new" type="password" required minlength="6" autocomplete="new-password"></label>
        <label class="field"><span>Type the new password again</span>
          <input name="confirm" type="password" required autocomplete="new-password"></label>
        <p class="form-error" role="alert"></p>
      </div>
      <footer>
        <button class="btn ghost" type="button" data-action="close-dlg">Cancel</button>
        <button class="btn primary" type="submit">Change password</button>
      </footer>
    </form>`, {
    onSave: async form => {
      const f = formValues(form);
      if (f.new.length < 6) throw new Error("The new password must be at least 6 characters.");
      if (f.new !== f.confirm) throw new Error("The two new passwords do not match.");
      const { data } = await db.supabase.auth.getUser();
      const email = data.user?.email;
      if (!email) throw new db.SessionError("Please log in again.");
      const check = await db.supabase.auth.signInWithPassword({ email, password: f.current });
      if (check.error) throw new Error("Current password is wrong.");
      const { error } = await db.supabase.auth.updateUser({ password: f.new });
      if (error) throw new Error(error.message);
      toast("Password changed.");
    },
  });
}

async function downloadBackup() {
  const backup = await db.exportAll();
  saveFile(JSON.stringify(backup, null, 1), "application/json", `mashaal-rent-backup-${todayISO()}.json`);
  toast(`Backup downloaded: ${plural(backup.cars.length, "car")}, ${backup.payments.length} rent ${backup.payments.length === 1 ? "entry" : "entries"}.`);
}

function openRestoreDialog() {
  openDialog(`
    <form class="dlg" autocomplete="off">
      <header>
        <h3>Restore backup</h3>
        <p>Choose a backup file you downloaded earlier (mashaal-rent-backup-….json).</p>
      </header>
      <div class="dlg-body">
        <label class="field"><span>Backup file</span>
          <input name="file" type="file" accept=".json,application/json" required></label>
        <p class="warn-box">This <strong>replaces all cars and rent entries</strong> with the ones in the file,
          and removes all payment screenshots (backup files do not include them).
          Download a backup of the current data first if you might need it.</p>
        <p class="form-error" role="alert"></p>
      </div>
      <footer>
        <button class="btn ghost" type="button" data-action="close-dlg">Cancel</button>
        <button class="btn primary" type="submit">Restore</button>
      </footer>
    </form>`, {
    onSave: async form => {
      const file = $<HTMLInputElement>("input[type=file]", form).files?.[0];
      if (!file) throw new Error("Please choose a backup file.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error("This file is not a backup file.");
      }
      const backup = checkBackup(parsed);
      await db.restoreAll(backup);
      toast(`Backup restored: ${plural(backup.cars.length, "car")} and ${backup.payments.length} rent ${backup.payments.length === 1 ? "entry" : "entries"}.`);
      void render();
    },
  });
}

/* ================= events ================= */

document.addEventListener("click", e => {
  const el = (e.target as Element).closest<HTMLElement>("[data-action]");
  if (!el) return;
  const id = Number(el.dataset.id);
  const row = state.rows.get(id);
  const car = state.cars.find(c => c.id === id);

  switch (el.dataset.action) {
    case "step-month": setMonth(shiftMonth(state.month, Number(el.dataset.step))); break;
    case "this-month": setMonth(thisMonth()); break;
    case "goto-month": setMonth(el.dataset.month ?? ""); break;
    case "pick-month": {
      const input = $<HTMLInputElement>(".month-picker", el.closest(".month-switch")!);
      try { input.showPicker(); } catch { input.focus(); }
      break;
    }
    case "filter":
      state.rentFilter = el.dataset.filter as typeof state.rentFilter;
      drawRentTable();
      break;
    case "receive":
    case "edit-pay": if (row) void run(() => openPaymentDialog(row)); break;
    case "quick-receive": if (row) void quickReceive(el as HTMLButtonElement, row); break;
    case "undo-pay": if (row) void run(() => undoPayment(row)); break;
    case "view-receipt": void run(() => viewReceipt(el)); break;
    case "remove-receipt": void run(() => removeReceiptClick(el)); break;
    case "export": void run(exportMonth); break;
    case "edit-car": if (car) openCarDialog(car); break;
    case "delete-car": if (car) void run(() => deleteCar(car)); break;
    case "restore-car": if (car) void run(() => restoreCar(car)); break;
    case "history": if (car) void run(() => openHistory(car)); break;
    case "close-dlg": dlg.close(); break;
    case "backup": void run(downloadBackup); break;
    case "restore-backup": openRestoreDialog(); break;
    case "change-password": openPasswordDialog(); break;
    case "logout": void run(() => db.supabase.auth.signOut()); break;
  }
});

// Close the popup when clicking the dark area around it.
dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });

// Press Enter in an amount box on Monthly Rent to mark that car as paid.
document.addEventListener("keydown", e => {
  const target = e.target as HTMLElement;
  if (e.key === "Enter" && target.matches(".in-amt, .in-date")) {
    e.preventDefault();
    $opt<HTMLButtonElement>("[data-action=quick-receive]", target.closest("tr")!)?.click();
  }
});

// Show money with commas after typing, e.g. 45000 -> 45,000
document.addEventListener("focusout", e => {
  const input = e.target as HTMLInputElement;
  if (!input.matches?.("[data-money]")) return;
  const n = parseAmount(input.value);
  if (input.value.trim() && Number.isFinite(n) && n >= 0) input.value = nf.format(n);
});

$<HTMLInputElement>("#rent-search").addEventListener("input", e => {
  state.rentQuery = (e.target as HTMLInputElement).value;
  drawRentTable();
});
$<HTMLInputElement>("#car-search").addEventListener("input", e => {
  state.carQuery = (e.target as HTMLInputElement).value;
  drawCarsTable();
});
$<HTMLInputElement>("#removed-toggle input").addEventListener("change", e => {
  state.showRemoved = (e.target as HTMLInputElement).checked;
  drawCarsTable();
});

$<HTMLFormElement>("#car-form").addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const err = $(".form-error", form);
  const btn = $<HTMLButtonElement>("button[type=submit]", form);
  err.textContent = "";
  btn.disabled = true;
  try {
    const car = await db.addCar(cleanCar(formValues(form)));
    toast(`${car.name} (${car.number}) added.`);
    form.reset();
    $<HTMLInputElement>("input[name=name]", form).focus();
    await renderCars();
  } catch (ex) {
    handleError(ex, msg => (err.textContent = msg));
  } finally {
    btn.disabled = false;
  }
});

window.addEventListener("hashchange", () => {
  if (dlg.open) dlg.close();
  if (!$("#app").hidden) void render();
});

/* ================= start ================= */

function showSetupNeeded() {
  document.body.innerHTML = `
    <div class="auth"><div class="auth-card">
      <h1>Almost ready</h1>
      <p class="auth-text">The app is not connected to Supabase yet. Open <code>src/client/config.ts</code>,
        paste your Supabase project URL and anon key, then build and deploy again.</p>
    </div></div>`;
}

async function start() {
  if (!db.isConfigured) {
    showSetupNeeded();
    return;
  }
  $(".form-grid", $("#car-form")).innerHTML = carFields();
  buildMonthSwitches();
  $("#today").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  db.supabase.auth.onAuthStateChange(event => {
    if (event === "SIGNED_OUT") showAuth();
  });
  const { data } = await db.supabase.auth.getSession();
  if (data.session) showApp(data.session.user.email);
  else showAuth();
}

void start();
