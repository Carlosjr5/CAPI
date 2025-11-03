<#
  Helper script to build the React frontend (Vite) and copy the output into the repo `static/` folder
  so the FastAPI app can serve the production build directly.

  Usage (PowerShell):
    ./build_frontend_and_copy.ps1

  This script assumes Node and npm are installed and will run `npm ci` then `npm run build` inside
  the `frontend` folder, and then copy `dist/*` to `static/`.
#>
Set-StrictMode -Version Latest
Push-Location (Join-Path $PSScriptRoot 'frontend')
Write-Host 'Installing frontend dependencies (npm ci)'
npm ci
Write-Host 'Building frontend (npm run build)'
npm run build
Pop-Location

$dist = Join-Path $PSScriptRoot 'frontend' | Join-Path -ChildPath 'dist'
$static = Join-Path $PSScriptRoot 'static'
if(-Not (Test-Path $dist)){
  Write-Error "Frontend build output not found at $dist"
  exit 1
}

Write-Host "Copying built files from $dist to $static"
Remove-Item -Recurse -Force (Join-Path $static '*') -ErrorAction SilentlyContinue
Copy-Item -Path (Join-Path $dist '*') -Destination $static -Recurse
Write-Host 'Frontend build copied to static/'