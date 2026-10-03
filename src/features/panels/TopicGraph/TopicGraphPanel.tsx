import React, { useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import cytoscape from 'cytoscape';
import type { Player } from '@/core/types/player';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { MessagePipelineState } from '@/core/pipeline/store';
import { Graph } from './Graph';
import type { GraphMutation } from './Graph';
import { Maximize, ArrowRightLeft } from 'lucide-react';

interface TopicGraphPanelProps {
  player: Player;
  panelId: string;
  rankDir?: 'TB' | 'LR';
  showControls?: boolean;
}

export const TopicGraphPanel: React.FC<TopicGraphPanelProps> = ({
  player: _player,
  panelId: _panelId,
  rankDir: rankDirProp = 'LR',
  showControls = true,
}) => {
  const { formatMessage } = useIntl();
  const publishersByTopic = useMessagePipeline((state: MessagePipelineState) => state.publishersByTopic);
  const [rankDir, setRankDir] = useState<'TB' | 'LR'>(rankDirProp);
  const graphRef = useRef<GraphMutation>(null);

  React.useEffect(() => {
    setRankDir(rankDirProp);
  }, [rankDirProp]);

  const elements = useMemo(() => {
    const nodes: cytoscape.ElementDefinition[] = [];
    const edges: cytoscape.ElementDefinition[] = [];
    const nodeIds = new Set<string>();
    const topicNames = new Set<string>();

    if (!publishersByTopic || publishersByTopic.size === 0) return [];

    publishersByTopic.forEach((publishers: Set<string>, topic: string) => {
      topicNames.add(topic);
      publishers.forEach((node) => nodeIds.add(node));
    });

    nodeIds.forEach((node) => {
      nodes.push({
        data: { id: `n:${node}`, label: node, type: 'node' },
      });
    });

    topicNames.forEach((topic) => {
      nodes.push({
        data: { id: `t:${topic}`, label: topic, type: 'topic' },
      });
    });

    publishersByTopic.forEach((publishers: Set<string>, topic: string) => {
      publishers.forEach((node) => {
        edges.push({
          data: {
            id: `e:${node}-${topic}`,
            source: `n:${node}`,
            target: `t:${topic}`,
          },
        });
      });
    });

    return [...nodes, ...edges];
  }, [publishersByTopic]);

  if (!publishersByTopic || elements.length === 0) {
    return (
      <div className="flex flex-col h-full bg-background items-center justify-center p-4">
        <div className="text-muted-foreground text-center text-xs italic">
          {formatMessage({ id: 'panels.topicGraph.empty.waitingMetadata' })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background relative overflow-hidden">
      {showControls && (
        <div className="absolute top-2 right-2 z-10 flex gap-1">
          <button
            onClick={() => setRankDir((prev) => (prev === 'LR' ? 'TB' : 'LR'))}
            className="p-1.5 bg-background/80 border rounded-md hover:bg-accent shadow-xs"
            title={formatMessage({ id: 'panels.topicGraph.toolbar.toggleOrientation' })}
          >
            <ArrowRightLeft size={14} className={rankDir === 'TB' ? 'rotate-90 transition-transform' : 'transition-transform'} />
          </button>
          <button
            onClick={() => graphRef.current?.fit()}
            className="p-1.5 bg-background/80 border rounded-md hover:bg-accent shadow-xs"
            title={formatMessage({ id: 'panels.topicGraph.toolbar.fitView' })}
          >
            <Maximize size={14} />
          </button>
        </div>
      )}
      <Graph elements={elements} rankDir={rankDir} graphRef={graphRef} />
    </div>
  );
};
