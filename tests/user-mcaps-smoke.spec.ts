import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measurePlaybackPerf } from './helpers/playbackPerf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_MCAPS_DIR = path.join(__dirname, '../public/user-mcaps');

type UserMcap = {
  id: string;
  url: string;
  bytes: number;
};

function listUserMcaps(): UserMcap[] {
  if (!existsSync(USER_MCAPS_DIR)) {
    return [];
  }
  return readdirSync(USER_MCAPS_DIR)
    .filter((name) => name.endsWith('.mcap'))
    .map((name) => ({
      id: name.replace(/\.mcap$/u, ''),
      url: `/user-mcaps/${name}`,
      bytes: statSync(path.join(USER_MCAPS_DIR, name)).size,
    }))
    .sort((a, b) => a.bytes - b.bytes);
}

const fixtures = listUserMcaps();

test.describe('Downloads MCAP playback smoke', () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(() => {
    test.skip(fixtures.length === 0, 'public/user-mcaps is empty');
  });

  for (const fixture of fixtures) {
    test(`${fixture.id} (${(fixture.bytes / (1024 * 1024)).toFixed(1)} MiB)`, async ({ page }) => {
      const readyTimeoutMs = fixture.bytes > 80 * 1024 * 1024 ? 180_000 : fixture.bytes > 20 * 1024 * 1024 ? 90_000 : 60_000;
      await page.goto(`/?url=${encodeURIComponent(fixture.url)}`, { waitUntil: 'domcontentloaded' });
      const root = page.locator('#rosview-root');
      await expect.poll(async () => root.getAttribute('data-player-presence'), { timeout: readyTimeoutMs }).toMatch(
        /ready|closed/,
      );

      const presence = await root.getAttribute('data-player-presence');
      await expect(root).toHaveAttribute('data-player-buffering', 'false');

      if (presence === 'closed') {
        await expect(page.getByTestId('rosview-playback-error')).toHaveCount(0);
        return;
      }

      const noTopics = await page.getByText('No topics found').isVisible().catch(() => false);
      const timeLine = page.getByTestId('playback-time-line');
      await expect.poll(async () => (await timeLine.textContent()) ?? '', { timeout: 10_000 }).toMatch(/\//);
      const timeText = (await timeLine.textContent().catch(() => '')) ?? '';
      const zeroDuration = /00:00\.000\s*\/\s*00:00\.000/.test(timeText);
      if (noTopics || zeroDuration) {
        await expect(page.getByTestId('rosview-playback-error')).toHaveCount(0);
        return;
      }

      const playTimeoutMs = fixture.bytes > 80 * 1024 * 1024 ? 20_000 : 12_000;
      const metrics = await measurePlaybackPerf(page, fixture.id, fixture.url, {
        readyTimeoutMs,
        playTimeoutMs,
      });
      expect(metrics.readyMs).toBeLessThan(readyTimeoutMs);
      expect(metrics.playAdvanceMs).toBeLessThan(playTimeoutMs);
      expect(metrics.seekAdvanceMs).toBeLessThan(playTimeoutMs);
      expect(metrics.bufferingStuckMs).toBeLessThan(3_000);
      await expect(root).toHaveAttribute('data-player-buffering', 'false');
      await expect(page.getByTestId('rosview-playback-error')).toHaveCount(0);
      console.log(JSON.stringify(metrics));
    });
  }
});
