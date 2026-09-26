"use strict";

/* ================= helpers ================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const pad = n => String(n).padStart(2, "0");
const nf = new Intl.NumberFormat("en-PK", { maximumFractionDigits: 0 });
const rs = n => "Rs " + nf.format(n || 0);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const parseAmount = v => Number(String(v ?? "").replace(/[,\s]/g, ""));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const thisMonth = () => todayISO().slice(0, 7);

function shiftMonth(m, delta) {
  const [y, mo] = m.split("-").map(Number);
  const i = y * 12 + (mo - 1) + delta;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}
function monthDate(m) { const [y, mo] = m.split("-").map(Number); return new Date(y, mo - 1, 1); }
const monthLabel = (m, month = "long") => monthDate(m).toLocaleDateString("en-GB", { month, year: "numeric" });
const monthShort = m => monthDate(m).toLocaleDateString("en-GB", { month: "short" });

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// Short money labels for the chart: 45k, 4.5 L (lakh), 1.2 Cr (crore)
function compact(n) {
  const cut = x => x.toFixed(1).replace(/\.0$/, "");
  if (n >= 1e7) return cut(n / 1e7) + " Cr";
  if (n >= 1e5) return cut(n / 1e5) + " L";
  if (n >= 1e3) return cut(n / 1e3) + "k";
  return String(n);
}

/* ================= state & server calls ================= */

const state = {
  month: thisMonth(),
  rows: new Map(),       // car id -> row for the month on screen
  sheet: null,           // Monthly Rent data
  cars: [],
  rentFilter: "all",
  rentQuery: "",
  carQuery: "",
  showRemoved: false,
};

class LoginNeeded extends Error {}

async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch("/api/" + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can't reach the server. Check your internet connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !["login", "session"].includes(path)) {
    showAuth("login");
    throw new LoginNeeded();
  }
  if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

let toastTimer;
function toast(msg, kind = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast " + kind), 3400);
}

// Runs an action and shows any error as a message.
async function run(fn) {
  try { await fn(); }
  catch (err) { if (!(err instanceof LoginNeeded)) toast(err.message, "error"); }
}

function remember(rows) {
  state.rows = new Map(rows.map(r => [r.id, r]));
}

/* ================= login ================= */

let authMode = "login";

function showAuth(mode) {
  authMode = mode;
  const setup = mode === "setup";
  $("#app").hidden = true;
  $("#auth").hidden = false;
  if ($("#dlg").open) $("#dlg").close();
  $("#auth-title").textContent = setup ? "Create your password" : "Log in";
  $("#auth-text").textContent = setup
    ? "This is the first time the app is opened. Choose a password (at least 6 characters). You will need it every time you log in."
    : "Enter your password to open the rent register.";
  $("#auth-confirm").hidden = !setup;
  $("#auth-confirm input").required = setup;
  $("#auth-btn").textContent = setup ? "Save password and continue" : "Log in";
  $("#auth-form .form-error").textContent = "";
  $("#auth-form").reset();
  $("#auth-form input[name=password]").focus();
}

function showApp() {
  $("#auth").hidden = true;
  $("#app").hidden = false;
  render();
}

$("#auth-form").addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.target;
  const f = Object.fromEntries(new FormData(form));
  const err = $(".form-error", form);
  const btn = $("#auth-btn");
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
    err.textContent = ex.message;
    $("input[name=password]", form).select();
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
    $(".month-picker", ms).addEventListener("change", e => e.target.value && setMonth(e.target.value));
  });
}

function syncMonthSwitches() {
  $$(".month-switch").forEach(ms => {
    $(".month-text", ms).textContent = monthLabel(state.month);
    $(".month-picker", ms).value = state.month;
    $(".this-month", ms).hidden = state.month === thisMonth();
  });
}

function setMonth(m) {
  if (!/^\d{4}-\d{2}$/.test(m) || m === state.month) return;
  state.month = m;
  render();
}

/* ================= pages ================= */

const VIEWS = ["dashboard", "rent", "cars"];
const currentView = () => (VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "dashboard");

function render() {
  const view = currentView();
  $$(".view").forEach(s => (s.hidden = s.id !== "view-" + view));
  $$(".nav a").forEach(a => a.classList.toggle("active", a.dataset.view === view));
  syncMonthSwitches();
  return run(() => ({ dashboard: renderDashboard, rent: renderRent, cars: renderCars })[view]());
}

/* ---------- dashboard ---------- */

function stat(label, value, sub, tone = "") {
  return `<div class="card stat ${tone}"><div class="label">${label}</div>
    <div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

async function renderDashboard() {
  const d = await api("dashboard?m=" + state.month);
  remember(d.rows);
  const s = d.summary;
  const noCars = d.active_cars === 0 && d.rows.length === 0;
  $("#dash-welcome").hidden = !noCars;
  $("#dash-content").hidden = noCars;
  if (noCars) return;

  const pct = s.total_cars ? Math.round((s.paid_cars / s.total_cars) * 100) : 0;
  const yearTotal = d.trend.reduce((a, t) => a + t.collected, 0);
  $("#dash-stats").innerHTML = [
    stat("Rent received", rs(s.collected),
      s.expected ? `out of ${rs(s.expected)}` : "No rent due this month", "hero"),
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
  $("#unpaid-count").textContent = unpaid.length;
  $("#paid-count").textContent = paid.length;

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
  const h = v => (v ? Math.max(2, (v / max) * 100) : 0);
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
  const d = await api("month?m=" + state.month);
  remember(d.rows);
  state.sheet = d;
  $("#rent-export").href = "/api/export?m=" + state.month;
  const s = d.summary;
  $("#rent-summary").innerHTML = `
    <div><span>Rent received</span><strong>${rs(s.collected)}</strong></div>
    <div><span>Cars paid</span><strong>${s.paid_cars} <small class="muted">/ ${s.total_cars}</small></strong></div>
    <div><span>Cars not paid</span><strong class="${s.unpaid_cars ? "warn-text" : ""}">${s.unpaid_cars}</strong></div>
    <div><span>Amount still to come</span><strong>${rs(s.pending)}</strong></div>`;
  drawRentTable();
}

function rentRow(r, i) {
  const car = `<div class="car-cell"><strong>${esc(r.name)}</strong>${r.owner ? `<span>${esc(r.owner)}</span>` : ""}</div>`;
  // data-label is shown as a small heading when the row turns into a card on phones
  const head = `<td class="num idx c-idx">${i + 1}</td><td class="c-car">${car}</td>
    <td class="c-plate"><span class="plate">${esc(r.number)}</span></td>
    <td class="num c-rent" data-label="Monthly rent">${rs(r.monthly_rent)}</td>`;
  if (r.paid) {
    const short = r.amount < r.monthly_rent ? `<span class="short-note">${rs(r.monthly_rent - r.amount)} less</span>` : "";
    return `<tr data-id="${r.id}">${head}
      <td class="num strong c-amt" data-label="Amount received">${rs(r.amount)}${short}</td>
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
  const all = state.sheet.rows;
  const paidN = all.filter(r => r.paid).length;
  $("#rent-filter").innerHTML = [["all", "All", all.length], ["pending", "Not paid", all.length - paidN], ["paid", "Paid", paidN]]
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

async function quickReceive(btn, row) {
  const tr = btn.closest("tr");
  const amountInput = $(".in-amt", tr);
  const amount = parseAmount(amountInput.value);
  if (!(amount > 0)) {
    toast("Please enter the amount received.", "error");
    amountInput.focus();
    return;
  }
  btn.disabled = true;
  try {
    await api("payments", { method: "POST", body: { car_id: row.id, month: state.month, amount, paid_on: $(".in-date", tr).value || todayISO() } });
    toast(`Saved: ${row.name} (${row.number}) paid ${rs(amount)}`);
    await render();
  } catch (err) {
    btn.disabled = false;
    if (!(err instanceof LoginNeeded)) toast(err.message, "error");
  }
}

async function undoPayment(row) {
  if (!confirm(`Remove the rent entry for ${row.name} (${row.number}) for ${monthLabel(state.month)}?\n\nThe car will show as "Not paid" again.`)) return;
  await api(`payments?car_id=${row.id}&month=${state.month}`, { method: "DELETE" });
  toast("Rent entry removed.");
  await render();
}

/* ---------- cars ---------- */

function carFields(c = {}) {
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

function readCarForm(form) {
  const f = Object.fromEntries(new FormData(form));
  f.monthly_rent = parseAmount(f.monthly_rent);
  return f;
}

async function renderCars() {
  state.cars = (await api("cars")).cars;
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
  $("input", toggle).checked = state.showRemoved;

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

async function deleteCar(c) {
  if (!confirm(`Delete ${c.name} (${c.number})?`)) return;
  const r = await api("cars/" + c.id, { method: "DELETE" });
  toast(r.archived
    ? `${c.number} has rent history, so it was moved to removed cars. Its history is kept.`
    : `${c.number} deleted.`);
  await renderCars();
}

async function restoreCar(c) {
  await api("cars/" + c.id, { method: "PUT", body: { active: true } });
  toast(`${c.number} is back in your car list.`);
  await renderCars();
}

/* ================= dialogs ================= */

// Opens the popup. onSave(formValues) runs when the form is submitted.
function openDialog(html, { wide = false, onSave } = {}) {
  const dlg = $("#dlg");
  dlg.className = wide ? "wide" : "";
  dlg.innerHTML = html;
  dlg.showModal();
  const form = $("form", dlg);
  if (form && onSave) {
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const btn = $("button[type=submit]", form);
      const err = $(".form-error", form);
      btn.disabled = true;
      err.textContent = "";
      try {
        await onSave(form);
        dlg.close();
      } catch (ex) {
        if (!(ex instanceof LoginNeeded)) err.textContent = ex.message;
      } finally {
        btn.disabled = false;
      }
    });
  }
  const first = $("[data-autofocus]", dlg);
  if (first) { first.focus(); first.select?.(); }
}

function openPaymentDialog(row) {
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
            value="${nf.format(editing ? row.amount : row.monthly_rent)}"></label>
        <label class="field"><span>Date received</span>
          <input name="paid_on" type="date" required value="${editing ? row.paid_on : todayISO()}"></label>
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
      const f = Object.fromEntries(new FormData(form));
      const amount = parseAmount(f.amount);
      await api("payments", { method: "POST", body: { car_id: row.id, month: state.month, amount, paid_on: f.paid_on, note: f.note } });
      toast(`Saved: ${row.name} (${row.number}) paid ${rs(amount)}`);
      render();
    },
  });
}

function openCarDialog(c) {
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
      renderCars();
    },
  });
}

async function openHistory(id) {
  const d = await api(`cars/${id}/history`);
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
      const f = Object.fromEntries(new FormData(form));
      if (f.new !== f.confirm) throw new Error("The two new passwords do not match.");
      await api("password", { method: "POST", body: { current: f.current, new: f.new } });
      toast("Password changed.");
    },
  });
}

/* ================= events ================= */

document.addEventListener("click", e => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const id = Number(el.dataset.id);
  const row = state.rows.get(id);
  const car = state.cars.find(c => c.id === id);

  switch (el.dataset.action) {
    case "step-month": setMonth(shiftMonth(state.month, Number(el.dataset.step))); break;
    case "this-month": setMonth(thisMonth()); break;
    case "goto-month": setMonth(el.dataset.month); break;
    case "pick-month": {
      const input = $(".month-picker", el.closest(".month-switch"));
      try { input.showPicker(); } catch { input.focus(); }
      break;
    }
    case "filter": state.rentFilter = el.dataset.filter; drawRentTable(); break;
    case "receive":
    case "edit-pay": if (row) openPaymentDialog(row); break;
    case "quick-receive": if (row) quickReceive(el, row); break;
    case "undo-pay": if (row) run(() => undoPayment(row)); break;
    case "edit-car": if (car) openCarDialog(car); break;
    case "delete-car": if (car) run(() => deleteCar(car)); break;
    case "restore-car": if (car) run(() => restoreCar(car)); break;
    case "history": run(() => openHistory(id)); break;
    case "close-dlg": $("#dlg").close(); break;
    case "change-password": openPasswordDialog(); break;
    case "logout":
      run(async () => { await api("logout", { method: "POST" }); showAuth("login"); });
      break;
  }
});

// Close the popup when clicking the dark area around it.
$("#dlg").addEventListener("click", e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// Press Enter in an amount box on Monthly Rent to mark that car as paid.
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.matches(".in-amt, .in-date")) {
    e.preventDefault();
    $("[data-action=quick-receive]", e.target.closest("tr"))?.click();
  }
});

// Show money with commas after typing, e.g. 45000 -> 45,000
document.addEventListener("focusout", e => {
  if (!e.target.matches("[data-money]")) return;
  const n = parseAmount(e.target.value);
  if (e.target.value.trim() && Number.isFinite(n) && n >= 0) e.target.value = nf.format(n);
});

$("#rent-search").addEventListener("input", e => { state.rentQuery = e.target.value; drawRentTable(); });
$("#car-search").addEventListener("input", e => { state.carQuery = e.target.value; drawCarsTable(); });
$("#removed-toggle input").addEventListener("change", e => { state.showRemoved = e.target.checked; drawCarsTable(); });

$("#car-form").addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.target;
  const err = $(".form-error", form);
  const btn = $("button[type=submit]", form);
  err.textContent = "";
  btn.disabled = true;
  try {
    const f = readCarForm(form);
    const { car } = await api("cars", { method: "POST", body: f });
    toast(`${car.name} (${car.number}) added.`);
    form.reset();
    $("input[name=name]", form).focus();
    await renderCars();
  } catch (ex) {
    if (!(ex instanceof LoginNeeded)) err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

window.addEventListener("hashchange", () => {
  if ($("#dlg").open) $("#dlg").close();
  if (!$("#app").hidden) render();
});

/* ================= start ================= */

async function start() {
  $(".form-grid", $("#car-form")).innerHTML = carFields();
  buildMonthSwitches();
  $("#today").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  try {
    const s = await api("session");
    if (s.setup_needed) showAuth("setup");
    else if (!s.logged_in) showAuth("login");
    else showApp();
  } catch (err) {
    document.body.innerHTML = `<div class="auth"><div class="auth-card"><h1>Can't open the app</h1><p class="auth-text">${esc(err.message)}</p></div></div>`;
  }
}

start();
