/**
 * Remove any text that looks like an API key from log messages.
 * Matches common patterns: sk-..., Bearer tokens, long base64 strings
 */
export function sanitizeMessage(message: string): string {
  return (
    message
      // URLs in provider errors may contain COS signatures or credentials.
      .replace(/https?:\/\/[^\s<>"']+/gi, (url) => {
        try {
          const parsed = new URL(url);
          parsed.username = '';
          parsed.password = '';
          parsed.search = parsed.search ? '?[REDACTED_QUERY]' : '';
          parsed.hash = '';
          return parsed.toString();
        } catch { return '[REDACTED_URL]'; }
      })
      .replace(/((?:api[_-]?key|access[_-]?token|secret|q-signature|signature)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi, '$1[REDACTED]')
      // Redact OpenAI-style keys (sk-...)
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]')
      // Redact Bearer tokens in log messages
      .replace(/Bearer\s+[a-zA-Z0-9._\-=+/]{20,}/gi, 'Bearer [REDACTED]')
      // Redact Authorization headers
      .replace(/Authorization:\s*[^\s,]+\s*[^\s,]+/gi, 'Authorization: [REDACTED]')
      // Redact long hex/base64 strings that could be keys (40+ chars)
      .replace(/\b[a-zA-Z0-9+/=]{40,}\b/g, (match) => {
        // Don't redact image base64 (they're much longer and come after "b64_json")
        if (match.length > 200) return match;
        return '[REDACTED_LONG_STRING]';
      })
  );
}
