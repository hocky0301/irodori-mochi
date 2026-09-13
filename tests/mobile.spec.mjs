import { test, expect, pointer, pixels, selected } from './helpers.mjs';

test('M1 a 375px viewport exposes every control, clears a line, and folds diagnostics without drawing', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => {
    // Keep the MESH control visible even in Chromium builds without Web Bluetooth.
    if (!navigator.bluetooth) Object.defineProperty(navigator, 'bluetooth', { value: {} });
  });
  for (const path of ['/', '/?debug=1']) {
    await page.goto(path);
    const controls = page.locator('#palette .sw, #bar button');
    await expect(controls).toHaveCount(11);
    for (const control of await controls.all()) {
      await expect(control).toBeVisible();
      const rectangle = await control.boundingBox();
      expect(rectangle.x).toBeGreaterThanOrEqual(0);
      expect(rectangle.y).toBeGreaterThanOrEqual(0);
      expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(375);
      expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(812);
    }
    const buttons = await page.locator('#bar button').evaluateAll(elements => elements.map(element => ({
      height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).fontSize),
    })));
    for (const button of buttons) expect(button.height).toBeLessThan(button.lineHeight * 3);
    await pointer(page, 'pointerdown', 4, 80, 420);
    await pointer(page, 'pointermove', 4, 200, 420);
    await pointer(page, 'pointerup', 4, 200, 420);
    const [line, background] = await pixels(page, [[140, 420], [330, 420]]);
    expect(line.sum - background.sum).toBeGreaterThan(100);
    await page.getByRole('button', { name: 'けす', exact: true }).click();
    await page.waitForTimeout(2500);
    const [cleared, empty] = await pixels(page, [[140, 420], [330, 420]]);
    expect(Math.abs(cleared.sum - empty.sum)).toBeLessThanOrEqual(12);
    if (path.includes('debug')) {
      const before = await selected(page);
      await page.locator('#debug-panel summary').focus();
      await page.keyboard.press('Space');
      await expect(page.locator('#debug-log')).toBeHidden();
      await page.keyboard.press('1');
      expect(await selected(page)).toBe(before);
      expect(await page.evaluate(() => irodori.getMotionState().sparkCount)).toBe(0);
    }
  }
});
