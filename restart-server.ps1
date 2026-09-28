$backendRoot = $PSScriptRoot
$conns = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $backendRoot -WindowStyle Hidden
Start-Sleep -Seconds 6
curl.exe -s http://localhost:4000/api/health
Write-Output ""
curl.exe -s http://localhost:4000/api/clients
