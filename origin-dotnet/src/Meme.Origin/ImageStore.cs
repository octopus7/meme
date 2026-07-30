using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats;
using SixLabors.ImageSharp.Formats.Webp;
using SixLabors.ImageSharp.Processing;

namespace Meme.Origin;

public sealed record BlobResult(string Hash, string Extension, string MimeType, long Size, bool Deduplicated);
public sealed record TrashRecord(
    string Hash,
    string Extension,
    [property: JsonPropertyName("trashed_at")] DateTimeOffset TrashedAt,
    [property: JsonPropertyName("purge_at")] DateTimeOffset PurgeAt);
public sealed record MediaFile(string Path, long Length, DateTimeOffset LastModified);

public sealed class ImageStore(OriginOptions options, TimeProvider timeProvider)
{
    private static readonly string[] Extensions = ["jpg", "png", "webp", "gif"];
    private readonly SemaphoreSlim gate = new(1, 1);
    private string Images => Path.Combine(options.DataDir, "images");
    private string Thumbnails => Path.Combine(options.DataDir, "thumbnails");
    private string TrashImages => Path.Combine(options.DataDir, "trash", "images");
    private string TrashThumbnails => Path.Combine(options.DataDir, "trash", "thumbnails");
    private string TrashRecords => Path.Combine(options.DataDir, "trash", "records");
    private string Temp => Path.Combine(options.DataDir, "tmp");

    public void Initialize()
    {
        foreach (var path in new[] { Images, Thumbnails, TrashImages, TrashThumbnails, TrashRecords, Temp })
            Directory.CreateDirectory(path);
    }

    public async Task<BlobResult> PutAsync(Stream input, CancellationToken cancellationToken)
    {
        var id = $"{Environment.ProcessId}-{Guid.NewGuid():N}";
        var raw = Path.Combine(Temp, $".upload-{id}");
        var thumb = Path.Combine(Temp, $".thumb-{id}.webp");
        try
        {
            var (hash, size) = await CopyAndHashAsync(input, raw, cancellationToken);
            string extension;
            string mime;
            try
            {
                await using var source = File.OpenRead(raw);
                var identified = await Image.IdentifyAsync(source, cancellationToken)
                    ?? throw new StoreException(StoreError.Unsupported, "invalid or unsupported image");
                checked
                {
                    if ((long)identified.Width * identified.Height > options.MaxImagePixels)
                        throw new StoreException(StoreError.Unsupported, "image pixel count exceeds limit");
                }
                source.Position = 0;
                var decoderOptions = new DecoderOptions { MaxFrames = 1, SkipMetadata = true };
                using var image = await Image.LoadAsync(decoderOptions, source, cancellationToken);
                (extension, mime) = identified.Metadata.DecodedImageFormat?.Name.ToUpperInvariant() switch
                {
                    "JPEG" => ("jpg", "image/jpeg"),
                    "PNG" => ("png", "image/png"),
                    "WEBP" => ("webp", "image/webp"),
                    "GIF" => ("gif", "image/gif"),
                    _ => throw new StoreException(StoreError.Unsupported, "unsupported image format")
                };
                image.Mutate(context => context.AutoOrient().Resize(new ResizeOptions
                {
                    Size = new Size(128, 128),
                    Mode = ResizeMode.Crop,
                    Position = AnchorPositionMode.Center
                }));
                await image.SaveAsWebpAsync(thumb, new WebpEncoder { Quality = 82 }, cancellationToken);
            }
            catch (StoreException) { throw; }
            catch (Exception error) when (error is InvalidImageContentException or UnknownImageFormatException)
            {
                throw new StoreException(StoreError.Unsupported, "invalid or unsupported image", error);
            }

            await gate.WaitAsync(cancellationToken);
            try
            {
                if (File.Exists(RecordPath(hash)))
                    throw new StoreException(StoreError.Trashed, "blob is in trash");
                var existing = FindOriginal(hash);
                if (existing is not null)
                {
                    var info = new FileInfo(existing);
                    if (Path.GetExtension(existing)[1..] != extension || info.Length != size)
                        throw new StoreException(StoreError.Conflict, "blob state conflict");
                    var finalThumb = ThumbnailPath(hash);
                    if (!File.Exists(finalThumb)) File.Move(thumb, finalThumb);
                    return new BlobResult(hash, extension, mime, size, true);
                }
                var original = OriginalPath(hash, extension);
                var thumbnail = ThumbnailPath(hash);
                File.Move(raw, original);
                try { File.Move(thumb, thumbnail); }
                catch { File.Delete(original); throw; }
                return new BlobResult(hash, extension, mime, size, false);
            }
            finally { gate.Release(); }
        }
        finally
        {
            File.Delete(raw);
            File.Delete(thumb);
        }
    }

    public MediaFile ResolveOriginal(string hash, string extension)
    {
        ValidateHash(hash);
        if (!Extensions.Contains(extension, StringComparer.Ordinal)) throw NotFound();
        if (File.Exists(RecordPath(hash))) throw NotFound();
        return Resolve(OriginalPath(hash, extension));
    }

    public MediaFile ResolveThumbnail(string hash)
    {
        ValidateHash(hash);
        if (File.Exists(RecordPath(hash))) throw NotFound();
        return Resolve(ThumbnailPath(hash));
    }

    public async Task<TrashRecord> TrashAsync(string hash, CancellationToken cancellationToken)
    {
        ValidateHash(hash);
        await gate.WaitAsync(cancellationToken);
        try
        {
            if (File.Exists(RecordPath(hash))) return await ReadRecordAsync(hash, cancellationToken);
            var original = FindOriginal(hash) ?? throw NotFound();
            var thumbnail = ThumbnailPath(hash);
            if (!File.Exists(thumbnail)) throw new StoreException(StoreError.Conflict, "thumbnail missing");
            var now = timeProvider.GetUtcNow();
            var record = new TrashRecord(hash, Path.GetExtension(original)[1..], now, now.AddDays(options.TrashRetentionDays));
            var trashOriginal = Path.Combine(TrashImages, Path.GetFileName(original));
            var trashThumb = Path.Combine(TrashThumbnails, $"{hash}.webp");
            File.Move(original, trashOriginal);
            try
            {
                File.Move(thumbnail, trashThumb);
                await AtomicJsonAsync(RecordPath(hash), record, cancellationToken);
            }
            catch
            {
                if (File.Exists(trashThumb)) File.Move(trashThumb, thumbnail);
                if (File.Exists(trashOriginal)) File.Move(trashOriginal, original);
                throw;
            }
            return record;
        }
        finally { gate.Release(); }
    }

    public async Task<TrashRecord> RestoreAsync(string hash, CancellationToken cancellationToken)
    {
        ValidateHash(hash);
        await gate.WaitAsync(cancellationToken);
        try
        {
            var record = await ReadRecordAsync(hash, cancellationToken);
            var original = OriginalPath(hash, record.Extension);
            var thumbnail = ThumbnailPath(hash);
            if (File.Exists(original) || File.Exists(thumbnail))
                throw new StoreException(StoreError.Conflict, "active destination exists");
            var trashOriginal = Path.Combine(TrashImages, $"{hash}.{record.Extension}");
            var trashThumb = Path.Combine(TrashThumbnails, $"{hash}.webp");
            if (!File.Exists(trashOriginal) || !File.Exists(trashThumb))
                throw new StoreException(StoreError.Conflict, "trash files missing");
            File.Move(trashOriginal, original);
            try
            {
                File.Move(trashThumb, thumbnail);
                File.Delete(RecordPath(hash));
            }
            catch
            {
                if (File.Exists(thumbnail)) File.Move(thumbnail, trashThumb);
                if (File.Exists(original)) File.Move(original, trashOriginal);
                throw;
            }
            return record;
        }
        finally { gate.Release(); }
    }

    public async Task<int> PurgeExpiredAsync(CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            var count = 0;
            foreach (var path in Directory.EnumerateFiles(TrashRecords, "*.json"))
            {
                var hash = Path.GetFileNameWithoutExtension(path);
                if (!IsHash(hash)) continue;
                var record = await ReadRecordAsync(hash, cancellationToken);
                if (record.PurgeAt > timeProvider.GetUtcNow()) continue;
                File.Delete(Path.Combine(TrashImages, $"{hash}.{record.Extension}"));
                File.Delete(Path.Combine(TrashThumbnails, $"{hash}.webp"));
                File.Delete(path);
                count++;
            }
            return count;
        }
        finally { gate.Release(); }
    }

    private async Task<(string Hash, long Size)> CopyAndHashAsync(Stream input, string destination, CancellationToken ct)
    {
        await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, FileOptions.Asynchronous);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[81920];
        long size = 0;
        while (true)
        {
            var read = await input.ReadAsync(buffer, ct);
            if (read == 0) break;
            size += read;
            if (size > options.MaxUploadBytes) throw new StoreException(StoreError.TooLarge, $"upload exceeds {options.MaxUploadBytes} bytes");
            hash.AppendData(buffer, 0, read);
            await output.WriteAsync(buffer.AsMemory(0, read), ct);
        }
        await output.FlushAsync(ct);
        return (Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant(), size);
    }

    private string? FindOriginal(string hash)
    {
        var matches = Extensions.Select(extension => OriginalPath(hash, extension)).Where(File.Exists).ToArray();
        return matches.Length switch
        {
            0 => null,
            1 => matches[0],
            _ => throw new StoreException(StoreError.Conflict, "multiple originals found")
        };
    }

    private async Task<TrashRecord> ReadRecordAsync(string hash, CancellationToken ct)
    {
        try
        {
            await using var stream = File.OpenRead(RecordPath(hash));
            return await JsonSerializer.DeserializeAsync<TrashRecord>(stream, cancellationToken: ct)
                ?? throw new StoreException(StoreError.Conflict, "invalid trash record");
        }
        catch (FileNotFoundException) { throw NotFound(); }
        catch (JsonException error) { throw new StoreException(StoreError.Conflict, "invalid trash record", error); }
    }

    private static async Task AtomicJsonAsync(string destination, TrashRecord record, CancellationToken ct)
    {
        var temp = $"{destination}.tmp-{Guid.NewGuid():N}";
        try
        {
            await using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                await JsonSerializer.SerializeAsync(stream, record, cancellationToken: ct);
            File.Move(temp, destination);
        }
        finally { File.Delete(temp); }
    }

    private static MediaFile Resolve(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw NotFound();
        return new MediaFile(path, info.Length, new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero));
    }

    private string OriginalPath(string hash, string extension) => Path.Combine(Images, $"{hash}.{extension}");
    private string ThumbnailPath(string hash) => Path.Combine(Thumbnails, $"{hash}.webp");
    private string RecordPath(string hash) => Path.Combine(TrashRecords, $"{hash}.json");
    private static bool IsHash(string hash) => hash.Length == 64 && hash.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static void ValidateHash(string hash) { if (!IsHash(hash)) throw NotFound(); }
    private static StoreException NotFound() => new(StoreError.NotFound, "not found");
}
