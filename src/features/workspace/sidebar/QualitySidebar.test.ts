import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import type { DataQualityReport } from '@/core/types/ros';
import { getRosViewMessages } from '@/shared/intl/loadRosViewMessages';
import { QualitySidebar } from './QualitySidebar';

const enMessages = getRosViewMessages('en');

const mockReport: DataQualityReport = {
  status: 'ready',
  scannedMessages: 1000,
  totalMessages: 1000,
  updatedAt: Date.now(),
  issueCounts: {
    timestamp_rollback: 1,
    topic_frame_drop: 0,
  },
  issues: [],
  ranges: [
    {
      id: 'timestamp_rollback:1',
      type: 'timestamp_rollback',
      clockSource: 'header',
      scope: 'topic',
      severity: 'error',
      topicNames: ['/camera/left/color/image_resized/compressed'],
      start: { sec: 1, nsec: 0 },
      end: { sec: 1, nsec: 200_000_000 },
      count: 3,
      maxMagnitudeMs: 433.2,
      titlePayload: { key: 'quality.incident.title.timestamp_rollback', values: { topic: '/camera/left/color/image_resized/compressed' } },
      impactPayload: { key: 'quality.incident.impact.timestamp_rollback', values: { count: 3, ms: '433.2' } },
      recommendationPayload: { key: 'quality.incident.recommendation.timestamp_rollback', values: {} },
      explainPayload: { key: 'quality.summary.timestamp_rollback', values: { ms: '433.2' } },
      summaryStats: {
        baselineIntervalNs: '33333333',
        beforeAvgDeltaNs: '33333333',
        anomalyAvgDeltaNs: '-43333333',
        afterAvgDeltaNs: '33333333',
        rollbackDepthNs: '43333333',
        evidenceTargetCount: 2,
        evidenceComplete: true,
        mergedSourceCount: 1,
      },
      evidenceWindow: {
        beforeNormal: [
          { index: 10, timeNs: '1000000000', deltaNs: '33333333' },
          { index: 11, timeNs: '1033333333', deltaNs: '33333333' },
        ],
        anomaly: [{ index: 12, timeNs: '990000000', deltaNs: '-43333333', isRollback: true, isAnomaly: true }],
        afterNormal: [
          { index: 13, timeNs: '1023333333', deltaNs: '33333333' },
          { index: 14, timeNs: '1056666666', deltaNs: '33333333' },
        ],
      },
    },
  ],
};

describe('QualitySidebar', () => {
  it('renders metrics, topic selector, and chart/table tabs', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        IntlProvider,
        { locale: 'en', messages: enMessages },
        React.createElement(QualitySidebar, {
          report: mockReport,
          filter: undefined,
          timelineStart: { sec: 0, nsec: 0 },
          autoDataQualityScan: false,
          onAutoDataQualityScanChange: vi.fn(),
          onRequestScan: vi.fn(),
          onFilterChange: vi.fn(),
          onSeek: vi.fn(),
        }),
      ),
    );

    expect(html).not.toContain('Incident overview');
    expect(html).toContain('Scanned 1000 / 1000 (100%)');
    expect(html).not.toContain('Training quality');
    expect(html).not.toContain('Score');
    expect(html).toContain('1 errors');
    expect(html).toContain('/camera/left/color/image_resized/compressed timestamp rollback');
    expect(html).toContain('Anomaly 1');
    expect(html).toContain('Max |Δ| 43.3 ms');
    expect(html).toContain('Topics 1');
    expect(html).toContain('Topic');
    expect(html).toContain('Chart');
    expect(html).toContain('Raw data');
    expect(html).not.toContain('Suggestion');
    expect(html).toContain('B2 · A1 · N2');
    expect(html).toContain('quality-issue-chart');
    expect(html).toContain('All types');
  });

  it('does not emit CJK characters in English locale markup', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        IntlProvider,
        { locale: 'en', messages: enMessages },
        React.createElement(QualitySidebar, {
          report: mockReport,
          filter: undefined,
          timelineStart: { sec: 0, nsec: 0 },
          autoDataQualityScan: true,
          onAutoDataQualityScanChange: vi.fn(),
          onRequestScan: vi.fn(),
          onFilterChange: vi.fn(),
          onSeek: vi.fn(),
        }),
      ),
    );
    expect(html).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('renders manual scan idle state', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        IntlProvider,
        { locale: 'en', messages: enMessages },
        React.createElement(QualitySidebar, {
          report: { ...mockReport, status: 'idle', scannedMessages: 0, totalMessages: 1000, ranges: [], incidents: [], issues: [] },
          filter: undefined,
          timelineStart: { sec: 0, nsec: 0 },
          autoDataQualityScan: false,
          onAutoDataQualityScanChange: vi.fn(),
          onRequestScan: vi.fn(),
          onFilterChange: vi.fn(),
          onSeek: vi.fn(),
        }),
      ),
    );
    expect(html).toContain('Start scan');
    expect(html).toContain('Auto scan small files');
    expect(html).toContain('Quality scan is idle');
  });
});

describe('QualitySidebar source problems', () => {
  const render = (report: DataQualityReport | undefined) =>
    renderToStaticMarkup(
      React.createElement(
        IntlProvider,
        { locale: 'en', messages: enMessages },
        React.createElement(QualitySidebar, {
          report,
          sourceProblems: [
            { severity: 'warn', message: 'Dex3 hand data is recorded in the sidecar file "x.dex3.mcap".' },
            { severity: 'error', message: 'Channel 3 (/foo): Unsupported encoding' },
          ],
          filter: undefined,
          timelineStart: { sec: 0, nsec: 0 },
          autoDataQualityScan: false,
          onAutoDataQualityScanChange: vi.fn(),
          onRequestScan: vi.fn(),
          onFilterChange: vi.fn(),
          onSeek: vi.fn(),
        }),
      ),
    );

  it('lists source warnings with or without a scan report', () => {
    for (const html of [render(undefined), render(mockReport)]) {
      expect(html).toContain('Source warnings (2)');
      expect(html).toContain('x.dex3.mcap');
      expect(html).toContain('Unsupported encoding');
    }
  });
});
