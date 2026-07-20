import type { Player } from '@/core/types/player';
import { toNano } from '@/shared/utils/time';
import { parseSceneMeshes, type SceneMeshFrame } from './sceneMesh';

type SceneMeshListener = (frame: SceneMeshFrame) => void;

interface SceneMeshBroker {
  consumerId: string;
  listeners: Set<SceneMeshListener>;
}

const brokersByPlayer = new WeakMap<Player, Map<string, SceneMeshBroker>>();
let nextBrokerId = 1;

export function subscribeSceneMeshTopic(
  player: Player,
  topic: string,
  listener: SceneMeshListener,
): () => void {
  let brokers = brokersByPlayer.get(player);
  if (!brokers) {
    brokers = new Map();
    brokersByPlayer.set(player, brokers);
  }
  let broker = brokers.get(topic);
  if (!broker) {
    broker = {
      consumerId: `scene-mesh-broker-${nextBrokerId}`,
      listeners: new Set(),
    };
    nextBrokerId += 1;
    brokers.set(topic, broker);
    const activeBroker = broker;
    player.registerHighFrequencyConsumer(activeBroker.consumerId, {
      topic,
      lane: 'pointcloud',
      mode: 'all',
      onMessageBatch: (messages) => {
        for (const event of messages) {
          const frame = parseSceneMeshes(event.message, toNano(event.publishTime));
          if (!frame) continue;
          for (const activeListener of activeBroker.listeners) activeListener(frame);
        }
      },
    });
  }
  broker.listeners.add(listener);

  return () => {
    const activeBrokers = brokersByPlayer.get(player);
    const activeBroker = activeBrokers?.get(topic);
    if (!activeBroker) return;
    activeBroker.listeners.delete(listener);
    if (activeBroker.listeners.size > 0) return;
    player.unregisterHighFrequencyConsumer(activeBroker.consumerId);
    activeBrokers?.delete(topic);
    if (activeBrokers?.size === 0) brokersByPlayer.delete(player);
  };
}
