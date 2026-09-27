# Harness 版本兼容

本包是**构建产物**（`lib/` 提交进仓库，git 安装不跑构建），所以它不能随 harness 一起重新发布。
它因此做两件事：把支持的版本写进 `peerDependencies`（让启动器按 harness 自己的规则拒绝不兼容的
组合，而不是悄悄跑坏），以及在**运行时按能力探测**而不是按版本号猜。

本页所有结论都是**实测**的：下面每张表都能用第 5 节的命令在一棵真实 harness 树上重跑一遍。

---

## 一、支持的版本

`@deepseek-ai/dsh*` 是 lockstep 发布的，本包声明的 peer 范围是：

```none
>=0.1.6-alpha.1 <0.2.0-0 || >=0.1.7-alpha.0 <0.2.0-0
```

| 版本 | 状态 | 差别 |
|---|---|---|
| `0.1.5-rc.3` 及更早 | **不支持** | 会话格式代际更早（v0/v1），peer 范围直接拒绝 |
| `0.1.6-alpha.1` | 支持；本包最初的基线 | 会话格式代际 **v3**（`session.v3.jsonl.zstd`） |
| `0.1.6-alpha.2` | 支持（实测通过 `compat-check`） | 同上 |
| `0.1.7-alpha.1` … `0.1.7-rc.2` | 支持；`rc.2` 是当前桌面版 | 会话格式代际 **v4**（`session.v4.jsonl.zstd`） |
| `0.2.0` 及以后 | 未声明 | 上界 `<0.2.0-0` 是刻意的：它连 `0.2.0-rc.1` 也排除 |

### 为什么范围要写成两项

启动器用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 评估
（`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`）—— 预发布版本在这里是**参与**比较的，
所以对启动器而言一项就够。但 npm / pnpm 自己报 peer 时用的是普通 semver 规则：**带预发布标签的版本，
只有当比较式里存在同一 `major.minor.patch` 的预发布项时才算满足**。于是 `>=0.1.6-alpha.1 <0.2.0`
和 `*` 都**不**匹配 `0.1.7-rc.2`。一条发布线一项，是让两个读者都不说谎的写法。

`@deepseek-ai/cordis`、`react`、以及三个客户端模块不是 `@deepseek-ai/dsh*`，
启动器不检查它们（`evaluatePluginCompatibility` 只看 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`），
所以它们带普通范围；客户端模块与 `react` 另标 `peerDependenciesMeta.optional`，
因为它们由**浏览器的模块注册表**提供，`node_modules` 里从来就没有。

---

## 二、唯一真正会变的接口：会话日志的磁盘格式

本插件的宿主半**不 import 任何 `@deepseek-ai/*` 包** —— 它只通过 DI 拿 `webServer` 服务、
并直接读磁盘上的会话日志。所以「兼容」这件事，几乎全部落在**会话日志格式**上。

格式有两处随发布线移动，且都是承重的：

### 2.1 文件名带代际

```none
session.jsonl[.zstd]        ← 代际 0（最早的、无标签的名字）
session.v<N>.jsonl[.zstd]   ← 代际 N ≥ 1
```

`session.v3.jsonl.zstd` 是 `0.1.6` 写的，`session.v4.jsonl.zstd` 是 `0.1.7` 写的。
**升级之后两代文件可以在同一个目录里并存** —— 迁移的做法是把新一代写在旧一代旁边，
而 harness 读的是**数值最高的那一代**（`dsh-session-persistence-jsonl` 的 `selectGeneration`）。
所以：写死一个文件名会在另一条发布线上**一个日志都找不到**（页面全是 0）；
读错一代、或者两代都读，则是两个方向的错。

实测（三棵树里的同一段代码）：

| | `0.1.6-alpha.1` | `0.1.6-alpha.2` | `0.1.7-rc.2` |
|---|---|---|---|
| `SESSION_FORMAT_VERSION` | `3` | `3` | `4` |
| `CANONICAL_LOG_FILENAME` | `/^session(?:\.v([1-9][0-9]*))?\.jsonl$/u` | 同左 | 同左 |

正则三代**逐字节相同**，所以本包照抄它（`src/usage/format.js` 的 `CANONICAL_LOG_NAME`）就够了 ——
不需要为每条发布线写一套规则。`session.V4.jsonl`、`session.v04.jsonl`、`session.v0.jsonl`、
`session.v4.jsonl.zstd.tmp` 都**不是**已提交的代际，harness 不读，本包也不计。

### 2.2 fork 切点从表头搬进了日志

日志的第一行是**表头行**（`{"type":"session", …}`），它不是事件：没有 `seq`，
所以事件解析器会正确地把它丢掉。它携带的事实随代际变化：

| 代际 | 表头 | fork 继承切点 |
|---|---|---|
| 0–1 | 扁平，带 `seedLength` | 表头里的 `seedLength` |
| 2、3、4 | 扁平，只有 `isSeeded` | **最后一条带 `inherited: true` 的 `session/end-seed` 事件的 `seq`** |

harness 自己的 README 就是这么写的
（`dsh-session-persistence-jsonl`：“The current format stores `isSeeded` in the header and
derives the inherited cut from the last tagged `session/end-seed` marker, while historical
codecs translate their numeric `seedLength`.”），而 `dsh-session/lib/types/fork.js` 把标记
写在 `seq: boundary + 1`，也就是「继承前缀之后的第一条」。

这条规则在两条发布线上**实测相同**：

```none
# 0.1.6-alpha.1 与 0.1.7-rc.2 的 dsh-session-format-v1-to-v2，逐字相同
if (event.type === "session/end-seed") {
  if (jsonRecord(event.data, …)["inherited"] === true) inheritedEventCount = event.seq;
}
if (header.isSeeded && inheritedEventCount === undefined)
  throw new SessionFormatError("released v2 seeded Session lacks an inherited end-seed marker");
```

注意最后那两行：**声明了 seeded 却没有标记的日志，harness 自己会抛**。
本包对同一种日志做同一件事 —— 把该会话记为「读不到」并如实报出，
而不是猜一个切点（猜错的后果是把父会话的整段前缀**再计一次费**）。

### 2.3 这次修掉的三个缺陷

0.3.1 及更早的版本里，这三件事都是错的（其中前两条继承自被它取代的 0.2.0）：

| 缺陷 | 在 `0.1.6` 上的表现 | 在 `0.1.7-rc.2` 上的表现 |
|---|---|---|
| 写死 `session.v3.jsonl.zstd` | 恰好正确 | **一个会话都读不到，页面全是 0** |
| 从 `header.data.inheritedEventCount` 读切点 | 未 fork 的会话看不出来；**fork/subagent 会话把父前缀重复计费** | 同上 |
| 从 `header.data.createdAt` 读创建时间 | 总是 0（只影响没有 `time` 的事件） | 同上 |

第一条是这次最要命的：**在 `0.1.7-rc.2` 上插件原本是完全不工作的**，而不是数字略有偏差。

---

## 三、两条发布线上**没有**变的东西（也实测过）

| 接口 | `0.1.6-alpha.1` / `alpha.2` | `0.1.7-rc.2` |
|---|---|---|
| `webServer.register({ kind, path, handler })` | `route.kind === "exact" ? this.exact : this.prefixes` | 同左 |
| `webServer.registerFallback` / `tapIndex` | 有 | 有 |
| `ctx.slots.inject('settings.section', …)` + `ctx.slots.register({name,id,order,label}, C)` | 有 | 有（slot 描述符在 `dsh-cordis-client-runner` 里逐字给出同一个例子） |
| `ctx.locale.register(ns, { zh, en })` / `ctx.locale.bind(ns)` | 有 | 有 |
| `window.__ModuleLoader__.load({ id, factory })` 外壳 | 有 | 有（harness 自己 83 个客户端模块用的是同一个外壳） |
| `DSH_HOME` → `~/.dsh` 的解析顺序 | 同 | 同（`dsh-home-paths`） |
| `tokenUsage` 投影语义（最后一条样本胜出 / 重试开新槽 / 两种事件都带 usage） | 同 | 同（`dsh-token-meter`） |
| `sessions/<工作区>/<会话 id>/` 两层布局 | 同 | 同（工作区是压平后的 cwd，无 cwd 时为 `_no-cwd`） |

所以本插件**不需要**按版本分叉代码：会话格式按**代际**识别（这是磁盘上的事实，
不是版本号），其余接口在两条线上是同一个。这也是为什么 `src/usage/format.js` 里
一个版本号判断都没有。

---

## 四、遇到不认识的格式时怎么办

原则和 0.2.0 一致：**和框架对不上的数字，比没有数字更糟**。

| 情况 | 行为 |
|---|---|
| 表头代际是新的、但事件形状没变 | 正常折叠，并在页脚**写出读到的代际**（`v4 × 12`） |
| 日志目录里有多代文件 | 读数值最高的那一代；旧代文件不读、也不重复计 |
| 目录里没有规范的代际文件名 | 该会话记为「读不到」（页脚会报数量），台账里原有的记录**不动**、也不被判为已删除 |
| 声明 `isSeeded` 却找不到继承标记 | 记为「读不到」。harness 自己的解码器对这种日志同样抛错 |
| 表头完全读不出来 | 按「未 fork、切点 0」折叠（与 harness 对无表头日志的宽容一致），代际记为 `null` 并在页脚显示为「未标版本」 |

页脚会写出代际分布，就是为了让「它在这台机器上到底读懂了没有」是一个**可核对的事实**，
而不是一句承诺。

---

## 五、怎么重新验证

### 5.1 声明面：本包 vs 一棵真实 harness 树

```bash
node scripts/compat-check.mjs --tree <放着 @deepseek-ai/* 包的目录>
node scripts/compat-check.mjs --tree <目录> --runtime 0.1.7-rc.2 --json
```

它检查：宿主半的 import 面（当前是**零**个 harness 包，所以不可能链接失败）、
客户端半的 `require()` 面、`dsh.client.inject` 里每个名字在这棵树里是否真的存在、
`dsh.bundle.patch` 是否在包内、以及**每个 `@deepseek-ai/dsh*` peer 范围是否接受这棵树的运行时版本**。
范围判定按启动器的规则（`includePrerelease`）在本脚本内重新实现，并用 10 个参考用例自检
（含 `0.1.7-rc.2` 应被接受、`0.2.0-rc.1` 应被拒绝、`0.1.5-rc.3` 应被拒绝）。

桌面版的运行时**在 `app.asar` 里**，不是磁盘上的普通目录，需要先解出来再指过去。

实测结果：

```none
0.1.6-alpha.1  OK: 12 surfaces checked
0.1.6-alpha.2  OK: 12 surfaces checked
0.1.7-rc.2     OK: 12 surfaces checked
```

### 5.2 行为面：格式矩阵

```bash
node scripts/verify-compat.mjs --sessions "$DSH_HOME/sessions"
```

它按代际造出真实的日志（v0/v1 的 `seedLength`、v3/v4 的 `session/end-seed` 标记、明文编码、
多代并存、非规范文件名），逐条断言**手算出来的**期望值，并把「按代际选文件名」和
「切点推导」两件事与脚本内**另一份独立转写**的规则交叉比对
（`selectLog` 与独立实现在 256 种目录组合上必须选同一个文件）。
最后一段在真实会话树上核对「文件名里的代际 == 表头里的代际」。

---

## 六、已知边界

- **只真机跑过 `web` / `desktop` profile。** `headless`、`tui`、`acp`、`sdk` 共用同一批 bundle
  和同一个 `apply()`，但没有实测。
- **`0.1.7-alpha.1` / `alpha.2` / `rc.1` 只在 peer 范围与接口差异之内**，没有逐一启动；
  真机启动过的是 `0.1.7-rc.2`。`0.1.6` 这一侧实测的是 `alpha.1` 与 `alpha.2` 的**包树**，
  没有重启 `0.1.6` 的 harness 进程。
- **手上没有真实的 seeded（fork/subagent）会话日志。** 切点规则是按 harness 的源码、
  它自己的 README 与合成日志验证的，不是在一条真实的 fork 日志上验证的 ——
  合成日志的形状是照着 `fork.js` 的 `seq: boundary + 1` 造的。
- **只有 Windows。**
- 会话 id 用的是**目录名**（harness 会对 id 做 `encodeSegment` 转义）。对本插件的用途
  （稳定的身份标识）足够；它不会被当成原始 id 反解。
