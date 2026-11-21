using Miru.Diagrams;

internal static class SessionCases
{
    internal static async Task<int> Run(Action<bool, string> check)
    {
        var count = 0;
        async Task Test(string name, Func<Task> body) { await body(); count++; Console.WriteLine("PASS " + name); }
        async Task Cancelled(Task task)
        {
            try { await task; throw new Exception("Expected cancellation"); }
            catch (OperationCanceledException) { check(true, "cancelled"); }
        }
        await Test("latest-only session keeps one active render and cancels obsolete waiter", async () =>
        {
            var held = new TaskCompletionSource<DiagramResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            var calls = new List<string>();
            using var session = new DiagramSession(async (source, _, _) =>
            {
                calls.Add(source);
                return source == "A" ? await held.Task : new([1], 1, 1, null);
            });
            var first = session.RenderLatestAsync(["A"], false);
            var second = session.RenderLatestAsync(["B"], false);
            var third = session.RenderLatestAsync(["C"], true);
            held.SetResult(new([1], 1, 1, null));
            await Cancelled(first); await Cancelled(second);
            var result = await third;
            check(calls.SequenceEqual(new[] { "A", "C" }), "obsolete B did not render");
            check(session.IsCurrent(result.Version), "latest ticket valid");
            session.Invalidate();
            check(!session.IsCurrent(result.Version), "navigation invalidates completed result");
        });
        await Test("already cancelled old task cannot invalidate a newer result", async () =>
        {
            using var session = new DiagramSession((_, _, _) => Task.FromResult(new DiagramResult([1], 1, 1, null)));
            var good = await session.RenderLatestAsync(["new"], false);
            using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
            await Cancelled(session.RenderLatestAsync(["old"], false, cancelled.Token));
            check(session.IsCurrent(good.Version), "cancelled old callback did not supersede new state");
        });
        await Test("session deduplicates and limits generation to four unique sources", async () =>
        {
            var calls = 0;
            using var session = new DiagramSession((_, _, _) => { calls++; return Task.FromResult(new DiagramResult([1], 1, 1, null)); });
            var batch = await session.RenderLatestAsync(["A", "A", "B", "C", "D", "E", "F"], false);
            check(calls == 4 && batch.Diagrams.Count == 4 && !batch.Diagrams.ContainsKey("E"), "four unique previews only");
        });
        await Test("per-document decoded pixel and retained PNG byte budgets fall back", async () =>
        {
            using var pixels = new DiagramSession((_, _, _) => Task.FromResult(new DiagramResult([1], 2000, 2000, null)));
            var p = await pixels.RenderLatestAsync(["A", "B", "C", "D"], false);
            check(p.Diagrams.Values.Count(x => x.CanPreview) == 2 && p.Diagrams["C"].Error == DiagramSession.LimitMessage, "8m pixel batch budget");
            using var bytes = new DiagramSession((_, _, _) => Task.FromResult(new DiagramResult(new byte[2 * 1024 * 1024], 1, 1, null)));
            var b = await bytes.RenderLatestAsync(["A", "B", "C"], false);
            check(b.Diagrams.Values.Count(x => x.CanPreview) == 2 && b.Diagrams["C"].Error == DiagramSession.LimitMessage, "4MiB PNG batch budget");
        });
        await Test("close cancels active request without disposing its held semaphore", async () =>
        {
            var held = new TaskCompletionSource<DiagramResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            var session = new DiagramSession((_, _, _) => held.Task);
            var task = session.RenderLatestAsync(["active"], false);
            session.Dispose(); held.SetResult(new([1], 1, 1, null));
            await Cancelled(task);
            try { await session.RenderLatestAsync(["later"], false); throw new Exception("Disposed session accepted work"); }
            catch (ObjectDisposedException) { check(true, "disposed"); }
            check(!session.IsCurrent(1), "closed session never current");
        });
        return count;
    }
}
