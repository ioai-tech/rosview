import React from 'react';
import { Link2 } from 'lucide-react';
import { useIntl } from 'react-intl';
import type { SampleDataset } from '@/services/sampleDatasets';
import type { DatasetHistoryListItem } from '@/shared/utils/datasetHistory';
import { useSampleDatasets } from '@/hooks/useSampleDatasets';
import { DatasetSourceSelector } from '@/features/workspace/welcome/DatasetSourceSelector';
import { SampleDatasetList } from '@/features/workspace/welcome/SampleDatasetList';
import { Button } from '@/shared/ui/button';
import { Separator } from '@/shared/ui/separator';
import { Spinner } from '@/shared/ui/spinner';

interface WelcomeScreenProps {
  isLoading?: boolean;
  loadingSourceName?: string;
  manualOpenHint?: string | null;
  onOpenFile: () => void;
  onOpenDirectory: () => void;
  onOpenTarPicker: () => void;
  onSubmitRemoteUrl: (url: string) => void | Promise<void>;
  remoteSubmitLoading?: boolean;
  onSelectSample: (sample: SampleDataset) => void | Promise<void>;
  onRequestChangeRemoteUrl?: () => void;
  historyItems?: DatasetHistoryListItem[];
  onReplayHistory?: (id: string) => void | Promise<void>;
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  isLoading,
  loadingSourceName,
  manualOpenHint,
  onOpenFile,
  onOpenDirectory,
  onOpenTarPicker,
  onSubmitRemoteUrl,
  remoteSubmitLoading,
  onSelectSample,
  onRequestChangeRemoteUrl,
  historyItems = [],
  onReplayHistory,
}) => {
  const { formatMessage } = useIntl();
  const { samples, loading: samplesLoading } = useSampleDatasets();
  const hasSamples = samples.length > 0;
  /** Show samples column while loading or when any samples exist; hide when none configured after load. */
  const showSamplesSection = samplesLoading || hasSamples;

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 bg-background px-6 py-16">
        <div className="w-full max-w-sm rounded-xl border border-border bg-card px-8 py-12 text-center shadow-sm">
          <Spinner className="mx-auto mb-5 size-10 text-primary" aria-hidden />
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            {formatMessage({ id: 'welcome.loadingTitle' })}
          </h2>
          {loadingSourceName ? (
            <p className="mx-auto mt-3 max-w-full truncate text-xs text-muted-foreground" title={loadingSourceName}>
              {loadingSourceName}
            </p>
          ) : null}
          <p className="mt-4 text-sm text-muted-foreground">{formatMessage({ id: 'welcome.loadingHint' })}</p>
        </div>
        {onRequestChangeRemoteUrl ? (
          <Button type="button" variant="link" className="text-sm" onClick={onRequestChangeRemoteUrl}>
            <Link2 data-icon="inline-start" aria-hidden />
            {formatMessage({ id: 'welcome.changeUrl' })}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="relative mx-auto flex min-h-[100dvh] w-full min-w-0 max-w-6xl flex-1 flex-col overflow-y-auto px-4 pb-12 pt-8 sm:px-6 sm:pb-16 sm:pt-12 lg:pb-20 lg:pt-14">
        <div className="flex flex-1 flex-col">
          <header className="mb-10 text-center sm:mb-12">
            <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
            {formatMessage({ id: 'common.productName' })}
          </h1>
          <p
            className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg"
            data-readability
          >
            {formatMessage({ id: 'welcome.heroSubtitle' })}
            </p>
          </header>

          <section className="mx-auto w-full max-w-xl sm:max-w-2xl">
          {manualOpenHint ? (
            <p className="mt-4 text-center text-sm text-muted-foreground">{manualOpenHint}</p>
          ) : null}
          <div className="mt-5">
            <DatasetSourceSelector
              onOpenFile={onOpenFile}
              onOpenDirectory={onOpenDirectory}
              onOpenTarPicker={onOpenTarPicker}
              onSubmitRemoteUrl={(u) => void onSubmitRemoteUrl(u)}
              remoteSubmitLoading={remoteSubmitLoading}
              historyItems={historyItems}
              onReplayHistory={onReplayHistory}
            />
          </div>
        </section>

          {showSamplesSection ? (
            <section className="mt-auto shrink-0 pb-4 pt-12 sm:pt-14">
            <Separator />
            <div className="mt-8">
              <SampleDatasetList
                samples={samples}
                loading={samplesLoading}
                onSelect={onSelectSample}
                variant="bottom"
              />
            </div>
            </section>
          ) : null}
        </div>

        <footer className="mt-8 shrink-0 pb-2 text-center sm:mt-10">
          <p className="text-xs text-muted-foreground sm:text-sm">
            <span>{formatMessage({ id: 'welcome.footerDevelopedBy' })}</span>
            <a
              href="https://io-ai.tech"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline"
            >
              {formatMessage({ id: 'welcome.footerOrgName' })}
            </a>
            <span>{formatMessage({ id: 'welcome.footerDevelopedSuffix' })}</span>
            <a
              href="https://github.com/ioai-tech/rosview"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline"
            >
              {formatMessage({ id: 'welcome.footerOpenSourceLink' })}
            </a>
            <span>{formatMessage({ id: 'welcome.footerOpenSourceSuffix' })}</span>
          </p>
        </footer>
      </div>
    </div>
  );
};
