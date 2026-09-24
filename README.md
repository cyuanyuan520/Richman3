# RichMan3 · Q版 3D 大富翁

一款 Q 版画风的 3D 大富翁（Monopoly 类）桌面网页游戏：在线实时多人（WebRTC P2P）+ 单人 AI，
3D 资产全部由 Blender Python 脚本程序化生成，前端部署在 Vercel。

完整规格见 [`interview/q-blender-cli-vercel-d845cbe1-b273-4c80-ba6c-0a75fadbe6d5.md`](interview/q-blender-cli-vercel-d845cbe1-b273-4c80-ba6c-0a75fadbe6d5.md)。

## 技术栈

| 关注点   | 选型                                                                 |
| -------- | -------------------------------------------------------------------- |
| 构建     | Vite 8                                                               |
| UI       | React 19 + TypeScript 5.9                                            |
| 3D       | three.js + React Three Fiber 9 + drei                                |
| 校验     | Zod 4                                                                |
| 联机     | PeerJS（Host 权威，信令走公共云，可切换自托管）                      |
| 单测     | Vitest 5 + Testing Library（jsdom）                                  |
| 代码质量 | ESLint 10（flat config）+ Prettier                                   |
| 部署     | Vercel 静态托管（SPA rewrite + `noindex`）                           |
| 资产     | Blender 5.2.2 LTS headless（`scripts/build_assets.py`，P5 阶段落地） |

## 环境要求

- Node.js 24（见 `.nvmrc`）与 pnpm 12
- **Blender 5.2.2 LTS**，本机路径 `D:\Blender\blender.exe`（不在 PATH，构建脚本使用
  `BLENDER_BIN` 环境变量，默认该绝对路径）
- 访问 GitHub / npm 需要本地代理时，设置：
  ```bash
  export http_proxy=http://127.0.0.1:7890
  export https_proxy=http://127.0.0.1:7890
  ```

## 常用命令

```bash
pnpm install       # 安装依赖
pnpm dev           # 启动开发服务器 http://localhost:5173
pnpm typecheck     # tsc --noEmit
pnpm lint          # ESLint
pnpm format        # Prettier 写入
pnpm test          # Vitest 单次运行
pnpm test:watch    # Vitest 监听
pnpm build         # 类型检查 + 生产构建到 dist/
pnpm preview       # 预览生产构建
```

## 目录结构

```text
src/
  App.tsx            引导场景（后续被大厅/棋盘/ HUD 替换）
  lib/room-code.ts   房间标识契约（分享链接 / 6 位房间码，REQ-029 / SEC-006）
  engine/            确定性规则引擎与数据契约（P2）
  content/           角色、恶搞事件、地图等数据包（P3）
  net/               Host 权威联机协议与传输（P4）
  audio/             BGM 懒加载 + Web Audio 合成音效（P6）
  ui/                菜单 / 房间 / 设置 / 规则页 / HUD（P6）
scripts/             Blender 资产构建脚本（P5）
public/models/       程序化生成的 GLB（P5，随仓库提交）
docs/                补充文档
```

## 开发约定

- 仅桌面浏览器（WebGL2），不要求移动端适配。
- 规则引擎必须保持**纯逻辑 + 确定性**：同 seed + 同 intent ⇒ 同状态。
- 联机采用 **Host 权威**：客户端只发送意图，房主校验后广播事件。
- 所有 3D 资产必须可由脚本重建：禁止手工建模产物入库。
- 页面带 `noindex`，房间仅限邀请（无公开匹配）。

## 路线图

| 阶段 | 内容                                         | 状态   |
| ---- | -------------------------------------------- | ------ |
| P1   | 仓库引导与工具链（脚手架、CI、测试基线）     | 进行中 |
| P2   | 确定性引擎与数据契约                         | 待开始 |
| P3   | 内容包（4 角色 / 20–30 恶搞事件 / 首发地图） | 待开始 |
| P4   | 联机（PeerJS，Host 权威）                    | 待开始 |
| P5   | Blender 资产管线                             | 待开始 |
| P6   | 前端体验、音频、E2E、Vercel 部署             | 待开始 |
