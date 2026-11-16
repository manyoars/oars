// Reads of untyped JSON without casts: each reader names the field it wanted when it fails, so an order or manifest error points at the key.
export type JsonObject = { readonly [key: string]: unknown };

export class ParseError extends Error {}

export const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

export const objectAt = (value: unknown, where: string): JsonObject => {
  if (!isObject(value)) throw new ParseError(`${where} must be an object`);
  return value;
};

export const stringAt = (from: JsonObject, key: string, where: string): string => {
  const value = from[key];
  if (typeof value !== 'string' || value === '') throw new ParseError(`${where}.${key} must be a non-empty string`);
  return value;
};

export const optionalStringAt = (from: JsonObject, key: string, where: string): string | undefined => (from[key] === undefined ? undefined : stringAt(from, key, where));

export const arrayAt = (from: JsonObject, key: string, where: string): readonly unknown[] => {
  const value = from[key];
  if (!Array.isArray(value)) throw new ParseError(`${where}.${key} must be an array`);
  return value;
};

export const parseJson = (text: string, where: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new ParseError(`${where} is not valid JSON`);
  }
};
