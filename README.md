## 当前接入方式：dsh-std adapter

本插件通过 dsh-plugin.json 声明标准 host facet；lib/index.js 发布
plugins.starpivot.dev/v1 HostPlugin，lib/host.js 保留业务策略并接收 adapter API。
有浏览器界面的插件另声明 LocalModule，使用私有 WebPlugin surface。

执行 ./install.sh 会先验证全部九个自制插件的组合、Web 界面与 CodeCarry
原生 Remote，再备份并复制部署；失败不替换生产插件。需先安装同级 dsh-std
维护仓库及其依赖。部署后在没有活跃任务时重启 dsh，并刷新 Web。

不要把 lib/index.js 直接作为 Cordis 插件挂载；原插件的 cordis insert 行由
共享部署器移除，配置迁入 adapter.componentConfigs。不要链接运行时插件目录。
标准协议不承诺未来版本永久兼容；native ctx/hooks 的变化由候选门禁和集中
adapter 维护控制。Web 界面不会自动出现在原生 Android 中。

下方保留业务说明和历史修复记录；涉及旧式直接挂载、导入和安装步骤的内容，
以本节为准。

# dsh-plugin-model-capabilities

DSH 后台守护插件：自动补全 `llm-pi-ai` 各路由模型条目缺失的能力字段（上下文窗口、输出上限、输入模态、推理档位、compat），补完的配置经 settings 服务写入 `~/.dsh/settings.yaml`，热加载即时生效。

## 行为

- 触发：启动（llm-pi-ai 命名空间注册后）／`llm-pi-ai` 设置变更（防抖 5s）／每 12h 定期重扫。
- 来源链（按优先级）：
  1. `~/.dsh/model-capabilities.overrides.json` — 本地覆盖，最高优先，插件只读不写；
  2. 最新 pi-ai npm catalog（npmmirror 拉取，缓存 24h）；
  3. 运行时已安装的 pi-ai catalog（零网络）；
  4. models.dev 聚合数据（`gh api` 拉取，缓存 24h）。
- 安全性：**只补缺失字段，永不覆盖已写字段**；写入走 settings 服务，llm-pi-ai 自己的 `assertServiceable` 校验拒绝坏数据（整次写入拒收、不落盘）；写入冲突自动重扫一次收敛。已有 `compat` 对象若缺 `supportsDeveloperRole`，按来源事实合并该键；来源未写而条目或来源是 `thinkingFormat: zai` 时填 `false`。
- 仅处理显式声明了 `api` 的路由（自定义中转路由）；catalog 路由自带完整数据无需帮助。
- 每次补全写一行日志（`pm2 logs dsh-web` 可见）：`model-capabilities: <route>/<model> <- <source>: <fields>`。

## 新模型刚发布时

上游（pi-ai / models.dev）通常滞后 1–3 天收录。当天在 `~/.dsh/model-capabilities.overrides.json` 加一条即可（见文件内注释），字段形状与 settings.yaml 的模型条目一致。

## 安装 / 更新

```sh
./install.sh          # 部署到 ~/.dsh/profiles/node_modules/
# 挂载行（~/.dsh/profiles/web/cordis.patch.yml）：
#   - id: model-capabilities
#     name: dsh-plugin-model-capabilities
pm2 restart dsh-web   # host 半改动需重启生效
```

## 验证

- 部署后：`cd ~/.dsh/profiles/web && node -e "await import('dsh-plugin-model-capabilities')"`
- 扫描预检（不动真实 settings）：`node scripts/smoke-scan.mjs`
- 运行日志：`pm2 logs dsh-web --lines 50 --nostream | grep model-capabilities`
