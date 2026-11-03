param([string[]]$Versions = @('20.20.2', '22.23.4'))
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$evidence = Join-Path ([IO.Path]::GetTempPath()) ('runner-node-matrix-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $evidence | Out-Null
$results = @()
foreach ($version in $Versions) {
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid Node version' }
    $name = "node-v$version-win-x64"
    $archive = Join-Path $evidence "$name.zip"
    $base = "https://nodejs.org/dist/v$version"
    Invoke-WebRequest "$base/$name.zip" -OutFile $archive
    $checksums = (Invoke-WebRequest "$base/SHASUMS256.txt").Content
    $expected = (($checksums -split "`n" | Where-Object { $_.Trim().EndsWith(" $name.zip") }) -split '\s+')[0]
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if (!$expected -or $actual -ne $expected) { throw "Checksum mismatch: $name" }
    Expand-Archive -LiteralPath $archive -DestinationPath $evidence
    $runtime = Join-Path $evidence "$name/node.exe"
    $log = Join-Path $evidence "$name-verify.log"
    Push-Location $repo
    try { & $runtime scripts/verify.mjs *> $log; $code = $LASTEXITCODE } finally { Pop-Location }
    $results += [pscustomobject]@{version=(& $runtime --version); executable=$runtime; sha256=$actual; exitCode=$code; log=$log; classification='offline/full-suite/windows-x64'}
    $results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'acceptance.json')
    Write-Output "Node $version exit=$code evidence=$log"
}
if ($results.Where({$_.exitCode -ne 0}).Count) { exit 1 }
