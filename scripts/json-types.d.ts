// JSDoc cannot declare a recursive type alias, so the plain-Node scripts import these.
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface JsonObject {
  [key: string]: JsonValue;
}
