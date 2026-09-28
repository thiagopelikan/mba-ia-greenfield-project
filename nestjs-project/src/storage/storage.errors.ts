/**
 * Raised when the object storage rejects a multipart operation (e.g. an
 * invalid ETag or a missing part). `code` carries the S3 error name so callers
 * can map it to a domain error.
 */
export class StorageMultipartException extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StorageMultipartException';
  }
}
