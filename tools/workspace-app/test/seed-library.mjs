// A seed for test/shots.mjs --seed (screenshots of the asset library and the project settings),
// on the --example workspace: synthetic shared and project assets with versions (images drawn
// here, Markdown, JSON and a PDF; one archived), and two settings versions of "example" that
// attach some of them (one pinned, one that is missing on purpose). Everything goes through the
// app's own modules, so the data is exactly what the app writes. Synthetic names only.
//
//   node tools/workspace-app/test/shots.mjs --out <dir> --example --seed tools/workspace-app/test/seed-library.mjs \
//        --routes assets,project/example/settings,project/example/assets --theme both
import { addVersion, createAsset, setArchived } from '../asset-library.mjs';
import { encodePng } from '../make-icon.mjs';
import { saveSettings } from '../project-settings.mjs';

const HOUR = 3600_000;

// ---------------------------------------------------------------- drawn images

const hex = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

function canvas(width, height, background) {
  const rgba = Buffer.alloc(width * height * 4);
  const fill = (x0, y0, w, h, color) => {
    const [r, g, b] = hex(color);
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
        const k = (y * width + x) * 4;
        rgba[k] = r; rgba[k + 1] = g; rgba[k + 2] = b; rgba[k + 3] = 255;
      }
    }
  };
  fill(0, 0, width, height, background);
  return { fill, png: () => encodePng(width, height, rgba) };
}

// Five colour swatches with a label strip under each.
function palette(colors) {
  const c = canvas(320, 200, '#faf9f6');
  const w = Math.floor(296 / colors.length);
  colors.forEach((color, i) => {
    c.fill(12 + i * w, 12, w - 8, 140, color);
    c.fill(12 + i * w, 160, w - 8, 10, '#e0ddd3');
    c.fill(12 + i * w, 176, Math.floor((w - 8) * 0.6), 8, '#a29d92');
  });
  return c.png();
}

// A checkout page as grey boxes: a header, the cart lines, the summary and its button.
function wireframe(withCoupon) {
  const c = canvas(320, 200, '#ffffff');
  c.fill(0, 0, 320, 26, '#1f1e1b');
  c.fill(12, 9, 60, 8, '#faf9f6');
  for (let i = 0; i < 3; i++) {
    c.fill(12, 40 + i * 34, 28, 26, '#e0ddd3');
    c.fill(48, 44 + i * 34, 110, 7, '#a29d92');
    c.fill(48, 56 + i * 34, 70, 6, '#e0ddd3');
    c.fill(170, 46 + i * 34, 30, 8, '#6b675e');
  }
  c.fill(214, 40, 94, 120, '#f1efe8');
  c.fill(224, 52, 60, 7, '#6b675e');
  c.fill(224, 66, 74, 6, '#a29d92');
  if (withCoupon) c.fill(224, 80, 74, 16, '#ece6f6');
  c.fill(224, 136, 74, 16, '#c2410c');
  return c.png();
}

// Wooden planks with darker gaps and two nails per plank.
function planks() {
  const c = canvas(320, 200, '#7a4e2d');
  for (let i = 0; i < 5; i++) {
    c.fill(0, i * 40, 320, 36, i % 2 ? '#8a5a35' : '#9b6a40');
    c.fill(0, i * 40 + 36, 320, 4, '#4a2e1a');
    c.fill(20, i * 40 + 15, 5, 5, '#2b2b2b');
    c.fill(295, i * 40 + 15, 5, 5, '#2b2b2b');
  }
  return c.png();
}

function badge() {
  const c = canvas(200, 200, '#faf9f6');
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 200; x++) if ((x - 100) ** 2 + (y - 100) ** 2 < 70 ** 2) c.fill(x, y, 1, 1, '#2c5f9e');
  }
  c.fill(70, 92, 60, 16, '#faf9f6');
  return c.png();
}

// The smallest valid PDF a viewer opens: one empty page.
const PDF = Buffer.from([
  '%PDF-1.4',
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj',
  'trailer << /Root 1 0 R >>',
  '%%EOF',
].join('\n'));

// ---------------------------------------------------------------- texts

const STYLE_V1 = '# Writing style\n\n- Short sentences.\n- Say what changed and why.\n';
const STYLE_V2 = '# Writing style\n\n- Short sentences, one idea each.\n- Say what changed and why.\n- No marketing words.\n';
const STYLE_V3 = '# Writing style\n\nFor every text the app or an agent writes.\n\n- Short sentences, one idea each.\n- Say what changed and why.\n- No marketing words.\n- Numbers as digits.\n';
const API = '# API conventions\n\n- Every route answers { ok, ... } or { ok: false, error }.\n- Errors are plain sentences.\n- Money is in cents, never floats.\n- Dates are ISO 8601 in UTC.\n';
const SCHEMA = `${JSON.stringify({ order: { id: 'string', items: [{ sku: 'string', cents: 'integer' }], total: 'integer' } }, null, 2)}\n`;
const READING = '# Reading list\n\n1. A short book on writing.\n2. Notes on testing.\n3. A paper on version control.\n';

const RULES_V1 = '- Money is in cents, never floats.\n- Every change to checkout gets a test first.\n';
const RULES_V2 = '# Example rules\n\n- Money is in cents, never floats.\n- Every change to checkout gets a pinning test first.\n- Ask before adding a dependency.\n- Keep the cart logic out of the components.\n';

// ---------------------------------------------------------------- the seed

export default async function seed({ root, dataDir }) {
  const asset = (opts, buf) => createAsset(root, opts, buf);
  const style = await asset({ scope: 'shared', title: 'Writing style', tags: 'docs, style', description: 'How texts read, for people and for Claude.', originalName: 'writing-style.md', note: 'First draft' }, Buffer.from(STYLE_V1));
  await addVersion(root, style.ref, Buffer.from(STYLE_V2), { expectVersions: 1, originalName: 'writing-style.md', note: 'One idea per sentence' });
  await addVersion(root, style.ref, Buffer.from(STYLE_V3), { expectVersions: 2, originalName: 'writing-style.md', note: 'Numbers as digits' });
  const brand = await asset({ scope: 'shared', title: 'Brand colours', tags: 'brand, colours', description: 'The five colours of the interface.', originalName: 'brand-colours.png' },
    palette(['#c2410c', '#2f7a4b', '#2c5f9e', '#6a4aa8', '#8a5300']));
  await addVersion(root, brand.ref, palette(['#c2410c', '#a8380a', '#2f7a4b', '#2c5f9e', '#6a4aa8']), { expectVersions: 1, originalName: 'brand-colours.png', note: 'A darker accent' });
  await asset({ scope: 'shared', title: 'API conventions', tags: 'docs, api', originalName: 'api.md' }, Buffer.from(API));
  await asset({ scope: 'shared', title: 'Release checklist', tags: 'release', description: 'The printable checklist.', originalName: 'release-checklist.pdf' }, PDF);
  const old = await asset({ scope: 'shared', title: 'Old logo', tags: 'brand', originalName: 'old-logo.png' }, badge());
  await setArchived(root, old.ref, true);
  const checkout = await asset({ scope: 'project', project: 'example', title: 'Checkout wireframe', tags: 'ux', description: 'The cart page as agreed.', originalName: 'checkout.png' }, wireframe(false));
  await addVersion(root, checkout.ref, wireframe(true), { expectVersions: 1, originalName: 'checkout.png', note: 'With the coupon field' });
  await asset({ scope: 'project', project: 'example', title: 'Order schema', tags: 'api', originalName: 'order-schema.json' }, Buffer.from(SCHEMA));
  await asset({ scope: 'project', project: 'sample-art', title: 'Crate reference', tags: 'reference, props', description: 'Planks for the crate texture.', originalName: 'crate.png' }, planks());
  await asset({ scope: 'project', project: 'notes', title: 'Reading list', tags: 'notes', originalName: 'reading.md' }, Buffer.from(READING));

  const now = Date.now();
  await saveSettings(dataDir, 'example', {
    rules: RULES_V1, defaults: { model: 'sonnet' }, allowedTools: 'Read, Grep', assets: [{ ref: style.ref, pin: null }],
  }, { basedOn: 0, now: () => now - 50 * HOUR });
  await saveSettings(dataDir, 'example', {
    rules: RULES_V2, defaults: { model: 'sonnet', effort: 'high', permissionMode: 'plan' }, allowedTools: 'Read, Grep, Bash(npm test:*)',
    assets: [{ ref: style.ref, pin: null }, { ref: brand.ref, pin: 1 }, { ref: checkout.ref, pin: null }, { ref: 'shared:retired-guide', pin: null }],
  }, { basedOn: 1, now: () => now - 3 * HOUR });
}
