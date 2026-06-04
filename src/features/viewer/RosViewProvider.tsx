import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { IntlProvider } from 'react-intl';
import { getRosViewMessages, type RosViewLocale } from '@/shared/intl/loadRosViewMessages';
import { Toaster } from '@/shared/ui/sonner';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { MessagePipelineState } from '@/core/pipeline/store';

export interface RosViewProviderProps {
  theme?: 'light' | 'dark' | 'system';
  language?: RosViewLocale;
  children: React.ReactNode;
}

type ResolvedTheme = 'light' | 'dark';

type RosViewThemeContextValue = {
  theme: 'light' | 'dark' | 'system';
  resolvedTheme: ResolvedTheme;
};

const RosViewThemeContext = createContext<RosViewThemeContextValue>({
  theme: 'system',
  resolvedTheme: 'dark',
});

function resolveTheme(theme: 'light' | 'dark' | 'system'): ResolvedTheme {
  if (theme !== 'system') {
    return theme;
  }
  if (typeof window === 'undefined') {
    return 'dark';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useRosViewTheme(): RosViewThemeContextValue {
  return useContext(RosViewThemeContext);
}

function intlLocaleFor(lang: RosViewLocale): string {
  if (lang === 'zh') return 'zh-CN';
  if (lang === 'ja') return 'ja-JP';
  return 'en';
}

export const RosViewProvider: React.FC<RosViewProviderProps> = ({
  theme = 'system',
  language = 'en',
  children,
}) => {
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(theme));

  useEffect(() => {
    if (theme !== 'system') {
      setResolvedTheme(theme);
      return;
    }
    if (typeof window === 'undefined') {
      setResolvedTheme('dark');
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const updateResolvedTheme = () => {
      setResolvedTheme(mediaQuery.matches ? 'dark' : 'light');
    };
    updateResolvedTheme();
    mediaQuery.addEventListener('change', updateResolvedTheme);
    return () => mediaQuery.removeEventListener('change', updateResolvedTheme);
  }, [theme]);

  const contextValue = useMemo(
    () => ({ theme, resolvedTheme }),
    [theme, resolvedTheme],
  );

  const messages = useMemo(() => getRosViewMessages(language), [language]);
  const playerPresence = useMessagePipeline(
    (state: MessagePipelineState) => state.playerState.presence,
  );

  return (
    <RosViewThemeContext.Provider value={contextValue}>
      <div
        id="rosview-root"
        data-language={language}
        data-theme={resolvedTheme}
        data-player-presence={playerPresence}
        className={`rosview-root-shell ${resolvedTheme === 'dark' ? 'dark' : ''}`}
      >
        <div className="h-full w-full min-h-0 min-w-0">
          <IntlProvider locale={intlLocaleFor(language)} defaultLocale="en" messages={messages}>
            {children}
            <Toaster theme={resolvedTheme} />
          </IntlProvider>
        </div>
      </div>
    </RosViewThemeContext.Provider>
  );
};
