# cvte/selfhost-e2b — 分支规则（follower 必读）

> 本分支是 CVTE 自托管 E2B 的**唯一代码线**：fork 自 `deepseek-ai/deepseek-harness`，
> 只补官方 POC 没有的自托管连接面。改任何东西之前，先读完本文。

## 1. 分支模型

- `cvte/selfhost-e2b` 基于官方 **release tag**（当前 `dsh-v0.1.0-rc.8`），**不追 main**。
  官方 rc 之间差异巨大（rc.7→rc.8 之间 250+ commits），追 main 会被无关变更淹没。
- 同步官方新 rc：

  ```sh
  git fetch upstream --tags
  git rebase --onto dsh-v0.1.0-rc.9 dsh-v0.1.0-rc.8 cvte/selfhost-e2b
  # 冲突只应出现在 packages/e2b/**；出现在别处 = 上游重构了，先停下来读上游 diff
  ```

- 永不 merge main 进本分支；只用 rebase 挪 tag 基线。

## 2. Diff 纪律（最重要的一条）

**只允许改 `packages/e2b/**`**（含 `tests/`）。这是 rebase 存活率的全部。

禁止触碰：
- `packages/bundle/**`（base/web-app/headless 组合）——执行世界由**使用方 overlay** 组合，不改基座
- bash / PTY / LSP / glob / grep 等**消费者**——它们是官方通用的，fork 它们就是回到旧路
- 其他任何 `packages/**`、`apps/**`、`native/**`、`vendor/**`

若确信必须越界（如上游 API 破坏性变更），先在本文「越界记录」一节登记理由与范围，
保持最小，并在 commit message 里显式标注 `out-of-scope:`。

## 3. 自托管字段的硬规则

`packages/e2b/e2b` 的 `Config` 上有三个自托管字段，规则如下，**不得放松**：

| 字段 | env 兜底 | 规则 |
|---|---|---|
| `apiUrl` | `E2B_API_URL` | **fail-closed**：空 ⇒ 构造即抛错。绝不默认 e2b.app |
| `domain` | `E2B_DOMAIN` | **fail-closed**：空 ⇒ 抛错。缺失时 SDK 会把 envd 流量路由到 `e2b.app` 然后假报 sandbox not found——这是最坑的静默失败，必须挡在构造期 |
| `template` | `E2B_TEMPLATE` | **fail-closed** + 只认 **模板 ID**。自托管 API 对别名直接 404（实测），错误信息必须写明「ID not alias」 |

- env 兜底顺序：config 显式值 > env > 报错。三者都不允许「云默认值」。
- `apiKey` 沿用官方语义（config 或 `E2B_API_KEY`）。
- `secure: true` 是官方默认，已实测在 CVTE 自托管集群成立（create 437ms）。
  **不得**为自托管「顺手」降级；要动必须附实测证据。
- 所有报错前缀 `dsh-e2b:` 保持官方风格，消息里点名 env 变量名。

## 4. 测试要求

- 每个 diff 必须带单测（`packages/e2b/e2b/tests/e2b.spec.ts`，风格随官方：mock `e2b`
  的静态 `Sandbox.create`）。
- 单测全绿不算完；**live 验证**才算完（`composition.e2e.ts` 本身就是
  `describe.skipIf(!process.env.E2B_API_KEY)` 门控的，带上四个 env 直接打真集群）。
- 新增行为先写失败测试再写实现（官方仓的惯例）。

## 5. 凭据纪律

- 任何密钥**不进 git**、不进日志、不 echo。
- live 测试凭据从 `~/.dsh/.credentials.yaml` 读出注入 env（`E2B_API_KEY` /
  `E2B_API_URL` / `E2B_DOMAIN` / `E2B_TEMPLATE`）。
- 模板构建需要 `E2B_ACCESS_TOKEN`：自托管**任意非空**即可（官方不签发真 token）。

## 6. 消费方式（本分支产物怎么被用）

- `npx @deepseek-ai/dsh`（官方 CLI）**永不 patch**——CLI 不含 e2b，执行世界由
  profile 装包组合。
- 本分支产物经 profile 消费：overlay 禁 `subprocess-local`/`fs-local`，挂本 owner +
  官方 `@deepseek-ai/dsh-fs-e2b` + `@deepseek-ai/dsh-subprocess-e2b`。
  官方适配器 peer 依赖云版 `@deepseek-ai/dsh-e2b`：**同装不同挂**即可满足，
  不要为此改适配器。
- 发布名/路由方案见 commit 历史与旧仓知识库
  （`~/code/agents/dsh-e2b-plugin` README 的「踩坑速查」）。

## 7. 已知坑（从旧仓验证带过来，别再踩）

| 坑 | 结论 |
|---|---|
| SDK 世代 | 必须 v2 Connect 世代（`e2b ^2.39.0`），envd 监听 49983；0.16.x beta 是废的 |
| 模板别名 | `Sandbox.create` 只认 ID，别名 404 |
| 缺 `E2B_DOMAIN` | envd 流量路由到 e2b.app → 假报 `sandbox not found`，沙箱其实活着 |
| 官方 `tool-fs-search` | spawn 宿主 `@vscode/ripgrep` 的绝对路径，进沙箱 ENOENT。adapter 已把 argv[0] 改写成沙箱内 `/usr/bin/rg`（只匹配 `@vscode`/`ripgrep` 打包路径），**不要**为此改 tool-fs-search |
| 官方 owner TTL | create 是 `onTimeout:'kill'`、无 keep-alive。Web 闲置 > timeoutMs 后第一次 bash 报 `Sandbox is probably not running anymore`。`getSandbox()` 每次成功获取都会 `setTimeout(timeoutMs)` 续命；overlay 默认 30min |
| GUI workspace vs e2b.cwd | overlay 钉远端 Linux 路径（默认 `/home/user/workspace`）。Web picker 仍会把宿主机绝对路径写进 `session.header.cwd`；adapter 已把 `/Users`/`C:\` 等 host-absolute cwd/path remap 到 `e2b.cwd`（`remapHostPathToSandbox`），**不要**为此改 Web picker |
| 源码 3081 热更新 | `pnpm dsh`/`tsx apps/cli/src/bin.ts` 读的是源码，但 **已启动的进程不会加载后来的 diff**。改 owner/adapter 后必须杀 3081 再起，否则会继续打到旧沙箱/旧 TTL |
| envd 事件延迟 | 自托管 envd（0.6.x Connect）把 background 命令的输出帧+完成事件延迟 ~0.6–0.9s 投递（帧是迟到不是丢失，与 settlement 同时到）；官方 adapter 以 `graceMs`（250–500ms）为排空窗会静默丢首批输出。已修：自然退出排空 = `max(graceMs, 3s)`，可用 `E2B_OUTPUT_DRAIN_BUDGET_MS` 调；慢集群先测 `packages/e2b/e2b` timing 再调 |
| envd 把 `user` 写回 sudo 组 | 模板构建期 `gpasswd -d` 无效；已用剥 setuid 断提权，别重复尝试 |
| 升级 rc tag 时 SQLite | rc.8 数据结构与 rc.7 不兼容；切 tag 前备份 `~/.dsh` |
| 本地 node/pnpm | node `^22.19.0`，`corepack` 提供 `pnpm@11.7.0`（root `packageManager` 锁定） |

## 8. 提交规范

- 约定式前缀：`selfhost:`（三字段相关）、`test:`、`docs:`、`chore(sync):`（rebase 挪基线）。
- 一个提交一件事；规则文档（本文件）改动独立提交。
- rebase 之后提交历史必须线性（`git log --oneline` 无 merge 节点）。

## 9. Follower 上手清单

```sh
git checkout cvte/selfhost-e2b
corepack pnpm install
corepack pnpm vitest run packages/e2b     # 单测全绿再动
# live：注入四个 env 后
corepack pnpm vitest run packages/e2b/e2b/tests/composition.e2e.ts
```

## 越界记录

（暂无。保持为空。）
