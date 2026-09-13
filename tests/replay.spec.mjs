import { test, expect, acFrame, withChecksum, notify, selected, pointer, pixels } from './helpers.mjs';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#palette .sw')).toHaveCount(6);
});

test('T1 acceleration uses signed little-endian units of 1/1024 G', async ({ page }) => {
  const values = await page.evaluate(() => [irodori.accel(0xE8, 0x03), irodori.accel(0xDB, 0xFF)].map(value => Number(value.toFixed(3))));
  expect(values).toEqual([0.977, -0.036]);
});

test('T2 every stable face selects its palette after 450 ms', async ({ page }) => {
  for (let face = 1; face <= 6; face++) {
    await notify(page, acFrame(3, face));
    await page.waitForTimeout(450);
    expect(await selected(page)).toBe(face - 1);
  }
});

test('T3 a 3 → 4 → 3 wobble commits only the last settled face', async ({ page }) => {
  await page.evaluate(async frames => {
    window.__notificationTimes = [];
    for (const bytes of frames) {
      window.__notificationTimes.push(performance.now());
      irodori.onMesh(Uint8Array.from(bytes), 'AC');
      if (window.__notificationTimes.length < frames.length) await new Promise(resolve => setTimeout(resolve, 60));
    }
  }, [acFrame(3, 3), acFrame(3, 4), acFrame(3, 3)]);
  const times = await page.evaluate(() => window.__notificationTimes);
  expect(times[1] - times[0]).toBeLessThan(350);
  expect(times[2] - times[1]).toBeLessThan(350);
  expect(await selected(page)).toBe(4);
  await page.waitForTimeout(450);
  expect(await selected(page)).toBe(2);
});

test('T4 a flip cancels a pending face and ignores the accompanying face', async ({ page }) => {
  await notify(page, acFrame(3, 4));
  await notify(page, acFrame(2));
  await notify(page, acFrame(3, 3));
  expect(await selected(page)).toBe(4);
  await page.waitForTimeout(450);
  expect(await selected(page)).toBe(4);
  await expect(page.locator('#status')).toContainText('そっと けす');
});

test('T5 one double-press notification advances exactly one color', async ({ page }) => {
  await notify(page, withChecksum([1, 0, 3]), 'BU');
  expect(await selected(page)).toBe(5);
  await page.waitForTimeout(450);
  expect(await selected(page)).toBe(5);
});

test('T6 checksum mismatch is counted and remains non-strict', async ({ page }) => {
  const bytes = acFrame(3, 2);
  const before = await page.evaluate(() => irodori.meshStats.sumMismatch);
  bytes[16] ^= 0xFF;
  await notify(page, bytes);
  expect(await page.evaluate(() => irodori.meshStats.sumMismatch)).toBe(before + 1);
  await page.waitForTimeout(450);
  expect(await selected(page)).toBe(1);
});

test('T7 two pointers do not bridge and the remaining pointer still draws', async ({ page }) => {
  await pointer(page, 'pointerdown', 11, 200, 300);
  await pointer(page, 'pointerdown', 22, 700, 300);
  await pointer(page, 'pointermove', 11, 240, 300);
  const [midpoint, background, drawn] = await pixels(page, [[450, 300], [880, 300], [220, 300]]);
  expect(Math.abs(midpoint.sum - background.sum)).toBeLessThanOrEqual(40);
  expect(drawn.sum - background.sum).toBeGreaterThan(100);
  await pointer(page, 'pointerup', 22, 700, 300);
  await pointer(page, 'pointermove', 11, 300, 300);
  const [continued, clear] = await pixels(page, [[280, 300], [880, 300]]);
  expect(continued.sum - clear.sum).toBeGreaterThan(100);
  await pointer(page, 'pointerup', 11, 300, 300);
});

test('T8 softClear removes a visible line after 2.5 seconds', async ({ page }) => {
  await pointer(page, 'pointerdown', 1, 160, 260);
  await pointer(page, 'pointermove', 1, 320, 260);
  await pointer(page, 'pointerup', 1, 320, 260);
  const [line, beforeBackground] = await pixels(page, [[230, 260], [850, 260]]);
  expect(line.sum - beforeBackground.sum).toBeGreaterThan(100);
  await page.evaluate(() => irodori.softClear());
  await page.waitForTimeout(2500);
  const [cleared, background] = await pixels(page, [[230, 260], [850, 260]]);
  expect(Math.abs(cleared.sum - background.sum)).toBeLessThanOrEqual(12);
});

test('T9 mixed synthetic inputs finish without error or unhandledrejection', async ({ page }) => {
  await notify(page, acFrame(0, 0, 1000, -37));
  await page.waitForTimeout(350);
  await notify(page, acFrame(1));
  await notify(page, withChecksum([1, 0, 1]), 'BU');
  await notify(page, withChecksum([1, 0, 2]), 'BU');
  await pointer(page, 'pointerdown', 17, 180, 340);
  await pointer(page, 'pointermove', 17, 350, 340);
  await pointer(page, 'pointerup', 17, 350, 340);
  await page.waitForTimeout(1800);
  expect(await page.evaluate(() => window.__exceptions)).toEqual([]);
});
