import React, { useEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown } from 'lucide-react';
import { useIntl } from 'react-intl';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import type { JointStateField } from './defaults';
import { JOINT_STATE_FIELDS } from './defaults';

/** Toggles one field; the plot always keeps at least one, falling back to position. */
export function toggleJointStateField(fields: readonly JointStateField[], field: JointStateField): JointStateField[] {
  const next = fields.includes(field) ? fields.filter((f) => f !== field) : [...fields, field];
  return next.length > 0 ? next : ['position'];
}

interface PlotJointFieldControlProps {
  fields: readonly JointStateField[];
  fieldLabels: Record<JointStateField, string>;
  onChange: (fields: JointStateField[]) => void;
  /** The toolbar the tabs sit in; its content width bounds the tabs. */
  toolbarRef: RefObject<HTMLElement | null>;
  /**
   * Toolbar width the other controls keep (their floors plus gaps). When the tabs need more than
   * the rest, they fold into one menu button instead of squeezing: a squeezed tab wraps its label
   * one character per line.
   */
  reservedWidth: number;
}

function tabClassName(active: boolean): string {
  return `shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] capitalize ${
    active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent'
  }`;
}

/**
 * Whether the tabs fit beside the rest of the toolbar. One observer watches the toolbar and an
 * invisible copy of the tabs (so the answer follows the locale, the font and the panel size), and
 * only a change of answer re-renders: dragging a splitter across many Plot panels re-renders none
 * of them until a toolbar crosses its threshold. Neither width depends on the answer, so it cannot
 * oscillate. Until both are measured the tabs show.
 */
function useTabsFit(
  toolbarRef: RefObject<HTMLElement | null>,
  measureRef: RefObject<HTMLElement | null>,
  reservedWidth: number,
): boolean {
  const [fit, setFit] = useState(true);

  useEffect(() => {
    const toolbar = toolbarRef.current;
    const measure = measureRef.current;
    if (!toolbar || !measure || typeof ResizeObserver === 'undefined') {
      return;
    }
    const widths = new Map<Element, number>();
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        widths.set(entry.target, entry.contentRect.width);
      }
      const toolbarWidth = widths.get(toolbar);
      const tabsWidth = widths.get(measure);
      if (toolbarWidth !== undefined && tabsWidth !== undefined) {
        setFit(tabsWidth <= toolbarWidth - reservedWidth);
      }
    });
    observer.observe(toolbar);
    observer.observe(measure);
    return () => {
      observer.disconnect();
    };
  }, [toolbarRef, measureRef, reservedWidth]);

  return fit;
}

/**
 * The JointState field tabs (position / velocity / effort) of a Plot toolbar. Labels never wrap:
 * in a toolbar too narrow for every tab, the tabs collapse into a compact menu button that names
 * the active fields, the way panel toolbars keep a fixed one-line height at any width.
 */
export function PlotJointFieldControl({
  fields,
  fieldLabels,
  onChange,
  toolbarRef,
  reservedWidth,
}: PlotJointFieldControlProps): React.ReactNode {
  const { formatMessage } = useIntl();
  // An invisible copy of the tabs measures what they need in the current locale and font.
  const measureRef = useRef<HTMLDivElement | null>(null);
  const collapsed = !useTabsFit(toolbarRef, measureRef, reservedWidth);

  const activeLabels = JOINT_STATE_FIELDS.filter((f) => fields.includes(f)).map((f) => fieldLabels[f]);
  const menuLabel = formatMessage({ id: 'panels.plot.toolbar.jointFields' });

  return (
    <div className="relative flex shrink-0 items-center gap-0.5">
      <div
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute right-0 top-0 flex w-max items-center gap-0.5"
      >
        {JOINT_STATE_FIELDS.map((field) => (
          <span key={field} className={tabClassName(fields.includes(field))}>
            {fieldLabels[field]}
          </span>
        ))}
      </div>
      {collapsed ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="plot-field-menu"
              aria-label={`${menuLabel}: ${activeLabels.join(', ')}`}
              title={activeLabels.join(', ')}
              className="flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded bg-primary/15 px-1.5 py-0.5 text-[10px] capitalize text-primary hover:bg-primary/25"
            >
              <span>{activeLabels[0]}</span>
              {activeLabels.length > 1 && <span className="opacity-70">+{activeLabels.length - 1}</span>}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-0">
            {JOINT_STATE_FIELDS.map((field) => (
              <DropdownMenuCheckboxItem
                key={field}
                checked={fields.includes(field)}
                // Keep the menu open so several fields can be picked in a row.
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => onChange(toggleJointStateField(fields, field))}
                className="whitespace-nowrap py-1 text-[11px] capitalize"
              >
                {fieldLabels[field]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        JOINT_STATE_FIELDS.map((field) => (
          <button
            key={field}
            type="button"
            aria-pressed={fields.includes(field)}
            data-testid="plot-field-tab"
            onClick={() => onChange(toggleJointStateField(fields, field))}
            className={tabClassName(fields.includes(field))}
          >
            {fieldLabels[field]}
          </button>
        ))
      )}
    </div>
  );
}
