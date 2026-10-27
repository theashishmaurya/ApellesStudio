/**
 * Reading a zod schema's structure (D-403/D-405): its definition type, and the
 * wrappers to look through. Used by `validate.ts` (walking a schema beside the
 * data) and by `schema.ts`'s `anim` check (what kind of prop a track targets).
 *
 * zod 4 exposes the definition as `schema.def`; it is read here through a
 * narrow structural type (only the fields used), never `any`.
 */
import type { z } from "zod";

/** zod 4's internal definition, read through a narrow structural type rather
 *  than `any`: only the fields this walker uses. */
export interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  items?: z.ZodType[];
  rest?: z.ZodType | null;
  innerType?: z.ZodType;
  in?: z.ZodType;
  options?: z.ZodType[];
  discriminator?: string;
  getter?: () => z.ZodType;
  valueType?: z.ZodType;
}

export function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { def: Def }).def;
}

/** strip the wrappers that do not change what a value looks like. */
export function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema;
  for (;;) {
    const d = defOf(s);
    if (
      (d.type === "optional" || d.type === "nullable" || d.type === "default" || d.type === "readonly" ||
        d.type === "catch" || d.type === "nonoptional" || d.type === "prefault") &&
      d.innerType
    ) {
      s = d.innerType;
    } else if (d.type === "lazy" && d.getter) {
      s = d.getter();
    } else if (d.type === "pipe" && d.in) {
      s = d.in;
    } else {
      return s;
    }
  }
}


function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** For a union, the option `data` belongs to: by discriminator when there is
 *  one, else the first option it parses under, else `undefined`. */
export function optionFor(def: Def, data: unknown): z.ZodType | undefined {
  const options = def.options ?? [];
  if (def.discriminator && isPlainObject(data)) {
    const want = data[def.discriminator];
    return options.find((opt) => {
      const shape = defOf(unwrap(opt)).shape;
      const lit = shape?.[def.discriminator as string];
      return lit !== undefined && lit.safeParse(want).success;
    });
  }
  return options.find((opt) => opt.safeParse(data).success);
}
