@echo off
cd /d "%~dp0"
title Mashaal Rent a Car
where python >nul 2>nul
if errorlevel 1 (
  echo Python is not installed on this computer.
  echo Download it from https://www.python.org/downloads/
  pause
  exit /b
)
python app.py
pause
