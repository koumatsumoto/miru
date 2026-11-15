param([string] $Output = "$PSScriptRoot/../artifacts/miru-windows-x64")
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$outputPath = [IO.Path]::GetFullPath($Output)
dotnet publish "$root/src/Miru.App/Miru.App.csproj" -c Release -r win-x64 --self-contained true -p:Platform=x64 -o $outputPath
if ($LASTEXITCODE -ne 0) { throw "WinUI publish failed ($LASTEXITCODE)." }
dotnet publish "$root/src/Miru.Cli/Miru.Cli.csproj" -c Release -r win-x64 --self-contained true -o $outputPath
if ($LASTEXITCODE -ne 0) { throw "CLI publish failed ($LASTEXITCODE)." }
foreach ($file in @('Miru.App.exe', 'Miru.App.dll', 'miru.exe', 'miru.dll', 'Miru.Core.dll', 'Miru.Documents.dll', 'Markdig.dll', 'Miru.Diagrams.dll', 'Mermaider.dll', 'Sugiyama.dll', 'Svg.Skia.dll', 'Svg.Custom.dll', 'SkiaSharp.dll', 'libSkiaSharp.dll', 'libHarfBuzzSharp.dll')) {
    if (-not (Test-Path (Join-Path $outputPath $file) -PathType Leaf)) { throw "Missing output: $file" }
}
Copy-Item "$root/README.md" (Join-Path $outputPath 'README.md')
Copy-Item "$root/THIRD-PARTY-NOTICES.md" (Join-Path $outputPath 'THIRD-PARTY-NOTICES.md')
$diagramNotices = Join-Path $outputPath 'third_party/diagrams'
New-Item -ItemType Directory -Force -Path $diagramNotices | Out-Null
Copy-Item "$root/third_party/diagrams/*" $diagramNotices
foreach ($notice in Get-ChildItem "$root/third_party/diagrams" -File) {
    $copied = Join-Path $diagramNotices $notice.Name
    if ((Get-FileHash $notice.FullName).Hash -ne (Get-FileHash $copied).Hash) { throw "Notice copy mismatch: $($notice.Name)" }
}
Write-Host "Published folder: $outputPath"
Write-Host 'Copy the entire folder, not just Miru.App.exe. No installer, PATH or registry changes were made.'
