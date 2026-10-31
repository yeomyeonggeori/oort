import document from "./contracts.schema.json";

type Schema = {
  $ref?: string;
  oneOf?: Schema[];
  type?: "object" | "array" | "string" | "integer" | "null";
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  minProperties?: number;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
};

export const EXPRESSION_CONTRACTS = document;
export type ExpressionContractName = keyof typeof document.$defs;
const definitions = document.$defs as unknown as Record<string, Schema>;

/** Dependency-free validator for the closed JSON-Schema subset in this contract. */
function conforms(schema: Schema, value: unknown): boolean {
  if (schema.$ref) {
    const target = definitions[schema.$ref.replace("#/$defs/", "")];
    return !!target && conforms(target, value);
  }
  if (schema.oneOf) return schema.oneOf.filter((branch) => conforms(branch, value)).length === 1;
  if (Object.prototype.hasOwnProperty.call(schema, "const")) return value === schema.const;
  if (schema.enum) return schema.enum.includes(value);
  if (schema.type === "null") return value === null;
  if (schema.type === "string") {
    if (typeof value !== "string") return false;
    const length = Array.from(value).length;
    return (schema.minLength === undefined || length >= schema.minLength) &&
      (schema.maxLength === undefined || length <= schema.maxLength) &&
      (schema.pattern === undefined || new RegExp(schema.pattern, "u").test(value));
  }
  if (schema.type === "integer") return typeof value === "number" && Number.isSafeInteger(value) &&
    (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === "array") return Array.isArray(value) &&
    (schema.minItems === undefined || value.length >= schema.minItems) &&
    (schema.maxItems === undefined || value.length <= schema.maxItems) &&
    (!schema.uniqueItems || new Set(value.map((entry) => JSON.stringify(entry))).size === value.length) &&
    !!schema.items && value.every((entry) => conforms(schema.items!, entry));
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    const keys = Object.keys(object);
    return (schema.minProperties === undefined || keys.length >= schema.minProperties) &&
      (schema.required ?? []).every((key) => Object.prototype.hasOwnProperty.call(object, key)) &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(properties, key) ? conforms(properties[key], object[key]) : schema.additionalProperties !== false);
  }
  return false;
}

export function matchesExpressionContract(name: ExpressionContractName, value: unknown): boolean {
  return conforms(definitions[name], value);
}

export function assertExpressionContract(name: ExpressionContractName, value: unknown): void {
  if (!matchesExpressionContract(name, value)) throw new Error(`Invalid expression contract: ${name}`);
}
