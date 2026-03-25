@echo off
chcp 65001 > nul
echo ============================================
echo   병원물품관리 시스템 - Windows 설치본 생성
echo ============================================
echo.

echo [1/3] 프로젝트 빌드 중...
call npm run build
if %errorlevel% neq 0 (
    echo 오류: 빌드 실패
    pause
    exit /b 1
)

echo [2/3] Electron 설치본 생성 중...
call npx electron-builder --win
if %errorlevel% neq 0 (
    echo 오류: electron-builder 실패
    pause
    exit /b 1
)

echo.
echo ============================================
echo   설치본이 release/ 폴더에 생성되었습니다.
echo ============================================
pause
