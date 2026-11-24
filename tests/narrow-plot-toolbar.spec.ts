import { test, expect, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Three Plot panels share a row in the auto layout of a robot recording. At a 1024 px window each
 * is about a quarter of the screen wide, and in zh the JointState field tabs (位置 / 速度 / 力矩)
 * used to wrap one character per line while the "加载中" status ran past the panel edge.
 *
 * Every piece of toolbar text must render on one line (its height equals its line height) and
 * stay inside the toolbar; text that does not fit is ellipsized and carries its full text as a
 * tooltip.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

test.describe.configure({ mode: 'serial', timeout: 120_000 });

let dir: string;
let server: ChildProcess;
let origin: string;

test.beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'rosview-narrow-plots-'));
  execFileSync('node', [path.join(here, '../scripts/gen-test-mcap-stream-3cam.mjs'), path.join(dir, 'robot.mcap'), '12', '40'], {
    stdio: 'ignore',
  });
  // A slow link keeps the plots loading, so the loading status shares the toolbar with the tabs.
  server = spawn('node', [path.join(here, '../scripts/throttled-range-server.mjs'), dir, '--port', '0', '--mbps', '8'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  origin = await new Promise<string>((resolve, reject) => {
    server.once('exit', (code) => reject(new Error(`range server exited (${code})`)));
    server.stdout!.on('data', (data: Buffer) => {
      const m = /on :(\d+)/.exec(data.toString());
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
  });
});

test.afterAll(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

type TextBox = { text: string; lines: number; height: number; lineHeight: number; overflowsToolbar: boolean; clippedWithoutTitle: boolean };

/** Every element inside `root` that directly holds visible text, with how that text is laid out. */
async function measureText(page: Page, rootSelector: string): Promise<TextBox[][]> {
  return page.evaluate((selector) => {
    const roots = Array.from(document.querySelectorAll<HTMLElement>(selector));
    return roots.map((root) => {
      const rootRect = root.getBoundingClientRect();
      const out: TextBox[] = [];
      for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
        if (el.closest('[aria-hidden="true"]')) continue;
        const textNodes = Array.from(el.childNodes).filter(
          (n): n is Text => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
        );
        if (textNodes.length === 0) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || el.getClientRects().length === 0) continue;
        const range = document.createRange();
        range.setStartBefore(textNodes[0]);
        range.setEndAfter(textNodes[textNodes.length - 1]);
        const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
        if (rects.length === 0) continue;
        // One line box per distinct top: a label wrapped per character yields one per character.
        const lines = new Set(rects.map((r) => Math.round(r.top))).size;
        const bounds = range.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const text = textNodes.map((n) => n.textContent ?? '').join('').trim();
        const clipped = el.scrollWidth > el.clientWidth + 1;
        out.push({
          text,
          lines,
          height: Math.round(bounds.height),
          lineHeight: Math.round(rects[0].height),
          overflowsToolbar: elRect.right > rootRect.right + 1 || elRect.left < rootRect.left - 1,
          clippedWithoutTitle: clipped && !(el.title || el.closest('[title]')?.getAttribute('title')),
        });
      }
      return out;
    });
  }, rootSelector);
}

function violations(boxes: TextBox[]): string[] {
  const problems: string[] = [];
  for (const b of boxes) {
    if (b.lines !== 1 || b.height > b.lineHeight + 1) {
      problems.push(`"${b.text}" wraps onto ${b.lines} lines (${b.height}px for a ${b.lineHeight}px line)`);
    }
    if (b.overflowsToolbar) problems.push(`"${b.text}" runs past the toolbar edge`);
    if (b.clippedWithoutTitle) problems.push(`"${b.text}" is cut off without a tooltip`);
  }
  return problems;
}

test('zh plot toolbars in a narrow auto-layout row keep every tab and status on one line', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.addInitScript(() => {
    (window as unknown as { __rosviewHostProps: unknown }).__rosviewHostProps = {
      preferAutoLayout: true,
      preferencePersistence: 'off',
      layoutPersistence: 'off',
      language: 'zh',
    };
  });
  // The zh UI names the transport buttons in Chinese, so wait on the player rather than "Play playback".
  await page.goto(`/?url=${encodeURIComponent(`${origin}/robot.mcap`)}`);
  await expect(page.locator('#rosview-root')).toHaveAttribute('data-language', 'zh');
  await expect(page.locator('#rosview-root')).toHaveAttribute('data-player-presence', 'ready', { timeout: 60_000 });

  const panels = page.getByTestId('plot-panel');
  await expect(panels).toHaveCount(3, { timeout: 30_000 });
  // Panels as narrow as the reported layout: three plots in a row on a 1024 px window.
  for (let i = 0; i < 3; i++) {
    expect((await panels.nth(i).boundingBox())!.width).toBeLessThan(320);
  }
  // Both JointState plots show their field tabs once the topic's paths are detected.
  const jointPanels = panels.filter({ hasText: '位置' });
  await expect(jointPanels).toHaveCount(2, { timeout: 30_000 });
  // The loading status shares the toolbar with the tabs while the window streams in.
  const toolbars = '[data-testid="plot-panel"] > :first-child';
  await expect(page.locator(toolbars).filter({ hasText: '加载中' }).first()).toBeVisible({ timeout: 30_000 });

  const toolbarProblems = (await measureText(page, toolbars)).flatMap(violations);
  expect(toolbarProblems).toEqual([]);

  // Tabs folded into a menu for want of room still list every field on one line each.
  const fieldMenus = page.getByTestId('plot-field-menu');
  await expect(fieldMenus).toHaveCount(2);
  await fieldMenus.first().click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(3);
  await expect(menu.getByRole('menuitemcheckbox', { name: '位置' })).toHaveAttribute('aria-checked', 'true');
  const menuProblems = (await measureText(page, '[role="menu"]')).flatMap(violations);
  expect(menuProblems).toEqual([]);
  // Toggling a field from the menu keeps it open for the next choice and updates the trigger.
  await menu.getByRole('menuitemcheckbox', { name: '速度' }).click();
  await expect(menu.getByRole('menuitemcheckbox', { name: '速度' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(fieldMenus.first()).toHaveText('位置+1');
  await expect(fieldMenus.first()).toHaveAttribute('title', '位置, 速度');
  expect((await measureText(page, toolbars)).flatMap(violations)).toEqual([]);

  // With room again the tabs come back, each on one line.
  await page.setViewportSize({ width: 1920, height: 768 });
  await expect(fieldMenus).toHaveCount(0);
  await expect(page.getByTestId('plot-field-tab')).toHaveText(['位置', '速度', '力矩', '位置', '速度', '力矩']);
  expect((await measureText(page, toolbars)).flatMap(violations)).toEqual([]);
});
