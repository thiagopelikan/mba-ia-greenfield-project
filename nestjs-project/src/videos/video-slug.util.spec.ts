import { VIDEO_SLUG_LENGTH, generateVideoSlug } from './video-slug.util';

describe('generateVideoSlug', () => {
  it('should produce an 11-character base64url slug', () => {
    const slug = generateVideoSlug();

    expect(slug).toHaveLength(VIDEO_SLUG_LENGTH);
    expect(slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('should produce distinct values across calls', () => {
    const slugs = new Set(Array.from({ length: 1000 }, generateVideoSlug));

    expect(slugs.size).toBe(1000);
  });
});
