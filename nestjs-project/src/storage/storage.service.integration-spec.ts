import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { requestPresigned } from '../test/storage-http';
import { StorageMultipartException } from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const FIVE_MIB = 5 * 1024 * 1024;
const TTL = 300;

describe('StorageService (integration — MinIO)', () => {
  let storage: StorageService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = moduleRef.get(StorageService);
  });

  const uniqueKey = () => `test/${randomUUID()}/original`;

  async function uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<string> {
    const url = await storage.presignUploadPart(key, uploadId, partNumber, TTL);
    const res = await requestPresigned(url, { method: 'PUT', body });
    expect(res.status).toBe(200);
    return String(res.headers.etag);
  }

  it('uploads parts through public presigned URLs and completes the object', async () => {
    const key = uniqueKey();
    const part1 = randomBytes(FIVE_MIB);
    const part2 = randomBytes(1024);
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const url = await storage.presignUploadPart(key, uploadId, 1, TTL);
    expect(new URL(url).host).toBe(
      new URL(process.env.S3_PUBLIC_ENDPOINT ?? 'http://localhost:9000').host,
    );
    const etag1 = await uploadPart(key, uploadId, 1, part1);
    const etag2 = await uploadPart(key, uploadId, 2, part2);
    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 2, etag: etag2 },
      { partNumber: 1, etag: etag1 },
    ]);

    const getUrl = await storage.presignGetObject(key, {
      ttlSeconds: TTL,
      audience: 'internal',
    });
    const res = await requestPresigned(getUrl);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(part1.length + part2.length);
    expect(res.body.equals(Buffer.concat([part1, part2]))).toBe(true);
  });

  it('lists only the parts already uploaded (resume support)', async () => {
    const key = uniqueKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const etag1 = await uploadPart(key, uploadId, 1, randomBytes(FIVE_MIB));

    const parts = await storage.listParts(key, uploadId);

    expect(parts).toEqual([{ partNumber: 1, etag: etag1, size: FIVE_MIB }]);
    await storage.abortMultipartUpload(key, uploadId);
  });

  it('rejects completion with an invalid ETag as InvalidPart', async () => {
    const key = uniqueKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    await uploadPart(key, uploadId, 1, randomBytes(1024));

    const attempt = storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: '"0123456789abcdef0123456789abcdef"' },
    ]);

    await expect(attempt).rejects.toBeInstanceOf(StorageMultipartException);
    await expect(attempt).rejects.toMatchObject({ code: 'InvalidPart' });
    await storage.abortMultipartUpload(key, uploadId);
  });

  it('reports NoSuchUpload after an upload is aborted', async () => {
    const key = uniqueKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    await storage.abortMultipartUpload(key, uploadId);

    await expect(storage.listParts(key, uploadId)).rejects.toMatchObject({
      code: 'NoSuchUpload',
    });
  });

  it('serves byte ranges (206) from a public presigned GET', async () => {
    const key = uniqueKey();
    const content = randomBytes(4096);
    await storage.putObject(key, content, 'video/mp4');

    const url = await storage.presignGetObject(key, {
      ttlSeconds: TTL,
      audience: 'public',
    });
    const res = await requestPresigned(url, {
      headers: { Range: 'bytes=0-1023' },
    });

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-1023/4096');
    expect(res.body.equals(content.subarray(0, 1024))).toBe(true);
  });

  it('signs a download disposition with the original file name', async () => {
    const key = uniqueKey();
    await storage.putObject(key, randomBytes(16), 'video/mp4');

    const url = await storage.presignGetObject(key, {
      ttlSeconds: TTL,
      audience: 'public',
      downloadFileName: 'Minhas férias.mp4',
    });
    const res = await requestPresigned(url);

    expect(url).toContain('response-content-disposition=attachment');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Minhas f_rias.mp4"; filename*=UTF-8''Minhas%20f%C3%A9rias.mp4`,
    );
  });
});
