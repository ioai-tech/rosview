import React, { useCallback } from 'react';
import { useIntl } from 'react-intl';
import { MoreHorizontal } from 'lucide-react';
import type { TopicInfo } from '@/core/types/ros';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { getTopicMetricLines } from './topicMetrics';
import { writeTopicDragPayload } from './topicDragPayload';

async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fallback for non-secure contexts or denied permission
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

interface TopicRowProps {
  topic: TopicInfo;
  isSelected: boolean;
  onSelect: (topicName: string) => void;
}

export const TopicRow: React.FC<TopicRowProps> = ({ topic, isSelected, onSelect }) => {
  const { formatMessage } = useIntl();
  const metrics = getTopicMetricLines(topic);

  const handleCopyTopicName = useCallback(() => {
    void copyTextToClipboard(topic.name);
  }, [topic.name]);

  const handleCopySchemaName = useCallback(() => {
    void copyTextToClipboard(topic.type);
  }, [topic.type]);

  const rowTitle = (() => {
    const lines = [topic.name, topic.type];
    if (metrics.secondary) {
      lines.push(metrics.secondary);
    }
    return lines.join('\n');
  })();

  return (
    <div
      className={cn(
        'flex w-full flex-col border-b border-border/50 text-left text-xs transition-colors',
        'hover:bg-accent/35',
        isSelected && 'bg-accent/50 text-foreground',
      )}
    >
      <div
        role="button"
        tabIndex={0}
        draggable
        aria-pressed={isSelected}
        aria-label={topic.name}
        title={rowTitle}
        onClick={() => onSelect(topic.name)}
        onFocus={() => onSelect(topic.name)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(topic.name);
          }
        }}
        onDragStart={(event) => {
          onSelect(topic.name);
          writeTopicDragPayload(event.dataTransfer, { name: topic.name, type: topic.type });
        }}
        className={cn(
          'flex w-full cursor-grab items-start gap-3 p-2 outline-hidden',
          'active:cursor-grabbing focus-visible:ring-1 focus-visible:ring-ring/50',
        )}
      >
        <div className="min-w-0 flex-1 flex flex-col gap-1">
          <div className="truncate text-[12px] font-medium leading-4">{topic.name}</div>
          <div className="truncate text-[10px] leading-4 text-muted-foreground">{topic.type}</div>
        </div>
        <div className="flex flex-col justify-end items-end gap-1">
          {(metrics.primary || metrics.secondary) && (
            <div className="shrink-0 whitespace-nowrap text-right font-mono text-[10px] leading-4 text-muted-foreground tabular-nums">
              {metrics.primary}
              {metrics.secondary ? (
                <span className="topic-row-count-extra">
                  {metrics.primary ? ' / ' : null}
                  {metrics.secondary}
                </span>
              ) : null}
            </div>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-4 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                aria-label={formatMessage({ id: 'sidebar.topicRow.actionsMenu' })}
                onPointerDown={(e) => e.stopPropagation()}
                onFocus={() => onSelect(topic.name)}
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem className="text-xs" onSelect={handleCopyTopicName}>
                {formatMessage({ id: 'sidebar.topicRow.copyTopicName' })}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-xs" onSelect={handleCopySchemaName}>
                {formatMessage({ id: 'sidebar.topicRow.copySchemaName' })}
              </DropdownMenuItem>
              {topic.sourceLabels && topic.sourceLabels.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    {formatMessage(
                      { id: 'sidebar.topicRow.sourceFiles' },
                      { files: topic.sourceLabels.join(', ') },
                    )}
                  </DropdownMenuLabel>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
};
