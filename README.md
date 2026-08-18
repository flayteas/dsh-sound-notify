# dsh-sound-notify

DSH web 插件：个性化面板——当 agent 向你提问、发起审批申请或完成一轮任务时播放提示音（每个触发条件可单独设置音效、音量、重复次数与间隔），并可自定义主背景（背景色、背景图片、图片不透明度）。

## 安装

**方式一：一条命令（推荐，需要 pnpm）**

```powershell
# 在下载了 dsharness-dsh-sound-notify-0.1.0.tgz 的目录里执行
dsh plugin --profile web add .\dsharness-dsh-sound-notify-0.1.0.tgz
```

**方式二：手动安装（没有 pnpm 时）**

1. 把 `@dsharness/dsh-sound-notify` 整个目录复制到 `$DSH_HOME/profiles/node_modules/@dsharness/dsh-sound-notify`
2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里追加：

```yaml
- insert:
    - id: sound-notify
      name: '@dsharness/dsh-sound-notify'
```

安装后**重启 `dsh web` 并刷新页面**即可生效。

## 界面

打开 设置 → **个性化**：

- **背景**：背景色（色板）、背景图片 URL、图片不透明度（0–100%）、恢复默认。背景色与主题（设置 → 外观）互补；设置图片后主背景透明以显示图片，各面板保持不透明
- **提示音**：启用总开关 + 三个触发条件（**提问 / 审批 / 任务完成**）各一组：**音效**（上扬 / 下行 / 叮咚 / 单声 / 静音）、**音量**、**次数**（1–10）、**间隔**（0–5000 ms），带**试听**按钮

改动自动保存到 `$DSH_HOME/settings.yaml`，实时生效，无需刷新。

## 实现

- **host 半**（`lib/index.js`）：注册 `sound-notify` 设置 namespace（声明 `inject: ["settings"]` 等待异步初始化的设置服务）
- **浏览器半**（`lib/client.js`）：
  - 提示音：订阅客户端会话运行时——`question/requested`、`approval/requested` 帧变成会话的 pending 交互，任务完成表现为 running 位翻转；按设置用 Web Audio 合成播放（零音频资源）
  - 背景：背景色通过 `ctx.theme.overrideTokens` 覆盖 `--dsw-alias-bg-base` 主题令牌；背景图片注入固定 `body::before` 层（`cover` 铺满 + 透明度），框架背景转透明后图片透出
