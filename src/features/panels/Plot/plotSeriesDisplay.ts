const NAMED_ITEM = /^([A-Za-z_]\w*)\[\d+\] \((.+)\)$/;

/**
 * Human labels for series. Array items carry `field[i] (name)`; the joint name
 * is what users recognise, so use it alone when all series share one field and
 * append the field (`name · velocity`) when several fields are plotted together.
 * `fieldLabels` names known fields in the UI language (`position` → 位置); other
 * fields keep their message name.
 */
export function displaySeriesLabels(
  labels: readonly string[],
  fieldLabels?: Readonly<Record<string, string>>,
): string[] {
  const parsed = labels.map((label) => NAMED_ITEM.exec(label));
  const fields = new Set<string>();
  for (const match of parsed) if (match) fields.add(match[1]);
  return labels.map((label, index) => {
    const match = parsed[index];
    if (!match) return label;
    if (fields.size <= 1) return match[2];
    const field = fieldLabels && Object.prototype.hasOwnProperty.call(fieldLabels, match[1]) ? fieldLabels[match[1]] : match[1];
    return `${match[2]} · ${field}`;
  });
}

export function formatPlotValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e6 || abs < 1e-4)) return value.toExponential(3);
  return Number(value.toPrecision(5)).toString();
}

export interface PlotTooltipRow {
  color: string;
  label: string;
  value: string;
}

export interface PlotTooltipSeries {
  label: string;
  color: string;
  unit?: string;
  show: boolean;
}

/** Rows (series name + value) at data index `idx`; hidden series and gaps are skipped. */
export function buildPlotTooltipRows(
  data: ReadonlyArray<ArrayLike<number | null | undefined>>,
  idx: number,
  series: readonly PlotTooltipSeries[],
): PlotTooltipRow[] {
  const rows: PlotTooltipRow[] = [];
  series.forEach((entry, i) => {
    if (!entry.show) return;
    const value = data[i + 1]?.[idx];
    if (value == null || !Number.isFinite(value)) return;
    const text = formatPlotValue(value);
    rows.push({
      color: entry.color,
      label: entry.label,
      value: entry.unit ? `${text} ${entry.unit}` : text,
    });
  });
  return rows;
}
