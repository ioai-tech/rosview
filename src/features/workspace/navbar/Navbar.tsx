import React, { useCallback, useRef, useState } from 'react';
import type { Player } from '@/core/types/player';
import {
  Archive,
  Clock,
  Database,
  Download,
  FileVideo,
  FolderOpen,
  Globe2,
  Languages,
  Loader2,
  Moon,
  PanelsTopLeft,
  RotateCcw,
  Save,
  Sun,
  SunMoon,
  Upload,
} from 'lucide-react';
import { useIntl } from 'react-intl';
import {
  Menubar,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarSeparator,
  MenubarTrigger,
} from '@/shared/ui/menubar';
import {
  exportDockviewLayout,
  importDockviewLayout,
  reapplyAutoDockviewLayout,
} from '../../layout/dockviewController';
import { clearSavedDockviewLayout, saveDockviewLayoutToStorage } from '@/core/preferences/layoutStorage';
import { useRosViewerLayoutContext } from '@/features/viewer/RosViewerLayoutContext';
import type { DatasetHistoryListItem } from '@/shared/utils/datasetHistory';

const MENUBAR_FILE = 'menubar-file';
const MENUBAR_LAYOUT = 'menubar-layout';
const MENUBAR_VIEW = 'menubar-view';
const MENUBAR_PREFERENCES = 'menubar-preferences';

/** Navbar-only: no thick focus ring on menubar triggers (Radix uses `data-highlighted`). */
const menubarTriggerClassName =
  'h-8 shrink-0 gap-2 border border-transparent px-2.5 text-xs font-medium text-muted-foreground shadow-none hover:text-foreground focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 data-[highlighted]:border-transparent';

/** Icon-only triggers (language / theme), aligned with previous ghost `size="icon"` buttons. */
const menubarIconTriggerClassName = `${menubarTriggerClassName} size-8 shrink-0 gap-0 px-0 justify-center`;

type PointerDownOutsideEvent = CustomEvent<{ originalEvent: PointerEvent }>;

function preventDismissForMenubarPointerDown(
  event: PointerDownOutsideEvent,
  menubarNode: HTMLDivElement | null,
) {
  const target = event.detail.originalEvent.target;
  if (target instanceof Node && menubarNode?.contains(target)) {
    event.preventDefault();
  }
}

function themeTriggerIcon(theme: 'light' | 'dark' | 'system' | undefined) {
  switch (theme) {
    case 'light':
      return <Sun className="h-[18px] w-[18px]" />;
    case 'dark':
      return <Moon className="h-[18px] w-[18px]" />;
    default:
      return <SunMoon className="h-[18px] w-[18px]" />;
  }
}

interface NavbarProps {
  player?: Player;
  sourceName?: string;
  sourceLoading?: boolean;
  theme?: 'light' | 'dark' | 'system';
  language?: 'en' | 'zh' | 'ja';
  onThemeChange?: (theme: 'light' | 'dark' | 'system') => void;
  onLanguageChange?: (lang: 'en' | 'zh' | 'ja') => void;
  showLanguageSwitcher?: boolean;
  showThemeSwitcher?: boolean;
  onBrandClick?: () => void;
  onOpenFilePick?: () => void;
  onOpenDirectory?: () => void;
  onOpenTarPick?: () => void;
  onOpenRemotePrompt?: () => void;
  onOpenSampleDialog?: () => void;
  /** Last opened sources (newest first); menu shows up to 10. */
  recentHistoryItems?: DatasetHistoryListItem[];
  onReplayHistory?: (id: string) => void | Promise<void>;
}

export const Navbar: React.FC<NavbarProps> = ({
  sourceName,
  sourceLoading,
  theme,
  language,
  onThemeChange,
  onLanguageChange,
  showLanguageSwitcher = true,
  showThemeSwitcher = true,
  onBrandClick,
  onOpenFilePick,
  onOpenDirectory,
  onOpenTarPick,
  onOpenRemotePrompt,
  onOpenSampleDialog,
  recentHistoryItems = [],
  onReplayHistory,
}) => {
  const { formatMessage } = useIntl();
  const { layoutPersistence, layoutStorageKey } = useRosViewerLayoutContext();
  const leftMenubarRef = useRef<HTMLDivElement>(null);
  const rightMenubarRef = useRef<HTMLDivElement>(null);
  const [leftMenubarValue, setLeftMenubarValue] = useState('');
  const [rightMenubarValue, setRightMenubarValue] = useState('');

  const handleExportLayout = useCallback(() => {
    const payload = exportDockviewLayout();
    if (!payload) return;
    const data = JSON.stringify(payload, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'studio-layout.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleImportLayout = useCallback(async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      importDockviewLayout(parsed);
    } catch (error) {
      console.warn('Failed to import layout', error);
    }
  }, []);

  const handleSaveLayout = useCallback(() => {
    if (layoutPersistence === 'off') return;
    const payload = exportDockviewLayout();
    if (!payload) return;
    saveDockviewLayoutToStorage(payload, layoutStorageKey);
  }, [layoutPersistence, layoutStorageKey]);

  const handleResetLayout = useCallback(() => {
    if (layoutPersistence === 'off') return;
    clearSavedDockviewLayout(layoutStorageKey);
  }, [layoutPersistence, layoutStorageKey]);

  const handleReapplyAutoLayout = useCallback(() => {
    reapplyAutoDockviewLayout();
  }, []);

  const hasOpenMenu =
    onOpenFilePick || onOpenDirectory || onOpenTarPick || onOpenRemotePrompt || onOpenSampleDialog;
  const showCenter = Boolean(sourceLoading || (sourceName && sourceName.trim().length > 0));
  const centerLabel = sourceLoading ? formatMessage({ id: 'navbar.sourceLoading' }) : (sourceName ?? '');

  return (
    <nav className="sticky top-0 z-50 w-full shrink-0 border-b border-border bg-background select-none">
      <div className="grid h-12 w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-2 gap-y-0 px-4">
        <div className="flex min-w-0 items-center gap-2 justify-self-start sm:gap-3">
          <button
            type="button"
            className="min-w-0 max-w-[min(11rem,28vw)] shrink truncate rounded-sm text-left text-sm font-semibold tracking-tight text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:max-w-[11rem]"
            onClick={onBrandClick}
            title={formatMessage({ id: 'navbar.goHome' })}
            aria-label={formatMessage({ id: 'navbar.goHome' })}
          >
            {formatMessage({ id: 'common.productName' })}
          </button>

          <Menubar
            ref={leftMenubarRef}
            value={leftMenubarValue}
            onValueChange={setLeftMenubarValue}
            className="min-w-0 shrink border-0 bg-transparent p-0 shadow-none"
          >
            {hasOpenMenu ? (
              <MenubarMenu value={MENUBAR_FILE}>
                <MenubarTrigger
                  className={menubarTriggerClassName}
                  aria-label={formatMessage({ id: 'navbar.menuFile' })}
                  title={formatMessage({ id: 'navbar.menuFile' })}
                  onPointerEnter={() => {
                    setLeftMenubarValue(MENUBAR_FILE);
                  }}
                >
                  <FolderOpen className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="hidden sm:inline">{formatMessage({ id: 'navbar.menuFile' })}</span>
                </MenubarTrigger>
                <MenubarContent
                  align="start"
                  className="min-w-[220px]"
                  onPointerDownOutside={(event) =>
                    preventDismissForMenubarPointerDown(event, leftMenubarRef.current)
                  }
                >
                  <MenubarGroup>
                    {onOpenFilePick ? (
                      <MenubarItem className="text-xs" onSelect={() => onOpenFilePick()}>
                        <FileVideo className="mr-2 h-4 w-4 shrink-0" />
                        {formatMessage({ id: 'navbar.openLocalFile' })}
                      </MenubarItem>
                    ) : null}
                    {onOpenDirectory ? (
                      <MenubarItem className="text-xs" onSelect={() => onOpenDirectory()}>
                        <FolderOpen className="mr-2 h-4 w-4 shrink-0" />
                        {formatMessage({ id: 'navbar.openLocalDir' })}
                      </MenubarItem>
                    ) : null}
                    {onOpenTarPick ? (
                      <MenubarItem className="text-xs" onSelect={() => onOpenTarPick()}>
                        <Archive className="mr-2 h-4 w-4 shrink-0" />
                        {formatMessage({ id: 'navbar.openLocalTar' })}
                      </MenubarItem>
                    ) : null}
                    {onOpenRemotePrompt ? (
                      <MenubarItem className="text-xs" onSelect={() => onOpenRemotePrompt()}>
                        <Globe2 className="mr-2 h-4 w-4 shrink-0" />
                        {formatMessage({ id: 'navbar.openRemoteUrl' })}
                      </MenubarItem>
                    ) : null}
                    {onOpenSampleDialog ? (
                      <>
                        <MenubarSeparator />
                        <MenubarItem className="text-xs" onSelect={() => onOpenSampleDialog()}>
                          <Database className="mr-2 h-4 w-4 shrink-0" />
                          {formatMessage({ id: 'navbar.browseSamples' })}
                        </MenubarItem>
                      </>
                    ) : null}
                  </MenubarGroup>
                  <MenubarSeparator />
                  <MenubarLabel className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
                    <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {formatMessage({ id: 'navbar.recentOpens' })}
                  </MenubarLabel>
                  <MenubarGroup className="max-h-60 overflow-y-auto">
                    {recentHistoryItems.length === 0 ? (
                      <MenubarItem disabled className="text-xs text-muted-foreground">
                        {formatMessage({ id: 'navbar.recentOpensEmpty' })}
                      </MenubarItem>
                    ) : (
                      recentHistoryItems.slice(0, 10).map((item) => (
                        <MenubarItem
                          key={item.id}
                          className="flex min-w-0 gap-2 text-xs"
                          title={
                            item.detail ? `${item.displayName} — ${item.detail}` : item.displayName
                          }
                          onSelect={() => onReplayHistory?.(item.id)}
                        >
                          <span className="min-w-0 flex-1 truncate">{item.displayName}</span>
                        </MenubarItem>
                      ))
                    )}
                  </MenubarGroup>
                </MenubarContent>
              </MenubarMenu>
            ) : null}

            <MenubarMenu value={MENUBAR_LAYOUT}>
              <MenubarTrigger
                type="button"
                className={menubarTriggerClassName}
                data-testid="navbar-layout-menu-trigger"
                aria-label={formatMessage({ id: 'navbar.layoutMenu' })}
                title={formatMessage({ id: 'navbar.layoutMenu' })}
                onPointerEnter={() => {
                  setLeftMenubarValue(MENUBAR_LAYOUT);
                }}
              >
                <PanelsTopLeft className="h-4 w-4 shrink-0" aria-hidden />
                <span className="hidden sm:inline">{formatMessage({ id: 'navbar.layoutMenu' })}</span>
              </MenubarTrigger>
              <MenubarContent
                align="start"
                sideOffset={6}
                className="min-w-[220px]"
                onPointerDownOutside={(event) =>
                  preventDismissForMenubarPointerDown(event, leftMenubarRef.current)
                }
              >
                <MenubarGroup>
                  <MenubarItem
                    className="text-xs"
                    onSelect={() => document.getElementById('rosview-navbar-layout-import')?.click()}
                  >
                    <Upload className="mr-2 h-4 w-4 shrink-0" />
                    {formatMessage({ id: 'navbar.importLayout' })}
                  </MenubarItem>
                  <MenubarItem className="text-xs" onSelect={() => handleExportLayout()}>
                    <Download className="mr-2 h-4 w-4 shrink-0" />
                    {formatMessage({ id: 'navbar.exportLayout' })}
                  </MenubarItem>
                  <MenubarSeparator />
                  <MenubarItem className="text-xs" onSelect={() => handleSaveLayout()}>
                    <Save className="mr-2 h-4 w-4 shrink-0" />
                    {formatMessage({ id: 'navbar.saveLayout' })}
                  </MenubarItem>
                  <MenubarItem className="text-xs" onSelect={() => handleResetLayout()}>
                    <RotateCcw className="mr-2 h-4 w-4 shrink-0" />
                    {formatMessage({ id: 'navbar.resetLayout' })}
                  </MenubarItem>
                  <MenubarItem className="text-xs" onSelect={() => handleReapplyAutoLayout()}>
                    <RotateCcw className="mr-2 h-4 w-4 shrink-0" />
                    {formatMessage({ id: 'navbar.reapplyAutoLayout' })}
                  </MenubarItem>
                </MenubarGroup>
              </MenubarContent>
            </MenubarMenu>
          </Menubar>

          <input
            id="rosview-navbar-layout-import"
            type="file"
            name="rosview-navbar-layout-import"
            accept="application/json"
            className="hidden"
            onChange={(event) => {
              void handleImportLayout(event.target.files);
              event.target.value = '';
            }}
          />
        </div>

        <div className="flex w-full min-w-0 items-center justify-center justify-self-center overflow-hidden px-1">
          {showCenter ? (
            <div className="pointer-events-none flex w-full min-w-0 max-w-[min(100%,36rem)] items-center justify-center gap-2 overflow-hidden">
              {sourceLoading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden /> : null}
              <span
                className={`block min-w-0 flex-1 truncate text-center text-sm font-medium tracking-tight ${
                  sourceLoading ? 'text-muted-foreground' : 'text-foreground'
                }`}
                title={centerLabel}
              >
                {centerLabel}
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex min-w-0 items-center justify-end justify-self-end gap-1">
          <Menubar
            ref={rightMenubarRef}
            value={rightMenubarValue}
            onValueChange={setRightMenubarValue}
            className="border-0 bg-transparent p-0 shadow-none"
          >
            {showLanguageSwitcher ? (
              <MenubarMenu value={MENUBAR_VIEW}>
              <MenubarTrigger
                type="button"
                className={menubarIconTriggerClassName}
                aria-label={formatMessage({ id: 'navbar.selectLanguage' })}
                title={formatMessage({ id: 'navbar.selectLanguage' })}
                onPointerEnter={() => {
                  setRightMenubarValue(MENUBAR_VIEW);
                }}
              >
                <Languages className="h-[18px] w-[18px]" aria-hidden />
              </MenubarTrigger>
              <MenubarContent
                align="end"
                sideOffset={6}
                className="min-w-36"
                onPointerDownOutside={(event) =>
                  preventDismissForMenubarPointerDown(event, rightMenubarRef.current)
                }
              >
                <MenubarLabel className="text-xs font-normal text-muted-foreground">
                  {formatMessage({ id: 'navbar.selectLanguage' })}
                </MenubarLabel>
                <MenubarGroup>
                  {(['en', 'zh', 'ja'] as const).map((item) => (
                    <MenubarItem
                      key={item}
                      onSelect={() => onLanguageChange?.(item)}
                      className={`text-xs ${language === item ? 'bg-accent text-accent-foreground' : ''}`}
                    >
                      {formatMessage({ id: `navbar.lang.${item}` })}
                    </MenubarItem>
                  ))}
                </MenubarGroup>
              </MenubarContent>
              </MenubarMenu>
            ) : null}

            {showThemeSwitcher ? (
              <MenubarMenu value={MENUBAR_PREFERENCES}>
              <MenubarTrigger
                type="button"
                className={menubarIconTriggerClassName}
                aria-label={formatMessage({ id: 'common.theme' })}
                title={formatMessage({ id: 'common.theme' })}
                onPointerEnter={() => {
                  setRightMenubarValue(MENUBAR_PREFERENCES);
                }}
              >
                {themeTriggerIcon(theme)}
                <span className="sr-only">{formatMessage({ id: 'common.theme' })}</span>
              </MenubarTrigger>
              <MenubarContent
                align="end"
                sideOffset={6}
                className="min-w-36"
                onPointerDownOutside={(event) =>
                  preventDismissForMenubarPointerDown(event, rightMenubarRef.current)
                }
              >
                <MenubarLabel className="text-xs font-normal text-muted-foreground">
                  {formatMessage({ id: 'common.theme' })}
                </MenubarLabel>
                <MenubarGroup>
                  <MenubarItem className="text-xs" onSelect={() => onThemeChange?.('light')}>
                    <Sun className="mr-2 h-4 w-4 shrink-0" />
                    {formatMessage({ id: 'common.light' })}
                  </MenubarItem>
                  <MenubarItem className="text-xs" onSelect={() => onThemeChange?.('dark')}>
                    <Moon className="mr-2 h-4 w-4 shrink-0" />
                    {formatMessage({ id: 'common.dark' })}
                  </MenubarItem>
                  <MenubarItem className="text-xs" onSelect={() => onThemeChange?.('system')}>
                    <SunMoon className="mr-2 h-4 w-4 shrink-0" />
                    {formatMessage({ id: 'common.system' })}
                  </MenubarItem>
                </MenubarGroup>
              </MenubarContent>
              </MenubarMenu>
            ) : null}
          </Menubar>
        </div>
      </div>
    </nav>
  );
};
