using System.IO.Compression;
using System.Text;
using Meme.Origin;

namespace Meme.Origin.Tests;

public sealed class AccessLogTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"meme-origin-dotnet-log-{Guid.NewGuid():N}");

    [Fact]
    public async Task CompressesOnlyLogsOlderThanThirtyFullDays()
    {
        Directory.CreateDirectory(root);
        var now = new DateTimeOffset(2026, 1, 31, 12, 0, 0, TimeSpan.Zero);
        var old = Path.Combine(root, "access-2025-12-31.log");
        var boundary = Path.Combine(root, "access-2026-01-01.log");
        var recent = Path.Combine(root, "access-2026-01-02.log");
        foreach (var log in new[] { old, boundary, recent })
            await File.WriteAllTextAsync(log, "{\"status\":200}\n", TestContext.Current.CancellationToken);
        var options = new OriginOptions { LogDir = root, LogCompressionDays = 30 };

        await AccessLogMiddleware.CompressOldAsync(options, new FixedTimeProvider(now),
            TestContext.Current.CancellationToken);

        Assert.False(File.Exists(old));
        Assert.True(File.Exists(boundary));
        Assert.True(File.Exists(recent));
        var compressed = old + ".gz";
        Assert.True(File.Exists(compressed));
        await using var input = File.OpenRead(compressed);
        await using var gzip = new GZipStream(input, CompressionMode.Decompress);
        using var reader = new StreamReader(gzip, Encoding.UTF8);
        Assert.Equal("{\"status\":200}\n", await reader.ReadToEndAsync(TestContext.Current.CancellationToken));
    }

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, true);
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
