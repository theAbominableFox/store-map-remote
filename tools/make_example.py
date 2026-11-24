"""
Builds przyklad/mapa_dane_przyklad.xlsx – an example data file with made-up stores (same layout as the real one).

    python tools/make_example.py

All names, people, phone numbers and addresses are invented; coordinates are city centres.
The file is saved through server.py itself, so it has exactly the format the app writes.
"""
import os
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import server  # noqa: E402

OUT = os.path.join(os.path.dirname(HERE), "przyklad", "mapa_dane_przyklad.xlsx")

COLS = ["POS Nazwa", "Adres", "Telefon", "Data otwarcia", "Region", "Kierownik sklepu", "Franczyzobiorca",
        "Rodzaj", "MPK", "Status", "Lat", "Lng", "ID"]

# name, street, postcode city, region, manager, franchisee, kind, status, lat, lng, opened
STORES = [
    ("GD1-Gdańsk Centrum", "ul. Przykładowa 1", "80-001 Gdańsk", "Północ", "Anna Nowak", "", "własny", "aktywny", 54.3520, 18.6466, "2019-03-01"),
    ("GD2-Gdynia Port", "ul. Testowa 12", "81-001 Gdynia", "Północ", "Piotr Kowalski", "", "własny", "aktywny", 54.5189, 18.5305, "2020-06-15"),
    ("SZ1-Szczecin", "al. Wzorcowa 5", "70-001 Szczecin", "Północ", "Ewa Wiśniewska", "Firma Handlowa A", "franczyza", "aktywny", 53.4285, 14.5528, "2021-09-01"),
    ("WA1-Warszawa Mokotów", "ul. Demonstracyjna 3", "02-001 Warszawa", "Wschód", "Tomasz Wójcik", "", "własny", "aktywny", 52.2297, 21.0122, "2018-11-20"),
    ("WA2-Warszawa Praga", "ul. Próbna 44", "03-001 Warszawa", "Wschód", "Katarzyna Kamińska", "", "własny", "pending", 52.2550, 21.0350, ""),
    ("LU1-Lublin", "ul. Fikcyjna 8", "20-001 Lublin", "Wschód", "Marek Lewandowski", "Sklepy B sp. z o.o.", "franczyza", "aktywny", 51.2465, 22.5684, "2022-02-10"),
    ("BI1-Białystok", "ul. Zmyślona 21", "15-001 Białystok", "Wschód", "Agnieszka Zielińska", "", "własny", "aktywny", 53.1325, 23.1688, "2020-01-05"),
    ("KR1-Kraków Rynek", "ul. Przykładowa 7", "31-001 Kraków", "Południe", "Paweł Szymański", "", "własny", "aktywny", 50.0614, 19.9366, "2017-05-12"),
    ("KA1-Katowice", "ul. Wymyślona 2", "40-001 Katowice", "Południe", "Magdalena Woźniak", "", "własny", "aktywny", 50.2649, 19.0238, "2019-08-30"),
    ("RZ1-Rzeszów", "ul. Testowa 30", "35-001 Rzeszów", "Południe", "Krzysztof Dąbrowski", "Handel C", "franczyza", "pending", 50.0412, 21.9991, ""),
    ("PO1-Poznań Stary Rynek", "ul. Wzorcowa 15", "61-001 Poznań", "Zachód", "Joanna Kozłowska", "", "własny", "aktywny", 52.4064, 16.9252, "2018-04-18"),
    ("WR1-Wrocław", "ul. Próbna 9", "50-001 Wrocław", "Zachód", "Michał Jankowski", "", "własny", "aktywny", 51.1079, 17.0385, "2019-10-01"),
    ("ZG1-Zielona Góra", "ul. Demonstracyjna 11", "65-001 Zielona Góra", "Zachód", "Monika Mazur", "Firma Handlowa A", "franczyza", "aktywny", 51.9356, 15.5062, "2023-03-14"),
    ("LD1-Łódź Piotrkowska", "ul. Fikcyjna 100", "90-001 Łódź", "", "Adam Krawczyk", "", "własny", "aktywny", 51.7592, 19.4560, "2021-12-01"),
    ("Magazyn centralny", "ul. Logistyczna 1", "95-001 Stryków", "Inne lokalizacje", "", "", "", "aktywny", 51.9010, 19.6040, ""),
]

INCIDENTS = [
    ("GD1-Gdańsk Centrum", "wysoki", "Nie działa terminal płatniczy przy kasie 2.", "nowa", "2026-11-18 09:15", ""),
    ("GD1-Gdańsk Centrum", "niski", "Przepalona żarówka nad wejściem.", "w trakcie", "2026-11-10 14:00", ""),
    ("WA1-Warszawa Mokotów", "średni", "Cieknie klimatyzacja na zapleczu.", "w trakcie", "2026-11-12 11:30", ""),
    ("KR1-Kraków Rynek", "wysoki", "Zablokowane drzwi automatyczne.", "nowa", "2026-11-19 08:05", ""),
    ("PO1-Poznań Stary Rynek", "średni", "Uszkodzony regał w alejce 3.", "naprawiona", "2026-10-28 16:20", "2026-11-02 10:00"),
    ("LU1-Lublin", "niski", "Brak papieru w drukarce etykiet.", "naprawiona", "2026-11-05 12:00", "2026-11-05 15:30"),
    ("WR1-Wrocław", "średni", "Alarm włącza się bez powodu w nocy.", "nowa", "2026-11-17 07:45", ""),
]

REGIONS = [("Północ", "#2563eb", "sklepy"), ("Wschód", "#16a34a", "sklepy"), ("Południe", "#f59e0b", "sklepy"),
           ("Zachód", "#9333ea", "sklepy"), ("Inne lokalizacje", "#0d9488", "inne")]


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    stores = []
    for n, (name, street, city, region, mgr, fr, kind, status, lat, lng, opened) in enumerate(STORES, start=1):
        stores.append({
            "POS Nazwa": name, "Adres": f"{street}, {city}", "Telefon": str(500100100 + n),
            "Data otwarcia": opened, "Region": region, "Kierownik sklepu": mgr, "Franczyzobiorca": fr,
            "Rodzaj": kind, "MPK": f"MPK-{n:03d}" if region != "Inne lokalizacje" else "", "Status": status,
            "Lat": str(lat), "Lng": str(lng), "ID": f"{n:08x}",
        })
    due = {1: "2026-11-25", 2: "2026-11-28", 4: "2026-11-20"}   # przewidywana data rozwiązania
    inc = [{"ID": f"{0xa0 + n:08x}", "POS": pos, "Priorytet": prio, "Komentarz": text, "Status": st,
            "Data zgłoszenia": rep, "Data zamknięcia": closed, "Data przewidywana": due.get(n, "")}
           for n, (pos, prio, text, st, rep, closed) in enumerate(INCIDENTS, start=1)]
    regs = [{"Region": r, "Kolor": c, "Typ": t} for r, c, t in REGIONS]

    # start from an empty workbook with the right sheet names, then let the server write it
    import openpyxl
    wb = openpyxl.Workbook()
    wb.active.title = "POSy"
    wb.save(OUT)
    st = server.Store(OUT)
    st.save(server.Data(COLS, stores, inc, regs))
    print(f"Zapisano {OUT}: {len(stores)} lokalizacji, {len(inc)} usterek, {len(regs)} regionów")


if __name__ == "__main__":
    main()
