param([string] $Output = "$PSScriptRoot/../artifacts/miru-windows-x64")
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$outputPath = [IO.Path]::GetFullPath($Output)
dotnet publish "$root/src/Miru.App/Miru.App.csproj" -c Release -r win-x64 --self-contained true -p:Platform=x64 -o $outputPath
if ($LASTEXITCODE -ne 0) { throw "WinUI publish failed ($LASTEXITCODE)." }
dotnet publish "$root/src/Miru.Cli/Miru.Cli.csproj" -c Release -r win-x64 --self-contained true -o $outputPath
if ($LASTEXITCODE -ne 0) { throw "CLI publish failed ($LASTEXITCODE)." }
foreach ($file in @('Miru.App.exe', 'Miru.App.dll', 'miru.exe', 'miru.dll', 'Miru.Core.dll', 'Miru.Documents.dll', 'Miru.Git.dll', 'Markdig.dll')) {
    if (-not (Test-Path (Join-Path $outputPath $file) -PathType Leaf)) { throw "Missing output: $file" }
}
Copy-Item "$root/README.md" (Join-Path $outputPath 'README.md')
Copy-Item "$root/THIRD-PARTY-NOTICES.md" (Join-Path $outputPath 'THIRD-PARTY-NOTICES.md')
Write-Host "Published folder: $outputPath"
Write-Host 'Copy the entire folder, not just Miru.App.exe. No installer, PATH or registry changes were made.'
