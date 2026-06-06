# Yard Sale Browser

A tiny static web app for browsing the **Forest Hill** and **Westover Hills**
(Richmond, VA) yard sales on one interactive map.

It merges two public sources into a single view:

- [Westover Hills Neighborhood Association address list](https://www.westover-hills.org/updates/2026-addresses)
- [Forest Hill Google My Map](https://tinyurl.com/fh-2026-yardsale-map) (includes per-sale item lists)

Neither source publishes coordinates, so the addresses are geocoded with the
free [US Census batch geocoder](https://geocoding.geo.census.gov/) and baked
into `data/sales.json`.

## Features

- Leaflet + OpenStreetMap map with a pin per sale
- Color-coded by source (Forest Hill, Westover Hills, or both)
- Searchable, scrollable sidebar list synced with the map
- Filter by neighborhood
- One-tap "Directions" link to Google Maps for each address

## Run locally

It's a static site — just serve the folder:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(Serve it rather than opening `index.html` directly, so the `fetch` of
`data/sales.json` works.)

## Rebuild the data

`data/sales.json` is generated. To regenerate it (e.g. after the maps update):

```bash
python3 build/build_data.py
```

The build:

1. Parses the Forest Hill map snapshot (`build/source_map.kml`) for addresses + items.
2. Adds the WHNA address list (kept in `build/build_data.py`).
3. Dedupes by normalized street name, tagging each sale with its source(s).
4. Geocodes via the Census batch API, caching results in
   `build/geocode_cache.json`.

To refresh the Forest Hill snapshot:

```bash
curl -sL "https://www.google.com/maps/d/kml?mid=1k8X_b4vTrQ1vcSwRDfBbHssrSvNn8v4&forcekml=1" \
  -o build/source_map.kml
```

## Deploy

Any static host works. For GitHub Pages, enable Pages on this branch/repo and
point it at the root — no build step is needed since `data/sales.json` is committed.
