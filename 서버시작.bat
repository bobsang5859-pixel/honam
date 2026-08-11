@echo off
chcp 65001 > nul
title 병원 공급 관리 서버

echo.
echo ========================================
echo  병원 소모품 관리 시스템 - 서버 시작
echo ========================================
echo.

cd /d "%~dp0"

echo [1/2] 최신 코드로 빌드하는 중... (몇십 초 걸릴 수 있습니다)
call npm run build
if errorlevel 1 (
  echo.
  echo [오류] 빌드에 실패했습니다. 위 오류 메시지를 확인하세요.
  pause
  exit /b 1
)

echo.
echo [2/2] 서버를 시작합니다...
echo.
echo [접속 주소] 같은 네트워크에서 아래 주소로 접속하세요:
echo.
ipconfig | findstr "IPv4"
echo.
echo  위 IP 뒤에 :4900 을 붙여 브라우저에서 열어주세요.
echo  예: http://192.168.0.142:4900
echo.
echo 서버를 중지하려면 이 창을 닫으세요.
echo ========================================
echo.

node_modules\.bin\ts-node --transpile-only -P tsconfig.server.json src\server\index.ts

pause
