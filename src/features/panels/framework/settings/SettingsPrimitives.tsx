import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ChevronRight } from 'lucide-react';
import type { TopicInfo } from '@/core/types/ros';
import { Slider } from '@/shared/ui/slider';
import { TopicQuickPicker } from '../TopicQuickPicker';

/**
 * A small, dependency-free form kit used by panels to compose settings UIs
 * that feel consistent with the rest of the app. Panels MAY bring their own
 * components instead — these are opt-in helpers, not a framework.
 *
 * Visual language:
 * - `text-xs` labels, `bg-background` inputs, `border-input` hairlines, to
 *   blend with the existing left sidebar.
 * - Inputs take full available width; fields stack vertically unless the
 *   caller places children in a flex container.
 */

// ---------- SettingsSection ----------

interface SettingsSectionProps {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

/** Collapsible card with a heading and optional subtitle. */
export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  description,
  defaultOpen = true,
  children,
}) => {
  const [open, setOpen] = useState<boolean>(defaultOpen);
  return (
    <div className="rounded-md border border-border bg-card/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
        aria-expanded={open}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="text-xs font-semibold">{title}</span>
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-2">
          {description && <div className="text-[10px] text-muted-foreground">{description}</div>}
          {children}
        </div>
      )}
    </div>
  );
};

// ---------- SettingsField ----------

interface SettingsFieldProps {
  label: string;
  help?: string;
  error?: string;
  /** Render the control inline with the label (compact) vs stacked below. */
  orientation?: 'stacked' | 'row';
  children: ReactNode;
}

export const SettingsField: React.FC<SettingsFieldProps> = ({
  label,
  help,
  error,
  orientation = 'stacked',
  children,
}) => {
  if (orientation === 'row') {
    return (
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col min-w-0">
          <span className="text-xs">{label}</span>
          {help && <span className="text-[10px] text-muted-foreground">{help}</span>}
        </div>
        <div className="shrink-0">{children}</div>
      </div>
    );
  }
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs">{label}</span>
      {help && <span className="text-[10px] text-muted-foreground">{help}</span>}
      {children}
      {error && <span className="text-[10px] text-destructive">{error}</span>}
    </label>
  );
};

// ---------- SettingsText / Number / TextArea ----------

interface TextInputProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
  name?: string;
}

export const SettingsText: React.FC<TextInputProps> = ({
  value,
  onChange,
  placeholder,
  disabled,
  name,
}) => (
  <input
    type="text"
    name={name}
    value={value}
    placeholder={placeholder}
    disabled={disabled}
    onChange={(event) => onChange(event.target.value)}
    className="w-full border border-input rounded-sm bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50"
  />
);

interface NumberInputProps {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  name?: string;
  placeholder?: string;
}

function clampNumber(value: number, min?: number, max?: number): number {
  let next = value;
  if (typeof min === 'number' && next < min) next = min;
  if (typeof max === 'number' && next > max) next = max;
  return next;
}

function isPartialNumericInput(raw: string): boolean {
  // Strings that are valid mid-typing but not yet a complete number.
  // e.g. '', '-', '.', '-.', '1.', '1e', '1e-', '-1.'
  if (raw === '' || raw === '-' || raw === '+' || raw === '.' || raw === '-.' || raw === '+.') {
    return true;
  }
  return /^[+-]?(\d+\.?|\.\d+|\d+\.\d+)([eE][+-]?)?$/.test(raw) && !Number.isFinite(Number(raw));
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  return String(value);
}

/**
 * Numeric input with min/max clamping and a forgiving editing experience:
 * - Allows the field to be empty / partial (`-`, `1.`, `.5`) while typing.
 * - Commits a clamped numeric value as the user types valid numbers.
 * - On blur: clamps an out-of-range value, or reverts to the last valid
 *   external value if the field is empty / invalid.
 * - Enter commits; Escape reverts.
 * - External `value` changes are reflected unless the user is mid-edit.
 */
export const SettingsNumber: React.FC<NumberInputProps> = ({
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  name,
  placeholder,
}) => {
  const [text, setText] = useState<string>(() => formatNumber(value));
  const focusedRef = useRef(false);
  // Last numeric value mirrored from props, used when reverting partial input.
  const externalValueRef = useRef(value);

  useEffect(() => {
    externalValueRef.current = value;
    if (focusedRef.current) {
      // Don't yank the field while the user is mid-typing.
      return;
    }
    const formatted = formatNumber(value);
    // Only update display when the parsed values differ to avoid clobbering
    // intermediate text like `1.` while the user types.
    if (Number(text) !== value || text === '') {
      setText(formatted);
    }
  }, [value, text]);

  const commitFromText = useCallback(
    (raw: string): { committed: boolean; nextText: string } => {
      const trimmed = raw.trim();
      if (trimmed === '' || isPartialNumericInput(trimmed)) {
        return { committed: false, nextText: formatNumber(externalValueRef.current) };
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        return { committed: false, nextText: formatNumber(externalValueRef.current) };
      }
      const clamped = clampNumber(parsed, min, max);
      if (clamped !== externalValueRef.current) {
        onChange(clamped);
      }
      return { committed: true, nextText: formatNumber(clamped) };
    },
    [max, min, onChange],
  );

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const raw = event.target.value;
      setText(raw);
      const trimmed = raw.trim();
      if (trimmed === '' || isPartialNumericInput(trimmed)) {
        return;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) return;
      const clamped = clampNumber(parsed, min, max);
      if (clamped !== externalValueRef.current) {
        onChange(clamped);
      }
    },
    [max, min, onChange],
  );

  const handleBlur = useCallback(() => {
    focusedRef.current = false;
    const { nextText } = commitFromText(text);
    setText(nextText);
  }, [commitFromText, text]);

  const handleFocus = useCallback((event: React.FocusEvent<HTMLInputElement>) => {
    focusedRef.current = true;
    // Select existing content so a fresh value (e.g. typing `5` over `0`) replaces it,
    // avoiding leading-zero artifacts like `05`.
    event.currentTarget.select();
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const { nextText } = commitFromText(text);
        setText(nextText);
        event.currentTarget.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setText(formatNumber(externalValueRef.current));
        event.currentTarget.blur();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const stepSize =
          typeof step === 'number' && step > 0 ? step : 1;
        const direction = event.key === 'ArrowUp' ? 1 : -1;
        const base = Number.isFinite(externalValueRef.current)
          ? externalValueRef.current
          : 0;
        const next = clampNumber(base + direction * stepSize, min, max);
        event.preventDefault();
        setText(formatNumber(next));
        if (next !== externalValueRef.current) onChange(next);
      }
    },
    [commitFromText, max, min, onChange, step, text],
  );

  return (
    <input
      type="text"
      inputMode="decimal"
      name={name}
      value={text}
      placeholder={placeholder}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={handleChange}
      onBlur={handleBlur}
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
      autoComplete="off"
      className="w-full border border-input rounded-sm bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50"
    />
  );
};

export const SettingsTextArea: React.FC<TextInputProps & { rows?: number }> = ({
  value,
  onChange,
  placeholder,
  rows = 6,
  disabled,
  name,
}) => (
  <textarea
    name={name}
    value={value}
    rows={rows}
    placeholder={placeholder}
    disabled={disabled}
    onChange={(event) => onChange(event.target.value)}
    className="w-full border border-input rounded-sm bg-background px-2 py-1 text-[10px] font-mono leading-tight focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50 resize-y"
  />
);

// ---------- SettingsSelect ----------

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface SelectProps<T extends string> {
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (next: T) => void;
  disabled?: boolean;
  name?: string;
}

export function SettingsSelect<T extends string>({
  value,
  options,
  onChange,
  disabled,
  name,
}: SelectProps<T>): React.ReactElement {
  return (
    <select
      name={name}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
      className="w-full border border-input rounded-sm bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

// ---------- SettingsSlider ----------

interface SettingsSliderProps {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}

/** Slider-only control for settings (no separate numeric field). */
export const SettingsSlider: React.FC<SettingsSliderProps> = ({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  disabled,
}) => {
  const rafRef = useRef<number | null>(null);

  const handleSliderChange = useCallback(
    (next: number) => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        onChange(next);
      });
    },
    [onChange],
  );

  const handleSliderCommit = useCallback(
    ([next]: number[]) => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (next !== undefined) {
        onChange(next);
      }
    },
    [onChange],
  );

  return (
    <div className="min-w-0">
      <Slider
        value={value}
        onChange={handleSliderChange}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onCommit={handleSliderCommit}
      />
    </div>
  );
};

// ---------- SettingsSwitch ----------

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

export const SettingsSwitch: React.FC<SwitchProps> = ({ checked, onChange, disabled }) => (
  <input
    type="checkbox"
    checked={checked}
    disabled={disabled}
    onChange={(event) => onChange(event.target.checked)}
    className="h-3.5 w-3.5 accent-primary disabled:opacity-50"
  />
);

// ---------- TopicAutocomplete ----------

interface TopicAutocompleteProps {
  value: string;
  onChange: (next: string) => void;
  topics: ReadonlyArray<TopicInfo>;
  /** Optional filter: only include topics whose type contains one of these tokens (case-insensitive). */
  typeIncludes?: ReadonlyArray<string>;
  /** Optional filter: predicate match over ROS topic type (schema-aware usage recommended). */
  topicTypeMatches?: (topicType: string) => boolean;
  /** Optional filter: only include topics whose name matches this pattern. */
  nameIncludes?: string;
  placeholder?: string;
  disabled?: boolean;
  name?: string;
}

/**
 * Topic selector for settings sidebars — same Popover + Command UI as {@link TopicQuickPicker}.
 */
export const TopicAutocomplete: React.FC<TopicAutocompleteProps> = ({
  value,
  onChange,
  topics,
  typeIncludes,
  topicTypeMatches,
  nameIncludes,
  placeholder,
  disabled,
  name,
}) => (
  <>
    {name != null && name.length > 0 ? (
      <input type="hidden" name={name} value={value} readOnly aria-hidden />
    ) : null}
    <TopicQuickPicker
      value={value}
      onChange={onChange}
      topics={topics}
      typeIncludes={typeIncludes}
      topicTypeMatches={topicTypeMatches}
      nameIncludes={nameIncludes}
      placeholder={placeholder}
      disabled={disabled}
      className="w-full min-w-0"
    />
  </>
);

// ---------- UrlInput ----------

interface UrlInputProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
  name?: string;
}

export const UrlInput: React.FC<UrlInputProps> = ({
  value,
  onChange,
  placeholder = 'https:// or package://',
  disabled,
  name,
}) => (
  <input
    type="url"
    name={name}
    value={value}
    placeholder={placeholder}
    disabled={disabled}
    onChange={(event) => onChange(event.target.value)}
    className="w-full border border-input rounded-sm bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50"
  />
);

// ---------- FileInput ----------

interface FileInputProps {
  accept?: string;
  onRead: (text: string, file: File) => void;
  label?: string;
  disabled?: boolean;
  name?: string;
}

/** Hidden `<input type=file>` triggered by a button; reads the file as text. */
export const FileInput: React.FC<FileInputProps> = ({
  accept,
  onRead,
  label = 'Choose file…',
  disabled,
  name,
}) => {
  const inputId = useId();
  return (
    <>
      <input
        id={inputId}
        type="file"
        name={name ?? inputId}
        accept={accept}
        disabled={disabled}
        className="hidden"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          try {
            const text = await file.text();
            onRead(text, file);
          } catch (error) {
            console.warn('[FileInput] Failed to read file', error);
          }
        }}
      />
      <button
        type="button"
        onClick={() => document.getElementById(inputId)?.click()}
        disabled={disabled}
        className="w-full border border-input rounded-sm bg-background px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
      >
        {label}
      </button>
    </>
  );
};
