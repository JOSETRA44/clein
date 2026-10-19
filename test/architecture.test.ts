import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Fitness function for the Dependency Rule: source code dependencies may only
 * point inwards (main → presentation/infrastructure → application → domain).
 */
const SRC = path.resolve(import.meta.dirname, '..', 'src');
const LAYERS = ['domain', 'application', 'presentation', 'infrastructure', 'main'] as const;
type Layer = (typeof LAYERS)[number];

const ALLOWED: Record<Layer, Layer[]> = {
  domain: ['domain'],
  application: ['domain', 'application'],
  presentation: ['domain', 'application', 'presentation'],
  infrastructure: ['domain', 'application', 'infrastructure'],
  main: ['domain', 'application', 'presentation', 'infrastructure', 'main']
};

/** Inner layers must not touch frameworks or the runtime; that is what ports are for. */
const FORBIDDEN_PACKAGES: Partial<Record<Layer, RegExp>> = {
  domain: /^(node:|@modelcontextprotocol|zod)/,
  application: /^(node:|@modelcontextprotocol|zod)/
};

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (entry.name.endsWith('.ts')) yield full;
  }
}

function layerOf(file: string): Layer {
  const layer = path.relative(SRC, file).split(path.sep)[0] as Layer;
  assert.ok(LAYERS.includes(layer), `${file} is outside the known layers`);
  return layer;
}

test('every source file depends only on its own or inner layers', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const layer = layerOf(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const [, specifier] of text.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      if (specifier.startsWith('.')) {
        const target = layerOf(path.resolve(path.dirname(file), specifier));
        if (!ALLOWED[layer].includes(target)) violations.push(`${path.relative(SRC, file)} → ${specifier}`);
      } else if (FORBIDDEN_PACKAGES[layer]?.test(specifier)) {
        violations.push(`${path.relative(SRC, file)} → ${specifier}`);
      }
    }
    if (FORBIDDEN_PACKAGES[layer] && /\bBuffer\b|\bprocess\./.test(text)) {
      violations.push(`${path.relative(SRC, file)} uses Node globals (Buffer/process)`);
    }
  }
  assert.deepEqual(violations, []);
});
