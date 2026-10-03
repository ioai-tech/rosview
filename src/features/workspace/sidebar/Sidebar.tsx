import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { useIntl } from 'react-intl';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { MessagePipelineState } from '@/core/pipeline/store';
import type { Player } from '@/core/types/player';
import type { TopicInfo } from '@/core/types/ros';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { Skeleton } from '@/shared/ui/skeleton';
import { AlertTriangle, Database, Layers, Search, Settings2 } from 'lucide-react';
import { useSidebarStore } from '@/shared/hooks/useSidebarStore';
import { PanelSettingsTab } from './PanelSettingsTab';
import { TopicRow } from './topic-list/TopicRow';
import { QualitySidebar } from './QualitySidebar';
import type { PreferencePersistence } from '@/core/preferences/types';
import { writePreferences } from '@/core/preferences/readWritePreferences';
import type { RosViewExtension, RosViewExtensionContext, SidebarTabContribution } from '@/core/extensions/types';
import { SidebarExtensionHost } from '@/features/extensions/SidebarExtensionHost';
import type { DatasetItem } from '@/shared/utils/datasetSources';
import { groupDatasets } from '@/shared/utils/datasetSources';
import { formatBytes } from '@/shared/utils/formatBytes';
import { cn } from '@/shared/lib/utils';

const SIDEBAR_TAB_TRIGGER_CLASS =
  'flex flex-1 items-center justify-center gap-1 border-b-2 border-transparent px-2 py-2 text-xs font-medium transition-colors hover:bg-accent/70 data-[state=active]:border-primary data-[state=active]:bg-background data-[state=active]:text-primary';

const TOPIC_LIST_SKELETON_ROWS = 8;

function TopicRowSkeleton(): React.ReactElement {
  return (
    <div className="flex w-full items-start gap-3 border-b border-border/50 p-2">
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <Skeleton className="h-4 w-[75%]" />
        <Skeleton className="h-3 w-[55%]" />
      </div>
      <Skeleton className="h-4 w-10 shrink-0" />
    </div>
  );
}

interface SidebarProps {
  player: Player;
  datasets: DatasetItem[];
  activeDatasetId?: string;
  onDatasetSelect: (id: string) => void;
  autoDataQualityScan: boolean;
  onAutoDataQualityScanChange: (enabled: boolean) => void;
  preferencePersistence: PreferencePersistence;
  extensionContext: RosViewExtensionContext;
  extensions?: RosViewExtension[];
  /** Tab id to select once on mount when listed in extension or built-in tabs. */
  initialSidebarTab?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({
  player,
  datasets,
  activeDatasetId,
  onDatasetSelect,
  autoDataQualityScan,
  onAutoDataQualityScanChange,
  preferencePersistence,
  extensionContext,
  extensions = [],
  initialSidebarTab,
}) => {
  const { formatMessage } = useIntl();
  const topics = useMessagePipeline((state: MessagePipelineState) => state.sortedTopics);
  const playerPresence = useMessagePipeline((state: MessagePipelineState) => state.playerState.presence);
  const topicsLoading = playerPresence === 'preinit' || playerPresence === 'initializing';
  const activeTab = useSidebarStore((s) => s.tab);
  const setActiveTab = useSidebarStore((s) => s.setTab);
  const initialSidebarTabAppliedRef = useRef(false);
  const qualityFilter = useSidebarStore((s) => s.qualityFilter);
  const setQualityFilter = useSidebarStore((s) => s.setQualityFilter);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTopicName, setSelectedTopicName] = useState<string | null>(null);
  const dataQualityReport = useMessagePipeline(
    (state: MessagePipelineState) => state.playerState.progress.dataQualityReport,
  );
  const qualityTimelineStart = useMessagePipeline((state: MessagePipelineState) => state.playerState.activeData?.startTime);
  const extensionTabs = useMemo<SidebarTabContribution[]>(
    () =>
      extensions
        .flatMap((extension) => extension.sidebarTabs ?? [])
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [extensions],
  );

  const showDatasetsTab = datasets.length !== 1;
  /** One row per merged session; a standalone file is a group of one. */
  const datasetGroups = useMemo(() => groupDatasets(datasets), [datasets]);

  const tabValue = !showDatasetsTab && activeTab === 'datasets' ? 'topics' : activeTab;

  const filteredTopics = useMemo(() => {
    if (!searchQuery.trim()) return topics;
    const lowerQ = searchQuery.toLowerCase();
    return topics.filter(
      (t: TopicInfo) => t.name.toLowerCase().includes(lowerQ) || t.type.toLowerCase().includes(lowerQ),
    );
  }, [topics, searchQuery]);

  useEffect(() => {
    if (topics.length === 0) {
      setSelectedTopicName(null);
      return;
    }
    if (selectedTopicName && topics.some((topic: TopicInfo) => topic.name === selectedTopicName)) {
      return;
    }
    setSelectedTopicName(topics[0]?.name ?? null);
  }, [topics, selectedTopicName]);

  useLayoutEffect(() => {
    if (!initialSidebarTab || initialSidebarTabAppliedRef.current) {
      return;
    }
    const isValid =
      initialSidebarTab === 'topics' ||
      (showDatasetsTab && initialSidebarTab === 'datasets') ||
      initialSidebarTab === 'quality' ||
      initialSidebarTab === 'settings' ||
      extensionTabs.some((tab) => tab.id === initialSidebarTab);
    if (isValid) {
      setActiveTab(initialSidebarTab);
      initialSidebarTabAppliedRef.current = true;
    }
  }, [extensionTabs, initialSidebarTab, setActiveTab, showDatasetsTab]);

  useEffect(() => {
    const tabId: string = activeTab;
    const isLegacyTab = tabId === 'annotations';
    const isKnown =
      activeTab === 'topics' ||
      (showDatasetsTab && activeTab === 'datasets') ||
      activeTab === 'quality' ||
      activeTab === 'settings' ||
      extensionTabs.some((tab) => tab.id === activeTab);
    if (isLegacyTab || !isKnown) {
      setActiveTab('topics');
    }
  }, [activeTab, extensionTabs, setActiveTab, showDatasetsTab]);


  return (
    <aside
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-r border-border/70 bg-card [container-name:sidebar] @container"
    >
      <Tabs.Root
        value={tabValue}
        onValueChange={(value) => {
          if (
            value === 'topics' ||
            (showDatasetsTab && value === 'datasets') ||
            value === 'quality' ||
            value === 'settings' ||
            extensionTabs.some((tab) => tab.id === value)
          ) {
            setActiveTab(value);
          }
        }}
        className="flex min-h-0 flex-1 flex-col bg-background"
      >
        <Tabs.List className="flex shrink-0 border-b border-border/60 bg-muted/20">
          <Tabs.Trigger value="topics" className={SIDEBAR_TAB_TRIGGER_CLASS}>
            <Layers size={14} />
            {formatMessage({ id: 'sidebar.tab.topics' })}
          </Tabs.Trigger>
          {showDatasetsTab ? (
            <Tabs.Trigger value="datasets" className={SIDEBAR_TAB_TRIGGER_CLASS}>
              <Database size={14} />
              {formatMessage({ id: 'sidebar.tab.datasets' })}
            </Tabs.Trigger>
          ) : null}
          <Tabs.Trigger value="quality" className={SIDEBAR_TAB_TRIGGER_CLASS}>
            <AlertTriangle size={14} />
            {formatMessage({ id: 'sidebar.tab.quality' })}
          </Tabs.Trigger>
          <Tabs.Trigger value="settings" className={SIDEBAR_TAB_TRIGGER_CLASS}>
            <Settings2 size={14} />
            {formatMessage({ id: 'sidebar.tab.settings' })}
          </Tabs.Trigger>
          {extensionTabs.map((tab) => (
            <Tabs.Trigger key={tab.id} value={tab.id} className={SIDEBAR_TAB_TRIGGER_CLASS}>
              {tab.icon}
              {tab.title}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content
          value="topics"
          className="flex-1 min-h-0 overflow-hidden outline-hidden data-[state=active]:flex flex-col"
        >
          <div className="px-2 py-2 border-b border-border/60 bg-background">
            <div className="relative flex items-center">
              <Search className="absolute left-2 text-muted-foreground" size={12} />
              <input
                type="text"
                name="topic-filter"
                placeholder={formatMessage({ id: 'sidebar.topicFilter' })}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-background border border-input rounded-sm text-xs pl-6 pr-2 py-1.5 focus:outline-hidden focus:ring-2 focus:ring-ring/40 transition-all"
              />
            </div>
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <div className="border-b border-border/50">
              {topicsLoading ? (
                Array.from({ length: TOPIC_LIST_SKELETON_ROWS }, (_, index) => (
                  <TopicRowSkeleton key={index} />
                ))
              ) : filteredTopics.length > 0 ? (
                filteredTopics.map((topic: TopicInfo) => (
                  <TopicRow
                    key={topic.name}
                    topic={topic}
                    isSelected={topic.name === selectedTopicName}
                    onSelect={setSelectedTopicName}
                  />
                ))
              ) : (
                <div className="text-xs text-muted-foreground italic px-2 mt-4 text-center">
                  {formatMessage({ id: 'sidebar.noTopics' })}
                </div>
              )}
            </div>
          </ScrollArea>
        </Tabs.Content>

        {showDatasetsTab ? (
          <Tabs.Content
            value="datasets"
            className="flex-1 min-h-0 overflow-hidden outline-hidden data-[state=active]:flex flex-col"
          >
            <ScrollArea className="flex-1 min-h-0">
              <div className="border-b border-border/50">
                {datasetGroups.length > 0 ? (
                  datasetGroups.map((group) => {
                    const isActive = group.groupId === activeDatasetId;
                    const primary = group.members[0];
                    const isMerged = group.members.length > 1;
                    const totalSizeBytes = group.members.reduce((sum, m) => {
                      const size = m.kind === 'file' ? m.file?.size : m.sizeBytes;
                      return sum + (typeof size === 'number' ? size : 0);
                    }, 0);
                    const sizeLabel = formatBytes(totalSizeBytes) ?? '—';
                    const displayName = isMerged
                      ? `${primary.name} +${String(group.members.length - 1)}`
                      : primary.name;
                    const rowTitle = [
                      ...group.members.map((m) => (m.kind === 'url' ? m.url ?? m.name : m.name)),
                      sizeLabel,
                    ]
                      .filter(Boolean)
                      .join('\n');
                    return (
                      <div
                        key={group.groupId}
                        className={cn(
                          'flex w-full flex-col border-b border-border/50 text-left text-xs transition-colors',
                          'hover:bg-accent/35',
                          isActive && 'bg-accent/50 text-foreground',
                        )}
                      >
                        <button
                          type="button"
                          title={rowTitle}
                          aria-current={isActive ? 'true' : undefined}
                          onClick={() => onDatasetSelect(group.groupId)}
                          className={cn(
                            'flex w-full cursor-pointer items-center gap-3 p-2 outline-hidden',
                            'focus-visible:ring-1 focus-visible:ring-ring/50',
                          )}
                        >
                          <div className="min-w-0 flex-1 overflow-hidden text-left">
                            <div className="line-clamp-2 wrap-break-word text-[12px] font-medium leading-[18px] text-foreground">
                              {displayName}
                              {!isMerged && primary.kind === 'url' && primary.url ? (
                                <>
                                  <br />
                                  <span className="text-[10px] font-normal leading-[18px] text-muted-foreground">
                                    {primary.url}
                                  </span>
                                </>
                              ) : null}
                            </div>
                            {isMerged ? (
                              <div className="line-clamp-3 wrap-break-word text-[10px] font-normal leading-[16px] text-muted-foreground">
                                {group.members.map((m) => m.name).join(' · ')}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 flex-col items-end justify-center gap-0.5 whitespace-nowrap text-right font-mono text-[10px] leading-[14px] text-muted-foreground tabular-nums">
                            <span>{sizeLabel}</span>
                            {isMerged ? (
                              <span>
                                {formatMessage(
                                  { id: 'sidebar.datasetGroup.fileCount' },
                                  { count: group.members.length },
                                )}
                              </span>
                            ) : null}
                          </div>
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <div className="text-xs text-muted-foreground italic px-2 mt-4 text-center">
                    {formatMessage({ id: 'sidebar.noDatasets' })}
                  </div>
                )}
              </div>
            </ScrollArea>
          </Tabs.Content>
        ) : null}

        <Tabs.Content
          value="quality"
          className="flex-1 min-h-0 overflow-hidden outline-hidden data-[state=active]:flex flex-col"
        >
          <QualitySidebar
            report={dataQualityReport}
            filter={qualityFilter}
            timelineStart={qualityTimelineStart}
            onFilterChange={setQualityFilter}
            autoDataQualityScan={autoDataQualityScan}
            onAutoDataQualityScanChange={(enabled) => {
              onAutoDataQualityScanChange(enabled);
              if (preferencePersistence === 'localStorage') {
                writePreferences({ autoDataQualityScan: enabled });
              }
            }}
            onRequestScan={() => {
              player.startDataQualityScan?.();
            }}
            onSeek={(time) => {
              player.seek(time);
            }}
          />
        </Tabs.Content>

        <Tabs.Content
          value="settings"
          className="flex-1 min-h-0 overflow-hidden outline-hidden data-[state=active]:flex flex-col"
        >
          <PanelSettingsTab player={player} topics={topics} />
        </Tabs.Content>
        {extensionTabs.map((tab) => (
          <Tabs.Content
            key={tab.id}
            value={tab.id}
            className="flex-1 min-h-0 overflow-hidden outline-hidden data-[state=active]:flex flex-col"
          >
            <SidebarExtensionHost contribution={tab} context={extensionContext} />
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </aside>
  );
};
