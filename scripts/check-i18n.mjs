/**
 * Release gate: verify RosView i18n message shards stay in sync and that
 * formatMessage ids referenced in source exist in the English catalog.
 *
 * Usage: node scripts/check-i18n.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MESSAGES_DIR = path.join(ROOT, 'src/shared/intl/messages');
const SRC_DIR = path.join(ROOT, 'src');
const LOCALES = ['en', 'zh', 'ja'];

/** @param {string} dir */
function listJsonShards(locale) {
  const dir = path.join(MESSAGES_DIR, locale);
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

/** @param {string} locale @param {string} shard */
function readShard(locale, shard) {
  const filePath = path.join(MESSAGES_DIR, locale, shard);
  return /** @type {Record<string, string>} */ (JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

/** @param {string} locale */
function mergeLocale(locale) {
  /** @type {Record<string, string>} */
  const merged = {};
  const duplicates = [];
  for (const shard of listJsonShards(locale)) {
    const part = readShard(locale, shard);
    for (const key of Object.keys(part)) {
      if (Object.prototype.hasOwnProperty.call(merged, key)) {
        duplicates.push({ locale, key, shard });
      }
      merged[key] = part[key];
    }
  }
  return { merged, duplicates };
}

/** @param {string} dir @param {string[]} files */
function walkSource(dir, files = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!['node_modules', 'dist', 'dist-lib'].includes(ent.name)) {
        walkSource(full, files);
      }
      continue;
    }
    if (/\.(ts|tsx)$/.test(ent.name) && !/\.(test|spec)\.(ts|tsx)$/.test(ent.name)) {
      files.push(full);
    }
  }
  return files;
}

/** @param {string} content */
function extractStaticMessageIds(content) {
  /** @type {Set<string>} */
  const ids = new Set();

  const patterns = [
    /formatMessage\(\s*\{\s*id:\s*['"]([^'"]+)['"]/g,
    /formatMessage\(\s*\n\s*\{\s*id:\s*['"]([^'"]+)['"]/g,
    /offlineIntl\.formatMessage\(\s*\{\s*id:\s*['"]([^'"]+)['"]/g,
    /intl\.formatMessage\(\s*\{\s*id:\s*['"]([^'"]+)['"]/g,
    /(?:^|[?:,\s])['"]((?:panels|layout|navbar|quality|welcome|sidebar|playback|common|urdfDebug|errors|viewer)\.[^'"]+)['"]/gm,
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(content)) !== null) {
      ids.add(match[1]);
    }
  }

  // Multiline formatMessage blocks.
  for (const block of content.matchAll(/formatMessage\(\s*\{[\s\S]*?id:\s*['"]([^'"]+)['"]/g)) {
    ids.add(block[1]);
  }

  return ids;
}

/** @param {string} content */
function extractDynamicTemplatePrefixes(content) {
  /** @type {Set<string>} */
  const prefixes = new Set();
  const patterns = [
    /formatMessage\(\s*\{\s*id:\s*`([^`$]+)\$\{/g,
    /formatMessage\(\s*\n\s*\{\s*id:\s*`([^`$]+)\$\{/g,
    /offlineIntl\.formatMessage\(\s*\{\s*id:\s*`([^`$]+)\$\{/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(content)) !== null) {
      prefixes.add(match[1]);
    }
  }
  return prefixes;
}

/** @returns {string[]} */
function loadPanelTypeSlugs() {
  const slugFile = path.join(ROOT, 'src/features/panels/framework/panelMessageSlug.ts');
  const content = fs.readFileSync(slugFile, 'utf8');
  const slugs = [];
  for (const match of content.matchAll(/:\s*'([^']+)'/g)) {
    slugs.push(match[1]);
  }
  return slugs;
}

/** @param {string[]} issues */
function fail(issues) {
  console.error('\n[i18n] Check failed:\n');
  for (const issue of issues) {
    console.error(`  - ${issue}`);
  }
  process.exit(1);
}

/** @param {string} message */
function warn(message) {
  console.warn(`[i18n] warn: ${message}`);
}

const issues = [];

// 1) Duplicate keys within each locale merge.
for (const locale of LOCALES) {
  const { duplicates } = mergeLocale(locale);
  for (const dup of duplicates) {
    issues.push(`Duplicate key "${dup.key}" in locale "${dup.locale}" (shard ${dup.shard})`);
  }
}

// 2) Cross-locale parity per shard.
const shards = listJsonShards('en');
for (const shard of shards) {
  const enKeys = new Set(Object.keys(readShard('en', shard)));
  for (const locale of ['zh', 'ja']) {
    const locKeys = new Set(Object.keys(readShard(locale, shard)));
    for (const key of enKeys) {
      if (!locKeys.has(key)) {
        issues.push(`Missing key "${key}" in ${locale}/${shard} (present in en)`);
      }
    }
    for (const key of locKeys) {
      if (!enKeys.has(key)) {
        issues.push(`Extra key "${key}" in ${locale}/${shard} (not in en)`);
      }
    }
  }
}

const { merged: enMessages } = mergeLocale('en');
const enKeys = new Set(Object.keys(enMessages));

// 3) Static ids referenced in source.
/** @type {Set<string>} */
const usedStaticIds = new Set();
/** @type {Set<string>} */
const dynamicPrefixes = new Set();

for (const file of walkSource(SRC_DIR)) {
  const content = fs.readFileSync(file, 'utf8');
  for (const id of extractStaticMessageIds(content)) {
    usedStaticIds.add(id);
  }
  for (const prefix of extractDynamicTemplatePrefixes(content)) {
    dynamicPrefixes.add(prefix);
  }
}

for (const id of usedStaticIds) {
  if (!enKeys.has(id)) {
    issues.push(`Message id "${id}" used in source but missing from en catalog`);
  }
}

// 4) Known dynamic expansions.
for (const lang of LOCALES) {
  const id = `navbar.lang.${lang}`;
  if (!enKeys.has(id)) {
    issues.push(`Expected dynamic message id "${id}" missing from en catalog`);
  }
  usedStaticIds.add(id);
}

for (const slug of loadPanelTypeSlugs()) {
  const id = `panels.${slug}.defaultTitle`;
  if (!enKeys.has(id)) {
    issues.push(`Expected panel defaultTitle id "${id}" missing from en catalog`);
  }
  usedStaticIds.add(id);
}

// Expand other dynamic template prefixes: every en key with that prefix must exist (parity already checked).
for (const prefix of dynamicPrefixes) {
  const matching = [...enKeys].filter((key) => key.startsWith(prefix));
  if (matching.length === 0) {
    issues.push(`Dynamic template prefix "${prefix}" has no matching keys in en catalog`);
  } else {
    for (const id of matching) {
      usedStaticIds.add(id);
    }
  }
}

// Context menu message ids (messageId field, not formatMessage).
const contextMenuIds = [
  'layout.panelTab.context.close',
  'layout.panelTab.context.closeAllInGroup',
  'layout.panelTab.context.resetPanel',
  'layout.panelTab.context.copyPanelId',
  'layout.panelTab.context.duplicatePanel',
];
for (const id of contextMenuIds) {
  if (!enKeys.has(id)) {
    issues.push(`Context menu message id "${id}" missing from en catalog`);
  }
  usedStaticIds.add(id);
}

if (issues.length > 0) {
  fail(issues);
}

// 5) Optional summary.
const unusedCount = [...enKeys].filter((key) => !usedStaticIds.has(key)).length;
console.log('[i18n] OK');
console.log(`  locales: ${LOCALES.join(', ')}`);
console.log(`  shards: ${shards.length} per locale`);
console.log(`  total keys (en): ${enKeys.size}`);
console.log(`  referenced keys (static + known dynamic): ${usedStaticIds.size}`);
console.log(`  unused keys (en, informational): ${unusedCount}`);

if (unusedCount > 0) {
  warn(`${unusedCount} en keys are not referenced by the static scanner (may be dynamic or legacy)`);
}
