window.__ModuleLoader__.load({
	id: "dsh-plugin-crypto-ticker",
	factory: (require) => {
		var exports = {};
		const React = require("react");

		/** 与 index.js 的 TICKER_PATH 保持一致：宿主半侧注册的精确 Fetch 路由。 */
		const ENDPOINT = "/api/crypto.ticker";
		/** 交易所行情变化很快，15 秒轮询；点击表头可立即强制刷新。 */
		const POLL_MS = 15000;
		const STYLE_ID = "dsh-crypto-ticker-style";
		/**
		 * 注册选项里的 order：只决定 ui-slots 生成的 DOM 顺序。取一个很小的值让卡片
		 * 排在已有的占用者（余额等，order 0）**前面**——也就是显示在余额上方。
		 * 真正决定左右/上下位置的是 CSS 里的 `order:-990`，两者保持一致。
		 */
		const SLOT_ORDER = -990;
		/** 迷你走势图的绘制区域，单位 px。 */
		const SPARK_W = 78;
		const SPARK_H = 20;
		/** 价格数值滚动时的变化高亮时长，单位 ms。 */
		const FLASH_MS = 650;

		const CSS = [
			// 外壳。sidebar.footer.action 的容器是 `display:flex`（横向），所以：
			//   flex-basis:100% 让这张卡片在宽栏里独占一整行（配合挂载时给容器加 wrap）；
			//   order:-990 让它排在余额等占用者（order 0）**前面**，也就是显示在余额上方。
			//   必须是 CSS 的 order：注册选项里的 order 只决定 ui-slots 的 DOM 顺序，
			//   不影响 flex 排布。
			".dct-root{display:flex;flex-direction:column;gap:2px;box-sizing:border-box;",
			"flex:1 0 100%;width:100%;min-width:0;order:-990;",
			"padding:6px 0 4px;border-top:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}",
			// 窄栏（56px）：不抢行，各自一个紧凑按钮，order 也回到默认以免把按钮挤走。
			".dct-root.dct-rail{flex:0 0 auto;width:auto;order:0;border-top:0;padding:2px 0;align-items:center}",
			// 表头：标签 + 信源 + 刷新按钮；窄栏模式下整体隐藏。
			".dct-head{display:flex;align-items:center;gap:6px;padding:0 8px 2px;font-size:11px;line-height:16px;",
			"color:var(--dsw-alias-label-tertiary,#8a8a8a);min-height:16px}",
			".dct-title{font-weight:600;letter-spacing:.02em}",
			".dct-source{margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap}",
			".dct-refresh{display:inline-flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px;",
			"padding:0;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer}",
			".dct-refresh:hover{background:var(--dsw-alias-button-floating-hover,rgba(127,127,127,.14));",
			"color:var(--dsw-alias-label-primary,#1a1a1a)}",
			".dct-refresh svg{transition:transform .5s cubic-bezier(.4,0,.2,1)}",
			".dct-refresh.dct-busy svg{transform:rotate(360deg)}",
			// 一行一个标的：字标 / 价格 / 涨跌 / 走势。
			".dct-row{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;",
			"padding:3px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;",
			"text-align:left;cursor:pointer;overflow:hidden}",
			".dct-row:hover{background:var(--dsw-alias-button-floating-hover,rgba(127,127,127,.12))}",
			".dct-sym{display:inline-flex;align-items:center;gap:5px;flex:none;width:34px}",
			".dct-dot{width:5px;height:5px;border-radius:50%;flex:none}",
			".dct-symtext{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#5a5a5a);letter-spacing:.02em}",
			".dct-price{margin-left:auto;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;",
			"color:var(--dsw-alias-label-primary,#1a1a1a);white-space:nowrap;transition:color .2s ease}",
			".dct-price.dct-flash-up{color:var(--dsw-alias-state-error-primary,#e5484d)}",
			".dct-price.dct-flash-down{color:var(--dsw-alias-state-success-primary,#30a46c)}",
			".dct-chg{flex:none;width:46px;text-align:right;font-size:11px;font-weight:600;",
			"font-variant-numeric:tabular-nums;white-space:nowrap}",
			".dct-up{color:var(--dsw-alias-state-error-primary,#e5484d)}",
			".dct-down{color:var(--dsw-alias-state-success-primary,#30a46c)}",
			".dct-flat{color:var(--dsw-alias-label-tertiary,#8a8a8a)}",
			".dct-spark{flex:none;display:block;opacity:.9}",
			// 数据陈旧（全部信源失败）时整块降级成次级色，但保留最后已知价格。
			".dct-stale .dct-price,.dct-stale .dct-symtext{color:var(--dsw-alias-label-tertiary,#8a8a8a)}",
			".dct-stale .dct-spark{opacity:.35}",
			// 窄栏（56px）：字标加价格，仍然能一眼读到数，悬停看完整提示。
			".dct-railrow{display:flex;align-items:center;justify-content:space-between;gap:2px;",
			"width:44px;height:22px;padding:0 3px;box-sizing:border-box;",
			"border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer;overflow:hidden}",
			".dct-railrow:hover{background:var(--dsw-alias-button-floating-hover,rgba(127,127,127,.14))}",
			".dct-railrow .dct-symtext{font-size:9px;width:auto}",
			".dct-railprice{font-size:9px;font-variant-numeric:tabular-nums;",
			"color:var(--dsw-alias-label-secondary,#6f6f6f);white-space:nowrap}",
		].join("");

		/** 浏览器 bundle 只执行一次，这里也保证注入一次样式。 */
		function ensureStyle() {
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		/** 每个标的的品牌色，用于行首圆点；未列出的标的取中性色。 */
		const BRAND = {
			BTC: "#f7931a", ETH: "#627eea", SOL: "#14f195", JUP: "#c7f284",
			BNB: "#f0b90b", XRP: "#23292f", DOGE: "#c2a633",
		};

		/**
		 * 价格格式化：按量级选择小数位，并加千分位。
		 * @param value 后端返回的价格，可能为 null。
		 * @returns 展示用文本，无法解析时为 "--"。
		 */
		function formatPrice(value) {
			const amount = Number(value);
			if (value === null || value === undefined || !Number.isFinite(amount)) return "--";
			const abs = Math.abs(amount);
			const digits = abs >= 1000 ? 0 : abs >= 100 ? 2 : abs >= 1 ? 2 : 4;
			return amount.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
		}

		/**
		 * 涨跌幅格式化：带符号两位小数。
		 * @param value 百分比数值，可能为 null。
		 * @returns 展示用文本，缺失时为 "--"。
		 */
		function formatChange(value) {
			const amount = Number(value);
			if (value === null || value === undefined || !Number.isFinite(amount)) return "--";
			const sign = amount > 0 ? "+" : "";
			return sign + amount.toFixed(2) + "%";
		}

		/**
		 * 成交量缩写：按量级取 K/M/B 后缀。
		 * @param value 成交量，可能为 null。
		 * @param unit 计价单位，如 BTC 或 USDT。
		 * @returns 展示用文本，缺失时为 "--"。
		 */
		function formatVolume(value, unit) {
			const amount = Number(value);
			if (value === null || value === undefined || !Number.isFinite(amount)) return "--";
			const suffix = amount >= 1e9 ? "B" : amount >= 1e6 ? "M" : amount >= 1e3 ? "K" : "";
			const scale = suffix === "B" ? 1e9 : suffix === "M" ? 1e6 : suffix === "K" ? 1e3 : 1;
			return (amount / scale).toFixed(2) + suffix + (unit ? " " + unit : "");
		}

		/** 涨跌方向对应的语义类名：中文习惯红涨绿跌。 */
		function toneClass(value) {
			const amount = Number(value);
			if (!Number.isFinite(amount) || amount === 0) return "dct-flat";
			return amount > 0 ? "dct-up" : "dct-down";
		}

		/**
		 * 本地时间标签。
		 * @param at 毫秒时间戳。
		 * @returns 展示用时间，缺失时为 "从未"。
		 */
		function clock(at) {
			if (typeof at !== "number" || !Number.isFinite(at)) return "从未";
			const d = new Date(at);
			const pad = (v) => String(v).padStart(2, "0");
			return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
		}

		/**
		 * 单行悬停说明：24h 高低、成交量、信源与更新时间。
		 * @param row 该标的的数据行。
		 * @param meta 整份快照的信源与时间信息。
		 * @returns 多行提示文本。
		 */
		function tooltipOf(row, meta) {
			const lines = [`${row.symbol} / USDT　${formatPrice(row.price)}　${formatChange(row.changePercent)}`];
			if (row.high !== null || row.low !== null) {
				lines.push("24h 高 " + formatPrice(row.high) + "　低 " + formatPrice(row.low));
			}
			if (row.volume24h !== null) {
				lines.push("24h 量 " + formatVolume(row.volume24h, row.volumeUnit));
			}
			if (meta.error !== undefined) {
				lines.push("行情不可用：" + meta.error + "　点击重试");
			} else if (meta.degraded) {
				lines.push("全部信源暂时不可用，显示最后已知价格　点击重试");
			} else {
				lines.push("信源 " + (meta.source || "未知") + "　更新于 " + clock(meta.updatedAt) + "　点击刷新");
			}
			return lines.join("\n");
		}

		/**
		 * 24 小时迷你走势图：归一化到 78×20 的折线，端点补一个圆点。
		 * @param props points 收盘价序列；tone 决定颜色；label 无障碍名称。
		 * @returns 内联 SVG，点数不足两个时为 null。
		 */
		function Sparkline(props) {
			const points = props.points;
			if (!Array.isArray(points) || points.length < 2) return null;
			const values = points.filter((v) => Number.isFinite(Number(v))).map(Number);
			if (values.length < 2) return null;
			let min = values[0];
			let max = values[0];
			for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
			const span = max - min;
			const pad = 2;
			const usable = SPARK_H - pad * 2;
			const coords = values.map((v, i) => {
				const x = (i / (values.length - 1)) * SPARK_W;
				// 全平序列画中线，避免除零后贴边。
				const y = span === 0 ? SPARK_H / 2 : pad + usable - ((v - min) / span) * usable;
				return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
			});
			const path = coords.map((c) => c[0] + "," + c[1]).join(" ");
			const end = coords[coords.length - 1];
			const stroke = props.tone === "up"
				? "var(--dsw-alias-state-error-primary,#e5484d)"
				: props.tone === "down"
					? "var(--dsw-alias-state-success-primary,#30a46c)"
					: "var(--dsw-alias-label-tertiary,#8a8a8a)";
			return React.createElement("svg", {
				className: "dct-spark",
				width: SPARK_W,
				height: SPARK_H,
				viewBox: "0 0 " + SPARK_W + " " + SPARK_H,
				role: "img",
				"aria-label": props.label,
			}, [
				React.createElement("polyline", {
					key: "line",
					points: path,
					fill: "none",
					stroke: stroke,
					strokeWidth: 1.25,
					strokeLinecap: "round",
					strokeLinejoin: "round",
				}),
				React.createElement("circle", { key: "end", cx: end[0], cy: end[1], r: 1.6, fill: stroke }),
			]);
		}

		/**
		 * 刷新图标：环形箭头，与 DSH 其它图标保持同一套 1.5px 描边语言。
		 * @returns 内联 SVG 图标元素。
		 */
		function RefreshIcon() {
			return React.createElement("svg", {
				width: 12,
				height: 12,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.5,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
			}, [
				React.createElement("path", { key: "arc", d: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9" }),
				React.createElement("path", { key: "head", d: "M13.5 2.6V6h-3.4" }),
			]);
		}

		/**
		 * 侧边栏左下角的行情卡片；`wide` 为 false 时收缩成只显示币种字标的栏位。
		 * @param props 槽位 owner 传入的列状态（wide）。
		 * @returns 行情卡片元素。
		 */
		function CryptoTicker(props) {
			ensureStyle();
			const wide = !(props !== undefined && props.wide === false);
			const [snapshot, setSnapshot] = React.useState({ phase: "loading" });
			const [tick, setTick] = React.useState(0);
			const [flash, setFlash] = React.useState({});
			/** 上一轮价格，用于判断价格上/下跳并给出对应的颜色脉冲。 */
			const previous = React.useRef({});
			/** 卡片根节点，用来向上找到真正排布它的 flex 容器。 */
			const rootRef = React.useRef(null);
			/**
			 * 当前轮询间隔（ms）。宿主会在每份载荷里带上它配置的 schedule，
			 * 所以这里不写死；用 ref 让取到新值后不必重启定时器。
			 */
			const intervalRef = React.useRef(POLL_MS);

			React.useEffect(() => {
				let alive = true;
				const run = (force) => {
					const url = force ? ENDPOINT + "?refresh=1" : ENDPOINT;
					fetch(url, { headers: { accept: "application/json" } })
						.then((response) => response.ok ? response.json() : Promise.reject(new Error("HTTP " + response.status)))
						.then((body) => {
							if (!alive) return;
							if (body === null || typeof body !== "object" || body.ok !== true) {
								setSnapshot({ phase: "error", message: (body && body.message) || "行情不可用" });
								return;
							}
							const rows = Array.isArray(body.symbols) ? body.symbols : [];
							const nextFlash = {};
							for (const row of rows) {
								const before = previous.current[row.symbol];
								if (typeof before === "number" && typeof row.price === "number" && before !== row.price) {
									nextFlash[row.symbol] = row.price > before ? "up" : "down";
								}
								if (typeof row.price === "number") previous.current[row.symbol] = row.price;
							}
							// 宿主配置的刷新间隔（秒）优先于内置默认值。
							if (typeof body.schedule === "number" && body.schedule >= 5) {
								intervalRef.current = body.schedule * 1000;
							}
							setFlash(nextFlash);
							setSnapshot({
								phase: "ready",
								rows,
								source: body.source,
								updatedAt: body.updatedAt,
								degraded: body.degraded === true,
							});
						})
						.catch((error) => {
							if (!alive) return;
							setSnapshot({ phase: "error", message: String((error && error.message) || error) });
						});
				};
				run(tick > 0);
				// 定时器读 ref，所以 schedule 变了也不必重建。
				const timer = setInterval(() => { run(false) }, intervalRef.current);
				return () => { alive = false; clearInterval(timer) };
			}, [tick]);

			/** 价格脉冲只维持一瞬间，随后回到常规色。 */
			React.useEffect(() => {
				if (snapshot.phase !== "ready") return;
				const timer = setTimeout(() => { setFlash({}) }, FLASH_MS);
				return () => { clearTimeout(timer) };
			}, [snapshot]);

			// 挂载心跳：宿主据此可判断卡片是否真的渲染出来了（界面无法从外部观察）。
			React.useEffect(() => {
				fetch(ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ event: "mounted" }),
				}).catch(() => {});
			}, []);

			/**
			 * 让这张卡片独占一整行。
			 *
			 * 实测（无头浏览器量 computed style）：槽位元素本身是 display:contents、不生成
			 * 盒子，真正排布占用者的是它外面那个 flex 容器；那个容器默认 flex-wrap:nowrap，
			 * 所以在它里面 flex-basis:100% 只被当成初始尺寸，卡片会被压成半行、和余额并排
			 * ——余额在左、行情在右，走势图也挤没了。
			 *
			 * 给容器加上 wrap 是一处很小的布局修补（不改 dsh 的样式表），加完后卡片占满整行、
			 * 余额落到下一行。幂等，所以 HMR 重挂载也不会叠加。
			 */
			React.useEffect(() => {
				const card = rootRef.current;
				if (card === null) return;
				// 中间可能夹着 display:contents 的槽位元素，往上找到第一个真正的 flex 盒子。
				let box = card.parentElement;
				while (box !== null && box !== document.body) {
					const display = window.getComputedStyle(box).display;
					if (display === "flex" || display === "inline-flex") {
						box.style.flexWrap = "wrap";
						return;
					}
					box = box.parentElement;
				}
			}, []);

			const refresh = () => { setTick((value) => value + 1) };
			const ready = snapshot.phase === "ready";
			const stale = snapshot.phase === "error" || (ready && snapshot.degraded);
			const rows = ready ? snapshot.rows : [];
			const meta = ready
				? { source: snapshot.source, updatedAt: snapshot.updatedAt, degraded: snapshot.degraded }
				: { error: snapshot.message || "尚未取到数据" };

			if (!wide) {
				return React.createElement("div", { className: "dct-root dct-rail" },
					(rows.length > 0 ? rows : [{ symbol: "…" }]).map((row) => React.createElement("button", {
						key: row.symbol,
						type: "button",
						className: "dct-railrow" + (stale ? " dct-stale" : ""),
						title: tooltipOf(row, meta),
						"aria-label": row.symbol + " " + formatPrice(row.price),
						onClick: refresh,
					}, [
						React.createElement("span", { key: "sym", className: "dct-symtext" }, row.symbol),
						React.createElement("span", { key: "price", className: "dct-railprice" }, formatPrice(row.price)),
					])));
			}

			const head = React.createElement("div", { key: "head", className: "dct-head" }, [
				React.createElement("span", { key: "t", className: "dct-title" }, "行情"),
				React.createElement("span", { key: "s", className: "dct-source" },
					snapshot.phase === "loading" ? "读取中…" : stale ? "已断开" : (snapshot.source || "")),
				React.createElement("button", {
					key: "r",
					type: "button",
					className: "dct-refresh" + (snapshot.phase === "loading" ? " dct-busy" : ""),
					title: "立即刷新行情",
					"aria-label": "立即刷新行情",
					onClick: refresh,
				}, React.createElement(RefreshIcon, null)),
			]);

			const body = rows.length === 0
				? [React.createElement("div", { key: "empty", className: "dct-head" },
					React.createElement("span", { className: "dct-source" },
						snapshot.phase === "error" ? "行情不可用，点击刷新重试" : "正在读取行情…"))]
				: rows.map((row) => {
					const tone = Number(row.changePercent) > 0 ? "up" : Number(row.changePercent) < 0 ? "down" : "flat";
					return React.createElement("button", {
						key: row.symbol,
						type: "button",
						className: "dct-row" + (stale ? " dct-stale" : ""),
						title: tooltipOf(row, meta),
						onClick: refresh,
					}, [
						React.createElement("span", { key: "sym", className: "dct-sym" }, [
							React.createElement("span", {
								key: "dot",
								className: "dct-dot",
								style: { background: BRAND[row.symbol] || "var(--dsw-alias-label-tertiary,#8a8a8a)" },
							}),
							React.createElement("span", { key: "text", className: "dct-symtext" }, row.symbol),
						]),
						React.createElement("span", {
							key: "price",
							className: "dct-price" + (flash[row.symbol] === "up" ? " dct-flash-up" : flash[row.symbol] === "down" ? " dct-flash-down" : ""),
						}, formatPrice(row.price)),
						React.createElement("span", { key: "chg", className: "dct-chg " + toneClass(row.changePercent) },
							formatChange(row.changePercent)),
						React.createElement(Sparkline, {
							key: "spark",
							points: row.trend,
							tone: tone,
							label: row.symbol + " 24 小时走势",
						}),
					]);
				});

			return React.createElement("div", { className: "dct-root", ref: rootRef }, [head].concat(body));
		}

		/** 侧边栏脚位的注册；声明出现后才会挂载。 */
		const inject = ["slots"];

		/**
		 * 把行情卡片注册进侧边栏左下角的 footer 动作槽位。
		 * @param ctx 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "crypto-ticker",
				order: SLOT_ORDER,
			}, CryptoTicker));
		}

		exports.apply = apply;
		exports.inject = inject;
		return exports;
	}
});
