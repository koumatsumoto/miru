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
$raster = Join-Path $dir "$japanese image.png"
$pdf = Join-Path $dir "$japanese document.pdf"
$expectedTitle = "MIRU $([char]0x00B7) $dir"
$window = $null
$stderrTask = $null
$started = Get-Date
$clock = [Diagnostics.Stopwatch]::StartNew()

function Find-NamedElement($Root, [string] $Name, $Kind = $null) {
    $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty, $Name)
    $condition = if ($null -eq $Kind) { $nameCondition } else {
        $typeCondition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $Kind)
        [System.Windows.Automation.AndCondition]::new($nameCondition, $typeCondition)
    }
    $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Open-Preview([string] $Path, [string[]] $ImageNames, [string[]] $Captions) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
    $pathBox = Find-NamedElement $root 'Local path' ([System.Windows.Automation.ControlType]::Edit)
    $open = Find-NamedElement $root 'Open' ([System.Windows.Automation.ControlType]::Button)
    if ($null -eq $pathBox -or $null -eq $open) { throw 'The path input or Open button is missing.' }
    $pathBox.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Path)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $open.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    while ($clock.Elapsed.TotalSeconds -lt 15) {
        $window.Refresh()
        if ($window.HasExited) { throw "WinUI exited while opening $Path : $($window.ExitCode)." }
        foreach ($name in $ImageNames) {
            # Match a real image with a layout rectangle, not a same-named
            # Explorer entry or an empty preview panel.
            $image = Find-NamedElement $root $name ([System.Windows.Automation.ControlType]::Image)
            if ($null -eq $image -or $image.Current.IsOffscreen) { continue }
            $bounds = $image.Current.BoundingRectangle
            if ($bounds.Width -le 0 -or $bounds.Height -le 0) { continue }
            foreach ($caption in $Captions) {
                if ($null -ne (Find-NamedElement $root $caption)) {
                    Write-Host "PASS: in-app image and caption for $([IO.Path]::GetExtension($Path)) in $($clock.ElapsedMilliseconds) ms."
                    return
                }
            }
        }
        Start-Sleep -Milliseconds 200
    }
    throw "No visible image and matching caption for $Path within 15s."
}

try {
    [void][IO.Directory]::CreateDirectory($dir)
    Copy-Item -LiteralPath $fixture -Destination $target
    Copy-Item -LiteralPath "$PSScriptRoot/Miru.Pdf.Windows.Tests/Fixtures/two-pages.pdf" -Destination $pdf
    # 96 x 48 solid-color RGB PNG. No download or test-only app hook.
    [IO.File]::WriteAllBytes($raster, [Convert]::FromBase64String(
        'iVBORw0KGgoAAAANSUhEUgAAAGAAAAAwCAIAAABhdOiYAAAAVUlEQVR42u3QQQkAAAgEsAt3aU1pA//CYAmWaTlEgSBBggQJEiRIEIIECRIkSJAgQQgSJEiQIEGCBCFIkCBBggQJEiQIQYIECRIkSJAgBAkSJEjQDwvsp4U8OsXnTAAAAABJRU5ErkJggg=='))
    $hashes = @{}
    foreach ($file in @($target, $raster, $pdf)) { $hashes[$file] = (Get-FileHash -LiteralPath $file).Hash }
    # Fixed executable and a single quoted, absolute path (not interpreted by a shell).
    $start = [Diagnostics.ProcessStartInfo]::new($exe, ('"{0}"' -f $target))
    $start.UseShellExecute = $false
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['MIRU_CI_TRACE_STARTUP'] = '1'
    $window = [Diagnostics.Process]::Start($start)
    $stderrTask = $window.StandardError.ReadToEndAsync()
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
    $dot = [char]0x00B7
    Open-Preview $raster @([IO.Path]::GetFileName($raster)) @("96 $([char]0x00D7) 48 pixels $dot read only")
    $pdfName = [IO.Path]::GetFileName($pdf)
    Open-Preview $pdf @($pdfName, "$pdfName, page 1") @(
        "PDF $dot page 1 of 2 $dot first-page preview", "PDF $dot page 1 of 2")
    if (-not $window.CloseMainWindow() -or -not $window.WaitForExit(10000)) {
        throw 'WinUI did not close normally within 10s.'
    }
    if ($window.ExitCode -ne 0) { throw "WinUI closed with exit code $($window.ExitCode)." }
    foreach ($file in $hashes.Keys) {
        if ((Get-FileHash -LiteralPath $file).Hash -ne $hashes[$file]) { throw "The viewed fixture changed: $file." }
    }
    Write-Host "PASS: packaged WinUI opened a Japanese/space path and exposed rendered Markdown in $openMs ms; normal close and all fixtures unchanged."
}
catch {
    # Keep the original failure. Report only this disposable run's process and
    # package, not a crash dump or the runner's environment.
    try {
        if ($null -ne $window -and -not $window.HasExited) {
            $window.Kill(); [void]$window.WaitForExit(5000)
        }
        if ($null -ne $stderrTask -and $stderrTask.Wait(2500)) {
            $trace = $stderrTask.Result
            if ($trace) { Write-Host ($trace.Substring(0, [Math]::Min(8000, $trace.Length))) }
            else { Write-Host 'No managed startup phase was written to stderr.' }
        }
        foreach ($base in @($Package, "$PSScriptRoot/../src/Miru.App/bin")) {
            $base = (Get-Item -LiteralPath $base).FullName
            $files = @(Get-ChildItem -LiteralPath $base -Recurse -File | Where-Object {
                $_.Extension -eq '.xbf' -or $_.Name -eq 'resources.pri' -or $_.Name -like 'Miru*.pri'
            } | Select-Object -First 30 | ForEach-Object { $_.FullName.Substring($base.Length + 1) })
            Write-Host "App PRI/XBF under ${base}: $($files -join ', ')"
        }
        $events = @(Get-WinEvent -FilterHashtable @{
            LogName = 'Application'; StartTime = $started; Id = 1000,1001,1026
        } -ErrorAction SilentlyContinue | Where-Object { $_.Message -like '*Miru.App.exe*' } | Select-Object -First 3)
        foreach ($event in $events) {
            $message = $event.Message
            Write-Host "Windows event $($event.Id): $($message.Substring(0, [Math]::Min(3500, $message.Length)))"
        }
    }
    catch { Write-Host "Additional Windows startup diagnostics unavailable: $($_.Exception.Message)" }
    throw
}
finally {
    if ($null -ne $window) {
        if (-not $window.HasExited) { $window.Kill(); [void]$window.WaitForExit(5000) }
        $window.Dispose()
    }
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Force -Recurse }
}
