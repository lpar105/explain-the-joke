@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -WindowStyle Hidden -Command "$sorterPath = Join-Path (Get-Location) 'server.mjs'; Start-Process -FilePath 'node.exe' -ArgumentList ([char]34 + $sorterPath + [char]34 + ' --open') -WindowStyle Hidden"
