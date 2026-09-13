import { test, expect, pointer } from './helpers.mjs';

for (const [width, height] of [[320, 568], [375, 812], [568, 320], [667, 375], [812, 375], [640, 900], [768, 1024], [1000, 700], [1280, 720]]) {
  test(`P3 at ${width}x${height} the play badge is big enough, on screen, and clear of the bar and the side column`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/?mochi=1');
    const box = async (selector) => page.locator(selector).boundingBox();
    const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const game = await box('#game');
    expect(game.width).toBeGreaterThanOrEqual(44);
    expect(game.height).toBeGreaterThanOrEqual(44);
    expect(game.x).toBeGreaterThanOrEqual(0);
    expect(game.y).toBeGreaterThanOrEqual(0);
    expect(game.x + game.width).toBeLessThanOrEqual(width);
    expect(game.y + game.height).toBeLessThanOrEqual(height);
    expect(overlaps(game, await box('#bar')), 'clear of the bottom bar').toBe(false);
    expect(overlaps(game, await box('#side')), 'clear of the side column').toBe(false);
    await page.locator('#game').click();
    expect((await page.evaluate(() => irodori.getGameState())).on).toBe(true);
    const playing = await box('#game');
    expect(overlaps(playing, await box('#bar'))).toBe(false);
  });
}

test('P4 drawing dims the bar but not the play badge, and the badge stops breathing once play starts', async ({ page }) => {
  await page.goto('/');
  const badge = page.locator('#game');
  expect(await badge.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('game-breathe');
  await pointer(page, 'pointerdown', 9, 200, 260);
  await pointer(page, 'pointermove', 9, 260, 280);
  await pointer(page, 'pointerup', 9, 260, 280);
  await expect(page.locator('#bar')).toHaveClass(/quiet/);
  await page.waitForTimeout(700);
  expect(await badge.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
  expect(await badge.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('none');
  expect((await page.evaluate(() => irodori.getGameState())).settled).toBe(true);
});

test('P5 with reduced motion the badge never scales, and while playing it shows a way back to drawing', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const badge = page.locator('#game');
  expect(await badge.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('none');
  await expect(badge).toHaveText('あそぶ');
  await expect(page.getByRole('button', { name: 'あそぶ', exact: true })).toBeVisible();
  await badge.click();
  await expect(badge).toHaveText('えにもどる');
  await expect(badge).toHaveClass(/playing/);
  await expect(badge.locator('.ic-star')).toBeHidden();
  await expect(badge.locator('.ic-back')).toBeVisible();
  await badge.click();
  await expect(badge).toHaveText('あそぶ');
  await expect(badge.locator('.ic-star')).toBeVisible();
});

test('P6 the mochi mentions the play badge once when nobody moves on from the first lesson for 18 seconds', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/?mochi=1');
  await expect.poll(() => page.evaluate(() => irodori.getTalkState().step), { timeout: 10000 }).toBeGreaterThanOrEqual(1);
  expect((await page.evaluate(() => irodori.getGameState())).hintGiven).toBe(false);
  await expect.poll(() => page.evaluate(() => irodori.getGameState().hintGiven), { timeout: 40000, intervals: [1000] }).toBe(true);
  await expect(page.locator('#talk')).toContainText('きんいろ', { timeout: 5000 });
  const lines = await page.evaluate(() => irodori.getTalkState().lines);
  await page.waitForTimeout(20000);
  const later = await page.evaluate(() => ({ hint: irodori.getGameState().hintGiven, text: document.getElementById('talk-text').textContent }));
  expect(later.hint).toBe(true);
  expect(later.text.includes('きんいろ') && (await page.evaluate(() => irodori.getTalkState().lines)) > lines, 'the hint is not repeated').toBe(false);
});

test('P7 a keyboard user can Tab to the play badge and press it with Space or Enter without setting off a firework', async ({ page }) => {
  await page.goto('/');
  await page.locator('#game').focus();
  const sparks = await page.evaluate(() => irodori.getMotionState().sparkCount);
  await page.keyboard.press('Space');
  expect((await page.evaluate(() => irodori.getGameState())).on).toBe(true);
  expect(await page.evaluate(() => irodori.getMotionState().sparkCount)).toBe(sparks);
  await page.locator('#game').focus();
  await page.keyboard.press('Enter');
  expect((await page.evaluate(() => irodori.getGameState())).on).toBe(false);
});

test('P8 play through a real or on-screen block, or the keyboard, also stops the badge from calling out', async ({ page }) => {
  for (const act of [
    async () => page.evaluate(() => irodori.onMesh(Uint8Array.from([1, 0, 1, 2]), 'BU')),
    async () => page.locator('#vb-ac').click(),
    async () => page.keyboard.press('r'),
    async () => page.keyboard.press('Space'),
  ]) {
    await page.goto('/');
    expect((await page.evaluate(() => irodori.getGameState())).settled).toBe(false);
    await act();
    expect((await page.evaluate(() => irodori.getGameState())).settled).toBe(true);
  }
});
