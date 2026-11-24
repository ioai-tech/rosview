import { useMemo } from 'react';
import { useIntl } from 'react-intl';
import type { PanelType } from '../panels/framework';
import { getPanelState, getPanelTypeFromId, listPanelStates, usePanelConfig } from '../panels/framework';
import { PANEL_TYPE_MESSAGE_SLUG } from '../panels/framework/panelMessageSlug';
import { getFoxgloveAdapter, getPanelDefinition, hasFoxgloveAdapter, hasPanelDefinition } from '../panels/registry';
import { useTopicLabel } from '@/shared/ros/topicLabels';
import { labelledPanelTitle, singleTopicOfPanelConfig } from './panelTitleLabel';

/** English fallback for the localized panel title (`panels.<slug>.defaultTitle`). */
function resolveDefaultTitle(panelId: string, dockviewTitle: string): string {
  const snapshot = listPanelStates()[panelId];
  if (snapshot?.type && hasPanelDefinition(snapshot.type)) {
    return getPanelDefinition(snapshot.type).defaultTitle;
  }
  const prefix = getPanelTypeFromId(panelId);
  if (hasPanelDefinition(prefix)) {
    return getPanelDefinition(prefix).defaultTitle;
  }
  if (hasFoxgloveAdapter(prefix)) {
    return getPanelDefinition(getFoxgloveAdapter(prefix).internalType).defaultTitle;
  }
  return dockviewTitle;
}

/** Resolves the PanelType for a panel id, returns null for unknown/welcome panels. */
export function resolvePanelType(panelId: string): PanelType | null {
  const snapshot = listPanelStates()[panelId];
  if (snapshot?.type && hasPanelDefinition(snapshot.type)) {
    return snapshot.type;
  }
  const prefix = getPanelTypeFromId(panelId);
  if (hasPanelDefinition(prefix)) {
    return prefix;
  }
  if (hasFoxgloveAdapter(prefix)) {
    return getFoxgloveAdapter(prefix).internalType;
  }
  return null;
}

export interface PanelDisplayTitle {
  panelType: PanelType | null;
  /** What the tab shows: the host's label for the panel's topic, else the localized panel title. */
  text: string;
  /** Hover text: the panel title, the label and the topic when a label is shown. */
  tooltip: string;
}

/**
 * Display title of a panel: localized panel type title (`panels.<slug>.defaultTitle`), replaced by
 * the host's topic label (`RosViewerProps.topicLabels`) when the panel shows one labelled topic.
 * Display only: the layout keeps its own title.
 */
export function usePanelDisplayTitle(panelId: string, dockviewTitle: string): PanelDisplayTitle {
  const { formatMessage } = useIntl();
  const panelType = resolvePanelType(panelId);
  const defaultTitleFallback = resolveDefaultTitle(panelId, dockviewTitle);
  const typeTitle = useMemo(() => {
    if (panelType != null && hasPanelDefinition(panelType)) {
      const slug = PANEL_TYPE_MESSAGE_SLUG[panelType];
      return formatMessage({ id: `panels.${slug}.defaultTitle`, defaultMessage: defaultTitleFallback });
    }
    return defaultTitleFallback;
  }, [formatMessage, panelType, defaultTitleFallback]);
  const liveConfig = usePanelConfig(panelId);
  const topic = singleTopicOfPanelConfig(liveConfig ?? getPanelState(panelId)?.config);
  const label = useTopicLabel(topic);
  return { panelType, ...labelledPanelTitle(typeTitle, topic, label) };
}
