import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './app.module';
import { VideoProcessingProcessor } from './video-processing/video-processing.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule (integration)', () => {
  let worker: TestingModule;
  let api: TestingModule;

  beforeAll(async () => {
    // compile() resolves DI without running onModuleInit, so no BullMQ
    // consumer is started against the shared queue.
    worker = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    api = await Test.createTestingModule({ imports: [AppModule] }).compile();
  });

  afterAll(async () => {
    await worker.close();
    await api.close();
  });

  it('should provide the video-processing queue consumer', () => {
    expect(worker.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
  });

  it('should keep the queue consumer out of the API application', () => {
    expect(() => api.get(VideoProcessingProcessor)).toThrow();
  });
});
