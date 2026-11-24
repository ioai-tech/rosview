/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TopicInfo } from '@/core/types/ros';
import { getRosViewMessages } from '@/shared/intl/loadRosViewMessages';
import { TopicLabelsProvider } from '@/shared/ros/topicLabels';
import { TopicQuickPicker } from './TopicQuickPicker';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HEAD = '/sensor/EgoCentric_Camera_0/image/compressed';
const WRIST = '/sensor/Left_Wrist_Camera_0/image/compressed';
const TOPICS: TopicInfo[] = [
  { name: HEAD, type: 'sensor_msgs/msg/CompressedImage' },
  { name: WRIST, type: 'sensor_msgs/msg/CompressedImage' },
];

describe('TopicQuickPicker with host topic labels', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  function render(value: string, labels?: Record<string, string>) {
    act(() => {
      root.render(
        <IntlProvider locale="en" messages={getRosViewMessages('en')}>
          <TopicLabelsProvider labels={labels}>
            <TopicQuickPicker value={value} onChange={() => {}} topics={TOPICS} />
          </TopicLabelsProvider>
        </IntlProvider>,
      );
    });
    return container.querySelector('button[role="combobox"]') as HTMLButtonElement;
  }

  it('shows the label first and the topic as secondary text', () => {
    const trigger = render(HEAD, { [HEAD]: 'Head left' });
    expect(trigger.querySelector('[data-testid="topic-picker-label"]')?.textContent).toBe('Head left');
    expect(trigger.querySelector('[data-testid="topic-picker-topic"]')?.textContent).toBe(HEAD);
    expect(trigger.title).toBe(HEAD);
  });

  it('lists labelled topics by label, with the topic under it', () => {
    const trigger = render(HEAD, { [HEAD]: 'Head left' });
    act(() => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      trigger.click();
    });
    const items = Array.from(document.querySelectorAll('[cmdk-item]'));
    expect(items.map((item) => item.textContent)).toEqual([
      `Head left${HEAD}sensor_msgs/msg/CompressedImage`,
      `${WRIST}sensor_msgs/msg/CompressedImage`,
    ]);
    // Typing the label finds the topic.
    expect(items[0]?.getAttribute('data-value')).toContain('Head left');
  });

  it('is unchanged without a label', () => {
    const trigger = render(WRIST, { [HEAD]: 'Head left' });
    expect(trigger.querySelector('[data-testid="topic-picker-label"]')).toBeNull();
    expect(trigger.textContent).toBe(WRIST);
    expect(trigger.hasAttribute('title')).toBe(false);
  });
});
