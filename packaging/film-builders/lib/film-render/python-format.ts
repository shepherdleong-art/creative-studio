// Formatting compatibility only. Rendering never starts a Python process.
const floatFields = new WeakMap<object, Set<string>>();

export function parsePythonJson(text: string): unknown {
  return JSON.parse(text, function (key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === 'number' && context?.source && /[.eE]/.test(context.source)) {
      let fields = floatFields.get(this);
      if (!fields) floatFields.set(this, fields = new Set());
      fields.add(key);
    }
    return value;
  });
}

export function pyFloat(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Non-finite Python-compatible number');
  if (Object.is(value, -0)) return '-0.0';
  const [mantissa, exponent] = value.toExponential().split('e');
  const exp = Number(exponent);
  if (exp < -4 || exp >= 16) {
    return `${mantissa}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

export function pyNumber(value: number, owner?: object, key?: string | number): string {
  return floatFields.get(owner ?? {})?.has(String(key)) || !Number.isInteger(value)
    ? pyFloat(value) : String(value);
}

/** Exact binary64 rounding, including Python's ties-to-even (not JS toFixed). */
export function pyFixed(value: number, digits: number): string {
  if (!Number.isFinite(value) || !Number.isInteger(digits) || digits < 0 || digits > 20) {
    throw new Error('Invalid fixed-point number');
  }
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, Math.abs(value));
  const bits = bytes.getBigUint64(0);
  const exponent = Number((bits >> BigInt(52)) & BigInt(2047));
  const fraction = bits & ((BigInt(1) << BigInt(52)) - BigInt(1));
  const significand = exponent === 0 ? fraction : fraction + (BigInt(1) << BigInt(52));
  const power = (exponent === 0 ? -1022 : exponent - 1023) - 52;
  let numerator = significand * BigInt(10) ** BigInt(digits);
  const denominator = power < 0 ? BigInt(1) << BigInt(-power) : BigInt(1);
  if (power >= 0) numerator <<= BigInt(power);
  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * BigInt(2) > denominator ||
      (remainder * BigInt(2) === denominator && rounded % BigInt(2) !== BigInt(0))) rounded++;
  const s = rounded.toString().padStart(digits + 1, '0');
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  return sign + (digits ? `${s.slice(0, -digits)}.${s.slice(-digits)}` : s);
}

export function roundEven(value: number): number { return Number(pyFixed(value, 0)) || 0; }

export function pyJson(value: unknown, ascii = true): string {
  function encode(item: unknown, owner?: object, key?: string): string {
    if (typeof item === 'number') return pyNumber(item, owner, key);
    if (typeof item === 'string') {
      const quoted = JSON.stringify(item);
      return ascii ? quoted.replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`) : quoted;
    }
    if (item === null || typeof item === 'boolean') return String(item);
    if (Array.isArray(item)) return `[${item.map((v, i) => encode(v, item, String(i))).join(', ')}]`;
    if (typeof item === 'object') return `{${Object.entries(item).map(([k, v]) => `${encode(k)}: ${encode(v, item, k)}`).join(', ')}}`;
    throw new Error('Unsupported JSON value');
  }
  return encode(value);
}

export function htmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}
