/**
 * Host half of the crypto ticker pill.
 *
 * Publishes one exact Fetch route on Connection's shared `/api` channel, so the
 * browser half reaches it over the same transport the rest of the GUI uses —
 * including the Desktop app, which serves no Web port and forwards `/api/*`
 * through its framed pipe instead of a listener.
 *
 * The route exists for two reasons beyond convenience:
 *   - the upstream exchanges send no CORS headers, so a browser half cannot call
 *     them directly;
 *   - every open tab then shares one upstream request and one cache, instead of
 *     one request per tab per refresh.
 *
 * Sources are tried in order (OKX, then Binance, then CoinGecko) and the one that
 * answered is reported back, so the UI can label degraded data instead of hiding it.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { httpsGet } from './https.mjs'

/**
 * The exchanges are reached over HTTPS, and Node's `fetch` — unlike a browser —
 * ignores the operating system's proxy settings. On a machine that reaches the
 * outside world only through a local proxy, every upstream call would otherwise
 * time out, so the proxy is resolved and the request travels through it.
 */

/** Windows registry key and value names holding the WinINET (system) proxy. */
const WININET_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** Route the browser half polls. `client.js` carries the same constant. */
export const TICKER_PATH = '/api/crypto.ticker'

/** Connection owns the `/api` channel; its exact Fetch registry carries this route. */
export const inject = ['connection']

export const name = 'crypto-ticker'

/** Log prefix for every warning this plugin emits. */
const LOG_PREFIX = '[crypto-ticker]'

/**
 * The Host cannot observe the browser tree, so the pill's first mount POSTs to
 * the same route and the instant is recorded here. Its presence in this file is
 * the only outside evidence that the client bundle registered and rendered.
 */
const HEARTBEAT_FILENAME = 'crypto-ticker.json'

/**
 * Refresh cadence and timeouts are deployment choices, so they arrive as Cordis
 * config fields from the profile patch rather than as fixed constants.
 *
 * There is deliberately no `Config` schema export: Cordis validates a plugin's
 * `Config` as a Standard Schema and refuses to start the whole tree when it is
 * not one, so these defaults are resolved inside {@link apply} instead.
 */
const DEFAULTS = {
  /** Total budget for one upstream attempt before the next source is tried. */
  upstreamTimeoutMs: 8000,
  /** How long a good quote is served from cache before upstream is consulted again. */
  cacheMs: 10000,
  /** How long the 24-hour trend series is reused before it is re-read. */
  sparklineCacheMs: 300000,
  /** Seconds between browser polls; published to the browser half in each payload. */
  schedule: 15,
}

/** Upstream failure classes the browser half renders differently. */
const SOURCES = [
  {
    id: 'okx',
    label: 'OKX',
    quote: okxQuotes,
    spark: okxSpark,
  },
  {
    id: 'binance',
    label: 'Binance',
    quote: binanceQuotes,
    spark: binanceSpark,
  },
  {
    id: 'coingecko',
    label: 'CoinGecko',
    quote: coingeckoQuotes,
    // CoinGecko's free tier has no keyless OHLC series, so this source is quote-only.
    spark: undefined,
  },
]

/**
 * The symbols shown when `config.symbols` is absent.
 *
 * JUP is Solana's Jupiter exchange token; it is quoted as a plain `JUPUSDT`
 * spot pair on OKX and Binance, so it needs no chain access — only the
 * CoinGecko id below for the last-resort source.
 */
export const DEFAULT_SYMBOLS = ['BTC', 'ETH', 'SOL', 'JUP']

/** CoinGecko addresses assets by id, not by ticker; these cover the shipped defaults and common asks. */
const COINGECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  JUP: 'jupiter-exchange-solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  DOGE: 'dogecoin',
  ADA: 'cardano',
  AVAX: 'avalanche-2',
  TON: 'the-open-network',
  LINK: 'chainlink',
  SUI: 'sui',
  LTC: 'litecoin',
  DOT: 'polkadot',
  TRX: 'tron',
}

/**
 * Bare symbol to the USDT-quoted instrument the exchange lists.
 * @param symbol - uppercase bare symbol such as `BTC`.
 * @returns the dashed instrument id OKX uses.
 */
function okxInstId(symbol) {
  return `${symbol}-USDT`
}

/**
 * Read a finite number out of one upstream string field.
 * @param value - raw field, possibly missing or non-numeric.
 * @returns the number, or undefined when the field carries no usable value.
 */
function num(value) {
  if (value === null || value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Percent change from an opening price to the latest price.
 * @param last - latest traded price.
 * @param open - price 24 hours ago.
 * @returns percent change, or undefined when the baseline is unusable.
 */
function percentChange(last, open) {
  if (last === undefined || open === undefined || open === 0) return undefined
  return ((last - open) / open) * 100
}

/**
 * Normalize one raw record into the payload the browser half renders.
 * @param fields - partially filled quote fields.
 * @returns the complete quote, with `changePercent` always present.
 */
function quote(fields) {
  const changePercent = fields.open === undefined
    ? undefined
    : percentChange(fields.price, fields.open)
  return {
    symbol: fields.symbol,
    price: fields.price,
    open: fields.open ?? null,
    high: fields.high ?? null,
    low: fields.low ?? null,
    changePercent: changePercent === undefined ? null : changePercent,
    volume24h: fields.volume24h ?? null,
    volumeUnit: fields.volumeUnit ?? null,
  }
}

/**
 * Read the proxy a request to this URL should travel through.
 *
 * Environment variables win because they are how a deliberate per-process choice
 * is expressed; the Windows system proxy is the fallback, so a machine whose only
 * route out is a local proxy works without any extra setup.
 * @param url - the request URL whose protocol selects the variable.
 * @param override - `config.proxy`, which always wins; `false` forces direct.
 * @returns the proxy URL, or undefined to connect directly.
 */
export function resolveProxy(url, override) {
  if (override === false) return undefined
  if (typeof override === 'string' && override.trim() !== '') return override.trim()

  const env = process.env
  const candidate = url.protocol === 'https:'
    ? env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
    : env.HTTP_PROXY ?? env.http_proxy
  if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()

  if (process.platform !== 'win32') return undefined
  try {
    const output = execFileSync('reg', ['query', WININET_KEY], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(output)) return undefined
    const server = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(output)?.[1]?.trim()
    if (server === undefined || server === '') return undefined
    // A per-protocol list reads `http=host:port;https=host:port`; a bare value applies to both.
    const entry = /(?:^|;)\s*https?=([^;]+)/i.exec(server)?.[1]?.trim() ?? server.split(';')[0].trim()
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? entry : `http://${entry}`
  } catch (error) {
    // No registry, no `reg` binary, or an unreadable value: direct is the only remaining option.
    return undefined
  }
}

/**
 * Read the hostname-to-origin override map.
 *
 * This exists so the smoke test can point every exchange at one local server and
 * exercise the real request path without touching the network. Production leaves it
 * unset and reaches the exchanges.
 * @returns a map from upstream hostname to replacement origin, empty when unset.
 */
function hostOverrides() {
  const raw = process.env.DSH_CRYPTO_TICKER_HOSTS
  if (raw === undefined || raw === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    return {}
  }
}

/**
 * Absolute upstream URL for one source URL.
 * @param url - the shipped upstream URL.
 * @returns the URL to request, with its origin replaced when an override matches.
 */
function upstream(url) {
  const overrides = hostOverrides()
  const target = new URL(url)
  const replacement = overrides[target.hostname]
  return replacement === undefined ? url : `${replacement}${target.pathname}${target.search}`
}

/**
 * Read a JSON document, keeping status and body together for the caller's error text.
 * @param url - absolute upstream URL.
 * @param signal - caller cancellation, combined with the per-attempt timeout.
 * @param timeoutMs - budget for this attempt.
 * @param proxy - `config.proxy`, forwarded to {@link resolveProxy}.
 * @param log - unused by this reader; kept so every source function has one signature.
 * @returns the parsed body.
 */
async function readJson(url, signal, timeoutMs, proxy, log) {
  const target = new URL(url)
  const response = await httpsGet(target.href, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-crypto-ticker' },
    signal,
    timeoutMs,
    proxy: resolveProxy(target, proxy),
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}: ${response.body.slice(0, 160)}`)
  }
  try {
    return JSON.parse(response.body)
  } catch (error) {
    throw new Error(`response is not JSON: ${String(error.message ?? error)}`)
  }
}

/**
 * Quote every requested symbol from OKX's full spot ticker table in one request.
 * @param symbols - uppercase bare symbols.
 * @param signal - caller cancellation.
 * @param timeoutMs - per-attempt budget.
 * @param proxy - `config.proxy`.
 * @param log - warning sink.
 * @returns one quote per requested symbol, in request order.
 */
async function okxQuotes(symbols, signal, timeoutMs, proxy, log) {
  const body = await readJson(upstream('https://www.okx.com/api/v5/market/tickers?instType=SPOT'), signal, timeoutMs, proxy, log)
  if (body?.code !== '0' || !Array.isArray(body.data)) throw new Error(`OKX rejected the request (code ${body?.code})`)
  const byInstId = new Map(body.data.map((row) => [row.instId, row]))
  return symbols.map((symbol) => {
    const row = byInstId.get(okxInstId(symbol))
    return quote({
      symbol,
      price: num(row?.last),
      open: num(row?.open24h),
      high: num(row?.high24h),
      low: num(row?.low24h),
      volume24h: num(row?.volCcy24h),
      volumeUnit: symbol,
    })
  })
}

/**
 * Quote every requested symbol from Binance's multi-symbol 24-hour endpoint.
 * @param symbols - uppercase bare symbols.
 * @param signal - caller cancellation.
 * @param timeoutMs - per-attempt budget.
 * @param proxy - `config.proxy`.
 * @param log - warning sink.
 * @returns one quote per requested symbol, in request order.
 */
async function binanceQuotes(symbols, signal, timeoutMs, proxy, log) {
  const query = encodeURIComponent(JSON.stringify(symbols.map((symbol) => `${symbol}USDT`)))
  const body = await readJson(upstream(`https://api.binance.com/api/v3/ticker/24hr?symbols=${query}`), signal, timeoutMs, proxy, log)
  if (!Array.isArray(body)) throw new Error('Binance returned no ticker array')
  const bySymbol = new Map(body.map((row) => [row.symbol, row]))
  return symbols.map((symbol) => {
    const row = bySymbol.get(`${symbol}USDT`)
    const price = num(row?.lastPrice)
    const change = num(row?.priceChangePercent)
    return quote({
      symbol,
      price,
      // Binance reports the change directly; recover an opening price so every
      // source produces the same fields.
      open: price === undefined || change === undefined ? undefined : price / (1 + change / 100),
      high: num(row?.highPrice),
      low: num(row?.lowPrice),
      volume24h: num(row?.quoteVolume),
      volumeUnit: 'USDT',
    })
  })
}

/**
 * Quote the requested symbols from CoinGecko, which is keyless but rate-limited.
 * @param symbols - uppercase bare symbols.
 * @param signal - caller cancellation.
 * @param timeoutMs - per-attempt budget.
 * @param proxy - `config.proxy`.
 * @param log - warning sink.
 * @returns one quote per requested symbol; symbols without a known id report no price.
 */
async function coingeckoQuotes(symbols, signal, timeoutMs, proxy, log) {
  const ids = symbols.map((symbol) => COINGECKO_IDS[symbol]).filter((id) => id !== undefined)
  const body = await readJson(
    upstream(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`),
    signal,
    timeoutMs,
    proxy,
    log,
  )
  if (body === null || typeof body !== 'object') throw new Error('CoinGecko returned no price object')
  return symbols.map((symbol) => {
    const row = body[COINGECKO_IDS[symbol]]
    const price = num(row?.usd)
    const change = num(row?.usd_24h_change)
    return quote({
      symbol,
      price,
      open: price === undefined || change === undefined ? undefined : price / (1 + change / 100),
      volume24h: num(row?.usd_24h_vol),
      volumeUnit: 'USDT',
    })
  })
}

/**
 * Read a 24-hour hourly close series for OKX's newest candles.
 *
 * OKX answers newest-first and a candle still forming is flagged `confirm === '0'`;
 * that candle is folded in because its close is the current price, which makes the
 * series end exactly where the headline price is. The rows are then sorted by
 * timestamp, because the trend is drawn oldest-to-newest.
 * @param symbol - uppercase bare symbol.
 * @param signal - caller cancellation.
 * @param timeoutMs - per-attempt budget.
 * @param proxy - `config.proxy`.
 * @param log - warning sink.
 * @returns oldest-to-newest closes, or an empty array when OKX answers nothing usable.
 */
async function okxSpark(symbol, signal, timeoutMs, proxy, log) {
  const body = await readJson(
    upstream(`https://www.okx.com/api/v5/market/candles?instId=${okxInstId(symbol)}&bar=1H&limit=24`),
    signal,
    timeoutMs,
    proxy,
    log,
  )
  if (body?.code !== '0' || !Array.isArray(body.data)) return []
  return body.data
    .map((row) => ({ at: num(row[0]), close: num(row[4]) }))
    .filter((entry) => entry.at !== undefined && entry.close !== undefined)
    .sort((left, right) => left.at - right.at)
    .map((entry) => entry.close)
}

/**
 * Read a 24-hour hourly close series from Binance klines.
 * @param symbol - uppercase bare symbol.
 * @param signal - caller cancellation.
 * @param timeoutMs - per-attempt budget.
 * @param proxy - `config.proxy`.
 * @param log - warning sink.
 * @returns oldest-to-newest closes, or an empty array when Binance answers nothing usable.
 */
async function binanceSpark(symbol, signal, timeoutMs, proxy, log) {
  const body = await readJson(
    upstream(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1h&limit=24`),
    signal,
    timeoutMs,
    proxy,
    log,
  )
  if (!Array.isArray(body)) return []
  const closes = body.map((row) => num(row[4])).filter((value) => value !== undefined)
  return closes
}

/**
 * Resolve the Harness home the same way the rest of the product does.
 * @returns absolute Harness home directory.
 */
function harnessHome() {
  const configured = process.env.DSH_HOME
  return configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured
}

/**
 * Persist the browser half's mount heartbeat, merging into any existing document.
 * @param path - heartbeat file path.
 * @param log - warning sink for a failed write or an unreadable document.
 * @returns the recorded heartbeat instant.
 */
function recordClientSeen(path, log) {
  const at = Date.now()
  let state = {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') state = parsed
  } catch (error) {
    // A missing file is the normal first run; anything else is worth reporting and then replaced.
    if (error.code !== 'ENOENT') log.warn(`${LOG_PREFIX} ignoring ${path}: ${String(error.message ?? error)}`)
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ ...state, clientSeenAt: at }, null, 2)}\n`)
  } catch (error) {
    log.warn(`${LOG_PREFIX} cannot write ${path}: ${String(error.message ?? error)}`)
  }
  return at
}

/**
 * Render one JSON response, never cached by the browser or an intermediary.
 * @param payload - serializable body.
 * @param status - HTTP status code.
 * @returns the response handed back to Connection.
 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Turn one operator-supplied symbol into the uppercase bare form the sources expect.
 * @param value - raw entry from `config.symbols`.
 * @returns the normalized symbol, or undefined when the entry is not a plain ticker.
 */
export function normalizeSymbol(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toUpperCase()
  return /^[A-Z0-9]{2,10}$/.test(trimmed) ? trimmed : undefined
}

/**
 * Read and clean the symbol list, falling back to the shipped majors when the
 * configured value yields nothing usable.
 * @param configured - `config.symbols`, if any.
 * @returns a non-empty list of distinct symbols.
 */
function resolveSymbols(configured) {
  const source = Array.isArray(configured) && configured.length > 0
    ? configured
    : DEFAULT_SYMBOLS
  const seen = new Set()
  for (const entry of source) {
    const symbol = normalizeSymbol(entry)
    if (symbol !== undefined) seen.add(symbol)
  }
  return seen.size > 0 ? [...seen] : [...DEFAULT_SYMBOLS]
}

/**
 * Fold one fresh reading into the in-memory trend ring for a symbol.
 *
 * The ring carries the last hour of readings, which is what makes the strip move
 * between the five-minute refreshes of the hourly series.
 * @param ring - mutable per-symbol buffer.
 * @param price - the reading to append.
 * @returns the buffer contents, oldest first.
 */
function pushReading(ring, price) {
  if (price !== undefined && Number.isFinite(price)) ring.push(price)
  while (ring.length > 60) ring.shift()
  return [...ring]
}

/**
 * Join the hourly series with the readings collected since it was read.
 * @param series - hourly closes for the last 24 hours.
 * @param live - readings appended since the series was read.
 * @returns up to 60 points, oldest first.
 */
function trendOf(series, live) {
  return [...series, ...live].slice(-60)
}

/**
 * Register the ticker route for the lifetime of this plugin.
 * @param ctx - plugin context; `connection` is injected above.
 * @param config - Cordis config from the profile patch; absent fields use {@link DEFAULTS}.
 */
export function apply(ctx, config = {}) {
  const log = ctx.logger ?? console
  const symbols = resolveSymbols(config.symbols)
  const settings = {
    upstreamTimeoutMs: config.upstreamTimeoutMs ?? DEFAULTS.upstreamTimeoutMs,
    cacheMs: config.cacheMs ?? DEFAULTS.cacheMs,
    sparklineCacheMs: config.sparklineCacheMs ?? DEFAULTS.sparklineCacheMs,
    /**
     * Seconds between browser polls. Clamped to a sane floor: the Host already
     * serves a cache window, and a sub-second poll would only burn CPU in both
     * halves without showing anything new.
     */
    schedule: Number.isFinite(config.schedule) && config.schedule >= 5
      ? Math.floor(config.schedule)
      : DEFAULTS.schedule,
  }
  /** `config.proxy`: a URL to force, `false` to force direct, unset to auto-detect. */
  const proxy = config.proxy
  const heartbeatPath = join(harnessHome(), HEARTBEAT_FILENAME)

  /** Last good quote per symbol, retained so a total outage still renders a stale price. */
  const lastGood = new Map()
  /** Live readings per symbol, appended on every successful poll. */
  const ring = new Map(symbols.map((symbol) => [symbol, []]))
  /** Hourly series per symbol, re-read on the slow cadence. */
  const series = new Map()
  let cached
  let sparkReadAt = 0

  log.info(`${LOG_PREFIX} watching ${symbols.join(', ')} (sources: ${SOURCES.map((s) => s.label).join(' -> ')})`)

  /**
   * Ask every source in order and return the first complete answer.
   * @param signal - request cancellation.
   * @returns the winning source plus its quotes.
   */
  async function collect(signal) {
    const failures = []
    for (const source of SOURCES) {
      try {
        const quotes = await source.quote(symbols, signal, settings.upstreamTimeoutMs, proxy, log)
        const usable = quotes.filter((entry) => entry.price !== undefined)
        if (usable.length === 0) {
          failures.push(`${source.id}: no usable price`)
          continue
        }
        return { source, quotes, failures }
      } catch (error) {
        if (signal.aborted) throw error
        failures.push(`${source.id}: ${String(error?.message ?? error)}`)
      }
    }
    return { source: undefined, quotes: [], failures }
  }

  /**
   * Refresh the hourly trend series from whichever source is answering.
   * @param signal - request cancellation.
   */
  async function refreshSeries(signal) {
    if (Date.now() - sparkReadAt < settings.sparklineCacheMs) return
    sparkReadAt = Date.now()
    for (const source of SOURCES) {
      if (source.spark === undefined) continue
      try {
        const next = new Map()
        for (const symbol of symbols) {
          next.set(symbol, await source.spark(symbol, signal, settings.upstreamTimeoutMs, proxy, log))
        }
        if ([...next.values()].some((points) => points.length > 1)) {
          for (const [symbol, points] of next) {
            if (points.length <= 1) continue
            series.set(symbol, points)
            // The series already carries the readings collected so far, so the live
            // ring restarts here instead of appending them a second time.
            ring.set(symbol, [])
          }
          return
        }
      } catch (error) {
        if (signal.aborted) throw error
        // A failed series only costs the sparkline, so the headline quote is kept either way.
      }
    }
  }

  /**
   * Build one full payload: head quotes, trend points, and honest source metadata.
   * @param signal - request cancellation.
   * @returns serializable payload for the browser half.
   */
  async function build(signal) {
    const { source, quotes, failures } = await collect(signal)
    if (source !== undefined) {
      for (const entry of quotes) {
        if (entry.price === undefined) continue
        lastGood.set(entry.symbol, entry)
        ring.set(entry.symbol, pushReading(ring.get(entry.symbol) ?? [], entry.price))
      }
      await refreshSeries(signal)
    }

    const degraded = source === undefined
    const rows = symbols.map((symbol) => {
      const fresh = quotes.find((entry) => entry.symbol === symbol)
      const entry = fresh?.price === undefined ? lastGood.get(symbol) : fresh
      return {
        symbol,
        price: entry?.price ?? null,
        changePercent: entry?.changePercent ?? null,
        high: entry?.high ?? null,
        low: entry?.low ?? null,
        volume24h: entry?.volume24h ?? null,
        volumeUnit: entry?.volumeUnit ?? null,
        trend: trendOf(series.get(symbol) ?? [], ring.get(symbol) ?? []),
        stale: fresh?.price === undefined,
      }
    })

    return {
      ok: true,
      degraded,
      source: source?.label ?? null,
      updatedAt: Date.now(),
      symbols: rows,
      failures: failures.slice(-3),
      // 浏览器半侧需要的展示配置：轮询间隔。放这里是为了让它跟着部署走，
      // 不必在客户端 bundle 里再写死一份。
      schedule: settings.schedule,
    }
  }

  ctx.connection.fetch.register({
    path: TICKER_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'POST') {
        return jsonResponse({ ok: true, clientSeenAt: recordClientSeen(heartbeatPath, log) })
      }
      const force = new URL(request.url).searchParams.get('refresh') === '1'
      if (!force && cached !== undefined && Date.now() - cached.at < settings.cacheMs) {
        return jsonResponse(cached.payload)
      }
      try {
        const payload = await build(request.signal)
        // Only a live reading is worth caching; a stale snapshot must be retried next poll.
        if (!payload.degraded) cached = { at: Date.now(), payload }
        return jsonResponse(payload)
      } catch (error) {
        if (request.signal.aborted) return new Response(null, { status: 499 })
        log.warn(`${LOG_PREFIX} ticker query failed: ${String(error?.stack ?? error)}`)
        if (cached !== undefined) return jsonResponse({ ...cached.payload, degraded: true })
        return jsonResponse({ ok: false, error: 'internal', message: String(error?.message ?? error) })
      }
    },
  })
}
