/**
 * Type-checks a tiny consumer against the built package with skipLibCheck: false, so a d.ts that
 * imports files the package does not ship (TS2307) or degrades types to `any` fails the build.
 *   node scripts/check-lib-consumer.mjs   (after build:lib)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dts = path.join(root, 'dist-lib/rosview.d.ts');
if (!fs.existsSync(dts)) {
  console.error('dist-lib/rosview.d.ts is missing: run build:lib first');
  process.exit(1);
}
// Inside the repo so react / three types resolve from node_modules; removed afterwards.
const dir = fs.mkdtempSync(path.join(root, '.consumer-check-'));
try {
  fs.writeFileSync(
    path.join(dir, 'consumer.tsx'),
    `import { RosViewer, clearCache, type RosViewMessageKey } from '@ioai/rosview';
const ok: RosViewMessageKey = 'layout.viewerRegion';
// @ts-expect-error a typo in a message id must be a type error (a plain string or any would accept it)
const bad: RosViewMessageKey = 'layout.viewerRegionn';
export const el = <RosViewer url="/x.mcap" sourceKey="k" refreshUrls={async (u) => u} messages={{ [ok]: 'x' }} />;
export { bad, clearCache };
`,
  );
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        module: 'ESNext',
        moduleResolution: 'bundler',
        target: 'ES2022',
        jsx: 'react-jsx',
        types: [],
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        paths: { '@ioai/rosview': [dts] },
      },
      files: ['consumer.tsx'],
    }),
  );
  execFileSync('npx', ['tsc', '-p', path.join(dir, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
  console.log('check-lib-consumer: ok');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
