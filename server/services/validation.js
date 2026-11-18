// server/services/validation.js
// Strict request validation without a dependency (review finding X7). A route declares the fields it reads; the
// middleware checks types, required fields, integer ranges, enums and lengths that match the database columns, and
// hands the route the normalised values in req.valid (body) / req.validQuery (query). Anything wrong is a 400
// { success: false, error } before the route runs; unknown fields are ignored (never read).
//
// Rules: { type, required, nullable, default, min, max, maxLength, maxBytes, values, pattern, upper, emptyAs }
//   string   a JSON string (an object, array, number or boolean is refused); trimmed; `required` also refuses ""
//   integer  a JSON number that is an integer (refuses "", "1", 1.5, true; JSON has no exponent integers to confuse)
//   number   a finite JSON number
//   enum     a string from `values` (`upper` compares case-insensitively and returns the upper-case value)
//   strings  an array of strings (maxItems, each at most maxLength)
//   boolean  a JSON true / false (not "true", 1 or null)
// In a query string every value is text: `integer` there means decimal digits only ("1e3", "-1", "" are refused).

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

const fail = message => { throw new ValidationError(message); };
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkString(name, value, rule) {
  if (typeof value !== 'string') fail(`${name} must be a string.`);
  const text = rule.trim === false ? value : value.trim();
  if (text === '' && rule.emptyAs !== undefined) return rule.emptyAs;
  if (text === '' && rule.required) fail(`${name} must not be empty.`);
  if (rule.maxLength !== undefined && text.length > rule.maxLength) fail(`${name} must be at most ${rule.maxLength} characters.`);
  if (rule.maxBytes !== undefined && Buffer.byteLength(text, 'utf8') > rule.maxBytes) fail(`${name} is too long.`);
  if (rule.pattern && text !== '' && !rule.pattern.test(text)) fail(rule.patternMessage || `${name} has an invalid format.`);
  return text;
}

function checkValue(name, value, rule, { inQuery }) {
  switch (rule.type) {
    case 'string':
      return checkString(name, value, rule);
    case 'enum': {
      if (typeof value !== 'string') fail(`${name} must be one of: ${rule.values.join(', ')}.`);
      const text = rule.upper ? value.trim().toUpperCase() : value.trim();
      if (!rule.values.includes(text)) fail(`${name} must be one of: ${rule.values.join(', ')}.`);
      return text;
    }
    case 'integer': {
      let n = value;
      if (inQuery) {
        if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) fail(`${name} must be a whole number.`);
        n = Number(value);
      } else if (typeof value !== 'number' || !Number.isInteger(value)) {
        fail(`${name} must be a whole number.`);
      }
      if ((rule.min !== undefined && n < rule.min) || (rule.max !== undefined && n > rule.max)) {
        fail(`${name} must be a whole number from ${rule.min ?? '-∞'} to ${rule.max ?? '∞'}.`);
      }
      return n;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} must be a number.`);
      if ((rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max)) {
        fail(`${name} must be a number from ${rule.min} to ${rule.max}.`);
      }
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean') fail(`${name} must be true or false.`);
      return value;
    case 'strings': {
      if (!Array.isArray(value)) fail(`${name} must be a list of strings.`);
      if (rule.maxItems !== undefined && value.length > rule.maxItems) fail(`${name} has too many items (at most ${rule.maxItems}).`);
      return value.map((item, i) => checkString(`${name}[${i}]`, item, { maxLength: rule.maxLength, required: true }));
    }
    default:
      throw new Error(`Unknown validation type ${rule.type}`);
  }
}

/** Validate `source` against `schema`; returns the normalised object (only declared, present fields). */
export function validateFields(source, schema, { inQuery = false } = {}) {
  const input = source === undefined ? {} : source;
  if (!isPlainObject(input)) fail(inQuery ? 'Invalid query string.' : 'The request body must be a JSON object.');
  const out = {};
  for (const [name, rule] of Object.entries(schema)) {
    const value = Object.prototype.hasOwnProperty.call(input, name) ? input[name] : undefined;
    if (value === undefined) {
      if (rule.required) fail(`${name} is required.`);
      if (rule.default !== undefined) out[name] = rule.default;
      continue;
    }
    if (value === null) {
      if (rule.nullable) { out[name] = null; continue; }
      fail(rule.required ? `${name} is required.` : `${name} must not be null.`);
    }
    out[name] = checkValue(name, value, rule, { inQuery });
  }
  return out;
}

const badRequest = (res, err) => res.status(400).json({ success: false, error: err.message });

/** Middleware: validate the JSON body; `atLeastOne` lists fields of which one must be present. */
export function validateBody(schema, { atLeastOne = null } = {}) {
  return (req, res, next) => {
    try {
      req.valid = validateFields(req.body, schema);
      if (atLeastOne && !atLeastOne.some(name => req.valid[name] !== undefined)) {
        fail(`Provide at least one of: ${atLeastOne.join(', ')}.`);
      }
      next();
    } catch (err) {
      if (err instanceof ValidationError) return badRequest(res, err);
      next(err);
    }
  };
}

/** Middleware: validate the query string (each value must be a single string; see rejectRepeatedQuery). */
export function validateQuery(schema) {
  return (req, res, next) => {
    try {
      req.validQuery = validateFields({ ...req.query }, schema, { inQuery: true });
      next();
    } catch (err) {
      if (err instanceof ValidationError) return badRequest(res, err);
      next(err);
    }
  };
}

/** Middleware for every /api route: a repeated query parameter (?a=1&a=2 is an array) is a 400, never a 500. */
export function rejectRepeatedQuery(req, res, next) {
  for (const [name, value] of Object.entries(req.query ?? {})) {
    if (typeof value !== 'string') return res.status(400).json({ success: false, error: `Query parameter "${name}" must be given once.` });
  }
  next();
}

// Shared field rules matching the database columns.
export const ID20 = { type: 'string', maxLength: 20 };           // hospital_id, request_id, ambulance_id, doctor_id
export const SHIFT_TIME = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/; // TIME column: "H:MM" or "HH:MM[:SS]"
