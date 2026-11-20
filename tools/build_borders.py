"""
Builds static/granice.geojson (border lines for the map) from a voivodeship GeoJSON
(https://github.com/ppatrzyk/polska-geojson, data: GUGiK PRG).

    python -I tools/build_borders.py wojewodztwa-medium.geojson static/granice.geojson

Edges used by one voivodeship only = national border ("kraj");
edges shared by two voivodeships = voivodeship border ("wojewodztwa").
Each line is therefore drawn once.
"""
import json
import sys
from collections import Counter

src, out = sys.argv[1], sys.argv[2]
gj = json.load(open(src, encoding="utf-8"))
if gj.get("type") != "FeatureCollection":
    sys.exit("not a FeatureCollection")

R = 5  # ~1 m precision


def rings(geom):
    if geom["type"] == "Polygon":
        polys = [geom["coordinates"]]
    elif geom["type"] == "MultiPolygon":
        polys = geom["coordinates"]
    else:
        return
    for poly in polys:
        for ring in poly:
            yield [(round(float(x), R), round(float(y), R)) for x, y, *_ in ring]


edges = Counter()
all_rings = []
for f in gj["features"]:
    for ring in rings(f["geometry"]):
        all_rings.append(ring)
        for a, b in zip(ring, ring[1:]):
            if a != b:
                edges[frozenset((a, b))] += 1


def chains(want):
    """Join consecutive ring edges of one kind into polylines."""
    lines = []
    for ring in all_rings:
        cur = []
        for a, b in zip(ring, ring[1:]):
            if a == b:
                continue
            if (edges[frozenset((a, b))] == 1) == want:
                if not cur:
                    cur = [a]
                cur.append(b)
            elif cur:
                lines.append(cur)
                cur = []
        if cur:
            lines.append(cur)
    return lines


country = chains(True)
internal = chains(False)
# shared edges appear in both neighbouring rings - keep each polyline once
seen, uniq = set(), []
for line in internal:
    key = frozenset(frozenset(e) for e in zip(line, line[1:]))
    if key not in seen:
        seen.add(key)
        uniq.append(line)
# drop polylines whose every edge was already emitted (reverse direction duplicates)
emitted, final = set(), []
for line in uniq:
    es = [frozenset(e) for e in zip(line, line[1:])]
    if all(e in emitted for e in es):
        continue
    emitted.update(es)
    final.append(line)

fc = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "properties": {"kind": "kraj"},
     "geometry": {"type": "MultiLineString", "coordinates": [[list(p) for p in l] for l in country]}},
    {"type": "Feature", "properties": {"kind": "wojewodztwa"},
     "geometry": {"type": "MultiLineString", "coordinates": [[list(p) for p in l] for l in final]}},
]}
json.dump(fc, open(out, "w", encoding="utf-8"), separators=(",", ":"))
print(f"{len(gj['features'])} voivodeships -> {len(country)} country lines, {len(final)} voivodeship lines")
