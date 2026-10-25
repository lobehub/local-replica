# local-replica

[English](./README.md) · **简体中文**

**Linear 般的 local-first 体验，但不用重写后端，也不用引入一套同步引擎。**

你的 API、请求层和 store 都保持原样。local-replica 在本地保存一份服务端最近一次返回的副本：每个列表和详情页首帧就有数据，写操作即时生效，服务端在后台静默校准。

<!-- TODO: 刷新前后对比 GIF（骨架屏闪烁 vs 直接出数据） -->

## 为什么

### 大家都想要 Linear 的手感

Linear 用起来"快"，靠的是三件事：

- **打开就有**：没有 loading，没有骨架屏，刷新或重开应用都直接出数据。
- **操作即生效**：点完立刻变，不用等服务端返回。
- **到处一致**：一处改了，列表、详情页、侧边栏同时更新。

这就是 local-first 的体验，用户用过就回不去了。

### 但同步引擎对应用开发者来说代价很高

Linear 能做到这些，靠的是一套专门打造的同步引擎。如果想用同样的方式获得同样的体验（不管是自研，还是采用 Replicache、Zero、ElectricSQL、PowerSync 这类方案），通常要接受下面的部分代价：

| 代价                     | 实际意味着什么                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **后端围绕同步协议改造** | 变更日志、版本号或 sync id、push / pull 端点。写操作要走引擎的 mutation 通道，现有的 REST / tRPC / server action 不能直接用。 |
| **客户端多了一个数据库** | 本地要维护完整的对象图或表结构，每次 schema 变更客户端也要跟着迁移。                                               |
| **权限要表达两遍**       | "这个用户能同步哪些数据"要在同步层重新表达一遍，和业务里已有的鉴权逻辑分开维护。                                   |
| **首次同步与数据量**     | 大工作区的首次同步、增量同步、本地存储膨胀，都需要专门设计。                                                       |
| **冲突与调试**           | 数据的真相分散在客户端、同步层、服务端三处，一个值不对很难追溯来源。                                               |
| **锁定**                 | 数据层绑定在某个引擎上，往往还绑定某种数据库，迁移成本很高。                                                       |

想直观感受这需要什么，可以读 [Reverse Engineering Linear's Sync Engine](https://github.com/wzhudev/reverse-linear-sync-engine)。作者从 Linear 线上发布的（经过混淆的）前端代码中逆向还原了 Linear Sync Engine（LSE），给代码逐段加了注释，并和 Linear 公开的演讲内容做了对照。Linear 的 CTO 后来评价它比 Linear 内部的文档还要完整。从中可以看到：

- **模型是一套客户端 ORM**：约 80 个模型通过装饰器注册到 `ModelRegistry`，带有加载策略（`instant`、`lazy`、`partial` 等）、引用和反向引用。模型用 MobX 实现可观察，存放在内存对象池里。
- **客户端跑着一个数据库**：启动时要把数据装进每个工作区一个的 IndexedDB 数据库（分为完整、部分、本地三种启动方式）。所有模型元数据会算出一个 hash，用来判断这个数据库何时需要迁移；数据再从库里按需懒加载到内存。
- **写操作是事务，不是 API 调用**：`issue.title = '…'; issue.save()` 会生成一个事务。事务先排队并缓存进 IndexedDB，再批量发给服务端；服务端拒绝时可以在客户端撤销。
- **服务端是一个排序器**：服务端用一个全局递增的 `syncId` 执行每个事务，再通过 WebSocket 把 delta packet 广播给所有客户端，包括发起事务的那个。权限则表达为客户端订阅的 sync group。

最终的开发体验非常好，但前提是前端运行时、带迁移的客户端数据库、事务协议和服务端排序器都要为它配套建好。

对 Linear 这种从第一天就围绕同步引擎设计的产品来说，这是合理的投资。但对大多数已经有服务端 API、请求层和 store 的应用来说，这等于为了体验把数据层推倒重来，而且之后的每个新功能都要在这套心智模型里写。

### 用户感知到的"快"，大部分不需要同步引擎

拆开来看，用户真正感知到的是：

- **打开就有** → 首帧从本地存储读出上次确认的值来绘制。
- **操作即生效** → 乐观更新。
- **到处一致** → 把同一个实体的变更同步到所有持有它的副本。

这三件事都可以在客户端完成，前提是数据仍然从服务端正常获取，同时客户端保存一份生命周期被严格管理的本地副本。

## 工作方式：server data fetch + local data caching

```
  你现有的 API（REST / tRPC / server action）   ← 不用改
              │  fetcher
              ▼
  你现有的请求层（SWR）                          ← 不用换
              │
              ▼
  ┌─────────── local-replica ───────────┐
  │ 首帧从本地副本绘制                   │
  │ 服务端响应在后台静默校准             │
  │ 乐观写入叠加，失败自动回滚           │
  │ 一个实体同步到所有副本               │
  │ 按用户 + 工作区隔离                  │
  └──────────────────────────────────────┘
              │
              ▼
  你现有的 store（Zustand）                      ← 仍然是 UI 唯一的数据源
              │  selector
              ▼
            组件                                 ← 读法不变
```

- **服务端仍然是真相**：数据来自你现有的接口，鉴权、业务逻辑、数据库都不用动。
- **本地只是副本**：用来绘制首帧、承接乐观写入，每次服务端响应都会校准它。
- **渐进接入**：一次接一个列表，不需要一次性迁移整个数据层。

## 你不用再操心的事

"加一层本地缓存"听起来很简单。难点在于副本一旦持久化，它就活得比当前会话、当前登录用户、当前进行中的写操作都长。local-replica 把这些问题收进了包里，业务代码不用管：

- **首帧来自副本**：在网络返回之前，先从持久化存储读出上次确认的值，刷新或重新进入页面不会闪骨架屏。
- **服务端静默确认**：网络返回的头页会替换副本，但已加载的分页、仅存在于客户端的行、进行中的写操作都会保留。
- **写操作立即生效**：乐观更新会立刻叠加上去。写失败时回滚到"已确认的基线＋其它仍在进行中的写操作"。乐观值永远不会写入存储。
- **一个实体，所有副本**：`linkReplicaEntity` 会把 patch 或 delete 发送到每一个持有该实体的副本，包括列表行、管理页、详情缓存，以及未加载的持久化行。
- **删了就是删了**：针对实体、key、整个资源分别提供删除原语，会清除每一个持久化变体，并拦截已经在路上的 hydrate，刷新后不会让已删除的数据复活。
- **身份安全**：内存和存储都按 scope（用户＋工作区）分区。切换 scope 时先清空视图再绘制，上一个 scope 晚到的结果直接丢弃。
- **存储有界**：可以按 scope 设置上限，超出时淘汰最久未使用的行，但不会淘汰正在显示或有写操作进行中的条目。

你需要写的只有：一个资源定义、一个 fetcher、一次 `useSync` 调用。

## 对比

|                              | 传统 SWR + store | **local-replica** | Linear 式同步引擎 |
| ---------------------------- | ---------------- | ----------------- | ----------------- |
| 打开就有数据                 | ✗                | ✓                 | ✓                 |
| 操作即生效                   | 手写             | ✓                 | ✓                 |
| 实体跨视图一致               | 手写             | ✓                 | ✓                 |
| 后端改造                     | 无               | **无**            | 大                |
| 客户端数据库 / schema 迁移   | 无               | **无**            | 有                |
| 复用现有 API 和鉴权          | ✓                | **✓**             | 需在同步层重新表达 |
| 渐进接入                     | –                | **✓**             | 难                |
| 离线写入 / 多人实时协作      | ✗                | ✗                 | ✓                 |

### 非目标

local-replica 刻意**不做**离线写入队列、冲突合并（CRDT / OT），也不做服务端变更的实时推送。正是放弃了这些能力，后端才能保持不动。如果你的产品是围绕多人协同编辑或离线创作来构建的，同步引擎才是合适的工具。

## 安装

```bash
npm i local-replica
```

`react`（`useSync` 需要）和 `zustand` 是可选的 peer 依赖，只有 `local-replica/zustand` 需要它们。核心入口与框架无关。

## 分层

| 入口                    | 职责                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local-replica`         | 核心引擎，与框架无关：资源定义、纯 reducer、分页（offset / cursor，向前 / 向后）、实体关联、串行化持久化、存储适配器（见[存储](#存储)）。                          |
| `local-replica/zustand` | Zustand 适配器：把资源绑定到领域 store 中的某个位置（`recordLens`）。提供 `useSync` hook，通过 `ReplicaSyncDriver` 调度请求（SWR 用 `createSWRDriver`）。          |

宿主 store 始终是 UI 唯一的数据源，组件照常用 selector 读取 store。`useSync` 只返回请求状态（`isHydrated`、`isValidating`、`error`、`revalidate`），从不返回数据。

## 快速开始

```ts
import { definePagedReplica, KeyValueReplicaStorage } from 'local-replica';
import { createReplicaSlice, createSWRDriver, recordLens } from 'local-replica/zustand';

const topicList = definePagedReplica<Params, Topic, number, TopicPage>({
  key: ({ agentId }) => `agent_${agentId}`,
  name: 'topicList',
  paging: { direction: 'forward', getId: (t) => t.id, mode: 'offset', persist: { pages: 1 } },
  query: ({ sortBy }) => ({ sortBy }), // key 之外的查询标识
  scope, // ReplicaScope: { get, use, canPersist }
  storage: (namespace) => new KeyValueReplicaStorage({ namespace, store }), // 见「存储」
  version: 1,
});

const slice = createReplicaSlice(topicList, {
  driver: createSWRDriver({ mutate, useSWR }),
  fetcher: fetchTopicPage, // (params, cursor) => { items, total?, nextCursor? }
  get,
  set,
  stateKey: 'topicListReplica', // 记账用的 slot：createReplicaState()
  view: recordLens('topicDataMap'), // 渲染值所在的位置
});

slice.useSync(params); // 在组件中：先 hydrate，再同步
slice.loadMore(key);
slice.optimistic(key, apply, serverCall);
```

持久化读取是异步的，所以只靠 `useSync` hydrate 的列表，在冷启动时会先显示几帧 loading。如果这个列表必须无骨架屏绘制，就在路由提交之前从 route loader 里预先填充：`slice.ensureScope(scope)` + `slice.hydrate(params, scope)`，并用 `settleWithin(hydrate, ms)` 设上限，避免存储卡住时拖住路由。slot 填充之后，后续 `useSync` 的 hydrate 不会再执行。

持久化行只在值变化时才会重写：如果要持久化的值与引擎上次写入（或 hydrate 读出）的值深度相等，就跳过写入，所以一次没有变化的重新校验不产生存储写入。写入失败、删除、实体 patch、淘汰或 `clear()` 之后，引擎会忘记该行的内容，下一次持久化会重新写入。引擎只追踪自己的写入：如果某行在它背后被修改了（比如另一个标签页），会在下一次值变化或下一次会话时得到纠正。

## 使用指南

### 存储

资源可以通过任意 `ReplicaStorage`（`get` / `getStrict` / `set` / `remove`；失败约定见[失效](#失效)）持久化。包内自带两个适配器，key 格式都是 `<namespace>:<scope>:<queryKey>`：

| 适配器                       | 底层                                                                                         | 适用场景                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `KeyValueReplicaStorage`     | 任意异步 key-value 存储 `{ get, set, delete, initialize? }`：IndexedDB object store、走 IPC 的 SQLite… | 任意大小的列表和详情。行以对象形式存储，能克隆什么由存储自己决定。                            |
| `LocalStorageReplicaStorage` | 通过 codec 使用 `window.localStorage`（默认 JSON；需要 `Date`、`Map` 等可以传入 superjson 之类） | 必须在绘制前初始化阶段就渲染出来的小数据：`getSync(key)` 读取一行时不会让出帧。               |

两者在写入、删除失败时都会 reject，也都实现了 `getStrict`，所以所有破坏性操作都能在它们上面正常工作。在浏览器之外，`LocalStorageReplicaStorage` 始终返回未命中，不做任何操作。

### 没有挂载视图时的请求

`slice.revalidate(key)` 只会重新执行已挂载的 `useSync` 查询。如果 store 在没有视图挂载时也需要数据，比如 hover 预取，或者在没有该列表的路由上执行写操作后刷新，就调用 `slice.fetch(params)`，不要手动调用服务再 `replace`：

```ts
const { applied, data, missing } = await slice.fetch(params); // 复用进行中的请求
await slice.fetch(params, { fresh: true }); // 写操作之后：发起新请求，并作废旧请求
```

所有头页响应，不管来自 `useSync` 还是 `fetch`，都经过同一条 settle 流水线。请求发出时会记录它的 scope、`clear()` 代数、条目的删除代数和查询条件。只要其中任何一项已经变化（切换身份、`clear()`、`remove` 或实体被裁剪、视图已切到另一个查询），或者该条目已经应用了更新的响应，这个响应就会被丢弃。否则用 `replace` 合并进去；`isMissing` 的响应会删除条目，而在 store 已离开的 scope 下捕获的 `isMissing` 响应，则改为清除那个 scope 的行。`fetch` resolve 为 `{ applied, data, missing }`，请求失败时 reject。

- **去重**：`fetch` 会复用同一条目上进行中的请求，不管它是由 `useSync` 还是另一次 `fetch` 发起的。请求只 settle 一次，所以 effect 不会执行两次。`{ fresh: true }` 会发起新请求并作废旧请求，因为旧请求可能还带着写操作之前的值。
- **捕获 scope**：从先前响应展开的流程（比如预热时为拿到的根节点再请求回复）会传入开始时捕获的 `{ scope }`，之后每一步都 settle 到那个 scope。一旦该 scope 不再是当前 scope，`fetch` 会以 `ReplicaScopeChangedError` reject 且不发请求，否则这个请求会以旧身份的名义读取新身份的数据。
- **Driver 缓存**：`fetch` 应用响应后，会把数据写入 driver 在 sync key 下的缓存（`driver.seed`；对 SWR 来说是 `mutate(key, data, { revalidate: false })`）。如果该 key 有 `useSync` 请求正在进行，就跳过这次写入：SWR 会丢弃被写入抢先的进行中请求，此时写入会导致那个请求更新的响应被丢掉。之后再挂载时 SWR 仍然会重新校验，除非 sync 设置了 `revalidateIfStale: false`。值已经在 store 里了，那次重新校验只是确认它。
- **Effects**：每个响应都需要的副作用，放在 slice 上，不要放在某个视图的回调里：

  ```ts
  createReplicaSlice(resource, {
    effects: {
      onSettled: (data, params, ctx) => {}, // 每个成功的响应，包括被守卫丢弃的
      onApplied: (data, params, ctx) => {}, // 已合并进当前 scope
      onMissing: (params, ctx) => {}, // `isMissing`，已从当前 scope 删除
      onPurge: (params, ctx) => {}, // 在已离开的 scope 下捕获的 `isMissing`
      onError: (error, params, { isActive, key, scope }) => {},
    },
    isMissing: (data) => data === null,
    // …
  });
  ```

  它们对 `useSync` 和 `fetch` 的响应同样生效。`onSettled` 最先执行，并且对每个成功的响应都会执行，所以即使响应最终没有被合并，按请求维护的记账状态也能被释放。即使 hook 已经切到另一个 key、driver 跳过了它的回调，`useSync` 请求也会按自己的响应 settle。`useSync` 每次调用传入的 `onSuccess` / `onError` 仍然用于那一个视图的 UI 回调，hook 已经离开的 key 不会触发 `onSuccess`。

当展示数据的视图已经挂载、应该按它们自己的节奏重新请求时，用 `revalidate`。当调用方需要立即拿到数据、需要知道是否已应用，或者可能在没有任何视图挂载时运行，用 `fetch`。

### 失效

持久化行按条目 key **和**查询条件（`key?<query>`）分别保存，所以一个资源可以为同一个 key 保存多行。不要通过普通的 `set` 或清除 SWR key 来删除：持久化行还在，刷新后会把已删除的数据画出来。按"消失的是什么"选择对应的原语：

| 消失的是什么                                                          | 调用                                                           | 作用                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一个实体（删掉的话题、文件、记忆）                                    | `linkReplicaEntity(...).remove(id)` / `slice.removeEntity(id)` | 从所有已加载条目以及未加载条目的持久化行中删除它。之后 hydrate 出的值（哪怕是已经在路上的读取）都不会包含它，直到服务端的值再次包含它；如果持久化 patch 没有成功（scope 不可信、存储不可读），该守卫会在本次会话内一直保留。 |
| 一个条目 key，所有筛选 / 排序条件下的变体                              | `slice.remove(key)`                                            | 删除该条目及该 key 的所有持久化查询变体。在服务端针对该 key 的 `replace` 覆盖这次删除之前，任何变体都不会再被 hydrate。                                                                                   |
| 整个资源（"全部删除"、重置）                                           | `slice.clear()` / `linkReplicaEntity(...).clear()`             | 在一次提交中清空内存，删除当前 scope 的所有持久化行和索引，并丢弃在它之前发起的 hydrate 和 `useSync` 响应。存储清除完成后 resolve 为 `true`。                                                             |
| 某个已不是当前 scope 的整个资源（"全部删除"进行到一半时切换了账号）     | `slice.clearScope(scope)`                                      | 在本次会话已为该 scope 排队的写入之后，删除 `scope` 的所有持久化行和索引；内存（屏幕上另一个 scope 的数据）不受影响。对当前 scope 调用等同于 `clear()`。存储清除完成后 resolve 为 `true`。              |

`slice.updateEntity(id, (item) => undefined)` 也会把实体从已加载的值和持久化行中删除，但它只是一次普通 patch：只有 `removeEntity`（`linkReplicaEntity.remove` 和乐观 `'remove'` 调用的就是它）会拦截已经在路上的 hydrate。

`ReplicaStorage` 在删除没有成功时必须让 `remove` reject，并且必须实现 `getStrict`（I/O 失败时 reject 的读取），破坏性操作才能成功：`remove(key)` 的变体扫描、`clear()`、非当前 scope 的清除、未加载行的实体 patch 和淘汰都通过它读取，所以索引不可读时操作会失败，而不是当成空索引蒙混过去。没有 `getStrict` 的存储仍然可以 hydrate 和持久化，但所有破坏性操作都会失败：`clear()` resolve 为 `false`，删除保持未清除状态并会重试，实体守卫会保留。`get` 和 `set` 仍然是尽力而为。这时引擎会保留该行的索引、保留未完成的删除，下一次 `remove(key)` / `clear()` 会重试。

优先用范围最小的调用：删除实体会保留每个列表的其余部分；`remove(key)` 用于某个 key 的整个值都已不存在或被拒绝访问（NOT_FOUND / FORBIDDEN）；`clear()` 用于让用户在该资源下的所有数据都失效的流程。`clear()` 不会重新请求：已挂载的视图在下一次同步前会显示 loading，所以如果服务端仍有数据要显示，记得在它之后调用 `slice.revalidate()`。

### 限制持久化查询变体的数量

资源持久化的每个不同的 key + 查询条件都是独立的一行，所以如果资源的 key（或查询条件）是自由文本，比如搜索、市场筛选、按话题的数据包，存储就会随用户执行过的每一次查询不断增长。与其自己围绕 `remove` 手写一个最近使用窗口，不如开启上限：

```ts
const searchList = defineReplica<Params, Result>({
  key: ({ keyword }) => keyword,
  name: 'search',
  persist: { maxEntries: 20 }, // 每个 scope 最多持久化 20 行
  // …
});
```

- **计数方式**：按 scope 统计持久化的存储 key，每个 `key?query` 行计一次。
- **最近使用**：一次 hydrate、一次持久化，或者一次因值未变而跳过写入的重新校验，都会把该行标记为已使用。顺序保存在每个 scope 的索引中（最旧的在前），刷新后依然有效。由未设上限的旧版本建立索引的行，保持其追加顺序。
- **淘汰**：超出上限时淘汰最旧的行，包括该行本身、它的索引项，以及对应的内存条目。被淘汰的条目只是缓存未命中，再次访问时会重新请求；它不是删除，也不会像 `remove` 那样拦截 hydrate。
- **永不淘汰**：有已挂载 `useSync` 的行（挂载期间一直被固定）、有待提交乐观写入的条目、有 `loadMore` 进行中的条目。不通过 `useSync` 渲染条目的视图，可以用 `slice.retain(key, storageKey)` 固定它，返回值用于释放。
- **失败**：删除失败的行会保留在索引中，下次使用时再次被选中。索引不可读时（见 `getStrict`）不淘汰任何行。

### 对话记录等不规则分页

类消息资源按 cursor 向后分页，而且每次刷新时窗口长度都会变化。分页配置可以覆盖这些情况：

| 选项 / API                                                         | 用途                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `paging.isCursorable(item)`                                        | 在确定拼接锚点或推导 cursor 时跳过合成行（分组 / 摘要节点）。头页刷新时会按 id 替换头页里的合成行。          |
| `paging.deriveCursor(item)`                                        | 服务端不返回 `nextCursor` 的普通列表：下一个 cursor 由最旧的合格行推导。仅适用于位置信息无损的行。           |
| `paging.sort`                                                      | 稳定排序：比较结果相等的行保持服务端顺序。只比较位置。                                                       |
| `persistKey(key)`                                                  | 只保留在内存中的条目（不 hydrate、不持久化），例如按 scope 划分的桶。                                        |
| `slice.update(key, fn, { persist: false })` + `slice.persist(key)` | 先流式写入内存，再把确认后的值持久化一次。                                                                   |
| `splitPagedLens({ itemsField, metaField, derive })`                | 原始行放在读取方期望的位置，分页记账放在旁边，派生字段（解析后的展示列表）在同一次提交中更新。               |

`useSync(params, options)` 会把同步调度参数（`refreshInterval`、`dedupingInterval`、`revalidateIfStale`、`revalidateOnFocus` 等）转发给 driver，并在响应合并后执行 `onSuccess` / `onError` 副作用（资源级别的副作用应放在 slice 的 `effects` 中，见上文）。在没有网络的冷启动场景（离线或网络很慢）下，由于没有响应可供 `onSuccess` 处理，`onHydrated` 会基于 hydrate 绘制出的持久化值执行同样的"成功"逻辑。

## 许可证

[MIT](./LICENSE) © LobeHub
