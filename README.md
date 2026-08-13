# CriticalEncounter.CrowdSource

特殊场景野外事件众包服务，使用 Cloudflare Worker、Durable Objects SQLite、WebSocket 与 Static Assets 提供观察数据接收和实时状态页面。

## 开发

```shell
npm install
npm run check
npm run dev
```

`npm run deploy` 使用 `wrangler.jsonc` 中的配置发布到 `ce-crowdsource.atmoomen.top`。GitHub 仓库与 Cloudflare Worker 连接后，推送 `main` 会触发构建。

`web/public/assets/sampling.json` 通过 Static Assets 免费分发上传开关、全局采样率上限与 Data Center 上限。客户端首次报告按确定性的 `0–15` 秒错峰，后续报告按 `0–59` 秒错峰；Worker 在边缘将 `90` 秒内同一实例、同一事件的报告合并为一次 Durable Object 请求，Durable Object 按 `70,000` 次日请求预算统计每个 Data Center 的小时请求量，并将持续报告目标动态调整为 `3`、`2` 或 `1` 个，已观测到单个报告者时保持 `100%` 采样率。

## 端点

- `POST /v1/reports`：接收插件上传的野外事件观察数据，单条事件通过 `eventType` 与 `eventID` 标识。
- `GET /v1/realtime/{dataCenterID}`：按 Data Center 建立 WebSocket 实时连接。
- `GET /assets/sampling.json`：返回插件上传开关与 Data Center 采样率。
- `GET /health`：返回 Worker 运行状态和服务器时间。

## 数据目录

`web/public/assets/data-centers.json` 收录国际服、国服和韩服的 Data Center 与 World，繁体中文服暂不收录。`web/public/assets/dynamic-event-catalog.json` 按 `gameplays`（特殊场景玩法）和 `areas`（玩法内的区域）收录紧急遭遇战与危命任务目录，包含简体中文、日文、英文、德文、法文和韩文文本。每个区域通过 `gameplay` 字段归属到一个玩法，新增玩法时在 `gameplays` 数组补充 `code`、`iconID` 与 `localizedNames`，再让对应区域的 `gameplay` 指向该 `code`。

语言与客户端数据依据 [FFCafe XIVAPI 差异说明](https://xivapi-v2.xivcdn.com/zh-cn/docs/guides/difference/) 和 [FFCafe 字符串检索](https://strings.ffcafe.cn/) 整理。
