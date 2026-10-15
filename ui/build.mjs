import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const result = await build({ entryPoints: [fileURLToPath(new URL('./card.js', import.meta.url))], bundle: true, format: 'esm', write: false, minify: true, target: 'es2022' });
const html = await readFile(new URL('./card.html', import.meta.url), 'utf8');
const script = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await writeFile(new URL('./dist/card.html', import.meta.url), html.replace('<!-- SCRIPT -->', () => '<script type="module">' + script + '</script>'));
await build({ entryPoints: [fileURLToPath(new URL('../web/app.js', import.meta.url))], bundle: true, format: 'iife', minify: true, target: 'es2022', outfile: fileURLToPath(new URL('../web/dist/app.js', import.meta.url)) });
