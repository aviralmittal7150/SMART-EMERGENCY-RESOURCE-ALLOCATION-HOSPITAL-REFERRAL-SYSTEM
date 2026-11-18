// server/services/trustProxy.js
// TRUST_PROXY (round 2, item 10): unset / false = the socket address is the client (default); a hop count (e.g. 1);
// or explicit addresses / subnets (comma-separated IPs or CIDRs, or Express's named subnets loopback, linklocal,
// uniquelocal). `true` is REFUSED: it would trust any X-Forwarded-For a client sends and defeat the rate limits.

import net from 'node:net';

const NAMED_SUBNETS = ['loopback', 'linklocal', 'uniquelocal'];

function validSubnet(entry) {
  if (NAMED_SUBNETS.includes(entry)) return true;
  const [address, prefix, extra] = entry.split('/');
  const family = net.isIP(address);
  if (!family || extra !== undefined) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

export function parseTrustProxy(raw) {
  const value = String(raw ?? '').trim();
  if (value === '' || /^(false|no|off)$/i.test(value)) return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (/^true$/i.test(value)) {
    throw new Error('TRUST_PROXY=true is refused: it trusts any X-Forwarded-For. Set the number of proxy hops (e.g. 1) or the proxy addresses/subnets.');
  }
  const entries = value.split(',').map(e => e.trim()).filter(Boolean);
  const bad = entries.filter(e => !validSubnet(e));
  if (!entries.length || bad.length) {
    throw new Error(`TRUST_PROXY must be false, a hop count, or proxy addresses/subnets; invalid: ${bad.join(', ') || value}.`);
  }
  return entries;
}
