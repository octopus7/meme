using Meme.Origin;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

namespace Meme.Origin.Tests;

public sealed class ImageStoreTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"meme-origin-dotnet-{Guid.NewGuid():N}");
    private readonly ImageStore store;

    public ImageStoreTests()
    {
        store = new ImageStore(new OriginOptions
        {
            DataDir = root,
            MutationToken = new string('x', 32),
            TrashRetentionDays = 30
        }, TimeProvider.System);
        store.Initialize();
    }

    [Fact]
    public async Task UploadDeduplicatesAndCreatesThumbnail()
    {
        var bytes = await PngAsync(320, 160);
        var first = await store.PutAsync(new MemoryStream(bytes), TestContext.Current.CancellationToken);
        var second = await store.PutAsync(new MemoryStream(bytes), TestContext.Current.CancellationToken);
        Assert.False(first.Deduplicated);
        Assert.True(second.Deduplicated);
        Assert.Equal(first.Hash, second.Hash);
        Assert.Equal("png", first.Extension);
        var thumbnail = store.ResolveThumbnail(first.Hash);
        using var image = await Image.LoadAsync(thumbnail.Path, TestContext.Current.CancellationToken);
        Assert.Equal(128, image.Width);
        Assert.Equal(128, image.Height);
    }

    [Fact]
    public async Task TrashMakesBlobUnavailableAndRestoreReturnsIt()
    {
        var uploaded = await store.PutAsync(new MemoryStream(await PngAsync(10, 10)), TestContext.Current.CancellationToken);
        await store.TrashAsync(uploaded.Hash, TestContext.Current.CancellationToken);
        Assert.Throws<StoreException>(() => store.ResolveOriginal(uploaded.Hash, "png"));
        await store.RestoreAsync(uploaded.Hash, TestContext.Current.CancellationToken);
        Assert.True(File.Exists(store.ResolveOriginal(uploaded.Hash, "png").Path));
    }

    [Fact]
    public async Task RejectsNonImage()
    {
        var error = await Assert.ThrowsAsync<StoreException>(() =>
            store.PutAsync(new MemoryStream("not an image"u8.ToArray()), TestContext.Current.CancellationToken));
        Assert.Equal(StoreError.Unsupported, error.Error);
    }

    private static async Task<byte[]> PngAsync(int width, int height)
    {
        using var image = new Image<Rgba32>(width, height, Color.CornflowerBlue);
        await using var stream = new MemoryStream();
        await image.SaveAsPngAsync(stream);
        return stream.ToArray();
    }

    public void Dispose() => Directory.Delete(root, true);
}
