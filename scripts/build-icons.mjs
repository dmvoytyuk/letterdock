// Builds build/icon.ico and build/icon.png from the SVG masters (DESIGN-SPEC 1.8).
// Sizes up to 24px use the flat small design; 32px and up use the master.
// Run with: npm run icons
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';

const buildDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const master = readFileSync(join(buildDir, 'icon.svg'));
const small = readFileSync(join(buildDir, 'icon-small.svg'));
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];

function render(size) {
  const svg = size <= 24 ? small : master;
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
}

const ico = await pngToIco(SIZES.map(render));
writeFileSync(join(buildDir, 'icon.ico'), ico);
writeFileSync(join(buildDir, 'icon.png'), render(512));
// Renderer favicon (served from src/renderer/public).
writeFileSync(join(buildDir, '..', 'src', 'renderer', 'public', 'favicon.png'), render(64));
console.log(`Wrote build/icon.ico (${SIZES.join(', ')}) , build/icon.png (512) and the renderer favicon`);
