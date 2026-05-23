import React from 'react';
import { useIntl } from 'react-intl';
import { Loader2 } from 'lucide-react';
import type { SampleDataset } from '@/services/sampleDatasets';
import { SampleDatasetCard } from './SampleDatasetCard';

interface SampleDatasetListProps {
  samples?: SampleDataset[];
  loading?: boolean;
  onSelect: (sample: SampleDataset) => void | Promise<void>;
  /** `grid` for welcome page (many image cards); `bottom` for homepage footer cards; `list` for dialogs. */
  variant?: 'list' | 'grid' | 'bottom';
}

export const SampleDatasetList: React.FC<SampleDatasetListProps> = ({
  samples = [],
  loading = false,
  onSelect,
  variant = 'list',
}) => {
  const { formatMessage } = useIntl();

  if (loading) {
    return (
      <div className="flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-lg bg-muted/20 py-12 text-muted-foreground">
        <Loader2 className="h-7 w-7 animate-spin" aria-hidden />
        <span className="text-sm">{formatMessage({ id: 'welcome.samplesLoading' })}</span>
      </div>
    );
  }

  if (samples.length === 0) {
    return (
      <div className="rounded-lg bg-muted/20 px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground">{formatMessage({ id: 'welcome.samplesEmpty' })}</p>
      </div>
    );
  }

  if (variant === 'bottom') {
    return (
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {samples.map((s) => (
          <SampleDatasetCard key={s.id} sample={s} onSelect={onSelect} layout="grid" />
        ))}
      </div>
    );
  }

  if (variant === 'grid') {
    return (
      <div className="grid max-h-[min(520px,55vh)] grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
        {samples.map((s) => (
          <SampleDatasetCard key={s.id} sample={s} onSelect={onSelect} layout="grid" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex max-h-[min(420px,50vh)] flex-col gap-2 overflow-y-auto pr-1">
      {samples.map((s) => (
        <SampleDatasetCard key={s.id} sample={s} onSelect={onSelect} layout="row" />
      ))}
    </div>
  );
};
