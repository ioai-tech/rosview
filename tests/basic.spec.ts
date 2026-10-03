import { test, expect } from '@playwright/test';
import { MCAP_BASIC_URL, requireExamplesDir } from './fixturePaths';
import {
  attachBrowserDiagnostics,
  expectDockviewTopic,
  openFixtureByUrl,
} from './helpers/rosview';

test.beforeAll(() => {
  requireExamplesDir();
});

test('renders welcome screen initially', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('ROS View');
  await expect(page.getByRole('button', { name: 'Choose file' })).toBeVisible();
});

test('can trigger file input from welcome screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Choose file' })).toBeEnabled();
});

test('margin utilities on <p> survive the SPA shell reset', async ({ page }) => {
  // Tailwind v4 emits utilities inside `@layer utilities`, and an unlayered
  // declaration beats every layered one. The SPA shell reset in
  // src/entrypoints/standalone.css therefore has to stay in `@layer base`,
  // otherwise `mt-4` / `mx-auto` on this hero paragraph silently stop
  // applying (the subtitle snaps to the left edge and the page shifts up).
  await page.goto('/');
  const subtitle = page.locator('#rosview-root p[data-readability]');
  await expect(subtitle).toBeVisible();
  const measured = await subtitle.evaluate((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const parent = el.parentElement!.getBoundingClientRect();
    return {
      marginTop: style.marginTop,
      insetLeft: box.left - parent.left,
      insetRight: parent.right - box.right,
    };
  });
  expect(measured.marginTop).not.toBe('0px');
  expect(Math.abs(measured.insetLeft - measured.insetRight)).toBeLessThan(1);
});

test('language dropdown menu opens from icon button', async ({ page }) => {
  await page.goto('/');
  await page.locator('nav').getByLabel('Select language').first().click();
  await expect(page.getByRole('menuitem', { name: 'English' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Simplified Chinese' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Japanese' })).toBeVisible();
});

test('layout menu lists import, export, save, reset', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('navbar-layout-menu-trigger').click();
  await expect(page.getByRole('menuitem', { name: 'Import layout' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Export layout' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Save layout' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Reset saved layout' })).toBeVisible();
  await expect(page.locator('#rosview-navbar-layout-import')).toBeAttached();
});

test.describe('MCAP playback', () => {
  test.describe.configure({ timeout: 90_000 });

  test('keyboard shortcuts work', async ({ page }) => {
    const diagnostics = attachBrowserDiagnostics(page);
    await openFixtureByUrl(page, MCAP_BASIC_URL, { diagnostics });
    await expectDockviewTopic(page, '/camera/');

    await page.evaluate(() => {
      const el = document.activeElement;
      if (el instanceof HTMLElement) el.blur();
    });

    const loopMode = page.getByTestId('playback-loop-trigger');
    await expect(loopMode).toBeVisible();
    await expect(loopMode).toContainText('Loop');
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Play playback' })).toBeVisible();
  });

  test('playback bar supports hover, drag and loop menu', async ({ page }) => {
    await openFixtureByUrl(page, MCAP_BASIC_URL);
    await expectDockviewTopic(page, '/camera/');

    const track = page.getByTestId('playback-track');
    await expect(track).toBeVisible();
    await track.hover();
    await expect(page.getByTestId('playback-hover-time')).toBeVisible();

    const box = await track.boundingBox();
    if (!box) {
      throw new Error('playback-track has no bounding box');
    }
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
    await page.mouse.up();

    await expect(page.getByTestId('playback-thumb')).toBeVisible();

    const loopMode = page.getByTestId('playback-loop-trigger');
    await expect(loopMode).toContainText('Loop');
    await loopMode.click();
    await page.getByTestId('playback-loop-option-once').click();
    await expect(loopMode).toContainText('Once');
    await loopMode.click();
    await page.getByTestId('playback-loop-option-loop').click();
    await expect(loopMode).toContainText('Loop');
  });

  test('playback updates image frames and supports sampling FPS switch', async ({ page }) => {
    await openFixtureByUrl(page, MCAP_BASIC_URL);
    await expectDockviewTopic(page, '/camera/');

    const fpsSelect = page.getByTestId('playback-fps-trigger');
    await expect(fpsSelect).toBeVisible();
    await fpsSelect.click();
    await page.getByTestId('playback-fps-option-15').click();
    await expect(fpsSelect).toContainText('15');

    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: 45_000 });
    await page.getByRole('button', { name: 'Play playback' }).click();
    await expect(canvas).toBeVisible();
  });

  test('dockview main region resizes with the window', async ({ page }) => {
    const prev = page.viewportSize();
    await openFixtureByUrl(page, MCAP_BASIC_URL);
    await expectDockviewTopic(page, '/camera/');

    const dock = page.getByTestId('rosview-dockview');
    const box1 = await dock.boundingBox();
    expect(box1 && box1.width > 80 && box1.height > 80).toBeTruthy();

    await page.setViewportSize({ width: 720, height: 520 });
    await expect(async () => {
      const box2 = await dock.boundingBox();
      expect(
        box2 &&
          box1 &&
          (Math.abs(box2.width - box1.width) > 2 || Math.abs(box2.height - box1.height) > 2),
      ).toBeTruthy();
    }).toPass({ timeout: 15_000, intervals: [50, 100, 200, 400] });

    if (prev) {
      await page.setViewportSize({ width: prev.width, height: prev.height });
    }
  });
});
