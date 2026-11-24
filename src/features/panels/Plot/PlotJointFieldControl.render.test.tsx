/**
 * @vitest-environment happy-dom
 */
import { act, useRef } from 'react';
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
/** Toolbar width kept for the other controls. */
const RESERVED = 50;
/** The toolbar width at which the tabs exactly fit. */
const FIT_WIDTH = TABS_WIDTH + RESERVED;

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
  /** The toolbar's width as the stub observer reports it; undefined never reports (not measured). */
  let toolbarWidth: number | undefined;
  const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];

  function widthOf(target: Element): number | undefined {
    return target.getAttribute('aria-hidden') === 'true' ? TABS_WIDTH : toolbarWidth;
  }

  function report(observer: (typeof observers)[number], targets: Element[]): void {
    const entries = targets
      .filter((target) => widthOf(target) !== undefined)
      .map((target) => ({ target, contentRect: { width: widthOf(target)! } }) as unknown as ResizeObserverEntry);
    if (entries.length > 0) observer.callback(entries, {} as ResizeObserver);
  }

  /** Resizes the toolbar, as a panel resize would, and delivers the observation. */
  function resizeToolbar(width: number): void {
    toolbarWidth = width;
    act(() => {
      for (const observer of observers) {
        report(observer, observer.targets.filter((t) => t.getAttribute('aria-hidden') !== 'true'));
      }
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    observers.length = 0;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly entry: (typeof observers)[number];
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback, targets: [] };
          observers.push(this.entry);
        }
        observe(target: Element): void {
          this.entry.targets.push(target);
          report(this.entry, [target]);
        }
        disconnect(): void {
          this.entry.targets = [];
        }
        unobserve(): void {}
      },
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function Toolbar({ fields, onChange }: { fields: JointStateField[]; onChange: (fields: JointStateField[]) => void }) {
    const toolbarRef = useRef<HTMLDivElement | null>(null);
    return (
      <div ref={toolbarRef}>
        <PlotJointFieldControl
          fields={fields}
          fieldLabels={LABELS}
          onChange={onChange}
          toolbarRef={toolbarRef}
          reservedWidth={RESERVED}
        />
      </div>
    );
  }

  function render(width: number | undefined, fields: JointStateField[] = ['position', 'effort']) {
    toolbarWidth = width;
    const onChange = vi.fn();
    act(() => {
      root.render(
        <IntlProvider locale="zh" messages={getRosViewMessages('zh')}>
          <Toolbar fields={fields} onChange={onChange} />
        </IntlProvider>,
      );
    });
    return onChange;
  }

  const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="plot-field-tab"]'));
  const menuButton = () => container.querySelector<HTMLButtonElement>('[data-testid="plot-field-menu"]');

  it('shows one tab per field, unwrapping, when the toolbar has room', () => {
    const onChange = render(FIT_WIDTH);
    expect(tabs().map((t) => t.textContent)).toEqual(['位置', '速度', '力矩']);
    expect(tabs().map((t) => t.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'true']);
    expect(tabs().every((t) => t.className.includes('whitespace-nowrap'))).toBe(true);
    expect(menuButton()).toBeNull();
    act(() => tabs()[1].click());
    expect(onChange).toHaveBeenCalledWith(['position', 'effort', 'velocity']);
  });

  it('shows the tabs until the toolbar is measured', () => {
    render(undefined);
    expect(tabs()).toHaveLength(3);
  });

  it('folds the tabs into a menu button naming the active fields when they do not fit', () => {
    render(FIT_WIDTH - 1);
    expect(tabs()).toHaveLength(0);
    const menu = menuButton()!;
    expect(menu.textContent).toBe('位置+1');
    expect(menu.title).toBe('位置, 力矩');
    expect(menu.getAttribute('aria-label')).toBe('关节字段: 位置, 力矩');
  });

  it('switches between tabs and menu as the toolbar crosses the threshold', () => {
    render(FIT_WIDTH);
    resizeToolbar(FIT_WIDTH - 1);
    expect(tabs()).toHaveLength(0);
    expect(menuButton()).not.toBeNull();
    resizeToolbar(FIT_WIDTH + 200);
    expect(tabs()).toHaveLength(3);
    expect(menuButton()).toBeNull();
  });
});
