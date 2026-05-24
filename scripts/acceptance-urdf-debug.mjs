/**
 * One-off acceptance script for URDF Debug panel (run against dev server).
 * Usage: node scripts/acceptance-urdf-debug.mjs
 */
import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const baseUrl = process.env.ROS_STUDIO_URL ?? 'http://localhost:5174';
const urdfPath = path.join(root, 'public/examples/xArm7.urdf');

async function openUrdfDebugPanel(page) {
  await page.goto(`${baseUrl}/?url=/examples/test_5s.mcap`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Open add panel menu' }).last().click();
  await page.getByRole('menuitem', { name: 'UrdfDebug' }).hover();
  await page.waitForTimeout(300);
  await page.getByRole('menuitem', { name: 'In this group (tab)' }).evaluate((el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.getByText(/Mesh resources|Mesh 资源|输入/).first().waitFor({ timeout: 15000 });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await openUrdfDebugPanel(page);

  // Narrow viewport: settings and preview should remain side-by-side
  await page.setViewportSize({ width: 480, height: 800 });
  await page.waitForTimeout(300);
  const settingsBox = await page.getByText(/Joint pose|关节姿态|関節姿勢/).boundingBox();
  const previewBox = await page.getByText(/URDF Preview|URDF 预览|URDF プレビュー/i).first().boundingBox();
  if (!settingsBox || !previewBox) {
    throw new Error('Settings or preview region not visible in narrow viewport');
  }
  if (Math.abs(settingsBox.y - previewBox.y) > 40) {
    throw new Error('Layout should stay horizontal in narrow viewport (not stacked vertically)');
  }

  const resizeHandle = page.getByRole('separator', { name: /Resize settings|调整调参|設定パネル/i });
  await resizeHandle.waitFor({ timeout: 5000 });

  // Upload URDF via hidden input (drop zone)
  const urdfInput = page.getByTestId('urdf-debug-urdf-upload');
  await urdfInput.setInputFiles(urdfPath);
  await page.getByText('xArm7.urdf').waitFor({ timeout: 5000 });

  await page.getByText(/Mesh resources|Mesh 资源/).waitFor();
  await page.getByText(/Resolved mesh URLs|Mesh 解析结果/).waitFor({ timeout: 10000 });

  // Joint sliders
  await page.getByText(/Joint pose|关节姿态|関節姿勢/).waitFor();
  const firstSlider = page.getByRole('slider').first();
  await firstSlider.waitFor({ timeout: 5000 });
  const valueBefore = await firstSlider.getAttribute('aria-valuenow');
  await firstSlider.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  const valueAfter = await firstSlider.getAttribute('aria-valuenow');
  if (valueBefore === valueAfter) {
    throw new Error(`Slider did not change: before=${valueBefore} after=${valueAfter}`);
  }

  // Follow MCAP toggle disables sliders
  await page.getByRole('checkbox', { name: /Follow MCAP|跟随 MCAP|MCAP JointState/i }).check();
  await page.waitForTimeout(300);
  const disabled = await firstSlider.isDisabled();
  if (!disabled) {
    throw new Error('Slider should be disabled when Follow MCAP is enabled');
  }

  // Remote base URL flow
  await page.getByRole('radio', { name: /Remote base URL|远程 Base URL/i }).check();
  const remoteInput = page.getByPlaceholder(/your-host\/resources/i);
  await remoteInput.fill('not-a-valid-url');
  await page.getByRole('button', { name: /Apply|应用/ }).click();
  await page.getByText(/valid http:\/\/ or https:\/\/ URL|有效的 http/i).waitFor();

  const testBase = `${baseUrl}/examples`;
  await remoteInput.fill(testBase);
  await page.getByRole('button', { name: /Apply|应用/ }).click();
  await page.getByText(/Applied base URL|已应用 Base URL/i).waitFor();
  await page.getByText(testBase).waitFor();

  // Wait for mesh status check to finish
  await page.waitForTimeout(2000);
  const summary = await page.getByText(/\d+ \/ \d+.*(reachable|可访问)/).textContent();
  const resolvedBlock = await page.locator('text=package://').first().textContent();

  // rotate_mesh toggle
  await page.getByRole('checkbox', { name: /Rotate mesh visuals|旋转 mesh/i }).check();
  await page.getByText(/rotate_mesh: (ON|开)/i).waitFor({ timeout: 5000 });

  console.log('ACCEPTANCE OK');
  console.log('- Narrow viewport horizontal layout: OK');
  console.log('- Resize handle present: OK');
  console.log('- URDF uploaded: xArm7.urdf');
  console.log('- Joint slider moved:', valueBefore, '->', valueAfter);
  console.log('- Follow MCAP disables sliders: OK');
  console.log('- Mesh summary:', summary?.trim());
  console.log('- Sample resolved path:', resolvedBlock?.trim());
  console.log('- rotate_mesh overlay: ON');

  await page.screenshot({
    path: path.join(root, 'public/examples/urdf-debug-acceptance.png'),
    fullPage: true,
  });
  console.log('- Screenshot: public/examples/urdf-debug-acceptance.png');

  if (errors.length > 0) {
    console.log('Console errors (non-fatal):', errors.slice(0, 5));
  }

  await browser.close();
}

main().catch((error) => {
  console.error('ACCEPTANCE FAILED:', error);
  process.exit(1);
});
