import { describe, expect, it } from 'vitest';
import { labelledPanelTitle, singleTopicOfPanelConfig } from './panelTitleLabel';

describe('singleTopicOfPanelConfig', () => {
  it('reads the topic of single-topic panels', () => {
    expect(singleTopicOfPanelConfig({ topic: ' /cam/head ' })).toBe('/cam/head');
  });
  it('has none for multi-topic or empty configs', () => {
    expect(singleTopicOfPanelConfig({ series: [{ topic: '/joint_states' }] })).toBeUndefined();
    expect(singleTopicOfPanelConfig({ topics: ['/a', '/b'] })).toBeUndefined();
    expect(singleTopicOfPanelConfig({ topic: '' })).toBeUndefined();
    expect(singleTopicOfPanelConfig(undefined)).toBeUndefined();
  });
});

describe('labelledPanelTitle', () => {
  it('titles a panel with the label of its topic and keeps type and topic on hover', () => {
    expect(labelledPanelTitle('图像', '/cam/head', 'Head left')).toEqual({
      text: 'Head left',
      tooltip: '图像 · Head left\n/cam/head',
    });
  });
  it('keeps the panel title without a label', () => {
    expect(labelledPanelTitle('Image', '/cam/head', undefined)).toEqual({ text: 'Image', tooltip: 'Image' });
  });
});
