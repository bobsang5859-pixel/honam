@echo off
chcp 65001 > nul
title 병원 공급 관리 서버 - 종료

echo.
echo ========================================
echo  병원 소모품 관리 시스템 - 서버 종료
echo ========================================
echo.

REM PowerShell로 포트 4900 / 5173 점유 프로세스를 찾아 종료
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0\서버종료.ps1"

echo.
echo  종료 완료. 이 창은 3초 후 닫힙니다.
echo ========================================
timeout /t 3 > nul
