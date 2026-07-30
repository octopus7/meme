using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

namespace Meme.Origin.Tests;

public sealed class HttpContractTests : IDisposable
{
    private const string Token = "0123456789abcdef0123456789abcdef";
    private readonly string root = Path.Combine(Path.GetTempPath(), $"meme-origin-dotnet-http-{Guid.NewGuid():N}");
    private readonly WebApplicationFactory<Program> factory;
    private readonly HttpClient client;

    public HttpContractTests()
    {
        factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.UseSetting("DATA_DIR", Path.Combine(root, "data"));
            builder.UseSetting("LOG_DIR", Path.Combine(root, "logs"));
            builder.UseSetting("MUTATION_TOKEN", Token);
            builder.UseSetting("LISTEN_URL", "http://127.0.0.1:8087");
        });
        client = factory.CreateClient();
    }

    [Fact]
    public async Task HealthUploadRangeAndTrashFollowNodeContract()
    {
        var health = await client.GetAsync("/healthz", TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, health.StatusCode);

        using var unauthorizedBody = new ByteArrayContent(await PngAsync());
        var unauthorized = await client.PostAsync("/internal/v1/blobs", unauthorizedBody,
            TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Unauthorized, unauthorized.StatusCode);
        var accessLog = Directory.GetFiles(Path.Combine(root, "logs"), "access-*.log").Single();
        Assert.Contains("\"status\":401", await File.ReadAllTextAsync(accessLog,
            TestContext.Current.CancellationToken));

        using var upload = new HttpRequestMessage(HttpMethod.Post, "/internal/v1/blobs");
        upload.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        upload.Content = new ByteArrayContent(await PngAsync());
        upload.Content.Headers.ContentType = new MediaTypeHeaderValue("image/png");
        var response = await client.SendAsync(upload, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var blob = await response.Content.ReadFromJsonAsync<BlobResponse>(TestContext.Current.CancellationToken);
        Assert.NotNull(blob);
        Assert.Matches("^[a-f0-9]{64}$", blob.Hash);
        Assert.Equal("png", blob.Extension);
        Assert.Equal("image/png", blob.MimeType);
        Assert.False(blob.Deduplicated);

        using var rangeRequest = new HttpRequestMessage(HttpMethod.Get, $"/i/{blob.Hash}.png");
        rangeRequest.Headers.Range = new RangeHeaderValue(0, 9);
        var range = await client.SendAsync(rangeRequest, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.PartialContent, range.StatusCode);
        Assert.Equal(10, (await range.Content.ReadAsByteArrayAsync(TestContext.Current.CancellationToken)).Length);
        Assert.NotNull(range.Headers.ETag);
        Assert.Contains("bytes", range.Headers.AcceptRanges);

        using var conditional = new HttpRequestMessage(HttpMethod.Get, $"/i/{blob.Hash}.png");
        conditional.Headers.IfNoneMatch.Add(range.Headers.ETag);
        var notModified = await client.SendAsync(conditional, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.NotModified, notModified.StatusCode);

        using var dateConditional = new HttpRequestMessage(HttpMethod.Get, $"/i/{blob.Hash}.png");
        dateConditional.Headers.IfModifiedSince = range.Content.Headers.LastModified;
        var dateNotModified = await client.SendAsync(dateConditional, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.NotModified, dateNotModified.StatusCode);

        using var head = new HttpRequestMessage(HttpMethod.Head, $"/i/{blob.Hash}.png");
        var headResponse = await client.SendAsync(head, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, headResponse.StatusCode);
        Assert.Equal(blob.Size, headResponse.Content.Headers.ContentLength);
        Assert.Empty(await headResponse.Content.ReadAsByteArrayAsync(TestContext.Current.CancellationToken));

        var thumbnail = await client.GetAsync($"/t/{blob.Hash}", TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, thumbnail.StatusCode);
        Assert.Equal("image/webp", thumbnail.Content.Headers.ContentType?.MediaType);

        using var trash = new HttpRequestMessage(HttpMethod.Post, $"/internal/v1/blobs/{blob.Hash}/trash");
        trash.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        var trashed = await client.SendAsync(trash, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, trashed.StatusCode);
        var trashJson = await trashed.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        Assert.Contains("\"trashed_at\"", trashJson);
        Assert.Contains("\"purge_at\"", trashJson);

        var gone = await client.GetAsync($"/i/{blob.Hash}.png", TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
    }

    private static async Task<byte[]> PngAsync()
    {
        using var image = new Image<Rgba32>(32, 16, Color.CadetBlue);
        await using var stream = new MemoryStream();
        await image.SaveAsPngAsync(stream);
        return stream.ToArray();
    }

    public void Dispose()
    {
        client.Dispose();
        factory.Dispose();
        if (Directory.Exists(root)) Directory.Delete(root, true);
    }

    private sealed record BlobResponse(string Hash, string Extension, string MimeType, long Size, bool Deduplicated);
}
