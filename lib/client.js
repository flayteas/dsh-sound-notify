// @dsharness/dsh-sound-notify — browser half (hand-written in the DSH client
// bundle format; no build step needed).
//
// Plays synthesized chimes when the agent asks a question, requests approval,
// or completes a turn, and personalizes the app background (color, image,
// opacity). Both are configured in real time through the DSH settings system
// (namespace "sound-notify"):
//   - settingsScope reads the resolved settings and re-applies on every change
//   - a settings.section page (Settings > 提示音) edits them with live preview
//
// Triggers:
//   - question   -> the agent asks a question / plan review
//   - approval   -> approval request (sandbox escalation, tool approval, …)
//   - completion -> a turn finished (snapshot running bit true→false with no
//                   interaction waiting; background sessions use the list
//                   row's `completed` flag — the sidebar green dot)
//
// Design notes:
//   - The host emits no cordis event for question/approval requests; the only
//     reliable arrival signal is the client-side session snapshot's `pending`
//     array (PendingWait objects with kind "question" | "approval"), which is
//     exactly the data the question/approval UI renders from.
//   - First observation of a session establishes a baseline: pre-existing
//     pending waits (e.g. after a page refresh) are never replayed.
//   - Browser autoplay policy: the AudioContext is lazily created and resumed
//     on the first user gesture, so later chimes are never blocked.

window.__ModuleLoader__.load({
	id: "@dsharness/dsh-sound-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");

		//#region synthetic chime engine (Web Audio, zero assets)
		var audioCtx = null;
		var lastPlayedAt = 0;
		var MIN_INTERVAL_MS = 250;

		function ensureContext() {
			if (typeof window === "undefined") return null;
			var AC = window.AudioContext || window.webkitAudioContext;
			if (!AC) return null;
			if (audioCtx === null) {
				try {
					audioCtx = new AC();
				} catch (error) {
					return null;
				}
			}
			if (audioCtx.state === "suspended") audioCtx.resume().catch(function () {});
			return audioCtx;
		}

		/** Browsers require a user gesture before audio may play; unlock on the
		*  first interaction so later chimes are never blocked. */
		function unlock() {
			var ctx = ensureContext();
			if (ctx && ctx.state === "suspended") ctx.resume().catch(function () {});
		}
		if (typeof window !== "undefined") {
			window.addEventListener("pointerdown", unlock, { once: true, passive: true });
			window.addEventListener("keydown", unlock, { once: true });
		}

		/** One sine blip starting at ABSOLUTE audio time `t` (seconds). All
		*  scheduling uses the audio clock, not setTimeout: repeat rings stay
		*  exact and survive background-tab timer throttling (Chrome clamps
		*  timers to >=1s in hidden tabs, which used to eat repeat rings). */
		function toneAt(ctx, freq, t, dur, vol) {
			var osc = ctx.createOscillator();
			var gain = ctx.createGain();
			osc.type = "sine";
			osc.frequency.value = freq;
			gain.gain.setValueAtTime(0.0001, t);
			gain.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t + 0.02);
			gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
			osc.connect(gain);
			gain.connect(ctx.destination);
			osc.start(t);
			osc.stop(t + dur + 0.05);
		}

		/** Pending timers (custom-audio repeats only; synthetic sequences are
		*  scheduled on the audio clock and need no timers). */
		var pendingTimers = [];
		function clearPendingTimers() {
			for (var i = 0; i < pendingTimers.length; i++) clearTimeout(pendingTimers[i]);
			pendingTimers = [];
		}

		/** One ring of a preset, every tone scheduled at absolute time `t`. */
		function ringAt(ctx, preset, vol, t) {
			if (preset === "falling") {
				// 880 -> 620
				toneAt(ctx, 880, t, 0.16, vol);
				toneAt(ctx, 620, t + 0.16, 0.22, vol);
			} else if (preset === "dingdong") {
				// ding-dong: high short "ding", low longer "dong"
				toneAt(ctx, 880, t, 0.16, vol);
				toneAt(ctx, 660, t + 0.18, 0.32, vol);
			} else if (preset === "beep") {
				// single short blip
				toneAt(ctx, 880, t, 0.2, vol);
			} else {
				// rising: 620 -> 880 (default)
				toneAt(ctx, 620, t, 0.18, vol);
				toneAt(ctx, 880, t + 0.16, 0.24, vol);
			}
		}

		/** Schedule a whole repeat-sequence on the audio clock in one pass. The
		*  small lead (0.02s) keeps every start slightly in the future so no
		*  attack edge is ever clipped by a live clock. */
		function startSequence(ctx, preset, vol, count, gap) {
			var base = ctx.currentTime + 0.02;
			for (var i = 0; i < count; i++) {
				ringAt(ctx, preset, vol, base + i * (gap / 1000));
			}
		}

		/** Play one preset, repeated `repeat` times with `interval` ms between
		*  rings. The global debounce applies once at sequence start, so the
		*  repeats of one sequence are never blocked by it. */
		function playPreset(preset, volume, repeat, interval) {
			if (preset === "off") return;
			var ctx = ensureContext();
			if (!ctx) return;
			var now = Date.now();
			if (now - lastPlayedAt < MIN_INTERVAL_MS) return;
			lastPlayedAt = now;
			var vol = typeof volume === "number" ? Math.min(Math.max(volume, 0), 1) : 0.25;
			var count = Math.max(1, Math.min(10, Math.round(repeat || 1)));
			var gap = Math.max(0, Math.min(5000, interval || 500));
			if (ctx.state === "suspended") {
				// The browser auto-suspends the AudioContext after ~30s of
				// silence, freezing its clock. resume() is async, so defer the
				// whole sequence until it is running — otherwise the first chime
				// after a long idle is scheduled on the frozen clock and clipped
				// (or skipped entirely). The debounce already ran, so a burst
				// during the resume window still yields exactly one sequence.
				ctx.resume().then(function () {
					if (ctx.state === "running") startSequence(ctx, preset, vol, count, gap);
				}).catch(function () {});
				return;
			}
			startSequence(ctx, preset, vol, count, gap);
		}
		//#endregion

		//#region settings resolution
		/** Mirrors the host Config schema defaults (flat per-trigger fields). */
		var DEFAULTS = {
			enabled: true,
			questionSound: "rising",
			questionVolume: 0.25,
			questionRepeat: 1,
			questionInterval: 500,
			approvalSound: "falling",
			approvalVolume: 0.25,
			approvalRepeat: 1,
			approvalInterval: 500,
			completionSound: "dingdong",
			completionVolume: 0.25,
			completionRepeat: 1,
			completionInterval: 500,
			questionCustomSound: "",
			approvalCustomSound: "",
			completionCustomSound: "",
			bgColor: "",
			bgImage: "",
			bgOpacity: 0.85,
			sidebarMask: 1
		};

		function triggerFields(kind) {
			if (kind === "approval") return ["approvalSound", "approvalVolume", "approvalRepeat", "approvalInterval", "approvalCustomSound"];
			if (kind === "completion") return ["completionSound", "completionVolume", "completionRepeat", "completionInterval", "completionCustomSound"];
			return ["questionSound", "questionVolume", "questionRepeat", "questionInterval", "questionCustomSound"];
		}

		/** Play a custom audio file (uploaded URL) with repeat/interval. A fresh
		*  Audio element is created per ring — reusing one element and swapping
		*  `src` then calling play() immediately races the media load and can
		*  silently miss a ring. */
		function playCustomAudio(url, volume, repeat, interval) {
			if (typeof Audio === "undefined") return;
			var now = Date.now();
			if (now - lastPlayedAt < MIN_INTERVAL_MS) return;
			lastPlayedAt = now;
			clearPendingTimers();
			var vol = typeof volume === "number" ? Math.min(Math.max(volume, 0), 1) : 0.25;
			var count = Math.max(1, Math.min(10, Math.round(repeat || 1)));
			var gap = Math.max(0, Math.min(5000, interval || 500));
			var playOnce = function () {
				try {
					var el = new Audio(url);
					el.volume = vol;
					el.play().catch(function () {});
				} catch (error) {
					/* ignore autoplay/format failures */
				}
			};
			playOnce();
			for (var i = 1; i < count; i++) {
				pendingTimers.push(setTimeout(playOnce, i * gap));
			}
		}

		/** Play the configured sound for one trigger kind. */
		function play(kind, cfg) {
			if (!cfg || cfg.enabled === false) return;
			var fields = triggerFields(kind);
			var preset = cfg[fields[0]] ?? DEFAULTS[fields[0]];
			var volume = typeof cfg[fields[1]] === "number" ? cfg[fields[1]] : DEFAULTS[fields[1]];
			var repeat = typeof cfg[fields[2]] === "number" ? cfg[fields[2]] : DEFAULTS[fields[2]];
			var interval = typeof cfg[fields[3]] === "number" ? cfg[fields[3]] : DEFAULTS[fields[3]];
			if (preset === "custom") {
				var customUrl = typeof cfg[fields[4]] === "string" ? cfg[fields[4]].trim() : "";
				if (customUrl !== "") {
					playCustomAudio(customUrl, volume, repeat, interval);
					return;
				}
				// custom selected but no file yet — stay silent
				return;
			}
			playPreset(preset, volume, repeat, interval);
		}
		//#endregion

		//#region pending-interaction & completion observation
		/** Services required by the client half. */
		var inject = ["sessions", "settingsScope", "connection", "remote", "slots", "theme"];

		/** Escape a URL for embedding inside a CSS url("...") token. */
		function cssUrlSafe(value) {
			return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
		}

		/** @param ctx - client root context. */
		function apply(ctx) {
			// Live per-trigger configuration from the DSH settings system. The
			// namespace is registered by the host half; bind() pulls schema +
			// value over the loopback settings RPC and reloads on every
			// settings/document-updated event, so edits apply without refresh.
			var cfg = DEFAULTS;
			var scope = ctx.settingsScope.bind({ namespace: "sound-notify" });

			// ---- background personalization ----
			var bgOverrideDispose = null;
			var bgStyleEl = null;
			/** The theme's own --dsw-alias-bg-base value, captured once before any
			*  override — the fallback behind an image so a failed/blocked image
			*  shows the theme background instead of pure black. */
			var defaultBg = null;
			/** The theme's own --dsw-specific-sidebar-fill value, captured once. */
			var sidebarFill = null;
			function captureSurfaceColors() {
				if (typeof document === "undefined") return;
				if (defaultBg === null) {
					var v = getComputedStyle(document.body).getPropertyValue("--dsw-alias-bg-base").trim();
					defaultBg = v !== "" ? v : null;
				}
				if (sidebarFill === null) {
					var s = getComputedStyle(document.body).getPropertyValue("--dsw-specific-sidebar-fill").trim();
					sidebarFill = s !== "" ? s : null;
				}
			}
			/** Re-emit a color with a new alpha (hex #rgb/#rrggbb or rgb()/rgba()).
			*  Unparseable colors pass through unchanged. */
			function withAlpha(color, alpha) {
				if (typeof color !== "string") return color;
				var c = color.trim();
				var m;
				if ((m = /^#([0-9a-f]{3})$/i.exec(c))) {
					return "rgba(" + parseInt(m[1][0] + m[1][0], 16) + "," + parseInt(m[1][1] + m[1][1], 16) + "," + parseInt(m[1][2] + m[1][2], 16) + "," + alpha + ")";
				}
				if ((m = /^#([0-9a-f]{6})$/i.exec(c))) {
					return "rgba(" + parseInt(m[1].slice(0, 2), 16) + "," + parseInt(m[1].slice(2, 4), 16) + "," + parseInt(m[1].slice(4, 6), 16) + "," + alpha + ")";
				}
				if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(c))) {
					return "rgba(" + m[1] + "," + m[2] + "," + m[3] + "," + alpha + ")";
				}
				return c;
			}
			/**
			* Apply the background settings:
			*  - bgColor / bgImage: as before.
			*  - bgOpacity: the GLOBAL mask — opacity of the theme background kept
			*    on the content surfaces (frame / chat / details, --dsw-alias-bg-base)
			*    over the image; lower = image more visible. The image itself is
			*    always rendered at full opacity.
			*  - sidebarMask: opacity of the sidebar's own fill (--dsw-specific-sidebar-fill)
			*    so the image shows through the left rail.
			*/
			function applyBackground(bg) {
				var color = typeof bg.bgColor === "string" ? bg.bgColor.trim() : "";
				var image = typeof bg.bgImage === "string" ? bg.bgImage.trim() : "";
				var opacity = typeof bg.bgOpacity === "number" ? Math.min(Math.max(bg.bgOpacity, 0), 1) : 0.85;
				var sidebarMask = typeof bg.sidebarMask === "number" ? Math.min(Math.max(bg.sidebarMask, 0), 1) : 1;
				captureSurfaceColors();
				// 1) theme token overrides (one layer replaces the previous):
				//    - with an image: the frame/chat/details surface keeps a
				//      theme-tinted rgba mask (bgOpacity, the GLOBAL mask); the
				//      sidebar keeps its own rgba mask (sidebarMask).
				//    - without an image: only the explicit bgColor, if any.
				if (bgOverrideDispose !== null) {
					bgOverrideDispose();
					bgOverrideDispose = null;
				}
				var tokens = {};
				if (image !== "") {
					tokens["--dsw-alias-bg-base"] = { light: withAlpha(defaultBg !== null ? defaultBg : "#000000", opacity), dark: withAlpha(defaultBg !== null ? defaultBg : "#000000", opacity) };
					tokens["--dsw-specific-sidebar-fill"] = { light: withAlpha(sidebarFill !== null ? sidebarFill : "#000000", sidebarMask), dark: withAlpha(sidebarFill !== null ? sidebarFill : "#000000", sidebarMask) };
				} else if (color !== "") {
					tokens["--dsw-alias-bg-base"] = { light: color, dark: color };
				}
				if (Object.keys(tokens).length > 0 && ctx.theme !== void 0) {
					bgOverrideDispose = ctx.theme.overrideTokens("dsh-sound-notify", tokens);
				}
				// 2) body layer: the image lives ONLY on body::before (full
				//    opacity — image strength is controlled by the global mask on
				//    the surfaces, not by a per-layer image opacity, which the
				//    body's own background-image used to render ineffective).
				if (bgStyleEl === null && typeof document !== "undefined") {
					bgStyleEl = document.createElement("style");
					bgStyleEl.dataset.plugin = "@dsharness/dsh-sound-notify";
					bgStyleEl.dataset.pluginCss = "@dsharness/dsh-sound-notify/background.css";
					document.head.appendChild(bgStyleEl);
				}
				var rules = "";
				if (image !== "") {
					var url = "url(\"" + cssUrlSafe(image) + "\")";
					// Fall back to the theme's own background color (or black only
					// as a last resort) so a broken/blocked image never turns the
					// app into a black void.
					var base = color !== "" ? color : (defaultBg !== null ? defaultBg : "#000000");
					rules += "body{background-color:" + base + "}";
					rules += "body::before{content:\"\";position:fixed;inset:0;z-index:0;pointer-events:none;background-image:" + url + ";background-size:cover;background-position:center;background-attachment:fixed}";
				} else if (color !== "") {
					rules += "body{background-color:" + color + "}";
				}
				if (bgStyleEl !== null) bgStyleEl.textContent = rules;
			}

			var applySettings = function () {
				var snap = scope.getSnapshot();
				if (snap && snap.value && typeof snap.value === "object") {
					cfg = snap.value;
					applyBackground(cfg);
				}
			};
			var offSettings = scope.subscribe(applySettings);
			applySettings();
			ctx.effect(() => () => {
				if (bgOverrideDispose !== null) bgOverrideDispose();
				if (bgStyleEl !== null) bgStyleEl.remove();
			}, "dsh-sound-notify: background teardown");

			var sessions = ctx.sessions;
			if (!sessions) return;

			/** Known pending keys per session: Map<sessionId, Set<key>>. */
			var known = new Map();
			/** Coarse list-row status per session: Map<sessionId, string|undefined>. */
			var listStatus = new Map();
			/** Session snapshot subscriptions: Map<sessionId, disposer>. */
			var subs = new Map();
			/** Last-observed running bit per session (snapshot path). */
			var runningPrev = new Map();
			/** Last-observed list-row completed flag per session (background path). */
			var completedSeen = new Map();

			function keysOf(pending) {
				var keys = new Set();
				for (var i = 0; i < pending.length; i++) {
					var wait = pending[i];
					if (wait && typeof wait.key === "string") keys.add(wait.key);
				}
				return keys;
			}

			function beepFor(wait) {
				if (!wait) return;
				if (wait.kind === "approval") play("approval", cfg);
				else if (wait.kind === "question") play("question", cfg);
			}

			/** Diff one session's pending waits; first observation is baseline only. */
			function observeSession(id, snap) {
				var pending = snap && snap.pending ? snap.pending : [];
				var base = known.get(id);
				var current = keysOf(pending);
				if (base === undefined) {
					known.set(id, current);
				} else {
					for (var key of current) {
						if (!base.has(key)) {
							for (var i = 0; i < pending.length; i++) {
								if (pending[i].key === key) beepFor(pending[i]);
							}
						}
					}
					known.set(id, current);
				}
				// Turn-completion edge: running true -> false, with no interaction
				// still waiting (a question/approval pause is its own chime).
				var running = !!(snap && snap.running);
				var prevRunning = runningPrev.get(id);
				if (prevRunning !== undefined && prevRunning === true && running === false && pending.length === 0) {
					play("completion", cfg);
				}
				runningPrev.set(id, running);
			}

			function ensureSession(id) {
				if (subs.has(id)) return;
				var binding = sessions.binding(id);
				if (!binding || !binding.session) return;
				var session = binding.session;
				if (typeof session.subscribe !== "function" || typeof session.getSnapshot !== "function") return;
				var unsub = session.subscribe(function () {
					var snap = session.getSnapshot();
					observeSession(id, snap);
				});
				subs.set(id, unsub);
				var snap = session.getSnapshot();
				observeSession(id, snap);
			}

			function reconcile() {
				var snapshot = sessions.list.getSnapshot();
				var ids = snapshot && snapshot.ids ? snapshot.ids : [];
				var byId = snapshot && snapshot.byId ? snapshot.byId : {};
				for (var i = 0; i < ids.length; i++) {
					var id = ids[i];
					ensureSession(id);
					var row = byId[id];
					// Coarse fallback for listed-but-not-instantiated sessions: the
					// list row carries a pendingInteraction status string.
					var status = row && row.pendingInteraction;
					var prev = listStatus.get(id);
					if (status !== undefined && status !== prev) {
						if (prev !== undefined && !subs.has(id)) {
							play(status === "approval" ? "approval" : "question", cfg);
						}
						listStatus.set(id, status);
					} else if (status === undefined) {
						listStatus.set(id, undefined);
					}
					// Background completion: the manager arms the row's `completed`
					// flag on the running true->false edge of a non-selected session
					// (the sidebar green dot). Instantiated sessions are covered by
					// the snapshot running-edge path; the global debounce collapses
					// the rare double-fire.
					var completed = !!(row && row.completed);
					var prevCompleted = completedSeen.get(id);
					if (prevCompleted !== undefined && prevCompleted === false && completed === true) {
						play("completion", cfg);
					}
					completedSeen.set(id, completed);
				}
				// Prune sessions that left the list.
				for (var key of Array.from(known.keys())) {
					if (ids.indexOf(key) === -1) known.delete(key);
				}
				for (var key2 of Array.from(subs.keys())) {
					if (ids.indexOf(key2) === -1) {
						var dispose = subs.get(key2);
						if (typeof dispose === "function") dispose();
						subs.delete(key2);
					}
				}
				for (var key3 of Array.from(runningPrev.keys())) {
					if (ids.indexOf(key3) === -1) runningPrev.delete(key3);
				}
				for (var key4 of Array.from(completedSeen.keys())) {
					if (ids.indexOf(key4) === -1) completedSeen.delete(key4);
				}
			}

			sessions.list.subscribe(reconcile);
			reconcile();

			// Settings page: Settings > 个性化 (background + 提示音).
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "sound-notify",
				order: 100,
				label: () => "个性化",
				inject: () => ({ scope })
			}, SoundSection));
		}
		//#endregion

		//#region settings section UI (Settings > 提示音)
		var GROUPS = [
			{ key: "question", label: "提问", soundField: "questionSound", volumeField: "questionVolume", repeatField: "questionRepeat", intervalField: "questionInterval", customField: "questionCustomSound" },
			{ key: "approval", label: "审批", soundField: "approvalSound", volumeField: "approvalVolume", repeatField: "approvalRepeat", intervalField: "approvalInterval", customField: "approvalCustomSound" },
			{ key: "completion", label: "任务完成", soundField: "completionSound", volumeField: "completionVolume", repeatField: "completionRepeat", intervalField: "completionInterval", customField: "completionCustomSound" }
		];
		var SOUND_OPTIONS = [
			["rising", "上扬"],
			["falling", "下行"],
			["dingdong", "叮咚"],
			["beep", "单声"],
			["custom", "自定义音频"],
			["off", "静音"]
		];

		//#region sound section styles (theme-consistent; explicit colors so the
		// controls stay visible on the dark panel, mirroring DSH's own
		// settings form styling)
		var SECTION_CSS = ".dshsn_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;padding:0 16px 16px;display:flex}" +
			".dshsn_groupTitle{color:var(--dsw-alias-label-primary);margin:12px 0 0;font-size:14px;font-weight:600;line-height:22px}" +
			".dshsn_field{flex-direction:column;gap:6px;margin-top:10px;display:flex}" +
			".dshsn_fieldLabel{color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex}" +
			".dshsn_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:14px;line-height:22px}" +
			"select.dshsn_input{cursor:pointer;max-width:240px}" +
			".dshsn_input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}" +
			".dshsn_select{appearance:none;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\");background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px;padding-right:32px}" +
			".dshsn_button{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);height:28px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:var(--dsw-alias-bg-layer-1);border-radius:14px;align-items:center;gap:4px;padding:0 12px;font-size:12px;line-height:18px;display:inline-flex}" +
			".dshsn_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}" +
			".dshsn_row{display:flex;align-items:center;gap:10px}" +
			".dshsn_number{width:72px;flex:none}" +
			".dshsn_note{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}" +
			".dshsn_warn{color:var(--dsw-alias-state-warn-label);margin:0;font-size:12px;line-height:18px}" +
			".dshsn_slider{flex:1;accent-color:var(--dsw-alias-brand-primary);height:32px}" +
			".dshsn_value{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-width:36px;text-align:right}" +
			".dshsn_check{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px}" +
			".dshsn_check input{accent-color:var(--dsw-alias-brand-primary)}";
		var SECTION_CSS_TAG = "@dsharness/dsh-sound-notify/sound-section.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(SECTION_CSS_TAG) + "]") === null) {
			var styleTag = document.createElement("style");
			styleTag.dataset.plugin = "@dsharness/dsh-sound-notify";
			styleTag.dataset.pluginCss = SECTION_CSS_TAG;
			styleTag.textContent = SECTION_CSS;
			document.head.appendChild(styleTag);
		}
		//#endregion

		function el(type, props, children) {
			return react.createElement(type, props, children);
		}

		/** POST a local file to the host upload route; cb(url, error) on settle. */
		function uploadFile(file, cb) {
			if (typeof fetch === "undefined") {
				cb(null, "浏览器不支持 fetch");
				return;
			}
			fetch("/plugins/sound-notify/upload", {
				method: "POST",
				headers: { "x-file-name": encodeURIComponent(file.name || "file") },
				body: file
			}).then((res) => res.json().then((data) => ({ res, data })).catch(() => ({ res, data: null })))
				.then(({ res, data }) => {
					if (res.ok && data && data.ok === true) cb(data.url, null);
					else cb(null, (data && typeof data.error === "string" && data.error) || "上传失败（HTTP " + res.status + "）");
				}).catch(() => cb(null, "网络错误"));
		}

		/** Hidden <input type="file"> behind a themed button. */
		function FilePicker({ accept, label, onFile, busy }) {
			var inputRef = react.useRef(null);
			return el("div", { className: "dshsn_row" }, [
				el("input", {
					ref: inputRef,
					type: "file",
					accept,
					style: { display: "none" },
					onChange: (e) => {
						var file = e.target.files && e.target.files[0];
						if (file) onFile(file);
						e.target.value = "";
					}
				}),
				el("button", {
					type: "button",
					className: "dshsn_button",
					disabled: busy === true,
					onClick: () => {
						if (inputRef.current !== null) inputRef.current.click();
					}
				}, busy === true ? "上传中…" : label)
			]);
		}

		/** One trigger group: sound select + volume slider + repeat/interval. */
		function SoundGroup({ group, value, setField, preview }) {
			var sound = value[group.soundField] ?? "off";
			var volume = typeof value[group.volumeField] === "number" ? value[group.volumeField] : 0.25;
			var repeat = typeof value[group.repeatField] === "number" ? value[group.repeatField] : 1;
			var interval = typeof value[group.intervalField] === "number" ? value[group.intervalField] : 500;
			var customUrl = typeof value[group.customField] === "string" ? value[group.customField] : "";
			var [uploading, setUploading] = react.useState(false);
			var [uploadError, setUploadError] = react.useState("");
			var pickAudio = (file) => {
				setUploading(true);
				setUploadError("");
				uploadFile(file, (url, error) => {
					setUploading(false);
					if (url !== null) {
						setField(group.customField, url);
						setField(group.soundField, "custom");
					} else {
						setUploadError(error || "上传失败，请重试");
					}
				});
			};
			var customName = customUrl !== "" ? customUrl.split("/").pop() : "";
			return el("div", null, [
				el("div", { className: "dshsn_groupTitle" }, group.label),
				el("div", { className: "dshsn_field" }, [
					el("span", { className: "dshsn_fieldLabel" }, "音效"),
					el("div", { className: "dshsn_row" }, [
						el("select", {
							className: "dshsn_input dshsn_select",
							value: sound,
							onChange: (e) => setField(group.soundField, e.target.value)
						}, SOUND_OPTIONS.map((option) => el("option", { key: option[0], value: option[0] }, option[1]))),
						el("button", {
							type: "button",
							className: "dshsn_button",
							onClick: () => preview(group.key)
						}, "试听")
					])
				]),
				sound === "custom" ? el("div", { className: "dshsn_field" }, [
					el("span", { className: "dshsn_fieldLabel" }, "自定义音频文件"),
					el(FilePicker, {
						accept: "audio/*",
						label: "选择本地音频…",
						busy: uploading,
						onFile: pickAudio
					}),
					customName !== "" ? el("div", { className: "dshsn_row" }, [
						el("span", { className: "dshsn_fieldLabel", style: { maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "当前：" + customName),
						el("button", {
							type: "button",
							className: "dshsn_button",
							onClick: () => setField(group.customField, "")
						}, "清除")
					]) : null,
					uploadError !== "" ? el("div", { className: "dshsn_warn" }, uploadError) : null
				]) : null,
				el("div", { className: "dshsn_field" }, [
					el("span", { className: "dshsn_fieldLabel" }, "音量"),
					el("div", { className: "dshsn_row" }, [
						el("input", {
							type: "range",
							className: "dshsn_slider",
							min: 0,
							max: 1,
							step: 0.05,
							value: volume,
							onChange: (e) => setField(group.volumeField, parseFloat(e.target.value))
						}),
						el("span", { className: "dshsn_value" }, Math.round(volume * 100) + "%")
					])
				]),
				el("div", { className: "dshsn_field" }, [
					el("span", { className: "dshsn_fieldLabel" }, "重复次数与间隔"),
					el("div", { className: "dshsn_row" }, [
						el("input", {
							type: "number",
							className: "dshsn_input dshsn_number",
							min: 1,
							max: 10,
							step: 1,
							value: repeat,
							onChange: (e) => setField(group.repeatField, Math.max(1, Math.min(10, Math.round(parseFloat(e.target.value) || 1))))
						}),
						el("span", { className: "dshsn_fieldLabel" }, "次"),
						el("span", { className: "dshsn_fieldLabel", style: { marginLeft: 8 } }, "间隔"),
						el("input", {
							type: "number",
							className: "dshsn_input dshsn_number",
							min: 0,
							max: 5000,
							step: 100,
							value: interval,
							onChange: (e) => setField(group.intervalField, Math.max(0, Math.min(5000, parseFloat(e.target.value) || 0)))
						}),
						el("span", { className: "dshsn_fieldLabel" }, "ms")
					])
				])
			]);
		}

		/** Background personalization group: color, image (URL or local file), masks. */
		function BackgroundGroup({ value, setField, unsetField }) {
			var color = typeof value.bgColor === "string" ? value.bgColor : "";
			var image = typeof value.bgImage === "string" ? value.bgImage : "";
			var opacity = typeof value.bgOpacity === "number" ? value.bgOpacity : 0.85;
			var sidebarMask = typeof value.sidebarMask === "number" ? value.sidebarMask : 1;
			var [uploading, setUploading] = react.useState(false);
			var [uploadError, setUploadError] = react.useState("");
			var pickImage = (file) => {
				setUploading(true);
				setUploadError("");
				uploadFile(file, (url, error) => {
					setUploading(false);
					if (url !== null) setField("bgImage", url);
					else setUploadError(error || "上传失败，请重试");
				});
			};
			return el("div", null, [
				el("div", { className: "dshsn_groupTitle" }, "背景"),
				el("div", { className: "dshsn_field" }, [
					el("span", { className: "dshsn_fieldLabel" }, "背景色"),
					el("div", { className: "dshsn_row" }, [
						el("input", {
							type: "color",
							value: color !== "" ? color : "#000000",
							onChange: (e) => setField("bgColor", e.target.value),
							style: { width: 48, height: 32, padding: 2, flex: "none", background: "transparent", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8 }
						}),
						el("span", { className: "dshsn_fieldLabel" }, color !== "" ? color : "未设置（使用主题默认）")
					])
				]),
				el("div", { className: "dshsn_field" }, [
					el("span", { className: "dshsn_fieldLabel" }, "背景图片 URL"),
					el("input", {
						type: "text",
						className: "dshsn_input",
						placeholder: "https://example.com/bg.jpg 或 data:image/…（留空 = 无图）",
						value: image,
						onChange: (e) => setField("bgImage", e.target.value)
					}),
					el(FilePicker, {
						accept: "image/*",
						label: "选择本地图片…",
						busy: uploading,
						onFile: pickImage
					}),
					uploadError !== "" ? el("div", { className: "dshsn_warn" }, uploadError) : null
				]),
				el("div", { className: "dshsn_field" }, [
					el("span", { className: "dshsn_fieldLabel" }, "全局遮罩（聊天/内容区）"),
					el("div", { className: "dshsn_row" }, [
						el("input", {
							type: "range",
							className: "dshsn_slider",
							min: 0,
							max: 1,
							step: 0.05,
							value: opacity,
							onChange: (e) => setField("bgOpacity", parseFloat(e.target.value))
						}),
						el("span", { className: "dshsn_value" }, Math.round(opacity * 100) + "%")
					]),
					el("span", { className: "dshsn_fieldLabel" }, "越低图片越清晰，越高文字越易读")
				]),
				el("div", { className: "dshsn_field" }, [
					el("span", { className: "dshsn_fieldLabel" }, "侧边栏遮罩"),
					el("div", { className: "dshsn_row" }, [
						el("input", {
							type: "range",
							className: "dshsn_slider",
							min: 0,
							max: 1,
							step: 0.05,
							value: sidebarMask,
							onChange: (e) => setField("sidebarMask", parseFloat(e.target.value))
						}),
						el("span", { className: "dshsn_value" }, Math.round(sidebarMask * 100) + "%")
					]),
					el("span", { className: "dshsn_fieldLabel" }, "降低让左侧栏显示背景图片")
				]),
				el("div", { className: "dshsn_field" }, [
					el("button", {
						type: "button",
						className: "dshsn_button",
						onClick: () => {
							unsetField("bgColor");
							unsetField("bgImage");
							unsetField("bgOpacity");
							unsetField("sidebarMask");
						}
					}, "恢复默认背景")
				])
			]);
		}

		/** The settings.section page for this plugin (Settings > 个性化). */
		function SoundSection({ scope }) {
			var snap = react.useSyncExternalStore(
				(fn) => scope.subscribe(fn),
				() => scope.getSnapshot()
			);
			var storeValue = snap && snap.value && typeof snap.value === "object" ? snap.value : DEFAULTS;
			// Optimistic draft: edits reflect instantly (sliders track the mouse);
			// a debounced write persists each field, and the draft is dropped once
			// the store round-trips the confirmed value back.
			var [draft, setDraft] = react.useState(null);
			var writeTimers = react.useRef({});
			react.useEffect(() => {
				setDraft((current) => {
					if (current === null) return null;
					var same = true;
					for (var key in current) {
						if (current[key] !== storeValue[key]) {
							same = false;
							break;
						}
					}
					return same ? null : current;
				});
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [storeValue]);
			var value = draft ?? storeValue;
			var scheduleWrite = (field, val, op) => {
				var timers = writeTimers.current;
				if (timers[field] !== void 0) clearTimeout(timers[field]);
				timers[field] = setTimeout(function () {
					delete timers[field];
					if (op === "unset") scope.unset(field);
					else scope.set(field, val);
				}, 300);
			};
			var setField = (field, val) => {
				setDraft({ ...value, [field]: val });
				scheduleWrite(field, val, "set");
			};
			var unsetField = (field) => {
				setDraft({ ...value, [field]: DEFAULTS[field] });
				scheduleWrite(field, void 0, "unset");
			};
			var preview = (kind) => {
				// Preview always audible regardless of the master switch.
				play(kind, { ...value, enabled: true });
			};
			var ready = snap && snap.status === "ready" && snap.writable !== false;
			return el("div", { className: "dshsn_section" }, [
				el(BackgroundGroup, { value, setField, unsetField }),
				el("div", { className: "dshsn_groupTitle", style: { marginTop: 20 } }, "提示音"),
				el("label", { className: "dshsn_check" }, [
					el("input", {
						type: "checkbox",
						checked: value.enabled !== false,
						onChange: (e) => setField("enabled", e.target.checked)
					}),
					"启用提示音"
				]),
				ready ? null : el("p", { className: "dshsn_warn" },
					"设置服务暂不可用：改动不会被保存。请重启 web 服务（dsh web）后刷新页面。"),
				el("p", { className: "dshsn_note" },
					"背景与主题（设置 → 外观）互补：背景色、图片（URL 或本地文件）与不透明度即时生效；本地文件上传到 $DSH_HOME/sound-notify/。提示音每个触发条件可独立设置音效（内置或自定义音频）、音量、重复次数与间隔；试听按当前配置播放，改动自动保存。"),
				GROUPS.map((group) => el(SoundGroup, {
					key: group.key,
					group,
					value,
					setField,
					preview
				}))
			]);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
