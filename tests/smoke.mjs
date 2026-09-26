/**
 * 冒烟测试：不启动 DSH，直接验证宿主半侧的路由逻辑与浏览器 bundle 的工厂/注册/渲染。
 * 运行：node tests/smoke.mjs
 *
 * 三个交易所全部被重定向到本进程内的一个本地 HTTP 服务器，所以这里既不需要网络，
 * 也不会触及真实行情；请求仍然走完整的传输层（头部解析、分块解码、超时）。
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = new URL('..', import.meta.url)
const REACT_ROOT = 'D:/deepseek/deepseek-harness/packages/client/ui-brand-official/node_modules'
const requireReact = createRequire(`${REACT_ROOT}/package.json`)
const React = requireReact('react')
const { renderToStaticMarkup } = requireReact('react-dom/server')

const failures = []
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`)
  else { failures.push(name); console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/** 一小时的毫秒数，用来造 K 线时间戳。 */
const HOUR = 3600_000

// ------------------------------------------------------------- 本地上游替身 ----
/** 由每个用例改写：返回一个 `{ status, body }`，或抛出以模拟网络故障。 */
let handler = () => ({ status: 500, body: 'unset' })
let received = []
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  received.push(url.pathname + url.search)
  let result
  try {
    result = handler(url)
  } catch (error) {
    // 模拟连接层故障：直接掐断，让客户端看到网络错误而不是 HTTP 错误。
    response.destroy()
    return
  }
  const payload = typeof result.body === 'string' ? result.body : JSON.stringify(result.body)
  response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(payload)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

// ---- 固定响应数据：OKX 的行情表、OKX 的 K 线、币安的 24hr、币安的 K 线、CoinGecko。
const okxRow = (instId, last, open, high, low) => ({
  instType: 'SPOT', instId, last: String(last), open24h: String(open),
  high24h: String(high), low24h: String(low), volCcy24h: '12345.6789', ts: String(Date.now()),
})
const OKX_TICKERS = {
  code: '0',
  data: [
    okxRow('BTC-USDT', 76360.88, 75750, 77200, 75100),
    okxRow('ETH-USDT', 2450.5, 2500, 2530, 2400),
    okxRow('SOL-USDT', 118.42, 118.42, 120, 115),
    okxRow('JUP-USDT', 0.2638, 0.2326, 0.2667, 0.2316),
  ],
}
/** OKX 返回最新在前的 K 线，且带一根未收盘的当前价，用来验证排序。 */
const okxCandles = (base) => ({
  code: '0',
  data: Array.from({ length: 24 }, (_, i) => [
    String(Date.now() - i * HOUR), String(base), String(base + 10), String(base - 10), String(base + (23 - i)), '1', '1', '1', '1',
  ]),
})
const BINANCE_TICKERS = [
  { symbol: 'BTCUSDT', lastPrice: '70000', priceChangePercent: '1.5', highPrice: '71000', lowPrice: '68000', quoteVolume: '9.9e8' },
  { symbol: 'ETHUSDT', lastPrice: '2000', priceChangePercent: '-2', highPrice: '2100', lowPrice: '1950', quoteVolume: '5e8' },
  { symbol: 'SOLUSDT', lastPrice: '150', priceChangePercent: '3', highPrice: '155', lowPrice: '140', quoteVolume: '2e8' },
  { symbol: 'JUPUSDT', lastPrice: '0.2636', priceChangePercent: '13.52', highPrice: '0.2661', lowPrice: '0.2315', quoteVolume: '6.6e6' },
]
const BINANCE_KLINES = Array.from({ length: 24 }, (_, i) => [0, '1', '1', '1', String(100 + i), '1'])

process.env.DSH_CRYPTO_TICKER_HOSTS = JSON.stringify({
  'www.okx.com': origin,
  'api.binance.com': origin,
  'api.coingecko.com': origin,
})

const home = mkdtempSync(join(tmpdir(), 'dct-smoke-'))
process.env.DSH_HOME = home

// ---------------------------------------------------------------- 宿主半侧 ----
console.log('宿主半侧 (index.js)')
const host = await import(pathToFileURL(join(HERE.pathname.slice(1), 'index.js')).href)
check('导出 apply/inject/name', typeof host.apply === 'function' && Array.isArray(host.inject) && host.name === 'crypto-ticker')
check('inject 需要 connection', host.inject.includes('connection'))
check('路由路径符合 Connection 的段落规则', /^\/api\/[A-Za-z0-9_$.-]+$/.test(host.TICKER_PATH), host.TICKER_PATH)
check('标的归一化拒绝非法输入', host.normalizeSymbol('btc') === 'BTC' && host.normalizeSymbol('$$$') === undefined)
// Cordis 把插件的 Config 当作 Standard Schema 校验；导出一个普通对象会让整个插件树启动失败。
check('不导出非法 Config（普通对象会让插件树启动失败）', host.Config === undefined, typeof host.Config)

/** 用给定配置注册一次路由，并返回该路由与告警记录。 */
function mount(config) {
  let route
  const warnings = []
  const ctx = {
    logger: { info: () => {}, warn: (message) => { warnings.push(String(message)) } },
    connection: { fetch: { register: (registered) => { route = registered; return async () => {} } } },
  }
  host.apply(ctx, config)
  return { route, warnings }
}

const request = (path) => new Request(`http://127.0.0.1${path}`)

// --- OKX 主源：全字段与走势图都从真实 HTTP 响应里读出。
handler = (url) => {
  if (url.pathname === '/api/v5/market/tickers') return { status: 200, body: OKX_TICKERS }
  if (url.pathname === '/api/v5/market/candles') {
    const instId = url.searchParams.get('instId')
    const base = instId === 'BTC-USDT' ? 76000
      : instId === 'ETH-USDT' ? 2400
        : instId === 'SOL-USDT' ? 110
          : 0.25
    return { status: 200, body: okxCandles(base) }
  }
  return { status: 404, body: { error: 'unexpected path' } }
}

const primary = mount({ cacheMs: 0, sparklineCacheMs: 0 })
received = []
const first = await (await primary.route.fetch(request(`${host.TICKER_PATH}?refresh=1`))).json()
check('返回 ok 且未降级', first.ok === true && first.degraded === false, JSON.stringify({ ok: first.ok, degraded: first.degraded }))
check('信源标记为 OKX', first.source === 'OKX', String(first.source))
check('默认显示 BTC/ETH/SOL/JUP', first.symbols.map((row) => row.symbol).join(',') === 'BTC,ETH,SOL,JUP', first.symbols.map((row) => row.symbol).join(','))
const btc = first.symbols[0]
check('价格来自 last 字段', btc.price === 76360.88, String(btc.price))
check('涨跌幅按 open24h 计算', Math.abs(btc.changePercent - ((76360.88 - 75750) / 75750) * 100) < 1e-9, String(btc.changePercent))
check('24h 高低与成交量已带上', btc.high === 77200 && btc.low === 75100 && btc.volume24h === 12345.6789, JSON.stringify(btc))
check('走势图有 24 个小时点', btc.trend.length === 24, String(btc.trend.length))
check('走势图按时间从旧到新', btc.trend[0] === 76000 && btc.trend[23] === 76023, `${btc.trend[0]}..${btc.trend[23]}`)
check('未标记为陈旧', first.symbols.every((row) => row.stale === false))
check('一次轮询共 5 个上游请求（1 行情 + 4 走势）', received.length === 5, JSON.stringify(received))
// JUP 走的是普通 USDT 现货对，验证它确实被解析成价格而不是留空。
const jup = first.symbols[3]
check('JUP 价格与涨跌被解析', jup.symbol === 'JUP' && jup.price === 0.2638 && Math.abs(jup.changePercent - ((0.2638 - 0.2326) / 0.2326) * 100) < 1e-9, JSON.stringify({ symbol: jup.symbol, price: jup.price, chg: jup.changePercent }))
check('JUP 也有走势图', jup.trend.length === 24 && jup.trend[0] === 0.25, `${jup.trend.length} 点，首值 ${jup.trend[0]}`)

// --- 缓存：窗口内的重复轮询复用同一份快照，多个标签页因此不放大上游请求。
handler = (url) => {
  if (url.pathname === '/api/v5/market/tickers') return { status: 200, body: OKX_TICKERS }
  return { status: 200, body: okxCandles(76000) }
}
const cachedHost = mount({ cacheMs: 60000, sparklineCacheMs: 60000 })
received = []
const cachedFirst = await (await cachedHost.route.fetch(request(`${host.TICKER_PATH}?refresh=1`))).json()
const callsAfterFirst = received.length
const cachedSecond = await (await cachedHost.route.fetch(request(host.TICKER_PATH))).json()
check('缓存窗口内复用同一份快照', cachedSecond.updatedAt === cachedFirst.updatedAt)
check('缓存命中时不请求上游', received.length === callsAfterFirst, `${callsAfterFirst} -> ${received.length}`)
const forced = await (await cachedHost.route.fetch(request(`${host.TICKER_PATH}?refresh=1`))).json()
check('显式 refresh 绕过缓存', forced.updatedAt >= cachedFirst.updatedAt && received.length > callsAfterFirst)
check('第二次快照把实时读数并入走势', forced.symbols[0].trend.length > 24, String(forced.symbols[0].trend.length))

// --- Binance 降级：OKX 全线失败时自动接管，并保留同样的字段。
const fallback = mount({ cacheMs: 0, sparklineCacheMs: 0 })
handler = (url) => {
  if (url.pathname.startsWith('/api/v5/')) throw new Error('okx is down')
  if (url.pathname === '/api/v3/ticker/24hr') return { status: 200, body: BINANCE_TICKERS }
  if (url.pathname === '/api/v3/klines') return { status: 200, body: BINANCE_KLINES }
  return { status: 404, body: {} }
}
let binanceQuoteCalls = 0
const counting = fallback.route
const originalFetch = counting.fetch
const second = await (async () => {
  // 只统计行情请求，不关心为每根走势单独发的请求。
  const before = received.filter((entry) => entry.startsWith('/api/v3/ticker/24hr')).length
  const body = await (await originalFetch(request(`${host.TICKER_PATH}?refresh=1`))).json()
  binanceQuoteCalls = received.filter((entry) => entry.startsWith('/api/v3/ticker/24hr')).length - before
  return body
})()
check('OKX 失败时由 Binance 接管', second.source === 'Binance' && second.degraded === false, String(second.source))
check('Binance 一次请求覆盖全部标的', binanceQuoteCalls === 1, String(binanceQuoteCalls))
check('由涨跌幅反推开盘价', Math.abs(second.symbols[0].changePercent - 1.5) < 1e-9, String(second.symbols[0].changePercent))

// --- CoinGecko 末位兜底：两个交易所都不可用时仍然给出价格。
const coingecko = mount({ cacheMs: 0, sparklineCacheMs: 0 })
handler = (url) => {
  if (url.pathname === '/api/v3/simple/price') {
    return {
      status: 200,
      body: {
        bitcoin: { usd: 68000, usd_24h_change: 2, usd_24h_vol: 1e9 },
        ethereum: { usd: 1800, usd_24h_change: -1, usd_24h_vol: 5e8 },
        solana: { usd: 90, usd_24h_change: 0.5, usd_24h_vol: 1e8 },
      },
    }
  }
  throw new Error('exchange down')
}
const thirdSource = await (await coingecko.route.fetch(request(`${host.TICKER_PATH}?refresh=1`))).json()
check('两处交易所失败后由 CoinGecko 兜底', thirdSource.source === 'CoinGecko' && thirdSource.degraded === false, String(thirdSource.source))
check('CoinGecko 的价格被解析', thirdSource.symbols[0].price === 68000, String(thirdSource.symbols[0].price))

// --- 全源失败：保留最后已知价格并标记陈旧，而不是清空。
const outage = mount({ cacheMs: 0, sparklineCacheMs: 0 })
handler = () => { throw new Error('network unreachable') }
const fourth = await (await outage.route.fetch(request(`${host.TICKER_PATH}?refresh=1`))).json()
check('全部信源失败时降级但不报错', fourth.ok === true && fourth.degraded === true, JSON.stringify({ ok: fourth.ok, degraded: fourth.degraded }))
check('降级时信源为空', fourth.source === null)
check('降级时记录失败原因', Array.isArray(fourth.failures) && fourth.failures.length === 3, JSON.stringify(fourth.failures))
check('首次即全失败时价格为 null', fourth.symbols.every((row) => row.price === null && row.stale === true))

// --- 陈旧价格保留：成功一次之后全源失败，仍然给最后已知价格。
const sticky = mount({ cacheMs: 0, sparklineCacheMs: 0 })
handler = (url) => (url.pathname === '/api/v5/market/tickers'
  ? { status: 200, body: OKX_TICKERS }
  : { status: 200, body: okxCandles(76000) })
await sticky.route.fetch(request(`${host.TICKER_PATH}?refresh=1`))
handler = () => { throw new Error('network unreachable') }
const stickyResult = await (await sticky.route.fetch(request(`${host.TICKER_PATH}?refresh=1`))).json()
check('全源失败时保留最后已知价格', stickyResult.symbols[0].price === 76360.88, String(stickyResult.symbols[0].price))
check('同时把这些行标记为陈旧', stickyResult.symbols.every((row) => row.stale === true))

// --- 自定义标的：配置项生效并去重。
const custom = mount({ symbols: ['btc', 'DOGE', 'btc', '###'], cacheMs: 0 })
handler = () => ({ status: 200, body: { code: '0', data: [] } })
const fifth = await (await custom.route.fetch(request(`${host.TICKER_PATH}?refresh=1`))).json()
check('自定义标的去重并归一化', fifth.symbols.map((row) => row.symbol).join(',') === 'BTC,DOGE', fifth.symbols.map((row) => row.symbol).join(','))

// --- 非 2xx 上游响应被当作失败，而不是解析出空数据。
const httpError = mount({ cacheMs: 0, sparklineCacheMs: 0 })
handler = () => ({ status: 429, body: 'rate limited' })
const sixth = await (await httpError.route.fetch(request(`${host.TICKER_PATH}?refresh=1`))).json()
check('上游 429 被识别为失败', sixth.degraded === true && sixth.failures.every((line) => line.includes('429')), JSON.stringify(sixth.failures))

// --- 挂载心跳：宿主看不到界面，这条记录是卡片真的渲染过的唯一外部证据。
handler = () => ({ status: 200, body: OKX_TICKERS })
const beat = await (await primary.route.fetch(new Request(`http://127.0.0.1${host.TICKER_PATH}`, { method: 'POST' }))).json()
check('POST 记录浏览器挂载心跳', beat.ok === true && typeof beat.clientSeenAt === 'number', JSON.stringify(beat))
const heartFile = JSON.parse(readFileSync(join(home, 'crypto-ticker.json'), 'utf8'))
check('心跳已落盘到 DSH_HOME', heartFile.clientSeenAt === beat.clientSeenAt, JSON.stringify(heartFile))
check('声明 GET 与 POST 且请求体为 buffered', primary.route.methods.join(',') === 'GET,POST' && primary.route.requestBody === 'buffered')

// --- 分块传输：OKX 用 chunked 返回大表，解码错误会让 JSON 直接读废。
const chunked = mount({ cacheMs: 0, sparklineCacheMs: 0 })
const chunkedServer = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  const payload = url.pathname === '/api/v5/market/tickers' ? JSON.stringify(OKX_TICKERS) : JSON.stringify(okxCandles(76000))
  response.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' })
  // 故意切成不规则的分块边界，包括把 JSON 从中间劈开。
  for (let at = 0; at < payload.length; at += 97) response.write(payload.slice(at, at + 97))
  response.end()
})
await new Promise((resolve) => chunkedServer.listen(0, '127.0.0.1', resolve))
process.env.DSH_CRYPTO_TICKER_HOSTS = JSON.stringify({
  'www.okx.com': `http://127.0.0.1:${chunkedServer.address().port}`,
})
const chunkedResult = await (await chunked.route.fetch(request(`${host.TICKER_PATH}?refresh=1`))).json()
check('chunked 响应被正确解码', chunkedResult.source === 'OKX' && chunkedResult.symbols[0].price === 76360.88, JSON.stringify({ source: chunkedResult.source, price: chunkedResult.symbols[0].price }))
chunkedServer.close()

// --- 代理：环境变量与显式覆盖的优先级，以及可关闭。
check('HTTPS_PROXY 被识别为代理', host.resolveProxy(new URL('https://a.example/'), undefined) !== undefined || process.env.HTTPS_PROXY === undefined)
process.env.HTTPS_PROXY = 'http://proxy.test:8080'
check('环境变量代理生效', host.resolveProxy(new URL('https://a.example/'), undefined) === 'http://proxy.test:8080')
check('config.proxy 覆盖环境变量', host.resolveProxy(new URL('https://a.example/'), 'http://other:1') === 'http://other:1')
check('config.proxy=false 强制直连', host.resolveProxy(new URL('https://a.example/'), false) === undefined)
delete process.env.HTTPS_PROXY

server.close()

// ------------------------------------------------------------ 浏览器半侧 ----
console.log('浏览器半侧 (client.js)')
const bundle = readFileSync(join(HERE.pathname.slice(1), 'client.js'), 'utf8')
let handoff
globalThis.window = {
  __ModuleLoader__: { load: (registration) => { handoff = registration } },
}
// 工厂在物化时会注入样式；这里给出最小的 document 替身并按 id 去重，
// 让 ensureStyle 的幂等守卫和真实 DOM 一样生效。
const injected = []
globalThis.document = {
  getElementById: (id) => injected.find((element) => element.id === id) ?? null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: (element) => { injected.push(element) } },
}
await import(pathToFileURL(join(HERE.pathname.slice(1), 'client.js')).href)
check('bundle 通过 window.__ModuleLoader__.load 注册', handoff !== undefined && handoff.id === 'dsh-plugin-crypto-ticker', handoff?.id)
check('bundle 提供工厂函数', typeof handoff.factory === 'function')

const exports_ = handoff.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require: ${specifier}`)
})
check('导出 apply/inject', typeof exports_.apply === 'function' && exports_.inject.includes('slots'))

let boundSlot
let registration
const ctx = {
  slots: {
    inject: (name, run) => { boundSlot = { name, run }; return () => {} },
    register: (options, component) => { registration = { options, component }; return () => {} },
  },
}
exports_.apply(ctx)
check('注入 sidebar.footer.action 槽位', boundSlot?.name === 'sidebar.footer.action', String(boundSlot?.name))
boundSlot.run()
check('注册 id 为 crypto-ticker', registration?.options.id === 'crypto-ticker', registration?.options.id)
// 注册选项里的 order 决定 ui-slots 生成的 DOM 顺序；余额（dsh-cost-meter）是 0，
// 取一个很小的值让卡片排在它前面（DOM 顺序靠前）。
check('slot 注册 order 小于余额的 0', typeof registration.options.order === 'number' && registration.options.order < 0, String(registration.options.order))

const wide = renderToStaticMarkup(React.createElement(registration.component, { wide: true }))
check('宽栏渲染出标题', wide.includes('dct-title') && wide.includes('行情'))
check('宽栏渲染出刷新按钮', wide.includes('dct-refresh'))
check('首次渲染显示读取中', wide.includes('正在读取行情'))
check('样式已注入且 id 正确', injected.length === 1 && injected[0].id === 'dsh-crypto-ticker-style', String(injected.length))
check('样式包含涨跌与走势图规则', injected[0].textContent.includes('.dct-up') && injected[0].textContent.includes('.dct-spark'))
// 真正决定 flex 排布的是 CSS 的 order（不是 slot.register 的 order）：
// 取很小的值让卡片落在余额**上方**；窄栏则回到默认，避免把窄栏按钮挤走。
check('宽栏 CSS order 为负（排在余额上方）', /\.dct-root\{[^}]*order:-990/.test(injected[0].textContent), 'missing order:-990')
check('窄栏 CSS order 回到 0', /\.dct-root\.dct-rail\{[^}]*order:0/.test(injected[0].textContent), 'missing rail order:0')
check('宽栏要求独占一行（flex-basis 100%）', /flex:1 0 100%/.test(injected[0].textContent), 'missing flex-basis')

const rail = renderToStaticMarkup(React.createElement(registration.component, { wide: false }))
check('窄栏渲染成栏位形态', rail.includes('dct-rail') && !rail.includes('dct-refresh'))
check('多次渲染只注入一份样式', injected.length === 1, String(injected.length))

// ------------------------------------------------------------------ 结论 ----
rmSync(home, { recursive: true, force: true })
console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
} else {
  console.log(`${failures.length} 项失败：${failures.join(' | ')}`)
  process.exitCode = 1
}
