import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.cjs',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: production,
  treeShaking: true,
});
