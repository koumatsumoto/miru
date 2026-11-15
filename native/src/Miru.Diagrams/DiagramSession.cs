namespace Miru.Diagrams;

public sealed record DiagramBatch(long Version, IReadOnlyDictionary<string, DiagramResult> Diagrams);

/// <summary>One window's latest-only, serial render queue. No filesystem or UI authority.</summary>
public sealed class DiagramSession : IDisposable
{
    public const int MaximumDiagrams = 4;
    public const int MaximumBatchPixels = 8_000_000;
    public const int MaximumBatchBytes = 4 * 1024 * 1024;
    public const string LimitMessage = "This document exceeds the four-diagram / image budget. Read the remaining Mermaid source.";
    private readonly object sync = new();
    private readonly SemaphoreSlim serial = new(1);
    private readonly Func<string, bool, CancellationToken, Task<DiagramResult>> renderer;
    private CancellationTokenSource? current;
    private long version;
    private bool disposed;

    public DiagramSession() : this(MermaidDiagram.RenderAsync) { }
    internal DiagramSession(Func<string, bool, CancellationToken, Task<DiagramResult>> renderer) => this.renderer = renderer;

    public bool IsCurrent(long value) { lock (sync) return !disposed && version == value; }
    public void Invalidate()
    {
        lock (sync) { version++; current?.Cancel(); }
    }
    public void Dispose()
    {
        lock (sync) { disposed = true; version++; current?.Cancel(); }
        // Each operation owns/disposes its CTS; pending native work may still hold
        // the semaphore, so it must not be disposed underneath that operation.
    }

    public async Task<DiagramBatch> RenderLatestAsync(IReadOnlyList<string> sources, bool dark, CancellationToken token = default)
    {
        ArgumentNullException.ThrowIfNull(sources);
        CancellationTokenSource request;
        long ticket;
        lock (sync)
        {
            token.ThrowIfCancellationRequested();
            ObjectDisposedException.ThrowIf(disposed, this);
            current?.Cancel();
            current = request = CancellationTokenSource.CreateLinkedTokenSource(token);
            ticket = ++version;
        }
        var entered = false;
        try
        {
            // Cancelling a superseded waiter removes it before the next request
            // waits: only the active render and latest requested view may survive.
            await serial.WaitAsync(request.Token).ConfigureAwait(false);
            entered = true;
            var result = new Dictionary<string, DiagramResult>(StringComparer.Ordinal);
            long pixels = 0; long bytes = 0;
            foreach (var source in sources.Take(400).Distinct(StringComparer.Ordinal).Take(MaximumDiagrams))
            {
                request.Token.ThrowIfCancellationRequested();
                var image = await renderer(source, dark, request.Token).ConfigureAwait(false);
                request.Token.ThrowIfCancellationRequested();
                if (image.Png is { } png)
                {
                    if (image.Width <= 0 || image.Height <= 0 || image.Width > 4096 || image.Height > 4096 ||
                        (long)image.Width * image.Height > MermaidDiagram.MaximumPixels || png.Length > 2 * 1024 * 1024 ||
                        pixels + (long)image.Width * image.Height > MaximumBatchPixels || bytes + png.Length > MaximumBatchBytes)
                        image = new(null, 0, 0, LimitMessage);
                    else { pixels += (long)image.Width * image.Height; bytes += png.Length; }
                }
                result.Add(source, image);
            }
            request.Token.ThrowIfCancellationRequested();
            return new(ticket, result);
        }
        finally
        {
            if (entered) serial.Release();
            lock (sync) if (ReferenceEquals(current, request)) current = null;
            request.Dispose();
        }
    }
}
