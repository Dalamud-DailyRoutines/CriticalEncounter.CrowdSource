# CriticalEncounter.CrowdSource

特殊场景野外事件众包服务，使用 Cloudflare Worker、Durable Objects SQLite、WebSocket 与 Static Assets 提供观察数据接收和实时状态页面。

## 开发

```shell
npm install
npm run check
npm run dev
```

`npm run deploy` 使用 `wrangler.jsonc` 中的配置发布到 `ce-crowdsource.atmoomen.top`。GitHub 仓库与 Cloudflare Worker 连接后，推送 `main` 会触发构建。

`web/public/assets/sampling.json` 通过 Static Assets 免费分发上传开关、全局采样率上限与 Data Center 上限。客户端首次报告按确定性的 `0–15` 秒错峰，后续报告按 `0–59` 秒错峰；Worker 在边缘将 `90` 秒内同一实例、同一事件的报告合并为一次 Durable Object 请求。Durable Object 按每日 `70,000` 次上报请求和 `70,000` 行上报写入预算，统计每个 Data Center 的小时请求量与实际 SQL 写入行数，将持续报告目标动态调整为 `3`、`2` 或 `1` 个，已观测到单个报告者时保持 `100%` 采样率。该预算用于自适应采样；订阅、快照发布、清理和定时任务消耗单独预留的额度。

## 端点

- `POST /v1/reports`：接收插件上传的野外事件观察数据，单条事件通过 `eventType` 与 `eventID` 标识。
- `GET /v1/realtime/{dataCenterID}`：按 Data Center 建立 WebSocket 实时连接。
- `POST /v1/subscriptions`：按 Data Center 批量订阅或续订区域事件记录，返回公开快照地址与有效期。
- `GET /assets/sampling.json`：返回插件上传开关与 Data Center 采样率。
- `GET /health`：返回 Worker 运行状态和服务器时间。

## 外部读取

[外部调用指引](web/public/assets/articles/0002_chs.md) 对应站内 `/articles/0002`，提供六种语言的接口说明和调用示例。订阅有效期为 `30` 分钟，调用方按照响应中的 `renewAfter` 每 `15` 分钟续订。每次请求支持同一 Data Center 的 `1–32` 个区域，每个 Data Center 最多同时启用 `64` 个区域。订阅接口按来源 IP 在 Cloudflare 边缘限流为每分钟 `10` 次；区域有效期共享，提前重复续订沿用原有效期。

每份快照包含区域内各事件最近一次已观测发生时间，保留当前实例轨迹的分组。新事件、时间修正、实例重置和记录清理推进快照版本。阶段变化、来源数量和重复上报沿用原快照。订阅到期后暂停发布，再次启用时生成当前快照。`snapshotURL` 的数据新鲜度以订阅有效期为界，调用方应在到期前续订。

上报处理直接生成待发布快照，SQLite 保存待发布内容和发布版本，同一区域按顺序写入 R2；失败发布按 `5–300` 秒退避，由 Durable Object alarm 重试。每次内容更新通常增加一行待发布写入和一行发布确认写入，续订按共享有效期增加一行写入。小时清理会同步刷新仍在订阅的区域。快照请求直接访问 R2 自定义域名，CDN 缓存 `30` 秒，浏览器重新验证缓存。

## R2 配置

`wrangler.jsonc` 将 `EVENT_SNAPSHOTS` 绑定到 `critical-encounter-snapshots`，公开地址由 `SNAPSHOT_PUBLIC_URL` 配置，默认 `https://ce-data.atmoomen.top`。

```shell
wrangler r2 bucket create critical-encounter-snapshots
wrangler r2 bucket domain add critical-encounter-snapshots --domain ce-data.atmoomen.top --zone-id <ZONE_ID> --min-tls 1.2
wrangler r2 bucket cors set critical-encounter-snapshots --file r2-cors.json
```

快照路径使用 Cloudflare 默认支持缓存的 `.json.js` 扩展名，响应类型为 `application/json`，源站设置 `s-maxage=30`。订阅响应中的读取地址包含版本参数，使新订阅获取已发布的数据；调用方原样复用返回地址。浏览器示例使用 `cache: "no-cache"`，避免站点级 Browser Cache TTL 延长本地缓存时间。域名直接关联 R2，Worker 路由覆盖主站域名。发布前确认 R2 域名、证书和 CORS 生效，再执行 `npm run deploy -- --outdir dist`。

## 数据目录

`web/public/assets/data-centers.json` 收录国际服、国服和韩服的 Data Center 与 World，繁体中文服暂不收录。`web/public/assets/dynamic-event-catalog.json` 按 `gameplays`（特殊场景玩法）和 `areas`（玩法内的区域）收录紧急遭遇战与危命任务目录，包含简体中文、日文、英文、德文、法文和韩文文本。每个区域通过 `gameplay` 字段归属到一个玩法，新增玩法时在 `gameplays` 数组补充 `code`、`iconID` 与 `localizedNames`，再让对应区域的 `gameplay` 指向该 `code`。

语言与客户端数据依据 [FFCafe XIVAPI 差异说明](https://xivapi-v2.xivcdn.com/zh-cn/docs/guides/difference/) 和 [FFCafe 字符串检索](https://strings.ffcafe.cn/) 整理。
