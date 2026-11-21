# Windows PowerShell uses the built-in .NET Framework UI Automation client.
# Real window and document checks; not pixel QA, WSL or a desktop UX test.
[CmdletBinding()]
param([string] $Package = "$PSScriptRoot/../artifacts/miru-windows-x64")
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$exe = (Get-Item -LiteralPath (Join-Path $Package 'Miru.App.exe')).FullName
$fixture = (Get-Item -LiteralPath (Join-Path $Package 'examples/native-smoke.md')).FullName
$temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
# Keep this script ASCII so that Windows PowerShell 5.1 reads it without a BOM.
$japanese = -join [char[]](0x65E5, 0x672C, 0x8A9E)
$dir = Join-Path $temp ("MIRU {0} {1}" -f $japanese, [Guid]::NewGuid().ToString('N'))
$target = Join-Path $dir "$japanese notes.md"
$expectedTitle = "MIRU $([char]0x00B7) $dir"
$window = $null
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
    [void][IO.Directory]::CreateDirectory($dir)
    Copy-Item -LiteralPath $fixture -Destination $target
    $hash = (Get-FileHash -LiteralPath $target).Hash
    # Fixed executable and a single quoted, absolute path (not interpreted by a shell).
    $window = Start-Process -FilePath $exe -ArgumentList ('"{0}"' -f $target) -PassThru
    $taskName = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty, 'Completed task')
    $seen = $false
    while ($clock.Elapsed.TotalSeconds -lt 45) {
        $window.Refresh()
        if ($window.HasExited) { throw "WinUI exited before opening the fixture: $($window.ExitCode)." }
        if ($window.MainWindowHandle -ne [IntPtr]::Zero -and $window.MainWindowTitle -eq $expectedTitle) {
            # Window.Title is the folder name. This marker comes from rendering the
            # fixture's checked Markdown task, not the tree, title or empty shell.
            $element = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
            if ($null -ne $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $taskName)) {
                $seen = $true
                break
            }
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $seen) { throw "No initialized window with the expected folder title and Markdown content within 45s. Last title: '$($window.MainWindowTitle)'." }
    $openMs = $clock.ElapsedMilliseconds
    if (-not $window.CloseMainWindow() -or -not $window.WaitForExit(10000)) {
        throw 'WinUI did not close normally within 10s.'
    }
    if ($window.ExitCode -ne 0) { throw "WinUI closed with exit code $($window.ExitCode)." }
    if ((Get-FileHash -LiteralPath $target).Hash -ne $hash) { throw 'The viewed fixture changed.' }
    Write-Host "PASS: packaged WinUI opened a Japanese/space path and exposed rendered Markdown in $openMs ms; normal close and unchanged fixture."
}
finally {
    if ($null -ne $window) {
        if (-not $window.HasExited) { $window.Kill(); [void]$window.WaitForExit(5000) }
        $window.Dispose()
    }
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Force -Recurse }
}
