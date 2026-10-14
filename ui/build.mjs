import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const result = await build({ entryPoints: ['card.js'], bundle: true, format: 'esm', write: false, minify: true, target: 'es2022' });
const html = await readFile('card.html', 'utf8');
const script = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
await mkdir('dist', { recursive: true });
await writeFile('dist/card.html', html.replace('<!-- SCRIPT -->', '<script type="module">' + script + '</script>'));
