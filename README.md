# @dsharness/dsh-sound-notify

DSH web 插件：当 agent 向用户提问（`ask_user_question` / 计划审阅）、发起审批申请（沙箱升级、工具审批等），或**完成一轮任务**时，在浏览器里播放提示音。

**每个触发条件可独立配置音效、音量、重复次数与间隔**（设置 → 提示音，实时生效、持久化到 `$DSH_HOME/settings.yaml`）：

| 触发条件 | 默认音效 | 默认音量 | 次数 | 间隔 |
| --- | --- | --- | --- | --- |
| 提问（`question` / plan-review） | 上扬 620→880 Hz | 0.25 | 1 | 500 ms |
| 审批（`approval`） | 下行 880→620 Hz | 0.25 | 1 | 500 ms |
| 任务完成（running true→false 且无待处理交互） | 叮咚 880→660 Hz | 0.25 | 1 | 500 ms |

内置音效预设：**上扬 / 下行 / 叮咚 / 单声 / 静音**（每触发条件独立选择，可各自静音）。次数 1–10、间隔 0–5000 ms。

## 架构

```
包 @dsharness/dsh-sound-notify
├── package.json       dsh.bundle（分发）+ dsh.client（浏览器半）声明
├── cordis.patch.yml   bundle 补丁层（自动插入 sound-notify 行）
├── lib/index.js       host 半：Config schema + 注册 "sound-notify" 设置 namespace
└── lib/client.js      浏览器半：音效引擎 + 会话观察 + 设置页 UI
```

**配置流（设置系统）**：

```
用户改设置页 → scope.set(field) → host settings.mutate → 持久化 settings.yaml
  → settings/document-updated 广播 → 所有打开页面的 settingsScope 自动刷新
  → 插件按新配置播放（无需刷新页面）
```

**事件流（实测代码）**：

1. Agent 调用 `ask_user_question` → host `dsh-host-apiproxy` 直接推送 `question/requested` mux 帧
2. 审批请求 → `approval/requested` mux 帧
3. 浏览器 `SessionRuntime` 把它们变成会话 snapshot 的 `pending` 数组（`PendingWait`，`kind: "question" | "approval"`）——这正是提问/审批卡片渲染所依据的数据
4. 本插件的浏览器半订阅 `ctx.sessions`：对每个会话 diff `pending` 的请求 key，新出现的 key 就响对应音色；完成信号走 snapshot `running` 边沿（当前会话）或列表行 `completed` 标记（后台会话）

Host 侧没有可订阅的提问/审批事件，所以感知必须在浏览器半完成——这也正好是提示音需要播放的地方。

## 安装与验证

1. 包已放到 `$DSH_HOME/profiles/node_modules/@dsharness/dsh-sound-notify`
2. `profiles/web/cordis.patch.yml` 已注册行 `sound-notify`
3. profile 的 `cordis.patch.yml` 通过 HMR 热重载；`client-modules` 服务会增量扫描新激活的 loader 条目并把 bundle 加入启动图（`window.__DSH_BOOT__`），bundle 由 `/plugins/<id>/client.js` 按请求从磁盘读取
4. **刷新页面**即可生效；如果插件没出现，重启 web GUI 兜底

验证方式：设置 → 提示音 里用**试听**按钮调音效；在会话里让 agent 调用一次 `ask_user_question`（提问音），再触发一次审批/计划审阅（审批音），跑完一个任务（完成音）。

## 设置项（设置 → 提示音，持久化到 `$DSH_HOME/settings.yaml`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `questionSound` / `questionVolume` | `rising` / `0.25` | 提问音效与音量 |
| `questionRepeat` / `questionInterval` | `1` / `500` | 提问重复次数（1–10）与间隔 ms（0–5000） |
| `approvalSound` / `approvalVolume` | `falling` / `0.25` | 审批音效与音量 |
| `approvalRepeat` / `approvalInterval` | `1` / `500` | 审批重复次数与间隔 |
| `completionSound` / `completionVolume` | `dingdong` / `0.25` | 完成音效与音量 |
| `completionRepeat` / `completionInterval` | `1` / `500` | 完成重复次数与间隔 |

音效取值：`rising`（上扬）、`falling`（下行）、`dingdong`（叮咚）、`beep`（单声）、`off`（静音）。
同一 schema 也作为 loader 行 Config 校验，所以 `cordis.patch.yml` 行的 `config` 可播种默认值（可选）。

## 打包分发（发给别人）

本包声明了 `dsh.bundle`（自带 `cordis.patch.yml`），所以支持 DSH 官方推荐的**一条命令安装**。分发包用 `npm pack` 生成 tarball：

```powershell
cd C:\dsharness\plugins\dsh-sound-notify
npm pack          # 生成 dsharness-dsh-sound-notify-0.1.0.tgz
```

### 对方安装（推荐，一条命令）

需要对方机器上装有 **pnpm**（`dsh plugin` 是 pnpm 转发器）：

```powershell
# 在下载了 tgz 的目录里执行
dsh plugin --profile web add .\dsharness-dsh-sound-notify-0.1.0.tgz
# 重启 web（dsh web），刷新页面
```

`dsh plugin add` 会：pnpm 安装包 → 检测到 `dsh.bundle` 声明 → 自动把它加进 `dsh.profile.bundles` → 下次启动时其 patch 自动插入 `sound-notify` 行。**对方无需手动改任何配置文件。**

### 手动安装（对方没有 pnpm 时）

与开发机同样的两步：

1. 把 `@dsharness/dsh-sound-notify` 目录复制到 `$DSH_HOME/profiles/node_modules/@dsharness/dsh-sound-notify`
2. 在 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 里加：

```yaml
- insert:
    - id: sound-notify
      name: '@dsharness/dsh-sound-notify'
```

3. 重启/刷新

### 发布到 registry（公开或公司私有源）

包已具备发布条件（`npm pack` 通过即可 `npm publish`），对方直接：

```powershell
dsh plugin --profile web add @dsharness/dsh-sound-notify
```

### 注意事项

- 对方 profile 若已手动加过 `sound-notify` 行，用 `dsh plugin add` 安装 bundle 前**先删掉那一行**（重复 entry id 会报错）
- 本包运行时依赖 `@deepseek-ai/schemastery`（peer，host 半 Config 校验用），DSH 安装自带，无需额外安装
- 手动复制进 `profiles/node_modules` 的包在下次 `pnpm install` 时可能被清理；长期使用请走 `dsh plugin add`

## 已知限制 / 后续工作

- 浏览器 autoplay 策略：AudioContext 在首次用户手势时解锁（已处理）
- 首次加载建立基线：刷新后已存在的 pending 不会回放（已处理）
- 250ms 防抖：并发到达的一批请求只响一声（已处理）
- 每个打开的标签页都会响（各自独立的客户端运行时）——如需跨页去重可后续加
- 后台未实例化会话：用列表行的 `pendingInteraction` 状态做粗略兜底（首次观察为基线）
- 完成提示音与侧边栏绿点同源：当前会话走 snapshot running 边沿，后台会话走列表行 `completed` 标记；取消（cancel）也会触发 running→false，因此取消一轮任务同样会响"叮咚"——如需区分"正常完成"与"取消"，后续可改用 durable 会话事件流的 `turn/end` 结果
- 完成提示音目前对每个完成的轮次都响；如觉得频繁，可后续加"仅当页面不可见（document.hidden）时响"的选项
- 自定义音频（上传/URL）暂未支持，`custom` 音效字段留待后续
- 动态原型路径：`tool-cordis`（`cordis_define`/`cordis_run`）未在本 profile 启用；如需热调试可启用它（会向模型暴露进程级工具，需谨慎）
