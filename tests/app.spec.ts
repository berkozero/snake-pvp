import { expect, test } from '@playwright/test';

test('boots into the menu and starts the match flow', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByTestId('menu-overlay')).toBeVisible();
  await expect(page.getByTestId('timer-value')).toHaveText('3:00');

  await page.getByTestId('start-match').click();
  await expect(page.getByTestId('countdown-overlay')).toBeVisible();
  await page.waitForFunction(() => window.__SNAKE_PVP_STATE__?.phase === 'playing');

  await expect(page.locator('[data-phase="playing"]')).toBeVisible();
  await expect(page.getByTestId('game-canvas')).toBeVisible();
});

test('pause freezes the timer and resume continues it', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('start-match').click();
  await page.waitForFunction(() => window.__SNAKE_PVP_STATE__?.phase === 'playing');

  const beforePause = await page.getByTestId('timer-value').textContent();
  await page.getByTestId('game-canvas').click();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('paused-overlay')).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.getByTestId('timer-value')).toHaveText(beforePause ?? '');

  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__SNAKE_PVP_STATE__?.phase === 'playing');
  await expect(page.getByTestId('paused-overlay')).toBeHidden();
});

test('keyboard controls move both players', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('start-match').click();
  await page.waitForFunction(() => window.__SNAKE_PVP_STATE__?.phase === 'playing');

  const startState = await page.evaluate(() => window.__SNAKE_PVP_TEST_API__?.snapshot());
  await page.getByTestId('game-canvas').click();
  await page.keyboard.press('w');
  await page.keyboard.press('i');
  await page.waitForTimeout(220);

  const nextState = await page.evaluate(() => window.__SNAKE_PVP_TEST_API__?.snapshot());
  expect(startState?.players.p1.head).not.toEqual(nextState?.players.p1.head);
  expect(startState?.players.p2.head).not.toEqual(nextState?.players.p2.head);
  expect(nextState?.players.p1.direction).toBe('up');
  expect(nextState?.players.p2.direction).toBe('up');
});

test('shows the winner screen and can return to title', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    window.__SNAKE_PVP_TEST_API__?.setState((current) => ({
      ...current,
      phase: 'finished',
      winner: 'p1',
      players: {
        ...current.players,
        p1: { ...current.players.p1, score: 5 },
        p2: { ...current.players.p2, score: 2 },
      },
    }));
  });

  await expect(page.getByTestId('finished-overlay')).toBeVisible();
  await expect(page.getByTestId('winner-label')).toHaveText('P1 Wins');

  await page.getByTestId('back-to-title').click();
  await expect(page.getByTestId('menu-overlay')).toBeVisible();
  await expect(page.getByTestId('timer-value')).toHaveText('3:00');
});

test('shows a respawn countdown in the dead player HUD card', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    window.__SNAKE_PVP_TEST_API__?.setState((current) => ({
      ...current,
      phase: 'playing',
      countdownMs: 0,
      players: {
        ...current.players,
        p2: {
          ...current.players.p2,
          alive: false,
          segments: [],
          respawnAt: Date.now() + 2300,
        },
      },
    }));
  });

  await expect(page.getByTestId('p2-score')).toContainText('Respawn');
  await page.waitForTimeout(1400);
  await expect(page.getByTestId('p2-score')).toContainText('Respawn 1');
});
