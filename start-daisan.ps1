# start-daisan.ps1 — bring up Daisan Fast: engine (Anthropic Messages API) + Cloudflare tunnel.
# Run after a reboot to restore https://agent.daisan.ai. Idempotent: skips anything already up.
$ErrorActionPreference = 'SilentlyContinue'
$agent = 'C:\Users\Admin\Daisan.ai_2026\daisan-agent'

# 1) Engine on :8787 (reads .env for ANTHROPIC_API_KEY).
$onPort = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if (-not $onPort) {
    Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory $agent -WindowStyle Hidden
    Write-Host 'Engine started on :8787'
} else {
    Write-Host 'Engine already running on :8787'
}

# 2) Named tunnel daisan-agent -> agent.daisan.ai (uses ~/.cloudflared/config.yml).
$cf = Get-Process cloudflared -ErrorAction SilentlyContinue
if (-not $cf) {
    Start-Process -FilePath 'cloudflared' -ArgumentList 'tunnel run daisan-agent' -WindowStyle Hidden
    Write-Host 'Tunnel started'
} else {
    Write-Host 'Tunnel already running'
}

Start-Sleep -Seconds 5
try {
    $h = Invoke-RestMethod -Uri 'https://agent.daisan.ai/health' -TimeoutSec 15
    Write-Host ("Health: ok={0} hasKey={1}" -f $h.ok, $h.hasKey)
} catch {
    Write-Host 'Health check not ready yet — wait a few seconds and re-check https://agent.daisan.ai/health'
}
