// Minimal VLESS proxy + lightweight subscription (/sub).
// A slim alternative to the full edgetunnel _worker.js.
// Use this when the full edgetunnel build gets Error 1101 on an account
// (the full build + KV/admin bindings can get a service flagged, while this
// minimal build runs clean on a fresh service).
// BEFORE DEPLOYING: replace the placeholder UUID_STR below with your own
// UUIDv4. The /sub endpoint returns vless:// links for that UUID.
// Deploy with: PUT /accounts/{id}/workers/scripts/{name} as
// application/javascript+module, then enable the workers.dev subdomain.
// No KV binding and no env vars are required.
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
// NOTE (2026-11-09): do NOT statically import "cloudflare:sockets" — on this
// account a static import gets the service Error 1101. Load it dynamically
// at runtime inside startRemote() instead; that loads clean.
var UUID_STR = "00000000-0000-4000-8000-000000000000";
var WS_PATH = "/59829528aac48b2e8bd8d1cce9aafd28";
var MAX_REPLAY_BYTES = 64 * 1024;
var MAX_CONNECT_RETRIES = 2;
var UUID_BYTES = new Uint8Array(16);
var uuidHex = UUID_STR.replace(/-/g, "");
for (let i = 0; i < 16; i++) {
  UUID_BYTES[i] = parseInt(uuidHex.substr(i * 2, 2), 16);
}
function parseVlessHeader(buf) {
  if (buf.byteLength < 24) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = buf[0];
  for (let i = 0; i < 16; i++) {
    if (buf[i + 1] !== UUID_BYTES[i]) return null;
  }
  let offset = 17;
  const addonLength = buf[offset];
  offset += 1 + addonLength;
  if (offset + 4 > buf.byteLength) return null;
  const command = buf[offset++];
  if (command !== 1) return null;
  const port = view.getUint16(offset);
  offset += 2;
  const addressType = buf[offset++];
  let hostname = "";
  if (addressType === 1) {
    if (offset + 4 > buf.byteLength) return null;
    hostname = `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
    offset += 4;
  } else if (addressType === 2) {
    if (offset >= buf.byteLength) return null;
    const length = buf[offset++];
    if (offset + length > buf.byteLength) return null;
    hostname = new TextDecoder().decode(buf.subarray(offset, offset + length));
    offset += length;
  } else if (addressType === 3) {
    if (offset + 16 > buf.byteLength) return null;
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(view.getUint16(offset + i * 2).toString(16));
    }
    hostname = parts.join(":");
    offset += 16;
  } else {
    return null;
  }
  return { version, hostname, port, headerLength: offset };
}
__name(parseVlessHeader, "parseVlessHeader");
async function toUint8Array(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data && typeof data.arrayBuffer === "function") {
    return new Uint8Array(await data.arrayBuffer());
  }
  return null;
}
__name(toUint8Array, "toUint8Array");
function concatChunks(chunks, totalBytes) {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
__name(concatChunks, "concatChunks");
function safeCloseWebSocket(webSocket, code, reason) {
  if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) {
    try {
      webSocket.close(code, reason);
    } catch (_) {
    }
  }
}
__name(safeCloseWebSocket, "safeCloseWebSocket");
var index_default = {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    if (url.pathname === "/sub") {
      const host = url.hostname;
      const ips = ["104.16.0.1", "172.66.0.1", "104.17.128.16"];
      const links = ips.map((ip, i) => {
        return "vless://" + UUID_STR + "@" + ip + ":2083?encryption=none&security=tls&sni=" + host + "&fp=chrome&type=ws&host=" + host + "&path=%2F59829528aac48b2e8bd8d1cce9aafd28#node-" + (i + 1);
      });
      links.push("vless://" + UUID_STR + "@" + host + ":443?encryption=none&security=tls&sni=" + host + "&fp=chrome&type=ws&host=" + host + "&path=%2F59829528aac48b2e8bd8d1cce9aafd28#node-host");
      return new Response(links.join("\n"), { status: 200, headers: { "Content-Type": "text/plain;charset=utf-8" } });
    }
    if (url.pathname !== WS_PATH) {
      return new Response("Not Found", { status: 404 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 400 });
    }
    const [clientWebSocket, serverWebSocket] = Object.values(new WebSocketPair());
    serverWebSocket.accept();
    let destination = null;
    let remoteSocket = null;
    let remoteWriter = null;
    let writeChain = Promise.resolve();
    let replayChunks = [];
    let replayBytes = 0;
    let receivedRemoteData = false;
    let retryCount = 0;
    let generation = 0;
    let clientClosed = false;
    const rememberForRetry = /* @__PURE__ */ __name((chunk) => {
      if (receivedRemoteData || chunk.byteLength === 0) return;
      if (replayBytes + chunk.byteLength > MAX_REPLAY_BYTES) return;
      const copy = chunk.slice();
      replayChunks.push(copy);
      replayBytes += copy.byteLength;
    }, "rememberForRetry");
    const closeRemote = /* @__PURE__ */ __name(() => {
      generation += 1;
      remoteWriter = null;
      if (remoteSocket) {
        try {
          remoteSocket.close();
        } catch (_) {
        }
        remoteSocket = null;
      }
    }, "closeRemote");
    const startRemote = /* @__PURE__ */ __name(async () => {
      if (!destination || clientClosed) return;
      const currentGeneration = ++generation;
      // Dynamic import: a static `import { connect } from "cloudflare:sockets"`
      // gets this account Error 1101; runtime loading works (verified 2026-11-09).
      const { connect } = await import("cloudflare:sockets");
      const socket = connect(
        { hostname: destination.hostname, port: destination.port },
        { secureTransport: "off", allowHalfOpen: false }
      );
      try {
        await socket.opened;
      } catch (error) {
        try {
          socket.close();
        } catch (_) {
        }
        if (!clientClosed && retryCount < MAX_CONNECT_RETRIES) {
          retryCount += 1;
          console.warn("remote open failed; retrying", retryCount, error);
          await startRemote();
          return;
        }
        throw error;
      }
      if (clientClosed || currentGeneration !== generation) {
        socket.close();
        return;
      }
      remoteSocket = socket;
      const writer = socket.writable.getWriter();
      remoteWriter = writer;
      const replay = concatChunks(replayChunks, replayBytes);
      writeChain = replay.byteLength > 0 ? writer.write(replay) : Promise.resolve();
      await writeChain;
      void (async () => {
        const reader = socket.readable.getReader();
        let sawData = false;
        let failure = null;
        try {
          while (!clientClosed && currentGeneration === generation) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value?.byteLength) continue;
            sawData = true;
            receivedRemoteData = true;
            replayChunks = [];
            replayBytes = 0;
            serverWebSocket.send(value);
          }
        } catch (error) {
          failure = error;
          console.error("remote read failed", error);
        } finally {
          try {
            reader.releaseLock();
          } catch (_) {
          }
          try {
            writer.releaseLock();
          } catch (_) {
          }
          try {
            socket.close();
          } catch (_) {
          }
        }
        if (clientClosed || currentGeneration !== generation) return;
        remoteSocket = null;
        remoteWriter = null;
        if (!sawData && retryCount < MAX_CONNECT_RETRIES) {
          retryCount += 1;
          console.warn("remote closed before first response; retrying", retryCount, failure);
          try {
            await startRemote();
            return;
          } catch (error) {
            console.error("remote retry failed", error);
          }
        }
        safeCloseWebSocket(serverWebSocket, failure ? 1011 : 1e3, failure ? "remote error" : "remote eof");
      })();
    }, "startRemote");
    serverWebSocket.addEventListener("message", async (event) => {
      try {
        const chunk = await toUint8Array(event.data);
        if (!chunk) {
          safeCloseWebSocket(serverWebSocket, 1003, "binary required");
          return;
        }
        if (!destination) {
          const header = parseVlessHeader(chunk);
          if (!header) {
            safeCloseWebSocket(serverWebSocket, 1008, "bad vless");
            return;
          }
          destination = { hostname: header.hostname, port: header.port };
          const initialPayload = chunk.subarray(header.headerLength);
          rememberForRetry(initialPayload);
          serverWebSocket.send(new Uint8Array([header.version, 0]));
          try {
            await startRemote();
          } catch (error) {
            console.error("remote connection failed", error);
            safeCloseWebSocket(serverWebSocket, 1011, "connect failed");
          }
          return;
        }
        rememberForRetry(chunk);
        const writer = remoteWriter;
        if (!writer) {
          return;
        }
        writeChain = writeChain.then(() => writer.write(chunk));
        await writeChain;
      } catch (error) {
        console.error("websocket message processing failed", error);
        safeCloseWebSocket(serverWebSocket, 1011, "processing failed");
      }
    });
    const handleClientClose = /* @__PURE__ */ __name(() => {
      clientClosed = true;
      closeRemote();
    }, "handleClientClose");
    serverWebSocket.addEventListener("close", handleClientClose);
    serverWebSocket.addEventListener("error", handleClientClose);
    return new Response(null, { status: 101, webSocket: clientWebSocket });
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map