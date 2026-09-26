"""Mashaal Rent a Car - monthly rent register.

A small WSGI web app with no outside dependencies (Python standard library only).
All data is stored in one SQLite file: data/rent.db

Online (PythonAnywhere): the WSGI config imports `application` from this file.
On your own computer:    python app.py   then open http://127.0.0.1:8765

The app is protected by one password. The first person to open it sets the
password, so open it yourself right after you put it online.
"""

import csv
import hashlib
import hmac
import io
import json
import re
import secrets
import sqlite3
import sys
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs

BASE = Path(__file__).resolve().parent
DATA_DIR = BASE / "data"
DB_PATH = DATA_DIR / "rent.db"
BACKUP_DIR = BASE / "backups"
STATIC_DIR = BASE / "static"

LOCAL_HOST, LOCAL_PORT = "127.0.0.1", 8765
PAKISTAN_TIME = timezone(timedelta(hours=5))   # Pakistan has no daylight saving
KEEP_BACKUPS = 30
MAX_AMOUNT = 100_000_000
SESSION_COOKIE = "mrc_session"
SESSION_DAYS = 30
MIN_PASSWORD = 6

MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS cars (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    number        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    owner         TEXT    NOT NULL DEFAULT '',
    monthly_rent  INTEGER NOT NULL DEFAULT 0,
    start_month   TEXT    NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    notes         TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payments (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    car_id   INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
    month    TEXT    NOT NULL,
    amount   INTEGER NOT NULL,
    paid_on  TEXT    NOT NULL,
    note     TEXT    NOT NULL DEFAULT '',
    UNIQUE (car_id, month)
);
CREATE INDEX IF NOT EXISTS idx_payments_month ON payments(month);
CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
"""

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class Download:
    def __init__(self, data, content_type, filename):
        self.data, self.content_type, self.filename = data, content_type, filename


class Response:
    def __init__(self, body=b"", status=200, content_type="application/json; charset=utf-8",
                 cookies=(), extra_headers=()):
        self.body, self.status = body, status
        self.headers = [("Content-Type", content_type), ("Cache-Control", "no-store"),
                        ("Content-Length", str(len(body))), *extra_headers]
        self.headers += [("Set-Cookie", c) for c in cookies]


def json_response(payload, status=200, cookies=()):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return Response(body, status, cookies=cookies)


# ---------------------------------------------------------------- helpers

def today():
    return datetime.now(PAKISTAN_TIME).date()


def this_month():
    return today().strftime("%Y-%m")


def shift_month(month, delta):
    year, mon = map(int, month.split("-"))
    index = year * 12 + (mon - 1) + delta
    return f"{index // 12:04d}-{index % 12 + 1:02d}"


def connect():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def to_id(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ApiError("Invalid id") from None


def to_amount(value, label):
    text = re.sub(r"[,\s]", "", str(value if value is not None else ""))
    if not text:
        raise ApiError(f"{label} is required")
    try:
        amount = float(text)
    except ValueError:
        raise ApiError(f"{label} must be a number") from None
    if amount < 0 or amount > MAX_AMOUNT or amount != int(amount):
        raise ApiError(f"{label} must be a whole number of rupees")
    return int(amount)


def month_arg(q):
    month = q.get("m") or this_month()
    if not MONTH_RE.match(month):
        raise ApiError("Invalid month")
    return month


def get_car(con, car_id):
    row = con.execute("SELECT * FROM cars WHERE id = ?", (car_id,)).fetchone()
    if not row:
        raise ApiError("Car not found", 404)
    return dict(row)


# ---------------------------------------------------------------- login

def get_setting(con, key):
    row = con.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_setting(con, key, value):
    con.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT (key) DO UPDATE SET value = excluded.value", (key, value))


def secret_key(con):
    key = get_setting(con, "secret_key")
    if not key:
        key = secrets.token_hex(32)
        set_setting(con, "secret_key", key)
    return key


def hash_password(password):
    salt = secrets.token_hex(16)
    rounds = 240_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), rounds).hex()
    return f"pbkdf2${rounds}${salt}${digest}"


def verify_password(password, stored):
    try:
        _, rounds, salt, digest = stored.split("$")
        check = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(rounds)).hex()
    except (ValueError, AttributeError):
        return False
    return hmac.compare_digest(check, digest)


def check_new_password(value):
    password = str(value or "")
    if len(password) < MIN_PASSWORD:
        raise ApiError(f"Password must be at least {MIN_PASSWORD} characters")
    return password


def sign(con, expires):
    # Includes the password hash, so changing the password logs out every device.
    message = f"{expires}:{get_setting(con, 'password') or ''}".encode()
    return hmac.new(secret_key(con).encode(), message, hashlib.sha256).hexdigest()


def is_https(environ):
    return (environ.get("wsgi.url_scheme") == "https"
            or environ.get("HTTP_X_FORWARDED_PROTO", "").lower() == "https")


def session_cookie(con, environ):
    max_age = SESSION_DAYS * 86400
    expires = int(time.time()) + max_age
    cookie = (f"{SESSION_COOKIE}={expires}.{sign(con, expires)}; Path=/; "
              f"Max-Age={max_age}; HttpOnly; SameSite=Lax")
    return cookie + ("; Secure" if is_https(environ) else "")


def logout_cookie(environ):
    cookie = f"{SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
    return cookie + ("; Secure" if is_https(environ) else "")


def read_cookie(environ, name):
    for part in environ.get("HTTP_COOKIE", "").split(";"):
        key, _, value = part.strip().partition("=")
        if key == name:
            return value
    return None


def logged_in(con, environ):
    token = read_cookie(environ, SESSION_COOKIE)
    if not token or not get_setting(con, "password"):
        return False
    expires, _, signature = token.partition(".")
    if not expires.isdigit() or int(expires) < time.time():
        return False
    return hmac.compare_digest(signature, sign(con, int(expires)))


# ---------------------------------------------------------------- cars

def clean_car(body):
    name = re.sub(r"\s+", " ", str(body.get("name", ""))).strip()
    number = re.sub(r"\s+", " ", str(body.get("number", ""))).strip().upper()
    owner = str(body.get("owner", "")).strip()
    notes = str(body.get("notes", "")).strip()
    start = str(body.get("start_month") or this_month())
    if not name:
        raise ApiError("Please enter the car name")
    if not number:
        raise ApiError("Please enter the car number")
    if not MONTH_RE.match(start):
        raise ApiError("Please choose a valid start month")
    rent = to_amount(body.get("monthly_rent"), "Monthly rent")
    return {"name": name, "number": number, "owner": owner, "notes": notes,
            "monthly_rent": rent, "start_month": start}


def list_cars(con):
    rows = con.execute("""
        SELECT c.*, (SELECT COUNT(*) FROM payments p WHERE p.car_id = c.id) AS payment_count
        FROM cars c ORDER BY c.active DESC, c.name COLLATE NOCASE, c.number
    """).fetchall()
    return {"cars": [dict(r) for r in rows]}


def create_car(con, body):
    car = clean_car(body)
    try:
        cur = con.execute("""
            INSERT INTO cars (name, number, owner, monthly_rent, start_month, notes)
            VALUES (:name, :number, :owner, :monthly_rent, :start_month, :notes)
        """, car)
    except sqlite3.IntegrityError:
        raise ApiError(f"A car with number {car['number']} is already added") from None
    return {"car": get_car(con, cur.lastrowid)}


def update_car(con, car_id, body):
    get_car(con, car_id)
    if set(body) == {"active"}:
        con.execute("UPDATE cars SET active = ? WHERE id = ?", (1 if body["active"] else 0, car_id))
        return {"car": get_car(con, car_id)}
    car = clean_car(body)
    try:
        con.execute("""
            UPDATE cars SET name = :name, number = :number, owner = :owner,
                   monthly_rent = :monthly_rent, start_month = :start_month, notes = :notes
            WHERE id = :id
        """, {**car, "id": car_id})
    except sqlite3.IntegrityError:
        raise ApiError(f"A car with number {car['number']} is already added") from None
    return {"car": get_car(con, car_id)}


def delete_car(con, car_id):
    get_car(con, car_id)
    count = con.execute("SELECT COUNT(*) FROM payments WHERE car_id = ?", (car_id,)).fetchone()[0]
    if count:
        # Keep rent history safe: hide the car instead of deleting it.
        con.execute("UPDATE cars SET active = 0 WHERE id = ?", (car_id,))
        return {"archived": True}
    con.execute("DELETE FROM cars WHERE id = ?", (car_id,))
    return {"archived": False}


def car_history(con, car_id):
    car = get_car(con, car_id)
    pays = {r["month"]: dict(r) for r in con.execute(
        "SELECT month, amount, paid_on, note FROM payments WHERE car_id = ?", (car_id,))}
    start = min([car["start_month"], *pays])
    end = max([this_month(), *pays]) if car["active"] else max(pays, default=start)
    months, month = [], end
    while month >= start and len(months) < 240:
        pay = pays.get(month)
        months.append({
            "month": month,
            "paid": pay is not None,
            "amount": pay["amount"] if pay else None,
            "paid_on": pay["paid_on"] if pay else None,
            "note": pay["note"] if pay else "",
        })
        month = shift_month(month, -1)
    return {
        "car": car,
        "months": months,
        "total": sum(p["amount"] for p in pays.values()),
        "paid_months": len(pays),
        "pending_months": sum(1 for m in months if not m["paid"]),
    }


# ---------------------------------------------------------------- rent

def month_rows(con, month):
    """Every car that owes rent for `month`, plus any car that has a payment in it."""
    rows = con.execute("""
        SELECT c.id, c.name, c.number, c.owner, c.monthly_rent, c.active, c.start_month,
               p.amount, p.paid_on, p.note AS pay_note
        FROM cars c
        LEFT JOIN payments p ON p.car_id = c.id AND p.month = :m
        WHERE (c.active = 1 AND c.start_month <= :m) OR p.id IS NOT NULL
        ORDER BY c.name COLLATE NOCASE, c.number
    """, {"m": month}).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["paid"] = r["amount"] is not None
        result.append(d)
    return result


def summarize(rows):
    paid = [r for r in rows if r["paid"]]
    unpaid = [r for r in rows if not r["paid"]]
    collected = sum(r["amount"] for r in paid)
    pending = sum(r["monthly_rent"] for r in unpaid)
    return {
        "total_cars": len(rows),
        "paid_cars": len(paid),
        "unpaid_cars": len(unpaid),
        "collected": collected,
        "pending": pending,
        "expected": collected + pending,
    }


def month_sheet(con, month):
    rows = month_rows(con, month)
    return {"month": month, "rows": rows, "summary": summarize(rows)}


def dashboard(con, month):
    rows = month_rows(con, month)
    trend = []
    for back in range(11, -1, -1):
        m = shift_month(month, -back)
        trend.append({"month": m, **summarize(month_rows(con, m))})
    active = con.execute("SELECT COUNT(*) FROM cars WHERE active = 1").fetchone()[0]
    return {"month": month, "rows": rows, "summary": summarize(rows),
            "trend": trend, "active_cars": active}


def save_payment(con, body):
    car_id = to_id(body.get("car_id"))
    car = get_car(con, car_id)
    month = str(body.get("month", ""))
    if not MONTH_RE.match(month):
        raise ApiError("Invalid month")
    amount = to_amount(body.get("amount"), "Amount")
    if amount <= 0:
        raise ApiError("Amount must be more than zero")
    paid_on = str(body.get("paid_on") or today().isoformat())
    if not DATE_RE.match(paid_on):
        raise ApiError("Invalid date")
    note = str(body.get("note", "")).strip()
    con.execute("""
        INSERT INTO payments (car_id, month, amount, paid_on, note) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (car_id, month) DO UPDATE SET
            amount = excluded.amount, paid_on = excluded.paid_on, note = excluded.note
    """, (car_id, month, amount, paid_on, note))
    return {"ok": True, "car": car["number"], "month": month, "amount": amount}


def delete_payment(con, q):
    car_id = to_id(q.get("car_id"))
    month = month_arg(q)
    con.execute("DELETE FROM payments WHERE car_id = ? AND month = ?", (car_id, month))
    return {"ok": True}


def export_csv(con, month):
    rows = month_rows(con, month)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["#", "Car", "Number", "Owner / Driver", "Monthly Rent",
                "Status", "Amount Received", "Received On", "Note"])
    for i, r in enumerate(rows, 1):
        w.writerow([i, r["name"], r["number"], r["owner"], r["monthly_rent"],
                    "Received" if r["paid"] else "Pending",
                    r["amount"] if r["paid"] else "", r["paid_on"] or "", r["pay_note"] or ""])
    s = summarize(rows)
    w.writerow([])
    w.writerow(["", "Total received", "", "", "", "", s["collected"]])
    w.writerow(["", "Cars paid", "", "", "", "", s["paid_cars"]])
    w.writerow(["", "Cars pending", "", "", "", "", s["unpaid_cars"]])
    w.writerow(["", "Pending amount", "", "", "", "", s["pending"]])
    data = ("﻿" + buf.getvalue()).encode("utf-8")   # BOM so Excel reads it as UTF-8
    return Download(data, "text/csv; charset=utf-8", f"rent-{month}.csv")


def backup_file(con):
    return Download(con.serialize(), "application/vnd.sqlite3",
                    f"mashaal-rent-backup-{today().isoformat()}.db")


def dispatch(con, method, parts, q, body):
    match (method, parts):
        case ("GET", ["cars"]):
            return list_cars(con)
        case ("POST", ["cars"]):
            return create_car(con, body)
        case ("PUT", ["cars", car_id]):
            return update_car(con, to_id(car_id), body)
        case ("DELETE", ["cars", car_id]):
            return delete_car(con, to_id(car_id))
        case ("GET", ["cars", car_id, "history"]):
            return car_history(con, to_id(car_id))
        case ("GET", ["month"]):
            return month_sheet(con, month_arg(q))
        case ("GET", ["dashboard"]):
            return dashboard(con, month_arg(q))
        case ("POST", ["payments"]):
            return save_payment(con, body)
        case ("DELETE", ["payments"]):
            return delete_payment(con, q)
        case ("GET", ["export"]):
            return export_csv(con, month_arg(q))
        case ("GET", ["backup"]):
            return backup_file(con)
    raise ApiError("Not found", 404)


# ---------------------------------------------------------------- web app

def handle_api(con, environ, method, parts, q, body):
    match (method, parts):
        case ("GET", ["session"]):
            return json_response({"setup_needed": get_setting(con, "password") is None,
                                  "logged_in": logged_in(con, environ)})
        case ("POST", ["setup"]):
            if get_setting(con, "password"):
                raise ApiError("A password is already set. Please log in.", 403)
            set_setting(con, "password", hash_password(check_new_password(body.get("password"))))
            return json_response({"ok": True}, cookies=[session_cookie(con, environ)])
        case ("POST", ["login"]):
            stored = get_setting(con, "password")
            if not stored or not verify_password(str(body.get("password", "")), stored):
                time.sleep(1)   # slows down password guessing
                raise ApiError("Wrong password", 401)
            return json_response({"ok": True}, cookies=[session_cookie(con, environ)])
        case ("POST", ["logout"]):
            return json_response({"ok": True}, cookies=[logout_cookie(environ)])

    if not logged_in(con, environ):
        raise ApiError("Please log in", 401)

    if (method, parts) == ("POST", ["password"]):
        if not verify_password(str(body.get("current", "")), get_setting(con, "password")):
            time.sleep(1)
            raise ApiError("Current password is wrong")
        set_setting(con, "password", hash_password(check_new_password(body.get("new"))))
        return json_response({"ok": True}, cookies=[session_cookie(con, environ)])

    result = dispatch(con, method, parts, q, body)
    if isinstance(result, Download):
        return Response(result.data, content_type=result.content_type, extra_headers=[
            ("Content-Disposition", f'attachment; filename="{result.filename}"')])
    return json_response(result)


def read_json(environ):
    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except ValueError:
        length = 0
    if not length:
        return {}
    try:
        data = json.loads(environ["wsgi.input"].read(length).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ApiError("Invalid request") from None
    if not isinstance(data, dict):
        raise ApiError("Invalid request")
    return data


def static_response(path):
    rel = "index.html" if path in ("", "/") else path.lstrip("/")
    file = (STATIC_DIR / rel).resolve()
    if not file.is_relative_to(STATIC_DIR) or not file.is_file():
        raise ApiError("Not found", 404)
    return Response(file.read_bytes(),
                    content_type=CONTENT_TYPES.get(file.suffix, "application/octet-stream"))


def route(environ):
    method = environ.get("REQUEST_METHOD", "GET").upper()
    path = environ.get("PATH_INFO") or "/"
    q = {k: v[0] for k, v in parse_qs(environ.get("QUERY_STRING", "")).items()}
    if not path.startswith("/api/"):
        if method not in ("GET", "HEAD"):
            raise ApiError("Not found", 404)
        return static_response(path)
    parts = [p for p in path[5:].split("/") if p]
    body = read_json(environ) if method in ("POST", "PUT") else {}
    con = connect()
    try:
        with con:
            return handle_api(con, environ, method, parts, q, body)
    finally:
        con.close()


_ready_lock = threading.Lock()
_ready = False
_last_backup_day = None


def prepare():
    """Create the database on first use and keep one backup copy per day."""
    global _ready, _last_backup_day
    day = today().isoformat()
    if _ready and _last_backup_day == day:
        return
    with _ready_lock:
        if not _ready:
            DATA_DIR.mkdir(exist_ok=True)
            con = connect()
            try:
                con.executescript(SCHEMA)
            finally:
                con.close()
            _ready = True
        if _last_backup_day != day:
            try:
                BACKUP_DIR.mkdir(exist_ok=True)
                target = BACKUP_DIR / f"rent-{day}.db"
                if not target.exists():
                    src, dst = sqlite3.connect(DB_PATH), sqlite3.connect(target)
                    try:
                        src.backup(dst)
                    finally:
                        src.close()
                        dst.close()
                for old in sorted(BACKUP_DIR.glob("rent-*.db"))[:-KEEP_BACKUPS]:
                    old.unlink()
            except Exception:
                traceback.print_exc()
            _last_backup_day = day


def application(environ, start_response):
    try:
        prepare()
        response = route(environ)
    except ApiError as e:
        response = json_response({"error": str(e)}, e.status)
    except Exception:
        traceback.print_exc()
        response = json_response({"error": "Something went wrong on the server"}, 500)
    status = HTTPStatus(response.status)
    start_response(f"{status.value} {status.phrase}", response.headers)
    return [response.body]


# ---------------------------------------------------------------- run on this computer

def run_local():
    import webbrowser
    from socketserver import ThreadingMixIn
    from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

    class QuietHandler(WSGIRequestHandler):
        def log_message(self, *args):
            pass

    class LocalServer(ThreadingMixIn, WSGIServer):
        allow_reuse_address = False   # on Windows this would let two copies share the port
        daemon_threads = True

    url = f"http://{LOCAL_HOST}:{LOCAL_PORT}/"
    open_browser = "--no-browser" not in sys.argv
    try:
        server = make_server(LOCAL_HOST, LOCAL_PORT, application,
                             server_class=LocalServer, handler_class=QuietHandler)
    except OSError:
        print("The app is already running. Opening the browser.")
        if open_browser:
            webbrowser.open(url)
        return

    print()
    print("  Mashaal Rent a Car")
    print(f"  Running at: {url}")
    print(f"  Data file:  {DB_PATH}")
    print()
    print("  Keep this window open while you use the app. Close it to stop.")
    print()
    if open_browser:
        threading.Timer(0.6, webbrowser.open, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run_local()
