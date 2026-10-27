/**
 * Each primitive's layer schema as JSON Schema, for agents (D-403).
 *
 * What it is: `z.toJSONSchema` over `schema.ts`'s per-primitive layer schema —
 * the SAME zod object the manifest parses with, so what `motion_list_primitives`
 * publishes as `propsSchema` cannot drift from what the app accepts. Objects
 * are published with `additionalProperties: false`: the schema itself loads
 * unknown keys (existing files), but every authoring path refuses them
 * (`validate.ts`), and that refusal is the contract an agent writes against.
 *
 * What it does NOT do: describe semantics a JSON Schema cannot (an icon name
 * existing in the library, an asset id naming a real file); those are in each
 * primitive's description and checked by `motion_validate`.
 */
import { z } from "zod";
import { LAYER_SCHEMAS } from "./schema";
import type { PrimitiveUse } from "./primitiveProps";

export type JsonSchema = Record<string, unknown>;

/** `use` → a self-contained JSON Schema for one layer of that primitive. */
export function primitiveJsonSchema(use: PrimitiveUse): JsonSchema {
  const schema: z.ZodType = LAYER_SCHEMAS[use];
  const json = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    override: (ctx) => {
      const js = ctx.jsonSchema as JsonSchema;
      if (js.type === "object" && js.properties !== undefined) js.additionalProperties = false;
    },
  }) as JsonSchema;
  delete json.$schema;
  return json;
}
