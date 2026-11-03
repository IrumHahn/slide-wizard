@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 없어요. https://nodejs.org 에서 LTS를 설치한 뒤 다시 눌러 주세요.
  pause
  exit /b 1
)
start "" http://localhost:4900/
node server.mjs
pause
