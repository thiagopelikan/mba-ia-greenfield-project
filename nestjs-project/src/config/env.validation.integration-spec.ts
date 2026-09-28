import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and video keys', () => {
  it('should apply defaults when the phase 03 keys are not set', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'streamtube-videos',
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      VIDEO_MAX_UPLOAD_BYTES: 10737418240,
      VIDEO_UPLOAD_PART_SIZE_BYTES: 67108864,
      VIDEO_UPLOAD_URL_TTL_SECONDS: 3600,
      VIDEO_PLAYBACK_URL_TTL_SECONDS: 3600,
      VIDEO_UPLOAD_WINDOW_HOURS: 24,
    });
  });

  it('should reject a part size below the 5 MiB S3 multipart minimum', () => {
    const { error } = validate({ VIDEO_UPLOAD_PART_SIZE_BYTES: '1024' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_BYTES');
  });

  it('should reject a non-URI storage endpoint', () => {
    const { error } = validate({ S3_ENDPOINT: 'not a url' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });
});
