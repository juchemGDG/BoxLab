#!/usr/bin/env bash
# Baut die Desktop-App (macOS/Linux) mit PyInstaller.
# PyInstaller kann nicht plattformübergreifend bauen: auf dem Mac die .app,
# unter Linux die Linux-App; unter Windows build_desktop.bat benutzen.
#
#   ./desktop/build_desktop.sh
set -e
cd "$(dirname "$0")/.."

python3 -m venv .build-venv
source .build-venv/bin/activate
pip install --upgrade pip
pip install -r desktop/requirements.txt pyinstaller

SEP=":"
ICON=()
if [[ "$(uname)" == "Darwin" ]]; then ICON=(--icon icon-1024.png); fi

pyinstaller desktop/boxlab_desktop.py --name Boxlab --windowed --noconfirm \
  --add-data "web/static${SEP}static" "${ICON[@]}" \
  --distpath build/dist --workpath build/work --specpath build

mkdir -p web/static/downloads
if [[ "$(uname)" == "Darwin" ]]; then
  hdiutil create -volname "Boxlab" -srcfolder build/dist/Boxlab.app -ov -format UDZO build/dist/Boxlab.dmg
  cp build/dist/Boxlab.dmg web/static/downloads/
  echo "Fertig: build/dist/Boxlab.dmg (auch nach web/static/downloads/ kopiert)"
else
  tar -C build/dist -czf build/dist/Boxlab-linux-x86_64.tar.gz Boxlab
  cp build/dist/Boxlab-linux-x86_64.tar.gz web/static/downloads/
  echo "Fertig: build/dist/Boxlab-linux-x86_64.tar.gz (auch nach web/static/downloads/ kopiert)"
fi
