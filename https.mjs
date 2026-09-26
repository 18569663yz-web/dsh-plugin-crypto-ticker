/**
 * Minimal HTTPS client that can travel through an HTTP proxy.
 *
 * Node's `fetch` ignores the operating system proxy, and the exchanges this plugin
 * reads are unreachable without it on a machine whose only route out is a local
 * proxy. `undici` would solve this, but it is not this plugin's dependency and the
 * profile's `plugins/` directory has no `node_modules`, so resolving it means
 * guessing at the DSH installation layout. Node's own `http`/`tls` are always there,
 * so the tunnel is opened directly instead.
 *
 * Only what this plugin needs is implemented: an HTTPS GET through an HTTP proxy's
 * CONNECT method, chunked transfer decoding, a bounded body, and caller cancellation.
 * The exchanges answer large ticker tables with `Transfer-Encoding: chunked`, so a
 * reader that ignores framing would hand back chunk-size text instead of JSON.
 */

import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
/** Cap on a response body; the largest ticker table this plugin reads is about 500 KiB. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Cap on the response head; a legitimate one is a few hundred bytes. */
const MAX_HEAD_BYTES = 64 * 1024

/** ASCII for `\r\n`. */
const CR = 13
const LF = 10

/**
 * Decode `Transfer-Encoding: chunked` framing.
 * @param chunks - raw body chunks with the framing still in place.
 * @returns the decoded body, or undefined when the framing is malformed.
 */
function decodeChunked(chunks) {
  const joined = Buffer.concat(chunks)
  const parts = []
  let offset = 0
  for (;;) {
    const lineEnd = joined.indexOf(CR, offset)
    if (lineEnd === -1) return undefined
    // A chunk-size line may carry an extension after `;`, which is not part of the size.
    const size = Number.parseInt(joined.subarray(offset, lineEnd).toString('latin1').split(';')[0].trim(), 16)
    if (!Number.isInteger(size) || size < 0) return undefined
    if (size === 0) break
    const start = lineEnd + 2
    const end = start + size
    if (end > joined.length) return undefined
    parts.push(joined.subarray(start, end))
    if (joined[end] !== CR || joined[end + 1] !== LF) return undefined
    offset = end + 2
  }
  return Buffer.concat(parts)
}

/**
 * Open a TLS socket to `target` through an HTTP proxy's CONNECT tunnel.
 * @param proxy - the proxy URL to dial; only `http:` proxies are supported.
 * @param target - the https URL whose host and port the tunnel must reach.
 * @param signal - caller cancellation, which destroys the sockets.
 * @returns a connected TLS socket.
 */
function openTunnel(proxy, target, signal) {
  return new Promise((resolve, reject) => {
    if (proxy.protocol !== 'http:') {
      reject(new Error(`only http:// proxies are supported, got ${proxy.protocol}`))
      return
    }
    const port = target.port === '' ? '443' : target.port
    const authority = `${target.hostname}:${port}`
    const request = httpRequest({
      host: proxy.hostname,
      port: proxy.port === '' ? 80 : Number(proxy.port),
      method: 'CONNECT',
      path: authority,
      // The tunnel line carries the authority in its path, so no host header is added.
      headers: {},
      setHost: false,
      signal,
    })
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`proxy refused CONNECT to ${authority}: HTTP ${response.statusCode}`))
        return
      }
      const secure = tlsConnect({ socket, servername: target.hostname })
      secure.once('secureConnect', () => { resolve(secure) })
      secure.once('error', (error) => { secure.destroy(); reject(error) })
    })
    request.once('error', reject)
    request.end()
  })
}

/**
 * Dial the target directly, without a proxy.
 * @param target - the URL to reach; `http:` only appears when a test redirects an upstream.
 * @param signal - caller cancellation.
 * @returns a connected socket, TLS-wrapped for `https:` targets.
 */
function openDirect(target, signal) {
  const port = target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port)
  if (target.protocol !== 'https:') return netConnect({ host: target.hostname, port, signal })
  return tlsConnect({ host: target.hostname, port, servername: target.hostname, signal })
}

/**
 * Send one HTTPS GET and read its whole body as text.
 * @param url - the https URL to read.
 * @param options - request headers, per-attempt timeout, and an optional proxy URL.
 * @returns the response status, headers, and decoded body text.
 */
export async function httpsGet(url, options) {
  const target = new URL(url)
  const proxy = options.proxy === undefined ? undefined : new URL(options.proxy)
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  // Only https upstreams are proxied: a plain-http target exists solely so a test can
  // point an exchange at a local server, and that server needs no tunnel.
  const socket = (proxy === undefined || target.protocol !== 'https:')
    ? openDirect(target, signal)
    : await openTunnel(proxy, target, signal)

  return new Promise((resolve, reject) => {
    /** Every exit path destroys the socket, so a failed read cannot leak a tunnel. */
    const fail = (error) => { socket.destroy(); reject(error) }
    signal.addEventListener('abort', () => { socket.destroy() }, { once: true })
    socket.once('error', fail)

    // A direct socket has not finished its handshake yet, while a tunnel hands back an
    // already-connected socket whose `secureConnect` has fired. Asking the socket is the
    // only way to cover both without waiting for an event that will never come again.
    const send = () => {
      socket.write(
        `GET ${target.pathname}${target.search} HTTP/1.1\r\n`
        + `host: ${target.hostname}\r\n`
        + `accept: ${options.headers.accept}\r\n`
        + `user-agent: ${options.headers['user-agent']}\r\n`
        + 'accept-encoding: identity\r\n'
        + 'connection: close\r\n\r\n',
      )
    }
    // A directly dialled TLS socket has not finished its handshake yet, while a tunnel
    // hands back an already-connected socket whose `secureConnect` has fired. A plain
    // socket has no handshake to wait for at all.
    if (socket.encrypted === true && socket.connecting === true) socket.once('secureConnect', send)
    else send()

    /** Head bytes until the blank line, then body bytes with the framing intact. */
    const headChunks = []
    const bodyChunks = []
    let head
    let bodySize = 0
    let settled = false

    const finish = () => {
      if (settled) return
      if (head === undefined) { settled = true; fail(new Error('connection closed before any response')); return }
      settled = true
      const lines = head.split('\r\n')
      const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(lines[0])?.[1])
      /** Lower-cased header names, so lookups do not depend on the server's casing. */
      const headers = {}
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':')
        if (colon === -1) continue
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      socket.destroy()
      if (!Number.isFinite(status)) { reject(new Error('response had no HTTP status line')); return }
      const raw = Buffer.concat(bodyChunks)
      const body = headers['transfer-encoding'] !== undefined
        && headers['transfer-encoding'].toLowerCase().includes('chunked')
        ? decodeChunked(bodyChunks)
        : raw
      if (body === undefined) reject(new Error('chunked response body was malformed'))
      else resolve({ status, headers, body: body.toString('utf8') })
    }

    socket.on('data', (chunk) => {
      if (settled) return
      if (head !== undefined) {
        bodyChunks.push(chunk)
        bodySize += chunk.length
        if (bodySize > MAX_BODY_BYTES) { settled = true; fail(new Error('response body exceeded 8 MiB')) }
        return
      }
      // The status line and headers can be split across chunks, so nothing is parsed
      // until the blank line that ends them has arrived.
      headChunks.push(chunk)
      const joined = Buffer.concat(headChunks)
      const boundary = joined.indexOf('\r\n\r\n')
      if (boundary === -1) {
        if (joined.length > MAX_HEAD_BYTES) { settled = true; fail(new Error('response headers exceeded 64 KiB')) }
        return
      }
      head = joined.subarray(0, boundary).toString('latin1')
      const rest = joined.subarray(boundary + 4)
      if (rest.length > 0) { bodyChunks.push(rest); bodySize += rest.length }
    })

    socket.on('end', finish)
  })
}
