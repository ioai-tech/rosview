import type { Initialization, MessageEvent, TopicInfo } from '@/core/types/ros';
import type { GetAdjacentMessageArgs, IIterableSource } from '../IIterableSource';
import type { MessageIteratorArgs, GetBackfillMessagesArgs } from '@/infra/workers/types';
import { findUnsafeIntegerFields } from './unsafeIntegers';
import type { DerivedTopic, TopicAdapter, TopicAdapterPlan } from './types';

interface AdaptedTopic {
  plan: TopicAdapterPlan;
  derivedByName: Map<string, DerivedTopic>;
}

/**
 * Wraps a source and applies topic adapters: each topic whose schema an
 * adapter claims is sampled once at initialization to plan its derived
 * topics; afterwards derived topics are produced on the fly from the source
 * messages (read once, even when several derived topics are subscribed).
 * Sources without adapted topics pass straight through.
 */
export class TopicAdapterIterableSource implements IIterableSource {
  private _inner: IIterableSource;
  private _adapters: readonly TopicAdapter[];
  /** Source topic → its plan. */
  private _adapted = new Map<string, AdaptedTopic>();
  /** Derived topic → source topic. */
  private _sourceOf = new Map<string, string>();

  constructor(inner: IIterableSource, adapters: readonly TopicAdapter[]) {
    this._inner = inner;
    this._adapters = adapters;
  }

  async initialize(): Promise<Initialization> {
    const init = await this._inner.initialize();
    const adapterByTopic = new Map<string, TopicAdapter>();
    for (const topic of init.topics) {
      const adapter = this._adapters.find((a) => a.schemaNames.includes(topic.type));
      if (adapter) adapterByTopic.set(topic.name, adapter);
    }
    if (adapterByTopic.size === 0) return init;

    // Derived topics depend on the payload (camera names, joint layout); sample the first message.
    const samples = await this._inner.getBackfillMessages({
      time: init.start,
      topics: [...adapterByTopic.keys()],
    });

    const topics: TopicInfo[] = [...init.topics];
    const problems = [...init.problems];
    let datatypes = init.datatypes;
    for (const sample of samples) {
      const adapter = adapterByTopic.get(sample.topic);
      if (!adapter) continue;
      const unsafeFields = findUnsafeIntegerFields(sample.message);
      if (unsafeFields.length > 0) {
        problems.push({
          severity: 'warn',
          message:
            `${sample.topic}: ${unsafeFields.map((field) => `"${field}"`).join(', ')} exceed 2^53 and lost ` +
            'precision when decoded. Recorders should write nanosecond timestamps as strings in JSON.',
        });
      }
      const plan = adapter.plan(sample.topic, sample.message, init);
      if (!plan) continue;
      problems.push(...(plan.problems ?? []));
      if (adapter.datatypes) datatypes = { ...adapter.datatypes, ...datatypes };
      const derivedByName = new Map<string, DerivedTopic>();
      for (const derived of plan.derived) {
        derivedByName.set(derived.name, derived);
        this._sourceOf.set(derived.name, sample.topic);
        topics.push({ name: derived.name, type: derived.type });
        init.topicStats[derived.name] = { ...init.topicStats[sample.topic] };
        init.publishersByTopic[derived.name] = init.publishersByTopic[sample.topic] ?? [];
      }
      this._adapted.set(sample.topic, { plan, derivedByName });
    }

    return { ...init, topics, datatypes, problems };
  }

  async *messageIterator(args: MessageIteratorArgs): AsyncIterableIterator<MessageEvent> {
    if (this._adapted.size === 0) {
      yield* this._inner.messageIterator(args);
      return;
    }
    const wanted = new Set(args.topics);
    const innerArgs: MessageIteratorArgs = {
      ...args,
      topics: this._toInnerTopics(args.topics),
      latestOnlyTopics: args.latestOnlyTopics ? this._toInnerTopics(args.latestOnlyTopics) : undefined,
    };
    for await (const event of this._inner.messageIterator(innerArgs)) {
      yield* this._expand(event, wanted);
    }
  }

  async getBackfillMessages(args: GetBackfillMessagesArgs): Promise<MessageEvent[]> {
    if (this._adapted.size === 0) {
      return await this._inner.getBackfillMessages(args);
    }
    const wanted = new Set(args.topics);
    const events = await this._inner.getBackfillMessages({ ...args, topics: this._toInnerTopics(args.topics) });
    return events.flatMap((event) => this._expand(event, wanted));
  }

  async getAdjacentMessage(args: GetAdjacentMessageArgs): Promise<MessageEvent | null> {
    if (!this._inner.getAdjacentMessage) return null;
    if (this._adapted.size === 0) {
      return await this._inner.getAdjacentMessage(args);
    }
    const event = await this._inner.getAdjacentMessage({ ...args, topics: this._toInnerTopics(args.topics) });
    return event ? (this._expand(event, new Set(args.topics))[0] ?? null) : null;
  }

  private _toInnerTopics(topics: readonly string[]): string[] {
    return [...new Set(topics.map((topic) => this._sourceOf.get(topic) ?? topic))];
  }

  private _expand(event: MessageEvent, wanted: ReadonlySet<string>): MessageEvent[] {
    const adapted = this._adapted.get(event.topic);
    if (!adapted) return [event];

    const out: MessageEvent[] = [];
    if (wanted.has(event.topic)) {
      const transform = adapted.plan.transformSource;
      out.push(transform ? { ...event, message: transform(event.message) } : event);
    }
    for (const [name, derived] of adapted.derivedByName) {
      if (!wanted.has(name)) continue;
      const message = derived.derive(event.message, event);
      if (message == undefined) continue;
      out.push({ ...event, topic: name, message, schemaName: derived.type });
    }
    return out;
  }
}
