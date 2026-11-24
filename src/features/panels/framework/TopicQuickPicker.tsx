import React, { useMemo, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { useIntl } from 'react-intl';

import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { TopicInfo } from '@/core/types/ros';
import { Button } from '@/shared/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/shared/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { cn } from '@/shared/lib/utils';
import { topicLabelOf, useTopicLabels, type TopicLabels } from '@/shared/ros/topicLabels';

function filterTopics(
  topics: ReadonlyArray<TopicInfo>,
  typeIncludes?: ReadonlyArray<string>,
  topicTypeMatches?: (topicType: string) => boolean,
  nameIncludes?: string,
): TopicInfo[] {
  return topics.filter((topic) => {
    if (topicTypeMatches && !topicTypeMatches(topic.type)) {
      return false;
    }
    if (typeIncludes && typeIncludes.length > 0) {
      const t = topic.type.toLowerCase();
      if (!typeIncludes.some((token) => t.includes(token.toLowerCase()))) {
        return false;
      }
    }
    if (nameIncludes && nameIncludes.length > 0 && !topic.name.includes(nameIncludes)) {
      return false;
    }
    return true;
  });
}

function itemSearchValue(topic: TopicInfo, labels: TopicLabels): string {
  const label = topicLabelOf(labels, topic.name);
  return label ? `${label} ${topic.name} ${topic.type}` : `${topic.name} ${topic.type}`;
}

export interface TopicQuickPickerProps {
  value: string;
  onChange: (topicName: string) => void;
  topics?: ReadonlyArray<TopicInfo>;
  typeIncludes?: ReadonlyArray<string>;
  topicTypeMatches?: (topicType: string) => boolean;
  nameIncludes?: string;
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
}

export const TopicQuickPicker: React.FC<TopicQuickPickerProps> = ({
  value,
  onChange,
  topics: topicsProp,
  typeIncludes,
  topicTypeMatches,
  nameIncludes,
  disabled,
  placeholder: placeholderProp,
  searchPlaceholder: searchPlaceholderProp,
  emptyLabel: emptyLabelProp,
  className,
  triggerClassName,
  contentClassName,
}) => {
  const { formatMessage } = useIntl();
  const placeholder = placeholderProp ?? formatMessage({ id: 'panels.framework.topicPicker.placeholder' });
  const searchPlaceholder = searchPlaceholderProp ?? formatMessage({ id: 'panels.framework.topicPicker.searchPlaceholder' });
  const emptyLabel = emptyLabelProp ?? formatMessage({ id: 'panels.framework.topicPicker.empty' });
  const pipelineTopics = useMessagePipeline((s) => s.sortedTopics);
  const labels = useTopicLabels();
  const valueLabel = topicLabelOf(labels, value);
  const topics = topicsProp ?? pipelineTopics;
  const filtered = useMemo(
    () => filterTopics(topics, typeIncludes, topicTypeMatches, nameIncludes),
    [topics, typeIncludes, topicTypeMatches, nameIncludes],
  );

  const [open, setOpen] = useState(false);

  const resolveTopicName = (selected: string): string | undefined => {
    const lower = selected.toLowerCase();
    const exact = filtered.find((t) => itemSearchValue(t, labels).toLowerCase() === lower);
    if (exact) {
      return exact.name;
    }
    return filtered.find((t) => t.name.toLowerCase() === lower)?.name;
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          title={valueLabel ? value : undefined}
          className={cn(
            'h-8 min-w-0 w-full justify-between gap-2 px-2 font-mono text-xs font-normal',
            className,
            triggerClassName,
          )}
        >
          {valueLabel ? (
            // The host's name for the stream first; the topic stays readable as secondary text.
            <span className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
              <span className="max-w-full shrink-0 truncate font-sans font-medium" data-testid="topic-picker-label">
                {valueLabel}
              </span>
              <span className="min-w-0 shrink-[100] truncate text-[10px] opacity-60" data-testid="topic-picker-topic">
                {value}
              </span>
            </span>
          ) : (
            <span className="truncate text-left">{value.length > 0 ? value : placeholder}</span>
          )}
          <ChevronsUpDown data-icon="inline-end" className="shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className={cn('w-[min(28rem,calc(100vw-2rem))] p-0', contentClassName)} align="start">
        <Command shouldFilter>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              {filtered.map((topic) => {
                const isCurrent = topic.name === value;
                const label = topicLabelOf(labels, topic.name);
                return (
                  <CommandItem
                    key={topic.name}
                    value={itemSearchValue(topic, labels)}
                    className={cn(isCurrent && 'bg-primary/10')}
                    onSelect={(selected) => {
                      const name = resolveTopicName(selected);
                      if (name != null) {
                        onChange(name);
                      }
                      setOpen(false);
                    }}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className={cn('truncate text-[11px] font-medium leading-4', isCurrent ? 'text-primary' : 'text-foreground')}>
                        {label ?? topic.name}
                      </div>
                      {label ? (
                        <div className="truncate text-[10px] leading-4 text-muted-foreground" title={topic.name}>
                          {topic.name}
                        </div>
                      ) : null}
                      <div className="truncate text-[10px] leading-4 text-muted-foreground">
                        {topic.type}
                      </div>
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
