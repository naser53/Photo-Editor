@echo off
setlocal
cd /d "%~dp0"
title PhotoEditor

rem --- 1. Find Python -------------------------------------------------------
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (
  echo [ERROR] Python was not found. Install it from https://www.python.org/downloads/
  echo         and tick "Add python.exe to PATH" during setup.
  pause & exit /b 1
)
echo Using: & %PY% --version

rem --- 2. Create a private environment the first time ----------------------
if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment in .venv ...
  %PY% -m venv .venv || (echo [ERROR] Could not create the virtual environment. & pause & exit /b 1)
)

rem --- 3. Install / check Flask and Pillow ---------------------------------
".venv\Scripts\python.exe" -c "import flask, PIL" >nul 2>nul
if errorlevel 1 (
  echo Installing Flask and Pillow ...
  ".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || (echo [ERROR] Package install failed. & pause & exit /b 1)
)
".venv\Scripts\python.exe" -c "from importlib.metadata import version as v; print('Flask', v('flask'), '| Pillow', v('pillow'))"

rem --- 4. Start the app and open the browser --------------------------------
start "" http://127.0.0.1:5000
".venv\Scripts\python.exe" app.py
pause
