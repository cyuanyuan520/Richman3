import { expect, test } from '@playwright/test';

/**
 * Desktop smoke flows.
 *
 * These cover the shell and one full single-player turn rather than every
 * screen: the rules engine, content, audio and settings stores have their own
 * unit suites, and duplicating them here would only make the run slower.
 */

test('menu, rules and back', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('button', { name: '单人开局' })).toBeVisible();
  await expect(page.getByRole('button', { name: '联机对战' })).toBeVisible();

  await page.getByRole('button', { name: '规则说明' }).click();
  await expect(page.getByRole('button', { name: '返回' })).toBeVisible();
  await expect(page.getByText('掷骰移动，停在格子上结算事件。')).toBeVisible();

  await page.getByRole('button', { name: '返回' }).click();
  await expect(page.getByRole('button', { name: '单人开局' })).toBeVisible();
});

test('settings screen opens and closes', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('button', { name: '完成' })).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复默认' })).toBeVisible();

  await page.getByRole('button', { name: '完成' }).click();
  await expect(page.getByRole('button', { name: '单人开局' })).toBeVisible();
});

test('single-player turn: board renders and a roll resolves', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '单人开局' }).click();
  await page.getByRole('button', { name: '开始游戏' }).click();

  const roll = page.getByRole('button', { name: '掷骰子' });
  await expect(roll).toBeVisible({ timeout: 30_000 });

  // The canvas is the renderer's only proof of life from the DOM.
  await expect(page.locator('canvas')).toBeVisible();

  // Roll, then prove the engine actually advanced by reading the event feed.
  // Asserting that the roll button disappears is racy: three AI seats act
  // between this turn and the next, so it can reappear well inside the wait.
  await page.getByRole('button', { name: '掷骰子' }).click();

  // After the roll the seat is either offered the property or asked to end its
  // turn, and that state persists until the next click, so it is a stable
  // signal that the intent reached the engine.
  await expect(
    page.getByRole('button', { name: '结束回合' }).or(page.getByRole('button', { name: '购买' })),
  ).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: '战报' }).click();
  await expect(page.locator('.feed-panel')).toBeVisible();
});

test('share link routes into the joining flow', async ({ page }) => {
  await page.goto('/?room=rm3-23456789ABCDEFGHJKMNP');
  await expect(page.getByRole('button', { name: '加入' })).toBeVisible();
});
