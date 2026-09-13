import { readFileSync } from 'node:fs';
import { test, expect, acFrame, withChecksum, notify, selected } from './helpers.mjs';

test('D1 diagnostics are opt-in and a normal page loads no external resources', async ({ page }) => {
  const externalRequests = [];
  page.on('request', request => {
    if (new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url());
  });
  await page.goto('/');
  await notify(page, acFrame(1));
  await expect(page.locator('#debug-panel')).toHaveCount(0);
  expect(await page.evaluate(() => 'debug' in irodori)).toBe(false);
  expect(externalRequests).toEqual([]);
  await page.goto('/?debug=0');
  await expect(page.locator('#debug-panel')).toHaveCount(0);
});

test('D2 diagnostics display raw bytes, checksum, all receipts and shake intervals', async ({ page }) => {
  await page.goto('/?debug=1');
  await notify(page, acFrame(1));
  await page.waitForTimeout(40);
  await notify(page, acFrame(1));
  const invalid = acFrame(3, 6);
  invalid[16] ^= 255;
  await notify(page, invalid);
  await expect(page.locator('#debug-log')).toContainText('01 01 00 00 00 00 00 00 00 04 00 00 00 00 00 00 06');
  await expect(page.locator('#debug-log')).toContainText('SUM 一致');
  await expect(page.locator('#debug-log')).toContainText('SUM 不一致');
  await expect(page.locator('#debug-log')).toContainText('synthetic-1 AC/direct');
  await expect(page.locator('#debug-counts')).toContainText('シェイク: 2');
  const snapshot = await page.evaluate(() => irodori.debug.snapshot());
  expect(snapshot.received).toBe(3);
  expect(snapshot.counts.shake).toBe(2);
  expect(snapshot.meshStats.sumMismatch).toBe(1);
  expect(snapshot.rawChecksumMismatches).toBe(1);
  expect(snapshot.notifications[0].shakeIntervalMs).toBeNull();
  expect(snapshot.notifications[1].shakeIntervalMs).toBeGreaterThanOrEqual(35);
  expect(snapshot.notifications[1].shakeIntervalMs).toBeLessThan(600);
  expect(snapshot.sumStrict).toBe(false);
  expect(snapshot.notifications[2].bytes).toEqual(invalid);
  expect(await page.evaluate(() => irodori.getMotionState().sparkCount)).toBe(150);
});

test('D3 export includes receipts beyond the last 20 displayed, without mutating live data', async ({ page }) => {
  await page.goto('/?debug=1');
  await page.evaluate(frame => {
    for (let i = 0; i < 25; i++) irodori.onMesh(Uint8Array.from(frame), 'BU');
    const copy = irodori.debug.snapshot();
    copy.notifications[0].bytes[0] = 99;
    copy.counts.buttonDouble = 999;
  }, withChecksum([1, 0, 3]));
  await expect(page.locator('#debug-log')).toContainText('SUM 一致');
  const text = await page.locator('#debug-log').textContent();
  expect(text.match(/SUM 一致/g)).toHaveLength(20);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'ログを書き出す' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('irodori-mesh-log.json');
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const exported = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(exported.notifications).toHaveLength(25);
  expect(exported.notifications[0].bytes).toEqual(withChecksum([1, 0, 3]));
  expect(exported.counts.buttonDouble).toBe(25);
  expect(exported.received).toBe(25);
  expect(exported.dropped).toBe(0);
  expect(exported.notifications.at(-1).sequence).toBe(25);
  await page.locator('#debug-panel summary').click();
  await expect(page.locator('#debug-log')).toBeHidden();
  await page.reload();
  expect(await page.evaluate(() => irodori.debug.snapshot().received)).toBe(0);
});

test('D4 keyboard use of diagnostic controls does not invoke drawing shortcuts', async ({ page }) => {
  await page.goto('/?debug=1');
  await page.getByRole('button', { name: 'ログを書き出す' }).focus();
  await page.keyboard.press('1');
  expect(await selected(page)).toBe(4);
  await page.keyboard.press('s');
  const downloadPromise = page.waitForEvent('download');
  await page.keyboard.press('Space');
  await downloadPromise;
  expect(await page.evaluate(() => irodori.getMotionState().sparkCount)).toBe(0);
  expect(await page.evaluate(() => irodori.getMotionState().warmth)).toBe(0);
});

test('D5 the log cap is explicit and cumulative counters include discarded entries', async ({ page }) => {
  await page.goto('/?debug=1');
  const snapshot = await page.evaluate(() => {
    const limit = irodori.debug.snapshot().logLimit;
    for (let i = 0; i < limit + 1; i++) irodori.onMesh(Uint8Array.of(0), 'AC');
    return irodori.debug.snapshot();
  });
  expect(snapshot.notifications).toHaveLength(snapshot.logLimit);
  expect(snapshot.received).toBe(snapshot.logLimit + 1);
  expect(snapshot.dropped).toBe(1);
  expect(snapshot.counts.other).toBe(snapshot.received);
  expect(snapshot.notifications[0].sequence).toBe(2);
  expect(snapshot.notifications[0].checksum).toBe('unavailable');
  expect(snapshot.meshStats.sumMismatch).toBe(0);
  await expect(page.locator('#debug-counts')).toContainText('保存上限で除外 1 件');
});

test('D6 simulated GATT callbacks retain firmware, battery and separate block shake intervals', async ({ page }) => {
  await page.addInitScript(() => {
    const devices = [];
    window.__mockMesh = {
      emit(index, channel, bytes) { devices[index].characteristics[channel].emit(bytes); },
      writes: [],
    };
    function characteristic() {
      const handlers = new Set();
      return {
        addEventListener(type, handler) { handlers.add(handler); },
        async startNotifications() {},
        async writeValueWithResponse(bytes) { window.__mockMesh.writes.push(Array.from(bytes)); },
        emit(bytes) { const value = new DataView(Uint8Array.from(bytes).buffer); handlers.forEach(handler => handler({ target: { value } })); },
      };
    }
    Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: {
      async requestDevice() {
        const index = devices.length;
        const characteristics = { notify: characteristic(), indicate: characteristic(), write: characteristic() };
        const device = {
          id: `private-device-${index}`, name: `MESH-100AC${String(index).padStart(7, '0')}`, characteristics,
          addEventListener() {},
          gatt: {
            async connect() { return { async getPrimaryService() { return { async getCharacteristic(uuid) {
              return uuid.startsWith('72c90005') ? characteristics.indicate : uuid.startsWith('72c90003') ? characteristics.notify : characteristics.write;
            } }; } }; },
            disconnect() {},
          },
        };
        devices.push(device);
        return device;
      },
    } });
  });
  await page.goto('/?debug=1');
  await page.getByRole('button', { name: 'MESHをつなぐ' }).click();
  await expect(page.locator('#debug-blocks')).toContainText('AC-1 動き / on / FW 未受信 / 電池 未受信');
  const firmware = withChecksum([0, 2, 0, 0, 0, 0, 0, 1, 2, 5, 0, 0, 0, 0, 8]);
  await page.evaluate(({ firmware, shake, battery }) => {
    __mockMesh.emit(0, 'indicate', firmware);
    __mockMesh.emit(0, 'notify', battery);
    __mockMesh.emit(0, 'notify', shake);
  }, { firmware, shake: acFrame(1), battery: withChecksum([0, 0, 7]) });
  await expect(page.locator('#debug-blocks')).toContainText('AC-1 動き / on / FW 1.2.5 / 電池 70%');
  await page.getByRole('button', { name: 'MESHをつなぐ' }).click();
  await page.evaluate(shake => {
    __mockMesh.emit(1, 'notify', shake);
    __mockMesh.emit(0, 'notify', shake);
  }, acFrame(1));
  const snapshot = await page.evaluate(() => irodori.debug.snapshot());
  expect(snapshot.blocks).toEqual([
    { block: 'AC-1', kind: 'AC', status: 'on', firmware: '1.2.5', batteryPercent: 70, lastError: null },
    { block: 'AC-2', kind: 'AC', status: 'on', firmware: null, batteryPercent: null, lastError: null },
  ]);
  expect(snapshot.received).toBe(5);
  expect(snapshot.counts.shake).toBe(3);
  expect(snapshot.notifications[0].channel).toBe('indicate');
  expect(snapshot.notifications[1].event).toBe('battery');
  expect(snapshot.notifications[2].shakeIntervalMs).toBeNull();
  expect(snapshot.notifications[3].shakeIntervalMs).toBeNull();
  expect(snapshot.notifications[4].shakeIntervalMs).toBeGreaterThan(0);
  expect(JSON.stringify(snapshot)).not.toContain('private-device');
  expect(JSON.stringify(snapshot)).not.toContain('MESH-100');
  expect(await page.evaluate(() => __mockMesh.writes)).toEqual([[0, 2, 1, 3], [0, 2, 1, 3]]);
});

test('D7 tapping a block chip releases it without retrying, and tapping again reconnects without the chooser', async ({ page }) => {
  await page.addInitScript(() => {
    window.__mock = { requests: 0, connects: 0, disconnects: 0 };
    const lost = [];
    const characteristic = () => ({ addEventListener() {}, async startNotifications() {}, async writeValueWithResponse() {} });
    const characteristics = { indicate: characteristic(), notify: characteristic(), write: characteristic() };
    const device = {
      id: 'private-device-0', name: 'MESH-100AC0000001',
      addEventListener(type, handler) { if (type === 'gattserverdisconnected') lost.push(handler); },
      gatt: {
        async connect() {
          window.__mock.connects++;
          return { async getPrimaryService() { return { async getCharacteristic(uuid) {
            return uuid.startsWith('72c90005') ? characteristics.indicate : uuid.startsWith('72c90003') ? characteristics.notify : characteristics.write;
          } }; } };
        },
        disconnect() { window.__mock.disconnects++; setTimeout(() => lost.forEach(handler => handler()), 0); },
      },
    };
    Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: {
      async requestDevice() { window.__mock.requests++; return device; },
    } });
  });
  await page.goto('/?debug=1');
  await page.getByRole('button', { name: 'MESHをつなぐ' }).click();
  const chip = page.locator('#blocks .chip');
  await expect(chip).toHaveText('動き');
  await chip.click();
  await expect(chip).toHaveText('動き ×');
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => ({ ...window.__mock }))).toEqual({ requests: 1, connects: 1, disconnects: 1 });
  await chip.click();
  await expect(chip).toHaveText('動き');
  expect(await page.evaluate(() => ({ ...window.__mock }))).toEqual({ requests: 1, connects: 2, disconnects: 1 });
});

test('H1 brightness block: holding a hand near charges, releasing blooms by the charge, a flicker does nothing', async ({ page }) => {
  const pa = prox => withChecksum([1, 0, 1, 0x24, prox & 255, (prox >> 8) & 255, 0, 1, 0, 0, 0, 0]);
  const sparks = async () => (await page.evaluate(() => irodori.getMotionState())).sparkCount;
  await page.goto('/');
  const color = await selected(page);
  for (let i = 0; i < 3; i++) { await notify(page, pa(100), 'PA'); await page.waitForTimeout(100); }
  await notify(page, pa(900), 'PA');
  await page.waitForTimeout(60);
  await notify(page, pa(100), 'PA');
  expect(await sparks(), 'a flicker shorter than 250 ms does not bloom').toBe(0);

  await notify(page, pa(900), 'PA');
  for (let i = 0; i < 3; i++) { await page.waitForTimeout(300); await notify(page, pa(900), 'PA'); }
  const mid = await page.evaluate(() => irodori.getHandState());
  expect(mid.near).toBe(true);
  expect(mid.charge).toBeGreaterThan(0.2);
  expect(mid.charge).toBeLessThan(0.6);
  await notify(page, pa(100), 'PA');
  const small = await sparks();
  expect(small, 'a short charge blooms a small firework').toBeGreaterThan(0);
  expect(small).toBeLessThanOrEqual(90);

  await page.waitForTimeout(2300);
  expect(await sparks()).toBe(0);
  await notify(page, pa(900), 'PA');
  for (let i = 0; i < 7; i++) { await page.waitForTimeout(400); await notify(page, pa(900), 'PA'); }
  expect((await page.evaluate(() => irodori.getHandState())).charge).toBe(1);
  await notify(page, pa(100), 'PA');
  await page.waitForTimeout(300);
  expect(await sparks(), 'a full charge blooms twice').toBeGreaterThan(200);
  expect(await selected(page), 'the brightness block no longer changes the color').toBe(color);
  expect((await page.evaluate(() => irodori.getHandState())).near).toBe(false);
});

test('H2 a connected block shows how to play until that play has happened once', async ({ page }) => {
  await page.addInitScript(() => {
    const characteristic = () => ({ addEventListener() {}, async startNotifications() {}, async writeValueWithResponse() {} });
    const characteristics = { indicate: characteristic(), notify: characteristic(), write: characteristic() };
    const device = {
      id: 'private-device-pa', name: 'MESH-100PA0000001', addEventListener() {},
      gatt: {
        async connect() { return { async getPrimaryService() { return { async getCharacteristic(uuid) {
          return uuid.startsWith('72c90005') ? characteristics.indicate : uuid.startsWith('72c90003') ? characteristics.notify : characteristics.write;
        } }; } }; },
        disconnect() {},
      },
    };
    Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { async requestDevice() { return device; } } });
  });
  const pa = prox => withChecksum([1, 0, 1, 0x24, prox & 255, (prox >> 8) & 255, 0, 1, 0, 0, 0, 0]);
  await page.goto('/?mochi=0');
  await expect(page.locator('#hint')).toBeHidden();
  await page.getByRole('button', { name: 'MESHをつなぐ' }).click();
  await expect(page.locator('#hint')).toBeVisible();
  await expect(page.locator('#hint')).toContainText('明るさ');
  await notify(page, pa(100), 'PA');
  await page.waitForTimeout(100);
  await notify(page, pa(900), 'PA');
  await page.waitForTimeout(400);
  await notify(page, pa(900), 'PA');
  await notify(page, pa(100), 'PA');
  await expect(page.locator('#hint')).toBeHidden();
});

test('P1 mochi: replaying the real brightness block recording squishes, throws and splats, then settles', async ({ page }) => {
  const { frames } = JSON.parse(readFileSync(new URL('./fixtures/pa-hand-20260913.json', import.meta.url), 'utf8'));
  await page.goto('/?mochi=1');
  const squashes = await page.evaluate(frames => new Promise(resolve => {
    const seen = [];
    frames.forEach(([at, bytes]) => setTimeout(() => {
      window.irodori.onMesh(Uint8Array.from(bytes), 'PA');
      seen.push(window.irodori.getMochiState().squash);
    }, at));
    setTimeout(() => resolve(seen), frames[frames.length - 1][0] + 50);
  }), frames);
  expect(Math.max(...squashes), 'a real hand squishes the mochi').toBeGreaterThan(0.3);
  await page.waitForTimeout(5000);
  const state = await page.evaluate(() => irodori.getMochiState());
  expect(state.active).toBe(true);
  expect(state.thrown, 'the four long presses in the recording throw mochi').toBeGreaterThanOrEqual(4);
  expect(state.splats).toBeGreaterThan(0);
  expect(state.flying).toBe(0);
  expect(Math.abs(state.squash), 'the mochi settles after the hand leaves').toBeLessThan(0.05);
  await page.keyboard.press('m');
  expect((await page.evaluate(() => irodori.getMochiState())).muted).toBe(true);
});

test('P2 mochi stays hidden on the normal page and when disabled', async ({ page }) => {
  await page.goto('/');
  expect((await page.evaluate(() => irodori.getMochiState())).active).toBe(false);
  await page.goto('/?mochi=0');
  expect((await page.evaluate(() => irodori.getMochiState())).active).toBe(false);
});

async function playHand(page, steps) {
  // steps: [[ms, proximity], ...] を実機と同じように時刻どおり流す
  const frames = steps.map(([at, prox]) => [at, [1, 0, 1, 0x20, prox & 255, (prox >> 8) & 255, 0, 1, 0, 0, 0, 0]]);
  await page.evaluate(frames => new Promise(resolve => {
    frames.forEach(([at, b]) => setTimeout(() => {
      const bytes = [...b, b.reduce((sum, v) => sum + v, 0) & 255];
      window.irodori.onMesh(Uint8Array.from(bytes), 'PA');
    }, at));
    setTimeout(resolve, frames[frames.length - 1][0] + 60);
  }), frames);
}
const ramp = (from, ms, prox) => Array.from({ length: Math.max(1, Math.round(ms / 50)) }, (_, i) => [from + i * 50, prox]);

test('G1 the five hand gestures and the release speed are told apart on 20 Hz proximity', async ({ page }) => {
  await page.goto('/?mochi=1&still=2');
  const last = async () => (await page.evaluate(() => irodori.getMochiState())).lastGesture;
  await playHand(page, [...ramp(0, 300, 40), [300, 640], [350, 40], [400, 40]]);
  expect(await last(), 'a 50 ms brush of the hand is ignored').toBeNull();
  await playHand(page, [...ramp(0, 300, 40), ...ramp(300, 150, 640), [450, 40], [500, 40]]);
  expect(await last()).toMatchObject({ kind: 'tap', fast: true });
  await playHand(page, [...ramp(0, 200, 40), ...ramp(200, 450, 640), [650, 40], [700, 40]]);
  expect(await last()).toMatchObject({ kind: 'short', fast: true });
  await playHand(page, [...ramp(0, 200, 40), ...ramp(200, 1300, 640), [1500, 400], [1550, 300], [1600, 250], [1650, 200], [1700, 160], [1750, 130], [1800, 100], [1850, 40]]);
  expect(await last(), 'a slow release is そっと').toMatchObject({ kind: 'long', fast: false });
  await playHand(page, [...ramp(0, 200, 40), ...ramp(200, 1500, 640).map(([t, p], i) => [t, p + (i % 2 ? 200 : -200)]), ...ramp(1700, 1300, 640).map(([t, p], i) => [t, p + (i % 2 ? 200 : -200)]), [3000, 40], [3050, 40]]);
  const grip = await page.evaluate(() => irodori.getMochiState());
  expect(grip.lastGesture, 'a wobbling long hold is a grip, not stillness').toMatchObject({ kind: 'grip' });
  expect(grip.gestures.still).toBe(0);
  await playHand(page, [...ramp(0, 200, 40), ...ramp(200, 2600, 640)]);
  await page.waitForTimeout(100);
  expect((await page.evaluate(() => irodori.getMochiState())).sleeping, 'holding still falls asleep').toBe(true);
  await playHand(page, [[0, 640], [50, 40], [100, 40]]);
  const woke = await page.evaluate(() => irodori.getMochiState());
  expect(woke.lastGesture.kind).toBe('wake');
  expect(woke.sleeping).toBe(false);
  expect(woke.gestures).toMatchObject({ tap: 1, short: 1, long: 1, grip: 1, still: 1, wake: 1 });
});

test('G2 the no-hand baseline does not creep toward a hand held near for a long time', async ({ page }) => {
  await page.goto('/?mochi=1');
  await playHand(page, [...ramp(0, 500, 40), ...ramp(500, 6000, 640)]);
  const hand = await page.evaluate(() => irodori.getHandState());
  expect(hand.near).toBe(true);
  expect(hand.lift, 'lift stays near 640 - 40 - 20').toBeGreaterThan(560);
});

test('J1 mochi jump: holding space longer jumps higher and the dashed guide predicts the apex', async ({ page }) => {
  await page.goto('/?game=1');
  await page.waitForTimeout(100);
  expect((await page.evaluate(() => irodori.getGameState())).on).toBe(true);
  await page.keyboard.down(' '); await page.waitForTimeout(400); await page.keyboard.up(' ');
  await page.waitForTimeout(2000);
  const low = await page.evaluate(() => irodori.getGameState());
  await page.keyboard.down(' '); await page.waitForTimeout(2000); await page.keyboard.up(' ');
  await page.waitForTimeout(3000);
  const high = await page.evaluate(() => irodori.getGameState());
  expect(high.jumps).toBe(2);
  expect(high.lastPredicted).toBeGreaterThan(low.lastPredicted * 1.8);
  expect(Math.abs(high.lastApex - high.lastPredicted) / high.lastPredicted, 'the guide matches the real apex within 15%').toBeLessThan(0.15);
});

test('J2 mochi jump: a star at the predicted height is caught and painted into the sky', async ({ page }) => {
  await page.goto('/?game=1');
  await page.waitForTimeout(100);
  const g = await page.evaluate(() => irodori.getGameState());
  const h = await page.evaluate(() => irodori.jumpHeight(1500));
  const R = await page.evaluate(() => irodori.getMochiState().squash !== undefined && Math.max(34, Math.min(innerWidth, innerHeight) * 0.12));
  await page.evaluate(({ x, y }) => irodori.gameSpawn(x, y, 0), { x: g.mochiX, y: g.ground - R * 0.5 - h * 0.9 });
  await page.keyboard.down(' '); await page.waitForTimeout(1500); await page.keyboard.up(' ');
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => ({ game: irodori.getGameState(), mochi: irodori.getMochiState() }));
  expect(after.game.score).toBeGreaterThanOrEqual(1);
  expect(after.mochi.splats).toBeGreaterThanOrEqual(1);
});

test('J3 mochi jump: pointer press-and-release jumps without drawing, G toggles back to drawing, real recording jumps', async ({ page }) => {
  const { frames } = JSON.parse(readFileSync(new URL('./fixtures/pa-hand-20260913.json', import.meta.url), 'utf8'));
  await page.goto('/');
  await page.keyboard.press('g');
  expect((await page.evaluate(() => irodori.getGameState())).on).toBe(true);
  await page.mouse.move(500, 300); await page.mouse.down(); await page.mouse.move(700, 320); await page.waitForTimeout(600); await page.mouse.up();
  await page.waitForTimeout(1800);
  expect((await page.evaluate(() => irodori.getGameState())).jumps).toBe(1);
  await page.evaluate(frames => new Promise(resolve => {
    frames.forEach(([at, bytes]) => setTimeout(() => window.irodori.onMesh(Uint8Array.from(bytes), 'PA'), at));
    setTimeout(resolve, frames[frames.length - 1][0] + 50);
  }), frames);
  await page.waitForTimeout(2500);
  // 記録の 101.5〜112 秒：地上からのジャンプ 3 回（握る 2・長め 1）。短めの 1 回は空中の「もう一段」になる
  expect((await page.evaluate(() => irodori.getGameState())).jumps, 'the recorded presses jump from the ground').toBeGreaterThanOrEqual(4);
  await page.keyboard.press('g');
  expect((await page.evaluate(() => irodori.getGameState())).on).toBe(false);
});

test('J4 mochi jump: stars appear across the whole reachable height range', async ({ page }) => {
  await page.goto('/?game=1');
  await page.waitForTimeout(100);
  const ys = await page.evaluate(() => { for (let i = 0; i < 60; i++) irodori.gameSpawn(); return true; });
  expect(ys).toBe(true);
  const spread = await page.evaluate(() => {
    const g = irodori.getGameState(), R = Math.max(34, Math.min(innerWidth, innerHeight) * 0.12), rest = g.ground - R * 0.5;
    return { rest, low: rest - irodori.jumpHeight(150), high: rest - irodori.jumpHeight(2500) * 0.95 };
  });
  const starYs = (await page.evaluate(() => irodori.getGameState())).starYs;
  expect(starYs).not.toBeNull();
  expect(Math.min(...starYs)).toBeLessThan(spread.high + (spread.low - spread.high) * 0.25);
  expect(Math.max(...starYs)).toBeGreaterThan(spread.low - (spread.low - spread.high) * 0.25);
});

test('S1 M mutes once per press, ignores key repeat, and still works from inside the diagnostics panel', async ({ page }) => {
  await page.goto('/?mochi=1&debug=1');
  const muted = async () => (await page.evaluate(() => irodori.getMochiState())).muted;
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    for (let i = 0; i < 5; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', repeat: true, bubbles: true }));
  });
  expect(await muted(), 'holding M keeps it muted').toBe(true);
  await page.locator('#debug-copy').focus();
  await page.keyboard.press('m');
  expect(await muted(), 'M works while a diagnostics button has focus').toBe(false);
});

test('K1 the あそぶ button toggles the game, and G works by key position even with Japanese input or Shift', async ({ page }) => {
  await page.goto('/');
  const on = async () => (await page.evaluate(() => irodori.getGameState())).on;
  await page.getByRole('button', { name: 'あそぶ' }).click();
  expect(await on()).toBe(true);
  await expect(page.locator('#game')).toHaveText('えにもどる');
  await page.keyboard.down(' '); await page.waitForTimeout(300); await page.keyboard.up(' ');
  expect(await on(), 'space after clicking the button charges a jump instead of pressing the button again').toBe(true);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: 'KeyG', bubbles: true })));
  expect(await on(), 'IME composing key still toggles by code').toBe(false);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', code: 'KeyG', shiftKey: true, bubbles: true })));
  expect(await on()).toBe(true);
  await expect(page.locator('#game')).toHaveText('えにもどる');
});

test('O1 the mochi talks: greets, teaches press and release, slows its words while pressed, and strains when held', async ({ page }) => {
  await page.goto('/?mochi=1');
  await expect(page.locator('#talk')).toBeVisible();
  await expect(page.locator('#talk')).toContainText('もち');
  // press and hold 1.2 s: onboarding moves on, words come slowly, the mochi strains
  await playHand(page, [...ramp(0, 150, 40), ...ramp(150, 400, 640)]);
  expect((await page.evaluate(() => irodori.getTalkState())).step).toBe(2);
  await expect(page.locator('#talk')).toContainText('むに');
  const a = (await page.evaluate(() => irodori.getTalkState())).shown;
  await playHand(page, ramp(0, 600, 640));
  const held = await page.evaluate(() => ({ talk: irodori.getTalkState(), strain: irodori.getStrain() }));
  expect(held.talk.shown - a, 'at most ~4 characters in 600 ms while pressed').toBeLessThanOrEqual(5);
  expect(held.strain.strain).toBe(true);
  expect(held.strain.umu).toBe(1);
  await playHand(page, [[0, 640], [50, 40], [100, 40]]);
  expect((await page.evaluate(() => irodori.getTalkState())).step).toBe(3);
  await expect(page.locator('#talk')).toContainText('とんだ');
});

test('B1 every 5 points goes boom, and 20 points brings the dawn instead', async ({ page }) => {
  await page.goto('/?game=1');
  await page.waitForTimeout(150);
  await page.evaluate(() => { const g = irodori.getGameState(); for (let i = 0; i < 5; i++) irodori.gameSpawn(g.mochiX, g.mochiY, 0); });
  await page.waitForTimeout(400);
  let g = await page.evaluate(() => irodori.getGameState());
  expect(g.score).toBeGreaterThanOrEqual(5);
  expect(g.booms).toBeGreaterThanOrEqual(1);
  await expect(page.locator('#talk')).toContainText(/ドーン|とれた/);
  expect((await page.evaluate(() => irodori.getTalkState())).step, 'starting in the game skips the drawing lessons').toBe(4);
});

test('A1 in the game, shaking the motion block pulls the stars down to the mochi and tapping makes it hop', async ({ page }) => {
  await page.goto('/?game=1');
  await page.waitForTimeout(200);
  await page.evaluate(() => { for (let i = 0; i < 4; i++) irodori.gameSpawn(innerWidth * 0.8, 120 + i * 40, 0); });
  await notify(page, acFrame(1), 'AC');
  await page.waitForTimeout(2500);
  const g = await page.evaluate(() => irodori.getGameState());
  expect(g.shakes).toBe(1);
  expect(g.score, 'the shaken stars reach the mochi').toBeGreaterThanOrEqual(4);
  await page.waitForTimeout(500);
  await notify(page, acFrame(0), 'AC');
  await page.waitForTimeout(450);
  expect((await page.evaluate(() => irodori.getGameState())).jumps).toBe(1);
});

test('C1 catching stars in one jump chains a combo, links a constellation, and scores a bonus; shooting stars give 5', async ({ page }) => {
  await page.goto('/?game=1');
  await page.waitForTimeout(200);
  const g0 = await page.evaluate(() => irodori.getGameState());
  const R = await page.evaluate(() => Math.max(34, Math.min(innerWidth, innerHeight) * 0.12));
  const h = await page.evaluate(() => irodori.jumpHeight(2500));
  await page.evaluate(({ x, ground, R, h }) => { for (const f of [0.35, 0.6, 0.85]) irodori.gameSpawn(x, ground - R * 0.5 - h * f, 0); }, { x: g0.mochiX, ground: g0.ground, R, h });
  await page.keyboard.down(' '); await page.waitForTimeout(2600); await page.keyboard.up(' ');
  // 固定の待ち時間ではなく、着地して星座ができるまで待つ（負荷でフレームが落ちても揺れない）
  await expect.poll(async () => (await page.evaluate(() => irodori.getGameState())).constellations, { timeout: 15000 }).toBe(1);
  await expect.poll(async () => (await page.evaluate(() => irodori.getGameState())).airborne, { timeout: 15000 }).toBe(false);
  const g = await page.evaluate(() => irodori.getGameState());
  expect(g.maxCombo).toBeGreaterThanOrEqual(3);
  expect(g.constellations).toBe(1);
  expect(g.score, '1+2+3 for the chain and +3 for the constellation').toBeGreaterThanOrEqual(9);
  await page.evaluate(({ x, y }) => irodori.gameSpawn(x, y, 0, true), { x: g0.mochiX, y: g0.mochiY });
  await expect.poll(async () => (await page.evaluate(() => irodori.getGameState())).shootings, { timeout: 5000 }).toBe(1);
  const s = await page.evaluate(() => irodori.getGameState());
  expect(s.score - g.score).toBeGreaterThanOrEqual(5);
});

test('F1 leaving the game puts the mochi away again when it was not out before, and the おと button mutes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'あそぶ' }).click();
  expect((await page.evaluate(() => irodori.getMochiState())).active).toBe(true);
  await page.getByRole('button', { name: 'えにもどる' }).click();
  expect((await page.evaluate(() => irodori.getMochiState())).active).toBe(false);
  await page.getByRole('button', { name: 'おと', exact: true }).click();
  expect((await page.evaluate(() => irodori.getMochiState())).muted).toBe(true);
  await expect(page.locator('#sound')).toHaveText('おと なし');
});

test('W1 the button launches a rocket that collects stars in the game, and shaking cycles the planets behind the painting', async ({ page }) => {
  await page.goto('/?game=1');
  await page.waitForTimeout(300);
  const g0 = await page.evaluate(() => irodori.getGameState());
  const R = await page.evaluate(() => Math.max(34, Math.min(innerWidth, innerHeight) * 0.12));
  await page.evaluate(({ x, R }) => { for (const y of [500, 380, 260]) irodori.gameSpawn(x + R * 1.3, y, 0); }, { x: g0.mochiX, R });
  await notify(page, withChecksum([1, 0, 1]), 'BU');
  expect((await page.evaluate(() => irodori.getRocketState())).launched).toBe(1);
  await page.waitForTimeout(4500);
  const g = await page.evaluate(() => ({ game: irodori.getGameState(), rocket: irodori.getRocketState() }));
  expect(g.rocket.flying).toBe(0);
  expect(g.game.score, 'the rocket collected the stars on its way').toBeGreaterThanOrEqual(3);
  expect(g.game.constellations).toBe(1);
  const names = [];
  for (let i = 0; i < 5; i++) { await page.keyboard.press('b'); names.push((await page.evaluate(() => irodori.getScene())).name); await page.waitForTimeout(120); }
  expect(names).toEqual(['げつめん', 'かせい', 'もくせい', 'どせい', 'よぞら']);
  await page.waitForTimeout(700);
  await notify(page, acFrame(1), 'AC');
  expect((await page.evaluate(() => irodori.getScene())).name).toBe('げつめん');
});

test('I1 the opening: a big centered mochi greets in hiragana, a tap skips it, then the mochi can be pressed with a finger', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto('/?intro=1');
  await expect(page.locator('#talk')).toContainText('さわってね');
  expect((await page.evaluate(() => irodori.getIntro())).phase).toBe('wait');
  await page.mouse.click(900, 100);
  await expect(page.locator('#talk')).toContainText('こんにちは');
  expect((await page.evaluate(() => irodori.getIntro())).phase).toBe('show');
  const talk = await page.locator('#talk').textContent();
  expect(talk, 'no kanji in the greeting').not.toMatch(/[一-鿿]/);
  await page.mouse.click(900, 100);
  await page.waitForTimeout(1000);
  expect((await page.evaluate(() => irodori.getIntro())).phase).toBe('done');
  await expect(page.locator('#talk')).toContainText('おしてみて');
  const m = await page.evaluate(() => irodori.getGameState());
  await page.mouse.move(m.mochiX, m.mochiY); await page.mouse.down(); await page.waitForTimeout(1100); await page.mouse.up();
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => irodori.getMochiState());
  expect(st.gestures.long, 'a finger press on the mochi is a long press').toBe(1);
  expect(st.thrown).toBeGreaterThan(0);
});

test('R1 reduced-motion keeps blossoms with fewer actual particles and gentler background changes', async ({ page }) => {
  await page.goto('/');
  const normal = await page.evaluate(() => { irodori.firework(300, 200); return irodori.getMotionState(); });
  expect(normal.sparkCount).toBe(90);
  expect(normal.reducedMotion).toBe(false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  const reduced = await page.evaluate(() => { irodori.firework(300, 200); return irodori.getMotionState(); });
  expect(reduced.reducedMotion).toBe(true);
  expect(reduced.sparkCount).toBe(30);
  expect(reduced.sparkCount).toBeLessThan(normal.sparkCount);
  expect(reduced.sparkCount).toBeGreaterThan(0);
  expect(reduced.warmth).toBeLessThan(normal.warmth);
  await page.waitForTimeout(150);
  const displayed = await page.evaluate(() => irodori.getMotionState());
  expect(displayed.displayedWarmth).toBeGreaterThan(0);
  expect(displayed.displayedWarmth).toBeLessThan(displayed.warmth / 2);
  await page.reload();
  expect(await page.evaluate(() => { irodori.firework(300, 200, 205, true); return irodori.getMotionState().sparkCount; })).toBe(50);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => page.evaluate(() => irodori.getMotionState().reducedMotion)).toBe(false);
  await page.reload();
  expect(await page.evaluate(() => { irodori.firework(300, 200, 205, true); return irodori.getMotionState().sparkCount; })).toBe(150);
});
