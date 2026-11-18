// js/dom.js
// Safe DOM construction. Every server-provided string reaches the page through textContent or an
// attribute set with setAttribute — never through innerHTML — so a value such as a patient name
// "<img src=x onerror=...>" is always rendered as text.

/**
 * el('div', { class: 'card', dataset: { id: 'H-101' }, on: { click: fn } }, 'text', childNode, [more])
 * Children: strings/numbers become text nodes; null/undefined/false are skipped; arrays are flattened.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.entries(value).forEach(([k, v]) => { if (v !== undefined && v !== null) node.dataset[k] = String(v); });
    else if (key === 'on') Object.entries(value).forEach(([evt, fn]) => node.addEventListener(evt, fn));
    else if (key === 'disabled' || key === 'checked' || key === 'selected' || key === 'hidden' || key === 'required') node[key] = Boolean(value);
    else if (key === 'value') node.value = String(value);
    else if (key.startsWith('on')) throw new Error(`Inline handler attribute "${key}" is not allowed; use props.on.`);
    else if (key === 'style') throw new Error('Inline style attributes are not allowed (CSP); use a class.');
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

/** Replace all children of `node` with `children` (same rules as el()). */
export function mount(node, ...children) {
  if (!node) return;
  node.replaceChildren();
  append(node, children);
}

export const byId = id => document.getElementById(id);

export function setText(id, value) {
  const node = typeof id === 'string' ? byId(id) : id;
  if (node) node.textContent = value === undefined || value === null ? '' : String(value);
}

export function show(node, visible = true) {
  const target = typeof node === 'string' ? byId(node) : node;
  if (target) target.hidden = !visible;
}

// ── Formatting ───────────────────────────────────────────────────────────────
const toDate = value => {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(d.getTime()) ? null : d;
};

export function fmtDateTime(value) {
  const d = toDate(value);
  return d ? d.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

export function fmtTime(value) {
  const d = toDate(value);
  return d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

export const fmtStatus = value => (value ? String(value).replace(/_/g, ' ') : '—');

export function fmtNumber(value, digits = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

/** CSV cell: quoted, quotes doubled, and a leading = + - @ neutralised so spreadsheets do not run formulas. */
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function downloadCsv(rows, fileName) {
  const content = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: fileName, class: 'sr-only' });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
