// @dsharness/dsh-sound-notify — host half.
//
// Registers the "sound-notify" settings namespace — the live configuration
// surface for the browser half (it reads it through ctx.settingsScope and
// renders the Settings > 提示音 page). The same schema doubles as the loader
// row's Config validation, so a cordis.patch.yml row may seed defaults
// (settings resolution: schema defaults → row base → user settings.yaml).

import z from "@deepseek-ai/schemastery";

const SOUND = z.union(["rising", "falling", "dingdong", "beep", "off"]);
const REPEAT = z.number().min(1).max(10).default(1);
const INTERVAL = z.number().min(0).max(5000).default(500);

export const Config = z.object({
  enabled: z.boolean().default(true),
  questionSound: SOUND.default("rising"),
  questionVolume: z.number().default(0.25),
  questionRepeat: REPEAT,
  questionInterval: INTERVAL,
  approvalSound: SOUND.default("falling"),
  approvalVolume: z.number().default(0.25),
  approvalRepeat: REPEAT,
  approvalInterval: INTERVAL,
  completionSound: SOUND.default("dingdong"),
  completionVolume: z.number().default(0.25),
  completionRepeat: REPEAT,
  completionInterval: INTERVAL
});

/**
* The settings provider is a Service with an async init (it loads the user
* document and arms a file watcher), so the namespace must wait for it — a
* plain `ctx.get("settings")` at apply time can race the provider and silently
* bail, leaving the namespace unregistered. Declaring `inject` parks this
* fiber until the settings service is active.
*/
export const inject = ["settings"];

export function apply(ctx, _config) {
  // The namespace registration is effect-scoped: unload removes it. Values are
  // persisted by the settings provider ($DSH_HOME/settings.yaml) and changes
  // broadcast to every open page via settings/document-updated.
  ctx.settings.register("sound-notify", Config);
}
