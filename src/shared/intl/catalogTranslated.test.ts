import { describe, expect, it } from 'vitest';
import { getRosViewMessages } from './loadRosViewMessages';

/**
 * Every zh / ja string differs from English unless it is a name, an identifier or an example
 * value that reads the same in every language. A string copied from en into a shard (walk
 * finding F-25: 3D, Pose and Image settings were English in zh and ja) fails here; a new
 * intentional exception is added below with its reason.
 */
const SAME_IN_EVERY_LOCALE = new Set([
  // Product, language and organisation names.
  'common.productName',
  'navbar.lang.en',
  'welcome.footerOrgName',
  'urdfDebug.action.xArm851',
  // Message field names and format identifiers.
  'panels.jointStatePlot.timestamp.receiveTime',
  'panels.jointStatePlot.timestamp.headerStamp',
  'panels.jointStatePlot.timestamp.publishTime',
  'panels.jointStatePlot.timestamp.customField',
  'panels.rawMessages.settings.enum.binaryCopy.uint8array',
  'panels.rawMessages.settings.enum.binaryCopy.hex',
  'panels.rawMessages.settings.enum.binaryCopy.base64',
  'panels.threeD.settings.section.urdf',
  'panels.threeD.settings.enum.urdfSource.url',
  'panels.threeD.settings.field.urdfUrl.label',
  'panels.image.settings.enum.colorMap.turbo',
  'welcome.fileTypes',
  // Example values in inputs (topic names, frames, URLs).
  'panels.audio.settings.field.audioTopic.placeholder',
  'panels.audio.settings.field.audioInfoTopic.placeholder',
  'panels.pose.settings.field.targetFrame.placeholder',
  'panels.image.settings.field.topic.placeholder',
  'urdfDebug.meshBase.remotePlaceholder',
]);

const SAME_IN_LOCALE: Record<'zh' | 'ja', Set<string>> = {
  // zh keeps "Topic" as the term in the Plot and data quality views.
  zh: new Set(['panels.plot.settings.field.topic', 'quality.details.topic']),
  ja: new Set([
    // Clock names, shown next to the values they label.
    'panels.align.overlay.plot',
    'panels.align.overlay.receive',
    'panels.align.overlay.stamp',
    // The help text next to the toggle says ON / OFF.
    'urdfDebug.preview.rotateMeshOff',
    'welcome.historyKindUrl',
    'welcome.tabRemote',
    'welcome.remoteUrlPlaceholder',
  ]),
};

/** Words a reader would need translated: letters left after ICU arguments are removed. */
function hasWords(text: string): boolean {
  return /[A-Za-z]{3,}/.test(text.replace(/\{[^{}]*\}/g, ''));
}

describe('zh and ja catalogs', () => {
  const en = getRosViewMessages('en');

  it.each(['zh', 'ja'] as const)('translate every English string in %s', (locale) => {
    const messages = getRosViewMessages(locale);
    const untranslated = Object.keys(en).filter(
      (id) =>
        hasWords(en[id]) && messages[id] === en[id] && !SAME_IN_EVERY_LOCALE.has(id) && !SAME_IN_LOCALE[locale].has(id),
    );
    expect(untranslated).toEqual([]);
  });

  it.each(['zh', 'ja'] as const)('list only exceptions that are still the same in %s', (locale) => {
    const messages = getRosViewMessages(locale);
    const stale = [...SAME_IN_EVERY_LOCALE, ...SAME_IN_LOCALE[locale]].filter((id) => messages[id] !== en[id]);
    expect(stale).toEqual([]);
  });
});
