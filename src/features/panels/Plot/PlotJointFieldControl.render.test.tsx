/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRosViewMessages } from '@/shared/intl/loadRosViewMessages';
import type { JointStateField } from './defaults';
import { PlotJointFieldControl, toggleJointStateField } from './PlotJointFieldControl';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LABELS: Record<JointStateField, string> = { position: '位置', velocity: '速度', effort: '力矩' };
/** What the tabs need, as the invisible measuring copy reports it. */
const TABS_WIDTH = 100;

describe('toggleJointStateField', () => {
  it('adds and removes a field, and never leaves the plot without one', () => {
    expect(toggleJointStateField(['position'], 'velocity')).toEqual(['position', 'velocity']);
    expect(toggleJointStateField(['position', 'velocity'], 'position')).toEqual(['velocity']);
    expect(toggleJointStateField(['effort'], 'effort')).toEqual(['position']);
  });
});

describe('Plot joint field control', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(): void {
          this.callback([{ contentRect: { width: TABS_WIDTH } } as ResizeObserverEntry], this);
        }
        disconnect(): void {}
        unobserve(): void {}
      },
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(availableWidth: number | undefined, fields: JointStateField[] = ['position', 'effort']) {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <IntlProvider locale="zh" messages={getRosViewMessages('zh')}>
          <PlotJointFieldControl fields={fields} fieldLabels={LABELS} onChange={onChange} availableWidth={availableWidth} />
        </IntlProvider>,
      );
    });
    return onChange;
  }

  it('shows one tab per field, unwrapping, when the toolbar has room', () => {
    const onChange = render(TABS_WIDTH);
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="plot-field-tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual(['位置', '速度', '力矩']);
    expect(tabs.map((t) => t.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'true']);
    expect(tabs.every((t) => t.className.includes('whitespace-nowrap'))).toBe(true);
    expect(container.querySelector('[data-testid="plot-field-menu"]')).toBeNull();
    act(() => tabs[1].click());
    expect(onChange).toHaveBeenCalledWith(['position', 'effort', 'velocity']);
  });

  it('shows the tabs until the toolbar is measured', () => {
    render(undefined);
    expect(container.querySelectorAll('[data-testid="plot-field-tab"]')).toHaveLength(3);
  });

  it('folds the tabs into a menu button naming the active fields when they do not fit', () => {
    render(TABS_WIDTH - 1);
    expect(container.querySelectorAll('[data-testid="plot-field-tab"]')).toHaveLength(0);
    const menu = container.querySelector<HTMLButtonElement>('[data-testid="plot-field-menu"]')!;
    expect(menu.textContent).toBe('位置+1');
    expect(menu.title).toBe('位置, 力矩');
    expect(menu.getAttribute('aria-label')).toBe('关节字段: 位置, 力矩');
  });
});
