/**
 * dsh-opencode-free — browser half (hand-written ModuleLoader bundle, no build step).
 *
 * ONE job: the card on this plugin's detail page (the plugins.bundle.config
 * seat, keyed by the package name) that toggles per-model visibility. Each
 * row flips one model id in this plugin's row Config form field
 * `hiddenModels`; the host filters those ids out of the model picker.
 *
 * The model list itself is NOT baked in here: the host owns the catalogue
 * (models.dev + the Zen availability gate + the live availability probe) and
 * serves it, so the rows always match what the picker can actually select. This
 * half reads that snapshot, writes `hiddenModels`, and offers the manual probe
 * that makes the host re-ask every model whether it still answers.
 *
 * Hand-written bundle rules (same shape as dsh-gitbash-shell):
 *   - ONE window.__ModuleLoader__.load({...}) call, id = package name;
 *   - require restricted to the client-module BASELINE whitelist
 *     (react and @deepseek-ai/dsh-client-ui-primitives only);
 *   - plain React.createElement, no JSX/TS; components at module level;
 *   - configForms is acquired lazily: a missing face must not take the card
 *     down with it;
 *   - copy ships zh/en inline (model ids are never translated); the lookup is
 *     live so a language switch repaints without a reload.
 */
window.__ModuleLoader__.load({
	id: "dsh-opencode-free",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var ui = require("@deepseek-ai/dsh-client-ui-primitives");

		var E = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;

		var TAG = "[opencode-free/client]";
		/** Dictionary namespace (this plugin's own t seat). */
		var NS = "opencodeFree";
		/** The settings namespace the HOST half serves (row id = plugin name). */
		var SETTINGS_NAMESPACE = "opencode-free";
		/** The Plugins page bundle-config seat key (package name). */
		var SLOT_KEY = "dsh-opencode-free";

		/**
		 * The host's catalogue endpoints. ABSOLUTE paths on purpose: this card
		 * renders under a client-side route, so a relative specifier would
		 * resolve against the route instead of the server root.
		 */
		var CATALOG_URL = "/dsh-opencode-free/api/catalog";
		var REFRESH_URL = "/dsh-opencode-free/api/refresh";
		var PROBE_URL = "/dsh-opencode-free/api/probe";

		// ── dictionaries (zh/en inline; model ids are never translated) ──────
		//
		// zh and en MUST carry the exact same key set: a key present in only one
		// falls back to the other at lookup time and reads as a half-translated
		// card.

		var zh = {
			"title": "模型显示",
			"cardDesc": "选择在模型选择器中显示的模型",
			"row.visible": "显示",
			"row.hidden": "已隐藏",
			"hint": "隐藏后，该模型不会出现在模型选择器中；重新打开即可恢复。",
			"error": "写入失败",
			"loading": "正在读取模型目录…",
			"loadFailed": "读取模型目录失败，宿主暂时没有回应。",
			"fallback": "当前显示的是内置兜底目录，尚未与 models.dev 同步。",
			"refresh": "立即刷新",
			"refreshing": "刷新中…",
			"probe": "立即探测",
			"probing": "探测中…",
			"probeFailed": "探测请求失败，模型显示保持不变，可重试。",
			"probeCooldown": "刚跑过一轮探测，约 {minutes} 分钟内不会重复请求（每轮都要花共享额度）。",
			"probeCooldownSeconds": "刚跑过一轮探测，约 {seconds} 秒后可再次点击（每轮都要花共享额度）。",
			"probeUntrusted": "本轮有模型没能测到（上游限流、匿名层被拒或网络异常），这些模型的显示保持不变。",
			"probedAt": "上次探测",
			"unknownFree": "另有模型 Zen 正在免费层供应、models.dev 却没有它们的资料：",
			"unknownFreeWhy": "我们不知道它们的上下文长度与能力，也没有验证过它们能否在本插件使用的两条通道上应答，所以不列在选择器里；这不影响下方任何一行。",
			"probing.now": "正在探测",
			"probing.waiting": "等待中",
			"probing.failed": "探测失败",
			"probing.done": "探测完成",
			"probing.ok": "成功",
			"probing.fail": "失败",
			"probing.removed": "本轮下架",
			"probing.unprobed": "本轮未探测",
			"probing.andMore": "等",
			"probing.unmeasured": "未测到",
			"probing.reconfirmed": "复核仍不可用",
			"probing.roundRefused": "本轮没能测到这些模型",
			"probing.notModelFault": "这是上游当时的回应，不是该模型的结论",
			"probing.retryHint": "点「立即探测」可重测",
			"probing.bill": "{requests} 次请求 · {pending} 个待测",
			"reason.dead": "已下架",
			"reason.notlisted": "Zen 未提供",
			"reason.timeout": "探测超时",
			"reason.transport": "连接失败",
			"reason.anongated": "匿名层被拒",
			"reason.quota": "额度用尽",
			"reason.badkey": "key 无效",
			"reason.endpoint": "上游端点不可达",
			"reason.overloaded": "上游过载（稍后重试）",
			"reason.unknown": "无响应",
			"reason.error": "探测异常",
			"advice.anongated": "上游当时拒绝了匿名层请求；挂 key 只能提高额度，不保证解除拒绝",
			"advice.quota": "额度或速率用尽，稍后重试",
			"advice.badkey": "检查 key 是否正确",
			"advice.keyhint": "key 只能提高额度，不能改变模型清单",
			"marker.freetier": "上游回了 FreeTierError（免费层准入被拒）",
			"marker.nosession": "上游回了 MissingSessionID（请求没带上会话标识）",
			"marker.opencodeonly": "上游说这个请求只能由 OpenCode 客户端发出",
			"badge.vision": "视觉",
			"badge.thinking": "思考",
			"badge.tools": "工具",
			"badge.measured": "实测",
			"caps.ctx": "上下文",
			"caps.out": "输出",
			"caps.observed": "实测产出",
			"caps.stated": "路由自述上限",
			"caps.detailDeclared": "models.dev 声明 {value}",
			"cap.sourceRoute": "来源：路由自述 {value}",
			"cap.sourceVendor": "来源：厂商公布 {value}",
			"cap.sourceWitnessed": "来源：目击生成 {value}",
			"cap.sourceInferred": "来源：由夹挤签名推断 {value}",
			"cap.sourceDeclared": "来源：models.dev 声明 {value}",
			"caps.detailStated": "路由自述上限 {value}",
			"caps.detailObserved": "实测产出 ≥{value}",
			"caps.detailTruncated": "真实回答被预算截断 {count} 次",
			"caps.truncated": "被预算截断",
			"caps.truncatedTitle": "真实会话中被 max_tokens 拦腰截断的次数（免费）",
			"caps.firstToken": "首字约 {ms}ms",
			"caps.statedTitle": "上游在拒绝正文里说出的它自己的上限",
			"caps.observedTitle": "本插件实际看这个模型写出过的最长回答",
			"caps.declared": "声明",
			"legend.vision": "多模态视觉",
			"legend.thinking": "思考推理",
			"legend.tools": "工具调用（本插件为每个请求补上 read/bash：免费层只放行带这两个工具的请求）",
			"legend.measured": "已实测（非声明）",
			"legend.verified": "已实测：{list}",
			"empty": "当前没有可显示的模型。"
		};

		var en = {
			"title": "Model visibility",
			"cardDesc": "Choose which models appear in the model picker",
			"row.visible": "Shown",
			"row.hidden": "Hidden",
			"hint": "Hidden models disappear from the model picker; turn them back on to restore.",
			"error": "Write failed",
			"loading": "Loading the model catalogue…",
			"loadFailed": "Could not load the model catalogue — the host did not answer.",
			"fallback": "Showing the built-in fallback catalogue; it is not synced with models.dev yet.",
			"refresh": "Refresh now",
			"refreshing": "Refreshing…",
			"probe": "Probe now",
			"probing": "Probing…",
			"probeFailed": "The probe request failed; visibility is unchanged. You can retry.",
			"probeCooldown": "A round just ran; it will not run again for about {minutes} minutes — each round spends the shared quota.",
			"probeCooldownSeconds": "A round just ran; try again in about {seconds} seconds — each round spends the shared quota.",
			"probeUntrusted": "Some models could not be measured this round (upstream throttling, the anonymous tier refusing, or a network error); those models keep their current visibility.",
			"probedAt": "Last probe",
			"unknownFree": "Models Zen serves on the free tier that models.dev carries no metadata for:",
			"unknownFreeWhy": "their context length and capabilities are not knowable, and we have not verified that they answer on either channel this plugin uses, so they are not offered; this does not affect any row below.",
			"probing.now": "Probing",
			"probing.waiting": "Waiting",
			"probing.failed": "Failed",
			"probing.done": "Probe complete",
			"probing.ok": "OK",
			"probing.fail": "Failed",
			"probing.removed": "Removed this round",
			"probing.unprobed": "Not probed",
			"probing.andMore": "and",
			"probing.unmeasured": "Not measured",
			"probing.reconfirmed": "Re-confirmed gone",
			"probing.roundRefused": "These models could not be measured this round",
			"probing.notModelFault": "that was the upstream's answer at the time, not a verdict on the model",
			"probing.retryHint": "press “Probe now” to retry",
			"probing.bill": "{requests} requests · {pending} still to measure",
			"reason.dead": "Gone",
			"reason.notlisted": "Not offered",
			"reason.timeout": "Timed out",
			"reason.transport": "Connection failed",
			"reason.anongated": "Anon tier refused",
			"reason.quota": "Quota used up",
			"reason.badkey": "Bad key",
			"reason.endpoint": "Upstream endpoint unreachable",
			"reason.overloaded": "Upstream overloaded (retry later)",
			"reason.unknown": "No response",
			"reason.error": "Probe error",
			"advice.anongated": "the upstream refused the anonymous request at the time; a key raises the quota but is not guaranteed to lift the refusal",
			"advice.quota": "quota or rate limit hit — retry later",
			"advice.badkey": "check that the key is correct",
			"advice.keyhint": "a key raises the quota; it does not change the model list",
			"marker.freetier": "upstream answered FreeTierError (free-tier admission refused)",
			"marker.nosession": "upstream answered MissingSessionID (the request carried no session id)",
			"marker.opencodeonly": "upstream says only the OpenCode client may send this",
			"badge.vision": "Vision",
			"badge.thinking": "Thinking",
			"badge.tools": "Tools",
			"badge.measured": "measured",
			"caps.ctx": "context",
			"caps.out": "output",
			"caps.observed": "observed",
			"caps.stated": "route says",
			"caps.detailDeclared": "models.dev declared {value}",
			"cap.sourceRoute": "source: stated by the route ({value})",
			"cap.sourceVendor": "source: published by the vendor ({value})",
			"cap.sourceWitnessed": "source: a generation was watched ({value})",
			"cap.sourceInferred": "source: inferred from a clamp signature ({value})",
			"cap.sourceDeclared": "source: declared by models.dev ({value})",
			"caps.detailStated": "route-stated ceiling {value}",
			"caps.detailObserved": "observed ≥{value}",
			"caps.detailTruncated": "real replies cut off at the budget: {count}",
			"caps.truncated": "cut off",
			"caps.firstToken": "first token ~{ms}ms",
			"caps.truncatedTitle": "times a real reply was cut off at max_tokens (free)",
			"caps.statedTitle": "the ceiling the upstream stated about itself in a refusal",
			"caps.observedTitle": "the longest reply this plugin has watched this model produce",
			"caps.declared": "declared",
			"legend.vision": "Multimodal vision",
			"legend.thinking": "Reasoning",
			"legend.tools": "Tool calls (the plugin adds read/bash to every request — the free tier admits nothing without them)",
			"legend.measured": "measured on the route, not declared",
			"legend.verified": "verified: {list}",
			"empty": "No models are available right now."
		};

		// ── locale resolution (live: read per lookup) ─────────────────────────

		function hasOwnKey(bag, key) {
			return Object.prototype.hasOwnProperty.call(bag, key);
		}

		function dictionaryFor(active) {
			var raw = active === undefined || active === null || active === "" ? "en" : String(active);
			var tag = raw.toLowerCase().replace(/_/g, "-");
			if (tag.split("-")[0] === "zh") return zh;
			return en;
		}

		function activeLocaleOf(ctx) {
			var active = "";
			try {
				var locale = ctx.get("locale");
				if (locale !== undefined && typeof locale.getSnapshot === "function") {
					var snapshot = locale.getSnapshot();
					if (snapshot !== null && typeof snapshot === "object" && typeof snapshot.active === "string") active = snapshot.active;
				}
			} catch (error) { /* fall through to the browser */ }
			if (active === "" && typeof navigator === "object" && navigator !== null && typeof navigator.language === "string") active = navigator.language;
			return active;
		}

		/** `{name}` placeholders, replaced once, from a caller-supplied map. */
		function interpolate(text, params) {
			if (!params) return text;
			return text.replace(/\{([a-zA-Z0-9_]+)\}/g, function (match, name) {
				return hasOwnKey(params, name) ? String(params[name]) : match;
			});
		}

		function translatorOf(ctx) {
			var cachedTag = null;
			var cachedDict = null;
			return function (key, params) {
				var tag = activeLocaleOf(ctx);
				if (tag !== cachedTag) { cachedTag = tag; cachedDict = dictionaryFor(tag); }
				var text = hasOwnKey(cachedDict, key) ? cachedDict[key] : hasOwnKey(en, key) ? en[key] : key;
				return interpolate(text, params);
			};
		}

		// ── styles (opf- prefixed) ────────────────────────────────────────────
		//
		// Apple-card look from the approved mock: literal palette, self-contained
		// white card so it reads the same on any host theme. Class names stay
		// opf- namespaced so they cannot collide with the host page.

		var STYLE_ID = "dsh-opencode-free-style";

		var CSS = [
			".opf-card{display:flex;flex-direction:column;max-width:720px;background:#FFFFFF;border:1px solid rgba(229,229,234,.8);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.06),0 1px 3px rgba(0,0,0,.04);overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;-webkit-font-smoothing:antialiased}",
			".opf-head{padding:28px 28px 20px}",
			".opf-title{font-size:22px;font-weight:600;letter-spacing:-.01em;line-height:1.3;color:#1D1D1F}",
			".opf-desc{margin:4px 0 20px;font-size:13px;line-height:1.5;color:#6B6B72}",
			".opf-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}",
			".opf-actions{display:flex;align-items:center;gap:10px}",
			".opf-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;font-weight:500;padding:6px 14px;border-radius:8px;border:1px solid #E5E5EA;background:#F5F5F7;color:#1D1D1F;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.04);transition:background-color .15s ease-out}",
			".opf-btn:hover{background:#EBEBEF}",
			".opf-btn:active{background:#E2E2E6}",
			".opf-btn[disabled]{opacity:.55;cursor:default}",
			".opf-btn svg{width:14px;height:14px;color:#515154;flex:none}",
			".opf-stamp{display:flex;align-items:center;gap:6px;margin:0;font-size:12px;line-height:1.5;color:#6B6B72}",
			".opf-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#34C759;flex:none}",
			".opf-body{padding:8px 28px}",
			".opf-list{display:flex;flex-direction:column;border:1px solid #E5E5EA;border-radius:12px;overflow:hidden;background:#FFFFFF;box-shadow:0 1px 2px rgba(0,0,0,.02)}",
			".opf-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;font-size:13px;cursor:pointer;color:#1D1D1F}",
			".opf-row+.opf-row{border-top:1px solid rgba(229,229,234,.7)}",
			".opf-row:hover{background:#F9F9FB}",
			".opf-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;padding-right:12px}",
			".opf-id{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:'SF Mono',Monaco,Menlo,Consolas,'Liberation Mono','Courier New',monospace;font-size:13px;font-weight:500;letter-spacing:-.01em;color:#1D1D1F}",
			".opf-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:500;line-height:1.6;white-space:nowrap;user-select:none}",
			".opf-badge svg{width:12px;height:12px;flex:none}",
			".opf-badge-vision{background:rgba(48,176,199,.10);color:#00737F;border:1px solid rgba(48,176,199,.25)}",
			".opf-badge-think{background:rgba(255,69,58,.08);color:#C22C22;border:1px solid rgba(255,69,58,.20)}",
			".opf-badge-think svg{width:10px;height:10px}",
			".opf-badge-tools{background:rgba(88,86,214,.08);color:#4B4ACB;border:1px solid rgba(88,86,214,.20)}",
			/* The measured mark rides on a badge that was verified on the route.
			   It is deliberately a different channel from colour: a teal badge
			   with a dot reads as "this one is not just a claim". */
			".opf-measured::after{content:'✓';margin-left:2px;font-size:10px;opacity:.85}",
			".opf-caps{font-size:11px;color:#6B6B72;white-space:nowrap;font-variant-numeric:tabular-nums}",
			".opf-caps b{font-weight:500;color:#3A3A3F}",
			".opf-caps .opf-declared{text-decoration:line-through;opacity:.75}",
			".opf-limit+.opf-limit{margin-left:10px}",
			".opf-hint-dot{cursor:help;opacity:.55}",
			".opf-hint-dot:hover{opacity:1}",
			".opf-side{display:flex;align-items:center;gap:12px;flex:none}",
			".opf-state{font-size:13px;color:#6B6B72;user-select:none}",
			".opf-state.on{color:#1D1D1F;font-weight:500}",
			".opf-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer;user-select:none}",
			".opf-switch input{position:absolute;opacity:0;width:0;height:0}",
			".opf-track{width:44px;height:26px;background:#E9E9EA;border-radius:9999px;transition:background-color .28s cubic-bezier(.4,0,.2,1);position:relative}",
			".opf-thumb{position:absolute;top:2px;left:2px;width:22px;height:22px;background:#FFFFFF;border-radius:50%;box-shadow:0 1.5px 3px rgba(0,0,0,.15),0 1px 1px rgba(0,0,0,.06);transition:transform .28s cubic-bezier(.4,0,.2,1)}",
			".opf-switch input:checked+.opf-track{background:#34C759}",
			".opf-switch input:checked+.opf-track .opf-thumb{transform:translateX(18px)}",
			".opf-switch input:focus-visible+.opf-track{box-shadow:0 0 0 3px rgba(51,112,255,.45);outline:2px solid transparent}",
			".opf-row:focus-within{background:#F0F5FF}",
			".opf-row:focus-within .opf-id{text-decoration:underline;text-underline-offset:2px}",
			".opf-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 28px 24px}",
			".opf-hint{margin:0;font-size:12px;line-height:1.6;color:#6B6B72}",
			".opf-legend{display:flex;align-items:center;gap:10px;flex:none}",
			".opf-note{margin:0;font-size:12px;line-height:1.6;color:#6B6B72}",
			".opf-error{margin:0;font-size:12px;color:#C22C22}",
			"@keyframes opf-spin{to{transform:rotate(360deg)}}",
			"@keyframes opf-ping{0%{transform:scale(1);opacity:.75}80%,100%{transform:scale(2.4);opacity:0}}",
			".opf-spin{animation:opf-spin 1s linear infinite}",
			".opf-btn-probing{color:#0071E3 !important;background:rgba(0,113,227,.10) !important;border-color:rgba(0,113,227,.30) !important}",
			".opf-btn-probing svg{color:#0071E3 !important}",
			".opf-capsule{display:inline-flex;align-items:center;gap:8px;background:#F5F5F7;border:1px solid #E5E5EA;border-radius:9999px;padding:4px 12px;font-size:12px;box-shadow:0 1px 2px rgba(0,0,0,.04);white-space:nowrap}",
			".opf-pingwrap{position:relative;display:inline-flex;width:8px;height:8px;flex:none}",
			".opf-pingring{position:absolute;display:inline-flex;width:100%;height:100%;border-radius:50%;background:#0071E3;animation:opf-ping 1.4s cubic-bezier(0,0,.2,1) infinite}",
			".opf-pingdot{position:relative;display:inline-flex;width:8px;height:8px;border-radius:50%;background:#0071E3}",
			".opf-capsulelabel{color:#1D1D1F;font-weight:500}",
			".opf-count{font-family:'SF Mono',Monaco,Menlo,Consolas,monospace;font-size:11px;color:#0060C0}",
			".opf-bar{width:56px;height:6px;background:#E5E5EA;border-radius:9999px;overflow:hidden;flex:none}",
			".opf-fill{height:100%;background:#0071E3;border-radius:9999px;transition:width .3s ease-out}",
			".opf-probe{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:9999px;font-size:12px;font-weight:500;line-height:1.6;white-space:nowrap;user-select:none}",
			".opf-probe svg{width:14px;height:14px;flex:none}",
			".opf-probe-ms{font-family:'SF Mono',Monaco,Menlo,Consolas,monospace;font-size:11px}",
			".opf-probe-ok{background:rgba(52,199,89,.10);color:#1B7F32}",
			".opf-probe-fail{background:rgba(255,59,48,.10);color:#C9251B}",
			".opf-probe-busy{background:rgba(0,113,227,.10);color:#0071E3}",
			".opf-probe-wait{background:rgba(229,229,234,.50);color:#6B6B72}",
			".opf-waitdot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#C7C7CC;flex:none}",
			".opf-capsule-done{background:rgba(52,199,89,.10);border-color:rgba(52,199,89,.28)}",
			".opf-capsule-done .opf-capsulelabel{color:#1D1D1F}",
			".opf-capsule-done .opf-pingdot,.opf-capsule-done .opf-pingring{background:#34C759;animation:none;opacity:1}",
			".opf-capsule-mixed{background:rgba(255,149,0,.10);border-color:rgba(255,149,0,.30)}",
			".opf-capsule-mixed .opf-pingdot,.opf-capsule-mixed .opf-pingring{background:#FF9500;animation:none;opacity:1}",
			".opf-capsule-ok{color:#1D1D1F;font-weight:500}",
			".opf-capsule-oknum{font-family:'SF Mono',Monaco,Menlo,Consolas,monospace;font-size:11px;color:#1B7F32}",
			".opf-capsule-badnum{font-family:'SF Mono',Monaco,Menlo,Consolas,monospace;font-size:11px;color:#C9251B}",
			".opf-summaryline{display:flex;align-items:baseline;gap:6px;margin:0;font-size:12px;line-height:1.6;color:#6B6B72}",
			".opf-capsule-gone{color:#8A5200;font-weight:500;padding-left:2px;border-left:1px solid rgba(0,0,0,.08)}",
			".opf-capsule-skip{font-family:'SF Mono',Monaco,Menlo,Consolas,monospace;font-size:11px;color:#6B6B72}",
			".opf-row-probing{background:rgba(0,113,227,.02)}",
			".opf-row-probing:hover{background:rgba(0,113,227,.04)}",
			".opf-row-waiting{opacity:.8}"
		].join("\n");

		function ensureStyles() {
			try {
				if (typeof document === "undefined" || typeof document.getElementById !== "function") return function () {};
				if (document.getElementById(STYLE_ID)) return function () {};
				var style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = CSS;
				document.head.appendChild(style);
				return function () {
					try {
						if (style.parentNode) style.parentNode.removeChild(style);
					} catch (error) { /* best effort */ }
				};
			} catch (error) {
				return function () {};
			}
		}

		/** Defensive primitives lookup: an unknown icon name degrades to null. */
		function icon(name) {
			try {
				var component = ui && ui[name];
				return typeof component === "function" ? component : null;
			} catch (error) {
				return null;
			}
		}

		// ── inline artwork (the mock's own icons, hand-copied) ────────────────
		//
		// The host's icon set has no refresh/magnifier/eye/star that match the
		// approved mock, and the client bundle may only require react plus the
		// ui primitives — so the four glyphs ship here as static SVG. They use
		// currentColor throughout and inherit their size from CSS.

		function svgIcon(paths, strokeWidth) {
			var attrs = strokeWidth === 0
				? { fill: "currentColor", viewBox: "0 0 24 24", "aria-hidden": "true" }
				: {
					fill: "none",
					stroke: "currentColor",
					strokeWidth: strokeWidth,
					viewBox: "0 0 24 24",
					"aria-hidden": "true",
				};
			return E.apply(null, ["svg", attrs].concat(paths.map(function (d) {
				return E("path", {
					key: d.slice(0, 24),
					d: d,
					strokeLinecap: "round",
					strokeLinejoin: "round",
				});
			})));
		}

		var ICON_REFRESH = "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99";
		var ICON_SEARCH = "M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z";
		var ICON_EYE_OUTLINE = "M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z";
		var ICON_EYE_PUPIL = "M15 12a3 3 0 11-6 0 3 3 0 016 0z";
		var ICON_STAR = "M12 2l2.4 6.9 7.1.3-5.5 4.5 1.9 6.9-5.9-4-5.9 4 1.9-6.9-5.5-4.5 7.1-.3L12 2z";
		var ICON_CHECK = "M4.5 12.75l6 6 9-13.5";
		var ICON_CROSS = "M6 18L18 6M6 6l12 12";

		function refreshIcon() { return svgIcon([ICON_REFRESH], 2.2); }
		function searchIcon() { return svgIcon([ICON_SEARCH], 2.2); }
		function eyeIcon() { return svgIcon([ICON_EYE_OUTLINE, ICON_EYE_PUPIL], 2); }
		function starIcon() { return svgIcon([ICON_STAR], 0); }
		function checkIcon() { return svgIcon([ICON_CHECK], 2.4); }
		function crossIcon() { return svgIcon([ICON_CROSS], 2.4); }

		/** Loading spinner from the mock: faint ring plus a solid arc. */
		function spinnerIcon(spinning) {
			return E("svg",
				{
					className: spinning ? "opf-spin" : undefined,
					fill: "none",
					viewBox: "0 0 24 24",
					"aria-hidden": "true",
				},
				E("circle", { cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "3.5", opacity: "0.25" }),
				E("path", {
					d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
					fill: "currentColor",
					opacity: "0.9",
				}));
		}

		/** Display names for thinking levels: "xhigh" reads "XHigh", not "Xhigh". */
		var LEVEL_LABELS = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };

		/** Token counts the way the picker writes them: 1048576 -> "1,048,576". */
		function countLabel(n) {
			if (typeof n !== "number" || !isFinite(n)) return "";
			return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}

		function levelLabel(level) {
			if (typeof level !== "string" || level === "") return "";
			if (Object.prototype.hasOwnProperty.call(LEVEL_LABELS, level)) return LEVEL_LABELS[level];
			return level.charAt(0).toUpperCase() + level.slice(1);
		}

		/** The mock's timestamp: `2026/9/29 23:30:17`, not a locale string. */
		function stampOf(ms) {
			try {
				var d = new Date(ms);
				if (isNaN(d.getTime())) return "";
				var pad = function (n) { return (n < 10 ? "0" : "") + n; };
				return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() +
					" " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
			} catch (error) {
				return "";
			}
		}

		/**
		 * Ids for the blind-spot note: a few names, then a count.
		 *
		 * Deliberately not a full list. These are ids the catalogue has no
		 * record of, so they are the one string here this plugin cannot vouch
		 * for; the note's job is to say the list is short and why, not to
		 * become a second inventory that reads like the first.
		 */
		function unknownIdsText(list) {
			var head = list.slice(0, 3);
			var rest = list.length - head.length;
			return head.join(", ") + (rest > 0 ? " (+" + String(rest) + ")" : "");
		}

		// ── error boundary (the dsh-better-workspace QuietBoundary pattern) ───

		/** A render failure degrades THIS card, never the detail page. */
		function QuietBoundary(props) {}
		QuietBoundary.prototype = Object.create(React.Component.prototype);
		QuietBoundary.prototype.constructor = QuietBoundary;
		QuietBoundary.state = { failed: false };
		QuietBoundary.getDerivedStateFromError = function () { return { failed: true }; };
		QuietBoundary.prototype.componentDidCatch = function (error) {
			console.warn(TAG + " card render failed:", error && error.message ? error.message : error);
		};
		QuietBoundary.prototype.render = function () {
			if (this.state && this.state.failed) return null;
			return this.props.children;
		};

		// ── live locale (repaint the card on a language switch) ───────────────

		function LocaleLive(props) {
			var tickState = useState(0);
			var tick = tickState[0];
			var setTick = tickState[1];
			void tick;

			useEffect(function () {
				var locale = props.ctx && typeof props.ctx.get === "function" ? props.ctx.get("locale") : undefined;
				if (locale === undefined || typeof locale.subscribe !== "function") return undefined;
				var unsubscribe = locale.subscribe(function () { setTick(function (value) { return value + 1; }); });
				return typeof unsubscribe === "function" ? unsubscribe : undefined;
			}, []);

			return E(QuietBoundary, null, E(ModelsCard, Object.assign({}, props.cardProps, { t: props.t })));
		}

		// ── catalogue reads (the host owns the list; this half only reads it) ──

		/**
		 * Normalize one host snapshot. A malformed payload is a RENDERED state
		 * (the card shows a failure line), never an exception: the rows must
		 * not take the detail page down.
		 * @param payload - the endpoint's parsed JSON body.
		 * @returns a snapshot, or null when the body is not usable.
		 */
		function readSnapshot(payload) {
			if (payload === null || typeof payload !== "object") return null;
			var names = function (value) {
				if (!Array.isArray(value)) return [];
				var out = [];
				for (var i = 0; i < value.length; i++) {
					if (typeof value[i] === "string" && value[i] !== "" && out.indexOf(value[i]) === -1) out.push(value[i]);
				}
				return out;
			};
			// Capability cards, one per visible id: `{id, image, thinking}`.
			// A malformed card is dropped, never fatal — the row still renders,
			// just without its badges.
			var cards = {};
			if (Array.isArray(payload.models)) {
				for (var k = 0; k < payload.models.length; k++) {
					var card = payload.models[k];
					if (card === null || typeof card !== "object") continue;
					if (typeof card.id !== "string" || card.id === "") continue;
					/* The numbers and the provenance travel together. The card used
					   to carry two booleans and a level, which is why a stale
					   declaration and a measured one looked identical on screen —
					   the panel had no way to show a number it was not sent. */
					var ev = card.evidence !== null && typeof card.evidence === "object" ? card.evidence : {};
					var stated = card.stated !== null && typeof card.stated === "object" ? card.stated : null;
					var trunc = card.truncated !== null && typeof card.truncated === "object" ? card.truncated : null;
					cards[card.id] = {
						truncated:
							trunc !== null && (typeof trunc.output === "number" || typeof trunc.context === "number")
								? { output: typeof trunc.output === "number" ? trunc.output : 0, context: typeof trunc.context === "number" ? trunc.context : 0 }
								: null,
						stated:
							stated !== null && (typeof stated.output === "number" || typeof stated.context === "number")
								? { output: typeof stated.output === "number" ? stated.output : null, context: typeof stated.context === "number" ? stated.context : null }
								: null,
						image: card.image === true,
						thinking: typeof card.thinking === "string" && card.thinking !== "" ? card.thinking : null,
						contextWindow: typeof card.contextWindow === "number" && isFinite(card.contextWindow) ? card.contextWindow : null,
						outputBudget: typeof card.outputBudget === "number" && isFinite(card.outputBudget) ? card.outputBudget : null,
						observedOutput: typeof card.observedOutput === "number" && isFinite(card.observedOutput) ? card.observedOutput : null,
						declaredContext: typeof card.declaredContext === "number" && isFinite(card.declaredContext) ? card.declaredContext : null,
						declaredOutput: typeof card.declaredOutput === "number" && isFinite(card.declaredOutput) ? card.declaredOutput : null,
						firstTokenMs: typeof card.firstTokenMs === "number" && isFinite(card.firstTokenMs) ? card.firstTokenMs : null,
						evidence: {
							context: typeof ev.context === "string" ? ev.context : "none",
							output: typeof ev.output === "string" ? ev.output : "none",
							vision: typeof ev.vision === "string" ? ev.vision : "none",
							tools: typeof ev.tools === "string" ? ev.tools : "none",
						},
					};
				}
			}
			return {
				visible: names(payload.visible),
				cards: cards,
				source: typeof payload.source === "string" ? payload.source : "unknown",
				/* Probe facts are OPTIONAL: a host older than the probe feature
				   simply omits them, and the card degrades to "never probed"
				   rather than failing to render. */
				probedAt: typeof payload.probedAt === "number" && isFinite(payload.probedAt) ? payload.probedAt : null,
				probeInconclusive: payload.probeInconclusive === true,
				/* Optional too, and for a stronger reason: a host that predates
				   the blind-spot report simply omits it. Nothing here ever
				   becomes a row — these ids are names, not models. */
				unknownFree: names(payload.unknownFree)
				// No `probe` key, and that is deliberate: the host answered the probe
				// POST with the SAME catalogPayload() the GET route uses, and it has
				// never carried progress. The 202 POST exists so a click does not
				// block for minutes; live progress belongs to the GET endpoint
				// alone. Reading a field nobody sends only teaches the next reader
				// that it does.
			};
		}

		// Every request carries a deadline. Without one, a host that accepts the
		// connection and then goes quiet leaves the promise pending forever, so
		// setBusy(false) / setProbing(false) never run and BOTH toolbar buttons stay
		// disabled until the page is reloaded.
		var REQUEST_TIMEOUT_MS = 20000;
		function getJSON(url, options) {
			var merged = Object.assign({}, options);
			if (typeof AbortSignal === "function" && typeof AbortSignal.timeout === "function") {
				merged.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			}
			return fetch(url, merged);
		}

		/** GET the current catalogue. Resolves null on any failure. */
		function loadCatalog() {
			if (typeof fetch !== "function") return Promise.resolve(null);
			try {
				return Promise.resolve(getJSON(CATALOG_URL, { headers: { accept: "application/json" } }))
					.then(function (response) { return response && response.ok ? response.json() : null; })
					.then(readSnapshot)
					.catch(function (error) {
						console.warn(TAG + " catalogue read failed:", error && error.message ? error.message : error);
						return null;
					});
			} catch (error) {
				console.warn(TAG + " catalogue read threw:", error && error.message ? error.message : error);
				return Promise.resolve(null);
			}
		}

		/**
		 * POST a forced refresh (bypasses the host's TTL) and resolve with the
		 * snapshot the host returns, so the card repaints from the answer
		 * rather than re-reading a possibly stale list.
		 */
		function refreshCatalog() {
			if (typeof fetch !== "function") return Promise.resolve(null);
			try {
				return Promise.resolve(getJSON(REFRESH_URL, { method: "POST", headers: { accept: "application/json" } }))
					.then(function (response) { return response && response.ok ? response.json() : null; })
					.then(readSnapshot)
					.catch(function (error) {
						console.warn(TAG + " catalogue refresh failed:", error && error.message ? error.message : error);
						return null;
					});
			} catch (error) {
				console.warn(TAG + " catalogue refresh threw:", error && error.message ? error.message : error);
				return Promise.resolve(null);
			}
		}

		/**
		 * POST a manual probe run (the host asks every catalogue model, in
		 * order, whether it still answers) and resolve with the snapshot it
		 * returns.
		 *
		 * Distinct from refreshCatalog() on purpose: a FAILED probe must not
		 * clobber a perfectly good list, so a null here means "no answer", not
		 * "empty catalogue". The caller keeps what it is showing.
		 */
		function probeCatalog() {
			if (typeof fetch !== "function") return Promise.resolve(null);
			try {
				/* A 429 is not a failure: it is the floor between manual rounds, and
				   it carries how much of it is left. The route used to answer 202 to
				   a click that never started a round, so the card spun out its grace
				   period with nothing to show and no word about why. Resolves
				   { cooldownMs } for that case, a snapshot when the round started, and
				   null for every other non-answer. */
				return Promise.resolve(getJSON(PROBE_URL, { method: "POST", headers: { accept: "application/json" } }))
					.then(function (response) {
						if (response && response.status === 429) {
							return response.json().then(function (body) {
								return { cooldownMs: typeof body.retryAfterMs === "number" ? body.retryAfterMs : 0 };
							}).catch(function () { return { cooldownMs: 0 }; });
						}
						return response && response.ok ? response.json().then(readSnapshot) : null;
					})
					.catch(function (error) {
						console.warn(TAG + " probe failed:", error && error.message ? error.message : error);
						return null;
					});
			} catch (error) {
				console.warn(TAG + " probe threw:", error && error.message ? error.message : error);
				return Promise.resolve(null);
			}
		}

		/**
		 * One progress reading, normalised. Null when the payload is not one.
		 *
		 * Shared by the GET and by the probe POST, which now answers as soon as
		 * the round is accepted and carries its own reading — two copies of this
		 * normaliser would be two places for the `removed`/`marker`/`targets`
		 * traps to reappear in.
		 */
		function readProgress(payload) {
			if (payload === null || typeof payload !== "object") return null;
			return {
				running: payload.running === true,
				total: typeof payload.total === "number" ? payload.total : 0,
				done: typeof payload.done === "number" ? payload.done : 0,
				current: typeof payload.current === "string" ? payload.current : null,
				results: payload.results !== null && typeof payload.results === "object" ? payload.results : {},
				// The round's scope. This normaliser copies field by
				// field, so anything the host starts sending that is
				// not listed here is dropped silently — the same trap
				// `removed` and `marker` walked into. A missing entry
				// leaves `targets` null, which the renderer reads as
				// "older host, assume everything is in scope".
				targets: Array.isArray(payload.targets)
					? payload.targets.filter((id) => typeof id === "string")
					: null,
				startedAt: typeof payload.startedAt === "number" ? payload.startedAt : 0,
				requests: typeof payload.requests === "number" ? payload.requests : 0,
				pending: Array.isArray(payload.pending) ? payload.pending.filter((id) => typeof id === "string") : null,
			};
		}

		function loadProgress() {
			if (typeof fetch !== "function") return Promise.resolve(null);
			try {
				return Promise.resolve(getJSON(PROBE_URL, { method: "GET", headers: { accept: "application/json" } }))
					.then(function (response) { return response && response.ok ? response.json() : null; })
					.then(readProgress)
					.catch(function (error) {
						console.warn(TAG + " probe progress failed:", error && error.message ? error.message : error);
						return null;
					});
			} catch (error) {
				console.warn(TAG + " probe progress threw:", error && error.message ? error.message : error);
				return Promise.resolve(null);
			}
		}

		/**
		 * Human wording for a probe failure. `code` is the machine half the
		 * host sends; the card owns the sentence, so a Chinese diagnostic
		 * never has to ship to an English reader. An unrecognized code falls
		 * back to the plain "failed" rather than a blank badge.
		 */
		var FAILURE_WORDS = {
			"dead": "reason.dead",
			"not-listed": "reason.notlisted",
			"timeout": "reason.timeout",
			"transport": "reason.transport",
			"anon-gated": "reason.anongated",
			"quota-exhausted": "reason.quota",
			"bad-key": "reason.badkey",
			"upstream-overloaded": "reason.overloaded",
			"endpoint-unavailable": "reason.endpoint",
			"unknown": "reason.unknown",
			"error": "reason.error"
		};

		/** Failure codes whose model also leaves the list, so its row — and
		    therefore its badge — cannot be read afterwards. Each needs to be
		    named in the report instead. */
		var GONE_CODES = { "dead": true, "not-listed": true };

		/**
		 * Failure codes that say nothing about the model. The tier refused, the
		 * quota was gone, or the key was rejected — the same answer every
		 * channel would have given. Painting these red on a row reads as "this
		 * model is bad" when the round actually learned nothing about it, which
		 * is exactly how a working model ends up wearing a failure badge.
		 */
		/* Codes that are about the CALLER, not the model. A row wearing one of these
		   is grey, never red: the round learned nothing about that model. The reason
		   is shown INLINE rather than only on hover — three different conditions all
		   render as "未测到", and a reader who cannot tell them apart cannot tell
		   whether to wait, reconfigure, or give up. */
		/* "region-blocked" belongs here, not with the model's own failures: the model is
		   not what is broken, the caller's egress is. Showing it in the model's own
		   colour would say the model is at fault for where you are. */
		var CALLER_CODES = { "anon-gated": true, "quota-exhausted": true, "bad-key": true, "upstream-overloaded": true, "endpoint-unavailable": true, "region-blocked": true };

		function failureText(t, result) {
			var key = typeof result.code === "string" && hasOwnKey(FAILURE_WORDS, result.code)
				? FAILURE_WORDS[result.code]
				: "probing.failed";
			return t(key);
		}

		/**
		 * Whether a gone-code verdict is what took the model out of the list in
		 * THIS round.
		 *
		 * A model already judged dead was removed by an earlier round; re-asking
		 * it and re-confirming the answer changes nothing, and counting that as a
		 * removal reports a change the round never made — the reader is told a
		 * model disappeared just now, when it disappeared hours ago. The
		 * backend says which it was; a result with no `removed` field comes from
		 * a backend that does not, and is read as a removal, which is exactly
		 * what that backend's own panel did.
		 */
		function isFreshRemoval(entry) {
			return GONE_CODES[entry.code] === true && entry.removed !== false;
		}

		/**
		 * Which of the three anonymous-gate markers the upstream body carried.
		 * `anon-gated` folds them together on purpose — none of them is a verdict
		 * about the model — but they are three different upstream conditions, and
		 * a reader who only sees "匿名层被拒" cannot tell an exhausted tier from a
		 * header the request failed to carry. The body is the only place that
		 * fact exists, so the round carries it here.
		 */
		var GATE_MARKERS = {
			"FreeTierError": "marker.freetier",
			"MissingSessionID": "marker.nosession",
			"opencode-only": "marker.opencodeonly"
		};

		/**
		 * The one-line reason under a red badge, in full: word, the HTTP status
		 * when one arrived, which gate marker answered when one did, and — for
		 * the codes that are really a condition of the account rather than the
		 * model — the advice the reader needs.
		 */
		function failureDetail(t, result) {
			var parts = [failureText(t, result)];
			if (typeof result.http === "number" && result.http > 0) parts.push("HTTP " + result.http);
			if (typeof result.marker === "string" && hasOwnKey(GATE_MARKERS, result.marker)) {
				parts.push(t(GATE_MARKERS[result.marker]));
			}
			if (result.code === "anon-gated") parts.push(t("advice.anongated"));
			else if (result.code === "quota-exhausted") parts.push(t("advice.quota"));
			else if (result.code === "bad-key") parts.push(t("advice.badkey"));
			return parts.join(" · ");
		}

		// ── models card (module-level component) ──────────────────────────────

		/**
		 * The detail-page card. t arrives from LocaleLive; scope arrives as a
		 * PLAIN prop from the inject factory. Snapshots are read per render;
		 * each write bumps a local tick so the card re-reads without an
		 * external-store hook adapter.
		 *
		 * `catalog` is tri-state on purpose: undefined = still loading, null =
		 * the host did not answer (the toolbar's refresh doubles as a retry),
		 * object = a snapshot whose `visible` rows are exactly what the picker
		 * can select.
		 */
		function ModelsCard(props) {
			/* The host supplies `t`; the fallback keeps the raw key but honours the
			   same params argument, so a message with a placeholder degrades to a
			   visible key rather than silently dropping the number. */
			var t = typeof props.t === "function" ? props.t : function (key, params) { return interpolate(key, params); };
			var scope = props.scope;

			var tickState = useState(0);
			var tick = tickState[0];
			var bumpTick = tickState[1];
			void tick;

			var errorState = useState("");
			var error = errorState[0];
			var setError = errorState[1];

			var catalogState = useState(undefined);
			var catalog = catalogState[0];
			var setCatalog = catalogState[1];

			var busyState = useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];

			/* The probe keeps its OWN busy flag and its OWN error line: it is a
			   different action from a catalogue refresh, and a failed probe must
			   leave the rendered list exactly as it was. */
			var probingState = useState(false);
			var probing = probingState[0];
			var setProbing = probingState[1];

			var probeErrorState = useState("");
			var probeError = probeErrorState[0];
			var setProbeError = probeErrorState[1];

			/* Live round progress, polled while the probe POST is in flight.
			   Null means "no reading yet" — the pill and the row badges only
			   render once the first poll lands. */
			var progressState = useState(null);
			var progress = progressState[0];
			var setProgress = progressState[1];

			useEffect(function () {
				if (scope === undefined || scope === null || typeof scope.subscribe !== "function") return undefined;
				var unsubscribe = scope.subscribe(function () { bumpTick(function (n) { return n + 1; }); });
				return typeof unsubscribe === "function" ? unsubscribe : undefined;
			}, []);

			useEffect(function () {
				var cancelled = false;
				loadCatalog().then(function (snapshot) { if (!cancelled) setCatalog(snapshot); });
				// Adopt the last round on mount: a finished one is the report
				// the reader has not seen yet, and a live one means a round is
				// running that this card should follow rather than ignore.
				loadProgress().then(function (reading) {
					if (cancelled || reading === null) return;
					adopt(reading);
				});
				return function () { cancelled = true; pollRef.current.active = false; stopPolling(); };
			}, []);

			function refresh() {
				if (busy) return;
				setBusy(true);
				refreshCatalog().then(function (snapshot) {
					setCatalog(snapshot);
					setBusy(false);
				});
			}

			/* A null answer means the host did not answer, NOT an empty
			   catalogue: keep the rows on screen and offer the retry.
			   While the POST is in flight the progress endpoint is polled, so
			   the pill and the per-row badges track the round live. When the
			   POST answers, polling stops but the LAST reading is kept: the
			   finished round's tally and per-row reasons stay on screen (with
			   the capability badges back beside them) until the next round
			   replaces them. Wiping the reading here is what made a finished
			   probe look like nothing ever happened. */
			var PROGRESS_POLL_MS = 800;
			/* How long a requested round may stay unpublished before the card stops
			   believing it. The gate is one cheap GET; anything past this is a backend
			   that is not going to start, and holding the poll open on it would leave
			   the button busy for ever. */
			var AWAIT_GRACE_MS = 30_000;
			var pollRef = React.useRef({
				timer: null,
				active: false,
				awaiting: false,
				since: 0,
				/* The most recent reading adopted, and the `startedAt` of the round that
					   was on screen when a round was REQUESTED. Every round is stamped, so
					   the second is what separates "the round I asked for is not out yet"
					   from "it just finished". */
				last: null,
				saw: null,
			});
			/* Whether the card is following a round, as a mutable flag rather
			   than the `probing` state. The poll timer outlives the render that
			   created it, and that render's `probing` is still the value from
			   BEFORE the click — so guarding on it killed the chain after one
			   tick and the live progress never appeared, leaving only the final
			   report the POST reads back. Same lesson as pollTimer: the timer
			   must not close over render state. */
			// Read through the ref, never the render-scope copy. See pollRef.
			/* A manual round is in flight and the poll chain is responsible for
			   closing it. Separate from `pollActive` because a pre-round reading
			   (`running: false` before the round has started) must not be read as
			   its end. */
			// Read through the ref, never the render-scope copy. See pollRef.

			function stopPolling() {
				var timer = pollRef.current.timer;
			if (timer !== null && typeof clearTimeout === "function") {
					try { clearTimeout(timer); } catch (error_) { /* best effort */ }
				}
				pollRef.current.timer = null;
			}

			function startPolling(reading) {
				if (reading !== null) setProgress(reading);
				if (typeof setTimeout !== "function") return;
				stopPolling();
				pollRef.current.timer = setTimeout(function () {
					pollRef.current.timer = null;
					if (!pollRef.current.active) return;
					loadProgress().then(function (next) {
						/* A real reading goes through `adopt`, which is what
						   decides whether the round is over. Routing it back to
						   `startPolling` instead would keep the pill moving but
						   never let anything see the end — the chain would poll a
						   finished round forever and the busy button would outlive
						   it. A FAILED read is not a reading, so it re-arms and
						   tries again rather than ending the chain. */
						if (next === null) {
							startPolling(null);
							return;
						}
						adopt(next);
					});
				}, PROGRESS_POLL_MS);
			}

			/* Adopt a reading: a live one starts/keeps the poll, a finished one
			   is retained as the resting report. `running: false` with results
			   is a completed round, not an absence of one.

			   The finished branch is also where a MANUAL round closes, because
			   the POST no longer waits for it — it answers while the round is
			   still starting, so the poll chain is the only thing that can
			   observe the end. Without this the busy button would outlive the
			   round and the card would keep showing the previous verdict. */
			function adopt(reading) {
				if (reading === null) return;
				pollRef.current.last = reading;
				setProgress(reading);
				if (reading.running === true) {
					pollRef.current.active = true;
					startPolling(reading);
					return;
				}
				// Whether this card was WATCHING this round, or is only looking
				// at a report that was already on disk when the page opened.
				var followed = pollRef.current.active;
				/* A finished reading while we are STILL waiting for the round this
					   card asked for is not that round finishing. The backend publishes
					   `running: true` only after the Zen catalogue gate answers, and that
					   gate costs one cheap GET — so a round slower than the poll interval
					   hands us the PREVIOUS round's report, which reads as complete.
					   Consuming `awaiting` there ended the chain one tick early: the
					   button came back, the panel settled, and the round that really did
					   start was never seen. Keep waiting — bounded, so
					   a backend that never starts the round cannot hold the poll open. */
				if (
					pollRef.current.awaiting &&
					/* `startedAt` is what says whether this finished report IS the round
						   asked for. A finished reading whose stamp still matches the one on
						   screen when the button was pressed is the PREVIOUS round — ours has
						   not been published yet. Without an identity the two are
						   indistinguishable, and consuming `awaiting` on the earlier one is
						   what ended the chain a tick early. */
					/* `saw === null` means NOTHING was on screen when the button was
					   pressed — the first read never landed — so there is no identity
					   to compare against and nothing can be ruled out. That is an
					   argument for keeping waiting, not for concluding the round is
					   over: a finished reading whose stamp is a number can never
					   equal null, so the test below would fail on every reading and
					   hand the reader back a button for a round that is still
					   running. */
					(pollRef.current.saw === null || reading.startedAt === pollRef.current.saw) &&
					Date.now() - pollRef.current.since < AWAIT_GRACE_MS
				) {
					/* `null`, deliberately: re-arming with the previous round's report
						   would paint a finished report under a busy button, which is the
						   confusion this branch exists to avoid. The click already cleared the
						   progress area; the real reading repaints it when it arrives. */
					startPolling(null);
					return;
				}
				pollRef.current.active = false;
				stopPolling();
				if (pollRef.current.awaiting) {
					pollRef.current.awaiting = false;
					setProbing(false);
				}
				if (!followed) return;
				// Either kind of round this card WATCHED may have removed a
				// model, and either kind leaves the rest of the card stale —
				// the last probed time, the inconclusive notice. The automatic
				// round reloaded only when a click had awaited it, so a card
				// left open across one kept a 1970 timestamp and stale
				// wording until it was reopened. `followed`
				// is what separates "this round finished while I was
				// watching" from "this report was already on disk" — the
				// latter must not spend a request on every page open.
				loadCatalog().then(function (next) {
					if (next !== null) setCatalog(next);
				});
			}

			function probe() {
				if (probing) return;
				setProbeError("");
				setProbing(true);
				// Clear the previous round's report: this one replaces it.
				setProgress(null);
				pollRef.current.active = true;
				pollRef.current.awaiting = true;
				pollRef.current.since = Date.now();
				pollRef.current.saw =
					pollRef.current.last === null ? null : pollRef.current.last.startedAt;
				loadProgress().then(function (reading) {
					/* A NULL reading is not "nothing to show", it is "nothing to
					   identify against". The route answers nothing at all in the
					   window right after a restart, so `last` stays null and this
					   branch used to `adopt(null)` and return — which armed NO poll
					   chain at all. The POST only answers when the round is OVER
					   (29s measured), so the card sat busy with nothing watching:
					   a button that blinked once and then nothing. Arm the poll;
					   `adopt()` applies the grace to whatever cannot be ruled out. */
					if (reading === null) {
						if (pollRef.current.awaiting) startPolling(null);
						return;
					}
					/* A reading can already be finished — the round may not have
					   started yet when this first poll lands, and the host answers
					   `running: false` until it does. That is the PRE-round state,
					   not a completed round, so it must not be read as the end of
					   this one. The POST returning successfully is what confirms the
					   round exists; until then the poll simply keeps going. */
					if (reading.running === true) {
						adopt(reading);
						return;
					}
					if (pollRef.current.awaiting) {
						pollRef.current.active = true;
						/* The same identity test `adopt()` makes. A finished reading that
							   still carries the stamp of the round that was on screen when
							   the button was pressed is the PREVIOUS one: ours has not been
							   published yet, and repainting it would present that round's
							   report as this one's result. */
						if (reading.startedAt === pollRef.current.saw) startPolling(null);
						else adopt(reading);
					} else {
						adopt(reading);
					}
				});
				/* The POST answers as soon as the round is ACCEPTED, so it is no
				   longer the signal that the round ended — `adopt()` is. Stopping
				   on the POST instead would cut the chain one tick after the click
				   and freeze the progress area mid-round, which is the exact bug
				   the note above `pollActive` records. */
				probeCatalog().then(function (snapshot) {
					if (snapshot !== null && typeof snapshot.cooldownMs === "number") {
						/* The round was refused, not started. Say so with the number,
						   and leave the panel exactly as it was. */
						pollRef.current.awaiting = false;
						pollRef.current.active = false;
						stopPolling();
						/* Under a minute left must not be rounded UP into the next
						   minute: 60.7s said "about 2 minutes" and the reader
						   waited out a minute for a button that still refused. */
						setProbeError(
							snapshot.cooldownMs < 60000
								? t("probeCooldownSeconds", { seconds: Math.max(1, Math.round(snapshot.cooldownMs / 1000)) })
								: t("probeCooldown", { minutes: Math.ceil(snapshot.cooldownMs / 60000) }),
						);
						setProbing(false);
						return;
					}
					if (snapshot !== null) setCatalog(snapshot);
					else {
						/* The round may still be running, so the poll is left alone
						   and the busy state stands. Only a start that never took
						   can be called a failure. */
						if (pollRef.current.active) return;
						pollRef.current.awaiting = false;
						stopPolling();
						setProbeError(t("probeFailed"));
						setProbing(false);
					}
				});
			}

			var snap = { status: "unavailable" };
			try {
				if (scope && typeof scope.getSnapshot === "function") snap = scope.getSnapshot();
			} catch (error_) { /* keep unavailable */ }

			if (snap.status !== "ready") return null;

			var value = snap.value || {};
			var stored = Array.isArray(value.hiddenModels) ? value.hiddenModels : [];
			var hidden = {};
			for (var i = 0; i < stored.length; i++) {
				if (typeof stored[i] === "string" && stored[i] !== "") hidden[stored[i]] = true;
			}

			function writeHidden(next) {
				setError("");
				if (!scope || typeof scope.set !== "function") {
					setError(t("error"));
					return Promise.resolve(false);
				}
				try {
					return Promise.resolve(scope.set("hiddenModels", next)).then(
						function (accepted) {
							bumpTick(function (n) { return n + 1; });
							if (accepted !== true) setError(t("error"));
							return accepted === true;
						},
						function (err) {
							bumpTick(function (n) { return n + 1; });
							setError(t("error") + ": " + (err && err.message ? err.message : String(err)));
							return false;
						}
					);
				} catch (err) {
					bumpTick(function (n) { return n + 1; });
					setError(t("error") + ": " + (err && err.message ? err.message : String(err)));
					return Promise.resolve(false);
				}
			}

			/* Read-modify-write on the FRESH snapshot: unknown/stale ids ride
			   along untouched, so a model that returns stays hidden. */
			function toggle(id) {
				var fresh = { status: "unavailable" };
				try {
					if (scope && typeof scope.getSnapshot === "function") fresh = scope.getSnapshot();
				} catch (error_) { /* fall through to the rendered snapshot */ }
				var base = (fresh.status === "ready" && fresh.value && Array.isArray(fresh.value.hiddenModels))
					? fresh.value.hiddenModels
					: stored;
				var seen = {};
				var next = [];
				for (var k = 0; k < base.length; k++) {
					var entry = typeof base[k] === "string" ? base[k].trim() : "";
					if (entry === "" || entry === id || hasOwnKey(seen, entry)) continue;
					seen[entry] = true;
					next.push(entry);
				}
				if (!hasOwnKey(hidden, id)) {
					next.push(id);
					seen[id] = true;
				}
				return writeHidden(next);
			}

			var Chevron = icon("IconChevronDownOutline14");
			void Chevron;

			var visible = catalog !== undefined && catalog !== null ? catalog.visible : [];
			var cards = catalog !== undefined && catalog !== null && catalog.cards !== undefined ? catalog.cards : {};

			/* One row per visible id. At rest: mono id, capability badges, status
			   word, iOS-style switch. While a round is running, the capability
			   badges step aside for the probe badge — green "✓ 142ms", red
			   "探测失败", blue spinner "探测中...", grey "等待中" — and the
			   active row highlights while queued rows dim, per the approved
			   mock. Badge data comes from the host's `models` array; a row
			   whose card is missing renders bare rather than failing — the
			   toggle is the contract, badges are decoration. */
			/* A reading is LIVE while a round runs and RETAINED once it has.
			   Either way the per-row outcome rides on the row. The capability
			   badges stay on screen throughout: a round used to take them away
			   and hand them back at the end, so every row lost its identity
			   exactly while the reader was waiting to find out what it was —
			   and the row came back looking different for reasons that had
			   nothing to do with the model. The probe badge is additive, so
			   nothing competes for space. `live` additionally means: animate,
			   highlight the in-flight row, dim the queue. */
			var hasReading = progress !== null && progress.total > 0;
			var live = progress !== null && progress.running === true;
			var liveResults = hasReading ? progress.results : {};
			var liveCurrent = live ? progress.current : null;
			/* The round's own scope. A round asks only about the models the
			   user has switched ON, so "no result yet" is two different things:
			   queued, or never in this round. Only the server knows which — the
			   panel used to call every untouched row "waiting", which promises
			   the round will reach a model it never intended to ask about. */
			var liveTargets = hasReading && Array.isArray(progress.targets) ? progress.targets : null;

			/* Shown models first, then the hidden ones — each group keeping the
			   order the catalogue already gave them, which is alphabetical
			   (see catalog.ts `byId`). Partitioning rather than sorting again
			   keeps one owner for the order: the list arrives sorted, and the
			   card only decides what comes first. A user reading this panel is
			   looking for "what can I use", so what they can use leads. */
			var ordered = visible.filter(function (id) { return !hasOwnKey(hidden, id); })
				.concat(visible.filter(function (id) { return hasOwnKey(hidden, id); }));
			var rows = ordered.map(function (id) {
				var shown = !hasOwnKey(hidden, id);
				var card = hasOwnKey(cards, id) ? cards[id] : null;
				/* What was VERIFIED about this model, on the name itself.
				   The tool badge used to sit here and it was removed: 9 of 12 rows
				   carried it, none ever lacked it, and a mark that is on every row
				   tells the reader nothing they would not have assumed. The
				   measurement stays — it is what would put the badge back — and it
				   lives on the model name now, which is the one element that means
				   "this model" rather than "this number". */
				var verified = [];
				if (card !== null) {
					if (card.evidence.tools === "route") verified.push(t("badge.tools"));
					if (card.evidence.vision === "route" && card.image === true) verified.push(t("badge.vision"));
				}
				var left = [
					E("span", {
						key: "id",
						className: "opf-id",
						title: verified.length === 0 ? undefined : t("legend.verified", { list: verified.join(" · ") }),
					}, id),
				];
				var rowClass = "opf-row";
				/* Capability badges describe the model and are always on
				   screen; the probe badge describes THIS round and sits after
				   them, because it is the thing the reader just asked for. */
				{
					/* A badge carries the measured mark when the ROUTE was asked
					   and agreed. Without it a declared badge and a verified one
					   are the same object on screen, which is the whole reason
					   this row could not be trusted before. */
					var measuredClass = function (on) { return on ? " opf-measured" : ""; };
					if (card !== null && card.image === true) {
						left.push(E("span", {
							key: "vision",
							className: "opf-badge opf-badge-vision" + measuredClass(card.evidence.vision === "route"),
							title: card.evidence.vision === "route" ? t("legend.measured") : t("caps.declared")
						}, eyeIcon(), E("span", null, t("badge.vision"))));
					}
					if (card !== null && card.thinking !== null) {
						left.push(E("span", { key: "think", className: "opf-badge opf-badge-think" },
							starIcon(),
							E("span", null, t("badge.thinking") + " · " + levelLabel(card.thinking))));
					}
					/* The two numbers the request path uses, and ONLY the effective
					   values. Provenance moved into the tooltip.

					   This line used to read `输出预算 131,072 → 262,144` plus two more
					   numbers on the same line, and the reader asked what the current
					   maximum output was — a line that shows four figures and two
					   arrows cannot answer that at a glance, however true each figure
					   is. The effective value is what the request carries, so it is what
					   the line says; where it came from, and what the model has actually
					   been seen writing, are one hover away. */
					if (card !== null && (card.contextWindow !== null || card.outputBudget !== null)) {
												/* Where each number comes from, NAMED. "已实测" used to cover four
							different things — a limit the route stated, a figure a vendor
							published, a reply somebody watched finish, and a raise inferred
							from a clamp — and the panel could not tell them apart. The number
							never changes; the word does. */
						var SOURCE_WORDS = {
							route: "cap.sourceRoute",
							vendor: "cap.sourceVendor",
							witnessed: "cap.sourceWitnessed",
							inferred: "cap.sourceInferred",
							declared: "cap.sourceDeclared",
						};
						var detail = function (shown, declared, evidence) {
							var lines = [t(SOURCE_WORDS[evidence] ?? "cap.sourceDeclared", { value: countLabel(shown) })];
							if (declared !== null && declared !== shown) {
								lines.push(t("caps.detailDeclared", { value: countLabel(declared) }));
							}
							return lines.join("\n");
						};
						var parts2 = [];
						if (card.contextWindow !== null) {
							parts2.push(E("span", { key: "ctx", className: "opf-limit", title: detail(card.contextWindow, card.declaredContext, card.evidence.context) },
								t("caps.ctx") + " ", E("b", null, countLabel(card.contextWindow)),
								card.evidence.context !== "declared"
									? E("span", { key: "ctxt", className: "opf-hint-dot" }, " ⓘ")
									: null));
						}
						if (card.outputBudget !== null) {
							/* Everything known about the output number, in one place:
							   what the publisher declared, what the route says it will
							   take, what the model has been watched writing, and how
							   often a real reply has been cut off. They were four items on
							   the row; they are one sentence in a tooltip. */
							var lines2 = detail(card.outputBudget, card.declaredOutput, card.evidence.output);
							if (card.stated !== null && card.stated.output !== null) {
								lines2 += (lines2 === "" ? "" : "\n") + t("caps.detailStated", { value: countLabel(card.stated.output) });
							}
							if (card.observedOutput !== null) {
								lines2 += (lines2 === "" ? "" : "\n") + t("caps.detailObserved", { value: countLabel(card.observedOutput) });
							}
							if (card.truncated !== null) {
								lines2 += (lines2 === "" ? "" : "\n") + t("caps.detailTruncated", { count: String(card.truncated.output + card.truncated.context) });
							}
							parts2.push(E("span", { key: "out", className: "opf-limit", title: lines2 },
								t("caps.out") + " ", E("b", null, countLabel(card.outputBudget))));
						}
						left.push(E("span", { key: "limits", className: "opf-caps" }, parts2));
					}
				}
				if (hasReading) {
					var verdict = hasOwnKey(liveResults, id) ? liveResults[id] : null;
					var covered = liveTargets === null || liveTargets.indexOf(id) !== -1;
					var status = verdict !== null && verdict.status === "ok" ? "ok"
						: verdict !== null ? "failed"
						: !covered ? "skipped"
						: live ? (id === liveCurrent ? "probing" : "waiting")
						: "unprobed";
					if (status === "ok") {
						var ms = typeof verdict.ms === "number" && isFinite(verdict.ms) ? Math.max(0, Math.round(verdict.ms)) : null;
						// Total latency alone cannot tell a model that is slow to
						// START from one that simply writes a lot, and those feel
						// completely different to wait for.
						var ftft = card !== null && card.firstTokenMs !== null
							? t("caps.firstToken", { ms: String(card.firstTokenMs) })
							: "";
						left.push(E("span", {
							key: "probe",
							className: "opf-probe opf-probe-ok",
							title: ftft === "" ? undefined : ftft
						},
							checkIcon(),
							E("span", { className: "opf-probe-ms" }, ms === null ? "" : ms + "ms"),
							ftft === "" ? null : E("span", { key: "ftft", className: "opf-probe-ms" }, " · " + ftft)));
					} else if (status === "failed") {
						if (CALLER_CODES[verdict.code] === true) {
							/* Grey, never red: the round learned nothing about
							   this model, so the row must not wear a failure.
							   The reason and the "not about the model" banner
							   below carry the story instead. */
							left.push(E("span", {
								key: "probe",
								className: "opf-probe opf-probe-wait",
								title: failureDetail(t, verdict)
							}, E("span", { className: "opf-waitdot" }),
								E("span", null, t("probing.unmeasured")),
								E("span", null, " · " + failureText(t, verdict))));
						} else {
							/* Red, but never mute: the badge names the reason and
							   the full story (status + what to do about it) rides
							   along as the tooltip, because a red dot that says
							   only "failed" is not a report. */
							left.push(E("span", {
								key: "probe",
								className: "opf-probe opf-probe-fail",
								title: failureDetail(t, verdict)
							}, crossIcon(), E("span", null, failureText(t, verdict))));
						}
					} else if (status === "probing") {
						rowClass += " opf-row-probing";
						left.push(E("span", { key: "probe", className: "opf-probe opf-probe-busy" },
							spinnerIcon(true),
							E("span", null, t("probing"))));
					} else if (status === "waiting") {
						rowClass += " opf-row-waiting";
						left.push(E("span", { key: "probe", className: "opf-probe opf-probe-wait" },
							E("span", { className: "opf-waitdot" }),
							E("span", null, t("probing.waiting"))));
					} else if (status === "skipped") {
						/* Outside the round's scope — the user has this model
						   switched off, so no request was spent on it and none
						   will be. It wears no probe badge at all: a row that
						   says nothing is the honest report, where "waiting"
						   would promise a round that will never reach it. */
					} else {
						/* In scope, but the round finished without asking — it was
						   already dead, or it arrived mid-round. Saying so
						   beats a row that quietly shows nothing. */
						left.push(E("span", { key: "probe", className: "opf-probe opf-probe-wait" },
							E("span", { className: "opf-waitdot" }),
							E("span", null, t("probing.unprobed"))));
					}
				}
				return E("label",
					{ key: id, className: rowClass },
					E("span", { className: "opf-main" }, left),
					E("span", { className: "opf-side" },
						E("span", { className: "opf-state" + (shown ? " on" : "") }, shown ? t("row.visible") : t("row.hidden")),
						E("span", { className: "opf-switch" },
							E("input", {
								type: "checkbox",
								checked: shown,
								onChange: function () { toggle(id); }
							}),
							E("span", { className: "opf-track" },
								E("span", { className: "opf-thumb" })))));
			});

			/* The list area has three honest states; none of them pretends the
			   catalogue is empty when it is merely unknown. */
			var listArea;
			if (catalog === undefined) {
				listArea = E("p", { className: "opf-note" }, t("loading"));
			} else if (catalog === null) {
				listArea = E("p", { className: "opf-error" }, t("loadFailed"));
			} else if (rows.length === 0) {
				listArea = E("p", { className: "opf-note" }, t("empty"));
			} else {
				listArea = E("div", { className: "opf-list" }, rows);
			}

			var fallbackNote = catalog !== undefined && catalog !== null && catalog.source === "builtin-fallback"
				? E("p", { className: "opf-note" }, t("fallback"))
				: null;

			/* Probe facts, each rendered only when the host actually reported
			   one. An older host omits them, and then none of this shows. The
			   timestamp sits top-right of the toolbar with a green dot, per
			   the approved mock — not in the body flow. */
			var untrustedNote = catalog !== undefined && catalog !== null && catalog.probeInconclusive === true
				? E("p", { className: "opf-note" }, t("probeUntrusted"))
				: null;

			/* The blind spot, when there is one. Names only, and never a row:
			   the models involved have no metadata, which is precisely why they
			   are not offered. Rendered after the untrusted note because both
			   explain an absence, and the user is reading top-down. */
			var unknownNote = null;
			if (catalog !== undefined && catalog !== null && catalog.unknownFree.length > 0) {
				unknownNote = E("p", { className: "opf-note" },
					t("unknownFree") + " " + unknownIdsText(catalog.unknownFree) + " " + t("unknownFreeWhy"));
			}

			var stamp = null;
			// `0` is what a catalogue that has never been probed reports, and it is
				// not 1970: a round that has never run has no time. Rendering it put a
				// 1970 stamp and stale inconclusive wording on a card that simply had
				// not probed yet.
				if (catalog !== undefined && catalog !== null && typeof catalog.probedAt === "number" && catalog.probedAt > 0) {
				var stampText = stampOf(catalog.probedAt);
				if (stampText !== "") {
					stamp = E("p", { className: "opf-stamp" },
						E("span", { className: "opf-dot" }),
						E("span", null, t("probedAt") + " " + stampText));
				}
			}

			/* Footer legend: what the two badge colours mean. Static, so it
			   renders whenever the card does. */
			var legend = E("span", { className: "opf-legend" },
				E("span", { className: "opf-badge opf-badge-vision" }, eyeIcon(), E("span", null, t("legend.vision"))),
				E("span", { className: "opf-badge opf-badge-think" }, starIcon(), E("span", null, t("legend.thinking"))),
				E("span", { className: "opf-badge opf-badge-tools", title: t("legend.tools") }, E("span", null, "read + bash")),
				E("span", { className: "opf-badge opf-measured" }, E("span", null, t("legend.measured"))));

			/* Progress capsule. LIVE: pulsing dot, "正在探测", "done/total", mini
			   bar — per the mock. FINISHED: the same shape, tinted by the
			   outcome, carrying the tally so the round's result is still a
			   fact on screen instead of a flash that vanishes on completion.
			   Both sit next to the last-probe timestamp. */
			var capsule = null;
			var unmeasuredCount = 0;
			var unmeasuredWords = {};
			if (progress !== null && progress.total > 0) {
				if (progress.running === true) {
					var pct = Math.max(0, Math.min(100, Math.round((progress.done / progress.total) * 100)));
					capsule = E("span", { className: "opf-capsule" },
						E("span", { className: "opf-pingwrap" },
							E("span", { className: "opf-pingring" }),
							E("span", { className: "opf-pingdot" })),
						E("span", { className: "opf-capsulelabel" },
							t("probing.now"),
							" ",
							E("span", { className: "opf-count" }, progress.done + "/" + progress.total)),
						E("span", { className: "opf-bar" },
							E("span", { className: "opf-fill", style: { width: pct + "%" } })));
				} else {
					var okCount = 0;
					var badCount = 0;
					var goneCount = 0;
					var reconfirmedCount = 0;
					unmeasuredCount = 0;
					unmeasuredWords = {};
					for (var rid in liveResults) {
						if (!hasOwnKey(liveResults, rid)) continue;
						var entry = liveResults[rid];
						if (entry !== null && entry.status === "ok") {
							okCount += 1;
							continue;
						}
						// A refusal is not a model verdict, so it is not a
						// "failure" of anything but the round itself. Counting
						// it separately is what stops a gated window from
						// painting the whole list red.
						if (entry !== null && CALLER_CODES[entry.code] === true) {
							unmeasuredCount += 1;
							// The banner carries the gate marker too, not just the
							// folded code: the reader's next move depends on which
							// of the three upstream conditions answered, and this is
							// the one line that survives a page reload.
							var refusedLabel = failureText(t, entry);
							if (typeof entry.marker === "string" && hasOwnKey(GATE_MARKERS, entry.marker)) {
								refusedLabel += "（" + t(GATE_MARKERS[entry.marker]) + "）";
							}
							unmeasuredWords[refusedLabel] = true;
							continue;
						}
						badCount += 1;
						// `dead` and `not-listed` both REMOVE the row, so their
						// badges can never be read afterwards. Counting them
						// separately is what lets the report say "3 failed, 2 of
						// them gone" instead of quietly losing two — and keeping
						// the re-confirmed ones apart is what stops an old verdict
						// from being announced as a removal that just happened.
						if (entry !== null && GONE_CODES[entry.code] === true) {
							if (isFreshRemoval(entry)) goneCount += 1;
							else reconfirmedCount += 1;
						}
					}
					// A dead model is gone from `visible`, so its row cannot
					// speak for itself. Naming the count here is what keeps a
					// disappearance from looking like a bug.
					capsule = E("span", { className: "opf-capsule" + (badCount > 0 ? " opf-capsule-mixed" : " opf-capsule-done") },
						E("span", { className: "opf-pingwrap" },
							E("span", { className: "opf-pingring" }),
							E("span", { className: "opf-pingdot" })),
						E("span", { className: "opf-capsule-ok" },
							t("probing.done"),
							" ",
							E("span", { className: "opf-capsule-oknum" }, String(okCount)),
							" ",
							E("span", { className: "opf-capsule-badnum" }, String(badCount)),
							unmeasuredCount > 0
								? E("span", { className: "opf-capsule-skip" },
									"· " + t("probing.unmeasured") + " " + String(unmeasuredCount))
								: null),
						goneCount > 0
							? E("span", { className: "opf-capsule-gone" },
								t("probing.removed") + " " + String(goneCount))
							: null,
						reconfirmedCount > 0
							? E("span", { className: "opf-capsule-gone" },
								t("probing.reconfirmed") + " " + String(reconfirmedCount))
							: null);
				}
			}

			/* What the round COST. A round may take several samples of one model, so
			   the model tally is not the bill: someone who presses "Probe now" is
			   spending the shared anonymous bucket and is entitled to see what it
			   bought and what it still owes. */
			if (capsule !== null && progress !== null && progress.running !== true && progress.requests > 0) {
				capsule = E("span", { className: "opf-capsule" },
					capsule,
					E("span", { className: "opf-capsule-skip" },
						t("probing.bill", {
							requests: progress.requests,
							pending: progress.pending === null ? 0 : progress.pending.length,
						})));
			}

			/* When the tier refused, said the quota was gone, or rejected the key,
			   the round learned nothing about those models — so it says exactly
			   that, once, instead of stamping each row with a red verdict that a
			   later working call would prove wrong. */
			var refusedNote = null;
			if (progress !== null && !progress.running && unmeasuredCount > 0) {
				var refusedWords = [];
				for (var word in unmeasuredWords) {
					if (hasOwnKey(unmeasuredWords, word)) refusedWords.push(word);
				}
				/* Name WHEN, or the retained refusal reads as a current fact.
				   A grey banner with no timestamp is how "the tier was gated
				   for five minutes yesterday" turns into "the probe says these
				   models don't work". */
				var refusedWhen = typeof progress.startedAt === "number" && progress.startedAt > 0
					? stampOf(progress.startedAt)
					: "";
				refusedNote = E("p", { className: "opf-note" },
					t("probing.roundRefused")
					+ (refusedWhen !== "" ? "（" + refusedWhen + "）" : "")
					+ "：" + refusedWords.join("、")
					+ " —— " + t("probing.notModelFault") + "，" + t("probing.retryHint"));
			}

			/* Why a vanished model vanished. Rendered only when the last round
			   actually took a model out of the list, and never more than a
			   couple of lines: this is a receipt for something that no longer
			   has a row, not a second list. A verdict the round only
			   RE-CONFIRMED gets its own line instead, because it removed
			   nothing — filing it under "removed this round" dates an earlier
			   round's change to this one, which is the receipt the reader
			   actually acts on. */
			var removedNote = null;
			if (progress !== null && !progress.running) {
				var removed = [];
				var reconfirmed = [];
				for (var goneId in liveResults) {
					if (!hasOwnKey(liveResults, goneId)) continue;
					var gone = liveResults[goneId];
					if (gone === null || gone.status !== "failed" || GONE_CODES[gone.code] !== true) continue;
					if (isFreshRemoval(gone)) removed.push(goneId);
					else reconfirmed.push(goneId);
				}
				var nameSome = function (word, ids) {
					var named = ids.slice(0, 3).join("、");
					var rest = ids.length - Math.min(ids.length, 3);
					return word + "：" + named + (rest > 0 ? t("probing.andMore") + " " + String(rest) : "");
				};
				var removalLines = [];
				if (removed.length > 0) removalLines.push(nameSome(t("probing.removed"), removed));
				if (reconfirmed.length > 0) removalLines.push(nameSome(t("probing.reconfirmed"), reconfirmed));
				if (removalLines.length > 0) {
					removedNote = E("p", { className: "opf-summaryline" }, removalLines.join("；"));
				}
			}

			var toolbarRight = stamp !== null || capsule !== null
				? E("div", { className: "opf-actions" }, capsule, stamp)
				: null;

			return E("div",
				{ className: "opf-card" },
				E("div", { className: "opf-head" },
					E("div", { className: "opf-title" }, t("title")),
					E("p", { className: "opf-desc" }, t("cardDesc")),
					E("div", { className: "opf-toolbar" },
						E("div", { className: "opf-actions" },
							E("button", {
								type: "button",
								className: "opf-btn",
								disabled: busy || probing,
								onClick: refresh
							}, refreshIcon(), E("span", null, busy ? t("refreshing") : t("refresh"))),
							E("button", {
								type: "button",
								className: "opf-btn" + (probing ? " opf-btn-probing" : ""),
								disabled: probing,
								onClick: probe
							}, probing ? spinnerIcon(true) : searchIcon(), E("span", null, probing ? t("probing") : t("probe")))),
						toolbarRight)),
				E("div", { className: "opf-body" },
					fallbackNote,
					untrustedNote,
					unknownNote,
					removedNote,
					refusedNote,
					listArea,
					error ? E("p", { className: "opf-error" }, error) : null,
					probeError ? E("p", { className: "opf-error" }, probeError) : null),
				E("div", { className: "opf-foot" },
					E("p", { className: "opf-hint" }, t("hint")),
					legend));
		}

		// ── plugin ────────────────────────────────────────────────────────────

		exports.name = "dsh-opencode-free/client";

		/**
		 * Required client services: only era-guaranteed ones are hard-injected;
		 * the settings face is acquired OPTIONALLY (a missing configForms on a
		 * stripped-down host must not take the card down with it).
		 */
		exports.inject = ["locale", "slots"];

		exports.apply = function (ctx) {
			// The settings face: one ConfigForm per live profile entry; the form
			// key is the row id "opencode-free" (contract: getSnapshot/set/subscribe).
			var scope = null;

			try {
				ctx.inject(["configForms"], function (fctx) {
					try {
						var forms = fctx && fctx.configForms;
						if (forms && typeof forms.get === "function") scope = forms.get(SETTINGS_NAMESPACE);
					} catch (error) {
						console.warn(TAG + " configForms acquisition failed:", error && error.message ? error.message : error);
					}
				});
			} catch (error) {
				console.warn(TAG + " configForms wiring failed:", error && error.message ? error.message : error);
			}
			/* The card's only copy entry point: a live lookup, never a captured
			   dictionary — the language preference switches without a reload. */
			var t = translatorOf(ctx);

			ctx.effect(function () {
				var disposers = [ensureStyles()];
				try {
					if (ctx.locale && typeof ctx.locale.register === "function") {
						var disposeDict = ctx.locale.register(NS, { zh: zh, en: en });
						if (typeof disposeDict === "function") disposers.push(disposeDict);
					}
				} catch (error) {
					console.warn(TAG + " dictionary registration failed:", error && error.message ? error.message : error);
				}
				return function () {
					for (var i = 0; i < disposers.length; i++) {
						try {
							if (typeof disposers[i] === "function") disposers[i]();
						} catch (error) { /* best effort */ }
					}
				};
			}, "dsh-opencode-free: styles, dictionaries");

			// Guarded registration: a thrown register degrades this one seat,
			// never the plugin fiber.
			try {
				var slots = ctx.slots;
				if (!slots || typeof slots.inject !== "function") {
					console.warn(TAG + " slots service unavailable; settings card idle");
					return;
				}
				var injected = function () {
					// The inject factory's returned members become the component's
					// props: the bound settings scope AND the ctx ride here as
					// PLAIN members (top-level options fields do NOT reach it).
					return { scope: scope, ctx: ctx };
				};
				// The detail page's bundle configuration seat, keyed by the
				// PACKAGE name. Each inject waits for its own slot declaration.
				slots.inject("plugins.bundle.config", function () {
					return slots.register({
						name: "plugins.bundle.config",
						key: SLOT_KEY,
						locale: NS,
						inject: injected
					}, function BundleConfigWithBoundary(props) {
						return E(LocaleLive, { ctx: ctx, t: t, cardProps: props });
					});
				});
			} catch (error) {
				console.warn(TAG + " settings card registration failed:", error && error.message ? error.message : error);
			}
		};

		return module.exports;
	}
});
