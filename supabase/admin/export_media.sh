#!/usr/bin/env bash
# Descarga todas las fotos y vídeos de la Noviembrada a ./exportacion, ordenados por fecha y con nombre claro.
# SOLO para quien administra y SOLO al acabar la Noviembrada (cuando la edición está cerrada).
# Uso, desde la carpeta app/:   bash supabase/admin/export_media.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.secrets.env; set +a
OUT="exportacion"
mkdir -p "$OUT/original"

echo "1/3 Lista de archivos (manifiesto.csv)…"
npx --yes supabase db query --remote --read-only -f supabase/admin/media_manifest.sql --output csv > "$OUT/manifiesto.csv"

echo "2/3 Descargando del almacenamiento…"
npx --yes supabase storage cp -r --remote ss:///proofs "$OUT/original" --experimental

echo "3/3 Renombrando en orden cronológico…"
python3 - "$OUT" <<'PY'
import csv, os, shutil, sys
out = sys.argv[1]; n = 0
os.makedirs(f"{out}/ordenados", exist_ok=True)
for r in csv.DictReader(open(f"{out}/manifiesto.csv", encoding="utf-8")):
    src = os.path.join(out, "original", r["ruta_original"])
    if os.path.exists(src):
        shutil.copy2(src, os.path.join(out, "ordenados", r["nuevo_nombre"])); n += 1
    else:
        print("  (no encontrado)", r["ruta_original"])
print(f"Listo: {n} archivos en {out}/ordenados")
PY
