@echo off
rem Encrypt API.txt into API.enc (run this after you change an API key, then push API.enc)
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt
  ".venv\Scripts\python.exe" keys.py lock
) else (
  python keys.py lock
)
pause
