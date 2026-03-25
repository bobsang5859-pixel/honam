@echo off
chcp 65001 > nul
echo ============================================
echo   병원물품관리 시스템 - 초기 설정
echo ============================================
echo.

echo [1/4] 의존성 설치 중...
call npm install
if %errorlevel% neq 0 (
    echo 오류: npm install 실패
    pause
    exit /b 1
)

echo [2/4] Prisma 클라이언트 생성 중...
call npx prisma generate
if %errorlevel% neq 0 (
    echo 오류: prisma generate 실패
    pause
    exit /b 1
)

echo [3/4] 데이터베이스 마이그레이션 중...
call npx prisma db push
if %errorlevel% neq 0 (
    echo 오류: DB push 실패
    pause
    exit /b 1
)

echo [4/4] 초기 데이터 적재 중...
call npx ts-node prisma/seed.ts
if %errorlevel% neq 0 (
    echo 오류: seed 실패
    pause
    exit /b 1
)

echo.
echo ============================================
echo   설정 완료!
echo   실행: start.bat
echo ============================================
pause
