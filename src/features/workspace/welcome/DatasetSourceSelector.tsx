import React, { useState } from 'react';
import { useIntl } from 'react-intl';
import { Archive, ChevronDown, ChevronUp, Clock, FileVideo, FolderOpen, Globe2 } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/shared/ui/item';
import { Button } from '@/shared/ui/button';
import { Collapsible, CollapsibleTrigger } from '@/shared/ui/collapsible';
import { RemoteRecordingUrlForm } from './RemoteRecordingUrlForm';
import type { DatasetHistoryListItem } from '@/shared/utils/datasetHistory';

interface DatasetSourceSelectorProps {
  onOpenFile: () => void;
  onOpenDirectory: () => void;
  onOpenTarPicker: () => void;
  onSubmitRemoteUrl: (url: string) => void;
  remoteSubmitLoading?: boolean;
  className?: string;
  historyItems?: DatasetHistoryListItem[];
  onReplayHistory?: (id: string) => void | Promise<void>;
}

export const DatasetSourceSelector: React.FC<DatasetSourceSelectorProps> = ({
  onOpenFile,
  onOpenDirectory,
  onOpenTarPicker,
  onSubmitRemoteUrl,
  remoteSubmitLoading,
  className = '',
  historyItems = [],
  onReplayHistory,
}) => {
  const { formatMessage } = useIntl();
  const [tab, setTab] = useState('file');
  const [historyExpanded, setHistoryExpanded] = useState(false);

  const dropCardClass =
    'group flex w-full cursor-pointer flex-col items-center gap-3 rounded-lg bg-muted/25 px-6 py-10 text-center transition-colors hover:bg-muted/40 active:bg-muted/50';

  const recent = historyItems.slice(0, 3);
  const visibleHistory = historyExpanded ? historyItems : recent;
  const canExpand = historyItems.length > 3;

  const kindLabel = (kind: DatasetHistoryListItem['kind']) => {
    switch (kind) {
      case 'url':
        return formatMessage({ id: 'welcome.historyKindUrl' });
      case 'remote_tar':
        return formatMessage({ id: 'welcome.historyKindRemoteTar' });
      case 'sample':
        return formatMessage({ id: 'welcome.historyKindSample' });
      case 'directory':
      case 'directory_fallback':
        return formatMessage({ id: 'welcome.historyKindFolder' });
      case 'files':
      case 'file_meta':
        return formatMessage({ id: 'welcome.historyKindFiles' });
      case 'local_tar':
        return formatMessage({ id: 'welcome.historyKindTar' });
      default:
        return '';
    }
  };

  const renderHistoryItem = (item: DatasetHistoryListItem) => (
    <Item
      key={item.id}
      size="sm"
      variant="muted"
      render={
        <button
          type="button"
          className="w-full text-left hover:bg-muted/60 data-[state=active]:bg-muted/60"
          aria-label={item.displayName}
        />
      }
      onClick={() => void onReplayHistory!(item.id)}
    >
      <ItemMedia variant="icon" className="mt-0.5 h-auto w-auto rounded bg-muted px-1.5 py-0.5">
        <span className="text-[10px] font-medium uppercase text-muted-foreground">{kindLabel(item.kind)}</span>
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{item.displayName}</ItemTitle>
        {item.detail ? <ItemDescription>{item.detail}</ItemDescription> : null}
      </ItemContent>
    </Item>
  );

  const historyTitleRow = (
    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {formatMessage({ id: 'welcome.historyTitle' })}
    </div>
  );

  const historyListSection =
    historyItems.length === 0 ? (
      <p className="text-xs text-muted-foreground">{formatMessage({ id: 'welcome.historyEmpty' })}</p>
    ) : (
      <ScrollArea className={canExpand && historyExpanded ? 'max-h-48' : canExpand ? 'max-h-none' : undefined}>
        <ItemGroup>{visibleHistory.map((item) => renderHistoryItem(item))}</ItemGroup>
      </ScrollArea>
    );

  return (
    <div className={className}>
      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="grid h-auto w-full grid-cols-2 gap-0.5 rounded-lg bg-muted/30 p-0.5 sm:grid-cols-4">
          <TabsTrigger
            value="file"
            className="gap-1.5 text-xs shadow-none data-[state=active]:shadow-none sm:text-sm"
          >
            <FileVideo className="h-4 w-4 shrink-0" />
            <span className="truncate">{formatMessage({ id: 'welcome.tabFile' })}</span>
          </TabsTrigger>
          <TabsTrigger value="dir" className="gap-1.5 text-xs shadow-none data-[state=active]:shadow-none sm:text-sm">
            <FolderOpen className="h-4 w-4 shrink-0" />
            <span className="truncate">{formatMessage({ id: 'welcome.tabDirectory' })}</span>
          </TabsTrigger>
          <TabsTrigger value="remote" className="gap-1.5 text-xs shadow-none data-[state=active]:shadow-none sm:text-sm">
            <Globe2 className="h-4 w-4 shrink-0" />
            <span className="truncate">{formatMessage({ id: 'welcome.tabRemote' })}</span>
          </TabsTrigger>
          <TabsTrigger value="tar" className="gap-1.5 text-xs shadow-none data-[state=active]:shadow-none sm:text-sm">
            <Archive className="h-4 w-4 shrink-0" />
            <span className="truncate">{formatMessage({ id: 'welcome.tabTar' })}</span>
          </TabsTrigger>
        </TabsList>

        <div className="mt-5 min-h-44">
          <TabsContent value="file" className="focus-visible:outline-hidden">
            <button type="button" onClick={onOpenFile} className={dropCardClass}>
              <div className="rounded-full bg-muted/50 p-3 transition-colors group-hover:bg-muted/70">
                <FileVideo className="h-6 w-6 text-muted-foreground group-hover:text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium">{formatMessage({ id: 'welcome.openFile' })}</p>
                <p className="mt-1 text-xs text-muted-foreground">{formatMessage({ id: 'welcome.fileTypes' })}</p>
              </div>
            </button>
          </TabsContent>

          <TabsContent value="dir" className="focus-visible:outline-hidden">
            <button type="button" onClick={onOpenDirectory} className={dropCardClass}>
              <div className="rounded-full bg-muted/50 p-3 transition-colors group-hover:bg-muted/70">
                <FolderOpen className="h-6 w-6 text-muted-foreground group-hover:text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium">{formatMessage({ id: 'welcome.openDirectory' })}</p>
                <p className="mt-1 text-xs text-muted-foreground">{formatMessage({ id: 'welcome.directoryHint' })}</p>
              </div>
            </button>
          </TabsContent>

          <TabsContent value="remote" className="focus-visible:outline-hidden">
            <RemoteRecordingUrlForm onSubmit={onSubmitRemoteUrl} isLoading={remoteSubmitLoading} />
          </TabsContent>

          <TabsContent value="tar" className="focus-visible:outline-hidden">
            <button type="button" onClick={onOpenTarPicker} className={dropCardClass}>
              <div className="rounded-full bg-muted/50 p-3 transition-colors group-hover:bg-muted/70">
                <Archive className="h-6 w-6 text-muted-foreground group-hover:text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium">{formatMessage({ id: 'welcome.openLocalTar' })}</p>
                <p className="mt-1 text-xs text-muted-foreground">{formatMessage({ id: 'welcome.tarHint' })}</p>
              </div>
            </button>
          </TabsContent>
        </div>
      </Tabs>

      {onReplayHistory ? (
        <div className="mt-8 flex flex-col gap-3 pt-2">
          {canExpand ? (
            <Collapsible open={historyExpanded} onOpenChange={setHistoryExpanded}>
              <div className="flex items-center justify-between gap-2">
                {historyTitleRow}
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    title={
                      historyExpanded
                        ? formatMessage({ id: 'welcome.historyCollapse' })
                        : formatMessage({ id: 'welcome.historyExpand' })
                    }
                  >
                    {historyExpanded ? (
                      <ChevronUp data-icon="inline-start" aria-hidden />
                    ) : (
                      <ChevronDown data-icon="inline-start" aria-hidden />
                    )}
                    <span className="sr-only">
                      {historyExpanded
                        ? formatMessage({ id: 'welcome.historyCollapse' })
                        : formatMessage({ id: 'welcome.historyExpand' })}
                    </span>
                  </Button>
                </CollapsibleTrigger>
              </div>
              {historyListSection}
            </Collapsible>
          ) : (
            <>
              {historyTitleRow}
              {historyListSection}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
};
