import { describe, it, expect } from 'vitest';
import { bilinearResize } from './depth.ts';

describe('bilinearResize', () => {
  it('returns same values when src and dst are same size', () => {
    const src = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const result = bilinearResize(src, 2, 2, 2, 2);
    expect(result.length).toBe(4);
    expect(result[0]).toBeCloseTo(0.1);
    expect(result[1]).toBeCloseTo(0.2);
    expect(result[2]).toBeCloseTo(0.3);
    expect(result[3]).toBeCloseTo(0.4);
  });

  it('upscales with bilinear interpolation', () => {
    // 2x2 → 4x4
    const src = new Float32Array([
      0, 1,
      1, 0,
    ]);
    const result = bilinearResize(src, 2, 2, 4, 4);
    expect(result.length).toBe(16);
    // Top-left corner should be close to 0
    expect(result[0]).toBeCloseTo(0, 1);
    // Top-right corner should be close to 1
    expect(result[3]).toBeCloseTo(1, 0);
    // Middle values should be interpolated (between 0 and 1)
    expect(result[5]).toBeGreaterThan(0);
    expect(result[5]).toBeLessThan(1);
  });

  it('downscales correctly', () => {
    // 4x4 uniform → 2x2 should preserve value
    const src = new Float32Array(16).fill(0.5);
    const result = bilinearResize(src, 4, 4, 2, 2);
    expect(result.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(result[i]).toBeCloseTo(0.5);
    }
  });

  it('handles 1x1 source', () => {
    const src = new Float32Array([0.7]);
    const result = bilinearResize(src, 1, 1, 3, 3);
    expect(result.length).toBe(9);
    for (let i = 0; i < 9; i++) {
      expect(result[i]).toBeCloseTo(0.7);
    }
  });

  it('preserves gradient in one direction', () => {
    // Horizontal gradient 0→1
    const src = new Float32Array([0, 0.5, 1, 0, 0.5, 1]);
    const result = bilinearResize(src, 3, 2, 6, 4);
    // First column should all be close to 0
    expect(result[0]).toBeCloseTo(0, 1);
    expect(result[6]).toBeCloseTo(0, 1);
    // Last column should be close to 1
    expect(result[5]).toBeCloseTo(1, 0);
  });
});
