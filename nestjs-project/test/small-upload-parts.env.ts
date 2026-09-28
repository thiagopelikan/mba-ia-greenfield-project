// Side-effect module: must be imported before AppModule so the video config
// factory sees it. Uses the S3 minimum part size (5 MiB) so a ~10 MB sample
// is uploaded as a real multi-part upload.
process.env.VIDEO_UPLOAD_PART_SIZE_BYTES = String(5 * 1024 * 1024);
