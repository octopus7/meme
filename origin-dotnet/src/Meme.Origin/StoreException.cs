namespace Meme.Origin;

public enum StoreError { NotFound, Trashed, Conflict, TooLarge, Unsupported }

public sealed class StoreException(StoreError error, string message, Exception? inner = null)
    : Exception(message, inner)
{
    public StoreError Error { get; } = error;
}
