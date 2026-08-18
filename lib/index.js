// @dsharness/dsh-sound-notify — host half.
//
// Registers the "sound-notify" settings namespace — the live configuration
// surface for the browser half (it reads it through ctx.settingsScope and
// renders the Settings > 个性化 page: background + 提示音). The same schema
// doubles as the loader row's Config validation, so a cordis.patch.yml row
// may seed defaults (settings resolution: schema defaults → row base → user
// settings.yaml).
//
// Also hosts the local-file import: a POST upload route and a static file
// route under /plugins/sound-notify/*, storing files under
// $DSH_HOME/sound-notify/. Settings store only the returned URL (no base64
// bloat), so background images and custom audio files work the same way.

import { mkdirSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import z from "@deepseek-ai/schemastery";

const SOUND = z.union(["rising", "falling", "dingdong", "beep", "custom", "off"]);
const REPEAT = z.number().min(1).max(10).default(1);
const INTERVAL = z.number().min(0).max(5000).default(500);

export const Config = z.object({
  enabled: z.boolean().default(true),
  questionSound: SOUND.default("rising"),
  questionVolume: z.number().default(0.25),
  questionRepeat: REPEAT,
  questionInterval: INTERVAL,
  questionCustomSound: z.string().default(""),
  approvalSound: SOUND.default("falling"),
  approvalVolume: z.number().default(0.25),
  approvalRepeat: REPEAT,
  approvalInterval: INTERVAL,
  approvalCustomSound: z.string().default(""),
  completionSound: SOUND.default("dingdong"),
  completionVolume: z.number().default(0.25),
  completionRepeat: REPEAT,
  completionInterval: INTERVAL,
  completionCustomSound: z.string().default(""),
  // Background personalization（单一背景色，明暗主题共用；空字符串 = 不覆盖，使用主题默认）
  bgColor: z.string().default(""),
  bgImage: z.string().default(""),
  // Global mask (0-1): opacity of the theme background kept on the content
  // surfaces (frame / chat / details) over the image. 0 = transparent, image
  // fully visible; 1 = opaque theme surface, image hidden. The image itself is
  // always rendered at full opacity.
  bgOpacity: z.number().default(0.85),
  // Sidebar mask (0-1): same idea for the left rail's own fill token.
  sidebarMask: z.number().default(1)
});

/**
* The settings provider is a Service with an async init (it loads the user
* document and arms a file watcher), so the namespace must wait for it — a
* plain `ctx.get("settings")` at apply time can race the provider and silently
* bail, leaving the namespace unregistered. Declaring `inject` parks this
* fiber until the settings service is active.
*/
export const inject = ["settings", "webServer"];

const UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
const UPLOAD_PREFIX = "/plugins/sound-notify/upload";
const FILES_PREFIX = "/plugins/sound-notify/files";
const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".webm": "audio/webm"
};

/** Strip anything outside a safe file-name alphabet; keeps the extension. */
function sanitizeName(name) {
  return (name || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

/** Accumulate a request body up to `limit` bytes. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("upload exceeds size limit"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function apply(ctx, _config) {
  // The namespace registration is effect-scoped: unload removes it. Values are
  // persisted by the settings provider ($DSH_HOME/settings.yaml) and changes
  // broadcast to every open page via settings/document-updated.
  ctx.settings.register("sound-notify", Config);

  const dshHomePath = ctx.get("dshHomePath");
  const storageDir = dshHomePath === void 0 ? null : dshHomePath("sound-notify");
  if (storageDir === null) return;
  mkdirSync(storageDir, { recursive: true });

  /** POST /plugins/sound-notify/upload — raw body, filename via x-file-name. */
  const uploadHandler = async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    try {
      const body = await readBody(req, UPLOAD_LIMIT_BYTES);
      const rawName = req.headers["x-file-name"];
      const name = sanitizeName(typeof rawName === "string" ? decodeURIComponent(rawName) : "");
      const stored = `${Date.now()}-${name}`;
      await writeFile(join(storageDir, stored), body);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, url: `${FILES_PREFIX}/${encodeURIComponent(stored)}` }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  };

  /** GET /plugins/sound-notify/files/* — serve stored uploads (traversal-guarded). */
  const serveHandler = async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    let rel;
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      rel = pathname.slice(FILES_PREFIX.length).replace(/^\/+/, "");
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const target = resolve(storageDir, rel);
    if (target !== storageDir && !target.startsWith(storageDir + sep)) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const data = await readFile(target);
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-cache"
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  };

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: "exact", path: UPLOAD_PREFIX, handler: uploadHandler }),
      ctx.webServer.register({ kind: "prefix", path: FILES_PREFIX, handler: serveHandler })
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "dsh-sound-notify: upload + file routes");
}
