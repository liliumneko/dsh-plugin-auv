import { accessSync, constants, statSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
// \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, flags) => {
	let target = Object.setPrototypeOf({}, null);
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!(flags & 1)) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return flags & 2 ? target : Object.preventExtensions(target);
};
// node_modules/.pnpm/es-toolkit@1.53.2/node_modules/es-toolkit/dist/math/clamp.mjs
/**
* Clamps a number within the specified bounds.
*
* This function takes a number and one or two bounds, and returns the number clamped within the specified bounds.
* If only one bound is provided, it returns the minimum of the value and the bound.
*
* @param value - The number to clamp.
* @param bound1 - The minimum bound to clamp the number, or the maximum bound if bound2 is not provided.
* @param [bound2] - The maximum bound to clamp the number. If not provided, the function will only consider bound1 as the upper limit.
* @returns The clamped number within the specified bounds.
*
* @example
* const result1 = clamp(10, 5); // result1 will be 5, as 10 is clamped to the bound 5
* const result2 = clamp(10, 5, 15); // result2 will be 10, as it is within the bounds 5 and 15
* const result3 = clamp(2, 5, 15); // result3 will be 5, as 2 is clamped to the lower bound 5
* const result4 = clamp(20, 5, 15); // result4 will be 15, as 20 is clamped to the upper bound 15
*/
function clamp(value, bound1, bound2) {
	if (bound2 == null) return Math.min(value, bound1);
	return Math.min(Math.max(value, bound1), bound2);
}
// node_modules/.pnpm/es-toolkit@1.53.2/node_modules/es-toolkit/dist/predicate/isPlainObject.mjs
/**
* Checks if a given value is a plain object.
*
* @param value - The value to check.
* @returns True if the value is a plain object, otherwise false.
*
* @example
* ```typescript
* // ✅👇 True
*
* isPlainObject({ });                       // ✅
* isPlainObject({ key: 'value' });          // ✅
* isPlainObject({ key: new Date() });       // ✅
* isPlainObject(new Object());              // ✅
* isPlainObject(Object.create(null));       // ✅
* isPlainObject({ nested: { key: true} });  // ✅
* isPlainObject(new Proxy({}, {}));         // ✅
* isPlainObject({ [Symbol('tag')]: 'A' });  // ✅
*
* // ✅👇 (cross-realms, node context, workers, ...)
* const runInNewContext = await import('node:vm').then(
*     (mod) => mod.runInNewContext
* );
* isPlainObject(runInNewContext('({})'));   // ✅
*
* // ❌👇 False
*
* class Test { };
* isPlainObject(new Test())           // ❌
* isPlainObject(10);                  // ❌
* isPlainObject(null);                // ❌
* isPlainObject('hello');             // ❌
* isPlainObject([]);                  // ❌
* isPlainObject(new Date());          // ❌
* isPlainObject(new Uint8Array([1])); // ❌
* isPlainObject(Buffer.from('ABC'));  // ❌
* isPlainObject(Promise.resolve({})); // ❌
* isPlainObject(Object.create({}));   // ❌
* isPlainObject(new (class Cls {}));  // ❌
* isPlainObject(globalThis);          // ❌,
* ```
*/
function isPlainObject(value) {
	if (!value || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	if (!(proto === null || proto === Object.prototype || Object.getPrototypeOf(proto) === null)) return false;
	return Object.prototype.toString.call(value) === "[object Object]";
}
// src/auv.mjs
/**
* AUV binary discovery, process runner, and receipt helpers for @local/dsh-auv.
*
* Plain ESM, Node builtins only. Every auv invocation is asynchronous, kills the
* child process on abort, and enforces a bounded timeout and output buffer so a
* hung desktop tool can never block the DSH Host event loop indefinitely.
*/
/** Default per-call timeout. */
const DEFAULT_TIMEOUT_MS = 12e4;
/** Minimum accepted per-call timeout. */
const MIN_TIMEOUT_MS = 1e3;
/** Maximum accepted per-call timeout. */
const MAX_TIMEOUT_MS = 3e5;
const STDOUT_LIMIT_BYTES = 8388608;
const STDERR_TAIL_CHARS = 65536;
const EXTRA_PATH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
let cachedBinary;
/**
* Actionable installation guidance for a missing AUV CLI.
*
* The bundle is only the DeepSeek Harness bridge: the `auv` executable is an
* external prerequisite, so every entry point that can discover the binary must
* fail with install instructions instead of a bare "not found".
*/
const AUV_INSTALL_GUIDANCE = [
	"This DeepSeek Harness plugin is only the bridge: it needs the AUV CLI installed and reachable first.",
	"Install AUV (https://github.com/moeru-ai/auv):",
	"  macOS (Homebrew):   brew install moeru-ai/tap/auv",
	"  macOS / Linux:      curl -fsSL https://auv.moeru.ai/install.sh | sh",
	"  Windows (Scoop):    scoop bucket add auv https://github.com/moeru-ai/auv ; scoop install auv/auv",
	"  proto:              proto plugin add auv \"https://raw.githubusercontent.com/moeru-ai/auv/main/toolchain/proto/auv.toml\" --to global ; proto install auv latest --config-mode global --pin global",
	"Then verify with `auv --version`, grant macOS permissions (see the plugin README), restart DeepSeek Harness, and run auv_doctor.",
	"If AUV is installed outside PATH, set AUV_BIN to the absolute auv executable path."
].join("\n");
/** Error raised for every failed AUV discovery, invocation, or receipt. */
var AuvError = class extends Error {
	/**
	* @param {string} message human-readable failure summary
	* @param {object} [details] structured diagnostics
	* @param {string} [details.code] stable error code
	* @param {object} [details.receipt] failed receipt, when one was printed
	* @param {string} [details.stderr] captured stderr tail
	* @param {string} [details.stdout] captured stdout tail
	*/
	constructor(message, details = {}) {
		super(message);
		this.name = "AuvError";
		this.code = details.code ?? "AUV_ERROR";
		this.receipt = details.receipt;
		this.stderr = details.stderr;
		this.stdout = details.stdout;
	}
};
/** Read a boolean-ish environment flag. */
function envFlag(name) {
	const value = process.env[name];
	return value === "1" || value === "true" || value === "yes";
}
/** Clamp a requested timeout into the supported 1s..300s window. */
function clampTimeout(value) {
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) return DEFAULT_TIMEOUT_MS;
	return clamp(Math.round(number), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
}
/** Whether a path is an existing executable file. */
function isExecutableFile(candidate) {
	try {
		if (!statSync(candidate).isFile()) return false;
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/**
* Resolve the auv executable once and cache it.
*
* Order: AUV_BIN (must exist), then PATH, then common install directories.
* @returns {string} absolute-ish executable path
*/
function resolveAuvBinary() {
	if (cachedBinary !== void 0) return cachedBinary;
	const configured = (process.env.AUV_BIN ?? "").trim();
	if (configured !== "") {
		if (isExecutableFile(configured)) {
			cachedBinary = configured;
			return configured;
		}
		throw new AuvError(`AUV_BIN is set to "${configured}", but that path is not an executable file. Fix AUV_BIN or install AUV.\n\n${AUV_INSTALL_GUIDANCE}`, { code: "AUV_BIN_INVALID" });
	}
	const directories = [];
	for (const entry of (process.env.PATH ?? "").split(path.delimiter)) if (entry !== "") directories.push(entry);
	for (const extra of [
		...EXTRA_PATH_DIRS,
		path.join(os.homedir(), ".local", "bin"),
		path.join(os.homedir(), ".cargo", "bin")
	]) directories.push(extra);
	const seen = /* @__PURE__ */ new Set();
	for (const directory of directories) {
		if (seen.has(directory)) continue;
		seen.add(directory);
		const candidate = path.join(directory, "auv");
		if (isExecutableFile(candidate)) {
			cachedBinary = candidate;
			return candidate;
		}
	}
	throw new AuvError(`AUV was not found on PATH (PATH=${process.env.PATH ?? "<empty>"}).\n\n${AUV_INSTALL_GUIDANCE}`, { code: "AUV_NOT_FOUND" });
}
/** Store root passed to every `auv invoke`; keeps artifact paths stable. */
function defaultStoreRoot() {
	const override = (process.env.AUV_DSH_STORE_ROOT ?? "").trim();
	if (override !== "") return override;
	const dshHome = (process.env.DSH_HOME ?? "").trim() || path.join(os.homedir(), ".dsh");
	return path.join(dshHome, "auv", "runs");
}
/** Child environment: inherited, with a GUI-safe PATH augmentation. */
function childEnvironment() {
	const inherited = process.env.PATH ?? "";
	const prefix = inherited === "" ? EXTRA_PATH_DIRS.join(path.delimiter) : `${inherited}${path.delimiter}${EXTRA_PATH_DIRS.join(path.delimiter)}`;
	return {
		...process.env,
		PATH: prefix
	};
}
/** Keep the last `limit` characters of a diagnostic string. */
function tail(text, limit) {
	if (typeof text !== "string" || text.length <= limit) return text ?? "";
	return `…${text.slice(text.length - limit)}`;
}
/** Extract a permission-oriented hint from an AUV failure message, if any. */
function permissionHint(text) {
	if (typeof text !== "string" || text === "") return void 0;
	if (/vision ocr/i.test(text)) return "Hint: AUV could not run Vision OCR. Confirm Screen Recording is granted to DeepSeek Harness in System Settings → Privacy & Security (macOS 27+: \"Device Control and Data Access\"), restart the app, then run auv_doctor. Some macOS/AUV combinations still fail with \"vision OCR failed: unknownError\"; fall back to auv_screenshot + read_image when that happens.";
	if (!/permission|accessibility|screen recording|screen_recording|tcc|not authorized|not permitted|authorization denied/i.test(text)) return;
	return "Hint: run auv_doctor, then grant Accessibility and Screen Recording to DeepSeek Harness in System Settings → Privacy & Security (macOS 27+ merges them under \"Device Control and Data Access\") and restart the app.";
}
/** First artifact file path in a receipt, or null. */
function artifactPathOf(receipt) {
	const first = (Array.isArray(receipt?.artifacts) ? receipt.artifacts : [])[0];
	return typeof first?.file_path === "string" && first.file_path !== "" ? first.file_path : null;
}
/** Describe an argv without leaking giant values. */
function describeCommand(binary, args) {
	const rendered = args.map((argument) => String(argument).length > 120 ? `${String(argument).slice(0, 117)}…` : String(argument));
	return `${path.basename(binary)} ${rendered.join(" ")}`;
}
/** Build the AUV failure error for a failed receipt. */
function receiptError(receipt, stderr, args, binary) {
	const details = receipt?.failure_details ?? {};
	const summary = typeof receipt?.failure === "string" && receipt.failure !== "" ? receipt.failure : typeof details.message === "string" ? details.message : "unknown failure";
	const code = typeof details.code === "string" ? details.code : "AUV_COMMAND_FAILED";
	let message = `AUV command "${receipt?.command_id ?? "unknown"}" failed: ${summary} (${code})`;
	if (typeof details.message === "string" && details.message !== "" && details.message !== summary) message += `\n${details.message}`;
	message += `\nCommand: ${describeCommand(binary, args)}`;
	const hint = permissionHint(`${summary}\n${details.message ?? ""}`);
	if (hint !== void 0) message += `\n${hint}`;
	const stderrTail = tail(stderr, 2e3);
	if (stderrTail !== "") message += `\nstderr: ${stderrTail}`;
	return new AuvError(message, {
		code,
		receipt,
		stderr,
		stdout: ""
	});
}
/** Build the error for a non-JSON CLI failure (e.g. a clap argument error). */
function cliError(code, signalName, stdout, stderr, binary, args) {
	const stderrTail = tail(stderr, 4e3);
	const stdoutTail = tail(stdout, 2e3);
	let message;
	if (code === 0 && stdout.trim() === "" && stderrTail === "") message = "AUV exited successfully but printed no JSON output (was --json passed?)";
	else message = `AUV exited with code ${code ?? "unknown"}${signalName === null || signalName === void 0 ? "" : ` (signal ${signalName})`}`;
	message += `\nCommand: ${describeCommand(binary, args)}`;
	if (stderrTail !== "") message += `\nstderr: ${stderrTail}`;
	if (stdoutTail !== "") message += `\nstdout: ${stdoutTail}`;
	const hint = permissionHint(`${stderrTail}\n${stdoutTail}`);
	if (hint !== void 0) message += `\n${hint}`;
	return new AuvError(message, {
		code: "AUV_CLI_ERROR",
		stderr,
		stdout
	});
}
/**
* Spawn auv, enforce timeout/abort, capture bounded output, and parse the JSON
* printed on stdout. Never rejects with a non-AuvError.
*/
function spawnAuv(binary, args, options) {
	const { timeoutMs, signal } = options;
	const command = describeCommand(binary, args);
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn(binary, args, {
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				],
				env: childEnvironment(),
				windowsHide: true
			});
		} catch (error) {
			reject(new AuvError(`Failed to start AUV (${binary}): ${error instanceof Error ? error.message : String(error)}`, { code: "AUV_SPAWN_ERROR" }));
			return;
		}
		let stdout = "";
		let stdoutTruncated = false;
		let stderr = "";
		let settled = false;
		let timer;
		const cleanup = () => {
			if (timer !== void 0) clearTimeout(timer);
			if (signal !== void 0) signal.removeEventListener("abort", onAbort);
		};
		const settle = (handler, value) => {
			if (settled) return;
			settled = true;
			cleanup();
			handler(value);
		};
		const kill = () => {
			try {
				child.kill("SIGKILL");
			} catch {}
		};
		const abort = () => {
			kill();
			settle(reject, new AuvError(`AUV call was aborted.\nCommand: ${command}`, { code: "ABORTED" }));
		};
		const onAbort = () => abort();
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			if (stdout.length >= STDOUT_LIMIT_BYTES) {
				stdoutTruncated = true;
				return;
			}
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr = tail(`${stderr}${chunk}`, STDERR_TAIL_CHARS);
		});
		child.on("error", (error) => {
			settle(reject, new AuvError(`Failed to run AUV (${binary}): ${error instanceof Error ? error.message : String(error)}. Install AUV or set AUV_BIN.`, {
				code: "AUV_SPAWN_ERROR",
				stderr
			}));
		});
		child.on("close", (code, signalName) => {
			if (settled) return;
			const text = stdout.trim();
			if (text !== "" && !stdoutTruncated) {
				let parsed;
				try {
					parsed = JSON.parse(text);
				} catch {
					parsed = void 0;
				}
				if (parsed !== void 0) {
					if (parsed !== null && typeof parsed === "object" && typeof parsed.status === "string") {
						if (parsed.status === "failed") {
							settle(reject, receiptError(parsed, stderr, args, binary));
							return;
						}
						settle(resolve, parsed);
						return;
					}
					settle(resolve, parsed);
					return;
				}
			}
			settle(reject, cliError(code, signalName, stdout, stderr, binary, args));
		});
		if (signal !== void 0) {
			if (signal.aborted) {
				abort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
		timer = setTimeout(() => {
			kill();
			const stderrTail = tail(stderr, 2e3);
			let message = `AUV timed out after ${timeoutMs} ms.\nCommand: ${command}`;
			if (stderrTail !== "") message += `\nstderr: ${stderrTail}`;
			settle(reject, new AuvError(message, {
				code: "AUV_TIMEOUT",
				stderr
			}));
		}, timeoutMs);
	});
}
/**
* Run one AUV command.
*
* Invoke mode (`commandId` set) builds:
*   auv [--no-daemon] invoke <commandId> [--store-root PATH] [--target T]
*       [--dry-run] [--no-overlay] --json [argv...]
* Raw mode (`raw: true`) runs `argv` verbatim at the top level, which is how
* `auv doctor --json` is invoked (doctor rejects `--no-daemon`).
*
* @param {object} options
* @param {string} [options.commandId] invoke command id; omit for raw mode
* @param {boolean} [options.raw] run argv as a complete top-level command
* @param {string[]} [options.argv] command arguments
* @param {string} [options.target] already-formatted target (`app:x`/`window:x`/`display:x`)
* @param {boolean} [options.dryRun] add --dry-run
* @param {AbortSignal} [options.signal] caller cancellation
* @param {number} [options.timeoutMs] per-call timeout (clamped 1s..300s)
* @param {string} [options.storeRoot] override the persistent run store root
* @param {boolean} [options.noDaemon] force --no-daemon (defaults to AUV_DSH_NO_DAEMON)
* @param {boolean} [options.noOverlay] default true unless AUV_DSH_OVERLAY is set
* @returns {Promise<object>} parsed JSON (a receipt, or the doctor report)
*/
async function runAuv(options = {}) {
	const { commandId, raw = false, argv = [], target, dryRun = false, signal, timeoutMs = DEFAULT_TIMEOUT_MS, storeRoot = defaultStoreRoot(), noDaemon = envFlag("AUV_DSH_NO_DAEMON"), noOverlay = !envFlag("AUV_DSH_OVERLAY") } = options;
	const binary = resolveAuvBinary();
	const effectiveTimeout = clampTimeout(timeoutMs);
	if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== "string")) throw new AuvError("AUV argv must be an array of strings.", { code: "AUV_BAD_ARGV" });
	let args;
	if (raw) args = [...argv];
	else if (typeof commandId === "string" && commandId !== "") {
		args = [];
		if (noDaemon) args.push("--no-daemon");
		args.push("invoke", commandId);
		if (storeRoot !== "" && storeRoot !== void 0 && storeRoot !== null) args.push("--store-root", storeRoot);
		if (typeof target === "string" && target !== "") args.push("--target", target);
		if (dryRun) args.push("--dry-run");
		if (noOverlay) args.push("--no-overlay");
		args.push("--json", ...argv);
	} else throw new AuvError("runAuv requires a commandId or raw: true.", { code: "AUV_BAD_REQUEST" });
	if (signal !== void 0 && signal.aborted) throw new AuvError("AUV call was aborted before it started.", { code: "ABORTED" });
	return await spawnAuv(binary, args, {
		timeoutMs: effectiveTimeout,
		signal
	});
}
/** Run `auv doctor --json` (never uses --no-daemon; doctor rejects it). */
async function runAuvDoctor(options = {}) {
	return await runAuv({
		raw: true,
		argv: ["doctor", "--json"],
		signal: options.signal,
		timeoutMs: options.timeoutMs
	});
}
// src/catalog-data.mjs
const catalog = {
	"auv_version": "0.0.43",
	"generated_at": "2026-11-07T19:58:51.977Z",
	"generated_by": "tools/generate-catalog.mjs",
	"commands": [
		{
			"id": "accessibility.focusText",
			"namespace": "accessibility",
			"description": "Focus a control in a target app through accessibility, located by its text.",
			"target": {
				"policy": "required",
				"accepted_types": ["application"],
				"required": true
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "partial"
			},
			"runner_support": { "route": "cells" },
			"arguments": [
				{
					"input_key": "query",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "TEXT",
					"help": "Text identifying the input to focus"
				},
				{
					"input_key": "candidate",
					"flag": "--candidate",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "PATH",
					"help": "Exact accessibility path on macOS. Windows accepts query selection only"
				},
				{
					"input_key": "expected-role",
					"flag": "--expected-role",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "ROLE",
					"help": "Programmatic accessibility role used to disambiguate equal query matches"
				}
			],
			"examples": [{
				"cli": "auv invoke accessibility.focusText \"Search\" --target com.apple.TextEdit",
				"call": {
					"command_id": "accessibility.focusText",
					"inputs": { "query": "Search" },
					"target": { "application_id": "com.apple.TextEdit" }
				}
			}]
		},
		{
			"id": "application.activate",
			"namespace": "application",
			"description": "Bring a target app to the foreground before a foreground-dependent step. The target is an application id: a bundle id on macOS, an executable name on Windows (the APP column of window.list, `.exe` optional).",
			"target": {
				"policy": "required",
				"accepted_types": ["application"],
				"required": true
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [],
			"examples": [{
				"cli": "auv invoke application.activate --target com.apple.TextEdit",
				"call": {
					"command_id": "application.activate",
					"inputs": {},
					"target": { "application_id": "com.apple.TextEdit" }
				}
			}]
		},
		{
			"id": "display.capture",
			"namespace": "display",
			"description": "Capture the primary display with its screenshot-to-logical coordinate contract.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "supported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [],
			"examples": [{
				"cli": "auv invoke display.capture",
				"call": {
					"command_id": "display.capture",
					"inputs": {}
				}
			}]
		},
		{
			"id": "display.captureRegion",
			"namespace": "display",
			"description": "Capture one display-contained region and emit its coordinate contract.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "supported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [
				{
					"input_key": "x",
					"flag": "--x",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "X",
					"help": "Region left coordinate in logical display space"
				},
				{
					"input_key": "y",
					"flag": "--y",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "Y",
					"help": "Region top coordinate in logical display space"
				},
				{
					"input_key": "width",
					"flag": "--width",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "WIDTH",
					"help": "Region width; must be greater than zero"
				},
				{
					"input_key": "height",
					"flag": "--height",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "HEIGHT",
					"help": "Region height; must be greater than zero"
				},
				{
					"input_key": "label",
					"flag": "--label",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "LABEL",
					"help": "Human-readable capture label"
				}
			],
			"examples": [{
				"cli": "auv invoke display.captureRegion --x 0 --y 0 --width 800 --height 600",
				"call": {
					"command_id": "display.captureRegion",
					"inputs": {
						"height": "600.0",
						"width": "800.0",
						"x": "0.0",
						"y": "0.0"
					}
				}
			}]
		},
		{
			"id": "display.clickText",
			"namespace": "display",
			"description": "Capture a screenshot, resolve an OCR text anchor, and click its projected logical point. Target activation is not yet available for this command.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "partial"
			},
			"runner_support": { "route": "cells" },
			"arguments": [{
				"input_key": "query",
				"flag": null,
				"kind": "positional",
				"required": true,
				"repeated": false,
				"value_name": "TEXT",
				"help": "Text anchor to click"
			}, {
				"input_key": "within",
				"flag": "--within",
				"kind": "value",
				"required": false,
				"repeated": false,
				"value_name": "LEFT,TOP,RIGHT,BOTTOM",
				"help": "Optional screen-coordinate fence checked against the freshly recognized click point before delivery"
			}],
			"examples": [{
				"cli": "auv invoke display.clickText \"Continue\"",
				"call": {
					"command_id": "display.clickText",
					"inputs": { "query": "Continue" }
				}
			}]
		},
		{
			"id": "display.findText",
			"namespace": "display",
			"description": "Capture a screenshot and locate OCR text anchors in logical screen coordinates. Target activation is not yet available for this command.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "supported",
				"windows": "partial"
			},
			"runner_support": { "route": "direct" },
			"arguments": [{
				"input_key": "query",
				"flag": null,
				"kind": "positional",
				"required": true,
				"repeated": false,
				"value_name": "TEXT",
				"help": "Text to locate in the captured image"
			}],
			"examples": [{
				"cli": "auv invoke display.findText \"Settings\"",
				"call": {
					"command_id": "display.findText",
					"inputs": { "query": "Settings" }
				}
			}, {
				"cli": "auv invoke display.findText \"Settings\" --json",
				"call": {
					"command_id": "display.findText",
					"inputs": { "query": "Settings" }
				}
			}]
		},
		{
			"id": "display.list",
			"namespace": "display",
			"description": "List connected displays using the normalized AUV coordinate contract.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "supported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [],
			"examples": [{
				"cli": "auv invoke display.list --json",
				"call": {
					"command_id": "display.list",
					"inputs": {}
				}
			}]
		},
		{
			"id": "display.waitForText",
			"namespace": "display",
			"description": "Poll live-desktop OCR until a text anchor appears or the timeout expires. Target activation is not yet available for this command.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "supported",
				"windows": "partial"
			},
			"runner_support": { "route": "direct" },
			"arguments": [
				{
					"input_key": "query",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "TEXT",
					"help": "Text to wait for in the captured image"
				},
				{
					"input_key": "timeout-ms",
					"flag": "--timeout-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "MS",
					"help": "Milliseconds to keep polling before failing (default 10000, 100..=120000)"
				},
				{
					"input_key": "interval-ms",
					"flag": "--interval-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "MS",
					"help": "Milliseconds between OCR attempts (default 250, 50..=10000)"
				}
			],
			"examples": [{
				"cli": "auv invoke display.waitForText \"Ready\"",
				"call": {
					"command_id": "display.waitForText",
					"inputs": { "query": "Ready" }
				}
			}, {
				"cli": "auv invoke display.waitForText \"Order confirmed\" --timeout-ms 30000",
				"call": {
					"command_id": "display.waitForText",
					"inputs": {
						"query": "Order confirmed",
						"timeout-ms": "30000"
					}
				}
			}]
		},
		{
			"id": "input.clickPoint",
			"namespace": "input",
			"description": "Click a point relative to the screen, a target window, or a target display.",
			"target": {
				"policy": "optional",
				"accepted_types": [
					"application",
					"window",
					"display"
				],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "partial",
				"windows": "partial"
			},
			"runner_support": { "route": "direct" },
			"arguments": [
				{
					"input_key": "button",
					"flag": "--button",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "BUTTON",
					"help": "Mouse button: left, right, or middle. Defaults to left",
					"possible_values": [
						"left",
						"right",
						"middle"
					]
				},
				{
					"input_key": "x",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "X",
					"help": "X coordinate in the selected coordinate basis"
				},
				{
					"input_key": "y",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "Y",
					"help": "Y coordinate in the selected coordinate basis"
				},
				{
					"input_key": "relative-to",
					"flag": "--relative-to",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "RELATIVE_TO",
					"help": "Coordinate basis. Defaults from --target: screen, window, or display. Use screen with an app or window target for a screen point, such as a display.capture pixel divided by its scale factor plus its capture origin",
					"possible_values": [
						"screen",
						"window",
						"display"
					]
				},
				{
					"input_key": "normalized",
					"flag": "--normalized",
					"kind": "flag",
					"required": false,
					"repeated": false,
					"value_name": null,
					"help": "Interpret X and Y as normalized values in 0..=1"
				},
				{
					"input_key": "title",
					"flag": "--title",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "TEXT",
					"help": "Window title text used with an app target"
				},
				{
					"input_key": "input-policy",
					"flag": "--input-policy",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "INPUT_POLICY",
					"help": "Window input delivery policy. Valid only with an app or window target",
					"possible_values": [
						"background-only",
						"background-preferred",
						"foreground-preferred"
					]
				},
				{
					"input_key": "click-count",
					"flag": "--click-count",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "CLICK_COUNT",
					"help": "Number of consecutive clicks"
				},
				{
					"input_key": "click-interval-ms",
					"flag": "--click-interval-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "CLICK_INTERVAL_MS",
					"help": "Delay between clicks in milliseconds"
				},
				{
					"input_key": "modifiers",
					"flag": "--modifiers",
					"kind": "value",
					"required": false,
					"repeated": true,
					"value_name": "KEYS",
					"help": "Mouse modifiers: shift, control, alt/option, meta/cmd. Repeat this option or separate names with commas"
				}
			],
			"examples": [
				{
					"cli": "auv invoke input.clickPoint 1032.5 1212",
					"call": {
						"command_id": "input.clickPoint",
						"inputs": {
							"button": "left",
							"normalized": "false",
							"x": "1032.5",
							"y": "1212.0"
						}
					}
				},
				{
					"cli": "auv invoke input.clickPoint 0.5 0.5 --target app:com.apple.TextEdit --relative-to window --normalized",
					"call": {
						"command_id": "input.clickPoint",
						"inputs": {
							"button": "left",
							"normalized": "true",
							"relative-to": "window",
							"x": "0.5",
							"y": "0.5"
						},
						"target": { "application_id": "com.apple.TextEdit" }
					}
				},
				{
					"cli": "auv invoke input.clickPoint 640 360 --target app:com.apple.TextEdit --relative-to screen",
					"call": {
						"command_id": "input.clickPoint",
						"inputs": {
							"button": "left",
							"normalized": "false",
							"relative-to": "screen",
							"x": "640.0",
							"y": "360.0"
						},
						"target": { "application_id": "com.apple.TextEdit" }
					}
				}
			]
		},
		{
			"id": "input.dragMouse",
			"namespace": "input",
			"description": "Press a mouse button, move in a straight line, and release it at the end point.",
			"target": {
				"policy": "optional",
				"accepted_types": [
					"application",
					"window",
					"display"
				],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "partial",
				"windows": "partial"
			},
			"runner_support": { "route": "cells" },
			"arguments": [
				{
					"input_key": "start_x",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "START_X",
					"help": "Start X coordinate in the selected coordinate basis"
				},
				{
					"input_key": "start_y",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "START_Y",
					"help": "Start Y coordinate in the selected coordinate basis"
				},
				{
					"input_key": "end_x",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "END_X",
					"help": "End X coordinate in the selected coordinate basis"
				},
				{
					"input_key": "end_y",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "END_Y",
					"help": "End Y coordinate in the selected coordinate basis"
				},
				{
					"input_key": "button",
					"flag": "--button",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "BUTTON",
					"help": "Mouse button held during the drag: left, right, or middle. Defaults to left",
					"possible_values": [
						"left",
						"right",
						"middle"
					]
				},
				{
					"input_key": "relative-to",
					"flag": "--relative-to",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "RELATIVE_TO",
					"help": "Coordinate basis. Defaults from --target: screen, window, or display. Use screen with an app or window target for a screen point, such as a display.capture pixel divided by its scale factor plus its capture origin",
					"possible_values": [
						"screen",
						"window",
						"display"
					]
				},
				{
					"input_key": "normalized",
					"flag": "--normalized",
					"kind": "flag",
					"required": false,
					"repeated": false,
					"value_name": null,
					"help": "Interpret all coordinates as normalized values in 0..=1"
				},
				{
					"input_key": "title",
					"flag": "--title",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "TEXT",
					"help": "Window title text used with an app target"
				},
				{
					"input_key": "input-policy",
					"flag": "--input-policy",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "INPUT_POLICY",
					"help": "Window input delivery policy. Valid only with an app or window target",
					"possible_values": [
						"background-only",
						"background-preferred",
						"foreground-preferred"
					]
				},
				{
					"input_key": "duration-ms",
					"flag": "--duration-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "DURATION_MS",
					"help": "Pointer travel time from start to end in milliseconds (0..=30000)"
				}
			],
			"examples": [
				{
					"cli": "auv invoke input.dragMouse 400 300 700 300",
					"call": {
						"command_id": "input.dragMouse",
						"inputs": {
							"button": "left",
							"duration-ms": "300",
							"end_x": "700.0",
							"end_y": "300.0",
							"normalized": "false",
							"start_x": "400.0",
							"start_y": "300.0"
						}
					}
				},
				{
					"cli": "auv invoke input.dragMouse 0.2 0.5 0.8 0.5 --target app:com.apple.TextEdit --relative-to window --normalized",
					"call": {
						"command_id": "input.dragMouse",
						"inputs": {
							"button": "left",
							"duration-ms": "300",
							"end_x": "0.8",
							"end_y": "0.5",
							"normalized": "true",
							"relative-to": "window",
							"start_x": "0.2",
							"start_y": "0.5"
						},
						"target": { "application_id": "com.apple.TextEdit" }
					}
				},
				{
					"cli": "auv invoke input.dragMouse 20 38 380 38 --target app:com.apple.TextEdit --input-policy foreground-preferred",
					"call": {
						"command_id": "input.dragMouse",
						"inputs": {
							"button": "left",
							"duration-ms": "300",
							"end_x": "380.0",
							"end_y": "38.0",
							"input-policy": "foreground-preferred",
							"normalized": "false",
							"start_x": "20.0",
							"start_y": "38.0"
						},
						"target": { "application_id": "com.apple.TextEdit" }
					}
				}
			]
		},
		{
			"id": "input.getPointerPosition",
			"namespace": "input",
			"description": "Read the OS pointer position in logical screen coordinates without delivering input.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [],
			"examples": [{
				"cli": "auv invoke input.getPointerPosition --json",
				"call": {
					"command_id": "input.getPointerPosition",
					"inputs": {}
				}
			}]
		},
		{
			"id": "input.holdKeys",
			"namespace": "input",
			"description": "Hold one key combination for a bounded duration, then release it. Delivery does not verify application effects.",
			"target": {
				"policy": "optional",
				"accepted_types": ["application", "window"],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "partial",
				"windows": "partial"
			},
			"runner_support": { "route": "direct" },
			"arguments": [
				{
					"input_key": "keys",
					"flag": null,
					"kind": "positional",
					"required": false,
					"repeated": true,
					"value_name": "KEY",
					"help": "One key combination. Modifiers precede ordinary keys"
				},
				{
					"input_key": "duration-ms",
					"flag": "--duration-ms",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "DURATION_MS",
					"help": "Time between key down and release, in milliseconds (1..=30000)"
				},
				{
					"input_key": "input-policy",
					"flag": "--input-policy",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "INPUT_POLICY",
					"help": "Foreground prepares focus; background modes require an application or window target",
					"possible_values": [
						"background-only",
						"background-preferred",
						"foreground-preferred"
					]
				}
			],
			"examples": [{
				"cli": "auv invoke input.holdKeys shift --duration-ms 800",
				"call": {
					"command_id": "input.holdKeys",
					"inputs": {
						"duration-ms": "800",
						"keys": "[\"shift\"]"
					}
				}
			}]
		},
		{
			"id": "input.moveMouse",
			"namespace": "input",
			"description": "Move the pointer to a logical screen coordinate without activating it.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "supported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [{
				"input_key": "x",
				"flag": null,
				"kind": "positional",
				"required": true,
				"repeated": false,
				"value_name": "X",
				"help": "Logical screen X coordinate"
			}, {
				"input_key": "y",
				"flag": null,
				"kind": "positional",
				"required": true,
				"repeated": false,
				"value_name": "Y",
				"help": "Logical screen Y coordinate"
			}],
			"examples": [{
				"cli": "auv invoke input.moveMouse 1032.5 1212",
				"call": {
					"command_id": "input.moveMouse",
					"inputs": {
						"x": "1032.5",
						"y": "1212.0"
					}
				}
			}]
		},
		{
			"id": "input.pasteText",
			"namespace": "input",
			"description": "Paste text into the active control through the clipboard, then restore the prior clipboard snapshot.",
			"target": {
				"policy": "optional",
				"accepted_types": ["application", "window"],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "partial",
				"windows": "partial"
			},
			"runner_support": { "route": "direct" },
			"arguments": [{
				"input_key": "input-policy",
				"flag": "--input-policy",
				"kind": "value",
				"required": false,
				"repeated": false,
				"value_name": "INPUT_POLICY",
				"help": "Target delivery policy. Foreground prepares focus; background modes do not activate or automatically fall back",
				"possible_values": [
					"background-only",
					"background-preferred",
					"foreground-preferred"
				]
			}, {
				"input_key": "text",
				"flag": null,
				"kind": "positional",
				"required": true,
				"repeated": false,
				"value_name": "TEXT",
				"help": "Text to paste into the active control"
			}],
			"examples": [{
				"cli": "auv invoke input.pasteText \"hello from AUV\"",
				"call": {
					"command_id": "input.pasteText",
					"inputs": { "text": "hello from AUV" }
				}
			}]
		},
		{
			"id": "input.performKeyboardInputs",
			"namespace": "input",
			"description": "Execute ordered keyboard actions. Stops on failure with partial progress; delivery does not verify control effects.",
			"target": {
				"policy": "optional",
				"accepted_types": ["application", "window"],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "partial",
				"windows": "partial"
			},
			"runner_support": { "route": "direct" },
			"arguments": [{
				"input_key": "actions",
				"flag": "--actions",
				"kind": "value",
				"required": true,
				"repeated": false,
				"value_name": "JSON",
				"help": "JSON array: press {keys, count?, interval_ms?}, type_text {text}, or paste_text {text}; each object requires kind"
			}, {
				"input_key": "input-policy",
				"flag": "--input-policy",
				"kind": "value",
				"required": false,
				"repeated": false,
				"value_name": "INPUT_POLICY",
				"help": "Apply this policy to every action; foreground preparation is the default",
				"possible_values": [
					"background-only",
					"background-preferred",
					"foreground-preferred"
				]
			}],
			"examples": [{
				"cli": "auv invoke input.performKeyboardInputs --actions '[{\"kind\":\"press\",\"keys\":[\"cmd\",\"a\"]},{\"kind\":\"type_text\",\"text\":\"hello\"}]' --target app:com.netease.163music",
				"call": {
					"command_id": "input.performKeyboardInputs",
					"inputs": { "actions": "[{\"kind\":\"press\",\"keys\":[\"cmd\",\"a\"]},{\"kind\":\"type_text\",\"text\":\"hello\"}]" },
					"target": { "application_id": "com.netease.163music" }
				}
			}]
		},
		{
			"id": "input.pressKeys",
			"namespace": "input",
			"description": "Press and release one key combination such as [\"ctrl\",\"l\"], optionally repeated. Keys are released in reverse order; effects remain unverified.",
			"target": {
				"policy": "optional",
				"accepted_types": ["application", "window"],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "partial",
				"windows": "partial"
			},
			"runner_support": { "route": "direct" },
			"arguments": [
				{
					"input_key": "keys",
					"flag": null,
					"kind": "positional",
					"required": false,
					"repeated": true,
					"value_name": "KEY",
					"help": "One key combination: key names or ANSI characters. Modifiers precede ordinary keys. MCP inputs encode this list as a JSON array string"
				},
				{
					"input_key": "input-policy",
					"flag": "--input-policy",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "INPUT_POLICY",
					"help": "Foreground prepares focus; background modes do not activate or automatically fall back",
					"possible_values": [
						"background-only",
						"background-preferred",
						"foreground-preferred"
					]
				},
				{
					"input_key": "count",
					"flag": "--count",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "COUNT",
					"help": "Number of complete presses, 1..255. Repetition requires --interval-ms"
				},
				{
					"input_key": "interval-ms",
					"flag": "--interval-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "INTERVAL_MS",
					"help": "Interval between complete presses in milliseconds; no delay after the last"
				}
			],
			"examples": [{
				"cli": "auv invoke input.pressKeys cmd shift p",
				"call": {
					"command_id": "input.pressKeys",
					"inputs": { "keys": "[\"cmd\",\"shift\",\"p\"]" }
				}
			}, {
				"cli": "auv invoke input.pressKeys return --count 2 --interval-ms 100",
				"call": {
					"command_id": "input.pressKeys",
					"inputs": {
						"count": "2",
						"interval-ms": "100",
						"keys": "[\"return\"]"
					}
				}
			}]
		},
		{
			"id": "input.scrollPoint",
			"namespace": "input",
			"description": "Scroll at a logical screen point by delta_x/delta_y pixels (positive delta_y scrolls down). Needs no target; use it when no app or window target is known.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "unsupported",
				"linux": "supported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [
				{
					"input_key": "x",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "X",
					"help": "Logical screen X coordinate"
				},
				{
					"input_key": "y",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "Y",
					"help": "Logical screen Y coordinate"
				},
				{
					"input_key": "delta_x",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "DELTA_X",
					"help": "Horizontal logical pixels; positive scrolls right"
				},
				{
					"input_key": "delta_y",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "DELTA_Y",
					"help": "Vertical logical pixels; positive scrolls down"
				},
				{
					"input_key": "settle-ms",
					"flag": "--settle-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "SETTLE_MS",
					"help": "Delay after delivery in milliseconds"
				}
			],
			"examples": [{
				"cli": "auv invoke input.scrollPoint 640 360 0 120",
				"call": {
					"command_id": "input.scrollPoint",
					"inputs": {
						"delta_x": "0.0",
						"delta_y": "120.0",
						"settle-ms": "0",
						"x": "640.0",
						"y": "360.0"
					}
				}
			}],
			"support_note": { "macos": "the driver exposes only window-owned scrolling" }
		},
		{
			"id": "input.typeText",
			"namespace": "input",
			"description": "Type text into the active control through the platform input driver.",
			"target": {
				"policy": "optional",
				"accepted_types": ["application", "window"],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "partial",
				"windows": "partial"
			},
			"runner_support": { "route": "direct" },
			"arguments": [{
				"input_key": "input-policy",
				"flag": "--input-policy",
				"kind": "value",
				"required": false,
				"repeated": false,
				"value_name": "INPUT_POLICY",
				"help": "Target delivery policy. Foreground prepares focus; background modes do not activate or automatically fall back",
				"possible_values": [
					"background-only",
					"background-preferred",
					"foreground-preferred"
				]
			}, {
				"input_key": "text",
				"flag": null,
				"kind": "positional",
				"required": true,
				"repeated": false,
				"value_name": "TEXT",
				"help": "Text to type into the active control"
			}],
			"examples": [{
				"cli": "auv invoke input.typeText \"hello from AUV\"",
				"call": {
					"command_id": "input.typeText",
					"inputs": { "text": "hello from AUV" }
				}
			}]
		},
		{
			"id": "media.getNowPlaying",
			"namespace": "media",
			"description": "Read structured now-playing media state from the desktop backend.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "partial"
			},
			"runner_support": { "route": "direct" },
			"arguments": [],
			"examples": [{
				"cli": "auv invoke media.getNowPlaying",
				"call": {
					"command_id": "media.getNowPlaying",
					"inputs": {}
				}
			}]
		},
		{
			"id": "media.pause",
			"namespace": "media",
			"description": "Send a generic system media pause command and read now-playing state for verification.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [],
			"examples": [{
				"cli": "auv invoke media.pause",
				"call": {
					"command_id": "media.pause",
					"inputs": {}
				}
			}]
		},
		{
			"id": "media.play",
			"namespace": "media",
			"description": "Send a generic system media play command and read now-playing state for verification.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [],
			"examples": [{
				"cli": "auv invoke media.play",
				"call": {
					"command_id": "media.play",
					"inputs": {}
				}
			}]
		},
		{
			"id": "media.skipToNextTrack",
			"namespace": "media",
			"description": "Send a generic system media next-track command and compare now-playing identity before and after.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [],
			"examples": [{
				"cli": "auv invoke media.skipToNextTrack",
				"call": {
					"command_id": "media.skipToNextTrack",
					"inputs": {}
				}
			}]
		},
		{
			"id": "media.skipToPreviousTrack",
			"namespace": "media",
			"description": "Send a generic system media previous-track command and compare now-playing identity before and after.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [],
			"examples": [{
				"cli": "auv invoke media.skipToPreviousTrack",
				"call": {
					"command_id": "media.skipToPreviousTrack",
					"inputs": {}
				}
			}]
		},
		{
			"id": "media.togglePlayback",
			"namespace": "media",
			"description": "Send a generic system media play/pause toggle command and compare now-playing state before and after.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [],
			"examples": [{
				"cli": "auv invoke media.togglePlayback",
				"call": {
					"command_id": "media.togglePlayback",
					"inputs": {}
				}
			}]
		},
		{
			"id": "overlay.captureFrame",
			"namespace": "overlay",
			"description": "Present the reusable capture-frame component around a screen rectangle.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "unsupported"
			},
			"runner_support": { "route": "cells" },
			"arguments": [
				{
					"input_key": "x",
					"flag": "--x",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "X",
					"help": ""
				},
				{
					"input_key": "y",
					"flag": "--y",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "Y",
					"help": ""
				},
				{
					"input_key": "width",
					"flag": "--width",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "WIDTH",
					"help": ""
				},
				{
					"input_key": "height",
					"flag": "--height",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "HEIGHT",
					"help": ""
				},
				{
					"input_key": "label",
					"flag": "--label",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "LABEL",
					"help": ""
				},
				{
					"input_key": "label-visible",
					"flag": "--label-visible",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "LABEL_VISIBLE",
					"help": "",
					"possible_values": ["true", "false"]
				},
				{
					"input_key": "padding",
					"flag": "--padding",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "PADDING",
					"help": ""
				},
				{
					"input_key": "border-color",
					"flag": "--border-color",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "BORDER_COLOR",
					"help": ""
				},
				{
					"input_key": "border-width",
					"flag": "--border-width",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "BORDER_WIDTH",
					"help": ""
				},
				{
					"input_key": "corner-radius",
					"flag": "--corner-radius",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "CORNER_RADIUS",
					"help": ""
				},
				{
					"input_key": "motion-duration-ms",
					"flag": "--motion-duration-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "MOTION_DURATION_MS",
					"help": ""
				},
				{
					"input_key": "hold-duration-ms",
					"flag": "--hold-duration-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "HOLD_DURATION_MS",
					"help": ""
				}
			],
			"examples": [{
				"cli": "auv invoke overlay.captureFrame --x 20 --y 20 --width 800 --height 600",
				"call": {
					"command_id": "overlay.captureFrame",
					"inputs": {
						"height": "600.0",
						"width": "800.0",
						"x": "20.0",
						"y": "20.0"
					}
				}
			}]
		},
		{
			"id": "overlay.clickTarget",
			"namespace": "overlay",
			"description": "Present the reusable click-target component with outline, cursor, and status layers.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "unsupported"
			},
			"runner_support": { "route": "cells" },
			"arguments": [
				{
					"input_key": "x",
					"flag": "--x",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "X",
					"help": ""
				},
				{
					"input_key": "y",
					"flag": "--y",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "Y",
					"help": ""
				},
				{
					"input_key": "width",
					"flag": "--width",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "WIDTH",
					"help": ""
				},
				{
					"input_key": "height",
					"flag": "--height",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "HEIGHT",
					"help": ""
				},
				{
					"input_key": "outline-label",
					"flag": "--outline-label",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "OUTLINE_LABEL",
					"help": ""
				},
				{
					"input_key": "outline-label-visible",
					"flag": "--outline-label-visible",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "OUTLINE_LABEL_VISIBLE",
					"help": "",
					"possible_values": ["true", "false"]
				},
				{
					"input_key": "cursor-label",
					"flag": "--cursor-label",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "CURSOR_LABEL",
					"help": ""
				},
				{
					"input_key": "cursor-label-visible",
					"flag": "--cursor-label-visible",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "CURSOR_LABEL_VISIBLE",
					"help": "",
					"possible_values": ["true", "false"]
				},
				{
					"input_key": "status",
					"flag": "--status",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "STATUS",
					"help": ""
				},
				{
					"input_key": "outline-padding",
					"flag": "--outline-padding",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "OUTLINE_PADDING",
					"help": ""
				},
				{
					"input_key": "border-color",
					"flag": "--border-color",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "BORDER_COLOR",
					"help": ""
				},
				{
					"input_key": "border-width",
					"flag": "--border-width",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "BORDER_WIDTH",
					"help": ""
				},
				{
					"input_key": "outline-corner-radius",
					"flag": "--outline-corner-radius",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "OUTLINE_CORNER_RADIUS",
					"help": ""
				},
				{
					"input_key": "status-padding",
					"flag": "--status-padding",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "STATUS_PADDING",
					"help": ""
				},
				{
					"input_key": "status-foreground-color",
					"flag": "--status-foreground-color",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "STATUS_FOREGROUND_COLOR",
					"help": ""
				},
				{
					"input_key": "status-background-color",
					"flag": "--status-background-color",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "STATUS_BACKGROUND_COLOR",
					"help": ""
				},
				{
					"input_key": "status-corner-radius",
					"flag": "--status-corner-radius",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "STATUS_CORNER_RADIUS",
					"help": ""
				},
				{
					"input_key": "motion-duration-ms",
					"flag": "--motion-duration-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "MOTION_DURATION_MS",
					"help": ""
				},
				{
					"input_key": "hold-duration-ms",
					"flag": "--hold-duration-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "HOLD_DURATION_MS",
					"help": ""
				}
			],
			"examples": [{
				"cli": "auv invoke overlay.clickTarget --x 20 --y 20 --width 200 --height 80 --status Ready",
				"call": {
					"command_id": "overlay.clickTarget",
					"inputs": {
						"height": "80.0",
						"status": "Ready",
						"width": "200.0",
						"x": "20.0",
						"y": "20.0"
					}
				}
			}]
		},
		{
			"id": "overlay.cursor",
			"namespace": "overlay",
			"description": "Present one configurable cursor layer, optionally using runtime SVG source.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "unsupported"
			},
			"runner_support": { "route": "cells" },
			"arguments": [
				{
					"input_key": "x",
					"flag": "--x",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "X",
					"help": ""
				},
				{
					"input_key": "y",
					"flag": "--y",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "Y",
					"help": ""
				},
				{
					"input_key": "label",
					"flag": "--label",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "LABEL",
					"help": ""
				},
				{
					"input_key": "label-visible",
					"flag": "--label-visible",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "LABEL_VISIBLE",
					"help": "",
					"possible_values": ["true", "false"]
				},
				{
					"input_key": "svg",
					"flag": "--svg",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "SVG",
					"help": ""
				},
				{
					"input_key": "padding",
					"flag": "--padding",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "PADDING",
					"help": ""
				},
				{
					"input_key": "foreground-color",
					"flag": "--foreground-color",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "FOREGROUND_COLOR",
					"help": ""
				},
				{
					"input_key": "background-color",
					"flag": "--background-color",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "BACKGROUND_COLOR",
					"help": ""
				},
				{
					"input_key": "corner-radius",
					"flag": "--corner-radius",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "CORNER_RADIUS",
					"help": ""
				},
				{
					"input_key": "sprite-size",
					"flag": "--sprite-size",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "SPRITE_SIZE",
					"help": ""
				},
				{
					"input_key": "motion-duration-ms",
					"flag": "--motion-duration-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "MOTION_DURATION_MS",
					"help": ""
				},
				{
					"input_key": "hold-duration-ms",
					"flag": "--hold-duration-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "HOLD_DURATION_MS",
					"help": ""
				}
			],
			"examples": [{
				"cli": "auv invoke overlay.cursor --x 320 --y 240 --label AUV",
				"call": {
					"command_id": "overlay.cursor",
					"inputs": {
						"label": "AUV",
						"x": "320.0",
						"y": "240.0"
					}
				}
			}]
		},
		{
			"id": "overlay.outline",
			"namespace": "overlay",
			"description": "Present one configurable outline layer for visual style inspection.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "unsupported"
			},
			"runner_support": { "route": "cells" },
			"arguments": [
				{
					"input_key": "x",
					"flag": "--x",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "X",
					"help": ""
				},
				{
					"input_key": "y",
					"flag": "--y",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "Y",
					"help": ""
				},
				{
					"input_key": "width",
					"flag": "--width",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "WIDTH",
					"help": ""
				},
				{
					"input_key": "height",
					"flag": "--height",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "HEIGHT",
					"help": ""
				},
				{
					"input_key": "label",
					"flag": "--label",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "LABEL",
					"help": ""
				},
				{
					"input_key": "label-visible",
					"flag": "--label-visible",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "LABEL_VISIBLE",
					"help": "",
					"possible_values": ["true", "false"]
				},
				{
					"input_key": "padding",
					"flag": "--padding",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "PADDING",
					"help": ""
				},
				{
					"input_key": "border-color",
					"flag": "--border-color",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "BORDER_COLOR",
					"help": ""
				},
				{
					"input_key": "border-width",
					"flag": "--border-width",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "BORDER_WIDTH",
					"help": ""
				},
				{
					"input_key": "corner-radius",
					"flag": "--corner-radius",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "CORNER_RADIUS",
					"help": ""
				},
				{
					"input_key": "motion-duration-ms",
					"flag": "--motion-duration-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "MOTION_DURATION_MS",
					"help": ""
				},
				{
					"input_key": "hold-duration-ms",
					"flag": "--hold-duration-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "HOLD_DURATION_MS",
					"help": ""
				}
			],
			"examples": [{
				"cli": "auv invoke overlay.outline --x 20 --y 20 --width 400 --height 240 --label Selection",
				"call": {
					"command_id": "overlay.outline",
					"inputs": {
						"height": "240.0",
						"label": "Selection",
						"width": "400.0",
						"x": "20.0",
						"y": "20.0"
					}
				}
			}]
		},
		{
			"id": "overlay.status",
			"namespace": "overlay",
			"description": "Present one configurable status layer for visual style inspection.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "unsupported"
			},
			"runner_support": { "route": "cells" },
			"arguments": [
				{
					"input_key": "x",
					"flag": "--x",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "X",
					"help": ""
				},
				{
					"input_key": "y",
					"flag": "--y",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "Y",
					"help": ""
				},
				{
					"input_key": "text",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "TEXT",
					"help": "Status text to present"
				},
				{
					"input_key": "padding",
					"flag": "--padding",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "PADDING",
					"help": ""
				},
				{
					"input_key": "foreground-color",
					"flag": "--foreground-color",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "FOREGROUND_COLOR",
					"help": ""
				},
				{
					"input_key": "background-color",
					"flag": "--background-color",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "BACKGROUND_COLOR",
					"help": ""
				},
				{
					"input_key": "corner-radius",
					"flag": "--corner-radius",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "CORNER_RADIUS",
					"help": ""
				},
				{
					"input_key": "motion-duration-ms",
					"flag": "--motion-duration-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "MOTION_DURATION_MS",
					"help": ""
				},
				{
					"input_key": "hold-duration-ms",
					"flag": "--hold-duration-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "HOLD_DURATION_MS",
					"help": ""
				}
			],
			"examples": [{
				"cli": "auv invoke overlay.status \"Click delivered\" --x 320 --y 240",
				"call": {
					"command_id": "overlay.status",
					"inputs": {
						"text": "Click delivered",
						"x": "320.0",
						"y": "240.0"
					}
				}
			}]
		},
		{
			"id": "permission.probe",
			"namespace": "permission",
			"description": "Probe macOS screen recording, accessibility, and automation permissions.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "unsupported"
			},
			"runner_support": { "route": "cells" },
			"arguments": [],
			"examples": [{
				"cli": "auv invoke permission.probe",
				"call": {
					"command_id": "permission.probe",
					"inputs": {}
				}
			}]
		},
		{
			"id": "scan.coverage",
			"namespace": "scan",
			"description": "Evaluate typed scan coverage from a fixture and record it in the active run.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "supported",
				"windows": "supported"
			},
			"runner_support": { "route": "no_route" },
			"arguments": [{
				"input_key": "fixture-dir",
				"flag": "--fixture-dir",
				"kind": "value",
				"required": true,
				"repeated": false,
				"value_name": "PATH",
				"help": "Directory containing a coverage scenario manifest; frame PNGs are resolved through its frame_fixture cross-reference"
			}],
			"examples": [{
				"cli": "auv invoke scan.coverage --fixture-dir fixtures/coverage --json",
				"call": {
					"command_id": "scan.coverage",
					"inputs": { "fixture-dir": "fixtures/coverage" }
				}
			}]
		},
		{
			"id": "scan.frame",
			"namespace": "scan",
			"description": "Produce a single scan-frame-v0 artifact bundle from a hermetic fixture directory and stage it into the run.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "supported",
				"windows": "supported"
			},
			"runner_support": { "route": "no_route" },
			"arguments": [{
				"input_key": "fixture-dir",
				"flag": "--fixture-dir",
				"kind": "value",
				"required": true,
				"repeated": false,
				"value_name": "PATH",
				"help": "Directory containing a single-frame scan fixture"
			}, {
				"input_key": "label",
				"flag": "--label",
				"kind": "value",
				"required": false,
				"repeated": false,
				"value_name": "LABEL",
				"help": "Human-readable label for this scan fixture invocation"
			}],
			"examples": [{
				"cli": "auv invoke scan.frame --fixture-dir fixtures/frame --label baseline",
				"call": {
					"command_id": "scan.frame",
					"inputs": {
						"fixture-dir": "fixtures/frame",
						"label": "baseline"
					}
				}
			}]
		},
		{
			"id": "window.capture",
			"namespace": "window",
			"description": "Capture one single-display window without activating it and emit a coordinate contract. Linux uses an AT-SPI display crop; Windows uses PrintWindow.",
			"target": {
				"policy": "optional",
				"accepted_types": ["application"],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "supported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [{
				"input_key": "title",
				"flag": "--title",
				"kind": "value",
				"required": false,
				"repeated": false,
				"value_name": "TEXT",
				"help": "Window title text used to select the capture target"
			}],
			"examples": [
				{
					"cli": "auv invoke window.capture --title Untitled",
					"call": {
						"command_id": "window.capture",
						"inputs": { "title": "Untitled" }
					}
				},
				{
					"cli": "auv invoke window.capture --target com.apple.TextEdit --title Untitled",
					"call": {
						"command_id": "window.capture",
						"inputs": { "title": "Untitled" },
						"target": { "application_id": "com.apple.TextEdit" }
					}
				},
				{
					"cli": "auv invoke window.capture --target notepad.exe",
					"call": {
						"command_id": "window.capture",
						"inputs": {},
						"target": { "application_id": "notepad.exe" }
					}
				}
			]
		},
		{
			"id": "window.clickText",
			"namespace": "window",
			"description": "Capture a resolved window, resolve an OCR text anchor, and click the match point in logical screen coordinates.",
			"target": {
				"policy": "optional",
				"accepted_types": ["application"],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "partial"
			},
			"runner_support": { "route": "cells" },
			"arguments": [
				{
					"input_key": "query",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "TEXT",
					"help": "Text anchor to click in the selected window"
				},
				{
					"input_key": "title",
					"flag": "--title",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "TITLE",
					"help": "Window title text used to select the capture target"
				},
				{
					"input_key": "index",
					"flag": "--index",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "INDEX",
					"help": "Zero-based OCR candidate index from this invocation's capture"
				},
				{
					"input_key": "input-policy",
					"flag": "--input-policy",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "INPUT_POLICY",
					"help": "Driver policy used to deliver the click",
					"possible_values": [
						"background-only",
						"background-preferred",
						"foreground-preferred"
					]
				},
				{
					"input_key": "click-count",
					"flag": "--click-count",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "CLICK_COUNT",
					"help": "Number of clicks to deliver"
				},
				{
					"input_key": "click-interval-ms",
					"flag": "--click-interval-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "CLICK_INTERVAL_MS",
					"help": "Delay between repeated clicks"
				}
			],
			"examples": [{
				"cli": "auv invoke window.clickText \"Continue\" --title Setup",
				"call": {
					"command_id": "window.clickText",
					"inputs": {
						"index": "0",
						"query": "Continue",
						"title": "Setup"
					}
				}
			}, {
				"cli": "auv invoke window.clickText \"AGENTS.md\" --index 1",
				"call": {
					"command_id": "window.clickText",
					"inputs": {
						"index": "1",
						"query": "AGENTS.md"
					}
				}
			}]
		},
		{
			"id": "window.findText",
			"namespace": "window",
			"description": "Capture a resolved window and locate OCR text anchors in logical screen coordinates.",
			"target": {
				"policy": "optional",
				"accepted_types": ["application"],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "supported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [{
				"input_key": "query",
				"flag": null,
				"kind": "positional",
				"required": true,
				"repeated": false,
				"value_name": "TEXT",
				"help": "Text to locate in the selected window"
			}, {
				"input_key": "title",
				"flag": "--title",
				"kind": "value",
				"required": false,
				"repeated": false,
				"value_name": "TITLE",
				"help": "Window title text used to select the capture target"
			}],
			"examples": [{
				"cli": "auv invoke window.findText \"Settings\" --title Preferences",
				"call": {
					"command_id": "window.findText",
					"inputs": {
						"query": "Settings",
						"title": "Preferences"
					}
				}
			}]
		},
		{
			"id": "window.focus",
			"namespace": "window",
			"description": "Raise one window and give it keyboard focus, bringing its application to the front; report the focus disturbance and whether it is focused afterwards.",
			"target": {
				"policy": "required",
				"accepted_types": ["application", "window"],
				"required": true
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [{
				"input_key": "title",
				"flag": "--title",
				"kind": "value",
				"required": false,
				"repeated": false,
				"value_name": "TEXT",
				"help": "Window title text used with an app target"
			}],
			"examples": [{
				"cli": "auv invoke window.focus --target window:1234",
				"call": {
					"command_id": "window.focus",
					"inputs": {},
					"target": { "window_id": "1234" }
				}
			}]
		},
		{
			"id": "window.get",
			"namespace": "window",
			"description": "Read one window fresh: its frame and state (minimized, maximized, focused, stacking, desktop).",
			"target": {
				"policy": "required",
				"accepted_types": ["application", "window"],
				"required": true
			},
			"support": {
				"macos": "supported",
				"linux": "supported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [{
				"input_key": "title",
				"flag": "--title",
				"kind": "value",
				"required": false,
				"repeated": false,
				"value_name": "TEXT",
				"help": "Window title text used with an app target"
			}],
			"examples": [{
				"cli": "auv invoke window.get --target window:1234",
				"call": {
					"command_id": "window.get",
					"inputs": {},
					"target": { "window_id": "1234" }
				}
			}, {
				"cli": "auv invoke window.get --target app:com.apple.TextEdit",
				"call": {
					"command_id": "window.get",
					"inputs": {},
					"target": { "application_id": "com.apple.TextEdit" }
				}
			}]
		},
		{
			"id": "window.list",
			"namespace": "window",
			"description": "List the windows a user could switch to, minimized windows and windows on other desktops included, with frames and state.",
			"target": {
				"policy": "forbidden",
				"accepted_types": [],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "supported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [{
				"input_key": "exclude-minimized",
				"flag": "--exclude-minimized",
				"kind": "flag",
				"required": false,
				"repeated": false,
				"value_name": null,
				"help": "Leave out minimized windows"
			}, {
				"input_key": "exclude-other-desktops",
				"flag": "--exclude-other-desktops",
				"kind": "flag",
				"required": false,
				"repeated": false,
				"value_name": null,
				"help": "Leave out windows known to be on another virtual desktop"
			}],
			"examples": [{
				"cli": "auv invoke window.list --wide",
				"call": {
					"command_id": "window.list",
					"inputs": {
						"exclude-minimized": "false",
						"exclude-other-desktops": "false"
					}
				}
			}, {
				"cli": "auv invoke window.list --exclude-minimized",
				"call": {
					"command_id": "window.list",
					"inputs": {
						"exclude-minimized": "true",
						"exclude-other-desktops": "false"
					}
				}
			}]
		},
		{
			"id": "window.scroll",
			"namespace": "window",
			"description": "Scroll at a point in a target window by logical-pixel deltas (positive dy scrolls down). Requires an app or window target; without one, use input.scrollPoint.",
			"target": {
				"policy": "required",
				"accepted_types": ["application", "window"],
				"required": true
			},
			"support": {
				"macos": "supported",
				"linux": "partial",
				"windows": "partial"
			},
			"runner_support": { "route": "direct" },
			"arguments": [
				{
					"input_key": "x",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "X",
					"help": "X coordinate inside the target window"
				},
				{
					"input_key": "y",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "Y",
					"help": "Y coordinate inside the target window"
				},
				{
					"input_key": "dx",
					"flag": "--dx",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "DX",
					"help": "Horizontal delta in logical pixels; positive scrolls right"
				},
				{
					"input_key": "dy",
					"flag": "--dy",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "DY",
					"help": "Vertical delta in logical pixels; positive scrolls down"
				},
				{
					"input_key": "normalized",
					"flag": "--normalized",
					"kind": "flag",
					"required": false,
					"repeated": false,
					"value_name": null,
					"help": "Interpret X and Y as normalized values in 0..=1"
				},
				{
					"input_key": "title",
					"flag": "--title",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "TEXT",
					"help": "Window title text used with an app target"
				},
				{
					"input_key": "input-policy",
					"flag": "--input-policy",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "INPUT_POLICY",
					"help": "Window input delivery policy. Defaults to background-preferred",
					"possible_values": [
						"background-only",
						"background-preferred",
						"foreground-preferred"
					]
				},
				{
					"input_key": "settle-ms",
					"flag": "--settle-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "SETTLE_MS",
					"help": "Delay after delivery in milliseconds (0..=30000)"
				},
				{
					"input_key": "duration-ms",
					"flag": "--duration-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "DURATION_MS",
					"help": "Spread the scroll over this many milliseconds (0 scrolls at once; up to 60000)"
				},
				{
					"input_key": "easing",
					"flag": "--easing",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "FUNCTION",
					"help": "Timing function for --duration-ms: linear, ease-in, ease-out, ease-in-out, or cubic-bezier:x1,y1,x2,y2"
				},
				{
					"input_key": "sample-rate-hz",
					"flag": "--sample-rate-hz",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "SAMPLE_RATE_HZ",
					"help": "Samples per second for --duration-ms (1..=1000)"
				}
			],
			"examples": [
				{
					"cli": "auv invoke window.scroll 200 300 --dy 300 --target app:com.google.Chrome",
					"call": {
						"command_id": "window.scroll",
						"inputs": {
							"duration-ms": "0",
							"dx": "0.0",
							"dy": "300.0",
							"normalized": "false",
							"sample-rate-hz": "60",
							"settle-ms": "0",
							"x": "200.0",
							"y": "300.0"
						},
						"target": { "application_id": "com.google.Chrome" }
					}
				},
				{
					"cli": "auv invoke window.scroll 0.5 0.5 --normalized --dy -600 --target window:12345 --input-policy background-only",
					"call": {
						"command_id": "window.scroll",
						"inputs": {
							"duration-ms": "0",
							"dx": "0.0",
							"dy": "-600.0",
							"input-policy": "background-only",
							"normalized": "true",
							"sample-rate-hz": "60",
							"settle-ms": "0",
							"x": "0.5",
							"y": "0.5"
						},
						"target": { "window_id": "12345" }
					}
				},
				{
					"cli": "auv invoke window.scroll 200 300 --dy 1200 --duration-ms 800 --easing ease-in-out --target app:com.google.Chrome",
					"call": {
						"command_id": "window.scroll",
						"inputs": {
							"duration-ms": "800",
							"dx": "0.0",
							"dy": "1200.0",
							"easing": "ease-in-out",
							"normalized": "false",
							"sample-rate-hz": "60",
							"settle-ms": "0",
							"x": "200.0",
							"y": "300.0"
						},
						"target": { "application_id": "com.google.Chrome" }
					}
				}
			]
		},
		{
			"id": "window.scrollUntil",
			"namespace": "window",
			"description": "Scroll a target window in steps until no visual motion remains, target text appears, or a step budget runs out.",
			"target": {
				"policy": "required",
				"accepted_types": ["application", "window"],
				"required": true
			},
			"support": {
				"macos": "supported",
				"linux": "partial",
				"windows": "partial"
			},
			"runner_support": { "route": "direct" },
			"arguments": [
				{
					"input_key": "x",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "X",
					"help": "X coordinate inside the target window"
				},
				{
					"input_key": "y",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "Y",
					"help": "Y coordinate inside the target window"
				},
				{
					"input_key": "dx",
					"flag": "--dx",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "DX",
					"help": "Horizontal step in logical pixels; positive scrolls right"
				},
				{
					"input_key": "dy",
					"flag": "--dy",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "DY",
					"help": "Vertical step in logical pixels; positive scrolls down"
				},
				{
					"input_key": "until",
					"flag": "--until",
					"kind": "value",
					"required": true,
					"repeated": false,
					"value_name": "CONDITION",
					"help": "Stop condition: end, or text:<query>"
				},
				{
					"input_key": "max-steps",
					"flag": "--max-steps",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "MAX_STEPS",
					"help": "Step budget (1..=1000)"
				},
				{
					"input_key": "settle-ms",
					"flag": "--settle-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "SETTLE_MS",
					"help": "Wait after each step before observing, in milliseconds (0..=10000)"
				},
				{
					"input_key": "confirmations",
					"flag": "--confirmations",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "CONFIRMATIONS",
					"help": "Consecutive no-motion steps that count as the end (1..=10)"
				},
				{
					"input_key": "region",
					"flag": "--region",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "X,Y,W,H",
					"help": "Normalized window region x,y,width,height compared for motion"
				},
				{
					"input_key": "normalized",
					"flag": "--normalized",
					"kind": "flag",
					"required": false,
					"repeated": false,
					"value_name": null,
					"help": "Interpret X and Y as normalized values in 0..=1"
				},
				{
					"input_key": "title",
					"flag": "--title",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "TEXT",
					"help": "Window title text used with an app target"
				},
				{
					"input_key": "input-policy",
					"flag": "--input-policy",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "INPUT_POLICY",
					"help": "Window input delivery policy. Defaults to background-preferred",
					"possible_values": [
						"background-only",
						"background-preferred",
						"foreground-preferred"
					]
				},
				{
					"input_key": "step-duration-ms",
					"flag": "--step-duration-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "STEP_DURATION_MS",
					"help": "Spread each step over this many milliseconds (0 scrolls each step at once)"
				},
				{
					"input_key": "easing",
					"flag": "--easing",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "FUNCTION",
					"help": "Timing function for --step-duration-ms (see window.scroll --easing)"
				},
				{
					"input_key": "sample-rate-hz",
					"flag": "--sample-rate-hz",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "SAMPLE_RATE_HZ",
					"help": "Samples per second for --step-duration-ms (1..=1000)"
				}
			],
			"examples": [
				{
					"cli": "auv invoke window.scrollUntil 200 300 --dy 600 --until end --target app:com.google.Chrome",
					"call": {
						"command_id": "window.scrollUntil",
						"inputs": {
							"confirmations": "2",
							"dx": "0.0",
							"dy": "600.0",
							"max-steps": "50",
							"normalized": "false",
							"sample-rate-hz": "60",
							"settle-ms": "400",
							"step-duration-ms": "0",
							"until": "end",
							"x": "200.0",
							"y": "300.0"
						},
						"target": { "application_id": "com.google.Chrome" }
					}
				},
				{
					"cli": "auv invoke window.scrollUntil 0.5 0.5 --normalized --dy 800 --until 'text:Load more' --settle-ms 600 --target window:12345",
					"call": {
						"command_id": "window.scrollUntil",
						"inputs": {
							"confirmations": "2",
							"dx": "0.0",
							"dy": "800.0",
							"max-steps": "50",
							"normalized": "true",
							"sample-rate-hz": "60",
							"settle-ms": "600",
							"step-duration-ms": "0",
							"until": "text:Load more",
							"x": "0.5",
							"y": "0.5"
						},
						"target": { "window_id": "12345" }
					}
				},
				{
					"cli": "auv invoke window.scrollUntil 200 300 --dy 900 --step-duration-ms 500 --easing ease-in-out --until end --region 0,0.1,1,0.8 --target app:com.google.Chrome",
					"call": {
						"command_id": "window.scrollUntil",
						"inputs": {
							"confirmations": "2",
							"dx": "0.0",
							"dy": "900.0",
							"easing": "ease-in-out",
							"max-steps": "50",
							"normalized": "false",
							"region": "0,0.1,1,0.8",
							"sample-rate-hz": "60",
							"settle-ms": "400",
							"step-duration-ms": "500",
							"until": "end",
							"x": "200.0",
							"y": "300.0"
						},
						"target": { "application_id": "com.google.Chrome" }
					}
				}
			]
		},
		{
			"id": "window.setFrame",
			"namespace": "window",
			"description": "Move and/or resize one normal window in logical screen points (--x --y --width --height, each optional) and report the frame before and after.",
			"target": {
				"policy": "required",
				"accepted_types": ["application", "window"],
				"required": true
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [
				{
					"input_key": "x",
					"flag": "--x",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "X",
					"help": "New left edge in logical screen points"
				},
				{
					"input_key": "y",
					"flag": "--y",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "Y",
					"help": "New top edge in logical screen points"
				},
				{
					"input_key": "width",
					"flag": "--width",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "WIDTH",
					"help": "New outer width in logical points"
				},
				{
					"input_key": "height",
					"flag": "--height",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "HEIGHT",
					"help": "New outer height in logical points"
				},
				{
					"input_key": "title",
					"flag": "--title",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "TEXT",
					"help": "Window title text used with an app target"
				}
			],
			"examples": [{
				"cli": "auv invoke window.setFrame --target window:1234 --x 100 --y 80",
				"call": {
					"command_id": "window.setFrame",
					"inputs": {
						"x": "100.0",
						"y": "80.0"
					},
					"target": { "window_id": "1234" }
				}
			}, {
				"cli": "auv invoke window.setFrame --target app:com.apple.TextEdit --width 800 --height 600",
				"call": {
					"command_id": "window.setFrame",
					"inputs": {
						"height": "600.0",
						"width": "800.0"
					},
					"target": { "application_id": "com.apple.TextEdit" }
				}
			}]
		},
		{
			"id": "window.setState",
			"namespace": "window",
			"description": "Move one window to normal, minimized or maximized and report its state before and after.",
			"target": {
				"policy": "required",
				"accepted_types": ["application", "window"],
				"required": true
			},
			"support": {
				"macos": "supported",
				"linux": "unsupported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [{
				"input_key": "state",
				"flag": null,
				"kind": "positional",
				"required": true,
				"repeated": false,
				"value_name": "STATE",
				"help": "The state to move the window to"
			}, {
				"input_key": "title",
				"flag": "--title",
				"kind": "value",
				"required": false,
				"repeated": false,
				"value_name": "TEXT",
				"help": "Window title text used with an app target"
			}],
			"examples": [{
				"cli": "auv invoke window.setState minimized --target window:1234",
				"call": {
					"command_id": "window.setState",
					"inputs": { "state": "minimized" },
					"target": { "window_id": "1234" }
				}
			}, {
				"cli": "auv invoke window.setState normal --target window:1234",
				"call": {
					"command_id": "window.setState",
					"inputs": { "state": "normal" },
					"target": { "window_id": "1234" }
				}
			}]
		},
		{
			"id": "window.waitForText",
			"namespace": "window",
			"description": "Poll resolved-window OCR until a text anchor appears or the timeout expires.",
			"target": {
				"policy": "optional",
				"accepted_types": ["application"],
				"required": false
			},
			"support": {
				"macos": "supported",
				"linux": "supported",
				"windows": "supported"
			},
			"runner_support": { "route": "direct" },
			"arguments": [
				{
					"input_key": "query",
					"flag": null,
					"kind": "positional",
					"required": true,
					"repeated": false,
					"value_name": "TEXT",
					"help": "Text to wait for in the selected window"
				},
				{
					"input_key": "title",
					"flag": "--title",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "TITLE",
					"help": "Window title text used to select the capture target"
				},
				{
					"input_key": "timeout-ms",
					"flag": "--timeout-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "MS",
					"help": "Milliseconds to keep polling before failing (default 10000, 100..=120000)"
				},
				{
					"input_key": "interval-ms",
					"flag": "--interval-ms",
					"kind": "value",
					"required": false,
					"repeated": false,
					"value_name": "MS",
					"help": "Milliseconds between OCR attempts (default 250, 50..=10000)"
				}
			],
			"examples": [{
				"cli": "auv invoke window.waitForText \"Ready\" --title Import",
				"call": {
					"command_id": "window.waitForText",
					"inputs": {
						"query": "Ready",
						"title": "Import"
					}
				}
			}]
		}
	]
};
// src/catalog.mjs
/**
* AUV command catalog helpers for the @local/dsh-auv Host plugin.
*
* Pure ESM. The catalog is imported from the generated `catalog-data.mjs`
* (mirrored from `catalog.json`) so a bundled build has no runtime file reads;
* there is no auv spawn and no network I/O.
*
* Exports:
*   CATALOG                       parsed catalog object
*   loadCatalog()                 -> CATALOG
*   getCommand(id)                -> command object | null
*   formatTarget(target)          -> "app:<id>" | "window:<id>" | "display:<id>" | null
*   buildInvokeArgs(cmd, inputs, options?) -> { args, target?, warnings }
*   summaryText()                 -> compact list of every command id
*   commandHelpText(id)           -> detailed help text for one command
*
* `buildInvokeArgs` input handling:
*   - `inputs` keys must be catalog `input_key`s (or the reserved `target` key).
*   - scalar string | finite number | boolean values become argv tokens.
*   - arrays repeat a `repeated` argument (repeated positionals are flattened;
*     repeated value options emit the flag once per element).
*   - `kind: "flag"` arguments are presence-only: emitted only when truthy
*     (`true` / `"true"` / `"1"`; `false` / `"false"` / `"0"` are omitted).
*   - missing/unknown/ill-typed inputs throw descriptive Errors.
*   - a `target` may be supplied as `options.target` or as `inputs.target`
*     (reserved key) and is returned formatted, never embedded in `args`.
*   - non-fatal issues are returned in `warnings` for the caller to surface.
*/
var catalog_exports = /* @__PURE__ */ __exportAll({
	CATALOG: () => catalog,
	buildInvokeArgs: () => buildInvokeArgs,
	commandHelpText: () => commandHelpText,
	formatTarget: () => formatTarget,
	getCommand: () => getCommand,
	loadCatalog: () => loadCatalog,
	summaryText: () => summaryText
});
const COMMANDS_BY_ID = new Map(catalog.commands.map((command) => [command.id, command]));
const TARGET_KEYS = [
	["application_id", "app"],
	["window_id", "window"],
	["display_id", "display"]
];
const TARGET_TYPES = /* @__PURE__ */ new Set([
	"application",
	"window",
	"display"
]);
/** Return the parsed catalog object (same instance as CATALOG). */
function loadCatalog() {
	return catalog;
}
/** Look up one command by id. Returns null when the id is unknown. */
function getCommand(id) {
	if (typeof id !== "string") return null;
	return COMMANDS_BY_ID.get(id.trim()) ?? null;
}
/**
* Format a target into AUV's CLI `--target` value.
*
* Accepts either an object with exactly one of `application_id`, `window_id`,
* `display_id` (values may already carry their prefix), or a target string
* (`com.apple.TextEdit` -> `app:com.apple.TextEdit`, prefixed strings pass
* through unchanged).
*
* Returns null for null/undefined. Throws on ambiguous/empty targets.
*/
function formatTarget(target) {
	if (target == null) return null;
	if (typeof target === "string") {
		const value = target.trim();
		if (!value) throw new Error("target must be a non-empty string or an object with exactly one of application_id, window_id, display_id");
		return /^(app|window|display):/.test(value) ? value : `app:${value}`;
	}
	if (typeof target !== "object" || Array.isArray(target)) throw new TypeError("target must be a string or an object with exactly one of application_id, window_id, display_id");
	const present = TARGET_KEYS.filter(([key]) => target[key] != null && String(target[key]).trim() !== "");
	if (present.length === 0) throw new Error("target requires exactly one of application_id, window_id, display_id");
	if (present.length > 1) throw new Error(`target requires exactly one of application_id, window_id, display_id (got ${present.map(([key]) => key).join(", ")})`);
	const [key, prefix] = present[0];
	const value = String(target[key]).trim();
	if (/^[a-z]+:/.test(value)) return value;
	return `${prefix}:${value}`;
}
function targetTypeOf(formattedTarget) {
	const match = /^(app|window|display):/.exec(formattedTarget);
	if (!match) return null;
	return match[1] === "app" ? "application" : match[1];
}
function targetSummary(target) {
	const formatted = (Array.isArray(target?.accepted_types) ? target.accepted_types : []).map((type) => type === "application" ? "app:<application-id>" : `${type}:<id>`).join(" or ");
	switch (target?.policy) {
		case "forbidden": return "none allowed (this command forbids --target)";
		case "required": return `required: ${formatted || "target"}`;
		default: return `optional: ${formatted || "target"}`;
	}
}
function isMissingInput(value) {
	return value == null || value === "" || Array.isArray(value) && value.length === 0;
}
function argvValue(value, inputKey) {
	if (typeof value === "string") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`input "${inputKey}" must be a finite number`);
		return String(value);
	}
	if (typeof value === "boolean") return value ? "true" : "false";
	throw new Error(`input "${inputKey}" must be a string, number, or boolean`);
}
function argvValueList(value, inputKey) {
	if (!Array.isArray(value)) return [argvValue(value, inputKey)];
	return value.map((item) => argvValue(item, inputKey));
}
function isFlagEnabled(value, inputKey, warnings) {
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off" || normalized === "") return false;
		if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
		warnings.push(`input "${inputKey}" is a presence flag; interpreted "${value}" as true (pass true/false)`);
		return true;
	}
	if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
	if (value && typeof value === "object") throw new Error(`input "${inputKey}" is a presence flag; expected boolean, got ${Array.isArray(value) ? "array" : "object"}`);
	return Boolean(value);
}
/** Accept MCP-style JSON-encoded arrays ("[\"cmd\",\"l\"]") for repeated inputs. */
function repeatedValues(value, inputKey, warnings) {
	if (typeof value === "string" && value.trim().startsWith("[")) try {
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed)) {
			warnings.push(`input "${inputKey}" was a JSON-encoded array string; parsed into ${parsed.length} value(s)`);
			return parsed;
		}
	} catch {}
	return Array.isArray(value) ? value : [value];
}
/**
* Convert command inputs into `auv invoke <id>` argv tokens.
*
* @param {object} command catalog command (from getCommand/CATALOG.commands)
* @param {object} [inputs] values keyed by catalog `input_key`
* @param {{target?: object|string}} [options]
* @returns {{args: string[], target?: string, warnings: string[]}}
*/
function buildInvokeArgs(command, inputs = {}, options = {}) {
	if (command && typeof command === "object" && typeof command.id === "string" && Array.isArray(command.arguments)) {} else throw new TypeError("buildInvokeArgs requires a catalog command object (see getCommand(id))");
	if (inputs == null) inputs = {};
	if (typeof inputs !== "object" || Array.isArray(inputs)) throw new TypeError(`inputs for ${command.id} must be a plain object`);
	const warnings = [];
	const arguments_ = command.arguments;
	const allowedKeys = new Set(arguments_.map((argument) => argument.input_key));
	allowedKeys.add("target");
	const unknownKeys = Object.keys(inputs).filter((key) => !allowedKeys.has(key));
	if (unknownKeys.length > 0) {
		const allowed = [...allowedKeys].sort().join(", ");
		throw new Error(`unknown input key(s) for ${command.id}: ${unknownKeys.join(", ")} (allowed: ${allowed})`);
	}
	const args = [];
	const missing = [];
	for (const argument of arguments_) {
		const value = inputs[argument.input_key];
		if (isMissingInput(value)) {
			if (argument.required) missing.push(argument.input_key);
			continue;
		}
		if (argument.kind === "positional") {
			if (argument.repeated) args.push(...argvValueList(repeatedValues(value, argument.input_key, warnings), argument.input_key).map(String));
			else {
				if (Array.isArray(value)) throw new Error(`input "${argument.input_key}" is a single positional for ${command.id}; got an array`);
				args.push(argvValue(value, argument.input_key));
			}
		}
	}
	for (const argument of arguments_) {
		if (argument.kind === "positional") continue;
		const value = inputs[argument.input_key];
		if (isMissingInput(value)) {
			if (argument.required) missing.push(argument.input_key);
			continue;
		}
		if (argument.kind === "flag") {
			if (isFlagEnabled(value, argument.input_key, warnings)) args.push(argument.flag);
			continue;
		}
		const values = argument.repeated ? repeatedValues(value, argument.input_key, warnings) : [value];
		for (const item of values) {
			if (Array.isArray(item)) throw new Error(`input "${argument.input_key}" must be scalar values`);
			args.push(argument.flag, argvValue(item, argument.input_key));
		}
	}
	if (missing.length > 0) throw new Error(`missing required input(s) for ${command.id}: ${missing.join(", ")}`);
	const rawTarget = options?.target !== void 0 ? options.target : inputs.target;
	let target;
	if (rawTarget != null) {
		const formatted = formatTarget(rawTarget);
		if ((command.target?.policy ?? "forbidden") === "forbidden") warnings.push(`command ${command.id} does not accept a target; ignoring ${formatted}`);
		else {
			const type = targetTypeOf(formatted);
			const accepted = Array.isArray(command.target?.accepted_types) ? command.target.accepted_types : [];
			if (type && accepted.length > 0 && !accepted.includes(type) && TARGET_TYPES.has(type)) warnings.push(`command ${command.id} accepts ${accepted.join("/")} targets, not ${type} (${formatted}); auv will reject it`);
			target = formatted;
		}
	} else if (command.target?.policy === "required") warnings.push(`command ${command.id} requires a target (${targetSummary(command.target)}); pass target`);
	const result = {
		args,
		warnings
	};
	if (target != null) result.target = target;
	return result;
}
function firstSentence(text) {
	const value = String(text ?? "").trim();
	if (!value) return "";
	const match = /^.*?[.!?](?=\s|$)/.exec(value);
	return match ? match[0] : value;
}
function supportSummary(support, supportNote) {
	const state = (platform) => {
		const value = support?.[platform] ?? "unknown";
		if (value === "supported") return "yes";
		if (value === "unsupported") return "no";
		return value;
	};
	const note = supportNote?.macos ? ` (macOS: ${supportNote.macos})` : "";
	return `macOS ${state("macos")}${note}; Linux ${state("linux")}; Windows ${state("windows")}`;
}
function argumentSignature(argument) {
	const flags = [];
	if (argument.kind === "positional") {
		const token = argument.repeated ? `<${argument.value_name ?? "VALUE"}>...` : argument.required ? `<${argument.value_name ?? "VALUE"}>` : `[${argument.value_name ?? "VALUE"}]`;
		flags.push(`positional ${token}`);
	} else if (argument.kind === "value") flags.push(`option ${argument.flag} <${argument.value_name ?? "VALUE"}>`);
	else flags.push(`presence flag ${argument.flag}`);
	if (argument.required) flags.push("required");
	else flags.push("optional");
	if (argument.repeated) flags.push("repeatable");
	if (Array.isArray(argument.possible_values) && argument.possible_values.length > 0) flags.push(`values: ${argument.possible_values.join(", ")}`);
	const help = argument.help ? ` — ${argument.help}` : "";
	return `  ${argument.input_key} (${flags.join(", ")})${help}`;
}
/** Compact list of every command id plus a one-sentence description. */
function summaryText() {
	const lines = [`AUV ${catalog.auv_version} invoke commands (${catalog.commands.length}):`];
	for (const command of catalog.commands) lines.push(`- ${command.id} — ${firstSentence(command.description)}`);
	lines.push("");
	lines.push("Call auv_help with command_id for arguments, target rules, platform support, and examples. auv_invoke.command_id must be one of the ids above.");
	return lines.join("\n");
}
/** Detailed help for one command id. Throws for unknown ids. */
function commandHelpText(id) {
	const command = getCommand(id);
	if (!command) {
		const sample = catalog.commands.slice(0, 3).map((entry) => entry.id).join(", ");
		throw new Error(`unknown AUV command id "${id}"; call auv_help without command_id to list all ${catalog.commands.length} ids (for example: ${sample})`);
	}
	const lines = [
		`# ${command.id}`,
		"",
		String(command.description ?? "").trim()
	];
	lines.push("", `Target: ${targetSummary(command.target)}`);
	lines.push(`Support: ${supportSummary(command.support, command.support_note)}`);
	if (command.runner_support?.route) lines.push(`Runner route: ${command.runner_support.route}`);
	lines.push("", "Arguments:");
	if (!command.arguments?.length) lines.push("  (none)");
	else for (const argument of command.arguments) lines.push(argumentSignature(argument));
	const exampleCall = command.examples?.find((example) => example?.call)?.call;
	if (exampleCall) lines.push("", `Example inputs for auv_invoke: ${JSON.stringify(exampleCall)}`);
	if (command.examples?.length) {
		lines.push("", "Examples:");
		for (const example of command.examples) if (typeof example.cli === "string" && example.cli) lines.push(`  ${example.cli}`);
	}
	lines.push("", "Invoke via auv_invoke with command_id and an inputs object keyed by the input keys above.");
	return lines.join("\n");
}
// src/tools.mjs
/**
* The eleven native DSH tools exposed by @local/dsh-auv.
*
* Each entry is a plain DSH ToolDefinition: name, description, object-rooted
* parameter JSON Schema (within the enforced DSH subset), a `{}` output schema,
* a render function that produces bounded text blocks, an async execute, a
* positive timeout, and `isConcurrencySafe: () => false` because OS input is
* mutually exclusive.
*
* The AUV command catalog (src/catalog.json mirrored into src/catalog-data.mjs,
* exposed by src/catalog.mjs) is statically imported so the tsdown bundle inlines
* it into the single dist/index.mjs. A missing generated catalog therefore fails
* package validation/build time, not at first tool call.
*/
const INLINE_JSON_LIMIT = 2e4;
const SCREENSHOT_JSON_LIMIT = 8e3;
const WINDOW_TARGET_TTL_MS = 3e4;
const TOOL_TIMEOUT_MS = 12e4;
const SLOW_TOOL_TIMEOUT_MS = 18e4;
/** The statically imported catalog module (bundled into dist/index.mjs). */
async function getCatalogModule() {
	return catalog_exports;
}
/** Resolve one catalog command or throw an actionable unknown-command error. */
async function getCatalogCommand(commandId) {
	const catalog = await getCatalogModule();
	const command = await catalog.getCommand(commandId);
	if (command === void 0 || command === null) throw new Error(`Unknown AUV command "${commandId}". Call auv_help without arguments to list every command id.`);
	return {
		catalog,
		command
	};
}
/** List a command's catalog argument descriptors. */
function catalogArguments(command) {
	return Array.isArray(command?.arguments) ? command.arguments : [];
}
/** Input key of the Nth positional argument (0-based). */
function positionalKey(command, index = 0) {
	const argument = catalogArguments(command).filter((argument) => argument?.kind === "positional")[index];
	if (argument === void 0 || typeof argument.input_key !== "string") throw catalogShapeError(command, `positional argument ${index}`);
	return argument.input_key;
}
/** Input key of a flag/value option, looked up by its exact CLI flag. */
function flagKey(command, flag) {
	const argument = catalogArguments(command).find((candidate) => candidate?.flag === flag);
	if (argument === void 0 || typeof argument.input_key !== "string") throw catalogShapeError(command, `option ${flag}`);
	return argument.input_key;
}
function catalogShapeError(command, detail) {
	return /* @__PURE__ */ new Error(`The AUV catalog entry for "${command?.id ?? "unknown"}" is missing ${detail}. Regenerate src/catalog.json with \`node tools/generate-catalog.mjs\`.`);
}
/**
* Build argv for one catalog command through the catalog's own argv builder and
* wrap its warnings. Unknown keys and missing required arguments are rejected by
* that builder and surfaced with a pointer to auv_help.
*/
async function buildInvoke(commandId, inputs, options = {}) {
	const { catalog, command } = await getCatalogCommand(commandId);
	let built;
	try {
		built = await catalog.buildInvokeArgs(command, inputs, options.target === void 0 ? void 0 : { target: options.target });
	} catch (error) {
		throw new Error(`Cannot build arguments for AUV command "${commandId}": ${messageOf(error)} Call auv_help with command_id "${commandId}" to see the accepted arguments.`);
	}
	const target = typeof built?.target === "string" && built.target !== "" ? built.target : void 0;
	const warnings = Array.isArray(built?.warnings) ? built.warnings.map((warning) => String(warning)) : [];
	return {
		command,
		args: Array.isArray(built?.args) ? built.args.map((argument) => String(argument)) : [],
		target,
		warnings
	};
}
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
function textBlock(text) {
	return [{
		type: "text",
		text: String(text)
	}];
}
function objectArgs(value) {
	return isPlainObject(value) ? value : {};
}
function optionalString(args, key) {
	const value = args[key];
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
function requiredString(args, key, label = key) {
	const value = optionalString(args, key);
	if (value === void 0) throw new Error(`Missing required parameter "${label}".`);
	return value;
}
function optionalNumber(args, key) {
	const value = args[key];
	if (value === void 0 || value === null) return void 0;
	const number = Number(value);
	if (!Number.isFinite(number)) throw new Error(`Parameter "${key}" must be a finite number.`);
	return number;
}
function optionalInteger(args, key) {
	const number = optionalNumber(args, key);
	if (number === void 0) return void 0;
	if (!Number.isInteger(number)) throw new Error(`Parameter "${key}" must be an integer.`);
	return number;
}
function optionalEnum(args, key, allowed) {
	const value = optionalString(args, key);
	if (value === void 0) return void 0;
	if (!allowed.includes(value)) throw new Error(`Parameter "${key}" must be one of ${allowed.map((entry) => `"${entry}"`).join(", ")}.`);
	return value;
}
function optionalObject(args, key) {
	const value = args[key];
	if (value === void 0 || value === null) return void 0;
	if (!isPlainObject(value)) throw new Error(`Parameter "${key}" must be an object.`);
	return value;
}
function boundedJson(value, limit = INLINE_JSON_LIMIT) {
	let text;
	try {
		text = JSON.stringify(value, null, 2);
	} catch {
		text = void 0;
	}
	if (typeof text !== "string") text = String(value);
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n… truncated ${text.length - limit} of ${text.length} characters; narrow the request for a smaller result.`;
}
function renderResult(lines, value, options = {}) {
	const parts = lines.map((line) => String(line)).filter((line) => line !== "");
	parts.push(boundedJson(value, options.jsonLimit ?? INLINE_JSON_LIMIT));
	return textBlock(parts.join("\n"));
}
function receiptMeta(receipt) {
	return {
		run_id: typeof receipt?.run_id === "string" ? receipt.run_id : null,
		command_id: typeof receipt?.command_id === "string" ? receipt.command_id : null,
		status: typeof receipt?.status === "string" ? receipt.status : null
	};
}
function warningsLine(warnings) {
	return Array.isArray(warnings) && warnings.length > 0 ? `Warnings: ${warnings.join(" ")}` : "";
}
/** Append a hint to an error message without losing the original diagnostics. */
function withHint(error, hint) {
	if (error instanceof Error) {
		if (!error.message.includes(hint)) error.message = `${error.message}\n${hint}`;
		return error;
	}
	return /* @__PURE__ */ new Error(`${String(error)}\n${hint}`);
}
const windowTargetCache = /* @__PURE__ */ new Map();
/**
* Resolve a window reference id into the application target that window.*
* commands actually accept (they reject `window:` targets on macOS).
*
* Uses `window.get --target window:<id>`, caches the result briefly, and returns
* a warning when the window has no title so the app's main window is captured.
*/
async function resolveWindow(windowId, signal) {
	const cached = windowTargetCache.get(windowId);
	if (cached !== void 0 && cached.expiresAt > Date.now()) return cached.value;
	const window = (await runAuv({
		commandId: "window.get",
		argv: [],
		target: `window:${windowId}`,
		signal,
		timeoutMs: 3e4
	}))?.result;
	const applicationId = typeof window?.application_id === "string" && window.application_id !== "" ? window.application_id : void 0;
	if (applicationId === void 0) throw new Error(`AUV could not resolve window "${windowId}" to an application. Call auv_windows to refresh window ids, then retry.`);
	const title = typeof window?.title === "string" && window.title !== "" ? window.title : null;
	const warnings = [];
	if (title === null) warnings.push(`Window "${windowId}" has no title; targeting the application's main visible window instead.`);
	const value = {
		window,
		applicationId,
		title,
		target: `app:${applicationId}`,
		warnings
	};
	if (windowTargetCache.size >= 100) windowTargetCache.clear();
	windowTargetCache.set(windowId, {
		expiresAt: Date.now() + WINDOW_TARGET_TTL_MS,
		value
	});
	return value;
}
/** Add the --title input for window.* commands when the title is known. */
function withWindowTitle(command, inputs, title) {
	if (title === null) return inputs;
	return {
		...inputs,
		[flagKey(command, "--title")]: title
	};
}
/** Resolve a display id into a full-display capture region via display.list. */
async function resolveDisplayRegion(displayId, signal) {
	const receipt = await runAuv({
		commandId: "display.list",
		argv: [],
		signal,
		timeoutMs: 3e4
	});
	const displays = Array.isArray(receipt?.result?.displays) ? receipt.result.displays : [];
	const display = displays.find((candidate) => String(candidate?.id) === String(displayId));
	if (display === void 0) {
		const available = displays.map((candidate) => `${String(candidate?.id)}${candidate?.name ? ` (${candidate.name})` : ""}`).join(", ");
		throw new Error(`Display "${displayId}" was not found. Available displays: ${available === "" ? "none reported by display.list" : available}.`);
	}
	const origin = display.frame?.origin ?? {};
	const size = display.frame?.size ?? {};
	const region = {
		x: Number(origin.x),
		y: Number(origin.y),
		width: Number(size.width),
		height: Number(size.height)
	};
	if (![
		region.x,
		region.y,
		region.width,
		region.height
	].every((value) => Number.isFinite(value)) || region.width <= 0 || region.height <= 0) throw new Error(`Display "${displayId}" has an unusable frame in display.list. Pass an explicit region instead.`);
	return region;
}
const WINDOW_ID_DESCRIPTION = "Window reference id reported by auv_windows (window.list).";
const APPLICATION_ID_DESCRIPTION = "Application id reported by auv_windows: the bundle id on macOS, for example com.apple.TextEdit.";
const DISPLAY_ID_DESCRIPTION = "Display id reported by display.list (auv_invoke command_id \"display.list\").";
function stringProperty(description) {
	return {
		type: "string",
		description
	};
}
function numberProperty(description) {
	return {
		type: "number",
		description
	};
}
function booleanProperty(description) {
	return {
		type: "boolean",
		description
	};
}
function integerProperty(description) {
	return {
		type: "integer",
		description
	};
}
function enumProperty(description, values) {
	return {
		type: "string",
		enum: values,
		description
	};
}
const REGION_SCHEMA = {
	type: "object",
	properties: {
		x: numberProperty("Left coordinate in logical screen points."),
		y: numberProperty("Top coordinate in logical screen points."),
		width: numberProperty("Region width in logical points; must be greater than zero."),
		height: numberProperty("Region height in logical points; must be greater than zero.")
	},
	required: [
		"x",
		"y",
		"width",
		"height"
	],
	additionalProperties: false,
	description: "Screen rectangle in logical points; only valid when no window or application target is given."
};
const WITHIN_SCHEMA = {
	type: "object",
	properties: {
		left: numberProperty("Left edge of the screen-coordinate fence."),
		top: numberProperty("Top edge of the screen-coordinate fence."),
		right: numberProperty("Right edge of the screen-coordinate fence."),
		bottom: numberProperty("Bottom edge of the screen-coordinate fence.")
	},
	required: [
		"left",
		"top",
		"right",
		"bottom"
	],
	additionalProperties: false,
	description: "Screen-coordinate fence checked against the OCR click point before delivery."
};
const TARGET_SCHEMA = {
	type: "object",
	properties: {
		application_id: stringProperty("Target an application by id (bare id accepted by AUV; app: prefix added automatically)."),
		window_id: stringProperty("Target a window by its reference id. Not accepted by commands that forbid window targets."),
		display_id: stringProperty("Target a display by its id. Only for commands that accept display targets.")
	},
	additionalProperties: false,
	description: "Exactly one of application_id, window_id, or display_id; omit for commands that operate without a target."
};
function objectSchema(properties, required = []) {
	return {
		type: "object",
		properties,
		required,
		additionalProperties: false
	};
}
const DOCTOR_DESCRIPTION = "Check whether AUV can automate this Mac and what is blocking it. Returns the doctor report: Accessibility and Screen Recording state, capture backend, all_ok, and a recommendation. AUV must be installed separately first; when the auv executable is missing this tool returns the install commands. Call it first after installing the plugin and whenever another auv_* tool fails or reports a permission error. If all_ok is false, open System Settings → Privacy & Security and enable DeepSeek Harness (macOS 27+ merges the permission list into \"Device Control and Data Access\"; older macOS shows Accessibility and Screen Recording as separate items), restart the app, and run auv_doctor again.";
const SCREENSHOT_DESCRIPTION = "Capture a screenshot and return its saved image path. Use it to see the desktop, a window, or a screen region, then call read_image with artifact_path to view the image. Target one window with window_id, one application with application_id, one display with display_id, or a screen rectangle with region; pass only one. Captures are .webp artifacts and image bytes are never returned. Use auv_ocr to read text. Screen capture needs Screen Recording permission for DeepSeek Harness; run auv_doctor if it fails.";
const OCR_DESCRIPTION = "Locate text on screen with Vision OCR and return the matches with their screen bounds. Use it to find a control before auv_click with text, or to read text that has no accessibility tree. Set wait: true to poll until the text appears, with an optional timeout_ms. Restrict the search with window_id or application_id; omit both to search the primary display. Text recognition needs Screen Recording permission for DeepSeek Harness; run auv_doctor if it fails.";
const CLICK_DESCRIPTION = "Click a UI element or an exact point. Pass text to locate it with OCR and click the match, or x and y to click a point; pass exactly one form. Constrain an OCR click with window_id or application_id, or target a display with display_id in the x/y form. button selects the mouse button for x/y clicks; within fences an OCR click to a screen rectangle. This performs a real click and needs Accessibility permission for DeepSeek Harness; run auv_doctor if it is refused or lands nowhere.";
const TYPE_DESCRIPTION = "Type or paste text into the focused control. mode \"type\" (default) sends keystrokes; mode \"paste\" uses the clipboard and restores it, which is faster and safer for long or non-ASCII text. Optionally send to a window_id or application_id and choose the delivery policy. This is real keyboard input and needs Accessibility permission for DeepSeek Harness; run auv_doctor if keystrokes do not arrive.";
const KEYS_DESCRIPTION = "Press one key combination such as [\"ctrl\",\"l\"] or [\"cmd\",\"shift\",\"t\"]. Modifiers come first and are released in reverse order. repeat presses the combination multiple times. Optionally target a window_id or application_id; without a target the foreground app receives the keys. This is real keyboard input that needs Accessibility permission for DeepSeek Harness; use auv_type for text. Run auv_doctor on failure.";
const SCROLL_DESCRIPTION = "Scroll at a point. dy is required and positive dy scrolls down; dx scrolls right when given. With window_id, scroll inside that window at its center or at window-local x and y. Without window_id, pass screen x and y; macOS does not support AUV screen-point scrolling, so prefer window_id on macOS. This is real input that needs Accessibility permission for DeepSeek Harness; run auv_doctor on failure.";
const WINDOWS_DESCRIPTION = "List the windows you could switch to, with each window id, owning application and application id, title, frame, and state. Use it to find window_id and application_id values for the other tools. Minimized windows and windows on other desktops are excluded by default; set include_minimized or include_other_desktops to include them. Window state comes from the window server and needs no Accessibility permission.";
const ACTIVATE_DESCRIPTION = "Bring an application to the front by its application id: the bundle id on macOS, for example com.apple.TextEdit. Use it before typing or clicking when the target app is not focused. Get ids from auv_windows. This changes foreground focus but enters no text. If activation is refused or ineffective, run auv_doctor to check permissions.";
const INVOKE_DESCRIPTION = "Run any AUV command directly. Use it for capabilities without a dedicated tool (display.list, window.get, window.focus, input.moveMouse, media.*, permission.probe, ...) or when you need exact control. command_id must be one of the ids listed by auv_help; the catalog has 43: display.capture, display.list, display.captureRegion, display.findText, display.waitForText, display.clickText, window.list, window.get, window.setFrame, window.setState, window.focus, window.capture, window.findText, window.waitForText, window.clickText, window.scroll, window.scrollUntil, input.typeText, input.pasteText, input.pressKeys, input.holdKeys, input.performKeyboardInputs, input.getPointerPosition, input.moveMouse, input.scrollPoint, input.clickPoint, input.dragMouse, accessibility.focusText, application.activate, permission.probe, overlay.outline, overlay.cursor, overlay.status, overlay.captureFrame, overlay.clickTarget, media.getNowPlaying, media.play, media.pause, media.togglePlayback, media.skipToNextTrack, media.skipToPreviousTrack, scan.frame, scan.coverage. inputs holds argument values keyed by catalog input keys; target selects app, window, or display; dry_run validates most commands without acting (application.activate is an exception and still activates). Prefer a dedicated auv_* tool when one exists, and run auv_doctor on permission errors.";
const HELP_DESCRIPTION = "Show the AUV command catalog. Without command_id it lists every command id with a one-line description; with command_id it returns that command description, required and optional arguments, target support, and examples. Call it before auv_invoke to check exact ids and input keys. This tool reads the bundled catalog only and never runs AUV.";
/** All eleven tool definitions, created fresh on each call. */
function createTools() {
	return [
		{
			name: "auv_doctor",
			description: DOCTOR_DESCRIPTION,
			parameters: objectSchema({}),
			output: {
				schema: {},
				render(_args, value) {
					const report = objectArgs(value);
					const allOk = report.all_ok === true;
					const lines = [allOk ? "AUV doctor: all checks passed, AUV is ready." : "AUV doctor: AUV is not fully ready."];
					for (const key of [
						"platform",
						"accessibility",
						"screen_recording_preflight",
						"screen_capture_kit",
						"screen_capture_kit_error"
					]) if (report[key] !== void 0 && report[key] !== null) lines.push(`${key}: ${String(report[key])}`);
					if (typeof report.recommendation === "string" && report.recommendation !== "") lines.push(`recommendation: ${report.recommendation}`);
					if (!allOk) lines.push("To fix: open System Settings → Privacy & Security, enable DeepSeek Harness (macOS 27+: \"Device Control and Data Access\"; older macOS: Accessibility + Screen Recording), restart the app, then run auv_doctor again.");
					return renderResult(lines, value, { jsonLimit: 8e3 });
				}
			},
			async execute(_rawArgs, exec) {
				return await runAuvDoctor({
					signal: exec?.signal,
					timeoutMs: TOOL_TIMEOUT_MS
				});
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			isConcurrencySafe: () => false
		},
		{
			name: "auv_screenshot",
			description: SCREENSHOT_DESCRIPTION,
			parameters: objectSchema({
				window_id: stringProperty(WINDOW_ID_DESCRIPTION),
				application_id: stringProperty(APPLICATION_ID_DESCRIPTION),
				display_id: stringProperty(DISPLAY_ID_DESCRIPTION),
				region: REGION_SCHEMA
			}),
			output: {
				schema: {},
				render(_args, value) {
					const shot = objectArgs(value);
					const artifactPath = typeof shot.artifact_path === "string" ? shot.artifact_path : null;
					const size = shot.width !== null && shot.width !== void 0 && shot.height !== null && shot.height !== void 0 ? `${shot.width}×${shot.height} px` : "size unknown";
					const lines = [`Captured ${shot.command_id ?? "screenshot"} (${size}${shot.content_type ? `, ${shot.content_type}` : ""}).`];
					if (artifactPath !== null) {
						lines.push(`artifact_path: ${artifactPath}`);
						lines.push("Call read_image with this artifact_path to view the screenshot.");
					} else lines.push("AUV returned no image artifact for this capture.");
					lines.push(warningsLine(shot.warnings));
					return renderResult(lines, value, { jsonLimit: SCREENSHOT_JSON_LIMIT });
				}
			},
			async execute(rawArgs, exec) {
				const args = objectArgs(rawArgs);
				const signal = exec?.signal;
				const windowId = optionalString(args, "window_id");
				const applicationId = optionalString(args, "application_id");
				const displayId = optionalString(args, "display_id");
				const region = optionalRegion(args);
				if ([
					windowId,
					applicationId,
					displayId,
					region === void 0 ? void 0 : "region"
				].filter((entry) => entry !== void 0).length > 1) throw new Error("Pass only one of window_id, application_id, display_id, or region to auv_screenshot.");
				let receipt;
				const warnings = [];
				if (windowId !== void 0) {
					const resolved = await resolveWindow(windowId, signal);
					warnings.push(...resolved.warnings);
					const command = (await getCatalogCommand("window.capture")).command;
					const built = await buildInvoke("window.capture", withWindowTitle(command, {}, resolved.title), { target: resolved.target });
					warnings.push(...built.warnings);
					receipt = await runAuv({
						commandId: "window.capture",
						argv: built.args,
						target: built.target,
						signal,
						timeoutMs: TOOL_TIMEOUT_MS
					});
				} else if (applicationId !== void 0) {
					warnings.push("Capturing the application's main visible window; pass window_id to choose a specific window.");
					const built = await buildInvoke("window.capture", {}, { target: `app:${applicationId}` });
					warnings.push(...built.warnings);
					receipt = await runAuv({
						commandId: "window.capture",
						argv: built.args,
						target: built.target,
						signal,
						timeoutMs: TOOL_TIMEOUT_MS
					});
				} else if (displayId !== void 0) {
					if (region !== void 0) throw new Error("Pass either display_id or region to auv_screenshot, not both.");
					const displayRegion = await resolveDisplayRegion(displayId, signal);
					const command = (await getCatalogCommand("display.captureRegion")).command;
					const built = await buildInvoke("display.captureRegion", regionInputs(command, displayRegion));
					warnings.push(...built.warnings);
					receipt = await runAuv({
						commandId: "display.captureRegion",
						argv: built.args,
						signal,
						timeoutMs: TOOL_TIMEOUT_MS
					});
				} else if (region !== void 0) {
					const command = (await getCatalogCommand("display.captureRegion")).command;
					const built = await buildInvoke("display.captureRegion", regionInputs(command, region));
					warnings.push(...built.warnings);
					receipt = await runAuv({
						commandId: "display.captureRegion",
						argv: built.args,
						signal,
						timeoutMs: TOOL_TIMEOUT_MS
					});
				} else {
					const built = await buildInvoke("display.capture", {});
					warnings.push(...built.warnings);
					receipt = await runAuv({
						commandId: "display.capture",
						argv: built.args,
						signal,
						timeoutMs: TOOL_TIMEOUT_MS
					});
				}
				return screenshotValue(receipt, warnings);
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			isConcurrencySafe: () => false
		},
		{
			name: "auv_ocr",
			description: OCR_DESCRIPTION,
			parameters: objectSchema({
				text: stringProperty("Literal text to find in the captured image."),
				window_id: stringProperty(WINDOW_ID_DESCRIPTION),
				application_id: stringProperty(APPLICATION_ID_DESCRIPTION),
				wait: booleanProperty("Poll until the text appears instead of failing immediately."),
				timeout_ms: integerProperty("Polling timeout in milliseconds, 100-120000. Only valid with wait: true.")
			}, ["text"]),
			output: {
				schema: {},
				render(_args, value) {
					const outcome = objectArgs(value);
					const lines = [`OCR completed (${outcome.command_id ?? "ocr"}).`];
					if (outcome.timed_out === true) lines.push("The text did not appear before timeout_ms expired.");
					lines.push(warningsLine(outcome.warnings));
					if (typeof outcome.hint === "string" && outcome.hint !== "") lines.push(outcome.hint);
					lines.push("Matches are in \"result\"; use auv_click with text to click one.");
					return renderResult(lines, value);
				}
			},
			async execute(rawArgs, exec) {
				const args = objectArgs(rawArgs);
				const signal = exec?.signal;
				const text = requiredString(args, "text");
				const wait = args.wait === true;
				const timeoutMs = optionalInteger(args, "timeout_ms");
				const windowId = optionalString(args, "window_id");
				const applicationId = optionalString(args, "application_id");
				if (timeoutMs !== void 0 && !wait) throw new Error("timeout_ms is only valid with wait: true.");
				if (timeoutMs !== void 0 && (timeoutMs < 100 || timeoutMs > 12e4)) throw new Error("timeout_ms must be between 100 and 120000.");
				if (windowId !== void 0 && applicationId !== void 0) throw new Error("Pass only one of window_id or application_id to auv_ocr.");
				const commandId = windowId !== void 0 || applicationId !== void 0 ? wait ? "window.waitForText" : "window.findText" : wait ? "display.waitForText" : "display.findText";
				const command = (await getCatalogCommand(commandId)).command;
				const warnings = [];
				let target;
				let inputs = { [positionalKey(command, 0)]: text };
				if (windowId !== void 0) {
					const resolved = await resolveWindow(windowId, signal);
					warnings.push(...resolved.warnings);
					target = resolved.target;
					inputs = withWindowTitle(command, inputs, resolved.title);
				} else if (applicationId !== void 0) target = `app:${applicationId}`;
				if (wait && timeoutMs !== void 0) inputs = {
					...inputs,
					[flagKey(command, "--timeout-ms")]: timeoutMs
				};
				const built = await buildInvoke(commandId, inputs, { target });
				warnings.push(...built.warnings);
				const runnerTimeoutMs = wait ? clampTimeout((timeoutMs ?? 1e4) + 3e4) : TOOL_TIMEOUT_MS;
				const receipt = await runAuv({
					commandId,
					argv: built.args,
					target: built.target,
					signal,
					timeoutMs: Math.min(SLOW_TOOL_TIMEOUT_MS, runnerTimeoutMs)
				});
				return {
					...receiptMeta(receipt),
					result: receipt?.result ?? null,
					warnings,
					timed_out: receipt?.result?.timed_out === true
				};
			},
			timeoutMs: SLOW_TOOL_TIMEOUT_MS,
			isConcurrencySafe: () => false
		},
		{
			name: "auv_click",
			description: CLICK_DESCRIPTION,
			parameters: objectSchema({
				text: stringProperty("Visible text to locate with OCR and click. Cannot be combined with x/y."),
				x: numberProperty("Click X coordinate. Requires y; cannot be combined with text."),
				y: numberProperty("Click Y coordinate. Requires x; cannot be combined with text."),
				window_id: stringProperty(WINDOW_ID_DESCRIPTION),
				application_id: stringProperty(APPLICATION_ID_DESCRIPTION),
				display_id: stringProperty(DISPLAY_ID_DESCRIPTION),
				button: enumProperty("Mouse button for x/y clicks; defaults to left.", [
					"left",
					"right",
					"middle"
				]),
				within: WITHIN_SCHEMA
			}),
			output: {
				schema: {},
				render(_args, value) {
					const outcome = objectArgs(value);
					const lines = [`Clicked${typeof outcome.target === "string" && outcome.target !== "" ? ` via ${outcome.target}` : ""} (${outcome.command_id ?? "click"}).`];
					lines.push(warningsLine(outcome.warnings));
					return renderResult(lines, value);
				}
			},
			async execute(rawArgs, exec) {
				const args = objectArgs(rawArgs);
				const signal = exec?.signal;
				const text = optionalString(args, "text");
				const x = optionalNumber(args, "x");
				const y = optionalNumber(args, "y");
				const windowId = optionalString(args, "window_id");
				const applicationId = optionalString(args, "application_id");
				const displayId = optionalString(args, "display_id");
				const button = optionalEnum(args, "button", [
					"left",
					"right",
					"middle"
				]);
				const within = optionalObject(args, "within");
				if (windowId !== void 0 && applicationId !== void 0) throw new Error("Pass only one of window_id or application_id to auv_click.");
				const warnings = [];
				if (text !== void 0) {
					if (x !== void 0 || y !== void 0) throw new Error("Pass either \"text\" or both \"x\" and \"y\" to auv_click, not both forms.");
					if (button !== void 0 && button !== "left") throw new Error("button applies only to x/y clicks; OCR text clicks use the left button.");
					if (displayId !== void 0) throw new Error("display_id cannot be used with OCR text clicks. Omit it, or pass x and y for a display click.");
					if (within !== void 0 && (windowId !== void 0 || applicationId !== void 0)) throw new Error("within is only supported for screen-wide OCR clicks; omit window_id and application_id when using within.");
					const commandId = windowId !== void 0 || applicationId !== void 0 ? "window.clickText" : "display.clickText";
					const command = (await getCatalogCommand(commandId)).command;
					let inputs = { [positionalKey(command, 0)]: text };
					let target;
					if (windowId !== void 0) {
						const resolved = await resolveWindow(windowId, signal);
						warnings.push(...resolved.warnings);
						target = resolved.target;
						inputs = withWindowTitle(command, inputs, resolved.title);
					} else if (applicationId !== void 0) target = `app:${applicationId}`;
					if (within !== void 0) {
						const fence = formatFence(within);
						inputs = {
							...inputs,
							[flagKey(command, "--within")]: fence
						};
					}
					const built = await buildInvoke(commandId, inputs, { target });
					warnings.push(...built.warnings);
					const receipt = await runAuv({
						commandId,
						argv: built.args,
						target: built.target,
						signal,
						timeoutMs: SLOW_TOOL_TIMEOUT_MS
					});
					return {
						...receiptMeta(receipt),
						target: built.target ?? null,
						result: receipt?.result ?? null,
						warnings
					};
				}
				if (x === void 0 || y === void 0) throw new Error("auv_click requires either \"text\" or both \"x\" and \"y\".");
				if (within !== void 0) throw new Error("within applies only to OCR text clicks; omit it for x/y clicks.");
				if (displayId !== void 0 && windowId !== void 0) throw new Error("Pass only one of window_id or display_id to auv_click.");
				const target = windowId !== void 0 ? `window:${windowId}` : applicationId !== void 0 ? `app:${applicationId}` : displayId !== void 0 ? `display:${displayId}` : void 0;
				const command = (await getCatalogCommand("input.clickPoint")).command;
				let inputs = {
					[positionalKey(command, 0)]: x,
					[positionalKey(command, 1)]: y
				};
				if (button !== void 0) inputs = {
					...inputs,
					[flagKey(command, "--button")]: button
				};
				const built = await buildInvoke("input.clickPoint", inputs, { target });
				warnings.push(...built.warnings);
				const receipt = await runAuv({
					commandId: "input.clickPoint",
					argv: built.args,
					target: built.target,
					signal,
					timeoutMs: TOOL_TIMEOUT_MS
				});
				return {
					...receiptMeta(receipt),
					target: built.target ?? null,
					result: receipt?.result ?? null,
					warnings
				};
			},
			timeoutMs: SLOW_TOOL_TIMEOUT_MS,
			isConcurrencySafe: () => false
		},
		{
			name: "auv_type",
			description: TYPE_DESCRIPTION,
			parameters: objectSchema({
				text: stringProperty("Text to type or paste into the focused control."),
				mode: enumProperty("\"type\" sends keystrokes; \"paste\" uses the clipboard and restores it.", ["type", "paste"]),
				window_id: stringProperty(WINDOW_ID_DESCRIPTION),
				application_id: stringProperty(APPLICATION_ID_DESCRIPTION),
				policy: enumProperty("Delivery policy: foreground activates the app first; background modes do not.", [
					"background-only",
					"background-preferred",
					"foreground-preferred"
				])
			}, ["text"]),
			output: {
				schema: {},
				render(_args, value) {
					const outcome = objectArgs(value);
					const lines = [`Text delivered (${outcome.command_id ?? "input"}).`];
					lines.push(warningsLine(outcome.warnings));
					return renderResult(lines, value);
				}
			},
			async execute(rawArgs, exec) {
				const args = objectArgs(rawArgs);
				const signal = exec?.signal;
				const text = requiredString(args, "text");
				const mode = optionalEnum(args, "mode", ["type", "paste"]) ?? "type";
				const policy = optionalEnum(args, "policy", [
					"background-only",
					"background-preferred",
					"foreground-preferred"
				]);
				const windowId = optionalString(args, "window_id");
				const applicationId = optionalString(args, "application_id");
				if (windowId !== void 0 && applicationId !== void 0) throw new Error("Pass only one of window_id or application_id to auv_type.");
				const commandId = mode === "paste" ? "input.pasteText" : "input.typeText";
				const command = (await getCatalogCommand(commandId)).command;
				let inputs = { [positionalKey(command, 0)]: text };
				if (policy !== void 0) inputs = {
					...inputs,
					[flagKey(command, "--input-policy")]: policy
				};
				const target = windowId !== void 0 ? `window:${windowId}` : applicationId !== void 0 ? `app:${applicationId}` : void 0;
				const built = await buildInvoke(commandId, inputs, { target });
				const receipt = await runAuv({
					commandId,
					argv: built.args,
					target: built.target,
					signal,
					timeoutMs: TOOL_TIMEOUT_MS
				});
				return {
					...receiptMeta(receipt),
					target: built.target ?? null,
					result: receipt?.result ?? null,
					warnings: built.warnings
				};
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			isConcurrencySafe: () => false
		},
		{
			name: "auv_keys",
			description: KEYS_DESCRIPTION,
			parameters: objectSchema({
				keys: {
					type: "array",
					items: { type: "string" },
					description: "One key combination as ordered key names, for example [\"ctrl\",\"l\"] or [\"cmd\",\"shift\",\"t\"]. Modifiers first."
				},
				repeat: integerProperty("Number of complete presses, 1-255. Values above 1 require interval_ms."),
				interval_ms: integerProperty("Delay in milliseconds between repeated presses; only used with repeat greater than 1 (default 50)."),
				window_id: stringProperty(WINDOW_ID_DESCRIPTION),
				application_id: stringProperty(APPLICATION_ID_DESCRIPTION)
			}, ["keys"]),
			output: {
				schema: {},
				render(_args, value) {
					const outcome = objectArgs(value);
					const lines = [`Keys pressed (${outcome.command_id ?? "input.pressKeys"}).`];
					lines.push(warningsLine(outcome.warnings));
					return renderResult(lines, value);
				}
			},
			async execute(rawArgs, exec) {
				const args = objectArgs(rawArgs);
				const signal = exec?.signal;
				const rawKeys = args.keys;
				const keys = Array.isArray(rawKeys) ? rawKeys.filter((key) => typeof key === "string" && key !== "") : [];
				if (keys.length === 0) throw new Error("auv_keys requires \"keys\" as a non-empty array of key names, for example [\"ctrl\",\"l\"].");
				const repeat = optionalInteger(args, "repeat");
				if (repeat !== void 0 && (repeat < 1 || repeat > 255)) throw new Error("repeat must be between 1 and 255.");
				const interval = optionalInteger(args, "interval_ms");
				if (interval !== void 0 && interval < 1) throw new Error("interval_ms must be a positive integer.");
				if (repeat === void 0 || repeat <= 1) {
					if (interval !== void 0) throw new Error("interval_ms is only valid with repeat greater than 1.");
				}
				const windowId = optionalString(args, "window_id");
				const applicationId = optionalString(args, "application_id");
				if (windowId !== void 0 && applicationId !== void 0) throw new Error("Pass only one of window_id or application_id to auv_keys.");
				const command = (await getCatalogCommand("input.pressKeys")).command;
				let inputs = { [positionalKey(command, 0)]: keys };
				if (repeat !== void 0 && repeat > 1) inputs = {
					...inputs,
					[flagKey(command, "--count")]: repeat,
					[flagKey(command, "--interval-ms")]: interval ?? 50
				};
				const target = windowId !== void 0 ? `window:${windowId}` : applicationId !== void 0 ? `app:${applicationId}` : void 0;
				const built = await buildInvoke("input.pressKeys", inputs, { target });
				const receipt = await runAuv({
					commandId: "input.pressKeys",
					argv: built.args,
					target: built.target,
					signal,
					timeoutMs: TOOL_TIMEOUT_MS
				});
				return {
					...receiptMeta(receipt),
					target: built.target ?? null,
					result: receipt?.result ?? null,
					warnings: built.warnings
				};
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			isConcurrencySafe: () => false
		},
		{
			name: "auv_scroll",
			description: SCROLL_DESCRIPTION,
			parameters: objectSchema({
				dy: numberProperty("Vertical delta in logical pixels; positive scrolls down."),
				dx: numberProperty("Horizontal delta in logical pixels; positive scrolls right."),
				window_id: stringProperty(WINDOW_ID_DESCRIPTION),
				x: numberProperty("X coordinate: window-local with window_id, otherwise screen coordinate."),
				y: numberProperty("Y coordinate: window-local with window_id, otherwise screen coordinate.")
			}, ["dy"]),
			output: {
				schema: {},
				render(_args, value) {
					const outcome = objectArgs(value);
					const lines = [`Scrolled (${outcome.command_id ?? "scroll"}).`];
					lines.push(warningsLine(outcome.warnings));
					return renderResult(lines, value);
				}
			},
			async execute(rawArgs, exec) {
				const args = objectArgs(rawArgs);
				const signal = exec?.signal;
				const dy = optionalNumber(args, "dy");
				if (dy === void 0) throw new Error("auv_scroll requires \"dy\", the vertical delta in logical pixels (positive scrolls down).");
				const dx = optionalNumber(args, "dx");
				const windowId = optionalString(args, "window_id");
				const x = optionalNumber(args, "x");
				const y = optionalNumber(args, "y");
				const warnings = [];
				if (windowId !== void 0) {
					let pointX = x;
					let pointY = y;
					if (pointX === void 0 || pointY === void 0) {
						const resolved = await resolveWindow(windowId, signal);
						warnings.push(...resolved.warnings);
						const size = resolved.window?.frame?.size ?? {};
						const width = Number(size.width);
						const height = Number(size.height);
						if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error(`AUV could not read the frame of window "${windowId}"; pass window-local x and y explicitly.`);
						if (pointX === void 0) pointX = Math.round(width / 2);
						if (pointY === void 0) pointY = Math.round(height / 2);
					}
					const command = (await getCatalogCommand("window.scroll")).command;
					let inputs = {
						[positionalKey(command, 0)]: pointX,
						[positionalKey(command, 1)]: pointY,
						[flagKey(command, "--dy")]: dy
					};
					if (dx !== void 0) inputs = {
						...inputs,
						[flagKey(command, "--dx")]: dx
					};
					const built = await buildInvoke("window.scroll", inputs, { target: `window:${windowId}` });
					warnings.push(...built.warnings);
					const receipt = await runAuv({
						commandId: "window.scroll",
						argv: built.args,
						target: built.target,
						signal,
						timeoutMs: TOOL_TIMEOUT_MS
					});
					return {
						...receiptMeta(receipt),
						result: receipt?.result ?? null,
						warnings
					};
				}
				if (x === void 0 || y === void 0) throw new Error("auv_scroll requires \"window_id\", or both \"x\" and \"y\" screen coordinates. On macOS AUV cannot scroll at a raw screen point, so prefer window_id.");
				if (process.platform === "darwin") throw new Error("macOS cannot scroll at a screen point: AUV's input.scrollPoint is available only on Linux and Windows. Pass window_id (and optionally window-local x and y) so the scroll goes through window.scroll.");
				const command = (await getCatalogCommand("input.scrollPoint")).command;
				const built = await buildInvoke("input.scrollPoint", {
					[positionalKey(command, 0)]: x,
					[positionalKey(command, 1)]: y,
					[positionalKey(command, 2)]: dx ?? 0,
					[positionalKey(command, 3)]: dy
				});
				warnings.push(...built.warnings);
				let receipt;
				try {
					receipt = await runAuv({
						commandId: "input.scrollPoint",
						argv: built.args,
						signal,
						timeoutMs: TOOL_TIMEOUT_MS
					});
				} catch (error) {
					throw withHint(error, "On macOS AUV cannot scroll at a screen point. Pass window_id (and optionally window-local x/y) to scroll inside a window instead.");
				}
				return {
					...receiptMeta(receipt),
					result: receipt?.result ?? null,
					warnings
				};
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			isConcurrencySafe: () => false
		},
		{
			name: "auv_windows",
			description: WINDOWS_DESCRIPTION,
			parameters: objectSchema({
				include_minimized: booleanProperty("Include minimized windows. Default false."),
				include_other_desktops: booleanProperty("Include windows on other virtual desktops. Default false.")
			}),
			output: {
				schema: {},
				render(_args, value) {
					const outcome = objectArgs(value);
					const windows = Array.isArray(outcome.windows) ? outcome.windows : [];
					const lines = [`${windows.length} window${windows.length === 1 ? "" : "s"} listed.`];
					for (const window of windows.slice(0, 40)) lines.push(formatWindowLine(window));
					if (windows.length > 40) lines.push(`… ${windows.length - 40} more windows in "windows".`);
					return renderResult(lines, value);
				}
			},
			async execute(rawArgs, exec) {
				const args = objectArgs(rawArgs);
				const signal = exec?.signal;
				const includeMinimized = args.include_minimized === true;
				const includeOtherDesktops = args.include_other_desktops === true;
				const command = (await getCatalogCommand("window.list")).command;
				const inputs = {};
				if (!includeMinimized) inputs[flagKey(command, "--exclude-minimized")] = true;
				if (!includeOtherDesktops) inputs[flagKey(command, "--exclude-other-desktops")] = true;
				const built = await buildInvoke("window.list", inputs);
				const receipt = await runAuv({
					commandId: "window.list",
					argv: built.args,
					signal,
					timeoutMs: TOOL_TIMEOUT_MS
				});
				const windows = Array.isArray(receipt?.result) ? receipt.result : [];
				return {
					...receiptMeta(receipt),
					windows,
					warnings: built.warnings
				};
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			isConcurrencySafe: () => false
		},
		{
			name: "auv_activate",
			description: ACTIVATE_DESCRIPTION,
			parameters: objectSchema({ application_id: stringProperty(APPLICATION_ID_DESCRIPTION) }, ["application_id"]),
			output: {
				schema: {},
				render(_args, value) {
					const outcome = objectArgs(value);
					const lines = [`Activated ${typeof outcome.target === "string" && outcome.target !== "" ? outcome.target : "application"}.`];
					lines.push(warningsLine(outcome.warnings));
					return renderResult(lines, value);
				}
			},
			async execute(rawArgs, exec) {
				const args = objectArgs(rawArgs);
				const signal = exec?.signal;
				const built = await buildInvoke("application.activate", {}, { target: `app:${requiredString(args, "application_id")}` });
				const receipt = await runAuv({
					commandId: "application.activate",
					argv: built.args,
					target: built.target,
					signal,
					timeoutMs: TOOL_TIMEOUT_MS
				});
				return {
					...receiptMeta(receipt),
					target: built.target ?? null,
					result: receipt?.result ?? null,
					warnings: built.warnings
				};
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			isConcurrencySafe: () => false
		},
		{
			name: "auv_invoke",
			description: INVOKE_DESCRIPTION,
			parameters: objectSchema({
				command_id: stringProperty("AUV command id from auv_help, for example \"display.list\" or \"window.get\"."),
				inputs: {
					type: "object",
					description: "Argument values keyed by the catalog input keys shown by auv_help, for example {\"text\":\"Settings\"} or {\"x\":10,\"y\":20}. Values may be strings, numbers, booleans, or arrays of strings."
				},
				target: TARGET_SCHEMA,
				dry_run: booleanProperty("Validate the command and its arguments before running it. Not side-effect free for every command: application.activate still activates in dry-run.")
			}, ["command_id"]),
			output: {
				schema: {},
				render(_args, value) {
					const outcome = objectArgs(value);
					const lines = [`Ran ${outcome.command_id ?? "AUV command"} (${outcome.status ?? "unknown status"}).`];
					lines.push(warningsLine(outcome.warnings));
					const artifacts = Array.isArray(outcome.artifacts) ? outcome.artifacts : [];
					for (const artifact of artifacts) if (typeof artifact?.file_path === "string" && artifact.file_path !== "") lines.push(`artifact_path: ${artifact.file_path}${artifact.content_type ? ` (${artifact.content_type})` : ""}`);
					if (artifacts.some((artifact) => typeof artifact?.content_type === "string" && artifact.content_type.startsWith("image/"))) lines.push("Call read_image with an image artifact_path to view it.");
					return renderResult(lines, value);
				}
			},
			async execute(rawArgs, exec) {
				const args = objectArgs(rawArgs);
				const signal = exec?.signal;
				const commandId = requiredString(args, "command_id");
				const inputs = optionalObject(args, "inputs") ?? {};
				const targetInput = optionalObject(args, "target");
				const dryRun = args.dry_run === true;
				const { catalog, command } = await getCatalogCommand(commandId);
				let target;
				if (targetInput !== void 0) {
					const selected = [
						optionalString(targetInput, "application_id"),
						optionalString(targetInput, "window_id"),
						optionalString(targetInput, "display_id")
					].filter((entry) => entry !== void 0);
					if (selected.length > 1) throw new Error("target accepts only one of application_id, window_id, or display_id.");
					if (selected.length === 0) throw new Error("target was provided but names no application_id, window_id, or display_id.");
					target = typeof catalog.formatTarget === "function" ? await catalog.formatTarget(targetInput) : formatTargetFallback(targetInput);
					if (typeof target !== "string" || target === "") target = void 0;
				}
				const policy = command?.target?.policy;
				if (policy === "forbidden" && target !== void 0) throw new Error(`AUV command "${commandId}" does not accept a target. Omit the target parameter.`);
				if (policy === "required" && target === void 0) throw new Error(`AUV command "${commandId}" requires a target: pass target.application_id, target.window_id, or target.display_id.`);
				if (policy !== "forbidden" && target !== void 0) {
					const accepted = Array.isArray(command?.target?.accepted_types) ? command.target.accepted_types : [];
					const type = targetTypeName(target);
					if (accepted.length > 0 && !accepted.includes(type)) throw new Error(`AUV command "${commandId}" does not accept a ${type} target; accepted target types: ${accepted.join(", ")}.`);
				}
				const built = await buildInvoke(commandId, inputs, { target });
				const receipt = await runAuv({
					commandId,
					argv: built.args,
					target: built.target,
					dryRun,
					signal,
					timeoutMs: SLOW_TOOL_TIMEOUT_MS
				});
				return {
					...receiptMeta(receipt),
					result: receipt?.result ?? null,
					artifacts: Array.isArray(receipt?.artifacts) ? receipt.artifacts : [],
					warnings: [...built.warnings]
				};
			},
			timeoutMs: SLOW_TOOL_TIMEOUT_MS,
			isConcurrencySafe: () => false
		},
		{
			name: "auv_help",
			description: HELP_DESCRIPTION,
			parameters: objectSchema({ command_id: stringProperty("Optional command id; omit to list every command.") }),
			output: {
				schema: {},
				render(_args, value) {
					const outcome = objectArgs(value);
					const lines = [];
					if (outcome.mode === "summary") {
						const count = typeof outcome.count === "number" ? ` (${outcome.count} commands)` : "";
						lines.push(`AUV command catalog${count}. Use one of these ids as auv_invoke.command_id.`);
					} else if (outcome.mode === "command") lines.push(`AUV command details: ${outcome.command_id ?? "unknown"}.`);
					if (typeof outcome.text === "string" && outcome.text !== "") lines.push(outcome.text);
					return textBlock(lines.join("\n"));
				}
			},
			async execute(rawArgs, exec) {
				const args = objectArgs(rawArgs);
				if ((exec?.signal)?.aborted === true) throw new Error("AUV help call was aborted.");
				const commandId = optionalString(args, "command_id");
				const catalog = await getCatalogModule();
				if (commandId !== void 0) {
					if (typeof catalog.getCommand === "function") {
						const command = await catalog.getCommand(commandId);
						if (command === void 0 || command === null) throw new Error(`Unknown AUV command "${commandId}". Call auv_help without command_id to list every command id.`);
					}
					const detail = typeof catalog.commandHelpText === "function" ? await catalog.commandHelpText(commandId) : "";
					return {
						mode: "command",
						command_id: commandId,
						text: typeof detail === "string" ? detail : boundedJson(detail)
					};
				}
				const summary = typeof catalog.summaryText === "function" ? await catalog.summaryText() : "";
				return {
					mode: "summary",
					count: Array.isArray(catalog.CATALOG?.commands) ? catalog.CATALOG.commands.length : null,
					text: typeof summary === "string" ? summary : boundedJson(summary)
				};
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			isConcurrencySafe: () => false
		}
	];
}
function optionalRegion(args) {
	const region = optionalObject(args, "region");
	if (region === void 0) return void 0;
	const values = {};
	for (const key of [
		"x",
		"y",
		"width",
		"height"
	]) {
		const value = Number(region[key]);
		if (!Number.isFinite(value)) throw new Error(`region.${key} must be a finite number.`);
		values[key] = value;
	}
	if (values.width <= 0 || values.height <= 0) throw new Error("region.width and region.height must be greater than zero.");
	return values;
}
function regionInputs(command, region) {
	return {
		[flagKey(command, "--x")]: region.x,
		[flagKey(command, "--y")]: region.y,
		[flagKey(command, "--width")]: region.width,
		[flagKey(command, "--height")]: region.height
	};
}
function formatFence(within) {
	return [
		"left",
		"top",
		"right",
		"bottom"
	].map((key) => {
		const value = Number(within[key]);
		if (!Number.isFinite(value)) throw new Error(`within.${key} must be a finite number.`);
		return value;
	}).join(",");
}
function screenshotValue(receipt, warnings) {
	const result = receipt?.result ?? null;
	const pixels = (result?.capture ?? null)?.pixel_dimensions ?? {};
	const artifacts = Array.isArray(receipt?.artifacts) ? receipt.artifacts : [];
	const dimension = (value) => value === void 0 || value === null || !Number.isFinite(Number(value)) ? null : Number(value);
	return {
		...receiptMeta(receipt),
		artifact_path: artifactPathOf(receipt),
		content_type: typeof artifacts[0]?.content_type === "string" ? artifacts[0].content_type : null,
		width: dimension(pixels.width),
		height: dimension(pixels.height),
		result,
		artifacts,
		warnings
	};
}
function formatWindowLine(window) {
	if (window === null || typeof window !== "object") return "- (unreadable window entry)";
	const id = window.reference?.id !== void 0 ? String(window.reference.id) : "?";
	const app = typeof window.application_id === "string" && window.application_id !== "" ? window.application_id : "(unknown app)";
	const title = typeof window.title === "string" && window.title !== "" ? window.title : "(untitled)";
	const frame = window.frame ?? {};
	const origin = frame.origin ?? {};
	const size = frame.size ?? {};
	const geometry = [
		origin.x,
		origin.y,
		size.width,
		size.height
	].every((value) => Number.isFinite(Number(value))) ? ` [${Number(origin.x)},${Number(origin.y)} ${Number(size.width)}×${Number(size.height)}]` : "";
	const state = window.state ?? {};
	const flags = [];
	if (state.is_minimized === true) flags.push("minimized");
	if (state.is_focused === true) flags.push("focused");
	if (state.desktop !== null && state.desktop !== void 0) flags.push(`desktop ${String(state.desktop)}`);
	return `- id ${id} | ${app} | ${title}${geometry}${flags.length > 0 ? ` | ${flags.join(", ")}` : ""}`;
}
function formatTargetFallback(target) {
	const applicationId = typeof target?.application_id === "string" ? target.application_id.trim() : "";
	const windowId = typeof target?.window_id === "string" ? target.window_id.trim() : "";
	const displayId = typeof target?.display_id === "string" ? target.display_id.trim() : "";
	if (applicationId !== "") return `app:${applicationId}`;
	if (windowId !== "") return `window:${windowId}`;
	if (displayId !== "") return `display:${displayId}`;
}
/**
* Map a formatted `--target` string to the catalog's target type vocabulary:
* `app:*` is called "application" in catalog accepted_types, the others match.
*/
function targetTypeName(formattedTarget) {
	const prefix = typeof formattedTarget === "string" && formattedTarget.includes(":") ? formattedTarget.slice(0, formattedTarget.indexOf(":")) : "";
	return prefix === "app" ? "application" : prefix;
}
// index.js
/**
* @local/dsh-auv — AUV desktop automation as native DSH tools.
*
* `ctx.tools.register()` is effect-scoped by the tool registry, so registrations
* are removed automatically when this plugin unloads; `apply` stays synchronous
* and never touches the AUV binary (binary resolution happens lazily on the
* first tool call).
*/
const inject = ["tools"];
function apply(ctx) {
	for (const definition of createTools()) ctx.tools.register(definition);
	try {
		resolveAuvBinary();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[dsh-auv] AUV is not available yet. The auv_* tools will fail until it is installed.\n${message}`);
	}
}
export { apply, inject };
