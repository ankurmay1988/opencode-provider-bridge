// =============================================================================
// providerUtils.ts  —  Schema simplification & tool result helpers
// =============================================================================
//
// Utilities for simplifying JSON schemas (stripping unsupported keywords)
// and extracting text from AI SDK tool result outputs.
// =============================================================================

import { log } from './logger.js';

// ---------------------------------------------------------------------------
// Schema simplification
// ---------------------------------------------------------------------------

const SAFE_SCHEMA_KEYS = new Set([
  'type', 'properties', 'items', 'required', 'description',
  'enum', 'format', 'default',
  'minimum', 'maximum', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'additionalProperties',
  'anyOf', 'oneOf', 'allOf', '$ref', 'not',
  'title', 'examples', 'pattern',
]);

/**
 * Recursively simplify a JSON schema by removing keys that the AI SDK
 * does not understand, while preserving the core validation structure.
 */
export function simplifySchema(schema: unknown, label = ''): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const rec = schema as Record<string, unknown>;
  const rawKeys = Object.keys(rec);

  for (const combinator of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (rec[combinator] && Array.isArray(rec[combinator])) {
      return {
        [combinator]: (rec[combinator] as unknown[]).map((sub, i) =>
          simplifySchema(sub, `${label}.${combinator}[${i}]`),
        ),
      };
    }
  }

  if (rec.type === 'object' || rec.type === undefined) {
    const out: Record<string, unknown> = { type: 'object' };
    for (const key of Object.keys(rec)) {
      if (!SAFE_SCHEMA_KEYS.has(key)) {continue;}
      const val = rec[key];
      if (key === 'properties' && val && typeof val === 'object' && !Array.isArray(val)) {
        const cleaned: Record<string, unknown> = {};
        for (const [propName, propSchema] of Object.entries(val as Record<string, unknown>)) {
          cleaned[propName] = simplifySchema(propSchema, `${label}.${propName}`);
        }
        out.properties = cleaned;
      } else if (key === 'items' && val && typeof val === 'object') {
        out.items = simplifySchema(val, `${label}.items`);
      } else {
        out[key] = val;
      }
    }
    const stripped = rawKeys.filter(k => !SAFE_SCHEMA_KEYS.has(k));
    if (stripped.length > 0) {
      log(`[opencode-provider-bridge] schema ${label || '<root>'}: stripped ${stripped.join(', ')}`, 'debug');
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rec)) {
    if (SAFE_SCHEMA_KEYS.has(key)) {
      const val = rec[key];
      if (key === 'items' && val && typeof val === 'object') {
        out.items = simplifySchema(val, `${label}.items`);
      } else {
        out[key] = val;
      }
    }
  }
  const stripped = rawKeys.filter(k => !SAFE_SCHEMA_KEYS.has(k));
  if (stripped.length > 0) {
    log(`[opencode-provider-bridge] schema ${label || '<root>'}: stripped ${stripped.join(', ')}`, 'debug');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool result extraction
// ---------------------------------------------------------------------------

/**
 * Extract plain text from an AI SDK ToolResult for rendering in the chat UI.
 * ToolResult.content is typically an array of { type: 'text', text: '...' } parts.
 */
export function extractTextFromToolResult(result: unknown): string {
  if (!result || typeof result !== 'object') {return '';}
  const rec = result as Record<string, unknown>;
  if (typeof rec.text === 'string') {return rec.text;}
  if (Array.isArray(rec.content)) {
    return rec.content
      .map((part: unknown) => {
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (p.type === 'text' && typeof p.text === 'string') {return p.text;}
          if (p.type === 'text' && typeof p.value === 'string') {return p.value;}
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
