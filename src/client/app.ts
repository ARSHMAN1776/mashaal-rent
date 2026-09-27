import type {
  Car, CarHistory, CarWithCount, Dashboard, MonthRow, MonthSheet, SessionInfo,
} from "../shared/types";

/* ================= helpers ================= */

function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}
const $opt = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];

const pad = (n: number) => String(n).padStart(2, "0");
const nf = new Intl.NumberFormat("en-PK", { maximumFractionDigits: 0 });
const rs = (n: number | null | undefined) => "Rs " + nf.format(n || 0);
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const parseAmount = (v: unknown) => Number(String(v ?? "").replace(/[,\s]/g, ""));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const thisMonth = () => todayISO().slice(0, 7);

function shiftMonth(m: string, delta: number): string {
  const [y, mo] = m.split("-").map(Number);
  const i = y * 12 + (mo - 1) + delta;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}
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

/* ================= state & server calls ================= */

const state = {
  month: thisMonth(),
  rows: new Map<number, MonthRow>(), // car id -> row for the month on screen
  sheet: null as MonthSheet | null,  // Monthly Rent data
  cars: [] as CarWithCount[],
  rentFilter: "all" as "all" | "pending" | "paid",
  rentQuery: "",
  carQuery: "",
  showRemoved: false,
};

class LoginNeeded extends Error {}

async function api<T = unknown>(path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch("/api/" + path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can't reach the server. Check your internet connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !["login", "session"].includes(path)) {
    showAuth("login");
    throw new LoginNeeded();
  }
  if (!res.ok) throw new Error((data as { error?: string }).error || "Something went wrong. Please try again.");
  return data as T;
}

let toastTimer: number | undefined;
function toast(msg: string, kind: "ok" | "error" = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.className = "toast " + kind), 3400);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Runs an action and shows any error as a message.
async function run(fn: () => Promise<unknown>) {
  try { await fn(); }
  catch (err) { if (!(err instanceof LoginNeeded)) toast(errorText(err), "error"); }
}

function remember(rows: MonthRow[]) {
  state.rows = new Map(rows.map(r => [r.id, r]));
}

/* ================= login ================= */

let authMode: "login" | "setup" = "login";
const dlg = $<HTMLDialogElement>("#dlg");

function showAuth(mode: "login" | "setup") {
  authMode = mode;
  const setup = mode === "setup";
  $("#app").hidden = true;
  $("#auth").hidden = false;
  if (dlg.open) dlg.close();
  $("#auth-title").textContent = setup ? "Create your password" : "Log in";
  $("#auth-text").textContent = setup
    ? "This is the first time the app is opened. Choose a password (at least 6 characters). You will need it every time you log in."
    : "Enter your password to open the rent register.";
  $("#auth-confirm").hidden = !setup;
  $<HTMLInputElement>("#auth-confirm input").required = setup;
  $("#auth-btn").textContent = setup ? "Save password and continue" : "Log in";
  $(".form-error", $("#auth-form")).textContent = "";
  $<HTMLFormElement>("#auth-form").reset();
  $<HTMLInputElement>("#auth-form input[name=password]").focus();
}

function showApp() {
  $("#auth").hidden = true;
  $("#app").hidden = false;
  void render();
}

$<HTMLFormElement>("#auth-form").addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const f = formValues(form);
  const err = $(".form-error", form);
  const btn = $<HTMLButtonElement>("#auth-btn");
  err.textContent = "";
  if (authMode === "setup" && f.password !== f.confirm) {
    err.textContent = "The two passwords do not match.";
    return;
  }
  btn.disabled = true;
  try {
    await api(authMode === "setup" ? "setup" : "login", { method: "POST", body: { password: f.password } });
    showApp();
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
  const d = await api<Dashboard>("dashboard?m=" + state.month);
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
      `${monthLabel(d.trend[0].month, "short")} to ${monthLabel(state.month, "short")}`),
  ].join("");

  $("#dash-progress").innerHTML = `
    <div class="progress-top">
      <span><strong>${s.paid_cars} of ${plural(s.total_cars, "car")}</strong> paid rent for ${monthLabel(state.month)}</span>
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
    <button class="col ${t.month === state.month ? "sel" : ""}" type="button" data-action="goto-month" data-month="${t.month}"
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
  const d = await api<MonthSheet>("month?m=" + state.month);
  remember(d.rows);
  state.sheet = d;
  $<HTMLAnchorElement>("#rent-export").href = "/api/export?m=" + state.month;
  const s = d.summary;
  $("#rent-summary").innerHTML = `
    <div><span>Rent received</span><strong>${rs(s.collected)}</strong></div>
    <div><span>Cars paid</span><strong>${s.paid_cars} <small class="muted">/ ${s.total_cars}</small></strong></div>
    <div><span>Cars not paid</span><strong class="${s.unpaid_cars ? "warn-text" : ""}">${s.unpaid_cars}</strong></div>
    <div><span>Amount still to come</span><strong>${rs(s.pending)}</strong></div>`;
  drawRentTable();
}

function rentRow(r: MonthRow, i: number): string {
  const car = `<div class="car-cell"><strong>${esc(r.name)}</strong>${r.owner ? `<span>${esc(r.owner)}</span>` : ""}</div>`;
  // data-label is shown as a small heading when the row turns into a card on phones
  const head = `<td class="num idx c-idx">${i + 1}</td><td class="c-car">${car}</td>
    <td class="c-plate"><span class="plate">${esc(r.number)}</span></td>
    <td class="num c-rent" data-label="Monthly rent">${rs(r.monthly_rent)}</td>`;
  if (r.paid) {
    const amount = r.amount ?? 0;
    const short = amount < r.monthly_rent ? `<span class="short-note">${rs(r.monthly_rent - amount)} less</span>` : "";
    return `<tr data-id="${r.id}">${head}
      <td class="num strong c-amt" data-label="Amount received">${rs(amount)}${short}</td>
      <td class="c-date" data-label="Date received">${fmtDate(r.paid_on)}${r.pay_note ? `<div class="small muted">${esc(r.pay_note)}</div>` : ""}</td>
      <td class="c-status"><span class="badge ok">Paid</span></td>
      <td class="actions c-act">
        <button class="btn sm ghost" type="button" data-action="edit-pay" data-id="${r.id}">Edit</button>
        <button class="btn sm ghost danger" type="button" data-action="undo-pay" data-id="${r.id}">Undo</button>
      </td></tr>`;
  }
  return `<tr data-id="${r.id}">${head}
    <td class="num c-amt" data-label="Amount received"><input class="in-amt" data-money inputmode="numeric" value="${nf.format(r.monthly_rent)}" aria-label="Amount received"></td>
    <td class="c-date" data-label="Date received"><input class="in-date" type="date" value="${todayISO()}" aria-label="Date received"></td>
    <td class="c-status"><span class="badge warn">Not paid</span></td>
    <td class="actions c-act"><button class="btn sm primary" type="button" data-action="quick-receive" data-id="${r.id}">Mark paid</button></td>
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
    ? rows.map(rentRow).join("")
    : `<tr><td colspan="8" class="empty">No cars match.</td></tr>`;
}

async function quickReceive(btn: HTMLButtonElement, row: MonthRow) {
  const tr = btn.closest("tr")!;
  const amountInput = $<HTMLInputElement>(".in-amt", tr);
  const amount = parseAmount(amountInput.value);
  if (!(amount > 0)) {
    toast("Please enter the amount received.", "error");
    amountInput.focus();
    return;
  }
  btn.disabled = true;
  try {
    const paid_on = $<HTMLInputElement>(".in-date", tr).value || todayISO();
    await api("payments", { method: "POST", body: { car_id: row.id, month: state.month, amount, paid_on } });
    toast(`Saved: ${row.name} (${row.number}) paid ${rs(amount)}`);
    await render();
  } catch (err) {
    btn.disabled = false;
    if (!(err instanceof LoginNeeded)) toast(errorText(err), "error");
  }
}

async function undoPayment(row: MonthRow) {
  if (!confirm(`Remove the rent entry for ${row.name} (${row.number}) for ${monthLabel(state.month)}?\n\nThe car will show as "Not paid" again.`)) return;
  await api(`payments?car_id=${row.id}&month=${state.month}`, { method: "DELETE" });
  toast("Rent entry removed.");
  await render();
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

function readCarForm(form: HTMLFormElement) {
  const f = formValues(form);
  return { ...f, monthly_rent: parseAmount(f.monthly_rent) };
}

async function renderCars() {
  state.cars = (await api<{ cars: CarWithCount[] }>("cars")).cars;
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
  const list = state.cars.filter(c =>
    (state.showRemoved || c.active) &&
    (!q || `${c.name} ${c.number} ${c.owner}`.toLowerCase().includes(q)));

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
  const r = await api<{ archived: boolean }>("cars/" + c.id, { method: "DELETE" });
  toast(r.archived
    ? `${c.number} has rent history, so it was moved to removed cars. Its history is kept.`
    : `${c.number} deleted.`);
  await renderCars();
}

async function restoreCar(c: Car) {
  await api("cars/" + c.id, { method: "PUT", body: { active: true } });
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
        if (!(ex instanceof LoginNeeded)) err.textContent = errorText(ex);
      } finally {
        btn.disabled = false;
      }
    });
  }
  const first = $opt<HTMLInputElement>("[data-autofocus]", dlg);
  if (first) { first.focus(); first.select(); }
}

function openPaymentDialog(row: MonthRow) {
  const editing = row.paid;
  openDialog(`
    <form class="dlg" autocomplete="off">
      <header>
        <h3>${editing ? "Edit rent entry" : "Mark rent as paid"}</h3>
        <p>${esc(row.name)} · <span class="plate">${esc(row.number)}</span> · ${monthLabel(state.month)}</p>
      </header>
      <div class="dlg-body">
        <label class="field"><span>Amount received (Rs)</span>
          <input name="amount" data-money data-autofocus inputmode="numeric" required
            value="${nf.format(editing ? row.amount ?? 0 : row.monthly_rent)}"></label>
        <label class="field"><span>Date received</span>
          <input name="paid_on" type="date" required value="${editing && row.paid_on ? row.paid_on : todayISO()}"></label>
        <label class="field"><span>Note <em>(optional)</em></span>
          <input name="note" placeholder="e.g. cash, bank transfer" value="${esc(editing ? row.pay_note : "")}"></label>
        <p class="form-error" role="alert"></p>
      </div>
      <footer>
        <button class="btn ghost" type="button" data-action="close-dlg">Cancel</button>
        <button class="btn primary" type="submit">Save</button>
      </footer>
    </form>`, {
    onSave: async form => {
      const f = formValues(form);
      const amount = parseAmount(f.amount);
      await api("payments", { method: "POST", body: { car_id: row.id, month: state.month, amount, paid_on: f.paid_on, note: f.note } });
      toast(`Saved: ${row.name} (${row.number}) paid ${rs(amount)}`);
      void render();
    },
  });
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
      await api("cars/" + c.id, { method: "PUT", body: readCarForm(form) });
      toast("Car details saved.");
      void renderCars();
    },
  });
}

async function openHistory(id: number) {
  const d = await api<CarHistory>(`cars/${id}/history`);
  const c = d.car;
  const rows = d.months.map(m => `
    <tr>
      <td>${monthLabel(m.month)}</td>
      <td>${m.paid ? '<span class="badge ok">Paid</span>' : '<span class="badge warn">Not paid</span>'}</td>
      <td class="num ${m.paid ? "strong" : "muted"}">${m.paid ? rs(m.amount) : "—"}</td>
      <td class="h-date">${m.paid ? fmtDate(m.paid_on) : ""}${m.note ? `<div class="small muted">${esc(m.note)}</div>` : ""}</td>
    </tr>`).join("");
  openDialog(`
    <div class="dlg">
      <header>
        <h3>${esc(c.name)} <span class="plate">${esc(c.number)}</span></h3>
        <p>Rent history · ${rs(c.monthly_rent)} per month${c.owner ? " · " + esc(c.owner) : ""}</p>
      </header>
      <div class="hist-stats">
        <div><span>Total received</span><strong>${rs(d.total)}</strong></div>
        <div><span>Months paid</span><strong>${d.paid_months}</strong></div>
        <div><span>Months not paid</span><strong class="${d.pending_months ? "warn-text" : ""}">${d.pending_months}</strong></div>
      </div>
      <div class="dlg-body flush">
        <table class="table">
          <thead><tr><th>Month</th><th>Status</th><th class="num">Amount</th><th class="h-date">Date received</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="4" class="empty">Rent starts from ${monthLabel(c.start_month)}.</td></tr>`}</tbody>
        </table>
      </div>
      <footer><button class="btn primary" type="button" data-action="close-dlg">Close</button></footer>
    </div>`, { wide: true });
}

function openPasswordDialog() {
  openDialog(`
    <form class="dlg" autocomplete="off">
      <header><h3>Change password</h3><p>You will stay logged in on this device. Other devices will need the new password.</p></header>
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
      if (f.new !== f.confirm) throw new Error("The two new passwords do not match.");
      await api("password", { method: "POST", body: { current: f.current, new: f.new } });
      toast("Password changed.");
    },
  });
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
        <p class="warn-box">This <strong>replaces all cars and rent entries</strong> with the ones in the file.
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
      let backup: unknown;
      try {
        backup = JSON.parse(await file.text());
      } catch {
        throw new Error("This file is not a backup file.");
      }
      const r = await api<{ cars: number; payments: number }>("restore", { method: "POST", body: backup });
      toast(`Backup restored: ${plural(r.cars, "car")} and ${r.payments} rent ${r.payments === 1 ? "entry" : "entries"}.`);
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
    case "edit-pay": if (row) openPaymentDialog(row); break;
    case "quick-receive": if (row) void quickReceive(el as HTMLButtonElement, row); break;
    case "undo-pay": if (row) void run(() => undoPayment(row)); break;
    case "edit-car": if (car) openCarDialog(car); break;
    case "delete-car": if (car) void run(() => deleteCar(car)); break;
    case "restore-car": if (car) void run(() => restoreCar(car)); break;
    case "history": void run(() => openHistory(id)); break;
    case "close-dlg": dlg.close(); break;
    case "change-password": openPasswordDialog(); break;
    case "restore-backup": openRestoreDialog(); break;
    case "logout":
      void run(async () => { await api("logout", { method: "POST" }); showAuth("login"); });
      break;
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
    const { car } = await api<{ car: Car }>("cars", { method: "POST", body: readCarForm(form) });
    toast(`${car.name} (${car.number}) added.`);
    form.reset();
    $<HTMLInputElement>("input[name=name]", form).focus();
    await renderCars();
  } catch (ex) {
    if (!(ex instanceof LoginNeeded)) err.textContent = errorText(ex);
  } finally {
    btn.disabled = false;
  }
});

window.addEventListener("hashchange", () => {
  if (dlg.open) dlg.close();
  if (!$("#app").hidden) void render();
});

/* ================= start ================= */

async function start() {
  $(".form-grid", $("#car-form")).innerHTML = carFields();
  buildMonthSwitches();
  $("#today").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  try {
    const s = await api<SessionInfo>("session");
    if (s.setup_needed) showAuth("setup");
    else if (!s.logged_in) showAuth("login");
    else showApp();
  } catch (err) {
    document.body.innerHTML = `<div class="auth"><div class="auth-card"><h1>Can't open the app</h1><p class="auth-text">${esc(errorText(err))}</p></div></div>`;
  }
}

void start();
