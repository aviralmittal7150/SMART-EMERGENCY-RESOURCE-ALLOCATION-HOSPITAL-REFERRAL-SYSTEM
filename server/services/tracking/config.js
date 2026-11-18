// server/services/tracking/config.js
// Start-up settings of the live-tracking demo. Junk stops the server, as the other numeric settings do.
//   TRACKING_TICK_MS        how often the engine moves the trips: whole ms, 100 to 60000 (default 500 outside production,
//                           1000 in production; Batch 8 P-0.2: smoother movement)
//   TRACKING_TIME_SCALE     simulated seconds per real second: 1 to 1000 (default 1). TESTS ONLY: must be 1 (or unset) when
//                           NODE_ENV=production.
//   TRACKING_DEMO_SPEEDUP   Batch 8 (P-0.2), development / demo only: a further time multiplier so a cross-town Dehradun
//                           leg takes about 30-60 s instead of minutes: 1 to 20 (default 4 outside production). Refused
//                           (start-up error) when set to anything but 1 with NODE_ENV=production. Trips stay "Simulated".
//   TRACKING_LEG_SECONDS    Batch 8 (Addendum 2): time compression, "off" or "<min>-<max>" real seconds per leg (whole
//                           seconds, 1-600): every simulated leg lasts between min and max seconds whatever its length,
//                           so a whole trip takes at most 2 x max. Default "30-60" outside production, "off" in production
//                           (real speeds) unless set explicitly.
//   SIMULATED_TRANSPORT     Batch 8 (P-0.3): "on" | "off". On: when a hospital accepts a case and an ambulance is
//                           dispatched to it, a simulated trip is created and started at once. Default on outside
//                           production, off in production (there is no real GPS); production may turn it on explicitly.
//   ROUTING_URL / ROUTING_TIMEOUT_MS: see routing.js.

import { parseIntegerSetting } from '../settings.js';
import { parseRoutingUrl, parseRoutingTimeout } from './routing.js';

export function parseTrackingConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const tickMs = parseIntegerSetting('TRACKING_TICK_MS', env.TRACKING_TICK_MS, { fallback: production ? 1000 : 500, min: 100, max: 60_000 });
  const timeScale = parseIntegerSetting('TRACKING_TIME_SCALE', env.TRACKING_TIME_SCALE, { fallback: 1, min: 1, max: 1000 });
  if (production && timeScale !== 1) throw new Error('TRACKING_TIME_SCALE is a test setting and must be 1 (or unset) when NODE_ENV=production.');
  const demoSpeedup = parseIntegerSetting('TRACKING_DEMO_SPEEDUP', env.TRACKING_DEMO_SPEEDUP, { fallback: production ? 1 : 4, min: 1, max: 20 });
  if (production && demoSpeedup !== 1) throw new Error('TRACKING_DEMO_SPEEDUP is a development / demo setting and must be 1 (or unset) when NODE_ENV=production.');
  const transport = String(env.SIMULATED_TRANSPORT ?? '').trim().toLowerCase();
  if (!['', 'on', 'off'].includes(transport)) throw new Error(`SIMULATED_TRANSPORT must be "on" or "off" (got "${env.SIMULATED_TRANSPORT}").`);
  const legRaw = String(env.TRACKING_LEG_SECONDS ?? '').trim().toLowerCase();
  let legSeconds = null;
  if (legRaw === '' ? !production : legRaw !== 'off') {
    const m = (legRaw === '' ? '30-60' : legRaw).match(/^(\d{1,3})-(\d{1,3})$/);
    const [min, max] = m ? [Number(m[1]), Number(m[2])] : [NaN, NaN];
    if (!(min >= 1 && max <= 600 && min <= max)) throw new Error(`TRACKING_LEG_SECONDS must be "off" or "<min>-<max>" seconds, 1 to 600, min <= max (got "${env.TRACKING_LEG_SECONDS}").`);
    legSeconds = { min, max };
  }
  return {
    tickMs,
    legSeconds,
    timeScale: timeScale * demoSpeedup,
    demoSpeedup,
    simulatedTransport: transport === '' ? !production : transport === 'on',
    routingUrl: parseRoutingUrl(env.ROUTING_URL, { production }),
    routingTimeoutMs: parseRoutingTimeout(env.ROUTING_TIMEOUT_MS)
  };
}
