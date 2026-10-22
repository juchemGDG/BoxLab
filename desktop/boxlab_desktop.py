"""Boxlab als Desktop-App.

Startet die Web-Oberfläche (web/static) über einen lokalen Server und zeigt sie
in einem eigenen Fenster (pywebview). Ist pywebview nicht installiert, öffnet
sich stattdessen der Standardbrowser.

    python3 desktop/boxlab_desktop.py
"""

import os
import sys
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


def resource_dir():
    """Ordner mit index.html – im Quellbaum und im PyInstaller-Paket."""
    if getattr(sys, "frozen", False):
        return os.path.join(sys._MEIPASS, "static")
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "static")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def start_server():
    handler = partial(QuietHandler, directory=resource_dir())
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)   # freier Port
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/index.html"


def main():
    server, url = start_server()
    try:
        import webview
    except ImportError:
        print(f"pywebview nicht installiert – öffne {url} im Browser (Strg+C beendet).")
        webbrowser.open(url)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass
        return

    try:
        webview.settings["ALLOW_DOWNLOADS"] = True       # Speichern/SVG-Export als Download
    except Exception:
        pass
    webview.create_window("Boxlab", url, width=1360, height=860, min_size=(900, 600))
    webview.start()
    server.shutdown()


if __name__ == "__main__":
    main()
