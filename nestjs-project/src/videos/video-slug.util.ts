import { randomBytes } from 'node:crypto';

export const VIDEO_SLUG_LENGTH = 11;

/** 8 random bytes → 11-char base64url string (64 bits of entropy, URL-safe). */
export function generateVideoSlug(): string {
  return randomBytes(8).toString('base64url');
}
