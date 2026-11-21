using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Miru.Core;
using Miru.Git;

// A known child process for finite cap/cancellation tests, never arbitrary shell code.
var helper = Array.IndexOf(args, "--miru-test-helper");
if (helper >= 0)
{
    if (args.Length > helper + 2) File.WriteAllText(args[helper + 2], Environment.ProcessId.ToString());
    switch (args[helper + 1])
    {
        case "stdout": Console.OpenStandardOutput().Write(new byte[GitCommand.OutputLimit + 1]); break;
        case "stderr": Console.OpenStandardError().Write(new byte[64 * 1024 + 1]); break;
        case "sleep": await Task.Delay(30_000); break;
    }
    return;
}

var root = Path.Combine(Environment.GetEnvironmentVariable("MIRU_TEST_TMPDIR") ?? Path.GetTempPath(), "miru-git-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
var originalGlobal = Environment.GetEnvironmentVariable("GIT_CONFIG_GLOBAL");
var originalSystem = Environment.GetEnvironmentVariable("GIT_CONFIG_NOSYSTEM");
Environment.SetEnvironmentVariable("GIT_CONFIG_GLOBAL", OperatingSystem.IsWindows() ? "NUL" : "/dev/null");
Environment.SetEnvironmentVariable("GIT_CONFIG_NOSYSTEM", "1");
var tests = 0;
var assertions = 0;
var skips = 0;
var watch = Stopwatch.StartNew();
try
{
    await Test("staged / unstaged / rename / delete / untracked / Japanese / subtree; index unchanged", async () =>
    {
        var repo = Repo(); var sub = Path.Combine(repo, "日本語 space"); Directory.CreateDirectory(sub);
        foreach (var name in new[] { "both.txt", "delete.txt", "old.txt" }) File.WriteAllText(Path.Combine(sub, name), "before\n");
        File.WriteAllText(Path.Combine(repo, "outside.txt"), "private\n"); Commit(repo);
        File.WriteAllText(Path.Combine(sub, "both.txt"), "staged\n"); Git(repo, "add", ".");
        File.WriteAllText(Path.Combine(sub, "both.txt"), "unstaged\n"); File.Delete(Path.Combine(sub, "delete.txt"));
        File.Move(Path.Combine(sub, "old.txt"), Path.Combine(sub, "new name.txt")); Git(repo, "add", "-A", "--", "日本語 space/old.txt", "日本語 space/new name.txt");
        File.WriteAllText(Path.Combine(sub, "new.txt"), "untracked\n"); File.WriteAllText(Path.Combine(repo, "outside.txt"), "not shown\n");
        var index = Path.Combine(repo, ".git", "index"); var before = File.ReadAllBytes(index); var time = File.GetLastWriteTimeUtc(index);
        var view = await GitRepository.OpenAsync(sub); var status = await view.RefreshAsync();
        Check(status.RootPath == repo && status.TopPath == sub, "fixed top/root");
        Check(!status.Changes.Any(c => c.RelativePath.Contains("outside")), "subtree only");
        var both = status.Changes.Single(c => c.RelativePath == "both.txt");
        Check(both.IsStaged && both.IsUnstaged && !both.IsConflict, "separate stages");
        Diff(await view.ReadDiffAsync(both.Id, GitStage.Staged), "before\n", "staged\n");
        Diff(await view.ReadDiffAsync(both.Id, GitStage.Unstaged), "staged\n", "unstaged\n");
        Diff(await view.ReadDiffAsync(status.Changes.Single(c => c.RelativePath == "delete.txt").Id, GitStage.Unstaged), "before\n", "");
        Diff(await view.ReadDiffAsync(status.Changes.Single(c => c.RelativePath == "new.txt").Id, GitStage.Unstaged), "", "untracked\n");
        var rename = status.Changes.Single(c => c.RelativePath == "new name.txt");
        Check(rename.OriginalRelativePath == "old.txt", "rename origin"); Diff(await view.ReadDiffAsync(rename.Id, GitStage.Staged), "before\n", "before\n");
        Check(File.ReadAllBytes(index).SequenceEqual(before) && File.GetLastWriteTimeUtc(index) == time, "index bytes/time unchanged");
        Check(!File.Exists(index + ".lock"), "no optional index lock");
        await view.RefreshAsync(); await Reject(() => view.ReadDiffAsync(both.Id, GitStage.Staged), "no longer");
    });
    await Test("unborn HEAD / binary / non-UTF8 / unknown id / wrong stage", async () =>
    {
        var repo = Repo(); File.WriteAllText(Path.Combine(repo, "first"), "first\n"); Git(repo, "add", ".");
        File.WriteAllBytes(Path.Combine(repo, "binary"), [0, 1, 2]); File.WriteAllBytes(Path.Combine(repo, "invalid"), [0xff, 0xfe, 0x01]);
        var view = await GitRepository.OpenAsync(repo); var status = await view.RefreshAsync();
        Diff(await view.ReadDiffAsync(status.Changes.Single(c => c.RelativePath == "first").Id, GitStage.Staged), "", "first\n");
        foreach (var name in new[] { "binary", "invalid" }) Check((await view.ReadDiffAsync(status.Changes.Single(c => c.RelativePath == name).Id, GitStage.Unstaged)).Binary, name);
        await Reject(() => view.ReadDiffAsync("invented", GitStage.Staged), "no longer");
        await Reject(() => view.ReadDiffAsync(status.Changes.Single(c => c.RelativePath == "binary").Id, GitStage.Staged), "selected stage");
    });
    await Test("Git-free / WSL UNC are explicit errors", async () =>
    {
        var folder = Path.Combine(root, "no-git"); Directory.CreateDirectory(folder);
        await Reject(() => GitRepository.OpenAsync(folder), "repository");
        await Reject(() => GitRepository.OpenAsync(@"\\wsl.localhost\Ubuntu\home\me\repo"), "not implemented");
        await Reject(() => GitRepository.OpenAsync(@"\\remote.invalid\repo"), "not implemented");
    });
    await Test("fsmonitor / textconv / external diff / hooks are never invoked", async () =>
    {
        var repo = Repo(); File.WriteAllText(Path.Combine(repo, "file"), "before\n"); Commit(repo);
        var marker = Path.Combine(repo, "executed"); var evil = "echo executed > '" + marker.Replace('\\', '/') + "'";
        foreach (var key in new[] { "core.fsmonitor", "diff.external", "diff.evil.textconv", "core.pager" }) Git(repo, "config", key, evil);
        File.WriteAllText(Path.Combine(repo, ".gitattributes"), "* diff=evil\n"); File.WriteAllText(Path.Combine(repo, "file"), "after\n");
        var view = await GitRepository.OpenAsync(repo); var status = await view.RefreshAsync();
        Diff(await view.ReadDiffAsync(status.Changes.Single(c => c.RelativePath == "file").Id, GitStage.Unstaged), "before\n", "after\n");
        Check(!File.Exists(marker), "no helper marker");
    });
    foreach (var filter in new[] { "clean", "process" })
        await Test("reject configured " + filter + " before status", async () =>
        {
            var repo = Repo(); File.WriteAllText(Path.Combine(repo, "file"), "before\n"); Commit(repo);
            var index = File.ReadAllBytes(Path.Combine(repo, ".git", "index"));
            var marker = Path.Combine(repo, "executed"); Git(repo, "config", "filter.evil." + filter, "echo executed > '" + marker.Replace('\\', '/') + "'");
            File.WriteAllText(Path.Combine(repo, ".gitattributes"), "* filter=evil\n"); File.WriteAllText(Path.Combine(repo, "file"), "change\n");
            await Reject(() => GitRepository.OpenAsync(repo), "External Git filters");
            Check(!File.Exists(marker) && File.ReadAllBytes(Path.Combine(repo, ".git", "index")).SequenceEqual(index), "filter refused, index retained");
        });
    await Test("global filter / include / post-refresh filter fail closed", async () =>
    {
        var repo = Repo(); File.WriteAllText(Path.Combine(repo, "file"), "before"); Commit(repo); File.WriteAllText(Path.Combine(repo, "file"), "after");
        var global = Path.Combine(root, "global-config"); File.WriteAllText(global, "[filter \"unused\"]\n clean = must-not-execute\n");
        Environment.SetEnvironmentVariable("GIT_CONFIG_GLOBAL", global);
        try { await Reject(() => GitRepository.OpenAsync(repo), "External Git filters"); }
        finally { Environment.SetEnvironmentVariable("GIT_CONFIG_GLOBAL", OperatingSystem.IsWindows() ? "NUL" : "/dev/null"); }
        Git(repo, "config", "include.path", Path.Combine(root, "must-not-be-required-config"));
        await Reject(() => GitRepository.OpenAsync(repo), "included configuration"); Git(repo, "config", "--unset", "include.path");
        var view = await GitRepository.OpenAsync(repo); var entry = (await view.RefreshAsync()).Changes.Single();
        Git(repo, "config", "filter.evil.clean", "must-not-execute");
        await Reject(() => view.ReadDiffAsync(entry.Id, GitStage.Unstaged), "External Git filters");
        await Reject(() => view.RefreshAsync(), "External Git filters");
        Git(repo, "config", "--unset", "filter.evil.clean");
        await Reject(() => view.ReadDiffAsync(entry.Id, GitStage.Unstaged), "no longer");
    });
    await Test("submodule status does not execute a nested filter", async () =>
    {
        var repo = Repo(); var origin = Repo(); File.WriteAllText(Path.Combine(origin, "file"), "before"); Commit(origin);
        Git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", origin, "sub"); Commit(repo);
        var sub = Path.Combine(repo, "sub"); var marker = Path.Combine(repo, "executed");
        Git(sub, "config", "filter.evil.clean", "echo executed > '" + marker.Replace('\\', '/') + "'");
        File.WriteAllText(Path.Combine(sub, ".gitattributes"), "* filter=evil\n"); File.WriteAllText(Path.Combine(sub, "file"), "changed");
        Git(repo, "config", "status.submoduleSummary", "true");
        var view = await GitRepository.OpenAsync(repo); await view.RefreshAsync();
        Check(!File.Exists(marker), "no nested submodule helper");
    });
    await Test("custom metadata/settings paths are explicitly unsupported", async () =>
    {
        var repo = Repo();
        foreach (var key in new[] { "core.attributesFile", "core.excludesFile" })
        {
            Git(repo, "config", key, Path.Combine(root, "unused-custom-file"));
            await Reject(() => GitRepository.OpenAsync(repo), "custom worktree");
            Git(repo, "config", "--unset", key);
        }
        await Reject(() => Task.FromResult(GitPaths.RequireExisting(@"\\wsl.localhost\Ubuntu\metadata")), "not implemented");
        await Reject(() => Task.FromResult(GitPaths.RequireExisting(@"\\remote.invalid\metadata")), "not implemented");
    });
    await Test("out-of-top rename origin is not disclosed", async () =>
    {
        var repo = Repo(); var sub = Path.Combine(repo, "visible"); Directory.CreateDirectory(sub);
        File.WriteAllText(Path.Combine(repo, "private.txt"), "common one\ncommon two\ncommon three\nPRIVATE SECRET\n"); Commit(repo);
        File.Move(Path.Combine(repo, "private.txt"), Path.Combine(sub, "moved.txt")); File.WriteAllText(Path.Combine(sub, "moved.txt"), "common one\ncommon two\ncommon three\npublic current\n"); Git(repo, "add", "-A");
        var view = await GitRepository.OpenAsync(sub); var entry = (await view.RefreshAsync()).Changes.Single();
        var diff = await view.ReadDiffAsync(entry.Id, GitStage.Staged); Check(diff.Before == "" && !diff.After.Contains("PRIVATE SECRET") && diff.After.Contains("public current"), "no original outside top");
    });
    foreach (var (kind, mode) in new[] { ("symlink", "120000"), ("submodule", "160000") })
        await Test(kind == "symlink" ? "staged symlink modes are refused on both comparison sides"
            : "submodule changes are omitted; a type change from gitlink is not a text diff", async () =>
        {
            // Synthetic index entries need no OS symlink privilege or nested checkout.
            // Exercise both raw metadata paths: index first, then HEAD after a commit.
            var repo = Repo(); File.WriteAllText(Path.Combine(repo, "base"), "base\n"); Commit(repo);
            var oid = mode == "120000"
                ? GitInput(repo, "../outside-not-opened", "hash-object", "-w", "--stdin").Trim()
                : Git(repo, "rev-parse", "HEAD").Trim();
            Git(repo, "update-index", "--add", "--cacheinfo", $"{mode},{oid},entry");
            var view = await GitRepository.OpenAsync(repo);
            var index = Path.Combine(repo, ".git", "index"); var before = File.ReadAllBytes(index);
            var status = await view.RefreshAsync();
            if (mode == "120000")
            {
                var staged = status.Changes.Single(c => c.RelativePath == "entry");
                Check(staged.IsStaged, "special index entry is staged");
                await Reject(() => view.ReadDiffAsync(staged.Id, GitStage.Staged), "Only ordinary file blobs");
            }
            else Check(status.Changes.Count == 0, "staged gitlink addition is omitted by ignore-submodules=all");
            Check(File.ReadAllBytes(index).SequenceEqual(before), "special index mode read made no index change");

            Git(repo, "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "synthetic special entry");
            if (mode == "160000")
            {
                var changedCommit = Git(repo, "rev-parse", "HEAD").Trim();
                Git(repo, "update-index", "--cacheinfo", $"160000,{changedCommit},entry");
                Check((await view.RefreshAsync()).Changes.Count == 0, "staged gitlink commit change is omitted");
                Git(repo, "update-index", "--force-remove", "entry");
                Check((await view.RefreshAsync()).Changes.Count == 0, "staged gitlink deletion is omitted");
                Git(repo, "update-index", "--add", "--cacheinfo", $"160000,{oid},entry");
            }
            var ordinary = GitInput(repo, "ordinary text\n", "hash-object", "-w", "--stdin").Trim();
            Git(repo, "update-index", "--cacheinfo", $"100644,{ordinary},entry");
            before = File.ReadAllBytes(index);
            var change = (await view.RefreshAsync()).Changes.Single(c => c.RelativePath == "entry");
            Check(change.IsStaged, "special HEAD to ordinary index is staged");
            await Reject(() => view.ReadDiffAsync(change.Id, GitStage.Staged), "Only ordinary file blobs");
            Check(File.ReadAllBytes(index).SequenceEqual(before), "special HEAD mode read made no index change");
        });
    await Test("linked worktree metadata stays local and is readable", async () =>
    {
        var repo = Repo(); File.WriteAllText(Path.Combine(repo, "file"), "before"); Commit(repo);
        var worktree = Path.Combine(root, "linked-worktree"); Git(repo, "worktree", "add", "--quiet", "-b", "other", worktree);
        File.WriteAllText(Path.Combine(worktree, "file"), "after");
        var view = await GitRepository.OpenAsync(worktree); var entry = (await view.RefreshAsync()).Changes.Single();
        Diff(await view.ReadDiffAsync(entry.Id, GitStage.Unstaged), "before", "after");
    });
    await Test("alternate objects / linked metadata / symlink working files refused", async () =>
    {
        var repo = Repo(); File.WriteAllText(Path.Combine(repo, "file"), "before"); Commit(repo); File.WriteAllText(Path.Combine(repo, "file"), "after");
        var view = await GitRepository.OpenAsync(repo); var entry = (await view.RefreshAsync()).Changes.Single();
        var alternates = Path.Combine(repo, ".git", "objects", "info", "alternates"); File.WriteAllText(alternates, "//not-opened.invalid/objects\n");
        await Reject(() => view.RefreshAsync(), "Alternate Git"); File.Delete(alternates);
        var foreign = Path.Combine(root, "foreign"); Directory.CreateDirectory(foreign); File.WriteAllText(Path.Combine(foreign, "secret"), "not disclosed");
        var link = Path.Combine(repo, "probe-link");
        if (!TryLink(link, Path.Combine(foreign, "secret"))) { skips++; Console.WriteLine("SKIP symlink checks: privilege unavailable"); return; }
        File.Delete(link); var fresh = (await view.RefreshAsync()).Changes.Single();
        File.Delete(Path.Combine(repo, "file")); File.CreateSymbolicLink(Path.Combine(repo, "file"), Path.Combine(foreign, "secret"));
        await Reject(() => view.ReadDiffAsync(fresh.Id, GitStage.Unstaged), "Links");
        var bad = Path.Combine(root, "linked-git"); Directory.CreateDirectory(bad); Directory.CreateSymbolicLink(Path.Combine(bad, ".git"), Path.Combine(repo, ".git"));
        await Reject(() => GitRepository.OpenAsync(bad), "Links");
    });
    foreach (var kind in new[] { "loose-object", "ref", "pack", "objects-info" })
        await Test("static " + kind + " metadata link refused before Git", async () =>
        {
            var repo = Repo(); File.WriteAllText(Path.Combine(repo, "file"), "before"); Commit(repo); File.WriteAllText(Path.Combine(repo, "file"), "after");
            var outside = Path.Combine(root, "outside-" + Guid.NewGuid().ToString("N"));
            File.WriteAllText(outside, "outside metadata");
            var probe = Path.Combine(repo, "probe-link");
            if (!TryLink(probe, outside)) { skips++; Console.WriteLine("SKIP metadata link: privilege unavailable"); return; }
            File.Delete(probe);
            string path;
            if (kind == "loose-object")
            {
                var oid = Git(repo, "rev-parse", "HEAD:file").Trim(); path = Path.Combine(repo, ".git", "objects", oid[..2], oid[2..]);
                File.Delete(outside); File.Move(path, outside); File.CreateSymbolicLink(path, outside);
            }
            else if (kind == "ref")
            {
                path = Path.Combine(repo, ".git", Git(repo, "symbolic-ref", "HEAD").Trim().Replace('/', Path.DirectorySeparatorChar));
                File.Delete(outside); File.Move(path, outside); File.CreateSymbolicLink(path, outside);
            }
            else if (kind == "pack")
            {
                path = Path.Combine(repo, ".git", "objects", "pack", "fixture.pack"); File.CreateSymbolicLink(path, outside);
            }
            else
            {
                path = Path.Combine(repo, ".git", "objects", "info"); Directory.Delete(path); File.Delete(outside); Directory.CreateDirectory(outside);
                File.WriteAllText(Path.Combine(outside, "alternates"), "must not be inspected first"); Directory.CreateSymbolicLink(path, outside);
            }
            await Reject(() => GitRepository.OpenAsync(repo), "inside Git metadata");
            Check((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0, "fixture link remains unchanged");
        });
    await Test("metadata scan is finite and cancellation-aware", async () =>
    {
        var dir = Path.Combine(root, "scan-budget"); Directory.CreateDirectory(dir);
        for (var i = 0; i < 4; i++) File.WriteAllText(Path.Combine(dir, i.ToString()), "x");
        await Reject(() => { GitPaths.ValidateMetadataTrees([dir], default, entryLimit: 3); return Task.CompletedTask; }, "scan limit");
        using var cancel = new CancellationTokenSource(); cancel.Cancel();
        try { GitPaths.ValidateMetadataTrees([dir], cancel.Token); throw new Exception("scan did not cancel"); }
        catch (OperationCanceledException) { assertions++; }
    });
    await Test("default global config, attributes and ignore links refused before Git", async () =>
    {
        var home = Path.Combine(root, "profile"); var xdg = Path.Combine(home, ".config"); Directory.CreateDirectory(Path.Combine(xdg, "git"));
        var outside = Path.Combine(root, "profile-original"); File.WriteAllText(outside, "[user]\n name = local fixture\n");
        var global = Environment.GetEnvironmentVariable("GIT_CONFIG_GLOBAL"); var oldHome = Environment.GetEnvironmentVariable("HOME"); var oldXdg = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
        var link = Path.Combine(home, ".gitconfig");
        if (!TryLink(link, outside)) { skips++; Console.WriteLine("SKIP global config link: privilege unavailable"); return; }
        try
        {
            Environment.SetEnvironmentVariable("GIT_CONFIG_GLOBAL", null); Environment.SetEnvironmentVariable("HOME", home); Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", xdg);
            await Reject(() => Task.FromResult(GitCommand.BuildStartInfo("absolute-git", root, ["status"])), "Links");
            File.Delete(link);
            foreach (var name in new[] { "attributes", "ignore" })
            {
                var extra = Path.Combine(xdg, "git", name); File.CreateSymbolicLink(extra, outside);
                await Reject(() => Task.FromResult(GitCommand.BuildStartInfo("absolute-git", root, ["status"])), "Links");
                File.Delete(extra);
            }
        }
        finally { Environment.SetEnvironmentVariable("GIT_CONFIG_GLOBAL", global); Environment.SetEnvironmentVariable("HOME", oldHome); Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", oldXdg); }
    });
    await Test("large worktree / blob do not present truncated diffs", async () =>
    {
        var repo = Repo(); File.WriteAllText(Path.Combine(repo, "file"), "before"); Commit(repo);
        File.WriteAllText(Path.Combine(repo, "file"), new string('a', GitCommand.OutputLimit + 1));
        var view = await GitRepository.OpenAsync(repo); var entry = (await view.RefreshAsync()).Changes.Single();
        await Reject(() => view.ReadDiffAsync(entry.Id, GitStage.Unstaged), "2 MiB");
        Git(repo, "add", "file"); var staged = (await view.RefreshAsync()).Changes.Single();
        await Reject(() => view.ReadDiffAsync(staged.Id, GitStage.Staged), "output exceeded");
    });
    await Test("missing object does not become an empty diff or lazy-fetch", async () =>
    {
        var origin = Repo(); File.WriteAllText(Path.Combine(origin, "file.txt"), "synthetic local fixture\n"); Commit(origin); Git(origin, "config", "uploadpack.allowFilter", "true");
        var clone = Path.Combine(root, "partial-clone"); Git(origin, "-c", "protocol.file.allow=always", "clone", "--quiet", "--filter=blob:none", "--no-checkout", new Uri(origin + Path.DirectorySeparatorChar).AbsoluteUri, clone);
        var oid = Git(origin, "rev-parse", "HEAD:file.txt").Trim();
        Check(Git(clone, "rev-list", "--objects", "--all", "--missing=print").Contains("?" + oid), "missing before");
        var pack = Path.Combine(clone, ".git", "objects", "pack"); var before = HashDirectory(pack);
        var view = await GitRepository.OpenAsync(clone); var entry = (await view.RefreshAsync()).Changes.Single(c => c.RelativePath == "file.txt");
        await Reject(() => view.ReadDiffAsync(entry.Id, GitStage.Staged), "missing or damaged");
        Check(Git(clone, "rev-list", "--objects", "--all", "--missing=print").Contains("?" + oid), "missing after");
        Check(HashDirectory(pack) == before, "object store unchanged, no lazy fetch");
    });
    await Test("damaged HEAD is not an unborn empty side", async () =>
    {
        var repo = Repo(); File.WriteAllText(Path.Combine(repo, "file"), "before"); Commit(repo); File.WriteAllText(Path.Combine(repo, "file"), "staged"); Git(repo, "add", ".");
        var view = await GitRepository.OpenAsync(repo); var entry = (await view.RefreshAsync()).Changes.Single();
        var reference = Git(repo, "symbolic-ref", "HEAD").Trim(); File.WriteAllText(Path.Combine(repo, ".git", reference.Replace('/', Path.DirectorySeparatorChar)), new string('a', 40) + "\n");
        await Reject(() => view.ReadDiffAsync(entry.Id, GitStage.Staged), "Git could not");
    });
    await Test("unresolved entries return a message, not guessed merged content", async () =>
    {
        var repo = Repo(); File.WriteAllText(Path.Combine(repo, "file"), "base"); Commit(repo);
        var oid = Git(repo, "rev-parse", "HEAD:file").Trim(); GitInput(repo, $"0 {new string('0', 40)}\tfile\n100644 {oid} 1\tfile\n100644 {oid} 2\tfile\n100644 {oid} 3\tfile\n", "update-index", "--index-info");
        var view = await GitRepository.OpenAsync(repo); var entry = (await view.RefreshAsync()).Changes.Single();
        Check(entry.IsConflict, "conflict status"); Check((await view.ReadDiffAsync(entry.Id, GitStage.Staged)).Message?.Contains("unresolved conflicts") == true, "conflict message");
    });
    if (!OperatingSystem.IsWindows())
        await Test("literal Git pathspec filename", async () =>
        {
            var repo = Repo(); var name = ":(glob)*.txt"; File.WriteAllText(Path.Combine(repo, name), "before"); Commit(repo); File.WriteAllText(Path.Combine(repo, name), "after");
            var view = await GitRepository.OpenAsync(repo); var entry = (await view.RefreshAsync()).Changes.Single();
            Diff(await view.ReadDiffAsync(entry.Id, GitStage.Unstaged), "before", "after");
        });
    await Test("sanitized environment / argv / no shell", () =>
    {
        var old = Environment.GetEnvironmentVariable("GIT_DIR"); var trace = Environment.GetEnvironmentVariable("GIT_TRACE");
        Environment.SetEnvironmentVariable("GIT_DIR", "attacker-repo"); Environment.SetEnvironmentVariable("GIT_TRACE", "attacker-output");
        try
        {
            var info = GitCommand.BuildStartInfo("absolute-git", root, ["status", "--", "space name & literal"]);
            Check(!info.UseShellExecute && info.RedirectStandardInput, "no shell, no prompt input");
            Check(!info.Environment.ContainsKey("GIT_DIR") && !info.Environment.ContainsKey("GIT_TRACE"), "no inherited repository/trace");
            Check(info.Environment["GIT_ALLOW_PROTOCOL"] == "" && info.Environment["GIT_NO_LAZY_FETCH"] == "1", "transport/lazy fetch disabled");
            Check(info.ArgumentList.Contains("--no-lazy-fetch") && info.ArgumentList.Contains("--literal-pathspecs") && info.ArgumentList.Last() == "space name & literal", "fixed flags/literal argv");
        }
        finally { Environment.SetEnvironmentVariable("GIT_DIR", old); Environment.SetEnvironmentVariable("GIT_TRACE", trace); }
        return Task.CompletedTask;
    });
    var self = Path.Combine(AppContext.BaseDirectory, "Miru.Git.Tests" + (OperatingSystem.IsWindows() ? ".exe" : ""));
    foreach (var channel in new[] { "stdout", "stderr" })
        await Test(channel + " cap kills known child", async () =>
        {
            var pid = Path.Combine(root, channel + ".pid");
            await Reject(() => new GitCommand(self).RunAsync(root, ["--miru-test-helper", channel, pid], default), "output exceeded");
            CheckChildStopped(pid);
        });
    await Test("cancellation kills known child", async () =>
    {
        using var cancel = new CancellationTokenSource(); var pid = Path.Combine(root, "cancel.pid");
        var pending = new GitCommand(self).RunAsync(root, ["--miru-test-helper", "sleep", pid], cancel.Token);
        for (var i = 0; i < 100 && !File.Exists(pid); i++) await Task.Delay(10);
        cancel.Cancel();
        try { await pending; throw new Exception("cancellation not honored"); }
        catch (OperationCanceledException) { assertions++; }
        CheckChildStopped(pid);
    });
    await Test("deadline kills known child", async () =>
    {
        var pid = Path.Combine(root, "deadline.pid");
        await Reject(() => new GitCommand(self).RunAsync(root, ["--miru-test-helper", "sleep", pid], default), "6-second");
        CheckChildStopped(pid);
    });
    await Test("fixture cleanup removes readonly files without changing link targets", () =>
    {
        var cleanup = Path.Combine(root, "cleanup"); Directory.CreateDirectory(cleanup);
        var file = Path.Combine(cleanup, "readonly"); File.WriteAllText(file, "owned fixture");
        File.SetAttributes(file, File.GetAttributes(file) | FileAttributes.ReadOnly);
        var target = Path.Combine(root, "cleanup-target"); File.WriteAllText(target, "keep target");
        File.SetAttributes(target, File.GetAttributes(target) | FileAttributes.ReadOnly);
        var targetAttributes = File.GetAttributes(target);
        if (!TryLink(Path.Combine(cleanup, "link"), target)) { skips++; Console.WriteLine("SKIP cleanup file link creation unavailable"); }
        var targetDirectory = Path.Combine(root, "cleanup-target-directory"); Directory.CreateDirectory(targetDirectory);
        var nestedTarget = Path.Combine(targetDirectory, "readonly"); File.WriteAllText(nestedTarget, "keep nested target");
        File.SetAttributes(nestedTarget, File.GetAttributes(nestedTarget) | FileAttributes.ReadOnly);
        var nestedAttributes = File.GetAttributes(nestedTarget);
        if (!TryLink(Path.Combine(cleanup, "directory-link"), targetDirectory, directory: true)) { skips++; Console.WriteLine("SKIP cleanup directory link creation unavailable"); }
        DeleteFixture(cleanup);
        Check(!Directory.Exists(cleanup), "readonly fixture deleted");
        Check(File.ReadAllText(target) == "keep target" && File.GetAttributes(target) == targetAttributes, "link target bytes/attributes unchanged");
        Check(File.ReadAllText(nestedTarget) == "keep nested target" && File.GetAttributes(nestedTarget) == nestedAttributes, "directory link target bytes/attributes unchanged");
        return Task.CompletedTask;
    });
}
finally
{
    Environment.SetEnvironmentVariable("GIT_CONFIG_GLOBAL", originalGlobal);
    Environment.SetEnvironmentVariable("GIT_CONFIG_NOSYSTEM", originalSystem);
    DeleteFixture(root);
}
Console.WriteLine($"PASS {tests} finite scenarios / {assertions} assertions / {skips} explicit skips; {watch.ElapsedMilliseconds} ms. Synthetic local Git only; no Windows GUI or WSL Git acceptance.");

void DeleteFixture(string path)
{
    // Only this invocation's generated files. Git for Windows may mark loose objects readonly.
    if (!LocalPaths.IsInside(root, Path.GetFullPath(path)) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
        throw new IOException("Refusing cleanup outside the generated fixture directory or through a link.");
    var options = new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint, IgnoreInaccessible = false };
    foreach (var file in new DirectoryInfo(path).EnumerateFiles("*", options))
        if ((file.Attributes & FileAttributes.ReadOnly) != 0) file.Attributes &= ~FileAttributes.ReadOnly;
    Directory.Delete(path, recursive: true); // Directory.Delete removes links themselves, not their targets.
}

async Task Test(string name, Func<Task> body) { await body(); tests++; Console.WriteLine("PASS " + name); }
void Check(bool value, string name) { if (!value) throw new Exception("FAIL " + name); assertions++; }
void Diff(GitDiff diff, string before, string after) => Check(!diff.Binary && diff.Before == before && diff.After == after, "diff contents");
async Task Reject(Func<Task> body, string text)
{
    try { await body(); throw new Exception("Expected rejection containing: " + text); }
    catch (IOException ex) { Check(ex.Message.Contains(text, StringComparison.OrdinalIgnoreCase), "rejection: " + ex.Message); }
}
string Repo()
{
    var path = Path.Combine(root, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(path); Git(path, "init", "--quiet"); Git(path, "config", "user.name", "Synthetic test"); Git(path, "config", "user.email", "fixture@example.invalid"); return path;
}
void Commit(string path) { Git(path, "--literal-pathspecs", "add", "."); Git(path, "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "synthetic fixture"); }
string Git(string directory, params string[] arguments) => GitInput(directory, null, arguments);
string GitInput(string directory, string? input, params string[] arguments)
{
    var info = new ProcessStartInfo(OperatingSystem.IsWindows() ? "git.exe" : "git") { WorkingDirectory = directory, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true, CreateNoWindow = true };
    info.Environment["GIT_CONFIG_COUNT"] = "0"; info.Environment["GIT_TERMINAL_PROMPT"] = "0";
    foreach (var arg in arguments) info.ArgumentList.Add(arg);
    using var process = Process.Start(info) ?? throw new Exception("Fixture Git failed to start");
    if (input is not null) process.StandardInput.Write(input); process.StandardInput.Close();
    var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
    if (!process.WaitForExit(10_000)) { process.Kill(true); throw new Exception("Fixture Git timeout"); }
    Task.WaitAll(output, error);
    if (process.ExitCode != 0) throw new Exception("Fixture Git failed: " + error.Result);
    return output.Result;
}
bool TryLink(string path, string target, bool directory = false)
{
    try
    {
        if (directory) Directory.CreateSymbolicLink(path, target); else File.CreateSymbolicLink(path, target);
        return true;
    }
    catch (UnauthorizedAccessException) when (OperatingSystem.IsWindows()) { return false; }
    catch (IOException) when (OperatingSystem.IsWindows()) { return false; }
}
string HashDirectory(string path) => string.Join("|", Directory.GetFiles(path).Order().Select(p => Path.GetFileName(p) + ":" + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(p)))));

void CheckChildStopped(string file)
{
    Check(File.Exists(file), "known child did start");
    var pid = int.Parse(File.ReadAllText(file));
    try { using var process = Process.GetProcessById(pid); Check(process.HasExited, "known child is not running"); }
    catch (ArgumentException) { assertions++; }
}
