import type { Env, EventHistory, EventHistorySnapshot, EventSubscription } from "./models";

interface SubscriptionRow extends Record<string, SqlStorageValue> {
  instance_id: number;
  territory_id: number;
  expires_at: number;
  content_json: string;
  revision: string;
  updated_at: number;
  published_revision: string;
  retry_at: number;
  failures: number;
}

export class EventSnapshots {
  private readonly subscriptions = new Map<string, SubscriptionRow>();
  private readonly publishing = new Map<string, Promise<void>>();

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS event_subscription
      (
        instance_id INTEGER NOT NULL,
        territory_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        revision TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        published_revision TEXT NOT NULL DEFAULT '',
        retry_at INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (instance_id, territory_id)
      ) WITHOUT ROWID
    `);
    const now = Math.floor(Date.now() / 1000);
    for (const row of ctx.storage.sql.exec<SubscriptionRow>(
      "SELECT * FROM event_subscription WHERE expires_at >= ?", now - 86_400
    ))
      this.subscriptions.set(`${row.instance_id}:${row.territory_id}`, row);
  }

  get activeHistories(): EventHistory[] {
    const now = Math.floor(Date.now() / 1000);
    return [...this.subscriptions.values()]
      .filter(row => row.expires_at > now)
      .map(row => JSON.parse(row.content_json) as EventHistory);
  }

  get nextRetryAt(): number | undefined {
    const now = Math.floor(Date.now() / 1000);
    const pending = [...this.subscriptions.values()].filter(row =>
      row.expires_at > now && row.revision !== row.published_revision && !this.publishing.has(`${row.instance_id}:${row.territory_id}`)
    );
    return pending.length > 0 ? Math.min(...pending.map(row => Math.max(now + 1, row.retry_at))) * 1000 : undefined;
  }

  isActive(instanceID: number, territoryID: number, now: number): boolean {
    return (this.subscriptions.get(`${instanceID}:${territoryID}`)?.expires_at ?? 0) > now;
  }

  async renew(histories: EventHistory[], now: number): Promise<EventSubscription[] | undefined> {
    const activeKeys = new Set([...this.subscriptions.entries()]
      .filter(([, row]) => row.expires_at > now).map(([key]) => key));
    for (const history of histories)
      activeKeys.add(`${history.instanceID}:${history.territoryID}`);
    if (activeKeys.size > 64) return undefined;

    const rows: SubscriptionRow[] = [];
    for (const history of histories) {
      const key = `${history.instanceID}:${history.territoryID}`;
      let row = this.subscriptions.get(key);
      if (!row || row.expires_at <= now) {
        const values: SubscriptionRow = {
          instance_id: history.instanceID,
          territory_id: history.territoryID,
          expires_at: now + 1800,
          content_json: JSON.stringify(history),
          revision: crypto.randomUUID(),
          updated_at: now,
          published_revision: "",
          retry_at: 0,
          failures: 0
        };
        this.ctx.storage.sql.exec(
          `INSERT INTO event_subscription
           (instance_id, territory_id, expires_at, content_json, revision, updated_at, published_revision, retry_at, failures)
           VALUES (?, ?, ?, ?, ?, ?, '', 0, 0)
           ON CONFLICT(instance_id, territory_id) DO UPDATE SET
             expires_at = excluded.expires_at, content_json = excluded.content_json,
             revision = excluded.revision, updated_at = excluded.updated_at,
             published_revision = '', retry_at = 0, failures = 0`,
          values.instance_id, values.territory_id, values.expires_at,
          values.content_json, values.revision, values.updated_at
        );
        if (row)
          Object.assign(row, values);
        else {
          row = values;
          this.subscriptions.set(key, row);
        }
      } else {
        this.stage(history, now);
        if (row.expires_at - now <= 900) {
          const expiresAt = now + 1800;
          this.ctx.storage.sql.exec(
            "UPDATE event_subscription SET expires_at = ? WHERE instance_id = ? AND territory_id = ?",
            expiresAt, row.instance_id, row.territory_id
          );
          row.expires_at = expiresAt;
        }
      }
      rows.push(row);
    }

    await this.flush();
    if (rows.some(row => row.revision !== row.published_revision))
      throw new Error("Snapshot publication is pending");
    return rows.map(row => {
      const history = JSON.parse(row.content_json) as EventHistory;
      const path = `/v1/events/${history.dataCenterID}/${row.instance_id}/${row.territory_id}.json.js`;
      const snapshotURL = new URL(path, this.env.SNAPSHOT_PUBLIC_URL);
      snapshotURL.searchParams.set("revision", row.revision);
      return {
        instanceID: row.instance_id,
        territoryID: row.territory_id,
        snapshotURL: snapshotURL.href,
        revision: row.revision,
        expiresAt: row.expires_at,
        renewAfter: row.expires_at - 900
      };
    });
  }

  stage(history: EventHistory, now: number): void {
    const row = this.subscriptions.get(`${history.instanceID}:${history.territoryID}`);
    if (!row || row.expires_at <= now) return;
    const content = JSON.stringify(history);
    if (row.content_json === content) return;
    const revision = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `UPDATE event_subscription SET content_json = ?, revision = ?, updated_at = ?
       WHERE instance_id = ? AND territory_id = ?`,
      content, revision, now, row.instance_id, row.territory_id
    );
    row.content_json = content;
    row.revision = revision;
    row.updated_at = now;
  }

  async flush(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const pending: Promise<void>[] = [];
    for (const [key, row] of this.subscriptions) {
      if (row.expires_at <= now || row.revision === row.published_revision) continue;
      let task = this.publishing.get(key);
      if (!task && row.retry_at <= now) {
        task = this.publish(row).finally(() => this.publishing.delete(key));
        this.publishing.set(key, task);
      }
      if (task) pending.push(task);
    }
    try {
      await Promise.all(pending);
    } finally {
      const nextRetryAt = this.nextRetryAt;
      if (nextRetryAt !== undefined) {
        const alarm = await this.ctx.storage.getAlarm();
        if (alarm === null || alarm > nextRetryAt)
          await this.ctx.storage.setAlarm(nextRetryAt);
      }
    }
  }

  prune(now: number): void {
    this.ctx.storage.sql.exec("DELETE FROM event_subscription WHERE expires_at < ?", now - 86_400);
    for (const [key, row] of this.subscriptions) {
      if (row.expires_at < now - 86_400 && !this.publishing.has(key))
        this.subscriptions.delete(key);
    }
  }

  private async publish(row: SubscriptionRow): Promise<void> {
    while (row.expires_at > Math.floor(Date.now() / 1000) && row.revision !== row.published_revision) {
      const revision = row.revision;
      const snapshot: EventHistorySnapshot = {
        ...JSON.parse(row.content_json) as EventHistory,
        revision,
        updatedAt: row.updated_at
      };
      try {
        await this.env.EVENT_SNAPSHOTS.put(
          `v1/events/${snapshot.dataCenterID}/${row.instance_id}/${row.territory_id}.json.js`,
          JSON.stringify(snapshot),
          { httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "public, max-age=0, s-maxage=30, must-revalidate" } }
        );
      } catch (error) {
        const failures = row.failures + 1;
        const retryAt = Math.floor(Date.now() / 1000) + Math.min(300, 5 * 2 ** Math.min(failures - 1, 6));
        this.ctx.storage.sql.exec(
          "UPDATE event_subscription SET retry_at = ?, failures = ? WHERE instance_id = ? AND territory_id = ?",
          retryAt, failures, row.instance_id, row.territory_id
        );
        row.failures = failures;
        row.retry_at = retryAt;
        console.error(JSON.stringify({ event: "snapshot.publish_failed", instanceID: row.instance_id, territoryID: row.territory_id, error: String(error) }));
        return;
      }
      this.ctx.storage.sql.exec(
        "UPDATE event_subscription SET published_revision = ?, retry_at = 0, failures = 0 WHERE instance_id = ? AND territory_id = ?",
        revision, row.instance_id, row.territory_id
      );
      row.published_revision = revision;
      row.retry_at = 0;
      row.failures = 0;
    }
  }
}
