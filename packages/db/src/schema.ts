import type { JsonValue } from './types';

export interface JsonSchema {
  type?:                 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  required?:             string[];
  properties?:           Record<string, JsonSchema>;
  additionalProperties?: boolean;
  items?:                JsonSchema;
  minimum?:              number;
  maximum?:              number;
  minLength?:            number;
  maxLength?:            number;
  pattern?:              string;
  enum?:                 JsonValue[];
}

/**
 * Validate a value against a JSON Schema subset.
 * Returns an error message string on failure, null on success.
 */
export function validate(val: JsonValue, schema: JsonSchema, path = ''): string | null {
  // type check
  if (schema.type) {
    const actual = val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val;
    if (actual !== schema.type) {
      return `${path || 'value'}: expected ${schema.type}, got ${actual}`;
    }
  }

  // enum check
  if (schema.enum !== undefined) {
    if (!schema.enum.some(e => JSON.stringify(e) === JSON.stringify(val))) {
      return `${path || 'value'}: must be one of ${JSON.stringify(schema.enum)}`;
    }
  }

  // string constraints
  if (typeof val === 'string') {
    if (schema.minLength !== undefined && val.length < schema.minLength) {
      return `${path || 'value'}: minLength ${schema.minLength}, got ${val.length}`;
    }
    if (schema.maxLength !== undefined && val.length > schema.maxLength) {
      return `${path || 'value'}: maxLength ${schema.maxLength}, got ${val.length}`;
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(val)) {
      return `${path || 'value'}: does not match pattern ${schema.pattern}`;
    }
  }

  // number constraints
  if (typeof val === 'number') {
    if (schema.minimum !== undefined && val < schema.minimum) {
      return `${path || 'value'}: minimum ${schema.minimum}, got ${val}`;
    }
    if (schema.maximum !== undefined && val > schema.maximum) {
      return `${path || 'value'}: maximum ${schema.maximum}, got ${val}`;
    }
  }

  // object constraints
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
    const obj = val as Record<string, JsonValue>;

    // required fields
    for (const field of schema.required ?? []) {
      if (!(field in obj)) return `${path || 'object'}: missing required field "${field}"`;
    }

    // properties
    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          const err = validate(obj[key], subSchema, path ? `${path}.${key}` : key);
          if (err) return err;
        }
      }
    }

    // additionalProperties
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(obj)) {
        if (!(key in schema.properties)) {
          return `${path || 'object'}: additional property "${key}" not allowed`;
        }
      }
    }
  }

  // array constraints
  if (Array.isArray(val) && schema.items) {
    for (let i = 0; i < val.length; i++) {
      const err = validate(val[i], schema.items, `${path}[${i}]`);
      if (err) return err;
    }
  }

  return null;
}
