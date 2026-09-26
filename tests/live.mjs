/**
 * 真实网络端到端检查：用真实的 OKX / Binance / CoinGecko 接口跑一遍宿主路由，
 * 确认字段能被正确解析、走势图能取到点。不启动 DSH，也不需要任何凭据。
 *
 * 运行：node tests/live.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = new URL('..', import.meta.url)
const home = mkdtempSync(join(tmpdir(), 'dct-live-'))
process.env.DSH_HOME = home

const host = await import(pathToFileURL(join(HERE.pathname.slice(1), 'index.js')).href)

let route
host.apply({
  logger: { info: (message) => console.log(`  · ${message}`), warn: (message) => console.log(`  ! ${message}`) },
  connection: { fetch: { register: (registered) => { route = registered; return async () => {} } } },
})

console.log('真实上游检查（需要能访问交易所接口）')
const started = Date.now()
const response = await route.fetch(new Request(`http://127.0.0.1${host.TICKER_PATH}?refresh=1`))
const body = await response.json()
console.log(`  HTTP ${response.status}，耗时 ${Date.now() - started} ms`)

if (body.ok !== true) {
  console.log(`  失败：${body.message ?? JSON.stringify(body)}`)
  process.exitCode = 1
} else {
  console.log(`  信源 ${body.source ?? '无'}，降级 ${body.degraded}，失败记录 ${JSON.stringify(body.failures ?? [])}`)
  console.log('')
  console.log('  标的     最新价            24h        24h高        24h低        走势点数')
  for (const row of body.symbols) {
    const pad = (value, width) => String(value ?? '--').padEnd(width)
    console.log('  ' + pad(row.symbol, 8) + pad(row.price, 18) + pad(row.changePercent === null ? '--' : row.changePercent.toFixed(2) + '%', 11) + pad(row.high, 13) + pad(row.low, 13) + pad(row.trend.length, 8))
  }
  const priced = body.symbols.filter((row) => typeof row.price === 'number')
  const trended = body.symbols.filter((row) => row.trend.length > 1)
  console.log('')
  console.log(`  取到价格：${priced.length}/${body.symbols.length}　取到走势：${trended.length}/${body.symbols.length}`)
  if (priced.length === 0) {
    console.log('  所有标的都没有价格——检查本机到交易所的网络。')
    process.exitCode = 1
  }
}

rmSync(home, { recursive: true, force: true })
