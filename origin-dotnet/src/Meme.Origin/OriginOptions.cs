namespace Meme.Origin;

public sealed class OriginOptions
{
    public string DataDir { get; init; } = "/var/lib/meme-origin-dotnet";
    public string LogDir { get; init; } = "/var/log/meme-origin-dotnet";
    public string MutationToken { get; init; } = "";
    public long MaxUploadBytes { get; init; } = 25 * 1024 * 1024;
    public int MaxImagePixels { get; init; } = 50_000_000;
    public int TrashRetentionDays { get; init; } = 30;
    public int LogCompressionDays { get; init; } = 30;
}
