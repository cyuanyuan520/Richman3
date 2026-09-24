---
sessionID: ses_f2b27f215ffezriHrPToGykACq
baseMessageCount: 3
updatedAt: 2026-09-24T19:42:59.954Z
version: 1.0
date_created: 2026-09-24
owner: agent
tags: [spec, diagnostic]
---

# q-version-monopoly-3d-web

## Current spec

# Introduction
本规格描述一款「Q 版画风、工业化打磨」的 3D 大富翁（Monopoly 类）桌面网页游戏。已确认的核心决策：
- **平台**：仅桌面浏览器（鼠标操作，最高画质）。
- **世界观/调性**：现代城市 Q 版微缩都市；**明亮欢快（高饱和、日间、玩具感）**。
- **对局模式**：在线实时多人（WebRTC P2P，PeerJS）+ 单人 AI；2–4 人，Host 权威同步。
- **邀请方式**：分享链接（URL 携带 roomId，点开即进）+ 6 位房间码手输。
- **信令**：首发 PeerJS 公共云 `0.peerjs.com`，预留自托管切换。
- **玩法**：经典大富翁（买地/盖房/收租/机会命运卡）+ 恶搞随机事件 + 角色技能/被动；**规则与角色人设语言参照《大富翁4》经典设计**。
- **角色 IP**：**致敬式原创**——沿用经典人设语言（Q 版大头身、星座/性格差异化、每人 1 天赋技能），名称与形象完全原创，可公开部署。
- **首发角色**：**经典四人组：老农 + 元气少女 + 贵妇 + 忍者**；联机禁止重复选角（先到先得，已选置灰）。
- **内容规模**：4 名角色（各 1 独有技能）；20–30 个恶搞事件；中央区域 2–3 个轻量小游戏（转盘/猜拳/抽卡）。
- **单局时长目标**：60–90 分钟；首发 1 张复杂地图（环形 + 中央区域）。
- **开局配置**：房主可选预设——事件频率（低/中/高）+ 胜利条件（资产倍数 2/3/5/10× 或 回合上限 30/90/180/365/730）。
- **单人模式**：固定 3 名 AI 对手，单一难度。
- **对局外体验**：主菜单/房间流程 + 设置（音量/画质/昵称）+ 规则说明页；**结算后返回主菜单**。
- **前端技术栈**：Vite + React + TypeScript + React Three Fiber（纯 SPA）。
- **3D 资产**：全程脚本化：Blender Python 程序化建模（模块化城市套件），无人工，CI 一键生成 GLB。**本机已验证：Blender 5.2.2 LTS @ `D:\Blender\blender.exe`，headless + GLB 导出跑通**。
- **音频**：BGM 用仓库内 `bgm/` 两首；音效由 Web Audio API 程序化合成。
- **部署**：前端静态托管 Vercel。
- **P2P 兜底**：首发不接 TURN，打洞失败仅提示换网络（传输层保留可注入 ICE 配置）。

# 1. Purpose & Scope
## 目标
- 交付一款可发布（成熟）的 Q 版 3D 大富翁桌面网页游戏，而非原型。
- 内容与引擎解耦：地图、恶搞事件、小游戏、角色技能均数据驱动、可扩展。
- 全流程可复现：Blender Python 脚本 → GLB → 前端 → Vercel，可 CI 自动化。

## 范围内
- 3D 棋盘/角色/骰子渲染与动画、完整回合制对局逻辑、地产经济、恶搞事件系统。
- 在线实时多人（2–4 人，邀请制）与单人 AI 对战（固定 3 AI）。
- 环形棋盘 + 中央区域（2–3 轻量小游戏/特殊事件/传送）。
- 4 名原创角色（老农/元气少女/贵妇/忍者原型）+ 各自独有技能。
- 开局少量可配置预设（事件频率 + 胜利条件）。
- 现代城市主题的模块化程序化 3D 资产（明亮玩具感调性）。
- 桌面端 UI（含设置：音量/画质/昵称；含规则说明页）+ 音频（BGM + 合成音效）。
- Vite + React + TS + R3F 前端；数据驱动地图格式；首发 1 张复杂地图。
- Vercel 静态部署。

## 范围外（明确排除）
- 移动端/触控适配；原生客户端；运行时服务端 3D 渲染；公开匹配/排行榜/账号系统。
- 完整小游戏系统（首发仅 2–3 款轻量款）。
- **TURN/中继服务**（打洞失败仅提示）。
- 房主迁移/接力（Host 掉线即结束）。
- 同房间一键重开（结算后回主菜单）。
- 隐藏角色 / 「四大恶人」类彩蛋角色。
- 云端设置同步、好友列表、文字/语音聊天。
- 本地热座（pass-and-play）模式。
- 在 Vercel 构建期执行 Blender（不可能，见 CON-002）。

## 假设
- **本机已安装 Blender 5.2.2 LTS（`D:\Blender\blender.exe`），headless 执行与 GLB 导出已验证可用**（见第 9 节实测证据）。
- 目标语言：简体中文 UI。
- 用户以桌面浏览器（支持 WebGL2）访问；不支持移动端。
- 参与者网络环境可完成 WebRTC 打洞（否则提示换网络）。

## 目标读者
前端/3D 开发者、工具链工程师、测试。

# 2. Definitions
- **大富翁 / Monopoly-like**：掷骰移动、格子事件、买地收租的回合制棋盘游戏。
- **《大富翁4》参照**：大宇资讯 1998 年经典作；本作在**规则口径与角色设计语言**上参照其手感（差异化人设、资产倍数/时间上限胜利条件），但**不复刻其受版权保护的角色名称与形象**。
- **Q 版画风**：夸张头身比、圆润低多边形；本作采用**明亮欢快玩具感**（高饱和、日间光照）。
- **现代城市微缩都市**：以街道、商铺、公园、车站等城市元素构成的 Q 版微缩场景主题。
- **模块化城市套件（City Kit）**：参数化脚本生成的统一风格积木式资产（地块基座/建筑模块/装饰件/角色）。
- **角色原型（Archetype）**：角色所基于的类型化人设；首发取 `farmer`(老农) / `girl`(元气少女) / `madame`(贵妇) / `ninja`(忍者)。
- **Blender CLI / headless**：`blender --background ... --python script.py` 无界面执行 bpy 脚本。
- **BLENDER_BIN**：指向 Blender 可执行文件的路径变量（本机默认 `D:\Blender\blender.exe`）；构建脚本必须通过它调用，不得依赖 PATH。
- **程序化建模**：用 Blender Python 参数化生成模型，无人工 GUI，可复现、可版本管理。
- **GLB / glTF**：二进制 glTF 资产格式，适合 Web 加载。
- **环形棋盘（Ring）**：玩家循环移动的有序格子序列。
- **中央区域（Center Zone）**：棋盘中央的非环形节点集合，经传送与环形互通。
- **传送（Warp）**：格子间非相邻跳转链接。
- **小游戏（MiniGame）**：中央区域轻量互动玩法（转盘/猜拳/抽卡），Host 权威结算。
- **角色技能（Skill/Passive）**：每名角色独有的能力，作为可插拔创新模块。
- **Web Audio 合成音效**：用 Web Audio API 程序化生成的音效，无需音频素材文件。
- **地图（Map/Board）**：格子拓扑 + 主题资产 + 事件配置的数据包。
- **PeerJS / PeerServer**：前端封装 WebRTC DataChannel 的库；PeerServer 为信令服务器，仅交换会话元数据与 ICE 候选，数据不经服务器转发。
- **房间码（roomCode）**：6 位人类可读短码，用于口头传达加入。
- **roomId**：高熵随机房间标识，用于分享链接。
- **NAT 打洞 / ICE**：建立 P2P 直连的过程；对称 NAT/严格防火墙下可能失败。
- **TURN**：中继服务器，打洞失败时转发数据；首发不采用。
- **Host 权威**：房主为唯一权威节点，客户端只发意图。
- **恶搞事件（Chaos/Troll Event）**：带娱乐/整蛊效果的随机事件，内容不设限，仅私局出现。
- **房间预设（RoomConfig）**：房主开局前选择的少量规则选项（事件频率、胜利条件）。
- **MSYS 路径转换**：Git Bash 会把形如 `/c` 的参数改写成 `C:/`，导致 `cmd.exe /c` 失效；规避见 CON-022。
- **Serverless**：Vercel Functions，无状态短时，不支持长连接 WebSocket。
- **设置（Settings）**：本地持久化的音量/画质/昵称等偏好。

# 3. Requirements, Constraints & Guidelines
## 需求
- **REQ-001**：支持完整一局大富翁（回合、掷骰、移动、地产、结算、胜负）。
- **REQ-002**：在线实时多人（2–4 人，邀请制）+ 单人 AI，共用同一规则引擎。
- **REQ-003**：联机使用 PeerJS/WebRTC P2P；信令默认公共云，可配置切换自托管。
- **REQ-004**：Host 权威同步：房主持有权威状态，客户端只发意图，房主校验后广播事件；随机数由房主生成随事件下发。
- **REQ-005**：规则引擎纯逻辑、可确定性回放（同 seed + 同 intent → 同状态）。
- **REQ-006**：地图数据驱动：新增地图 = `map.json` + 资产 + 注册表条目，不改引擎源码。
- **REQ-007**：3D 资产 100% 由 Blender Python 脚本程序化生成，无人工建模；脚本与产物纳入版本管理，CI 一键重建。
- **REQ-008**：恶搞随机事件数据驱动，支持目标（自身/随机对手/全场/领先者）与效果叠加（加钱、扣钱、传送、交换位置、强制动作、变装、状态时长等）。
- **REQ-009**：实现角色技能/被动系统：每名角色独有技能，数据驱动、可确定性求值；可含被动、主动、触发型。
- **REQ-010**：UI 简体中文，含回合提示、资产面板、事件弹窗与结算动画。
- **REQ-011**：断线重连经全量 `STATE_SNAPSHOT` 恢复。
- **REQ-012**：内容不设限，仅私局，配套最低合规护栏。
- **REQ-013**：首发 1 张复杂地图，单局目标时长 60–90 分钟。
- **REQ-014**：拓扑为环形 + 中央区域；特定格通过 `warp` 进入中央节点并返回。
- **REQ-015**：中央区域实现 2–3 个轻量小游戏（转盘/猜拳/抽卡）+ 特殊事件 + 传送，Host 权威结算。
- **REQ-016**：**单人模式固定 3 名 AI 对手（共 4 人），单一难度**；AI 与人类共用同一规则引擎。
- **REQ-017**：美术主题为现代城市 Q 版微缩都市，调性**明亮欢快**（高饱和配色、日间光照、玩具感材质），风格统一可组合。
- **REQ-018**：角色技能需与 AI 兼容（AI 会合理使用技能）。
- **REQ-019**：BGM 使用 `bgm/` 目录音频（当前 2 首）；音效由 Web Audio API 程序化合成，不依赖外部音效素材。
- **REQ-020**：仅面向桌面浏览器；UI 以鼠标交互设计，不要求触控适配。
- **REQ-021**：目标浏览器需支持 WebGL2 与 WebRTC DataChannel；不支持时给出明确提示。
- **REQ-022**：首发 **4 名可玩角色**，原型为**老农（farmer）、元气少女（girl）、贵妇（madame）、忍者（ninja）**，每人 1 个独有技能；角色沿用经典人设语言，但**名称与形象完全原创**；角色可在开局前选择。
- **REQ-023**：首发 **20–30 个恶搞事件**，覆盖主要 effect 类型，结构可轻松扩展。
- **REQ-024**：提供对局外体验：主菜单 → 创建/加入房间 → 选角色 → 开局；含**设置页**（音量：BGM/SFX 分轨、画质档位、昵称）与**规则说明页**。
- **REQ-025**：设置项持久化到 `localStorage`，刷新/重开保留。
- **REQ-026**：P2P 连接失败（打洞失败/信令不可达）时给出明确的失败提示与重试入口，不静默卡死。
- **REQ-027**：房主可在开局前选择**少量预设**：事件频率（`LOW`/`MEDIUM`/`HIGH`）+ 胜利条件（资产制 `ASSET_TARGET` / 回合上限 `TURN_LIMIT`）；不提供任意数值自定义。
- **REQ-028**：`RoomConfig` 由房主设定并随 `ROOM_INFO` 广播；各端 UI 必须显示当前生效的配置。
- **REQ-029**：支持两种加入方式：**分享链接**（URL 携带高熵 `roomId`，点开即进）与 **6 位房间码**（手输后向对应 Host 发起加入请求）。
- **REQ-030**：经**房间码**加入必须由房主**显式同意**（join request → accept/reject），并对加入尝试限流；分享链接加入默认直接进入，房主可开关「需同意」。
- **REQ-031**：一局结束后**返回主菜单**，玩家可重新创建/加入房间；不做同房间一键重开。
- **REQ-032**：胜利条件数值口径参照《大富翁4》，**全量提供**：`ASSET_TARGET.value` ∈ {2,3,5,10}（初始资金倍数）；`TURN_LIMIT.value` ∈ {30,90,180,365,730}（回合计，一回合=一天）；到达后总资产最高者胜；缺省 `ASSET_TARGET: 3`。
- **REQ-033**：地产经济结构参照经典：初始资金、按地段分组（`group`）的梯度定价、租金随房产等级递增、支持抵押与赎回。
- **REQ-034**：**联机对局中禁止重复选角**——角色先到先得，已被选角色在他人选单中置灰不可选；单人模式由玩家先选，AI 从剩余角色中补齐。
- **REQ-035**：资产构建脚本必须通过 **`BLENDER_BIN`**（默认 `D:\Blender\blender.exe`）调用 Blender，**不依赖 PATH**；脚本须在 Windows / Git Bash / cmd / CI 下均可调用。
- **REQ-036**：**GLB 产物提交入库**（`public/models/**`），Vercel 构建不执行 Blender，仅直接消费已提交产物；CI 负责在 Blender 可用环境中重建并校验幂等。

## 安全约束
- **SEC-001**：客户端输入不可信，关键结算（含小游戏结果、技能触发）必须房主端校验。
- **SEC-002**：信令关闭 `allow_discovery`。
- **SEC-003**：仅邀请制，禁止公开匹配。分享链接使用高熵 `roomId`；**6 位房间码熵低（约 20 bit），必须配合房主显式同意 + 加入尝试限流**，且房间码仅在房间存续期内有效。
- **SEC-004**：不得硬编码敏感密钥。
- **SEC-005**：内容不设限 → 最低护栏：私局邀请制、进入前年龄确认、`noindex`。
- **SEC-006**：Host peer id / roomId / roomCode 均须加命名空间前缀（如 `rm3-`），避免公共云上与其他应用/用户全局碰撞。
- **SEC-007**：**不得直接复刻《大富翁4》（大宇资讯/Softstar）受版权保护的角色名称、形象与美术资源**；已定策略为致敬式原创。CI 须含版权名称黑名单自检。

## 系统约束
- **CON-001**：前端 = Vite + React + TypeScript + React Three Fiber 纯 SPA，部署 Vercel。
- **CON-002**：Vercel 运行时/构建期均不可执行 Blender；GLB 必须在开发机或 CI 预生成并入库。
- **CON-003**：Vercel Serverless 不支持长连接 WebSocket；自托管 PeerServer 须独立常驻托管。
- **CON-004**：信令默认公共云，须可配置切换 + 连接失败降级提示。
- **CON-005**：资产预算：首屏 ≤ 5MB，地图按需加载。
- **CON-006**：**Blender 环境（已验证）**：`D:\Blender\blender.exe`，版本 **5.2.2 LTS**（build 2026-09-15，hash `d13f752e3b9c`）；同目录含 `blender-launcher.exe`。**`blender` 不在 PATH**，必须用绝对路径 / `BLENDER_BIN`。
- **CON-007**：Node v24 / pnpm 已具备；WebRTC 需 HTTPS。
- **CON-008**：**首发不部署 TURN**；对称 NAT/严格防火墙下连接可能失败 → 按 REQ-026 提示用户换网络。传输层保留可注入 `iceServers` 配置。
- **CON-009**：Blender CLI 固定参数保证确定性（**已实测通过**）：`--background --factory-startup -noaudio --python-exit-code <N> --python <script>`；自定义参数置于 `--` 之后，由 `sys.argv` 读取；`sys.exit(k)` 会传播为进程退出码 k。
- **CON-010**：Blender 版本锁定为 **5.2.2 LTS**，随机种子锁定，保证程序化资产确定性。
- **CON-011**：纯 SPA 无 SSR，SEO 非目标（且需 noindex）。
- **CON-012**：程序化资产一致性与幂等由 CI 校验（以锁定版本重建并比对哈希）；资产变更须可 diff。
- **CON-013**：模块化资产须遵循统一命名/网格约定/材质约定，确保可拼接、可 LOD 降级。
- **CON-014**：资产按需加载；单个 GLB > 1MB 时启用 meshopt/Draco 压缩（已验证 `export_draco_mesh_compression_enable` 属性可用）。
- **CON-015**：`bgm/` 两首 mp3 合计约 8.6MB，超出首屏 5MB 预算 → BGM 必须懒加载/流式播放，不得阻塞首屏与开局关键路径；加载失败需静默降级。
- **CON-016**：仅桌面浏览器（无移动端断点设计要求），可针对桌面分辨率做最大化视觉表现。
- **CON-017**：设置仅本地持久化（`localStorage`），无账号/云端同步。
- **CON-018**：`RoomConfig` 只暴露有限枚举，避免规则组合爆炸与平衡失控。
- **CON-019**：6 位房间码不足以提供安全边界 → 安全边界依赖「房主显式同意」；房间码仅作为**定位**手段，非授权凭证。
- **CON-020**：明亮玩具感调性的实现约束：材质以纯色/低复杂 PBR 为主，依赖高饱和色板 + 强烈环境光 + 柔和阴影，不做写实贴图与复杂后处理。
- **CON-021**：角色与地图命名须做版权自检（不得含 Softstar/大宇受保护名称）；资产脚本与文案集中管理便于替换。
- **CON-022**：**Windows shell 调用约束（已实测）**：Git Bash 的 MSYS 路径转换会把 `cmd.exe /c` 的 `/c` 改写成 `C:/`，导致命令未执行（仅打印 cmd banner）。正确做法：改用 `cmd //c "..."` 或 `MSYS_NO_PATHCONV=1 cmd.exe /c "..."`；或**直接以绝对路径调用 `blender.exe`**（`"/d/Blender/blender.exe" ...`），无需经过 cmd。推荐构建脚本用 Node `child_process.execFile` 直调可执行文件，彻底绕开 shell 引号/转换问题。
- **CON-023**：构建脚本不得假设 Blender 在 PATH；缺失或版本不符时须给出明确错误（含期望版本 5.2.2 LTS 与实际版本）。

## 指南
- **GUD-001**：资产与逻辑分离；UI 面向桌面鼠标交互优化。
- **GUD-002**：优先复用成熟开源方案而非自研引擎。
- **GUD-003**：资产导出遵循统一命名与目录约定。
- **GUD-004**：恶搞事件文案可配置、可开关。
- **GUD-005**：程序化建模脚本须幂等（同参数 → 同 GLB）。
- **GUD-006**：中央节点与环形格子共用统一 Tile 数据结构。
- **GUD-007**：小游戏、角色技能同为可插拔模块，通过统一接口注册。
- **GUD-008**：音效合成参数集中管理在音频模块。
- **GUD-009**：角色技能与 Chaos 效果复用同一 effect DSL，减少重复实现。
- **GUD-010**：画质档位（低/中/高）只影响阴影/后处理/分辨率缩放等表现项，不得改变规则逻辑。
- **GUD-011**：事件频率预设仅影响 Chaos 格与 Chaos 卡池的触发权重，不改变事件内容本身。
- **GUD-012**：UI 主题与 3D 资产共用同一色板 token，保证视觉一致。
- **GUD-013**：角色原型借鉴经典但不复刻；命名采用原创、口语化、有梗的中文名。
- **GUD-014**：优先运行 Blender 自检（版本/导出器）作为 CI 首步，快速失败并输出可诊断信息。

# 4. Interfaces & Data Contracts
- **Blender 构建契约**：`"$BLENDER_BIN" --background --factory-startup -noaudio --python-exit-code 1 --python scripts/build_assets.py -- --config assets.config.json --out public/models --seed <n>`（`BLENDER_BIN` 默认 `/d/Blender/blender.exe`，Windows 形式 `D:\Blender\blender.exe`）。
- **GLB 导出**：`bpy.ops.export_scene.gltf(filepath=..., export_format='GLB')`（已实测成功）。
- **信令配置**：`new Peer(peerId, { host, port, path, key, secure, config: { iceServers: [] } })`。
- **标识符**：`roomId` = `rm3-<nanoid(21)>`；`roomCode` = 6 字符短码；Host peer id 带 `rm3-` 前缀。
- **入口路由**：`/?room=<roomId>` 自动进入加入流程；`/` 主菜单；无 `roomId` 时禁止发现他人房间。
- **加入握手**：`INTENT_JOIN { roomCode?, roomId?, nickname, characterId? }` → Host 回 `JOIN_PENDING | JOIN_ACCEPTED | JOIN_REJECTED`。
- **房间配置（RoomConfig）**：`{ eventRate: 'LOW'|'MEDIUM'|'HIGH', victory: { kind: 'ASSET_TARGET'|'TURN_LIMIT', value: number }, requireApproval: boolean }`；`ASSET_TARGET.value ∈ {2,3,5,10}`，`TURN_LIMIT.value ∈ {30,90,180,365,730}`；缺省 `{ eventRate:'MEDIUM', victory:{kind:'ASSET_TARGET',value:3}, requireApproval:false }`。
- **P2P 消息信封** `NetMessage`：`{ v, type, seq, from, to?, payload }`。
  - 客户端→房主：`INTENT_JOIN/ROLL/BUY/UPGRADE/CHOICE/END_TURN/ENTER_CENTER/MINIGAME_ACTION/USE_SKILL/SELECT_CHARACTER`。
  - 房主→全部：`STATE_EVENT` / `STATE_SNAPSHOT` / `ROOM_INFO` / `TURN_START` / `MINIGAME_START` / `MINIGAME_RESULT` / `JOIN_PENDING|JOIN_ACCEPTED|JOIN_REJECTED` / `CHARACTER_TAKEN` / `GAME_OVER`。
- **权威状态** `GameState`：`{ seed, turn, phase, players[], board, rngCursor, eventLog[], roomConfig }`。
- **地图 schema** `map.schema.json`：`{ id, name, theme, board: { ring: Tile[], center: CenterNode[], warps: Warp[] }, assets, rules, events }`。
- **格子（Tile）**：`{ id, kind: 'ring'|'center', index, type: [START|PROPERTY|CHANCE|CHAOS|TAX|EVENT|JAIL|BONUS|MINIGAME|WARP], name, pos, price?, group?, modelRef?, onEnter? }`。
- **传送（Warp）**：`{ fromTileId, toTileId, bidirectional, condition? }`。
- **中央节点（CenterNode）**：`{ id, type: [MINIGAME|EVENT|SHOP|TELEPORT], payloadRef }`。
- **小游戏（MiniGame）**：`{ id, kind: [WHEEL|RPS|GACHA], players, rules, rewards, resolveIntent }`；结算签名 `resolve(state, actions, rng) -> ResultEvent[]`（Host 端执行）。
- **角色（Character）**：`{ id, name, archetype: 'farmer'|'girl'|'madame'|'ninja', modelRef, portraitRef, personality?, skill }`；首发 4 名，各 1 独有技能。
- **技能（Skill）**：`{ id, name, desc, type: [PASSIVE|ACTIVE|TRIGGER], trigger?: [ON_ROLL|ON_LAND|ON_PAY|ON_TURN_START|ON_CHAOS], cooldown?, cost?, effect[] }`。
- **恶搞事件** `ChaosEvent`：`{ id, title, text, weight, target: [SELF|RANDOM_OPPONENT|ALL|LEADER], effects[] }`；`effect: { kind: MONEY|MOVE|SWAP_POS|SKIP_TURN|STATUS|VISUAL|WARP|SKILL, value, duration? }`；首发 20–30 条。
- **设置契约** `Settings`：`{ v: 1, nickname, bgmVolume, sfxVolume, quality: [LOW|MEDIUM|HIGH], muted }`，持久化于 `localStorage['richman3.settings']`。
- **主题色板** `theme.tokens.json`：`{ colors: {...}, lightIntensity, shadowSoftness }`，供 UI 与 Blender 资产脚本共用。
- **音频契约**：BGM = `bgm/double-sixes.mp3`、`bgm/top-hat-and-thimble.mp3`（HTMLAudioElement，懒加载 + loop）；SFX = `playSfx(kind, params)`，`kind: [CLICK|DICE|MOVE|LAND|BUY|PAY|WIN|LOSE|CHAOS|MINIGAME]`。
- **资产清单** `assets.manifest.json`：`{ key, glbPath, scale, animations[], tags?, metadata }`。
- **AI 决策接口**：`decide(state, playerId, rng) -> Intent`。

# 5. Acceptance Criteria
- **AC-001**：Given 新建对局, When 玩家点击掷骰, Then 骰子动画播放并返回 1–6 点数，棋子沿环形逐格移动。
- **AC-002**：Given 棋子停在无主地产, When 玩家确认购买且资金充足, Then 地产归属更新、资金扣减、视觉标记更新。
- **AC-003**：Given 棋子停在他人地产, When 结算完成, Then 按规则扣除租金并更新双方资金。
- **AC-004**：Given 玩家破产, When 结算完成, Then 触发破产/失败判定与胜负结算。
- **AC-005**：Given 新增 `map.json` 与资产, When 登记并构建, Then 可选该地图游玩且未改动引擎源码。
- **AC-006**：Given 生产构建完成, When 部署到 Vercel, Then URL 可访问且无运行时资产 404。
- **AC-007**：Given 两台浏览器（A 房主、B 客户端）, When A 完成掷骰, Then B 在合理时延内看到一致结果与动画。
- **AC-008**：Given 客户端伪造「余额不足仍买地」INTENT, When 房主收到, Then 拒绝且状态不变。
- **AC-009**：Given 房主触发 ChaosEvent, When 效果作用于目标, Then 各端状态一致且播放反馈。
- **AC-010**：Given 单人模式, When 开局, Then 固定 3 名 AI 自主完成掷骰/购买/结束回合，可打完一局。
- **AC-011**：Given 客户端断线后重连, When 重新加入, Then 经 STATE_SNAPSHOT 恢复一致状态。
- **AC-012**：Given 未持有 roomId/roomCode, When 尝试发现/加入房间, Then 失败；页面 `noindex` 生效。
- **AC-013**：Given 固定 seed 与构建参数, When CI 连续两次运行 Blender 脚本, Then 生成的 GLB 一致（幂等）。
- **AC-014**：Given 首发复杂地图, When 完成一局, Then 单局时长落在 60–90 分钟目标区间（允许配置调优）。
- **AC-015**：Given 棋子触发 WARP, When 结算作用, Then 棋子进入中央区域对应节点并可经传送返回环形，各端一致。
- **AC-016**：Given 进入中央小游戏节点, When 玩家完成转盘/猜拳/抽卡, Then Host 结算并广播结果，各端一致且奖励正确入账。
- **AC-017**：Given 联机小游戏中客户端伪造结果, When Host 收到, Then 以 Host 权威结果为准。
- **AC-018**：Given 玩家使用主动技能且满足冷却/费用, When Host 校验通过, Then 技能效果生效且各端一致；若不满足则拒绝。
- **AC-019**：Given 被动技能满足触发条件, When 结算发生, Then 被动自动生效且各端一致。
- **AC-020**：Given 单人模式 AI 持有技能, When 轮到 AI, Then AI 会评估并合理使用技能。
- **AC-021**：Given 城市套件资产, When 组合到地图, Then 相邻模块风格/尺寸一致且无穿模错位。
- **AC-022**：Given 开局与首屏加载, When BGM 尚未加载完成, Then 首屏与开局流程不受阻塞；BGM 就绪后循环播放且可静音。
- **AC-023**：Given 触发任一 SFX 事件, When 播放, Then 由 Web Audio 合成对应音效，无外部素材缺失。
- **AC-024**：Given 在移动端或不支持 WebGL2 的浏览器, When 打开页面, Then 显示「请使用桌面浏览器」提示，不崩溃。
- **AC-025**：Given 4 名角色, When 开局选择角色, Then 角色技能在整局中按定义生效且四者行为可区分。
- **AC-026**：Given 20–30 条已配置 ChaosEvent, When 随机抽取, Then 均可正常触发且无引用缺失（schema 全量校验通过）。
- **AC-027**：Given 首次进入, When 打开设置页, Then 可调整 BGM/SFX 音量、画质档位与昵称；刷新后设置保留。
- **AC-028**：Given 用户打开规则说明页, When 浏览, Then 可见完整的核心规则与操作说明。
- **AC-029**：Given P2P 打洞失败, When 连接超时, Then 界面显示明确的「网络不支持 P2P 联机」提示与重试按钮，不静默卡死。
- **AC-030**：Given 房主选择「事件频率=HIGH + 胜利条件=回合上限」, When 对局进行, Then Chaos 触发频率显著提升，且到达回合上限后按总资产最高者判胜。
- **AC-031**：Given 房主设定 RoomConfig, When 客户端加入, Then 各端界面显示一致的当前配置。
- **AC-032**：Given 房主开启「需同意」, When 玩家用 6 位房间码请求加入, Then 房主收到请求并可同意/拒绝。
- **AC-033**：Given 分享链接 `/?room=<roomId>`, When 好友打开链接, Then 自动进入该房间的加入流程。
- **AC-034**：Given 明亮欢快调性, When 查看任意场景, Then 画面为高饱和日间玩具感，UI 与 3D 色板一致。
- **AC-035**：Given 选择「资产倍数 2/3/5/10×」任一档, When 任一玩家总资产达标, Then 立即判定该玩家获胜并进入结算页。
- **AC-036**：Given 一局结束, When 点击结算页按钮, Then 返回主菜单，可重新建房/加入（无同房间重开入口）。
- **AC-037**：Given 发布检查, When 检索游戏内文本与资产命名, Then 不含《大富翁4》受保护角色名称（版权自检通过）。
- **AC-038**：Given 选择「回合上限 30/90/180/365/730」任一档, When 回合数到达上限, Then 按总资产最高者判胜（并列时按预设并列规则处理）。
- **AC-039**：Given 联机对局中 A 已选择「忍者」, When B 打开选角界面, Then 忍者置灰不可选；B 选择其他角色成功，各端同步。
- **AC-040**：Given 单人模式, When 玩家选定角色, Then 3 名 AI 分别从剩余 3 个角色中取得唯一角色，无重复。
- **AC-041**：Given 地产被抵押, When 玩家支付赎回费用, Then 地产解除抵押并恢复收租；抵押期间不收租。
- **AC-042**：Given 仅提供 `BLENDER_BIN`（PATH 中无 blender）, When 运行资产构建脚本, Then 成功调用 Blender 5.2.2 LTS 并产出 GLB。
- **AC-043**：Given 在 Git Bash 中执行构建, When 脚本内部不使用被 MSYS 改写的 cmd 形式, Then 命令正常执行（无「banner-only」假成功）。
- **AC-044**：Given Blender 缺失或版本不符, When 运行构建脚本, Then 立即失败并输出期望（5.2.2 LTS）与实际版本信息。

# 6. Test Automation Strategy
- 单元测试：Vitest 覆盖规则引擎纯函数、小游戏结算、技能触发、胜负判定（资产倍数/回合上限）、事件频率权重、抵押/赎回与租金递增，含确定性回放（同 seed + 同 intent → 同状态哈希）。
- 契约测试：Zod/Ajv 校验 `map.schema.json`、`ChaosEvent`、`NetMessage`、`Warp`、`MiniGame`、`Character`/`Skill`、`Settings`、`RoomConfig`、`theme.tokens.json`，并全量校验 20–30 条事件配置。
- 联机测试：本地起 PeerServer（`peerjs --port 9000`）做 host/client 同步、恶意 intent 拒斥、断线重连、小游戏/技能权威校验、打洞失败路径（mock ICE 失败）、房间码加入与同意/拒绝、限流、并发选角冲突（`CHARACTER_TAKEN`）。
- 组件/E2E：Playwright（桌面视口）跑主路径 + 小游戏 + 技能路径 + 设置持久化 + 规则页 + 房间配置广播 + 分享链接进入 + 结算返回主菜单 + 选角置灰。
- 版权自检：CI 扫描角色/地图文案，命中《大富翁4》受保护名称黑名单即失败。
- **Blender 管线冒烟测试（已在本机实测通过）**：`<BLENDER_BIN> --background --factory-startup -noaudio --python-exit-code 1 --python-expr "..."` —— 校验版本为 5.2.2 LTS、`bpy.ops.export_scene.gltf` 存在、导出 GLB 成功、`--` 自定义参数可读、非零退出码可传播。
- 资产：CI 内 headless Blender 运行 `build_assets.py`，校验幂等性、GLB 结构、体积预算与套件拼接约定。
- 音频：单测合成函数可调用且不抛错；BGM 懒加载以 stub 校验非阻塞。

# 7. Rationale & Context
- **P2P + 独立信令**：PeerJS 仅信令走服务器，游戏数据 P2P 直连；Vercel 不支持长连接，故信令独立。首发公共云降成本，预留自托管。
- **Host 权威而非锁步**：恶搞事件、随机小游戏、技能触发多，Host 权威实现简单、防作弊、可复用同引擎跑单机 AI。
- **Vite 纯 SPA 而非 Next.js**：canvas 3D 游戏 SSR 收益低，SPA 构建/加载更简更快，且 noindex、无需 SEO。
- **仅桌面**：放弃触控/移动适配显著降低 UI/UX 与性能预算复杂度，聚焦桌面画质与交互深度。
- **不接 TURN**：以「与好兄弟联机」为核心场景，打洞成功率高；TURN 成本与运维不划算。少数严格网络以清晰提示替代静默失败；保留 `iceServers` 注入点。
- **两种邀请方式**：分享链接体验最好；6 位房间码胜在口头传达。因码熵低，安全边界改由「房主显式同意 + 限流」承担。
- **参照《大富翁4》**：其胜利条件口径（资产倍数 / 时间上限）与角色类型化人设是最经久的好设计，直接对齐可省去自创数值并贴合老玩家预期。
- **角色致敬式原创 + 经典四人组原型**：Softstar 角色为受版权保护资产；公开发布必须原创。老农/元气少女/贵妇/忍者这组原型辨识度最高、性格对撞最强，最利于恶搞事件发挥。
- **禁止重复选角**：保证 4 名角色在单局中辨识度与技能唯一性；Host 端做权威判重并广播 `CHARACTER_TAKEN`。
- **明亮玩具感调性**：契合「Q 版 + 和好兄弟搞笑」，且纯色/低复杂材质天然省包体与性能。
- **少量预设而非全自定义**：避免规则组合爆炸与平衡维护成本。
- **单人固定 3 AI 单一难度**：最小成本提供完整 4 人体验。
- **结算回主菜单**：避免房间生命周期与「重开时角色/配置重选」的额外状态机复杂度。
- **音效用 Web Audio 合成**：零素材依赖、零包体增量。
- **BGM 复用 `bgm/` 现有曲目**：省制作成本；文件较大必须懒加载。
- **环形 + 中央区域**：环形保证经典体验；中央区域低成本扩展差异化玩法并拉长单局。
- **4 角色 + 20–30 事件**：最小可用内容量覆盖核心体验，架构保证后续快速扩充。
- **全脚本化程序建模**：可复现、可 CI、无需人工美术；本机 Blender 5.2.2 LTS 已实测跑通 headless + GLB 导出。
- **走 `BLENDER_BIN` 而非 PATH**：实测 `blender` 不在 PATH；而 Git Bash 的 MSYS 路径转换会破坏 `cmd.exe /c`。以可执行文件绝对路径直调（或 Node `execFile`）是跨 shell 最稳的方式。
- **GLB 入库**：Vercel 无法运行 Blender，产物必须随仓库提供；CI 重建用于幂等校验而非部署来源。
- **内容不设限的风险**：以邀请制 + 年龄确认 + noindex 作最低护栏。

# 8. Dependencies & External Integrations
- **EXT-001**：Blender（构建期，headless）。**已验证**：`D:\Blender\blender.exe`，**5.2.2 LTS**（build 2026-09-15，hash `d13f752e3b9c`）；不在 PATH，须经 `BLENDER_BIN` 调用。
- **EXT-002**：Node.js v24 / pnpm（已具备）。
- **EXT-003**：Vite + React + TypeScript。
- **EXT-004**：Three.js + React Three Fiber（渲染）。
- **EXT-005**：Web Audio API（浏览器内置）。
- **EXT-006**：Vercel 静态托管。
- **EXT-007**：PeerJS（`peerjs`）；首发信令 = PeerJS 公共云 `0.peerjs.com`。
- **EXT-008**：[后续] 自托管 PeerServer（`peer` npm / Docker `peerjs/peerjs-server`）。
- **EXT-009**：[后续/可选] TURN；首发不接入。
- **EXT-010**：CI（GitHub Actions）+ headless Blender 镜像（或预装 Blender 5.2.2 LTS）。
- **EXT-011**：本地 BGM 素材：`D:/game/RichMan3/bgm/double-sixes.mp3`、`top-hat-and-thimble.mp3`。
- **EXT-012**：《大富翁4》（大宇资讯）——**仅作规则口径与角色原型的设计参照，不作为代码/素材依赖**。

# 9. Examples & Edge Cases
## Blender 调用（Git Bash / Windows / Node）
```bash
# Git Bash：直接绝对路径调用，绕开 MSYS 转换
BLENDER_BIN="${BLENDER_BIN:-/d/Blender/blender.exe}"
"$BLENDER_BIN" --background --factory-startup -noaudio --python-exit-code 1 \
  --python scripts/build_assets.py -- \
  --config assets/city.config.json --out public/models --seed 20260925
```
```bat
:: cmd.exe：使用 Windows 路径
"D:\Blender\blender.exe" --background --factory-startup -noaudio --python-exit-code 1 ^
  --python scripts/build_assets.py -- ^
  --config assets/city.config.json --out public/models --seed 20260925
```
```js
// Node（最稳，免 shell 引号/路径转换问题）
import { execFile } from 'node:child_process';
const BLENDER_BIN = process.env.BLENDER_BIN ?? 'D:\\Blender\\blender.exe';
execFile(BLENDER_BIN, [
  '--background', '--factory-startup', '-noaudio', '--python-exit-code', '1',
  '--python', 'scripts/build_assets.py', '--',
  '--config', 'assets/city.config.json', '--out', 'public/models', '--seed', '20260925',
], (err, stdout, stderr) => { /* ... */ });
```
> 反例（在 Git Bash 中会失效）：`cmd.exe /c "..."` —— MSYS 把 `/c` 改写成 `C:/`，cmd 仅打印 banner 后退出。改用 `cmd //c "..."` 或 `MSYS_NO_PATHCONV=1 cmd.exe /c "..."`。

## 本机实测证据（Blender 管线）
```
$ "/d/Blender/blender.exe" --version
Blender 5.2.2 LTS  build date: 2026-09-15  hash: d13f752e3b9c  build branch: blender-v5.2-release

$ "/d/Blender/blender.exe" --background --factory-startup -noaudio --python-exit-code 1 --python-expr "..."
BLENDER_PY_OK 5.2.2 LTS        # bpy 可用
HAS_GLTF True                  # bpy.ops.export_scene.gltf 存在
CUSTOM_ARGS ['--config','assets.config.json','--out','public/models','--seed','20260925']  # '--' 之后参数可读

$ ... --python-expr "import sys; sys.exit(3)"  ->  进程退出码 3   # 退出码传播正常

导出 GLB：bpy.ops.export_scene.gltf(filepath='cube.glb', export_format='GLB')  ->  cube.glb 3460 B
HAS_DRACO_PROP True            # export_draco_mesh_compression_enable 可用
```

## 首发角色（原创名，原型参照经典）
```json
[
  { "id": "char_farmer", "name": "土伯·阿旺",   "archetype": "farmer" },
  { "id": "char_girl",   "name": "元气小妹·糖糖", "archetype": "girl" },
  { "id": "char_madame", "name": "收租婆·珍姐",  "archetype": "madame" },
  { "id": "char_ninja",  "name": "隐形忍·阿影",  "archetype": "ninja" }
]
```

## 角色 + 技能示例
```json
{
  "id": "char_madame",
  "name": "收租婆·珍姐",
  "archetype": "madame",
  "modelRef": "char_madame",
  "portraitRef": "portrait_madame",
  "personality": "毒舌但护短；星座 狮子座",
  "skill": {
    "id": "skill_rent_boost",
    "name": "狮子大开口",
    "type": "PASSIVE",
    "trigger": "ON_PAY",
    "desc": "收取租金时额外 +20%。",
    "effect": [{ "kind": "MONEY", "value": 0.2 }]
  }
}
```

## 胜利预设示例
```json
{ "kind": "ASSET_TARGET", "value": 3 }
```
```json
{ "kind": "TURN_LIMIT", "value": 180 }
```

## 房间配置示例（`RoomConfig`）
```json
{ "eventRate": "HIGH", "victory": { "kind": "TURN_LIMIT", "value": 180 }, "requireApproval": true }
```

## 加入房间示例
```
分享链接： https://<app>.vercel.app/?room=rm3-V1StGXR8Z5jdHi6B-myT
房间码：   7K9Q2M        （口头传达；需房主同意方可入局）
```

## 地图拓扑示例（`map.json` 节选）
```json
{
  "id": "city_metro",
  "name": "都会大亨",
  "theme": "modern-city",
  "board": {
    "ring": [
      { "id": "t0", "kind": "ring", "index": 0, "type": "START",   "name": "起点广场",     "pos": [0, 0, 0] },
      { "id": "t1", "kind": "ring", "index": 1, "type": "PROPERTY", "name": "街角便利店",   "price": 600, "group": "blue", "modelRef": "shop_small" },
      { "id": "t7", "kind": "ring", "index": 7, "type": "WARP",     "name": "地铁入口",     "modelRef": "metro_entrance" }
    ],
    "center": [
      { "id": "c_wheel", "type": "MINIGAME", "payloadRef": "mg_wheel" },
      { "id": "c_plaza", "type": "EVENT",    "payloadRef": "ev_center_chaos" }
    ],
    "warps": [ { "fromTileId": "t7", "toTileId": "c_wheel", "bidirectional": true } ]
  }
}
```

## 恶搞事件示例
```json
{
  "id": "chaos_stinky_socks",
  "title": "臭袜子袭击",
  "text": "你的袜子被换成三天没洗的，全场捂鼻——强制跳过下一回合。",
  "weight": 8,
  "target": "SELF",
  "effects": [{ "kind": "SKIP_TURN", "value": 1 }]
}
```

## 网络消息示例
```json
{ "v": 1, "type": "INTENT_BUY", "seq": 42, "from": "peer_b", "payload": { "tileId": "t1" } }
```

## 设置持久化示例
```json
{ "v": 1, "nickname": "阿伟", "bgmVolume": 0.6, "sfxVolume": 0.8, "quality": "HIGH", "muted": false }
```

## 边缘场景
连续最大点数、破产时仍有抵押地产、骰子回绕起点奖励、Chaos 交换位置后再触发地产、WARP 无限循环、中央区域节点回环、小游戏平局/超时、技能冷却与同回合多次触发、技能与 Chaos 效果冲突、BGM 自动播放被拦截（需用户手势）、重连时处于动画中、同时收到两个 intent、房主掉线（对局结束）、NAT 打洞失败、房间码被陌生人猜测（走房主同意/拒绝）、分享链接在房间已关闭后打开、多人同时达到资产目标（并列判定）、回合上限到达时资产并列、两名玩家并发抢选同一角色（后者收 `CHARACTER_TAKEN`）、AI 技能决策、`localStorage` 不可用或旧版本迁移、事件频率 HIGH 下同回合连续触发 Chaos、角色名称版权自检、**Blender 未在 PATH（须 `BLENDER_BIN`）**、**Git Bash 下 `cmd.exe /c` 被 MSYS 改写导致静默失败**、**Blender 版本升级导致程序化资产回归**。

# 10. Validation Criteria
- 规则引擎单测 + 确定性回放全通过。
- 地图 schema 校验通过，非法拓扑构建期报错。
- 联机双端一致、恶意 intent 被拒、断线重连成功、小游戏与技能权威结算正确。
- 打洞失败时展示明确提示而非静默卡死。
- 分享链接与房间码均可完成加入；房间码路径下未获同意者无法入局。
- 端到端完成整局（联机 + 单人）并落在 60–90 分钟目标区间。
- RoomConfig 预设（3 档事件频率 × 9 档胜利条件）全部组合可正常运行且判定正确（含并列处理）。
- 选角禁止重复在联机与单人模式下均生效。
- 结算后返回主菜单流程可用。
- 抵押/赎回与租金递增规则正确。
- **Blender 管线可诊断**：仅设 `BLENDER_BIN`（PATH 无 blender）即可构建；Git Bash 下无「banner-only」假成功；版本不符时快速失败并报出期望/实际版本。
- Blender 脚本幂等，GLB 通过结构、体积与套件拼接校验。
- BGM 懒加载不阻塞首屏；SFX 全部由 Web Audio 合成可播放；设置持久化生效。
- 规则说明页信息完整可读。
- 不支持的浏览器给出提示而非白屏/崩溃。
- 4 名角色技能均可触发且行为可区分；20–30 条事件配置全部可加载。
- 明亮玩具感调性在各场景一致（UI 与 3D 色板统一）。
- 版权自检通过（无《大富翁4》受保护名称）。
- Vercel 生产 URL 可玩，无运行时资产 404。

# 11. Related Specifications / Further Reading
- 访谈源文件：`interview/q-blender-cli-vercel-d845cbe1-b273-4c80-ba6c-0a75fadbe6d5.md`
- PeerJS：https://peerjs.com/docs/ ；PeerServer：https://github.com/peers/peerjs-server
- Blender 命令行参数源码：https://github.com/blender/blender/blob/main/source/creator/creator_args.cc
- Blender 手册（命令行参数）：https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html
- headless Blender CI 镜像：`blenderkit/headless-blender`
- Vite / React Three Fiber / glTF 2.0 / Web Audio API 官方文档
- Vercel 部署文档：https://vercel.com/docs
- BGM 素材目录：`D:/game/RichMan3/bgm/`
- 《大富翁4》角色与规则参照资料（第三方攻略）：`github.com/skywind3000/GONGLUE`（大富翁4 人物及物品 / 完全攻略）；`github.com/mytbk/rich4`（`docs/characters.txt`）

## Q&A history

Q: 首发版本的对局模式是哪种？（这决定是否需要实时后端，以及 Vercel 架构复杂度）
A: 在线实时多人(可以考虑使用peerjs), 但同时也需要有单人模式

Q: 玩法范围（规则深度）做到哪一档？
A: 核心为1, 但是我需要更多有趣的随机事件让游戏变得更有趣; (最好是恶俗一点的, 这样和好兄弟玩的时候比较搞笑); 也可以加入创新性的玩法

Q: 恶搞随机事件的内容尺度边界定在哪？（影响文案、美术资产与合规）
A: 不设限：完全放飞

Q: 联机架构与信令托管方案选哪个？（房间人数 + 同步模型 + 信令部署）
A: 2–4 人，Host 权威同步，先用 PeerJS 公共云 0.peerjs.com，后期再自托管

Q: Blender CLI 在本项目里的定位是什么？（当前机器未装 Blender，这决定资产如何产出）
A: 全程脚本化：Blender Python 程序化建模，无人工，CI 一键生成全部 GLB

Q: 首发版本的地图与主题范围？
A: 1张, 但是我希望拉长游戏周期, 可以考虑将地图设计的复杂点

Q: 首发「复杂地图」的棋盘拓扑做到哪一档？（直接决定规则引擎的数据模型）
A: 环形 + 中央区域：中央用于小游戏/特殊事件/传送（引擎增加区域概念）

Q: 前端框架确定用哪套？（都是 Vercel 可部署的现代栈）
A: Vite + React + TypeScript + React Three Fiber（纯 SPA，构建/加载最快）

Q: 中央区域首发要实现哪些内容？（直接决定首发范围大小）
A: 2–3 个轻量小游戏（如转盘、猜拳、抽卡）

Q: 单局目标时长定多少？（用于地图规模与经济数值调优）
A: 60–90 分钟（拉长周期）

Q: 首发地图的美术世界观主题是什么？（全部资产将程序化生成，主题决定建模脚本方向）
A: 现代城市 Q 版微缩都市（街道/商铺/公园/车站）

Q: 你希望优先加入哪种创新玩法？（作为可插拔模块，影响玩法设计与数据结构）
A: 角色技能/被动：每个 Q 版角色独有技能

Q: 首发的目标平台与响应式程度？（影响 UI/UX 设计、性能预算与包体策略）
A: 仅桌面浏览器（鼠标操作；最小包体、最高画质）

Q: 音频范围与来源？（注意：Blender 管线只产 3D 模型，音频需另行解决）
A: bgm使用"D:\game\RichMan3\bgm"; 音效你自己合成

Q: 首发可玩角色数量与技能规模？（决定角色建模与技能设计工作量）
A: 4 名角色，每人 1 个独有技能（够 2–4 人对局）

Q: 首发恶搞事件的内容体量定多少？（决定文案与效果配置工作量）
A: 约 20–30 个事件，覆盖主要效果类型，后续快速迭代

Q: P2P 打洞失败（对称 NAT/严格防火墙）时如何兜底？（影响联机可靠性）
A: 仅提示「网络不支持，请换网络」——零成本，但部分用户无法联机

Q: 对局外体验（主菜单/房间/设置/引导）做到什么范围？
A: 含设置（音量/画质/昵称）与规则说明页

Q: 房主在开局前可以自定义规则吗？（影响开局 UI 与引擎参数化程度）
A: 少量预设：事件频率（低/中/高）+ 胜利条件（资产制/回合上限）

Q: AI 的使用范围与难度设计？（单人模式与联机补位）
A: 单人固定 3 名 AI，单一难度

Q: 美术调性定哪一种？（直接决定 Blender 资产脚本与 UI 主题）
A: 明亮欢快：高饱和、日间、玩具感（经典大富翁气质）

Q: 好友如何加入房间？（影响房间 UI 与安全约束）
A: 两者都要：链接分享 + 房间码手输

Q: 4 名角色的名字/形象/技能由谁定义？
A: 按照大富翁4的经典设计

Q: 一局结束后的流程？（影响结算页与房间生命周期）
A: 结算后返回主菜单，重新建房/加入

Q: 《大富翁4》角色 IP 如何处理？（公开部署到 Vercel 时直接复刻有侵权风险）
A: 致敬式原创：沿用经典人设语言（Q 版大头身、星座/性格差异化、每人 1 天赋技能），角色名称与形象完全原创（推荐，可公开部署）

Q: 胜利条件预设选项是否就按《大富翁4》经典口径？（资产倍数 2/3/5/10×；回合上限 30/90/180/365/730）
A: 按经典口径全量提供（2/3/5/10× 与 30/90/180/365/730）

Q: 首发 4 名角色的原型阵容选哪套？（名称/形象仍为原创）
A: 经典四人组：老农 + 元气少女 + 贵妇 + 忍者（最贴近《大富翁4》印象）

Q: 联机对局中是否允许两名玩家选择同一角色？
A: 禁止重复：先到先得，已被选的角色置灰
