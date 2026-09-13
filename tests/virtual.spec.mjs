import { test, expect } from './helpers.mjs';

async function holdBlock(page, selector, ms) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

test('V1 the on-screen button block launches a rocket and the motion block shakes to the next planet, as real frames', async ({ page }) => {
  await page.goto('/?debug=1');
  await page.locator('#vb-bu').click();
  expect((await page.evaluate(() => irodori.getRocketState())).launched).toBe(1);
  await page.locator('#vb-ac').click();
  expect((await page.evaluate(() => irodori.getScene())).name).toBe('げつめん');
  const snapshot = await page.evaluate(() => irodori.debug.snapshot());
  expect(snapshot.counts.buttonSingle).toBe(1);
  expect(snapshot.counts.shake).toBe(1);
  expect(snapshot.meshStats.sumMismatch).toBe(0);
  await expect(page.locator('#vb-bu')).not.toBeFocused();
});

test('V2 holding the on-screen brightness block streams proximity at 20 Hz: the mochi comes out, squishes, and a hold is told from a tap', async ({ page }) => {
  await page.goto('/?debug=1');
  const box = await page.locator('#vb-pa').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1000);
  const held = await page.evaluate(() => ({ hand: irodori.getHandState(), mochi: irodori.getMochiState(), received: irodori.debug.snapshot().counts.proximity }));
  expect(held.hand.near).toBe(true);
  expect(held.mochi.active).toBe(true);
  expect(held.mochi.squash).toBeGreaterThan(0.1);
  expect(held.received, 'about 20 notifications a second while held').toBeGreaterThanOrEqual(15);
  expect(held.received).toBeLessThanOrEqual(30);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => irodori.getMochiState().lastGesture?.kind)).toBe('long');
  await page.waitForTimeout(800);
  await holdBlock(page, '#vb-pa', 80);
  await expect.poll(() => page.evaluate(() => irodori.getMochiState().gestures.tap)).toBe(1);
  await page.waitForTimeout(1800);
  const settled = await page.evaluate(() => irodori.getHandState());
  expect(settled.near).toBe(false);
});

test('V3 in the game, holding the on-screen brightness block charges a jump and releasing jumps', async ({ page }) => {
  await page.goto('/?game=1');
  await page.waitForTimeout(300);
  await holdBlock(page, '#vb-pa', 900);
  await expect.poll(() => page.evaluate(() => irodori.getGameState().jumps)).toBe(1);
});

test('V4 the slides button opens the presentation deck in a new tab', async ({ page, context }) => {
  await page.goto('/');
  const link = page.locator('#deck-link');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'deck/mochi.html');
  await expect(link).toHaveAttribute('target', '_blank');
  const [deck] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await deck.waitForLoadState('domcontentloaded');
  await expect(deck).toHaveTitle(/もち/);
  expect((await page.evaluate(() => irodori.getGameState())).on, 'opening the slides does not touch the play screen').toBe(false);
});

for (const [width, height] of [[320, 568], [375, 812], [667, 375], [812, 375], [1000, 700]]) {
  test(`V5 at ${width}x${height} the side column fits on screen and does not cover the bottom bar`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    const side = await page.locator('#side').boundingBox();
    const bar = await page.locator('#bar').boundingBox();
    expect(side.x).toBeGreaterThanOrEqual(0);
    expect(side.y).toBeGreaterThanOrEqual(0);
    expect(side.x + side.width).toBeLessThanOrEqual(width);
    expect(side.y + side.height).toBeLessThanOrEqual(height);
    const overlaps = side.x < bar.x + bar.width && bar.x < side.x + side.width && side.y < bar.y + bar.height && bar.y < side.y + side.height;
    expect(overlaps).toBe(false);
    for (const id of ['#deck-link', '#vb-pa', '#vb-bu', '#vb-ac']) await expect(page.locator(id)).toBeVisible();
  });
}

for (const [width, height] of [[320, 568], [360, 640], [375, 667], [390, 844]]) {
  test(`V6 at ${width}x${height} the side column stays clear of the mochi's speech bubble`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/?mochi=1');
    await expect(page.locator('#talk')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(1500);
    const side = await page.locator('#side').boundingBox();
    const talk = await page.locator('#talk').boundingBox();
    const overlaps = side.x < talk.x + talk.width && talk.x < side.x + side.width && side.y < talk.y + talk.height && talk.y < side.y + side.height;
    expect(overlaps).toBe(false);
  });
}
