export type ProviderErrorKind = 'rate-limit' | 'quota' | 'invalid-key' | 'authentication' | 'access' | 'request';

/** HTTP 401/403 can also represent billing, policy, or model-access failures. */
export function classifyProviderError(statusCode: number, message: string): ProviderErrorKind {
  const lower = message.toLowerCase();
  if (statusCode === 429 || lower.includes('rate limit') || lower.includes('too many')) {
    return 'rate-limit';
  }
  if (statusCode === 402 || lower.includes('quota') || lower.includes('insufficient_quota')) {
    return 'quota';
  }
  if (/\b(?:invalid|missing|incorrect) api[ -]?key\b/u.test(lower)) {
    return 'invalid-key';
  }
  if (statusCode === 403) {return 'access';}
  if (statusCode === 401 || lower.includes('unauthorized')) {return 'authentication';}
  return 'request';
}