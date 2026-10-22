# Boxlab

Browser-App zum Entwerfen von Lasercut-Boxen mit Fingerzinken – im Look des PAP-Editors.

## Funktionen

- Deckel: ohne, fest verzinkt, **zum Abnehmen** (mit Einsatz), **Schiebedeckel** (läuft in Schlitzen
  der Seitenwände), **Klappdeckel** (Zapfen drehen in runden Lagern) – mit einstellbarem Spiel;
  Maße außen oder innen, Materialstärke, Zinkenbreite, Schnittfuge (Kerf)
- Zwischenwände: Anzahl (gleichmäßig verteilt) oder einzeln positionieren, in beide Richtungen;
  Kreuzschlitze, wenn sich Wände kreuzen
- Zeichenfläche (SVG): Löcher, Rechtecke (mit Eckenradius), Langlöcher und Lochraster (gerade oder
  versetzt) setzen, ziehen, drehen, mittig ausrichten
- **Bauteil-Vorlagen**: Buchsen, Taster, Schalter, Displays, Lüfter und Platinen-Bohrbilder
  (Raspberry Pi, Pi Zero, Pico) – als Ganzes verschieben/drehen, auf die Gegenseite spiegeln,
  in Einzellöcher auflösen. Maße sind Richtwerte
- Maße wie in Fusion: Maßlinie oder Zahl anklicken, Wert eintippen – auch für die Boxmaße
  und die Zwischenwand-Positionen
- **3D-Vorschau** (WebGL, ohne Bibliothek): drehen, zoomen, Explosionsansicht, Deckel ausblenden;
  ein Klick auf ein Teil markiert es in 2D und 3D. Umschalter 2D / 2D+3D / 3D oben rechts
- **3D-Modell (STL)** laden (auch per Drag & Drop), in 90°-Schritten drehen, in der Box platzieren,
  „Box ans Modell anpassen“; Warnung, wenn es aus dem Innenraum ragt oder an eine Zwischenwand stößt.
  Im Zuschnitt wirft das Modell einen **Schatten** auf jedes Teil (dunkel = nah an der Platte) – dort
  Löcher und Ausschnitte setzen.
  Die STL wird nicht in die JSON gespeichert (nur Name und Lage), der Browser merkt sich die letzte (IndexedDB)
- Rückgängig/Wiederholen, Speichern/Laden (JSON), automatische Sicherung im Browser
- **SVG-Export** in Millimetern, nur Schnittlinien, Farbe/Stärke einstellbar
- Desktop-Version: als App installieren (PWA), Offline-`.html`, oder native Pakete

## Starten

```bash
bash web/start_web.sh          # http://localhost:8000 (oder der nächste freie Port)
```

Reines statisches Hosting genügt: den Inhalt von `web/static/` hochladen
(inkl. der versteckten `.htaccess`). Nach Änderungen die `?v=N` in `index.html` hochzählen.

## Desktop

```bash
pip install -r desktop/requirements.txt
python3 desktop/boxlab_desktop.py     # eigenes Fenster (ohne pywebview: Browser)
./desktop/build_desktop.sh            # .app/.dmg bzw. Linux-Paket (auf dem jeweiligen System bauen)
desktop\build_desktop.bat             # Windows
```

Fertige Pakete landen in `web/static/downloads/` (`Boxlab.dmg`, `Boxlab-windows.zip`,
`Boxlab-linux-x86_64.tar.gz`) und erscheinen dann im Dialog „Desktop-Version“.
Alternativ `GITHUB_REPO` oben im Desktop-Abschnitt von `boxlab.js` setzen.

## Aufbau

| Datei | Inhalt |
|---|---|
| `web/static/geometry.js` | Teile, Fingerzinken, Zwischenwände, Lage der Teile in der Box (ohne Browser-Abhängigkeit) |
| `web/static/features.js` | Ausschnitte und Bauteil-Vorlagen → Kreise/Rechtecke (ohne Browser-Abhängigkeit) |
| `web/static/stl.js` | STL lesen (binär/ASCII), 90°-Drehungen, Schnitt mit Ebenen, Schatten als Tiefenbild (ohne Browser-Abhängigkeit) |
| `web/static/view3d.js` | 3D-Vorschau (WebGL) |
| `web/static/boxlab.js` | Modell, Oberfläche, SVG-Ansicht, Export |
| `test/geometry.test.js` | 3D-Test: keine Überlappung, keine Lücken – setzt die Teile mit derselben `place()` zusammen wie die 3D-Vorschau (`node test/geometry.test.js`) |
| `test/features.test.js` | Vorlagen ohne Überschneidungen, Drehen/Spiegeln, Lochraster (`node test/features.test.js`) |
| `test/stl.test.js` | STL binär und ASCII, Drehungen, Schnitt mit Zwischenwand-Ebenen (`node test/stl.test.js`) |

## Konstruktion

Vorder-/Rückwand sind außen voll breit; Seitenwände sitzen dazwischen. Boden und Deckel liegen innen
und greifen mit Zinken in die Wände. Zwischenwände stecken mit Zapfen in Schlitzen von Wänden und Boden
(oben bleibt bei geschlossenen Boxen ein Spalt zum Deckel). Der Test prüft das alles voxelweise.

Bewegliche Deckel: Beim **Schiebedeckel** ist die Vorderwand niedriger, der Deckel läuft in Schlitzen durch
beide Seitenwände (außen bündig) und hat hinten eine schmalere Zunge bis zur Rückwand; über dem Schlitz
bleibt ein Steg von 2t. Beim **Klappdeckel** sitzt die Drehachse in der Mitte der Deckeldicke, um
t·√2/2 + Spiel vor der Rückwand – so schwenkt die Hinterkante frei. Der Test zieht den Schiebedeckel
heraus und klappt den Klappdeckel bis 90° auf und prüft dabei auf Kollisionen.
