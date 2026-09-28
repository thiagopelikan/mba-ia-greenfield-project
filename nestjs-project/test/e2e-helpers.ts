import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';

/** Boots AppModule with the same global pipe/filters as main.ts. */
export async function createE2eApp(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();
  return app;
}

/** Registers, confirms (token captured from the mailer) and logs a user in. */
export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<string> {
  // Same instance AuthService uses (MailModule provider is a singleton).
  const mailService = app.get(MailService);
  let confirmationToken = '';
  jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_e: string, _n: string, t: string) => {
      confirmationToken = t;
      return Promise.resolve();
    });

  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken })
    .expect(204);
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  const body = res.body as { access_token: string };
  return body.access_token;
}
