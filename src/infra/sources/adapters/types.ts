import type { Initialization, MessageEvent, PlayerProblem, RosDatatypes } from '@/core/types/ros';

/**
 * Topic adapters turn vendor-specific messages (typically JSON blobs from a
 * custom recorder) into standard ROS topics so the stock panels work without
 * knowing the format. They run inside the source worker, wrapped around any
 * `IIterableSource` by `TopicAdapterIterableSource`.
 */

export interface DerivedTopic {
  name: string;
  type: string;
  /** Builds the derived message from one source message; `undefined` skips it. */
  derive: (message: unknown, event: MessageEvent) => unknown;
}

export interface TopicAdapterPlan {
  derived: DerivedTopic[];
  /** Replaces the source topic's own message, e.g. to drop heavy base64 payloads. */
  transformSource?: (message: unknown) => unknown;
  problems?: PlayerProblem[];
}

export interface TopicAdapter {
  id: string;
  /** Source schema names (topic `type`) this adapter consumes. */
  schemaNames: readonly string[];
  datatypes?: RosDatatypes;
  /**
   * Plans derived topics from the first message of a matching topic. `init`
   * is the wrapped source's initialization (all topics, before adaptation).
   */
  plan: (sourceTopic: string, sample: unknown, init: Initialization) => TopicAdapterPlan | undefined;
}
