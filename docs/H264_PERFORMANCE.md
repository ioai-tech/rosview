# H.264 playback performance

Use a representative, unmodified MCAP from the target workload rather than only the generated
`public/examples/test_h264.mcap`. Record its size, duration, H.264 profile/level, resolution, frame
rate, keyframe interval, and image topic. Do not copy or rewrite the recording for a benchmark.

## Automated Chromium benchmark

Start a production preview (`npm run build && npm run preview`), then run:

```bash
npm run benchmark:h264 -- \
  --file /absolute/path/representative.mcap \
  --base-url http://127.0.0.1:4173 \
  --duration 60 \
  --speed 8 \
  --no-seeks \
  --output benchmark-h264.json
```

The benchmark exposes the original file through a temporary read-only Range/CORS server. It records
progress updates, optional random seeks, aggregate metrics for every Image panel, decode/page/console
errors, and Chromium JS heap when available. `--speed` is a load input only: adaptive behavior is
driven by measured media lag and queue pressure, not by fixed playback-rate branches. Run
`npm run benchmark:h264 -- --help` for all options.

## Manual browser pass

Expose the same original MCAP through a read-only HTTP server with byte Range and CORS support. In
current stable Chrome, Edge, and Firefox, open
`http://127.0.0.1:4173/?url=<percent-encoded-mcap-url>`, play for 60 seconds, and seek to three
non-keyframe positions. Confirm that progress remains responsive, frames resume after each seek, and
no decode failure appears. Firefox H.264/WebCodecs availability depends on the OS codec stack; record
an unsupported-codec result separately instead of comparing it as a performance regression.

Suggested acceptance targets:

- The E2E smoke test observes at least two progress advances and at least 1 percentage point of
  movement in about one second.
- No decode, page, or console errors; Image metrics are non-negative and pressure is `normal`,
  `degraded`, or `recovery`.
- Decoder input remains bounded, media lag repeatedly recovers after pressure, rendered frames keep
  increasing, and resync count does not grow continuously under a steady workload.
- The H.264 pending queue is hard-bounded at 120 frames and a 1,000 ms media-time span. Soft
  pressure keeps a sole complete GOP intact; if either hard bound is exceeded without a newer IDR
  suffix that fits, the worker keeps the current picture, drops the complete backlog, and waits for
  the next real IDR rather than decoding a truncated delta chain. Playback must recover after every
  seek.
- For a 60-second run, progress updates on at least 50% of 200 ms samples and the longest unexplained
  stall is below 1 second.
- After warm-up, JS heap does not grow continuously; investigate growth above 25% or 256 MiB. Treat
  these as regression gates against a saved baseline, not universal limits.

Record browser/version, OS, CPU, GPU, RAM, display resolution, power mode, hardware acceleration
setting, cold/warm run, file metadata, and the JSON output. Compare results only on equivalent
hardware and browser settings.
