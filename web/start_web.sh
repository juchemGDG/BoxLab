#!/usr/bin/env bash
# Startet Boxlab lokal im Browser:  bash web/start_web.sh [Port]
# Vom iPad: http://<IP-des-Rechners>:<Port>
# Ohne Angabe wird ab 8000 der erste freie Port genommen
# (Port 5000 belegt auf dem Mac der AirPlay-Empfänger).
cd "$(dirname "${BASH_SOURCE[0]}")/static"

PORT="${1:-8000}"
if [[ -z "$1" ]]; then
  while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT + 1)); done
fi

echo "Boxlab läuft auf http://localhost:${PORT}  (Beenden: Strg+C)"
python3 -m http.server "$PORT"
