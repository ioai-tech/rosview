/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeTopicLabels, topicLabelOf, TopicLabelsProvider, useTopicLabel, useTopicLabels } from './topicLabels';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('normalizeTopicLabels', () => {
  it('keeps trimmed labels and drops empty, non-string and same-as-topic entries', () => {
    expect(
      normalizeTopicLabels({
        '/cam/head': '  Head left ',
        '/cam/wrist': '',
        '/cam/top': '   ',
        '/joint_states': '/joint_states',
        '/bad': 42 as unknown as string,
      }),
    ).toEqual({ '/cam/head': 'Head left' });
  });

  it('treats a missing or invalid prop as no labels', () => {
    expect(normalizeTopicLabels(undefined)).toEqual({});
    expect(normalizeTopicLabels('nope')).toEqual({});
  });

  it('matches topics exactly', () => {
    const labels = normalizeTopicLabels({ '/cam/head': 'Head left' });
    expect(topicLabelOf(labels, '/cam/head')).toBe('Head left');
    expect(topicLabelOf(labels, 'cam/head')).toBeUndefined();
    expect(topicLabelOf(labels, undefined)).toBeUndefined();
    expect(topicLabelOf(labels, 'toString')).toBeUndefined();
  });
});

describe('TopicLabelsProvider', () => {
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
  });

  it('gives panels the label, and keeps the same value for equal content', () => {
    const seen: Array<ReturnType<typeof useTopicLabels>> = [];
    const Probe = () => {
      seen.push(useTopicLabels());
      return <span>{useTopicLabel('/cam/head') ?? 'none'}</span>;
    };
    act(() => {
      root.render(
        <TopicLabelsProvider labels={{ '/cam/head': 'Head left' }}>
          <Probe />
        </TopicLabelsProvider>,
      );
    });
    expect(container.textContent).toBe('Head left');
    // A host passing a new but equal object each render does not change the context value.
    act(() => {
      root.render(
        <TopicLabelsProvider labels={{ '/cam/head': 'Head left' }}>
          <Probe />
        </TopicLabelsProvider>,
      );
    });
    expect(seen.at(-1)).toBe(seen[0]);
  });

  it('reads no label outside a provider', () => {
    const Probe = () => <span>{useTopicLabel('/cam/head') ?? 'none'}</span>;
    act(() => root.render(<Probe />));
    expect(container.textContent).toBe('none');
  });
});
