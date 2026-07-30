using System.IO.Compression;
using System.Globalization;
using System.Text.Json;

namespace Meme.Origin;

public sealed class AccessLogMiddleware(RequestDelegate next, OriginOptions options, TimeProvider timeProvider)
{
    private readonly SemaphoreSlim gate = new(1, 1);

    public async Task InvokeAsync(HttpContext context)
    {
        var started = timeProvider.GetTimestamp();
        try { await next(context); }
        finally
        {
            var entry = new
            {
                timestamp = timeProvider.GetUtcNow(),
                method = context.Request.Method,
                path = context.Request.Path.Value,
                status = context.Response.StatusCode,
                bytes = context.Response.ContentLength,
                elapsedMs = timeProvider.GetElapsedTime(started).TotalMilliseconds,
                remote = context.Connection.RemoteIpAddress?.ToString(),
                userAgent = context.Request.Headers.UserAgent.ToString()
            };
            await gate.WaitAsync(CancellationToken.None);
            try
            {
                Directory.CreateDirectory(options.LogDir);
                var path = Path.Combine(options.LogDir, $"access-{timeProvider.GetUtcNow():yyyy-MM-dd}.log");
                await File.AppendAllTextAsync(path, JsonSerializer.Serialize(entry) + "\n");
            }
            finally { gate.Release(); }
        }
    }

    public static async Task CompressOldAsync(OriginOptions options, TimeProvider timeProvider, CancellationToken ct)
    {
        Directory.CreateDirectory(options.LogDir);
        var cutoff = DateOnly.FromDateTime(timeProvider.GetUtcNow().UtcDateTime.AddDays(-options.LogCompressionDays));
        foreach (var path in Directory.EnumerateFiles(options.LogDir, "access-*.log"))
        {
            ct.ThrowIfCancellationRequested();
            var name = Path.GetFileName(path);
            if (name.Length != 21 ||
                !DateOnly.TryParseExact(name[7..17], "yyyy-MM-dd", CultureInfo.InvariantCulture,
                    DateTimeStyles.None, out var logDate) ||
                logDate >= cutoff) continue;
            var compressed = path + ".gz";
            if (File.Exists(compressed))
            {
                File.Delete(path);
                continue;
            }
            var temporary = compressed + $".tmp-{Guid.NewGuid():N}";
            try
            {
                await using (var input = File.OpenRead(path))
                await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    await using (var gzip = new GZipStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
                        await input.CopyToAsync(gzip, ct);
                    await output.FlushAsync(ct);
                    output.Flush(flushToDisk: true);
                }
                File.Move(temporary, compressed);
                File.Delete(path);
            }
            finally { File.Delete(temporary); }
        }
    }
}

public sealed class MaintenanceService(OriginOptions options, TimeProvider timeProvider, ImageStore store) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(24));
        do
        {
            await AccessLogMiddleware.CompressOldAsync(options, timeProvider, stoppingToken);
            await store.PurgeExpiredAsync(stoppingToken);
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
