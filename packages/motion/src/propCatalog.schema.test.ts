/**
 * D-403 — the Inspector's field catalogue (`propCatalog.ts`) cannot drift from
 * the per-primitive zod schemas the manifest actually parses with
 * (`@apelles/motion-engine`'s `primitiveProps.ts`).
 *
 * Before D-403 the catalogue was the only description of a primitive's props
 * and nothing enforced it. Now the schema is the source of truth for what
 * loads, and this test holds the catalogue to it in both directions:
 *
 *   1. every Inspector field names a real prop (or a shared layer field), and
 *      its control kind matches the prop's type — a `select` lists exactly the
 *      enum's options, a `vec` has exactly the tuple's length, a `color` is a
 *      colour schema;
 *   2. every prop the schema declares has an Inspector field, so a prop added
 *      to the schema without a control (which a human could then not edit,
 *      breaking CLAUDE.md's human-and-AI rule) fails here.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { PRIMITIVE_USES } from '@apelles/motion-engine/src/engine/primitiveProps';
import { LAYER_BASE_KEYS, LAYER_SCHEMAS, primitivePropShape } from '@apelles/motion-engine/src/engine/schema';
import { isColorSchema } from '@apelles/motion-engine/src/engine/schemaAtoms';
import { defOf, unwrap } from '@apelles/motion-engine/src/engine/validate';
import { fieldsForPrimitive, type FieldSpec } from './propCatalog';
import { catalogEntries } from './catalog';

const BASE = new Set<string>(LAYER_BASE_KEYS);

function ownFields(use: string): FieldSpec[] {
  return (fieldsForPrimitive(use) ?? []).filter((f) => !BASE.has(f.key));
}

/** does the prop schema fit the Inspector control `kind`? Returns a reason
 *  string when it does not. */
function kindMismatch(field: FieldSpec, schema: z.ZodType): string | null {
  const s = unwrap(schema);
  const d = defOf(s);
  const type = d.type;
  const unionTypes = type === 'union' ? (d.options ?? []).map((o) => defOf(unwrap(o)).type) : [];
  switch (field.kind) {
    case 'number':
      return type === 'number' ? null : `expected a number schema, got ${type}`;
    case 'boolean':
      return type === 'boolean' ? null : `expected a boolean schema, got ${type}`;
    case 'string':
      return type === 'string' || unionTypes.includes('string') ? null : `expected a string schema, got ${type}`;
    case 'color':
      return type === 'string' && isColorSchema(s) ? null : 'expected a colorSchema()';
    case 'select': {
      if (type !== 'enum') return `expected an enum schema, got ${type}`;
      const options = (s as unknown as { options: string[] }).options;
      return JSON.stringify(options) === JSON.stringify(field.options)
        ? null
        : `options ${JSON.stringify(field.options)} != schema ${JSON.stringify(options)}`;
    }
    case 'vec': {
      if (type !== 'tuple') return `expected a tuple schema, got ${type}`;
      return (d.items ?? []).length === (field.components ?? []).length ? null : 'tuple length != components';
    }
    case 'json':
      return ['array', 'object', 'union', 'record', 'tuple'].includes(type) ? null : `json field over a ${type}`;
    case 'ease':
      return type === 'tuple' ? null : `ease over a ${type}`;
    case 'asset':
    case 'icon':
      return type === 'string' ? null : `${field.kind} over a ${type}`;
  }
}

describe('propCatalog matches the per-primitive schemas (D-403)', () => {
  it('the Catalog and the schema list the same primitives', () => {
    expect(catalogEntries.map((e) => e.use).sort()).toEqual([...PRIMITIVE_USES].sort());
  });

  for (const use of PRIMITIVE_USES) {
    it(`${use}: every Inspector field is a real prop of the matching type`, () => {
      // the whole layer object's shape: a group's `children` live there, beside its props
      const shape = defOf(unwrap(LAYER_SCHEMAS[use])).shape ?? {};
      for (const field of ownFields(use)) {
        const schema = shape[field.key];
        expect(schema, `${use}.${field.key} is not in the schema`).toBeDefined();
        expect(kindMismatch(field, schema), `${use}.${field.key}`).toBeNull();
      }
    });

    it(`${use}: every schema prop has an Inspector field`, () => {
      const keys = ownFields(use).map((f) => f.key);
      for (const prop of Object.keys(primitivePropShape(use)).concat(use === 'group' ? ['children'] : [])) {
        expect(keys, `${use}.${prop} has no Inspector field`).toContain(prop);
      }
    });
  }
});
