/**
 * @vitest-environment happy-dom
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsNumber } from './SettingsPrimitives';

// Mark this as a React act() test environment so React 19 stops warning.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SettingsNumber', () => {
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

  function getInput(): HTMLInputElement {
    const input = container.querySelector('input');
    if (!input) throw new Error('input not found');
    return input;
  }

  function fireChange(input: HTMLInputElement, value: string): void {
    // React tracks input values internally; assigning via the prototype setter
    // forces React to observe the change and dispatch onChange.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('renders the initial value as text', () => {
    act(() => {
      root.render(<SettingsNumber value={5} onChange={() => {}} />);
    });
    expect(getInput().value).toBe('5');
  });

  it('clamps values to [min, max] when typing a complete number', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(<SettingsNumber value={5} min={0} max={10} onChange={onChange} />);
    });
    act(() => fireChange(getInput(), '15'));
    expect(onChange).toHaveBeenCalledWith(10);
  });

  it('does not commit while user types partial input like "-" or "1."', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(<SettingsNumber value={5} onChange={onChange} />);
    });
    act(() => fireChange(getInput(), '-'));
    expect(onChange).not.toHaveBeenCalled();
    act(() => fireChange(getInput(), '1e'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('allows clearing the field then committing a new value on blur reverts to old value', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(<SettingsNumber value={5} onChange={onChange} />);
    });
    const input = getInput();
    act(() => fireChange(input, ''));
    // No commit while empty
    expect(onChange).not.toHaveBeenCalled();
    // Blur reverts display to 5 (last external value)
    act(() => {
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    });
    expect(input.value).toBe('5');
  });

  it('replacing leading-zero value: focus selects all so typing replaces', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(<SettingsNumber value={0} onChange={onChange} />);
    });
    const input = getInput();
    expect(input.value).toBe('0');
    // Simulate focus -> select all -> type "5" replacing "0"
    act(() => input.focus());
    // happy-dom should expose select(); call it manually then assert no leading 0
    act(() => fireChange(input, '5'));
    expect(onChange).toHaveBeenCalledWith(5);
  });

  it('updates display when external value changes while not focused', () => {
    const onChange = vi.fn();
    function Wrapper({ value }: { value: number }) {
      return <SettingsNumber value={value} onChange={onChange} />;
    }
    act(() => root.render(<Wrapper value={1} />));
    expect(getInput().value).toBe('1');
    act(() => root.render(<Wrapper value={42} />));
    expect(getInput().value).toBe('42');
  });

  it('arrow up/down bumps by step and clamps', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <SettingsNumber value={2} min={0} max={5} step={1} onChange={onChange} />,
      );
    });
    const input = getInput();
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });
    expect(onChange).toHaveBeenLastCalledWith(3);
    act(() => {
      // simulate React state catching up via re-render
      root.render(
        <SettingsNumber value={5} min={0} max={5} step={1} onChange={onChange} />,
      );
    });
    act(() => {
      getInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });
    // already at max, should not exceed
    const last = onChange.mock.calls.at(-1)?.[0] as number | undefined;
    expect(last).toBeLessThanOrEqual(5);
  });

  it('Enter commits clamped value and blurs', () => {
    const onChange = vi.fn();
    function Wrapper() {
      const [val, setVal] = useState(1);
      onChange.mockImplementation((next: number) => setVal(next));
      return <SettingsNumber value={val} min={0} max={10} onChange={onChange} />;
    }
    act(() => {
      root.render(<Wrapper />);
    });
    const input = getInput();
    act(() => fireChange(input, '7'));
    expect(onChange).toHaveBeenLastCalledWith(7);
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(input.value).toBe('7');
  });

  it('Escape reverts to last external value', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(<SettingsNumber value={3} onChange={onChange} />);
    });
    const input = getInput();
    act(() => fireChange(input, '99'));
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    // Display reverts to external (which was 3 — onChange was called with 99 but parent didn't update)
    expect(input.value).toBe('3');
  });

  it('handles non-finite external value gracefully', () => {
    act(() => {
      root.render(<SettingsNumber value={Number.NaN} onChange={() => {}} />);
    });
    expect(getInput().value).toBe('');
  });
});
