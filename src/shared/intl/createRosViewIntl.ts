import { createIntl, createIntlCache } from 'react-intl';
import { getRosViewMessages, type RosViewLocale, type RosViewMessageOverrides } from './loadRosViewMessages';

const intlCache = createIntlCache();

function localeFor(lang: RosViewLocale): string {
  if (lang === 'zh') return 'zh-CN';
  if (lang === 'ja') return 'ja-JP';
  return 'en';
}

/** For strings outside `IntlProvider` (e.g. `RosViewer` data effects). */
export function createRosViewIntl(lang: RosViewLocale, overrides?: RosViewMessageOverrides) {
  return createIntl(
    {
      locale: localeFor(lang),
      defaultLocale: 'en',
      messages: getRosViewMessages(lang, overrides),
    },
    intlCache,
  );
}
