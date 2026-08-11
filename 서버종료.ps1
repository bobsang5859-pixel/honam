# 병원 공급 관리 서버 종료 — 포트 4900(server) / 5173(vite client) 점유 프로세스 일괄 종료
$ports = @(4900, 5173)
$found = $false

foreach ($port in $ports) {
    $procIds = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
               Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $procIds) {
        try {
            $proc = Get-Process -Id $procId -ErrorAction Stop
            Write-Host ("  - PID " + $procId + " (" + $proc.ProcessName + ") 종료 [port " + $port + "]")
            Stop-Process -Id $procId -Force -ErrorAction Stop
            $found = $true
        } catch {
            Write-Host ("  ! PID " + $procId + " 종료 실패: " + $_.Exception.Message)
        }
    }
}

if (-not $found) {
    Write-Host "  실행 중인 서버가 없습니다."
}
