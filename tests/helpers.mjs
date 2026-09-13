import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  page: async ({ page }, use) => {
    const uncaught = [];
    const renderingErrors = [];
    page.on('pageerror', error => uncaught.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && message.text().includes('[irodori]')) renderingErrors.push(message.text());
    });
    await page.addInitScript(() => {
      window.__exceptions = [];
      window.addEventListener('error', event => window.__exceptions.push(event.message));
      window.addEventListener('unhandledrejection', event => window.__exceptions.push(String(event.reason)));
    });
    await use(page);
    expect(uncaught, 'T9: pageerror throughout every check').toEqual([]);
    expect(renderingErrors, 'T9: caught rendering errors').toEqual([]);
    expect(await page.evaluate(() => window.__exceptions), 'T9: error / unhandledrejection throughout every check').toEqual([]);
  },
});
export { expect };

// Sony MESH AC: 17 bytes, 16-bit little-endian acceleration, sum in final byte.
export function acFrame(event, face = 0, x = 0, y = 0, z = 1024) {
  const bytes = [1, event, face, 0, x & 255, (x >> 8) & 255, y & 255, (y >> 8) & 255, z & 255, (z >> 8) & 255, 0, 0, 0, 0, 0, 0];
  return withChecksum(bytes);
}

export function withChecksum(bytes) {
  return [...bytes, bytes.reduce((sum, byte) => sum + byte, 0) & 255];
}

export async function notify(page, bytes, kind = 'AC') {
  await page.evaluate(({ bytes, kind }) => window.irodori.onMesh(Uint8Array.from(bytes), kind), { bytes, kind });
}

export async function selected(page) {
  return page.locator('#palette .sw').evaluateAll(elements => elements.findIndex(element => element.classList.contains('on')));
}

export async function pointer(page, type, id, x, y) {
  await page.locator('#paint').dispatchEvent(type, {
    pointerId: id, pointerType: 'touch', clientX: x, clientY: y,
    pressure: 0.5, bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  });
}

export async function pixels(page, coordinates) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.locator('#paint').evaluate((canvas, points) => points.map(([x, y]) => {
    const rgb = Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data).slice(0, 3);
    return { rgb, sum: rgb.reduce((a, b) => a + b, 0) };
  }), coordinates);
}
