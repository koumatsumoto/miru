using System.Diagnostics;
using System.Text;
using Miru.Core;
using Miru.Cli;

var tests = new List<(string Name, Action Body)>();
void Test(string name, Action body) => tests.Add((name, body));
void Check(bool value, string message = "assertion failed") { if (!value) throw new Exception(message); }
void Equal<T>(T actual, T expected) => Check(EqualityComparer<T>.Default.Equals(actual, expected), $"Expected {expected}, got {actual}");
void Throws(Action action)
{
    try { action(); }
    catch (Exception error) when (error is IOException or ArgumentException or UnauthorizedAccessException or OperationCanceledException) { return; }
    throw new Exception("Expected rejection");
}

var tempBase = Environment.GetEnvironmentVariable("MIRU_TEST_TMPDIR") ?? Path.GetTempPath();
Directory.CreateDirectory(tempBase);
var root = Path.Combine(tempBase, "miru-core-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
var home = Path.Combine(root, "home");
var folder = Path.Combine(home, "日本語 project's #1");
var outside = Path.Combine(root, "outside");
Directory.CreateDirectory(folder);
Directory.CreateDirectory(outside);
Directory.CreateDirectory(Path.Combine(folder, "nested"));
Directory.CreateDirectory(Path.Combine(folder, ".git"));
Directory.CreateDirectory(Path.Combine(folder, "node_modules"));
File.WriteAllText(Path.Combine(folder, "hello.txt"), "Hello 日本語\n");
File.WriteAllText(Path.Combine(folder, "diff"), "literal");
File.WriteAllText(Path.Combine(folder, "nested", "nested-report.txt"), "Nested");
File.WriteAllText(Path.Combine(folder, ".git", "hidden-report.txt"), "Git metadata");
File.WriteAllText(Path.Combine(folder, "node_modules", "hidden-report.txt"), "dependency");
File.WriteAllText(Path.Combine(outside, "secret.txt"), "not selected");

ViewerSession Session()
{
    var s = new ViewerSession(home);
    s.OpenPath(folder);
    return s;
}
ViewerEntry Entry(ViewerSession s, string name) => s.List().Entries.Single(e => e.Name == name);

Test("default CLI opens HOME launcher", () =>
{
    var request = LaunchArguments.Parse([], folder, home);
    Equal(request.TargetPath, home); Check(request.IsLauncher); Equal(request.Mode, ViewerMode.File);
});
Test("relative path resolves against explicit cwd", () => Equal(LaunchArguments.Parse(["hello.txt"], folder, home).TargetPath, Path.Combine(folder, "hello.txt")));
Test("diff is a mode, literal -- diff is a file", () =>
{
    Equal(LaunchArguments.Parse(["diff"], folder, home).Mode, ViewerMode.Repository);
    Equal(LaunchArguments.Parse(["--", "diff"], folder, home).TargetPath, Path.Combine(folder, "diff"));
});
Test("reject extra/unknown CLI args", () =>
{
    Throws(() => LaunchArguments.Parse(["a", "b"], folder, home));
    Throws(() => LaunchArguments.Parse(["--bogus"], folder, home));
});
Test("forwarding round trip is exact argv, no shell", () =>
{
    var request = LaunchArguments.Parse(["hello.txt"], folder, home);
    var process = GuiLauncher.BuildStartInfo("C:\\program files\\MIRU\\Miru.App.exe", request);
    Check(!process.UseShellExecute); Equal(process.Arguments, "");
    Equal(LaunchArguments.Parse(process.ArgumentList.ToArray(), folder, home), request);
});
Test("reject malformed forwarded args", () =>
{
    Throws(() => LaunchArguments.Parse(["--target", "relative", "--home", home, "--mode", "file", "--launcher", "false"], folder, home));
    Throws(() => LaunchArguments.Parse(["--target", folder, "--home", home, "--mode", "bad", "--launcher", "false"], folder, home));
});

foreach (var path in new[] { @"C:\Users\日本語\report's #1%.txt", @"D:\", @"\\wsl.localhost\Ubuntu\home\user\x.txt", @"\\wsl$\Ubuntu-24.04\home\user", "C:/Users/name/file.txt" })
    Test("accept Windows/WSL syntax " + path, () => Check(LocalPaths.ValidateWindowsPath(path).Length > 0));
foreach (var path in new[] { "", " ", "relative", @"C:relative", @"\rooted", @"\\server\share\secret", @"\\127.0.0.1\share\file", @"\\?\C:\file", @"\\.\pipe\name", @"C:\a:secret", @"C:\NUL", @"C:\CON.txt", @"C:\CONIN$", @"C:\CONOUT$", @"C:\NUL .txt", @"C:\LPT1.txt", @"C:\COM¹", @"C:\path.\file", @"C:\path \file", "C:\\bad\nfile", @"\\wsl.localhost\..\x", @"\\wsl.localhost\Ubuntu:stream\x", @"C:\wild*card" })
    Test("reject ambiguous/remote Windows syntax " + path.Replace('\n', ' '), () => Throws(() => LocalPaths.ValidateWindowsPath(path)));
Test("WSL parser preserves shell metacharacters as literal argv", () =>
{
    var path = @"\\wsl.localhost\Ubuntu\home\name\a' ; # $x.txt";
    Equal(WslPaths.ParseOutput(path + "\r\n"), path);
    Throws(() => WslPaths.ParseOutput(path + "\nmore\n"));
    Throws(() => WslPaths.ParseOutput(@"\\network\share\x" + "\n"));
});
if (OperatingSystem.IsWindows())
    Test("Windows CLI never guesses a POSIX root path", () =>
    {
        Throws(() => LaunchArguments.Parse(["/home/example/file.txt"], folder, home));
        Throws(() => LaunchArguments.Parse([@"\home\example\file.txt"], folder, home));
    });
Test("scope is separator-aware and conservative about case", () =>
{
    Check(LocalPaths.IsInside(folder, folder));
    Check(LocalPaths.IsInside(folder, Path.Combine(folder, "nested")));
    Check(!LocalPaths.IsInside(folder, folder + "-neighbor"));
    Check(!LocalPaths.IsInside(Path.Combine(root, "Case"), Path.Combine(root, "case", "secret")));
});

Test("ordinary tree includes .git and node_modules", () =>
{
    var listing = Session().List();
    Check(!listing.Truncated); Check(listing.Entries.Any(e => e.Name == ".git")); Check(listing.Entries.Any(e => e.Name == "node_modules"));
});
Test("read UTF8 is bounded, read-only, and selects the entry", () =>
{
    var s = Session(); var entry = Entry(s, "hello.txt");
    var before = File.ReadAllBytes(Path.Combine(folder, "hello.txt"));
    var file = s.Read(entry.Id); Equal(file.Text, "Hello 日本語\n"); Equal(file.Extension, ".txt");
    Check(file.Bytes.SequenceEqual(before)); Check(File.ReadAllBytes(Path.Combine(folder, "hello.txt")).SequenceEqual(before));
    Equal(s.SelectedEntry?.Id, entry.Id);
});
Test("file entry chooses parent and selected ID", () =>
{
    var s = new ViewerSession(home); s.OpenPath(Path.Combine(folder, "hello.txt"));
    Equal(s.RootPath, folder); Equal(s.Read(s.SelectedEntry!.Id).Text, "Hello 日本語\n");
});
Test("explicit outside HOME allowed, but only by explicit open", () =>
{
    var s = Session(); var id = Entry(s, "hello.txt").Id; s.OpenPath(outside);
    Equal(s.RootPath, outside); Throws(() => s.Read(id));
    Equal(s.Read(Entry(s, "secret.txt").Id).Text, "not selected");
});
Test("Top, Parent, HOME invalidate all old browse IDs", () =>
{
    var s = Session(); var old = Entry(s, "hello.txt").Id;
    s.SetTop(Entry(s, "nested").Id); Throws(() => s.Read(old));
    Equal(s.RootPath, Path.Combine(folder, "nested")); s.Parent(); Equal(s.RootPath, folder);
    old = Entry(s, "hello.txt").Id; s.OpenHome(); Check(s.IsLauncher); Equal(s.RootPath, home); Throws(() => s.Read(old));
});
Test("Refresh restores selected file under same root but changes IDs", () =>
{
    var s = Session(); var old = Entry(s, "hello.txt").Id; s.Read(old); s.Refresh();
    Equal(s.RootPath, folder); Check(s.SelectedEntry is not null); Check(s.SelectedEntry!.Id != old); Throws(() => s.Read(old));
});
Test("missing target does not discard existing valid scope", () =>
{
    var s = Session(); Throws(() => s.OpenPath(Path.Combine(root, "missing"))); Equal(s.RootPath, folder);
});
Test("unknown or raw-path IDs are rejected", () =>
{
    var s = Session(); Throws(() => s.Read(Path.Combine(folder, "hello.txt"))); Throws(() => s.List("fake-id")); Throws(() => s.SetTop(Entry(s, "hello.txt").Id));
});
Test("directory never becomes text content", () =>
{
    var s = Session(); Throws(() => s.Read(Entry(s, "nested").Id));
});
Test("UTF16 BOM and binary decoding", () =>
{
    File.WriteAllBytes(Path.Combine(folder, "utf16.txt"), [..Encoding.Unicode.GetPreamble(), ..Encoding.Unicode.GetBytes("日本語")]);
    File.WriteAllBytes(Path.Combine(folder, "binary.bin"), [0, 1, 2, 255]);
    var s = Session(); Equal(s.Read(Entry(s, "utf16.txt").Id).Text, "日本語"); Check(s.Read(Entry(s, "binary.bin").Id).Text is null);
});
Test("2 MiB accepted, larger rejected before allocation", () =>
{
    var path = Path.Combine(folder, "bounded.bin");
    using (var f = File.Create(path)) f.SetLength(ViewerSession.FileLimitBytes);
    var s = Session(); var id = Entry(s, "bounded.bin").Id; Equal(s.Read(id).Bytes.Length, ViewerSession.FileLimitBytes);
    using (var f = File.OpenWrite(path)) f.SetLength(ViewerSession.FileLimitBytes + 1);
    Throws(() => s.Read(id)); File.Delete(path);
});
Test("search is explicit, ignores metadata/dependencies and short queries invalidate IDs", () =>
{
    var s = Session(); var found = s.SearchHome("report.txt"); Equal(found.Entries.Count, 1); Check(!found.Truncated);
    Equal(found.Entries[0].Name, "nested-report.txt"); Equal(s.SearchHome("x").Entries.Count, 0); Throws(() => s.OpenSearch(found.Entries[0].Id));
});
Test("search result changes scope only when opened", () =>
{
    var s = Session(); var found = s.SearchHome("nested-report"); Equal(s.RootPath, folder);
    s.OpenSearch(found.Entries.Single().Id); Equal(s.RootPath, Path.Combine(folder, "nested")); Equal(s.Read(s.SelectedEntry!.Id).Text, "Nested");
});
Test("invalid query also revokes search IDs and cancellation is observed", () =>
{
    var s = Session(); var id = s.SearchHome("nested-report").Entries.Single().Id;
    Throws(() => s.SearchHome(new string('x', 257))); Throws(() => s.OpenSearch(id));
    using var cancel = new CancellationTokenSource(); cancel.Cancel(); Throws(() => s.SearchHome("report", cancel.Token));
});
Test("search result limit is finite and disclosed", () =>
{
    var many = Path.Combine(home, "many"); Directory.CreateDirectory(many);
    for (var i = 0; i < 105; i++) File.WriteAllText(Path.Combine(many, $"result-{i:000}.txt"), "x");
    var result = Session().SearchHome("result-"); Equal(result.Entries.Count, 100); Check(result.Truncated);
});

// On Windows, symbolic-link creation can require Developer Mode or privilege. A skip
// is printed instead of pretending that a syntactic test is filesystem acceptance.
var canSymlink = false;
var linkProbe = Path.Combine(root, "link-probe");
try { Directory.CreateSymbolicLink(linkProbe, outside); Directory.Delete(linkProbe); canSymlink = true; }
catch (Exception error) when (error is IOException or UnauthorizedAccessException) { Console.WriteLine("SKIP symlink filesystem tests: " + error.GetType().Name); }
if (canSymlink)
{
    Test("explicit links and linked ancestors are rejected", () =>
    {
        var link = Path.Combine(root, "escape-dir"); Directory.CreateSymbolicLink(link, outside);
        var s = Session(); Throws(() => s.OpenPath(link)); Throws(() => s.OpenPath(Path.Combine(link, "secret.txt"))); Equal(s.RootPath, folder);
    });
    Test("listed file replaced with escaping symlink is rejected", () =>
    {
        var path = Path.Combine(folder, "replace.txt"); File.WriteAllText(path, "original");
        var s = Session(); var id = Entry(s, "replace.txt").Id; File.Delete(path); File.CreateSymbolicLink(path, Path.Combine(outside, "secret.txt"));
        Throws(() => s.Read(id)); Check(Entry(s, "replace.txt").IsLink);
        File.Delete(path);
    });
    Test("search ancestor replacement cannot escape HOME", () =>
    {
        var child = Path.Combine(home, "swappable"); Directory.CreateDirectory(child); File.WriteAllText(Path.Combine(child, "secret.txt"), "safe");
        var s = Session(); var id = s.SearchHome("swappable/secret").Entries.Single().Id;
        Directory.Move(child, child + "-old"); Directory.CreateSymbolicLink(child, outside); Throws(() => s.OpenSearch(id)); Equal(s.RootPath, folder);
        Directory.Delete(child);
    });
}
if (OperatingSystem.IsLinux())
    Test("FIFO is rejected without waiting for a writer", () =>
    {
        var fifo = Path.Combine(folder, "pipe");
        var info = new ProcessStartInfo("/usr/bin/mkfifo") { UseShellExecute = false }; info.ArgumentList.Add(fifo);
        using var process = Process.Start(info)!; Check(process.WaitForExit(2000)); Equal(process.ExitCode, 0);
        var s = Session(); var watch = Stopwatch.StartNew(); Throws(() => s.Read(Entry(s, "pipe").Id)); Check(watch.ElapsedMilliseconds < 1000); File.Delete(fifo);
    });

var failed = 0;
var elapsed = Stopwatch.StartNew();
try
{
    foreach (var test in tests)
    {
        try { test.Body(); Console.WriteLine("PASS " + test.Name); }
        catch (Exception error) { failed++; Console.Error.WriteLine("FAIL " + test.Name + ": " + error); }
    }
}
finally { Directory.Delete(root, recursive: true); }
Console.WriteLine($"{tests.Count - failed}/{tests.Count} passed in {elapsed.ElapsedMilliseconds} ms; Windows/WSL launch and GUI require separate real-machine acceptance.");
return failed == 0 ? 0 : 1;
