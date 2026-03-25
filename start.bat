@echo off
chcp 65001 > nul
echo ============================================
echo   병원물품관리 시스템 시작
echo ============================================
echo.
echo 서버와 클라이언트를 동시에 시작합니다.
echo 브라우저에서 http://localhost:5173 으로 접속하세요.
echo.
echo 관리자 계정: admin / admin1234
echo 병동 계정: ward2 / ward1234
echo.
call node_modules\.bin\concurrently "node_modules\.bin\ts-node --transpile-only --project tsconfig.electron.json src/server/index.ts" "node_modules\.bin\vite"
