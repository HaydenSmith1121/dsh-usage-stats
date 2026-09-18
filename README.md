# dsh-usage-stats

在 DeepSeek Harness 的界面里看**这台 harness 花了多少 token**：按 Today / 近 7 天 / 近 30 天
/ 全部统计，并拆出服务方上报的四个桶（未缓存输入 / 输出 / 缓存读取 / 缓存写入）。

**它的重点是「删了也不丢」**：用量按会话逐个备份进一份**只增不减**的台账，
所以删除会话（`dsh-session-cleanup`、手删目录、归档清理）**不会**把它那部分用量从统计里抹掉。

适配 dsh `0.1.6-alpha.1`。只读会话日志、不持有凭据、不联系 provider、不改模型路由；
除了自己那份台账，不写任何东西。

---

## 一、这个插件解决什么问题

DSH 已经在 `$DSH_HOME/sessions/` 下为每个会话精确记录了服务方上报的 token 用量，
但那是一个**每会话累计值** —— 它回答不了「我今天花了多少」。本插件折叠那些日志，
把它变成按天、按供应商、按模型的报告。

**而会话日志是可以被删掉的**（`dsh-session-cleanup` 就是 `rm -rf` 会话目录）。
日志一没，按日志现场折叠出来的统计就跟着少一块 —— 用户清理一次侧边栏，
历史用量就凭空下降一次，这种数字没法用来做判断。

所以 0.3.0 起：每次扫描折叠出来的结果会**按会话备份**到

```none
$DSH_HOME/storages/dsh-usage-stats/usage-ledger.json
```

规则只有两条：

| 规则 | 含义 |
|---|---|
| **只增不减** | 同一个会话、同一个 (天, 供应商, 模型) 格子，取「台账里记的」与「日志现在说的」中较大的一份。日志被压缩、截断、改写，都**不能**把已经计过费的数字降下来 |
| **从不删除** | 记录写进去就只被向上更新。没有淘汰、没有 TTL、没有上限。想清空统计就删掉那个目录，下次扫描以当前日志为基线重新开始 |

后台每 30 秒巡检一次（只对 `mtime`/`size` 变过的日志重新折叠），
所以**不需要有人打开设置页**，用量也会被记下来：会话建了又删、中间没人看过页面，同样不丢。

---

## 二、安装

| 项 | 值 |
|---|---|
| 包名 | `dsh-usage-stats` |
| dsh 基线 | `0.1.6-alpha.1` |
| 源码 | 本仓库（`github.com/HaydenSmith1121/dsh-usage-stats`） |
| 分发 | 由集合仓库 [dsh-plugin-collection](https://github.com/HaydenSmith1121/dsh-plugin-collection) 托管 tarball |

**方式 A（推荐）**：装一次插件市场面板（`dsh-plugins-market`），在左侧「插件市场」里点安装。

**方式 B（手动）**：从集合仓库下载 tarball，核对 sha256，再装：

```powershell
# Windows（PowerShell）
Invoke-WebRequest -Uri <tarball 的 raw 地址> -OutFile $env:TEMP\dsh-usage-stats-0.3.0.tgz
(Get-FileHash $env:TEMP\dsh-usage-stats-0.3.0.tgz -Algorithm SHA256).Hash.ToLower()
dsh plugin --profile web add $env:TEMP\dsh-usage-stats-0.3.0.tgz
```

```bash
# macOS / Linux
curl -fL -o /tmp/dsh-usage-stats-0.3.0.tgz <tarball 的 raw 地址>
sha256sum /tmp/dsh-usage-stats-0.3.0.tgz      # macOS 用 shasum -a 256
dsh plugin --profile web add /tmp/dsh-usage-stats-0.3.0.tgz
```

> 具体的 tarball 地址与 sha256 以集合仓库
> [`plugins/dsh-usage-stats/`](https://github.com/HaydenSmith1121/dsh-plugin-collection)
> 与 `manifest.json` 为准 —— 那里记的才是被验证过的字节。

**装完重启 `dsh web`**：设置页是客户端半，重启后立刻出现；**读会话日志并维护台账的路由
由宿主半注册，只在启动时加载** —— 重启之前页面会明说这一点，而不是给一个裸 404。

---

## 三、配置

**没有配置项**：没有 API Key、没有设置项、没有环境变量。

唯一的路径约定是台账的位置（由 DSH 主目录推导）：

| 文件 | 说明 |
|---|---|
| `$DSH_HOME/storages/dsh-usage-stats/usage-ledger.json` | 用量台账（只增不减） |
| `$DSH_HOME/storages/dsh-usage-stats/usage-ledger.json.corrupt.json` | 台账损坏时被挪到这里的原件 |

`$DSH_HOME` 未设置时用 `~/.dsh`（与 DSH 自己的解析顺序一致）。

---

## 四、页面显示什么

- **总 tokens**，以及构成它的四个桶；
- **缓存读占比**（有缓存的 harness 上它常远超其它桶，只给裸总数会显得吓人）；
- 该范围内的**模型调用次数**；
- 页脚老实交代：读到几个会话日志、几个读不到、**几个已删除会话的用量是从台账保留的**。

范围是**含端点的本地日历窗口**且以今天结束，所以它们嵌套：7 天的数字必然包含 1 天的。

台账本身的状态也从不暗示，而是直接写出来：

| 状态 | 页面怎么写 |
|---|---|
| `ok` | 「删除会话不会丢用量：各会话的用量已逐个备份，只增不减。」 |
| `rebuilt` | 「用量台账曾不可用，已重建（原因）—— 重建之前保留的用量不再计入。」 |
| `unavailable` | 「用量台账 <路径> 写不进去（原因），删除会话会同时删掉它的用量。」并给出该路径 |

会话目录整体读不到时（临时故障），页面明说「本次读不到会话目录 —— 所有数字都来自备份」，
并且**不会**把在场会话谎报成「已删除」。

---

## 五、数字从哪来（口径）

折叠**刻意复刻 DSH 自己的 `tokenUsage` 投影**（`@deepseek-ai/dsh-token-meter`），
而不是自己发明一套看起来合理的规则 —— 一份和框架对不上的报告，比没有报告更糟。
三个 load-bearing 的细节：

| # | 细节 | 不这么做会怎样 |
|---|---|---|
| 1 | **同一步骤内最后一条样本胜出** | 一个流式步骤会为同一个 `(turn, step)` 记录多条 usage 样本，每条**替换**前一条。朴素求和会把一个流式步骤重复计很多遍 |
| 2 | **一次重试开一个新槽** | `llm/retry-started` 为它自己的 `(turn, step)` 关闭当前槽，所以被重试的那一次会**与它替换掉的那次并存相加** —— 它确实被计费了两次 |
| 3 | **`assistant/message` 与 `assistant/attempt` 都带 usage** | 后者是它内嵌流里最后一条 `usage` chunk |

`node scripts/verify-fold.mjs --reference <0.2.0 的 lib/index.js>` 会重新推导每个会话的合计，
并与**上一个发布的真实产物**逐字节比对（`npm test` 用仓库内冻结的那份参考实现）。

### 已知统计边界（诚实登记）

| 边界 | 说明 |
|---|---|
| **标题生成不计入** | `session/title-llm-request` 会消耗 token 但不记录 usage 样本，任何折叠都看不见。**DSH 自己的投影有同样的盲点** |
| **fork 的会话不向父会话重复计费** | fork 继承的前缀（`inheritedEventCount`）被跳过，因为那些事件保留父会话的时间戳、已经随父会话计过 |
| **台账启用之前的删除救不回来** | 0.3.0 第一次运行之前就被删掉的会话，日志已经没了，任何实现都无法复原。台账从第一次扫描开始积累 |
| **删除前最后 ≤30 秒的用量** | 极端情况下（会话在被折叠之前就被删掉）可能来不及记账。巡检间隔是 30 秒，它决定这个窗口 |
| **读失败会被报出来，不会被藏起来** | 页脚显示读了多少个日志、点名几个读不到；不完整的数字永远不会被当成完整的呈现 |

---

## 六、卸载 / 回滚

```bash
dsh plugin --profile web remove dsh-usage-stats
dsh web        # 重启
```

卸载**不会**删掉台账：那是你花掉的用量的记录，删不删由你决定。
想清空统计：删掉 `$DSH_HOME/storages/dsh-usage-stats/`（整目录或那一个 json），
下次扫描会以当前在场的会话日志为基线重建 —— 报告会随之下降，这是预期行为。

回滚到旧版：装回集合仓库里上一版即可，本插件不迁移、不改写任何 DSH 数据。

> ⚠️ **与 `dsh-workbuddy-quota` 的关系**：本包是它的继任者（改名 + 只保留用量统计）。
> 两者**不要同时装** —— 它们注册的设置分区 id 不同（`usage-stats` / `token-usage`），
> 同时装会出现两个 Token 用量页。旧包仍然可用，但不再维护。

---

## 七、开发

```bash
npm run build                 # src/ → lib/（无打包器：宿主半是拷贝，客户端半加外壳）
npm run build:check           # 校验 lib/ 与 src/ 一致（CI 用）
npm test                      # 五个套件：构建一致性 / 折叠一致 / 删除保留 / 宿主路由 / 客户端渲染
npm test -- --sessions <dir>  # 再加上真实会话日志的逐字节比对

npm test -- --reference <解包后的 0.2.0 包目录>   # 折叠比对改用真实产物作参考
```

目录：

```none
src/
├─ index.js                 宿主半入口：注册路由 + 启动巡检
├─ shared/buckets.js        桶运算与日历窗口（构建时内联进客户端半，两边不会漂移）
├─ usage/
│  ├─ decode.js             zstd 多帧 + JSONL 解码
│  ├─ fold.js               折叠算法（复刻 DSH 的 tokenUsage 投影）+ 只增不减的合并
│  ├─ ledger.js             台账：读取 / 校验 / 原子写入 / 损坏隔离
│  ├─ scan.js               扫描会话目录（按 mtime+size 记忆化）
│  ├─ report.js             合并「在场日志」与「台账」，产出报告
│  └─ host.js               扫描→对账→落盘→报告，外加那条 HTTP 路由
└─ client.js                客户端半（ModuleLoader 工厂体：设置页）
scripts/                    构建、五个校验套件、打包
test/                       合成会话日志构造器 + 冻结的 0.2.0 折叠参考实现
```

`lib/` **是提交进仓库的**：本包也支持 `github:` 直接安装，而 git 安装不会跑我们的构建步骤；
`npm run build:check` 是保证它与 `src/` 不脱节的那道闸门。

---

## 八、许可

MIT（见 [LICENSE](./LICENSE)）。作者：HaydenSmith1121。
