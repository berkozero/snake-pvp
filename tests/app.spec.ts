import { expect, test } from '@playwright/test';

async function joinSlot(page: import('@playwright/test').Page, name: string, slot: 'p1' | 'p2') {
  await page.goto('/');
  await expect(page.getByTestId('players-card')).toBeVisible();
  await page.getByTestId(slot === 'p1' ? 'name-input-p1' : 'name-input-p2').fill(name);
  await page.getByTestId(slot === 'p1' ? 'claim-p1' : 'claim-p2').click();
  await page.waitForFunction((expectedSlot) => window.__SNAKE_PVP_STATE__?.yourSlot === expectedSlot, slot);
}

async function snapshot(page: import('@playwright/test').Page) {
  return page.evaluate(() => window.__SNAKE_PVP_TEST_API__?.snapshot());
}

async function pressGameKey(page: import('@playwright/test').Page, key: string) {
  await page.evaluate((nextKey) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: nextKey, bubbles: true }));
  }, key);
}

test.describe.configure({ mode: 'serial' });

test('two clients join, get ownership, and start a live match', async ({ browser }) => {
  const p1 = await browser.newPage();
  const p2 = await browser.newPage();

  await joinSlot(p1, 'Alpha', 'p1');
  await joinSlot(p2, 'Bravo', 'p2');

  await p1.waitForFunction(() => window.__SNAKE_PVP_STATE__?.phase === 'ready');
  await p2.waitForFunction(() => window.__SNAKE_PVP_STATE__?.phase === 'ready');

  await pressGameKey(p1, 'Enter');
  await expect(p1.getByTestId('countdown-overlay')).toBeVisible();
  await expect(p2.getByTestId('countdown-overlay')).toBeVisible();

  await pressGameKey(p1, 'ArrowUp');

  await p1.waitForFunction(() => window.__SNAKE_PVP_STATE__?.phase === 'playing');
  await p2.waitForFunction(() => window.__SNAKE_PVP_STATE__?.phase === 'playing');
  await p1.waitForFunction(() => window.__SNAKE_PVP_STATE__?.game?.players.p1.direction === 'up');

  let p1State = await snapshot(p1);
  let p2State = await snapshot(p2);

  expect(p1State?.yourSlot).toBe('p1');
  expect(p2State?.yourSlot).toBe('p2');
  expect(p1State?.game?.players.p1.direction).toBe('up');
  expect(p1State?.phase).toBe('playing');
  expect(p2State?.phase).toBe('playing');

  await p1.waitForFunction(() => window.__SNAKE_PVP_STATE__?.phase === 'empty');
  await p2.waitForFunction(() => window.__SNAKE_PVP_STATE__?.phase === 'empty');

  await p1.close();
  await p2.close();
});

test('third client sees full-room state only', async ({ browser }) => {
  const p1 = await browser.newPage();
  const p2 = await browser.newPage();
  const viewer = await browser.newPage();

  await joinSlot(p1, 'Alpha', 'p1');
  await joinSlot(p2, 'Bravo', 'p2');
  await viewer.goto('/');

  await expect(viewer.getByTestId('viewer-overlay')).toBeVisible();
  await expect(viewer.getByTestId('claim-p1')).toHaveCount(0);
  await expect(viewer.getByTestId('claim-p2')).toHaveCount(0);

  await p2.getByTestId('leave-slot').click();
  await expect(viewer.getByTestId('lobby-overlay')).toBeVisible();
  await p1.getByTestId('leave-slot').click();

  await p1.close();
  await p2.close();
  await viewer.close();
});

test('disconnect grace restores the same player and still blocks a fresh viewer', async ({ browser }) => {
  const owner = await browser.newPage();
  const challenger = await browser.newPage();

  await joinSlot(owner, 'Alpha', 'p1');
  await owner.reload();
  await challenger.waitForTimeout(250);
  await owner.waitForFunction(() => window.__SNAKE_PVP_STATE__?.yourSlot === 'p1');
  await expect(owner.getByTestId('slot-p1')).toContainText('Alpha');

  await challenger.goto('/');
  await expect(challenger.getByTestId('players-card')).toBeVisible();
  await expect(challenger.getByTestId('slot-p1')).toContainText('Connected');
  await expect(challenger.getByTestId('claim-p1')).toBeDisabled();

  await owner.getByTestId('leave-slot').click();
  await owner.close();
  await challenger.close();
});

test('timer, result, and reset are driven by server snapshots', async ({ browser }) => {
  const p1 = await browser.newPage();
  const p2 = await browser.newPage();

  await joinSlot(p1, 'Alpha', 'p1');
  await joinSlot(p2, 'Bravo', 'p2');
  await p1.getByTestId('start-match').click();

  await p1.waitForFunction(() => {
    const remainingMs = window.__SNAKE_PVP_STATE__?.game?.remainingMs;
    return typeof remainingMs === 'number' && remainingMs <= 1_000;
  });
  await p1.waitForFunction(() => window.__SNAKE_PVP_STATE__?.phase === 'finished');
  await expect(p1.getByTestId('finished-overlay')).toBeVisible();
  await expect(p1.getByTestId('winner-label')).toHaveText(/Wins|Draw/);

  await p1.waitForFunction(() => window.__SNAKE_PVP_STATE__?.phase === 'empty');
  await expect(p1.getByTestId('lobby-overlay')).toBeVisible();
  await expect(p1.getByTestId('slot-p1')).toContainText('P1');
  await expect(p1.getByTestId('slot-p2')).toContainText('P2');

  await p1.close();
  await p2.close();
});
