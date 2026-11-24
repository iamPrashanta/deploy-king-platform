/**
 * A small JSON Schema subset for MCP tool inputs: the same object is sent to agents
 * in tools/list and used here to check the arguments they send back.
 */
export type Prop =
  | { type: "string"; description: string; enum?: string[]; maxLength?: number }
  | { type: "integer"; description: string; minimum?: number; maximum?: number; default?: number }
  | { type: "boolean"; description: string; default?: boolean }
  | { type: "object"; description: string; additionalProperties: { type: "string" } | true }
  | { type: "array"; description: string; items: { type: "string" }; maxItems?: number };

export type InputSchema = { type: "object"; properties: Record<string, Prop>; required?: string[]; additionalProperties: false };

export const obj = (properties: Record<string, Prop>, required: string[] = []): InputSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
export const str = (description: string, extra: { enum?: string[]; maxLength?: number } = {}): Prop => ({ type: "string", description, maxLength: 2000, ...extra });
export const int = (description: string, extra: { minimum?: number; maximum?: number; default?: number } = {}): Prop => ({ type: "integer", description, ...extra });
export const bool = (description: string, dflt?: boolean): Prop => ({ type: "boolean", description, ...(dflt === undefined ? {} : { default: dflt }) });
export const strMap = (description: string): Prop => ({ type: "object", description, additionalProperties: { type: "string" } });
export const anyObj = (description: string): Prop => ({ type: "object", description, additionalProperties: true });
export const strList = (description: string, maxItems = 200): Prop => ({ type: "array", description, items: { type: "string" }, maxItems });

export class ArgError extends Error {}

/** Returns the checked arguments with defaults filled in, or throws ArgError with a readable message. */
export function checkArgs(schema: InputSchema, input: unknown): Record<string, any> {
  const args = input == null ? {} : input;
  if (typeof args !== "object" || Array.isArray(args)) throw new ArgError("Arguments must be an object");
  const out: Record<string, any> = {};
  for (const key of Object.keys(args)) {
    if (!(key in schema.properties)) throw new ArgError(`Unknown argument "${key}". Allowed: ${Object.keys(schema.properties).join(", ") || "none"}`);
  }
  for (const [key, p] of Object.entries(schema.properties)) {
    let v = (args as any)[key];
    if (v === undefined || v === null) {
      if (schema.required?.includes(key)) throw new ArgError(`"${key}" is required`);
      if ("default" in p && p.default !== undefined) out[key] = p.default;
      continue;
    }
    switch (p.type) {
      case "string":
        if (typeof v === "number") v = String(v);
        if (typeof v !== "string") throw new ArgError(`"${key}" must be a string`);
        if (p.maxLength && v.length > p.maxLength) throw new ArgError(`"${key}" is too long`);
        if (p.enum && !p.enum.includes(v)) throw new ArgError(`"${key}" must be one of: ${p.enum.join(", ")}`);
        break;
      case "integer":
        if (typeof v === "string" && /^-?\d+$/.test(v)) v = Number(v);
        if (!Number.isInteger(v)) throw new ArgError(`"${key}" must be a whole number`);
        if (p.minimum !== undefined && v < p.minimum) throw new ArgError(`"${key}" must be at least ${p.minimum}`);
        if (p.maximum !== undefined && v > p.maximum) throw new ArgError(`"${key}" must be at most ${p.maximum}`);
        break;
      case "boolean":
        if (v === "true" || v === "false") v = v === "true";
        if (typeof v !== "boolean") throw new ArgError(`"${key}" must be true or false`);
        break;
      case "object":
        if (typeof v !== "object" || Array.isArray(v)) throw new ArgError(`"${key}" must be an object`);
        if (p.additionalProperties !== true) {
          for (const [k, x] of Object.entries(v)) {
            if (typeof x === "number" || typeof x === "boolean") (v as any)[k] = String(x);
            else if (typeof x !== "string") throw new ArgError(`"${key}.${k}" must be a string`);
          }
        }
        break;
      case "array":
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ArgError(`"${key}" must be a list of strings`);
        if (p.maxItems && v.length > p.maxItems) throw new ArgError(`"${key}" has too many items`);
        break;
    }
    out[key] = v;
  }
  return out;
}
