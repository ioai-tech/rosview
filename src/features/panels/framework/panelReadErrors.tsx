import React, { createContext, useContext } from 'react';
import { useIntl } from 'react-intl';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { TopicReadError } from '@/core/types/player';

/**
 * The read errors of the topics this panel reads (its subscriptions and high-frequency consumers),
 * provided by the panel shell. The shell shows them for every panel; a panel only uses
 * `usePanelTopicReadError` to stop saying "Waiting for …" about a topic that will not come.
 */
const PanelReadErrorContext = createContext<ReadonlyArray<TopicReadError> | undefined>(undefined);

export const PanelReadErrorProvider = PanelReadErrorContext.Provider;

export function usePanelReadErrorsFromPlayer(panelId: string): ReadonlyArray<TopicReadError> | undefined {
  return useMessagePipeline((state) => state.playerState.activeData?.panelReadErrors?.[panelId]);
}

/** Why `topic` could not be read in this panel, if it could not. */
export function usePanelTopicReadError(topic: string | undefined): string | undefined {
  const errors = useContext(PanelReadErrorContext);
  if (!errors || !topic) return undefined;
  return errors.find((entry) => entry.topic === topic)?.message;
}

/** The shell's notice: one line per topic of the panel that could not be read. */
export const PanelTopicReadErrors: React.FC<{ errors: ReadonlyArray<TopicReadError> }> = ({ errors }) => {
  const { formatMessage } = useIntl();
  return (
    <div
      role="alert"
      data-testid="panel-topic-read-error"
      className="pointer-events-none absolute inset-x-2 bottom-2 z-30 space-y-0.5 rounded border border-destructive/40 bg-background/95 px-2 py-1 text-[11px] text-destructive shadow-xs"
    >
      {errors.map(({ topic, message }) => (
        <p key={topic} className="break-words">
          {formatMessage({ id: 'panels.framework.topicReadFailed' }, { topic, reason: message })}
        </p>
      ))}
    </div>
  );
};
