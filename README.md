# Mapa sklepów – mapa sklepów, nowych otwarć i usterek

Web map (Leaflet + OpenStreetMap) of a store network: stores, new openings, franchises and incidents (usterki),
coloured by region. All data lives in an **Excel or CSV file**: the app reads it and writes every change back.

It is meant to run on an **Ubuntu server in Docker, reachable only from the local network**.
Anyone on the LAN can view the map; adding or changing data requires a single shared editor password.

## Try it with example data

`przyklad/mapa_dane_przyklad.xlsx` is a made-up data file (15 locations, 7 incidents, 5 regions) with exactly the
layout the app expects – use it to try the app or as a template for your own file:
```bash
pip install openpyxl
python server.py przyklad/mapa_dane_przyklad.xlsx
```
The app writes edits back into that file; `python tools/make_example.py` recreates it.

## Ubuntu server (Docker)

The server's app folder (e.g. `~/mapa-sklepow`) is a git checkout of this repository; the data stays in
`~/mapa-sklepow/dane/`, outside git.

### Updating the server
Push changes to `main` on GitHub, then on the server:
```bash
cd ~/mapa-sklepow && bash wdroz.sh
```
`wdroz.sh` pulls the latest code from GitHub, rebuilds and restarts the container. Data (`dane/`), backups and `.env`
are not in the repository and are never touched. If files on the server were edited by hand, it stops and says which
(make the change in the repository instead).

### Installing on a new server
The server reads the repository over SSH with its own **deploy key** (read-only, this repository only), which also
works while the repository is private.
```bash
git clone https://github.com/theAbominableFox/store-map-remote.git mapa-sklepow   # or copy the folder: only wdroz.sh is needed
cd mapa-sklepow && cp /path/to/mapa_dane.xlsx . && bash wdroz.sh
```
(While the repository is private the HTTPS clone needs a GitHub login; copying just `wdroz.sh` into an empty
`mapa-sklepow` folder works too. For a fork, set `MAPA_REPO=git@github.com:<you>/<repo>.git`.) On the first run `wdroz.sh`:
1. installs git and Docker if missing (asks for the sudo password),
2. creates the key `~/.ssh/mapa_sklepow_deploy`, prints its public part and **waits** – add it on GitHub under
   *Settings → Deploy keys → Add deploy key* (leave "Allow write access" off), or from a PC logged in with `gh`:
   `gh repo deploy-key add key.pub --repo theAbominableFox/store-map-remote --title "mapa-sklepow <server>"`,
3. turns the folder into a checkout of `main`, moves `mapa_dane.xlsx` to `dane/`,
4. asks for the editor password and writes `.env`,
5. builds and starts the container and prints the address.

Manual steps (what the script does):

1. Install Docker (Ubuntu 22.04/24.04):
   ```bash
   sudo apt update && sudo apt install -y docker.io docker-compose-v2
   ```
2. Get the code onto the server (e.g. `~/mapa-sklepow`) – `git clone` with the deploy key.
3. Put the data file in `dane/` and let the container (user 1000) write there:
   ```bash
   cd /opt/mapa-sklepow
   mkdir -p dane && cp mapa_dane.xlsx dane/
   sudo chown -R 1000:1000 dane
   ```
4. Create the settings file and set the password (and ideally the server's LAN IP in `MAPA_ADRES`):
   ```bash
   cp .env.example .env && nano .env && chmod 600 .env
   ```
5. Start it (restarts on its own after a reboot):
   ```bash
   sudo docker compose up -d --build
   ```
   The map is at `http://<server-ip>:8000`.

Useful commands: `sudo docker compose logs -f` (log, including failed logins), `sudo docker compose restart`,
`bash wdroz.sh` to update.

### Company logo and name
The repository ships a neutral logo. To show your own, put any of these in `dane/marka/` on the server (next to the
data file; locally: `marka/` next to `mapa_dane.xlsx`):
- `logo.png` (or `.svg`/`.jpg`/`.webp`) – sidebar logo, shown 40×40 px,
- `favicon.png` (or `.svg`/`.ico`) – browser tab icon,
- `nazwa.txt` – company name, shown in the browser tab as "Mapa sklepów | <name>".

Easiest: copy a `marka` folder with those files into the app folder on the server and run `bash wdroz.sh` – it moves
them to `dane/marka/`. A browser refresh shows them; no rebuild needed. `marka/` is git-ignored.

### Access and security
- **Viewing** needs no login. **Editing** (stores, incidents, regions, imports, geocoding) needs the password from
  `MAPA_HASLO`; the login lasts 30 days per browser (*Wyloguj* ends it). Changing the password logs everyone out.
- LAN only: the server rejects requests from non-private IP addresses (`MAPA_TYLKO_LAN=1`). Docker-published ports
  **bypass ufw**, so restrict the listening address with `MAPA_ADRES` in `.env` and never forward the port on the router.
- It is plain HTTP – the password travels unencrypted inside the LAN. Fine for an office network; put a reverse proxy
  with HTTPS in front of it if that matters.
- Browsers still need internet access for the map tiles (OpenStreetMap / Esri) and Leaflet (unpkg); the server needs it
  for address geocoding (Nominatim).

### Working in Excel
Nobody can open the server's file directly any more. Instead:
- **⬇ Pobierz Excel** – downloads the current data file (anyone).
- **⬆ Wgraj Excel** – replaces all data with an uploaded `.xlsx` (editors only). Download first, edit, upload –
  otherwise changes made on the map in the meantime are lost. The upload is validated (first sheet must contain stores).
- Before every upload the previous file is copied to `dane/kopie/` (newest `MAPA_KOPIE`, default 30, kept).
  To restore one, upload it with *Wgraj Excel*, or copy it over `dane/mapa_dane.xlsx`.

## Running locally on Windows (testing)

`start.bat` still works as before: it listens on localhost only and, without `MAPA_HASLO`, editing needs no login.

## Installation (new Windows computer)

Copy the whole folder and double-click **`install.bat`**. It:
1. installs Python 3.12 via **winget** if it is missing (for the current user, no admin rights needed),
2. installs the `openpyxl` library.

If the computer has no winget (older Windows 10), the script says so: install Python from
https://www.python.org/downloads/ (tick "Add python.exe to PATH") and run `install.bat` again.
`start.bat` also runs the installation itself if it can't find Python.

## Start

Double-click **`start.bat`** (opens http://localhost:8000), or:

```bash
python server.py mapa_dane.xlsx
```

Other file: `start.bat C:\path\to\file.xlsx` or `python server.py file.csv --port 8001`.
Requires Python 3 and openpyxl – `install.bat` sets both up.

## Using the map

| What | How |
|---|---|
| Add a store | **+ Dodaj sklep**, or right-click the map. Type the address and click *Znajdź na mapie*, or *Wskaż na mapie* |
| New opening ↔ active, moving a pin | store popup → *Edytuj* → *Status* / *Wskaż na mapie* |
| Add an incident | **+ Usterka** (pick the store), or the store popup → *+ Usterka*. Incidents always belong to an existing store |
| Incident status | click the status in the popup: **Nowa → W trakcie → Naprawiona** (the closing date is recorded) |
| Filters | chips: regions (several at once), Z usterkami / Nowe otwarcia, Własne / Franczyzy; search |
| Regions | **Regiony** – change names and colours (a rename also updates the stores); tick *nie sklepy* for regions of non-store locations (e.g. "Inne lokalizacje") |
| Editing | **🔒 Zaloguj do edycji** (password); without it the map is read-only |
| Excel | **⬇ Pobierz Excel** / **⬆ Wgraj Excel** (an upload replaces everything; the old file goes to `kopie/`) || Missing coordinates | *Geokoduj brakujące* looks the addresses up in OpenStreetMap |
| Menu | ☰ hides the menu; *Kolor menu*: auto / light / dark |
| Legend | click **Legenda** (bottom-right) to fold/unfold it; folded by default on phones (remembered per browser) |
| Route | route button (top-right, next to the magnifier), click pins in order, click the button again: list of stops with a Google Maps link. Straight lines only; the list is remembered per browser |
| Map style | button in the bottom-left corner: Standardowa, Przygaszona, Ciemna, Ciemnoszara (remembered per browser) |

### Pins
- full circle = own store (*własny*), hollow circle = franchise, diamond = new opening; colour = region
- **"!"** on a pin = open incidents, coloured by the highest priority (blue = low, amber = medium, red = high); the number = how many
- store names appear under the pins from zoom 9

Changes to the data file (an upload, or another person's edit) are picked up by every open map within ~5 s.
When running locally on Windows, **close the file in Excel before saving from the map** (Windows locks open files).

## File format

- Sheet **POSy** (stores; always the first sheet): the store-list columns (POS Nazwa, Adres, Telefon, Data otwarcia, Region, Kierownik sklepu, Franczyzobiorca, Rodzaj, MPK; first column = store name; columns with "Adres", "Region",
  "Rodzaj" are recognised automatically) + `Status` (`aktywny`/`pending`), `Lat`, `Lng`, `ID`.
- Sheet **Incydenty**: `ID, POS (store name), Priorytet (niski/średni/wysoki), Komentarz, Status (nowa/w trakcie/naprawiona), Data zgłoszenia, Data zamknięcia, Data przewidywana (predicted resolution date, optional)`.
- Sheet **Regiony**: `Region, Kolor, Typ` – `Typ` = `sklepy` or `inne` (locations that are not stores, e.g. warehouses; they appear on the map but don't count in the stores / nowe / franczyz tiles).
- CSV: `file.csv` + `file_incydenty.csv` + `file_regiony.csv` (`;`, UTF-8).

Older files (statuses `otwarty`/`zamknięty`, priority `krytyczny`, incident `Lat`/`Lng` columns) are converted automatically.

## Tools

- `tools/build_borders.py` – builds `static/granice.geojson` (national and voivodeship borders drawn over the map: red on the light styles, white on the dark ones) from the GUGiK voivodeship data in the ppatrzyk/polska-geojson repository.
- `tools/make_example.py` – rebuilds the made-up example file `przyklad/mapa_dane_przyklad.xlsx`.

## Licence

No licence is granted: the code is published for viewing only, and all rights are reserved.
The border data in `static/granice.geojson` comes from GUGiK (via ppatrzyk/polska-geojson); map tiles are
© OpenStreetMap contributors and © Esri, used under their own terms.
