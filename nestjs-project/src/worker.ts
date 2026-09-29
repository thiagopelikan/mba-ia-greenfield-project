import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // Close the BullMQ worker (waits for the active job) on SIGTERM/SIGINT.
  app.enableShutdownHooks();
  Logger.log('Video worker started — consuming "video-processing"', 'Worker');
}
void bootstrap();
