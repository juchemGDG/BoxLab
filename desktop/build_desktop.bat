@echo off
rem Baut die Windows-App mit PyInstaller. Aufruf aus dem Projektordner: desktop\build_desktop.bat
cd /d "%~dp0\.."
python -m venv .build-venv
call .build-venv\Scripts\activate.bat
pip install --upgrade pip
pip install -r desktop\requirements.txt pyinstaller
pyinstaller desktop\boxlab_desktop.py --name Boxlab --windowed --noconfirm --add-data "web\static;static" --distpath build\dist --workpath build\work --specpath build
echo Fertig: build\dist\Boxlab\Boxlab.exe  (Ordner zippen oder mit Inno Setup einen Installer bauen)
