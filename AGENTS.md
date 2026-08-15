# AGENTS.md

DSH host-only 守护插件：自动补全 `llm-pi-ai` 模型能力字段（llm-pi-ai 命名空间，只补缺失）。

## Architecture

- 单半插件（仅 host 半，无浏览器半、无 `dsh.client` manifest）：
  - `lib/capabilities.js` — 纯逻辑：缺失判定、按缺失清单合并、各来源条目→能力记录转换、id 匹配语义；
  - `lib/sources.js` — 来源链 IO：overrides 文件、已安装 pi-ai catalog（`import.meta.resolve` 定位）、最新 pi-ai（npmmirror tarball，curl+tar 子进程，缓存 24h）、models.dev 聚合（`gh api` raw，缓存 24h）；失败负缓存 1h；
  - `lib/index.js` — 守护：启动 settle 轮询（3s×100 等 llm-pi-ai 命名空间注册）、`settings/document-updated` 防抖 5s、12h 定期重扫；写入走 `settings.mutate('llm-pi-ai', [set providers], revision)`。
- 写入单元是整个 `providers` 对象：settings 的路径操作不能安全索引数组（会把数组替换成对象），粗粒度 set + `expectedRevision` 乐观锁。

## Conventions

- 源码真身在本仓库；`install.sh` 复制部署到 `$DSH_HOME/profiles/node_modules/<包名>/`（绝不 symlink，见 enter-newline 的实测教训）。
- host 半改动必须 `pm2 restart dsh-web` 才生效。
- 提交身份用命令级 env 覆盖（`GIT_AUTHOR_NAME=Wuxie233` 等），不写持久 git config。

## Gotchas & Decisions

- **pi-ai 的 exports 不含 `./package.json` 且 `.` 无 require 条件**：CJS `require.resolve` 双拼写都 `ERR_PACKAGE_PATH_NOT_EXPORTED`；定位已安装 catalog 必须用 `import.meta.resolve('@earendil-works/pi-ai')`（走 import 条件）→ `dist/index.js` 同级 `providers/data`。
- **聚合文件会遮蔽上游条目**：`opencode.json`/`opencode-go.json`/token-plan 文件按字母序排在 `zai.json` 等前面，携带稀疏条目；重复 id 时按"能力字段更多者胜"（`capabilityScore`），平局保先到。
- **自洽规则**：同一条目 `compat.supportsReasoningEffort === false` 时必须丢弃其 efforts 映射，否则 UI 档位会显示但派发永不发送（选择器撒谎）。
- **compat 只补 `openai-completions` 路由**：llm-pi-ai 的 resolveModelCompat 对其他协议上的模型级 compat 直接抛错，会拒收整次写入。
- **reasoningEfforts 不猜**：来源没有显式档位映射就不补（haiku 等无映射模型保持无档位），错配档位比缺档位危害大。
- models.dev 聚合 models.json 的 id 是 `vendor/model` slug，取 `/` 后缀做裸 id 匹配；聚合比 TOML 目录滞后（glm-5.2/5.3 长期缺），只作末位兜底。
- 最新 pi-ai catalog 里新模型常见"半成品"条目（如 0.84.2 的 glm-5.3 有 efforts 无 compat，或反之）； Overrides 文件是刚发布模型的正解，上游收录后自动被同优先级覆盖逻辑替代。
- 冒烟脚本 `scripts/smoke-scan.mjs` 导入的是**部署副本**（依赖只能从 profile 解析），改完源码要先 `./install.sh` 再跑。

## Commands

- `./install.sh` — 部署（幂等）
- `node scripts/smoke-scan.mjs` — 对真实 settings 只读预检扫描（约 12s，含网络层）
- `node --check`：ESM 文件复制为 `.mjs` 再查
- 生效验证：`cd ~/.dsh/profiles/web && node -e "await import('dsh-plugin-model-capabilities')"`
- 运行观察：`pm2 logs dsh-web --lines 50 --nostream | grep model-capabilities`

## Module Map

单包单插件。`lib/` 三模块 + `scripts/smoke-scan.mjs` 预检。参见 `README.md`。
