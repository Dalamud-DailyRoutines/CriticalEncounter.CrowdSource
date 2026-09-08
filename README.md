# CriticalEncounter.CrowdSource

《最终幻想 XIV》特殊场景探索区域事件众包服务：由社区客户端上报各副本实例内紧急遭遇战与危命任务的发生记录，在网页上实时展示，并对外提供读取接口。

站点：<https://ce-crowdsource.atmoomen.top>

## 功能

- 按大区与副本实例查看各区域事件的上次发生时间，数据通过 WebSocket 实时推送。
- 收录蜃景幻界新月岛、天佑女王与禁地优雷卡共 8 个区域。
- 界面提供简体中文、日文、英文、德文、法文与韩文。
- 在互动地图中查看区域位置，一键复制区域事件信息。
- 提供订阅与快照接口，供第三方应用读取事件记录。

## 使用

1. 打开 <https://ce-crowdsource.atmoomen.top>，在顶部选择大区。
2. 在左侧选择副本实例 ID，获取方式见[如何获取副本实例 ID](web/public/assets/articles/0001_chs.md)。
3. 右侧按区域列出各事件的上次发生时间。点击区域可在互动地图中查看位置，点击操作列按钮可复制该区域的事件信息。

## 数据收录

`web/public/assets/data-centers.json` 收录国际服、国服与韩服的大区与服务器，暂不收录繁体中文服。`web/public/assets/dynamic-event-catalog.json` 按玩法与区域收录紧急遭遇战与危命任务目录，包含简体中文、日文、英文、德文、法文与韩文文本。

语言与客户端数据依据 [FFCafe XIVAPI 差异说明](https://xivapi-v2.xivcdn.com/zh-cn/docs/guides/difference/) 与 [FFCafe 字符串检索](https://strings.ffcafe.cn/) 整理。

## 外部调用

第三方应用可订阅区域并读取事件快照，接口说明与调用示例见[外部调用指引](web/public/assets/articles/0002_chs.md)（站内 `/articles/0002`），提供六种语言。订阅有效期 30 分钟，按响应中的 `renewAfter` 续订；每次请求支持同一大区的 1–32 个实例与区域组合，每个大区最多同时启用 64 个区域；订阅接口按来源 IP 在 Cloudflare 边缘限流为每分钟 10 次。

## 接口

- `POST /v1/reports`：接收插件上传的野外事件观察数据，单条事件通过 `eventType` 与 `eventID` 标识。
- `GET /v1/realtime/{dataCenterID}`：按大区建立 WebSocket 实时连接。
- `POST /v1/subscriptions`：按大区批量订阅或续订区域事件记录，返回快照地址与有效期。
- `GET /assets/sampling.json`：返回插件上传开关与大区采样率。
- `GET /health`：返回 Worker 运行状态与服务器时间。

## 开发

```shell
npm install
npm run check
npm run dev
```

`npm run deploy` 按 `wrangler.jsonc` 中的配置发布到 `ce-crowdsource.atmoomen.top`；仓库与 Cloudflare Worker 连接后，推送 `main` 触发构建。

服务由 Cloudflare Worker、Durable Objects SQLite、WebSocket 与 Static Assets 组成。事件快照存放在 R2 桶 `critical-encounter-snapshots`（绑定 `EVENT_SNAPSHOTS`），公开地址由 `SNAPSHOT_PUBLIC_URL` 配置。

## 许可

[MIT](LICENSE)
