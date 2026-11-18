import { test, expect } from '@playwright/test';
import { MCAP_POSE_URL, requireFixture, MCAP_POSE } from './fixturePaths';
import { openFixtureByUrl } from './helpers/rosview';

test.describe.configure({ timeout: 90_000 });

test.beforeAll(() => {
  requireFixture(MCAP_POSE);
});

test('PoseStamped fixture exposes pose topics by schema', async ({ page }) => {
  await openFixtureByUrl(page, MCAP_POSE_URL);

  await expect(page.getByText('geometry_msgs/msg/PoseStamped').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('/io/pose/Left_Gripper').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('/io/pose/Right_Gripper').first()).toBeVisible({ timeout: 30_000 });
});
