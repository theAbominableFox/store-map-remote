"""
Mapa sklepów - server (local or on a LAN server, e.g. in Docker on Ubuntu).

Usage:
    python server.py [data_file] [--port 8000] [--host 127.0.0.1] [--no-browser]

Environment variables (override defaults, command-line arguments win):
    MAPA_DATA      data file path
    MAPA_HOST      address to listen on (0.0.0.0 = all interfaces; default 127.0.0.1)
    MAPA_PORT      port (default 8000)
    MAPA_HASLO     editor password. Viewing never needs a login; editing does when this is set.
                   Required when listening on anything other than localhost.
    MAPA_TYLKO_LAN 1 (default) = refuse requests from non-private IP addresses
    MAPA_KOPIE     how many backups to keep in the "kopie" folder next to the data file (default 30)
    MAPA_MARKA     folder with the company branding (default: "marka" next to the data file), all optional:
                   logo.png|svg|jpg|webp (sidebar, shown 40x40), favicon.png|svg|ico, nazwa.txt (company name,
                   shown in the browser tab). Missing files fall back to the neutral ones in static/domyslne/.

data_file can be .xlsx or .csv (default: mapa_dane.xlsx)
  * .xlsx -> first sheet = stores, sheet "Incydenty" = incidents, sheet "Regiony" = region colours
  * .csv  -> <file>.csv = stores, <file>_incydenty.csv, <file>_regiony.csv

Store columns are whatever the file has (original store list layout: POS Nazwa, Adres, ...).
The app adds these columns if missing: Status, Lat, Lng, ID
Incidents always belong to an existing store (column POS = store name).
"""
import csv
import hashlib
import hmac
import ipaddress
import json
import os
import re
import shutil
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
import webbrowser
from datetime import datetime, date
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

try:
    import openpyxl
except ImportError:
    openpyxl = None

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")

APP_STORE_COLS = ["Status", "Lat", "Lng", "ID"]
INCIDENT_COLS = ["ID", "POS", "Priorytet", "Komentarz", "Status", "Data zgłoszenia", "Data zamknięcia", "Data przewidywana"]
REGION_COLS = ["Region", "Kolor", "Typ"]
# Typ regionu: "sklepy" (zwykłe sklepy) albo "inne" (lokalizacje, które nie są sklepami – nie liczą się do statystyk)
REGION_TYPES = ["sklepy", "inne"]
INCIDENT_SHEET = "Incydenty"
REGION_SHEET = "Regiony"

PRIORITIES = ["niski", "średni", "wysoki"]
INC_STATUSES = ["nowa", "w trakcie", "naprawiona"]
DONE = "naprawiona"
# values from older versions of the file
LEGACY_STATUS = {"otwarty": "nowa", "zamknięty": "naprawiona", "w": "w trakcie", "ok": "naprawiona"}
LEGACY_PRIO = {"krytyczny": "wysoki"}
# used only when a file has no "Regiony" sheet yet
DEFAULT_REGIONS = [("Północ", "#2563eb", "sklepy"), ("Wschód", "#16a34a", "sklepy"), ("Południe", "#f59e0b", "sklepy"),
                   ("Zachód", "#9333ea", "sklepy"), ("Inne lokalizacje", "#0d9488", "inne")]

LOCK = threading.Lock()

# set in main()
PASSWORD = ""          # editor password; "" = no login (local mode, editing open)
LAN_ONLY = True
KEEP_BACKUPS = 30
SESSION_COOKIE = "mapa_sesja"
SESSION_DAYS = 30
LOGIN_LOCK = threading.Lock()   # serialises failed logins -> max ~1 guess per second
BRAND_DIR = ""        # set in main()
BRAND_TYPES = {".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webp": "image/webp",
               ".ico": "image/x-icon"}
MAX_UPLOAD = 20 * 1024 * 1024
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class FileLockedError(Exception):
    pass


class BadRequest(Exception):
    pass


class Unauthorized(Exception):
    pass


# ---------------------------------------------------------------- editor sessions
# Stateless signed cookie: "<expiry>.<hmac>". The key is derived from the password, so changing
# MAPA_HASLO logs everybody out; restarting the server does not.
def _session_key():
    return hashlib.sha256(("mapa-sklepow-sesja:" + PASSWORD).encode("utf-8")).digest()


def make_session():
    exp = str(int(time.time()) + SESSION_DAYS * 86400)
    sig = hmac.new(_session_key(), exp.encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{sig}"


def session_valid(token):
    try:
        exp, sig = token.split(".", 1)
        good = hmac.new(_session_key(), exp.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, good) and int(exp) > time.time()
    except (ValueError, AttributeError):
        return False


def check_password(pw):
    ok = hmac.compare_digest(hashlib.sha256((pw or "").encode("utf-8")).digest(),
                             hashlib.sha256(PASSWORD.encode("utf-8")).digest())
    if not ok:
        with LOGIN_LOCK:
            time.sleep(1)
    return ok


# ---------------------------------------------------------------- backups
def backup(reason):
    """Copy the data file(s) to <dir>/kopie/<name>-<timestamp>-<reason>.<ext>; keep the newest KEEP_BACKUPS."""
    folder = os.path.join(os.path.dirname(DB.path), "kopie")
    os.makedirs(folder, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    srcs = [DB.path] + ([DB.inc_csv, DB.reg_csv] if DB.kind == "csv" else [])
    for src in srcs:
        if os.path.exists(src):
            base, ext = os.path.splitext(os.path.basename(src))
            try:
                shutil.copy2(src, os.path.join(folder, f"{base}-{stamp}-{reason}{ext}"))
            except PermissionError:
                raise FileLockedError(f"Nie można zapisać kopii {os.path.basename(src)} – czy plik jest otwarty w Excelu?")
    files = sorted((os.path.join(folder, f) for f in os.listdir(folder)), key=os.path.getmtime, reverse=True)
    for old in files[KEEP_BACKUPS * len(srcs):]:
        try:
            os.remove(old)
        except OSError:
            pass


# ---------------------------------------------------------------- helpers
def to_json_value(v):
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d") if (v.hour, v.minute, v.second) == (0, 0, 0) else v.strftime("%Y-%m-%d %H:%M")
    if isinstance(v, date):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, float) and v.is_integer() and abs(v) > 1000:
        return str(int(v))
    return str(v).replace(" ", " ").strip()


DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$")


def to_cell_value(col, v):
    """Convert JSON string back to a sensible Excel cell value."""
    if v is None or v == "":
        return None
    if not isinstance(v, str):
        return v
    s = v.strip()
    if col in ("Lat", "Lng"):
        try:
            return float(s)
        except ValueError:
            return None
    if DATE_RE.match(s) and col.lower().startswith("data"):
        try:
            return datetime.strptime(s, "%Y-%m-%d %H:%M" if " " in s else "%Y-%m-%d")
        except ValueError:
            return s
    # plain integers without leading zero (phone numbers) -> int, keeps Excel tidy
    if re.fullmatch(r"[1-9]\d{0,14}", s) and col not in ("ID",):
        return int(s)
    return s


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


# ---------------------------------------------------------------- storage
class Data:
    """Everything in the file: store columns, stores, incidents, region colours."""

    def __init__(self, cols, stores, inc, regions):
        self.cols, self.stores, self.inc, self.regions = cols, stores, inc, regions

    def to_json(self):
        return {"columns": self.cols, "stores": self.stores, "incidents": self.inc, "regions": self.regions}


class Store:
    def __init__(self, path):
        self.path = os.path.abspath(path)
        self.kind = "csv" if self.path.lower().endswith(".csv") else "xlsx"
        if self.kind == "xlsx" and openpyxl is None:
            sys.exit("openpyxl is required for .xlsx files:  pip install openpyxl")
        base = re.sub(r"\.csv$", "", self.path, flags=re.I)
        self.inc_csv = base + "_incydenty.csv"
        self.reg_csv = base + "_regiony.csv"

    def mtime(self):
        paths = [self.path] + ([self.inc_csv, self.reg_csv] if self.kind == "csv" else [])
        return max([os.path.getmtime(p) for p in paths if os.path.exists(p)] or [0])

    # ---- read
    def load(self):
        cols, stores, inc, regs = self._load_xlsx() if self.kind == "xlsx" else self._load_csv()
        changed = normalize(cols, stores, inc, regs)
        return Data(cols, stores, inc, regs), changed

    def _rows_to_dicts(self, rows):
        rows = list(rows)
        if not rows:
            return [], []
        header = [to_json_value(h) for h in rows[0]]
        while header and not header[-1]:
            header.pop()
        out = []
        for r in rows[1:]:
            vals = [to_json_value(v) for v in list(r)[: len(header)]]
            if not any(vals):
                continue
            vals += [""] * (len(header) - len(vals))
            out.append(dict(zip(header, vals)))
        return header, out

    def _load_xlsx(self):
        wb = openpyxl.load_workbook(self.path, data_only=True)
        cols, stores = self._rows_to_dicts(wb.worksheets[0].iter_rows(values_only=True))
        inc = regs = []
        if INCIDENT_SHEET in wb.sheetnames:
            _, inc = self._rows_to_dicts(wb[INCIDENT_SHEET].iter_rows(values_only=True))
        if REGION_SHEET in wb.sheetnames:
            _, regs = self._rows_to_dicts(wb[REGION_SHEET].iter_rows(values_only=True))
        return cols, stores, inc, regs

    def _read_csv(self, path):
        if not os.path.exists(path):
            return [], []
        with open(path, "r", encoding="utf-8-sig", newline="") as f:
            sample = f.read(4096)
            f.seek(0)
            try:
                dialect = csv.Sniffer().sniff(sample, delimiters=";,\t")
            except csv.Error:
                dialect = csv.excel
            return self._rows_to_dicts(csv.reader(f, dialect))

    def _load_csv(self):
        cols, stores = self._read_csv(self.path)
        _, inc = self._read_csv(self.inc_csv)
        _, regs = self._read_csv(self.reg_csv)
        return cols, stores, inc, regs

    # ---- write
    def save(self, d):
        try:
            if self.kind == "xlsx":
                self._save_xlsx(d)
            else:
                self._save_csv(d)
        except PermissionError:
            raise FileLockedError(
                f"Nie można zapisać {os.path.basename(self.path)} – czy plik jest otwarty w Excelu? Zamknij go i spróbuj ponownie."
            )

    def _sheet(self, wb, name, header, rows, first=False):
        if first:
            ws = wb.worksheets[0]
        elif name in wb.sheetnames:
            ws = wb[name]
        else:
            ws = wb.create_sheet(name)
        widths = {k: v.width for k, v in ws.column_dimensions.items()}
        ws.delete_rows(1, ws.max_row + 1)
        ws.append(header)
        for r in rows:
            ws.append([to_cell_value(c, r.get(c, "")) for c in header])
        self._fmt(ws, header, widths)

    def _save_xlsx(self, d):
        wb = openpyxl.load_workbook(self.path)
        self._sheet(wb, None, d.cols, d.stores, first=True)
        self._sheet(wb, INCIDENT_SHEET, INCIDENT_COLS, d.inc)
        self._sheet(wb, REGION_SHEET, REGION_COLS, d.regions)
        tmp = self.path + ".tmp"
        wb.save(tmp)
        os.replace(tmp, self.path)

    @staticmethod
    def _fmt(ws, cols, widths):
        from openpyxl.styles import Font
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for idx, c in enumerate(cols, start=1):
            letter = openpyxl.utils.get_column_letter(idx)
            if letter not in widths or not widths[letter]:
                ws.column_dimensions[letter].width = max(10, min(45, len(c) + 4))
            if c.lower().startswith("data"):
                for row in ws.iter_rows(min_row=2, min_col=idx, max_col=idx):
                    for cell in row:
                        if isinstance(cell.value, datetime):
                            cell.number_format = "yyyy-mm-dd hh:mm" if (cell.value.hour or cell.value.minute) else "yyyy-mm-dd"
        ws.freeze_panes = "A2"

    def _save_csv(self, d):
        for path, header, rows in ((self.path, d.cols, d.stores), (self.inc_csv, INCIDENT_COLS, d.inc),
                                   (self.reg_csv, REGION_COLS, d.regions)):
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8-sig", newline="") as f:
                w = csv.writer(f, delimiter=";")
                w.writerow(header)
                for r in rows:
                    w.writerow([r.get(c, "") for c in header])
            os.replace(tmp, path)


def normalize(cols, stores, inc, regs):
    """Fill in app columns/IDs and convert values from older file versions. Returns True if anything changed."""
    changed = False
    for c in APP_STORE_COLS:
        if c not in cols:
            cols.append(c)
            changed = True
    for s in stores:
        for c in cols:
            s.setdefault(c, "")
        if not s["ID"]:
            s["ID"] = uuid.uuid4().hex[:8]
            changed = True
        if not s["Status"]:
            s["Status"] = "aktywny"
    for i in inc:
        for c in INCIDENT_COLS:
            i.setdefault(c, "")
        for k in [k for k in i if k not in INCIDENT_COLS]:  # e.g. old Lat/Lng columns
            del i[k]
            changed = True
        if not i["ID"]:
            i["ID"] = uuid.uuid4().hex[:8]
            changed = True
        st = LEGACY_STATUS.get(i["Status"], i["Status"]) or "nowa"
        pr = LEGACY_PRIO.get(i["Priorytet"], i["Priorytet"]) or "średni"
        if (st, pr) != (i["Status"], i["Priorytet"]):
            i["Status"], i["Priorytet"] = st, pr
            changed = True
    if not regs:
        regs.extend({"Region": n, "Kolor": c, "Typ": t} for n, c, t in DEFAULT_REGIONS)
        changed = True
    for r in regs:
        if r.get("Typ") not in REGION_TYPES:
            r["Typ"] = "sklepy"
            changed = True
    return changed


DB = None


def read_all():
    d, changed = DB.load()
    if changed:
        try:
            DB.save(d)
        except FileLockedError:
            pass
    return d


# ---------------------------------------------------------------- geocoding
_last_geo = [0.0]


def geocode(q):
    # Nominatim usage policy: max 1 request / second, identify the client
    wait = 1.1 - (time.time() - _last_geo[0])
    if wait > 0:
        time.sleep(wait)
    _last_geo[0] = time.time()
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": q, "format": "json", "limit": 1, "countrycodes": "pl,de"}
    )
    req = urllib.request.Request(url, headers={"User-Agent": "local-store-map/1.0", "Accept-Language": "pl"})
    with urllib.request.urlopen(req, timeout=15) as r:
        res = json.load(r)
    if not res:
        return None
    return {"lat": float(res[0]["lat"]), "lng": float(res[0]["lon"]), "label": res[0].get("display_name", "")}


def clean_address(a):
    a = (a or "").replace(" ", " ")
    a = re.sub(r"(?i)\bul\.\s*", "", a)
    a = re.sub(r"(?i)\bal\.\s*", "Aleja ", a)
    return re.sub(r"\s+", " ", a).strip()


# ---------------------------------------------------------------- mutations
def check_incident(rec, d):
    names = {s.get(d.cols[0]) for s in d.stores}
    if rec["POS"] not in names:
        raise BadRequest("Usterkę można przypisać tylko do istniejącego sklepu – wybierz sklep z listy.")
    if rec["Priorytet"] not in PRIORITIES:
        raise BadRequest("Nieznany priorytet: " + rec["Priorytet"])
    if rec["Status"] not in INC_STATUSES:
        raise BadRequest("Nieznany status: " + rec["Status"])
    if rec["Status"] == DONE and not rec["Data zamknięcia"]:
        rec["Data zamknięcia"] = now()
    if rec["Status"] != DONE:
        rec["Data zamknięcia"] = ""


def mutate(method, kind, rid, data):
    d = read_all()
    name_col = d.cols[0]
    coll = d.stores if kind == "stores" else d.inc
    allowed = d.cols if kind == "stores" else INCIDENT_COLS
    rec = None
    if rid:
        rec = next((r for r in coll if r.get("ID") == rid), None)
        if rec is None:
            raise BadRequest("Nie znaleziono rekordu (plik się zmienił?) – odśwież stronę.")
    old_name = rec.get(name_col) if (rec and kind == "stores") else None
    if method == "POST":
        rec = {c: "" for c in allowed}
        rec["ID"] = uuid.uuid4().hex[:8]
        if kind == "incidents":
            rec.update({"Data zgłoszenia": now(), "Status": "nowa", "Priorytet": "średni"})
        else:
            rec["Status"] = "aktywny"
        coll.append(rec)
    if method in ("POST", "PUT"):
        for k, v in data.items():
            if k in allowed and k != "ID":
                rec[k] = "" if v is None else str(v).strip()
        if kind == "incidents" and data.get("Data przewidywana"):
            try:
                datetime.strptime(rec["Data przewidywana"], "%Y-%m-%d")
            except ValueError:
                raise BadRequest("Nieprawidłowa przewidywana data rozwiązania (oczekiwano RRRR-MM-DD).")
        if kind == "incidents":
            check_incident(rec, d)
        else:
            if not rec[name_col]:
                raise BadRequest("Podaj nazwę sklepu.")
            # keep incidents attached when a store is renamed
            if old_name and rec[name_col] != old_name:
                for i in d.inc:
                    if i["POS"] == old_name:
                        i["POS"] = rec[name_col]
    if method == "DELETE":
        coll.remove(rec)
        if kind == "stores":
            d.inc = [i for i in d.inc if i["POS"] != rec[name_col]]
    DB.save(d)
    return rec if method != "DELETE" else None


def save_regions(items):
    """items: [{old, name, color}] - renames regions on stores and stores colours."""
    d = read_all()
    rcol = next((c for c in d.cols if re.search("region", c, re.I)), None)
    regs = []
    for it in items:
        old, name, color = (it.get("old") or "").strip(), (it.get("name") or "").strip(), (it.get("color") or "").strip()
        rtype = it.get("type") if it.get("type") in REGION_TYPES else "sklepy"
        if not name:
            continue
        if rcol and old and old != name:
            for s in d.stores:
                if s[rcol] == old:
                    s[rcol] = name
        regs.append({"Region": name, "Kolor": color, "Typ": rtype})
    d.regions = regs
    DB.save(d)


def upload_xlsx(raw):
    """Replace the data file with an uploaded workbook (after validating it and backing up the old one)."""
    if DB.kind != "xlsx":
        raise BadRequest("Serwer pracuje na plikach CSV – wgrywanie Excela jest wyłączone.")
    if not raw.startswith(b"PK"):
        raise BadRequest("To nie jest plik .xlsx.")
    tmp = os.path.splitext(DB.path)[0] + ".upload-tmp.xlsx"   # openpyxl checks the extension
    with open(tmp, "wb") as f:
        f.write(raw)
    try:
        try:
            cols, stores, inc, regs = Store(tmp)._load_xlsx()
        except Exception as e:
            raise BadRequest(f"Nie można odczytać pliku Excel: {e}")
        if not cols:
            raise BadRequest("Pierwszy arkusz jest pusty – oczekiwano listy sklepów z nagłówkiem w pierwszym wierszu.")
        if not stores:
            raise BadRequest("Pierwszy arkusz nie zawiera żadnych sklepów.")
        names = {s.get(cols[0]) for s in stores}
        orphans = sum(1 for i in inc if i.get("POS") not in names)
        backup("przed-wgraniem")
        os.replace(tmp, DB.path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    read_all()  # assign IDs / upgrade old values
    return {"stores": len(stores), "incidents": len(inc), "orphans": orphans}


# ---------------------------------------------------------------- branding
def brand_name():
    try:
        with open(os.path.join(BRAND_DIR, "nazwa.txt"), encoding="utf-8-sig") as f:
            return f.read().strip()[:80]
    except OSError:
        return ""


def brand_file(kind):
    """Path + MIME type of the logo/favicon: the company's one from BRAND_DIR, else the neutral default."""
    for ext, mime in BRAND_TYPES.items():
        p = os.path.join(BRAND_DIR, kind + ext)
        if os.path.isfile(p):
            return p, mime
    return os.path.join(STATIC, "domyslne", kind + ".svg"), "image/svg+xml"


# ---------------------------------------------------------------- HTTP
def editor_enabled():
    return bool(PASSWORD)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):
        first = str(args[0]) if args else ""
        if "/api/" in first and "/api/version" not in first:
            sys.stderr.write("%s %s\n" % (self.client_address[0], fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        super().end_headers()

    # ---- access control
    def _lan_ok(self):
        if not LAN_ONLY:
            return True
        try:
            ip = ipaddress.ip_address(self.client_address[0])
            if ip.version == 6 and ip.ipv4_mapped:
                ip = ip.ipv4_mapped
            return ip.is_private or ip.is_loopback or ip.is_link_local
        except ValueError:
            return False

    def _cookie(self, name):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == name:
                return v
        return ""

    def _is_editor(self):
        return not editor_enabled() or session_valid(self._cookie(SESSION_COOKIE))

    def _same_origin(self):
        # SameSite=Strict already stops other sites from sending the cookie; this is a second check.
        origin = self.headers.get("Origin")
        if not origin:
            return True
        return urllib.parse.urlparse(origin).netloc == (self.headers.get("Host") or "")

    def _deny_non_lan(self):
        self.send_error(403, "Dostep tylko z sieci lokalnej")

    # ---- responses
    def _json(self, obj, code=200, cookie=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def _raw_body(self, limit=MAX_UPLOAD):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise BadRequest(f"Plik jest za duży (maks. {limit // (1024 * 1024)} MB).")
        return self.rfile.read(n)

    def _body(self):
        try:
            return json.loads(self._raw_body().decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise BadRequest("Nieprawidłowe dane (oczekiwano JSON w UTF-8).")

    def _session_cookie(self, value, max_age):
        return f"{SESSION_COOKIE}={value}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Strict"

    # ---- GET
    def do_HEAD(self):
        if not self._lan_ok():
            return self._deny_non_lan()
        return super().do_HEAD()

    def do_GET(self):
        if not self._lan_ok():
            return self._deny_non_lan()
        p = urllib.parse.urlparse(self.path)
        if p.path == "/api/data":
            with LOCK:
                d = read_all()
            return self._json({**d.to_json(), "priorities": PRIORITIES, "statuses": INC_STATUSES,
                               "file": os.path.basename(DB.path), "mtime": DB.mtime(), "kind": DB.kind,
                               "editor": self._is_editor(), "login": editor_enabled(), "brand": brand_name()})
        if p.path in ("/marka/logo", "/marka/favicon"):
            path, mime = brand_file(p.path.rsplit("/", 1)[1])
            with open(path, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if p.path == "/api/version":
            return self._json({"mtime": DB.mtime()})
        if p.path == "/api/auth":
            return self._json({"editor": self._is_editor(), "login": editor_enabled()})
        if p.path == "/api/xlsx":
            if DB.kind != "xlsx":
                return self._json({"error": "Serwer pracuje na plikach CSV."}, 400)
            with LOCK:
                read_all()
                with open(DB.path, "rb") as f:
                    body = f.read()
            name = os.path.splitext(os.path.basename(DB.path))[0] + "-" + datetime.now().strftime("%Y-%m-%d") + ".xlsx"
            self.send_response(200)
            self.send_header("Content-Type", XLSX_MIME)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Disposition", f'attachment; filename="{name}"')
            self.end_headers()
            self.wfile.write(body)
            return
        if p.path == "/api/geocode":
            if not self._is_editor():
                return self._json({"error": "Zaloguj się, aby edytować.", "login": True}, 401)
            q = urllib.parse.parse_qs(p.query).get("q", [""])[0]
            try:
                r = geocode(clean_address(q))
                if not r:
                    m = re.search(r"\d{2}-\d{3}.*$", q)  # retry with just postcode + city
                    if m:
                        r = geocode(clean_address(m.group(0)))
                return self._json(r or {"error": "Nie znaleziono adresu"}, 200 if r else 404)
            except Exception as e:
                return self._json({"error": f"Błąd geokodowania: {e}"}, 502)
        if p.path.startswith("/api/"):
            return self._json({"error": "not found"}, 404)
        return super().do_GET()

    # ---- changes
    def do_POST(self):
        self._mutate("POST")

    def do_PUT(self):
        self._mutate("PUT")

    def do_DELETE(self):
        self._mutate("DELETE")

    def _mutate(self, method):
        if not self._lan_ok():
            return self._deny_non_lan()
        parts = [x for x in urllib.parse.urlparse(self.path).path.split("/") if x]
        try:
            if not self._same_origin():
                return self._json({"error": "Niedozwolone źródło żądania."}, 403)
            if parts == ["api", "login"] and method == "POST":
                if not editor_enabled():
                    return self._json({"ok": True, "editor": True})
                if not check_password(self._body().get("password")):
                    sys.stderr.write(f"{self.client_address[0]} nieudane logowanie\n")
                    return self._json({"error": "Nieprawidłowe hasło."}, 401)
                return self._json({"ok": True, "editor": True},
                                  cookie=self._session_cookie(make_session(), SESSION_DAYS * 86400))
            if parts == ["api", "logout"] and method == "POST":
                return self._json({"ok": True, "editor": not editor_enabled()}, cookie=self._session_cookie("", 0))
            if not self._is_editor():
                raise Unauthorized()
            if parts == ["api", "xlsx"] and method == "POST":
                raw = self._raw_body()
                with LOCK:
                    res = upload_xlsx(raw)
                return self._json({"ok": True, **res, "mtime": DB.mtime()})
            with LOCK:
                if parts == ["api", "regions"] and method == "PUT":
                    save_regions(self._body().get("regions") or [])
                    return self._json({"ok": True, "mtime": DB.mtime()})
                if len(parts) < 2 or parts[0] != "api" or parts[1] not in ("stores", "incidents"):
                    return self._json({"error": "not found"}, 404)
                rid = parts[2] if len(parts) > 2 else None
                if method != "POST" and not rid:
                    return self._json({"error": "missing id"}, 400)
                data = self._body() if method in ("POST", "PUT") else {}
                rec = mutate(method, parts[1], rid, data)
                return self._json({"ok": True, "record": rec, "mtime": DB.mtime()})
        except Unauthorized:
            return self._json({"error": "Zaloguj się, aby edytować.", "login": True}, 401)
        except BadRequest as e:
            return self._json({"error": str(e)}, 400)
        except FileLockedError as e:
            return self._json({"error": str(e)}, 409)


def main():
    global DB, PASSWORD, LAN_ONLY, KEEP_BACKUPS, BRAND_DIR
    argv = sys.argv[1:]
    no_browser = "--no-browser" in argv
    args = [a for a in argv if a != "--no-browser"]

    def opt(name, env, default):
        if name in args:
            i = args.index(name)
            val = args[i + 1]
            del args[i:i + 2]
            return val
        return os.environ.get(env) or default

    port = int(opt("--port", "MAPA_PORT", "8000"))
    host = opt("--host", "MAPA_HOST", "127.0.0.1")
    path = args[0] if args else os.environ.get("MAPA_DATA") or os.path.join(HERE, "mapa_dane.xlsx")
    PASSWORD = os.environ.get("MAPA_HASLO", "")
    LAN_ONLY = os.environ.get("MAPA_TYLKO_LAN", "1") != "0"
    KEEP_BACKUPS = max(1, int(os.environ.get("MAPA_KOPIE", "30")))
    local = host in ("127.0.0.1", "localhost", "::1")
    if not local and not PASSWORD:
        sys.exit("Ustaw hasło do edycji w zmiennej MAPA_HASLO – bez niego serwer dostępny w sieci nie wystartuje.")
    if not os.path.exists(path):
        sys.exit(f"Data file not found: {path}")
    DB = Store(path)
    BRAND_DIR = os.environ.get("MAPA_MARKA") or os.path.join(os.path.dirname(DB.path), "marka")
    read_all()  # validate, assign IDs, upgrade old values
    srv = ThreadingHTTPServer((host, port), Handler)
    url = f"http://localhost:{port}"
    print(f"Mapa sklepów: http://{host}:{port}  (dane: {DB.path})", flush=True)
    print(("Edycja: wymaga hasła" if PASSWORD else "Edycja: bez hasła (tryb lokalny)")
          + (" · tylko sieć lokalna" if LAN_ONLY else "") + "\nCtrl+C aby zatrzymać.", flush=True)
    if local and not no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
