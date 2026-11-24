import { test, expect, type Page } from '@playwright/test';
import { MCAP_3CAM, MCAP_3CAM_URL, requireFixture } from './fixturePaths';
import { openFixtureByUrl } from './helpers/rosview';

/**
 * `topicLabels`: a host names its streams ("Head", "Left wrist"); RosView shows that name first and
 * the topic as secondary text, and shows unlabelled topics exactly as before.
 */
const LEFT = '/camera/left/color/image_raw/compressed';
const TOP = '/camera/top/color/image_raw/compressed';
const RIGHT = '/camera/right/color/image_raw/compressed';
const LABELS = { [LEFT]: 'Left wrist', [TOP]: 'Head' };

test.describe.configure({ timeout: 120_000 });

test.beforeAll(() => {
  requireFixture(MCAP_3CAM);
});

async function withHostProps(page: Page, props: Record<string, unknown>): Promise<void> {
  await page.addInitScript((value) => {
    (window as unknown as { __rosviewHostProps: unknown }).__rosviewHostProps = value;
  }, props);
}

function imagePanelFor(page: Page, topic: string) {
  return page.getByTestId('image-panel').filter({ has: page.locator(`button[role="combobox"]:has-text("${topic}")`) });
}

test('image topic bars, panel tabs, the picker and the sidebar show the host label; unlabelled topics stay as they are', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await withHostProps(page, {
    topicLabels: LABELS,
    preferencePersistence: 'off',
    layoutPersistence: 'off',
  });
  await openFixtureByUrl(page, MCAP_3CAM_URL);
  await expect(page.getByTestId('image-panel')).toHaveCount(3, { timeout: 60_000 });

  // Topic bar: the label first, the topic as secondary text (and on hover).
  const left = imagePanelFor(page, LEFT).getByRole('combobox');
  await expect(left.getByTestId('topic-picker-label')).toHaveText('Left wrist');
  await expect(left.getByTestId('topic-picker-topic')).toHaveText(LEFT);
  await expect(left).toHaveAttribute('title', LEFT);
  const right = imagePanelFor(page, RIGHT).getByRole('combobox');
  await expect(right.getByTestId('topic-picker-label')).toHaveCount(0);
  await expect(right).toHaveText(RIGHT);

  // Panel tabs: the label where the panel's topic has one, the panel title otherwise.
  // (The auto layout also opens a Raw panel on the left camera: it is titled by the label too.)
  const titles = await page.getByTestId('panel-tab-title').allTextContents();
  expect([...new Set(titles)].sort()).toEqual(['Head', 'Image', 'Left wrist']);
  const tooltips = await page.getByTestId('panel-tab-title').evaluateAll((els) => els.map((el) => el.getAttribute('title')));
  expect(tooltips).toEqual(expect.arrayContaining([`Image · Left wrist\n${LEFT}`, `Raw · Left wrist\n${LEFT}`, 'Image']));

  // Sidebar topic list: label rows, and the filter matches labels.
  await expect(page.getByTestId('topic-row-label')).toHaveCount(2);
  expect((await page.getByTestId('topic-row-label').allTextContents()).sort()).toEqual(['Head', 'Left wrist']);
  await page.locator('input[name="topic-filter"]').fill('wrist');
  await expect(page.getByRole('button', { name: `Left wrist (${LEFT})` })).toBeVisible();
  await expect(page.getByRole('button', { name: RIGHT, exact: true })).toHaveCount(0);
  await page.locator('input[name="topic-filter"]').fill('');

  // Picker: labelled topics are listed by label with the topic under it, and found by label.
  await right.click();
  const items = page.locator('[cmdk-item]');
  await expect(items).toHaveCount(3);
  await expect(items.filter({ hasText: 'Head' })).toContainText(TOP);
  await page.keyboard.type('Left wrist');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText(LEFT);
  await page.keyboard.press('Escape');
});

test('in zh, a Raw panel on a labelled topic is titled by the label and its copy button is translated', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await withHostProps(page, {
    topicLabels: LABELS,
    language: 'zh',
    preferencePersistence: 'off',
    layoutPersistence: 'off',
    defaultPanel: { type: 'RawMessages', config: { topic: LEFT } },
  });
  // The zh UI names the transport buttons in Chinese, so wait on the panel rather than "Play playback".
  await page.goto(`/?url=${encodeURIComponent(MCAP_3CAM_URL)}`);
  await expect(page.getByTestId('panel-tab-title')).toHaveText(['Left wrist'], { timeout: 60_000 });
  await expect(page.getByTestId('panel-tab-title')).toHaveAttribute('title', `原始消息 · Left wrist\n${LEFT}`);
  const copy = page.getByTestId('raw-messages-copy-field');
  await expect(copy.first()).toHaveText('复制', { timeout: 60_000 });
  expect(await page.getByText('COPY', { exact: true }).count()).toBe(0);
});
