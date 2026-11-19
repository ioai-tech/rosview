import React from 'react';
import { useIntl } from 'react-intl';

/**
 * Says why a panel has no data for its window (for example a stalled range request), instead of
 * an empty or forever-loading panel.
 */
export const PanelReadError: React.FC<{ reason: string; className?: string }> = ({ reason, className }) => {
  const { formatMessage } = useIntl();
  return (
    <div
      role="alert"
      data-testid="panel-read-error"
      className={`rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive break-words ${className ?? ''}`}
    >
      {formatMessage({ id: 'panels.common.readFailed' }, { reason })}
    </div>
  );
};
