import { describe, expect, it } from 'vitest';
import { isClaudeIcon, pngSize, serverIcons } from '../src/server-icon.js';
import { BRAND } from '../src/ui.js';

// 1x1 and 96x96 PNG headers (IHDR only is enough for the size check).
const png = (w: number, h: number) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return 'data:image/png;base64,' + btoa(String.fromCharCode(...b));
};

describe('connector icon (serverInfo.icons, claude.ai rules)', () => {
  it('reads the PNG size', () => {
    expect(pngSize(png(96, 96))).toEqual({ width: 96, height: 96 });
    expect(pngSize('data:image/svg+xml;base64,PHN2Zy8+')).toBeUndefined();
  });

  it('accepts only an inline PNG of 64-128 px under 10 KB, first in the list', () => {
    expect(isClaudeIcon(png(96, 96))).toBe(true);
    expect(isClaudeIcon(png(32, 32))).toBe(false);
    expect(isClaudeIcon(png(512, 512))).toBe(false);
    expect(serverIcons(png(96, 96))).toEqual([{ src: png(96, 96), mimeType: 'image/png', sizes: ['96x96'] }]);
    expect(serverIcons(undefined)).toBeUndefined();
    expect(serverIcons(png(16, 16), [{ src: 'https://x/icon.svg', mimeType: 'image/svg+xml' }])).toEqual([{ src: 'https://x/icon.svg', mimeType: 'image/svg+xml' }]);
  });

  it('BRAND.logo is a valid claude.ai icon (it becomes the connector icon)', () => {
    expect(isClaudeIcon(BRAND.logo!)).toBe(true);
  });
});
