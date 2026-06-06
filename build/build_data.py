#!/usr/bin/env python3
"""Build data/sales.json for the yard sale browser.

Sources
-------
1. Forest Hill Google My Map (build/source_map.kml) -> addresses + item lists
2. Westover Hills Neighborhood Association page -> addresses only
   https://www.westover-hills.org/updates/2026-addresses

Both lists are residential addresses in Richmond, VA 23225 with no
coordinates, so we geocode them with the free US Census batch geocoder
(no API key required) and cache the results in build/geocode_cache.json.
"""
import csv
import io
import json
import os
import re
import time
import urllib.request
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
KML = os.path.join(HERE, "source_map.kml")
CACHE = os.path.join(HERE, "geocode_cache.json")
OUT = os.path.join(ROOT, "data", "sales.json")
OUT_JS = os.path.join(ROOT, "data", "sales.js")  # global for <script src> (no fetch)

CITY, STATE, ZIP = "Richmond", "VA", "23225"

# Addresses from the WHNA page (street portion only; all Richmond VA 23225).
WHNA = [
    "5001 Evelyn Byrd Road", "5104 Evelyn Byrd Road", "5105 Evelyn Byrd Road",
    "4930 Forest Hill Avenue", "5103 Forest Hill Avenue",
    "5112 King William Road", "5001 King William Road", "5004 King William Road",
    "5007 King William Road", "5108 King William Road", "5201 King William Road",
    "5010 New Kent Road", "5106 New Kent Road", "5107 New Kent Road",
    "5111 Riverside Drive",
    "5323 Sylvan Road", "4613 Sylvan Road", "4615 Sylvan Road", "5013 Sylvan Road",
    "5032 Sylvan Road", "5103 Sylvan Road",
    "2432 Breckenridge Road",
    "5302 Caledonia Road", "5009 Caledonia Road", "5018 Caledonia Road",
    "5202 Caledonia Road", "5216 Caledonia Road",
    "5027 Devonshire Road", "4608 Devonshire Road", "4709 Devonshire Road",
    "5022 Devonshire Road", "5024 Devonshire Road", "5033 Devonshire Road",
    "5110 Devonshire Road",
    "5410 Dorchester Road", "5502 Dorchester Road", "5214 Dorchester Road",
    "5300 Dorchester Road", "5303 Dorchester Road", "5307 Dorchester Road",
    "5309 Dorchester Road", "5314 Dorchester Road", "5414 Dorchester Road",
]

# Normalize common street-type abbreviations so the two lists dedupe cleanly.
STREET_TYPES = {
    "ave": "avenue", "av": "avenue", "rd": "road", "dr": "drive",
    "st": "street", "ln": "lane", "ct": "court", "blvd": "boulevard",
    "pl": "place", "ter": "terrace", "cir": "circle", "pkwy": "parkway",
}


def street_of(raw):
    """Return just the street portion (drop city/state/zip), trimmed."""
    s = raw.split(",")[0]
    s = re.sub(r"\b(richmond|va|virginia)\b", "", s, flags=re.I)
    s = re.sub(r"\b\d{5}\b", "", s)
    return re.sub(r"\s+", " ", s).strip(" ,")


def norm_key(street):
    """A canonical key for deduping (lowercased, abbreviations expanded)."""
    toks = re.sub(r"[^\w\s]", "", street.lower()).split()
    return " ".join(STREET_TYPES.get(t, t) for t in toks)


def load_forest_hill():
    ns = {"k": "http://www.opengis.net/kml/2.2"}
    root = ET.parse(KML).getroot()
    rows = []
    for p in root.findall(".//k:Placemark", ns):
        addr = (p.findtext("k:address", default="", namespaces=ns) or "").strip()
        if not addr or "#VALUE" in addr:
            continue
        items = ""
        for d in p.findall(".//k:Data", ns):
            if d.get("name") == "Items Available":
                items = (d.findtext("k:value", default="", namespaces=ns) or "").strip()
        rows.append((street_of(addr), items))
    return rows


def combine():
    """Merge both sources into one deduped list keyed by normalized street."""
    sales = {}

    def add(street, source, items=""):
        key = norm_key(street)
        rec = sales.setdefault(key, {
            "street": street, "sources": [], "items": "",
        })
        if source not in rec["sources"]:
            rec["sources"].append(source)
        if items and not rec["items"]:
            rec["items"] = items

    for street, items in load_forest_hill():
        add(street, "Forest Hill", items)
    for street in WHNA:
        add(street, "Westover Hills")

    return list(sales.values())


def geocode_batch(streets):
    """Geocode street strings with the US Census batch geocoder."""
    cache = {}
    if os.path.exists(CACHE):
        cache = json.load(open(CACHE))

    todo = [s for s in streets if s not in cache]
    print(f"{len(streets)} addresses, {len(todo)} need geocoding")

    for i in range(0, len(todo), 1000):  # census batch limit is 10k; stay small
        chunk = todo[i:i + 1000]
        buf = io.StringIO()
        w = csv.writer(buf)
        for n, s in enumerate(chunk):
            w.writerow([n, s, CITY, STATE, ZIP])
        result = _post_census(buf.getvalue())
        for row in csv.reader(io.StringIO(result)):
            # cols: id, input_addr, match, matchtype, matched_addr, lonlat, ...
            if len(row) < 6:
                continue
            idx = int(row[0])
            street = chunk[idx]
            if row[2] == "Match" and row[5]:
                lon, lat = row[5].split(",")
                cache[street] = {"lat": float(lat), "lon": float(lon),
                                 "matched": row[4]}
            else:
                cache[street] = None
        json.dump(cache, open(CACHE, "w"), indent=1)
    return cache


def _post_census(csv_text, retries=3):
    url = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
    boundary = "----yardsaleboundary"
    parts = []
    for name, val in [("benchmark", "Public_AR_Current")]:
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; "
                     f'name="{name}"\r\n\r\n{val}\r\n')
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; "
                 'name="addressFile"; filename="addr.csv"\r\n'
                 "Content-Type: text/csv\r\n\r\n" + csv_text + "\r\n")
    parts.append(f"--{boundary}--\r\n")
    body = "".join(parts).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    last = None
    for attempt in range(retries):
        try:
            return urllib.request.urlopen(req, timeout=120).read().decode()
        except Exception as e:  # noqa
            last = e
            time.sleep(2 ** attempt)
    raise last


def main():
    sales = combine()
    coords = geocode_batch([s["street"] for s in sales])

    out = []
    missing = []
    for s in sales:
        g = coords.get(s["street"])
        rec = {
            "street": s["street"],
            "address": f"{s['street']}, {CITY}, {STATE} {ZIP}",
            "sources": sorted(s["sources"]),
            "items": s["items"],
        }
        if g:
            rec["lat"], rec["lon"] = g["lat"], g["lon"]
        else:
            missing.append(s["street"])
        out.append(rec)

    out.sort(key=lambda r: (r["street"]))
    payload = {
        "event": "Forest Hill & Westover Hills Yard Sales",
        "date": "Saturday, June 6, 2026",
        "time": "8 a.m. - 12 noon (times vary by sale)",
        "generated_sources": [
            "https://www.westover-hills.org/updates/2026-addresses",
            "https://tinyurl.com/fh-2026-yardsale-map",
        ],
        "count": len(out),
        "sales": out,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(payload, open(OUT, "w"), indent=1)
    # The app loads the data via <script src="data/sales.js"> rather than fetch(),
    # so it works inside in-app webviews that restrict fetch/inline scripts.
    with open(OUT_JS, "w") as f:
        f.write("/* Auto-generated by build/build_data.py — do not edit. */\n")
        f.write("window.SALES_DATA = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    located = sum(1 for r in out if "lat" in r)
    print(f"wrote {OUT}: {len(out)} sales, {located} geocoded, "
          f"{len(missing)} missing")
    if missing:
        print("missing coords:")
        for m in missing:
            print("  -", m)


if __name__ == "__main__":
    main()
