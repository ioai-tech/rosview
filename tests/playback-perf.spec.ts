import { test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { measurePlaybackPerf, writePlaybackPerfReport, type PlaybackPerfMetrics } from './helpers/playbackPerf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type FixtureCase = {
  id: string;
  url: string;
  filePath: string;
  optional?: boolean;
};

const FIXTURES: FixtureCase[] = [
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

const results: PlaybackPerfMetrics[] = [];

function outputPath(): string {
  return (
    process.env.PLAYBACK_PERF_OUTPUT ??
    path.join(__dirname, '../tmp/playback-perf/latest.json')
  );
}

test.describe('playback performance capture', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeAll(() => {
    test.skip(Boolean(process.env.CI), 'perf capture is local-only; CI uses playback-health');
    requireExamplesDir();
  });

  for (const fixture of FIXTURES) {
    test(`${fixture.id} ready/play/seek timings`, async ({ page }) => {
      test.skip(Boolean(fixture.optional) && !fixtureExists(fixture.filePath), `${fixture.id} fixture not available`);
      const metrics = await measurePlaybackPerf(page, fixture.id, fixture.url);
      results.push(metrics);
    });
  }

  test.afterAll(async () => {
    if (results.length === 0) {
      return;
    }
    const label = process.env.PLAYBACK_PERF_LABEL ?? 'latest';
    await writePlaybackPerfReport(label, results, outputPath());
  });
});
