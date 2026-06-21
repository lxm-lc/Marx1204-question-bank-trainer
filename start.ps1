$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8000
$url = "http://127.0.0.1:$port/"

Write-Host "Starting local server in: $projectRoot"
Write-Host "Open in browser: $url"

Start-Process $url
python "$projectRoot\\serve.py" --host 127.0.0.1 --port $port
