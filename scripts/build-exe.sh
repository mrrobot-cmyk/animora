#!/usr/bin/env bash
# Baut release-app/Animora.exe (Einzeldatei): App-Fenster/Starter (launcher/, WebView2) + angehängtes ZIP
# mit dem Release-Paket. Voraussetzung: vorher `npm run dist:web` (liefert das
# Release-ZIP inkl. node.exe) sowie mingw-w64 (x86_64-w64-mingw32-gcc), zip, python3.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
IFS=. read -r MA MI PA <<<"$VERSION"
OUT=release-app; TMP=$(mktemp -d)
unzip -q "$OUT/Animora-$VERSION-win-x64.zip" -d "$TMP"
cp launcher/webview2/WebView2Loader.dll "$TMP/Animora/runtime/"
(cd "$TMP/Animora" && zip -qr -9 ../payload.zip .)
sed -e "s/1,2,2,0/$MA,$MI,$PA,0/g" -e "s/\"1\.2\.2\"/\"$VERSION\"/g" launcher/res.rc > "$TMP/res.rc"
cp launcher/animora.ico launcher/app.manifest "$TMP/"
x86_64-w64-mingw32-windres "$TMP/res.rc" -O coff -o "$TMP/res.o"
x86_64-w64-mingw32-gcc -O2 -municode -mwindows -Ilauncher/webview2 -D_WIN32_WINNT=0x0A00 -Wno-attributes -DANIMORA_VERSION="\"$VERSION\"" \
  launcher/launcher.c launcher/miniz.c "$TMP/res.o" -o "$TMP/launcher.exe" -lshell32 -lole32 -luuid -ldwmapi -static -s
python3 - "$TMP/launcher.exe" "$TMP/payload.zip" "$OUT/Animora.exe" <<'PY'
import struct, sys
l = open(sys.argv[1], "rb").read(); p = open(sys.argv[2], "rb").read()
open(sys.argv[3], "wb").write(l + p + struct.pack("<Q", len(l)) + b"ANIMORA\x01")
PY
rm -rf "$TMP"
echo "Fertig: $OUT/Animora.exe"
