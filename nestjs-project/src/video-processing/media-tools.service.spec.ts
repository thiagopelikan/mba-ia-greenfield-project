import { thumbnailTimestamp } from './media-tools.service';

describe('thumbnailTimestamp', () => {
  it('should pick 10% of the duration', () => {
    expect(thumbnailTimestamp(120)).toBeCloseTo(12);
  });

  it('should stay before the last frame of very short videos', () => {
    expect(thumbnailTimestamp(0.1)).toBe(0);
    expect(thumbnailTimestamp(0.5)).toBeCloseTo(0.05);
  });

  it('should use the first frame when the duration is unknown or zero', () => {
    expect(thumbnailTimestamp(null)).toBe(0);
    expect(thumbnailTimestamp(0)).toBe(0);
  });
});
