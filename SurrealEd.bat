@echo off
rem SurrealEd - inicia o editor / starts the editor
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (py -3 RiotEditor.py %*) else (python RiotEditor.py %*)
if errorlevel 1 pause
