using System.Security.Cryptography;
using System.Text;
using Microsoft.Net.Http.Headers;
using Meme.Origin;

var builder = WebApplication.CreateSlimBuilder(args);
builder.WebHost.UseUrls(builder.Configuration["LISTEN_URL"] ?? "http://127.0.0.1:8087");
var options = new OriginOptions
{
    DataDir = builder.Configuration["DATA_DIR"] ?? "/var/lib/meme-origin-dotnet",
    LogDir = builder.Configuration["LOG_DIR"] ?? "/var/log/meme-origin-dotnet",
    MutationToken = builder.Configuration["MUTATION_TOKEN"] ?? "",
    MaxUploadBytes = ParseLong("MAX_UPLOAD_BYTES", 25 * 1024 * 1024),
    MaxImagePixels = ParseInt("MAX_IMAGE_PIXELS", 50_000_000),
    TrashRetentionDays = ParseInt("TRASH_RETENTION_DAYS", 30),
    LogCompressionDays = ParseInt("LOG_COMPRESSION_DAYS", 30)
};
if (options.MutationToken.Length < 32)
    throw new InvalidOperationException("MUTATION_TOKEN must contain at least 32 characters.");
builder.Services.AddSingleton(options);
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<ImageStore>();
builder.Services.AddHostedService<MaintenanceService>();
var app = builder.Build();
app.Services.GetRequiredService<ImageStore>().Initialize();
app.UseMiddleware<AccessLogMiddleware>();
app.UseExceptionHandler(errorApp => errorApp.Run(async context =>
{
    var error = context.Features.Get<Microsoft.AspNetCore.Diagnostics.IExceptionHandlerFeature>()?.Error;
    context.Response.Headers.CacheControl = "no-store";
    (context.Response.StatusCode, var message) = error switch
    {
        UnauthorizedAccessException => (401, "unauthorized"),
        StoreException { Error: StoreError.NotFound } => (404, "not found"),
        StoreException { Error: StoreError.Trashed } => (409, "blob is in trash and requires administrator restore"),
        StoreException { Error: StoreError.Conflict } => (409, "blob state conflict"),
        StoreException { Error: StoreError.TooLarge or StoreError.Unsupported } store => (400, store.Message),
        _ => (500, "internal error")
    };
    if (context.Response.StatusCode == 401) context.Response.Headers.WWWAuthenticate = "Bearer";
    await context.Response.WriteAsJsonAsync(new { error = message });
}));
app.Use(async (context, next) =>
{
    context.Response.Headers.XContentTypeOptions = "nosniff";
    context.Response.Headers["Referrer-Policy"] = "no-referrer";
    if (context.Request.Path.StartsWithSegments("/i") || context.Request.Path.StartsWithSegments("/t"))
        context.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
    await next(context);
});

app.MapGet("/healthz", () => Results.Json(new { status = "ok" }));
app.MapMethods("/i/{hash}.{extension}", ["GET", "HEAD"], (string hash, string extension, ImageStore store) =>
    FileResult(store.ResolveOriginal(hash, extension), extension == "jpg" ? "image/jpeg" : $"image/{extension}", $"\"{hash}\""));
app.MapMethods("/t/{hash}", ["GET", "HEAD"], (string hash, ImageStore store) =>
    FileResult(store.ResolveThumbnail(hash), "image/webp", $"\"{hash}-thumb\""));
app.MapPost("/internal/v1/blobs", async (HttpContext context, ImageStore store, CancellationToken ct) =>
{
    Authorize(context, options.MutationToken);
    var result = await store.PutAsync(context.Request.Body, ct);
    return Results.Json(result, statusCode: StatusCodes.Status201Created);
});
app.MapPost("/internal/v1/blobs/{hash}/trash", async (string hash, HttpContext context, ImageStore store, CancellationToken ct) =>
{
    Authorize(context, options.MutationToken);
    return Results.Json(await store.TrashAsync(hash, ct));
});
app.MapPost("/internal/v1/blobs/{hash}/restore", async (string hash, HttpContext context, ImageStore store, CancellationToken ct) =>
{
    Authorize(context, options.MutationToken);
    return Results.Json(await store.RestoreAsync(hash, ct));
});
app.MapPost("/internal/v1/admin/purge", async (HttpContext context, ImageStore store, CancellationToken ct) =>
{
    Authorize(context, options.MutationToken);
    return Results.Json(new { purged = await store.PurgeExpiredAsync(ct) });
});
app.MapFallback(() => Results.Json(new { error = "not found" }, statusCode: StatusCodes.Status404NotFound));
app.Run();

static IResult FileResult(MediaFile media, string mime, string etag) =>
    Results.File(media.Path, mime, lastModified: media.LastModified, entityTag: new EntityTagHeaderValue(etag), enableRangeProcessing: true);

static void Authorize(HttpContext context, string expected)
{
    var value = context.Request.Headers.Authorization.ToString();
    var supplied = value.StartsWith("Bearer ", StringComparison.Ordinal) ? value[7..].Trim() : "";
    var left = Encoding.UTF8.GetBytes(supplied);
    var right = Encoding.UTF8.GetBytes(expected);
    if (left.Length != right.Length || !CryptographicOperations.FixedTimeEquals(left, right))
        throw new UnauthorizedAccessException();
}

int ParseInt(string key, int fallback) => int.TryParse(builder.Configuration[key], out var value) && value > 0 ? value : fallback;
long ParseLong(string key, long fallback) => long.TryParse(builder.Configuration[key], out var value) && value > 0 ? value : fallback;

public partial class Program;
