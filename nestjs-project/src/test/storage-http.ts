import * as http from 'node:http';

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Sends a request to a presigned URL signed for the public storage host
 * (e.g. http://localhost:9000) from inside the Compose network: the TCP
 * connection goes to the internal endpoint (S3_ENDPOINT) while the signed
 * `Host` header is preserved — exactly what a browser on the host machine sends.
 */
export function requestPresigned(
  presignedUrl: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer;
  } = {},
): Promise<RawResponse> {
  const target = new URL(presignedUrl);
  const internal = new URL(process.env.S3_ENDPOINT ?? 'http://minio:9000');

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: internal.hostname,
        port: internal.port || 80,
        method: init.method ?? 'GET',
        path: `${target.pathname}${target.search}`,
        headers: {
          ...init.headers,
          Host: target.host,
          ...(init.body ? { 'Content-Length': String(init.body.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}
