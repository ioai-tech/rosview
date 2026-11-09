import type { IIterableSource } from '../IIterableSource';
import { TopicAdapterIterableSource } from './TopicAdapterIterableSource';
import type { TopicAdapter } from './types';
import { dex3FrameAdapter, wholeBodyFrameAdapter, wholeBodyMetaAdapter } from './wholeBody/wholeBodyAdapter';

export type { DerivedTopic, TopicAdapter, TopicAdapterPlan } from './types';
export { TopicAdapterIterableSource } from './TopicAdapterIterableSource';

/** Adapters every source worker applies. Add new vendor formats here. */
export const BUILTIN_TOPIC_ADAPTERS: readonly TopicAdapter[] = [
  wholeBodyFrameAdapter,
  dex3FrameAdapter,
  wholeBodyMetaAdapter,
];

export function withBuiltinTopicAdapters(source: IIterableSource): IIterableSource {
  return new TopicAdapterIterableSource(source, BUILTIN_TOPIC_ADAPTERS);
}
