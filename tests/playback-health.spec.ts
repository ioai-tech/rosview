import { expect, test } from '@playwright/test';
import {
  BAG_MULTI,
  BVH_MINIMAL,
  BVH_MINIMAL_URL,
  HDF5_MINIMAL,
  HDF5_MINIMAL_URL,
  MCAP_3CAM,
  MCAP_3CAM_URL,
  MCAP_BASIC,
  MCAP_BASIC_URL,
  MCAP_COMPRESSED_DEPTH,
  MCAP_COMPRESSED_DEPTH_URL,
  MCAP_H264,
  MCAP_H264_URL,
  MCAP_MULTI_BASE,
  MCAP_MULTI_BASE_URL,
  MCAP_MULTI_INCREMENTAL,
  MCAP_MULTI_INCREMENTAL_URL,
  MCAP_POSE,
  MCAP_POSE_URL,
  fixtureExists,
  requireExamplesDir,
} from './fixturePaths';
import { measurePlaybackPerf } from './helpers/playbackPerf';

const FIXTURES = [
  { id: 'test_5s', url: MCAP_BASIC_URL, filePath: MCAP_BASIC },
  { id: 'test_pose', url: MCAP_POSE_URL, filePath: MCAP_POSE },
  { id: 'test_3cam', url: MCAP_3CAM_URL, filePath: MCAP_3CAM },
  { id: 'test_h264', url: MCAP_H264_URL, filePath: MCAP_H264 },
  { id: 'test_compressed_depth', url: MCAP_COMPRESSED_DEPTH_URL, filePath: MCAP_COMPRESSED_DEPTH },
  { id: 'test_minimal_hdf5', url: HDF5_MINIMAL_URL, filePath: HDF5_MINIMAL },
  { id: 'test_minimal_bvh', url: BVH_MINIMAL_URL, filePath: BVH_MINIMAL },
  { id: 'test_multi_base', url: MCAP_MULTI_BASE_URL, filePath: MCAP_MULTI_BASE },
  { id: 'test_multi_incremental', url: MCAP_MULTI_INCREMENTAL_URL, filePath: MCAP_MULTI_INCREMENTAL },
  { id: 'test_multi_bag', url: '/examples/test_multi.bag', filePath: BAG_MULTI, optional: true },
];

test.describe('playback health across example fixtures', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(() => {
    requireExamplesDir();
  });

  for (const fixture of FIXTURES) {
    test(`${fixture.id} plays, seeks, and does not stick on buffering`, async ({ page }) => {
      test.skip(Boolean(fixture.optional) && !fixtureExists(fixture.filePath), `${fixture.id} fixture not available`);
      const metrics = await measurePlaybackPerf(page, fixture.id, fixture.url);
      expect(metrics.readyMs).toBeLessThan(15_000);
      expect(metrics.playAdvanceMs).toBeLessThan(5_000);
      expect(metrics.seekAdvanceMs).toBeLessThan(5_000);
      expect(metrics.bufferingStuckMs).toBeLessThan(3_000);
      await expect(page.locator('#rosview-root')).toHaveAttribute('data-player-buffering', 'false');
      await expect(page.getByTestId('rosview-playback-error')).toHaveCount(0);
    });
  }
});
