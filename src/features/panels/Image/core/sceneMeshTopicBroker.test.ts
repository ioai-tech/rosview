import { describe, expect, it, vi } from 'vitest';
import type { HighFrequencyConsumer, Player } from '@/core/types/player';
import type { MessageEvent } from '@/core/types/ros';
import { subscribeSceneMeshTopic } from './sceneMeshTopicBroker';

function sceneEvent(timestampSec: number): MessageEvent {
  return {
    topic: '/warehouse/safety_zones',
    schemaName: 'foxglove.SceneUpdate',
    receiveTime: { sec: timestampSec, nsec: 0 },
    publishTime: { sec: timestampSec, nsec: 0 },
    message: {
      entities: [{
        id: 'loading-bay',
        timestamp: { sec: timestampSec, nsec: 0 },
        triangles: [{
          points: [
            { x: 0, y: 0, z: 1 },
            { x: 1, y: 0, z: 1 },
            { x: 0, y: 1, z: 1 },
          ],
          indices: [0, 1, 2],
        }],
      }],
    },
    sizeInBytes: 1,
  };
}

describe('subscribeSceneMeshTopic', () => {
  it('decodes each all-frame batch once and shares it across panel listeners', () => {
    let consumer: HighFrequencyConsumer | undefined;
    const register = vi.fn((_id: string, next: HighFrequencyConsumer) => {
      consumer = next;
    });
    const unregister = vi.fn();
    const player = {
      registerHighFrequencyConsumer: register,
      unregisterHighFrequencyConsumer: unregister,
    } as unknown as Player;
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = subscribeSceneMeshTopic(player, '/warehouse/safety_zones', first);
    const unsubscribeSecond = subscribeSceneMeshTopic(player, '/warehouse/safety_zones', second);
    consumer?.onMessageBatch?.([sceneEvent(1), sceneEvent(2)]);

    expect(register).toHaveBeenCalledTimes(1);
    expect(consumer?.mode).toBe('all');
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(first.mock.calls[0]?.[0]).toBe(second.mock.calls[0]?.[0]);

    unsubscribeFirst();
    expect(unregister).not.toHaveBeenCalled();
    unsubscribeSecond();
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
