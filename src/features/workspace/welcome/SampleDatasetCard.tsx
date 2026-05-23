import React from 'react';
import type { SampleDataset } from '@/services/sampleDatasets';
import { Card, CardHeader, CardTitle } from '@/shared/ui/card';

interface SampleDatasetCardProps {
  sample: SampleDataset;
  onSelect: (sample: SampleDataset) => void | Promise<void>;
  layout?: 'row' | 'grid';
}

function coverFallbackLabel(sample: SampleDataset): string {
  const url = sample.archiveUrl || sample.url || '';
  if (url.toLowerCase().endsWith('.bvh')) return 'BVH';
  return 'MCAP';
}

export const SampleDatasetCard: React.FC<SampleDatasetCardProps> = ({ sample, onSelect, layout = 'row' }) => {
  const title = sample.title || sample.name;
  const cover = sample.coverImageUrl;

  if (layout === 'grid') {
    return (
      <button
        type="button"
        onClick={() => void onSelect(sample)}
        className="block h-full w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <Card className="flex h-full flex-col overflow-hidden border-border py-0 shadow-none">
          <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden bg-muted">
            {cover ? (
              <img
                src={cover}
                alt=""
                className="size-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="flex size-full items-center justify-center text-xs font-medium text-muted-foreground">
                {coverFallbackLabel(sample)}
              </div>
            )}
          </div>
          <CardHeader className="gap-0 p-4">
            <CardTitle className="line-clamp-2 text-sm font-medium leading-snug">{title}</CardTitle>
          </CardHeader>
        </Card>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void onSelect(sample)}
      className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Card className="flex overflow-hidden border-border py-0 shadow-none">
        <div className="relative h-[4.5rem] w-20 shrink-0 bg-muted">
          {cover ? (
            <img src={cover} alt="" className="size-full object-cover" loading="lazy" />
          ) : (
            <div className="flex size-full items-center justify-center text-[10px] font-medium text-muted-foreground">
              {coverFallbackLabel(sample)}
            </div>
          )}
        </div>
        <CardHeader className="min-w-0 flex-1 justify-center gap-0 px-3 py-2">
          <CardTitle className="truncate text-sm font-medium leading-snug">{title}</CardTitle>
        </CardHeader>
      </Card>
    </button>
  );
};
