// Minimal Socket.IO v4 client over HTTP long-polling, enough to test the server's socket
// authentication and event handlers without adding a client dependency.
// Packet framing: engine.io joins packets with the record separator \x1e; a Socket.IO message is
// "4" + type: 40 CONNECT (+JSON), 42 EVENT ([name, payload]), 44 CONNECT_ERROR (+JSON).
//
// Polling rule: exactly one GET may be outstanding and it must never be aborted (aborting it makes
// the server drop the session). So one GET is kept in flight and each wait races it against a timer.

const SEP = '\x1e';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function connectSocket(base, token, { timeoutMs = 4000 } = {}) {
  const opened = await (await fetch(`${base}/socket.io/?EIO=4&transport=polling`)).text();
  const sid = JSON.parse(opened.slice(opened.indexOf('{'))).sid;
  const url = `${base}/socket.io/?EIO=4&transport=polling&sid=${sid}`;

  const socket = { sid, connected: false, error: null, events: [], pending: null };

  function parse(text) {
    for (const packet of text.split(SEP).filter(Boolean)) {
      if (packet.startsWith('40')) socket.connected = true;
      else if (packet.startsWith('44')) socket.error = JSON.parse(packet.slice(2)).message;
      else if (packet.startsWith('42')) {
        const [name, payload] = JSON.parse(packet.slice(2));
        socket.events.push({ name, payload });
      }
    }
  }

  /** Resolve true as soon as `predicate(socket)` holds, or false after the timeout. */
  socket.waitFor = async (predicate, ms = timeoutMs) => {
    const deadline = Date.now() + ms;
    while (!predicate(socket)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      if (!socket.pending) {
        socket.pending = fetch(url).then(r => r.text()).then(parse).catch(() => {}).finally(() => { socket.pending = null; });
      }
      await Promise.race([socket.pending, sleep(remaining)]);
    }
    return true;
  };

  socket.has = name => socket.events.some(e => e.name === name);
  socket.event = name => socket.events.find(e => e.name === name)?.payload;
  socket.emit = (name, payload) =>
    fetch(url, { method: 'POST', body: `42${JSON.stringify(payload === undefined ? [name] : [name, payload])}` });

  // CONNECT to the default namespace; the auth payload carries the token (undefined = none at all).
  await fetch(url, { method: 'POST', body: token === undefined ? '40' : `40${JSON.stringify({ token })}` });
  await socket.waitFor(s => s.connected || s.error);
  return socket;
}
