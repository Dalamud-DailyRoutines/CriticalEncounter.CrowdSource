import { DurableObject } from "cloudflare:workers";
import { DATA_CENTERS, getAreaForTerritory, getTrackResetWindowSeconds, type EventArea } from "../catalog";
import { countTrackCEMatches, hasTrackConflict, haveTrackCEMatch, haveTrackConflict } from "../instanceTrackRules";
import { EventSnapshots } from "../eventSnapshots";
import { jsonError } from "../validation";
import type {
  DurableEventState,
  DurableAreaTrackCollection,
  DurableInstanceState,
  DurableInstanceTrackState,
  Env,
  EventHistory,
  InstanceExpiredMessage,
  InstanceUpdatedMessage,
  NormalizedReport,
  ReportResponse,
  ReportResult,
  ReportEvent,
  SnapshotInstance,
  SnapshotInstanceTrack,
  SnapshotResponse,
  SubscriptionRequest
} from "../models";

interface InstanceRow extends Record<string, SqlStorageValue> {
  zone_server_id: number;
  instance_epoch: number;
  revision: number;
  last_received_at: number;
  event_last_seen_json: string;
  area_tracks_json: string | null;
  updated_at: number;
}

interface ColumnRow extends Record<string, SqlStorageValue> {
  name: string;
}

interface RevisionRow extends Record<string, SqlStorageValue> {
  revision: number;
}

interface CountRow extends Record<string, SqlStorageValue> {
  count: number;
}

interface ActivityWindowRow extends Record<string, SqlStorageValue> {
  instance_count: number;
}

interface RequestWindowRow extends Record<string, SqlStorageValue> {
  request_count: number;
  rows_written: number;
}

interface Metrics {
  accepted: number;
  duplicate: number;
  invalid: number;
  stale: number;
}

const TRACK_ACTIVE_WINDOW_SECONDS = 20 * 60;
const INSTANCE_EPOCH_GAP_SECONDS = 3_600;
const INSTANCE_RETENTION_SECONDS = 86_400;

export class DataCenterState extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly eventSnapshots: EventSnapshots;
  private dataCenterID = 0;
  private revision = 0;
  private metrics: Metrics = { accepted: 0, duplicate: 0, invalid: 0, stale: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS instance_state
      (
        zone_server_id INTEGER NOT NULL,
        instance_epoch INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        last_received_at INTEGER NOT NULL,
        ce_last_seen_json TEXT NOT NULL,
        area_tracks_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (zone_server_id)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS daily_metrics
      (
        day TEXT NOT NULL,
        accepted INTEGER NOT NULL,
        duplicate INTEGER NOT NULL,
        invalid INTEGER NOT NULL,
        stale INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (day)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS activity_window
      (
        window_started_at INTEGER NOT NULL,
        reporter_count INTEGER NOT NULL,
        instance_count INTEGER NOT NULL,
        PRIMARY KEY (window_started_at)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS reporter_instance_window
      (
        window_started_at INTEGER NOT NULL,
        zone_server_id INTEGER NOT NULL,
        reporter_epoch_id TEXT NOT NULL,
        PRIMARY KEY (window_started_at, zone_server_id, reporter_epoch_id)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS instance_window
      (
        window_started_at INTEGER NOT NULL,
        zone_server_id INTEGER NOT NULL,
        PRIMARY KEY (window_started_at, zone_server_id)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS reporter_instance_count
      (
        window_started_at INTEGER NOT NULL,
        zone_server_id INTEGER NOT NULL,
        reporter_count INTEGER NOT NULL,
        PRIMARY KEY (window_started_at, zone_server_id)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS request_window
      (
        window_started_at INTEGER NOT NULL,
        request_count INTEGER NOT NULL,
        rows_written INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (window_started_at)
      ) WITHOUT ROWID;
    `);

    const instanceColumns = Array.from(this.sql.exec<ColumnRow>("PRAGMA table_info(instance_state)"));
    if (!instanceColumns.some(column => column.name === "area_tracks_json"))
      this.sql.exec("ALTER TABLE instance_state ADD COLUMN area_tracks_json TEXT NOT NULL DEFAULT '{}'");

    const requestColumns = Array.from(this.sql.exec<ColumnRow>("PRAGMA table_info(request_window)"));
    if (!requestColumns.some(column => column.name === "rows_written"))
      this.sql.exec("ALTER TABLE request_window ADD COLUMN rows_written INTEGER NOT NULL DEFAULT 0");

    this.eventSnapshots = new EventSnapshots(ctx, env);
    ctx.waitUntil(this.eventSnapshots.flush());

    const revisionRows = Array.from(this.sql.exec<RevisionRow>("SELECT COALESCE(MAX(revision), 0) AS revision FROM instance_state"));
    this.revision = revisionRows[0]?.revision ?? 0;

    ctx.blockConcurrencyWhile(async () => {
      if (await ctx.storage.getAlarm() === null)
        await ctx.storage.setAlarm(this.getNextAlarm());
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/internal/reports" && request.method === "POST")
      return this.processReport(request);

    if (url.pathname === "/internal/subscriptions" && request.method === "POST")
      return this.subscribe(request);

    if (url.pathname.startsWith("/internal/realtime/") && request.headers.get("upgrade")?.toLowerCase() === "websocket")
      return this.acceptRealtime(request, url);

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const day = new Date(now * 1000).toISOString().slice(0, 10);

    this.sql.exec(
      `INSERT INTO daily_metrics (day, accepted, duplicate, invalid, stale, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         accepted = accepted + excluded.accepted,
         duplicate = duplicate + excluded.duplicate,
         invalid = invalid + excluded.invalid,
         stale = stale + excluded.stale,
         updated_at = excluded.updated_at`,
      day,
      this.metrics.accepted,
      this.metrics.duplicate,
      this.metrics.invalid,
      this.metrics.stale,
      now
    );

    this.metrics = { accepted: 0, duplicate: 0, invalid: 0, stale: 0 };
    this.sql.exec("DELETE FROM instance_state WHERE last_received_at < ?", now - INSTANCE_RETENTION_SECONDS);
    const oldestWindow = Math.floor((now - INSTANCE_RETENTION_SECONDS) / 3600) * 3600;
    this.sql.exec("DELETE FROM reporter_instance_window WHERE window_started_at < ?", oldestWindow);
    this.sql.exec("DELETE FROM reporter_instance_count WHERE window_started_at < ?", oldestWindow);
    this.sql.exec("DELETE FROM instance_window WHERE window_started_at < ?", oldestWindow);
    this.sql.exec("DELETE FROM activity_window WHERE window_started_at < ?", oldestWindow);
    this.sql.exec("DELETE FROM request_window WHERE window_started_at < ?", oldestWindow);
    this.sql.exec("DELETE FROM daily_metrics WHERE day < ?", new Date((now - 7 * 86_400) * 1000).toISOString().slice(0, 10));
    this.eventSnapshots.prune(now);
    for (const history of this.eventSnapshots.activeHistories) {
      const state = this.loadInstance(history.instanceID);
      this.eventSnapshots.stage(this.createEventHistory(history.dataCenterID, history.instanceID, history.territoryID, state), now);
    }
    await this.eventSnapshots.flush();
    await this.ctx.storage.setAlarm(this.getNextAlarm());
  }

  async webSocketMessage(webSocket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);

    try {
      const payload = JSON.parse(text) as { type?: string };
      if (payload.type === "resync") {
        const attachment = webSocket.deserializeAttachment() as { dataCenterID: number; lastResyncAt: number };
        const now = Date.now();
        if (now - attachment.lastResyncAt < 30_000) return;
        this.dataCenterID = attachment.dataCenterID;
        webSocket.serializeAttachment({ ...attachment, lastResyncAt: now });
        webSocket.send(JSON.stringify(this.createSnapshot()));
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "websocket.invalid_message", error: String(error) }));
      webSocket.send(JSON.stringify({ type: "error", code: "invalid_message" }));
    }
  }

  async webSocketError(webSocket: WebSocket, error: unknown): Promise<void> {
    console.error(JSON.stringify({ event: "websocket.error", error: String(error) }));
    webSocket.close(1011, "realtime_error");
  }

  private async processReport(request: Request): Promise<Response> {
    const report = await request.json<NormalizedReport>();
    const requestID = request.headers.get("x-request-id") ?? crypto.randomUUID();
    this.dataCenterID = report.dataCenterID;
    const activityWindow = Math.floor(report.receivedAt / 3600) * 3600;
    let rowsWritten = this.updateActivityWindow(activityWindow, report.reporterEpochID, report.zoneServerID);

    const state = this.loadInstance(report.zoneServerID) ?? this.createInstanceState(report);

    if (state.lastReceivedAt > 0 && state.lastReceivedAt < report.receivedAt - INSTANCE_EPOCH_GAP_SECONDS)
      state.instanceEpoch++;

    const area = getAreaForTerritory(report.territoryID);
    const areaCode = area?.code ?? `territory-${report.territoryID}`;
    const areaTracks = this.getOrCreateAreaTracks(state, areaCode, report.receivedAt);
    const track = this.selectTrack(state, areaTracks, areaCode, report, report.receivedAt);
    const previousTrackLastReceivedAt = track.lastReceivedAt;
    track.lastReceivedAt = report.receivedAt;
    if (!track.sourceIDs.includes(report.reporterEpochID))
      track.sourceIDs.push(report.reporterEpochID);
    areaTracks.reporterTrackIDs[report.reporterEpochID] = track.trackID;

    let changed = previousTrackLastReceivedAt !== track.lastReceivedAt;
    const results: ReportResult[] = [];

    for (const event of report.events) {
      const result = this.mergeEvent(track.eventLastSeen, report, event);
      this.mergeEvent(state.eventLastSeen, report, event);
      if (result.changed)
        changed = true;
      if (result.status === "accepted") {
        this.metrics.accepted++;
      } else if (result.status === "stale") {
        this.metrics.stale++;
      } else {
        this.metrics.duplicate++;
      }
      results.push(this.createResult(event.eventType, event.eventID, event.spawnedAt, result.status));
    }

    state.lastReceivedAt = Math.max(state.lastReceivedAt, report.receivedAt);
    state.updatedAt = report.receivedAt;
    if (changed) {
      this.revision = Math.max(this.revision + 1, Date.now());
      state.revision = this.revision;
    }
    rowsWritten += this.saveInstance(state);
    const requestWindow = this.updateRequestWindow(activityWindow, rowsWritten);
    if (this.eventSnapshots.isActive(report.zoneServerID, report.territoryID, report.receivedAt)) {
      this.eventSnapshots.stage(this.createEventHistory(report.dataCenterID, report.zoneServerID, report.territoryID, state), report.receivedAt);
      this.ctx.waitUntil(this.eventSnapshots.flush());
    }

    for (const result of results) {
      if (result.revision === 0)
        result.revision = state.revision;
    }

    const message: InstanceUpdatedMessage = {
      type: "instance.updated",
      serverTime: report.receivedAt,
      dataCenterID: this.dataCenterID,
      revision: state.revision,
      instance: this.toSnapshotInstance(state, report.receivedAt)
    };
    this.broadcast(message);

    console.log(JSON.stringify({
      requestID,
      dataCenterID: report.dataCenterID,
      zoneServerID: report.zoneServerID,
      results: results.map(result => result.status)
    }));

    const activityRows = Array.from(this.sql.exec<ActivityWindowRow>(
      `SELECT instance_count FROM activity_window
       WHERE window_started_at = ?`,
      activityWindow
    ));
    const reporterRows = Array.from(this.sql.exec<CountRow>(
      `SELECT reporter_count AS count FROM reporter_instance_count
       WHERE window_started_at = ? AND zone_server_id = ?`,
      activityWindow,
      report.zoneServerID
    ));
    const activeReporterCount = Math.max(1, reporterRows[0]?.count ?? 1);
    const activeInstanceCount = Math.max(1, activityRows[0]?.instance_count ?? 1);
    const elapsedWindowSeconds = Math.max(300, report.receivedAt - activityWindow + 1);
    const reportRequestsPerHour = requestWindow.request_count * 3600 / elapsedWindowSeconds;
    const sqlRowsWrittenPerHour = requestWindow.rows_written * 3600 / elapsedWindowSeconds;
    const targetReporterCount = getTargetReporterCount(reportRequestsPerHour, sqlRowsWrittenPerHour);
    const samplingRate = Math.min(1, targetReporterCount / activeReporterCount);
    const response: ReportResponse = {
      requestID,
      serverTime: report.receivedAt,
      samplingRate,
      activeReporterCount,
      activeInstanceCount,
      targetReporterCount,
      reportRequestsPerHour,
      sqlRowsWrittenPerHour,
      results
    };
    return Response.json(response);
  }

  private async subscribe(request: Request): Promise<Response> {
    const body = await request.json<SubscriptionRequest>();
    const now = Math.floor(Date.now() / 1000);
    const states = new Map<number, DurableInstanceState>();
    const histories: EventHistory[] = [];
    for (const target of body.instances) {
      const state = states.get(target.instanceID) ?? this.loadInstance(target.instanceID);
      if (!state || state.lastReceivedAt < now - INSTANCE_RETENTION_SECONDS)
        return jsonError("instance_not_found", 404);
      states.set(target.instanceID, state);
      histories.push(this.createEventHistory(body.dataCenterID, target.instanceID, target.territoryID, state));
    }
    const subscriptions = await this.eventSnapshots.renew(histories, now);
    if (!subscriptions) {
      const response = jsonError("subscription_capacity_reached", 429);
      response.headers.set("retry-after", "900");
      return response;
    }
    return Response.json({ dataCenterID: body.dataCenterID, serverTime: now, subscriptions });
  }

  private createEventHistory(
    dataCenterID: number,
    instanceID: number,
    territoryID: number,
    state: DurableInstanceState | undefined
  ): EventHistory {
    const area = getAreaForTerritory(territoryID)!;
    const collection = state?.areaTracks[area.code];
    const tracks = collection ? this.toSnapshotTracks(collection) : [];
    return {
      schemaVersion: 1,
      dataCenterID,
      instanceID,
      territoryID,
      instanceEpoch: state?.instanceEpoch ?? 0,
      tracks: tracks.map(track => ({
        trackID: track.trackID,
        events: area.events.map(event => ({
          eventType: event.eventType,
          eventID: event.eventID,
          lastSpawnedAt: track.eventLastSeen[`${territoryID}:${event.eventType}:${event.eventID}`]?.lastSpawnedAt ?? null
        }))
      }))
    };
  }

  private createInstanceState(report: NormalizedReport): DurableInstanceState {
    return {
      zoneServerID: report.zoneServerID,
      instanceEpoch: 1,
      revision: this.revision,
      lastReceivedAt: 0,
      eventLastSeen: {},
      areaTracks: {},
      updatedAt: report.receivedAt
    };
  }

  private getOrCreateAreaTracks(
    state: DurableInstanceState,
    areaCode: string,
    firstObservedAt: number
  ): DurableAreaTrackCollection {
    const existing = state.areaTracks[areaCode];
    if (existing)
      return existing;

    const trackID = `${areaCode}-1`;
    const eventLastSeen = Object.fromEntries(Object.entries(state.eventLastSeen).filter(([, event]) =>
      getAreaForTerritory(event.territoryID)?.code === areaCode
    ));
    const track: DurableInstanceTrackState = {
      trackID,
      ordinal: 1,
      firstObservedAt: firstObservedAt,
      lastReceivedAt: firstObservedAt,
      conflictDetectionStartedAt: firstObservedAt,
      conflictingTrackIDs: [],
      eventLastSeen,
      sourceIDs: []
    };
    const created: DurableAreaTrackCollection = {
      nextTrackOrdinal: 2,
      reporterTrackIDs: {},
      tracks: { [trackID]: track }
    };
    state.areaTracks[areaCode] = created;
    return created;
  }

  private selectTrack(
    state: DurableInstanceState,
    areaTracks: DurableAreaTrackCollection,
    areaCode: string,
    report: NormalizedReport,
    receivedAt: number
  ): DurableInstanceTrackState {
    const tracks = Object.values(areaTracks.tracks);
    const mappedTrackID = areaTracks.reporterTrackIDs[report.reporterEpochID];
    const area = getAreaForTerritory(report.territoryID);

    if (!area) {
      // Unknown territory: keep a single, never-splitting track.
      const mappedTrack = mappedTrackID
        ? tracks.find(track => track.trackID === mappedTrackID)
        : undefined;
      return mappedTrack ?? tracks[0] ?? this.createTrack(areaTracks, areaCode, receivedAt);
    }

    const resetWindowSeconds = getTrackResetWindowSeconds(area.gameplay);
    if (resetWindowSeconds <= 0) {
      // Gameplay that never splits into multiple tracks.
      const mappedTrack = mappedTrackID
        ? tracks.find(track => track.trackID === mappedTrackID)
        : undefined;
      return mappedTrack ?? tracks[0] ?? this.createTrack(areaTracks, areaCode, receivedAt);
    }

    const recentTracks = tracks.filter(track =>
      this.getTrackActivityAt(track) >= receivedAt - resetWindowSeconds
    );

    if (recentTracks.length === 0) {
      // No track seen recently: the instance ID was reclaimed and reused. Wipe
      // this area's tracks and instance-level events, then start fresh.
      this.resetAreaTrackCollection(areaTracks);
      this.rebuildAreaEventState(state, areaTracks, area);
      return this.createTrack(areaTracks, areaCode, receivedAt);
    }

    const recentTrackIDs = new Set(recentTracks.map(track => track.trackID));
    const staleTracks = tracks.filter(track => !recentTrackIDs.has(track.trackID));
    if (staleTracks.length > 0) {
      for (const track of staleTracks)
        delete areaTracks.tracks[track.trackID];
      this.pruneReporterTrackIDs(areaTracks);
      this.rebuildAreaEventState(state, areaTracks, area);
    }

    if (recentTracks.length === 1) {
      // A single recent track now represents this instance's copy: collapse to
      // it and renumber it back to ordinal 1.
      return this.renumberTrack(areaTracks, areaCode, recentTracks[0]);
    }

    // Two or more recent tracks coexist: keep them and route the report using
    // the existing CE-match + conflict logic (ordinals are left untouched).
    return this.routeTrack(areaTracks, areaCode, report, recentTracks, receivedAt);
  }

  private resetAreaTrackCollection(areaTracks: DurableAreaTrackCollection): void {
    areaTracks.tracks = {};
    areaTracks.reporterTrackIDs = {};
    areaTracks.nextTrackOrdinal = 1;
  }

  private pruneReporterTrackIDs(areaTracks: DurableAreaTrackCollection): void {
    for (const [reporterEpochID, trackID] of Object.entries(areaTracks.reporterTrackIDs)) {
      if (!areaTracks.tracks[trackID])
        delete areaTracks.reporterTrackIDs[reporterEpochID];
    }
  }

  private renumberTrack(
    areaTracks: DurableAreaTrackCollection,
    areaCode: string,
    track: DurableInstanceTrackState
  ): DurableInstanceTrackState {
    const previousTrackID = track.trackID;
    const newTrackID = `${areaCode}-1`;
    if (previousTrackID !== newTrackID) {
      delete areaTracks.tracks[previousTrackID];
      track.trackID = newTrackID;
      areaTracks.tracks[newTrackID] = track;
      for (const [reporterEpochID, trackID] of Object.entries(areaTracks.reporterTrackIDs)) {
        if (trackID === previousTrackID)
          areaTracks.reporterTrackIDs[reporterEpochID] = newTrackID;
      }
    }
    track.ordinal = 1;
    track.conflictingTrackIDs = [];
    areaTracks.nextTrackOrdinal = 2;
    return track;
  }

  private rebuildAreaEventState(
    state: DurableInstanceState,
    areaTracks: DurableAreaTrackCollection,
    area: EventArea
  ): void {
    for (const key of Object.keys(state.eventLastSeen)) {
      if (Number(key.split(":")[0]) === area.territoryID)
        delete state.eventLastSeen[key];
    }
    for (const track of Object.values(areaTracks.tracks)) {
      for (const [key, event] of Object.entries(track.eventLastSeen)) {
        if (Number(key.split(":")[0]) !== area.territoryID)
          continue;
        const current = state.eventLastSeen[key];
        if (!current || event.lastSpawnedAt > current.lastSpawnedAt)
          state.eventLastSeen[key] = { ...event, sourceIDs: [...event.sourceIDs] };
      }
    }
  }

  private routeTrack(
    areaTracks: DurableAreaTrackCollection,
    areaCode: string,
    report: NormalizedReport,
    tracks: DurableInstanceTrackState[],
    receivedAt: number
  ): DurableInstanceTrackState {
    const mappedTrackID = areaTracks.reporterTrackIDs[report.reporterEpochID];
    const mappedTrack = mappedTrackID
      ? tracks.find(track => track.trackID === mappedTrackID)
      : undefined;

    const matchingTracks = tracks
      .map(track => ({ track, matches: countTrackCEMatches(track, report.events, report.territoryID) }))
      .filter(item => item.matches > 0)
      .sort((left, right) => right.matches - left.matches || right.track.lastReceivedAt - left.track.lastReceivedAt);
    if (matchingTracks.length > 0)
      return matchingTracks[0].track;

    if (mappedTrack && !hasTrackConflict(mappedTrack, report.events, report.territoryID))
      return mappedTrack;

    const conflictingTracks = tracks.filter(track => hasTrackConflict(track, report.events, report.territoryID));
    const compatibleTracks = tracks
      .filter(track => !conflictingTracks.includes(track))
      .sort((left, right) => right.lastReceivedAt - left.lastReceivedAt);
    const selectedTrack = compatibleTracks[0] ?? this.createTrack(areaTracks, areaCode, receivedAt);

    for (const conflictingTrack of conflictingTracks) {
      if (conflictingTrack.trackID === selectedTrack.trackID)
        continue;
      if (!conflictingTrack.conflictingTrackIDs.includes(selectedTrack.trackID))
        conflictingTrack.conflictingTrackIDs.push(selectedTrack.trackID);
      if (!selectedTrack.conflictingTrackIDs.includes(conflictingTrack.trackID))
        selectedTrack.conflictingTrackIDs.push(conflictingTrack.trackID);
    }

    return selectedTrack;
  }

  private createTrack(
    areaTracks: DurableAreaTrackCollection,
    areaCode: string,
    firstObservedAt: number
  ): DurableInstanceTrackState {
    const ordinal = areaTracks.nextTrackOrdinal++;
    const trackID = `${areaCode}-${ordinal}`;
    const track: DurableInstanceTrackState = {
      trackID,
      ordinal,
      firstObservedAt,
      lastReceivedAt: firstObservedAt,
      conflictDetectionStartedAt: firstObservedAt,
      conflictingTrackIDs: [],
      eventLastSeen: {},
      sourceIDs: []
    };
    areaTracks.tracks[trackID] = track;
    return track;
  }

  private mergeEvent(
    eventLastSeen: Record<string, DurableEventState>,
    report: NormalizedReport,
    event: ReportEvent
  ): { status: "accepted" | "duplicate" | "stale"; changed: boolean } {
    const key = `${report.territoryID}:${event.eventType}:${event.eventID}`;
    const current = eventLastSeen[key];
    if (!current) {
      eventLastSeen[key] = this.createEventState(report, event);
      return { status: "accepted", changed: true };
    }

    if (event.spawnedAt > current.lastSpawnedAt) {
      eventLastSeen[key] = this.createEventState(report, event);
      return { status: "accepted", changed: true };
    }

    if (event.spawnedAt < current.lastSpawnedAt)
      return { status: "stale", changed: false };

    let changed = false;
    if (!current.sourceIDs.includes(report.reporterEpochID) && current.sourceCount === 1) {
      current.sourceIDs.push(report.reporterEpochID);
      current.sourceCount = 2;
      changed = true;
    }
    if (current.observedState !== event.observedState) {
      current.observedState = event.observedState;
      changed = true;
    }
    return { status: "duplicate", changed };
  }

  private createEventState(report: NormalizedReport, event: ReportEvent): DurableEventState {
    return {
      territoryID: report.territoryID,
      eventType: event.eventType,
      eventID: event.eventID,
      lastSpawnedAt: event.spawnedAt,
      firstReceivedAt: report.receivedAt,
      observedState: event.observedState,
      sourceCount: 1,
      sourceIDs: [report.reporterEpochID]
    };
  }

  private acceptRealtime(request: Request, url: URL): Response {
    const dataCenterID = Number(url.pathname.split("/").at(-1));
    if (Number.isSafeInteger(dataCenterID))
      this.dataCenterID = dataCenterID;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ dataCenterID: this.dataCenterID, lastResyncAt: Date.now() });
    server.send(JSON.stringify(this.createSnapshot()));

    return new Response(null, { status: 101, webSocket: client });
  }

  private loadInstance(zoneServerID: number): DurableInstanceState | undefined {
    const rows = Array.from(this.sql.exec<InstanceRow>(
      `SELECT zone_server_id, instance_epoch, revision, last_received_at,
              ce_last_seen_json AS event_last_seen_json, area_tracks_json, updated_at
       FROM instance_state WHERE zone_server_id = ?`,
      zoneServerID
    ));
    const row = rows[0];
    if (!row) return undefined;

    return {
      zoneServerID: row.zone_server_id,
      instanceEpoch: row.instance_epoch,
      revision: row.revision,
      lastReceivedAt: row.last_received_at,
      eventLastSeen: JSON.parse(row.event_last_seen_json) as Record<string, DurableEventState>,
      areaTracks: this.parseAreaTracks(row.area_tracks_json, row.event_last_seen_json, row.last_received_at),
      updatedAt: row.updated_at
    };
  }

  private saveInstance(state: DurableInstanceState): number {
    return this.sql.exec(
      `INSERT INTO instance_state
       (zone_server_id, instance_epoch, revision, last_received_at, ce_last_seen_json, area_tracks_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(zone_server_id) DO UPDATE SET
         instance_epoch = excluded.instance_epoch,
         revision = excluded.revision,
         last_received_at = excluded.last_received_at,
         ce_last_seen_json = excluded.ce_last_seen_json,
         area_tracks_json = excluded.area_tracks_json,
         updated_at = excluded.updated_at`,
      state.zoneServerID,
      state.instanceEpoch,
      state.revision,
      state.lastReceivedAt,
      JSON.stringify(state.eventLastSeen),
      JSON.stringify(state.areaTracks),
      state.updatedAt
    ).rowsWritten;
  }

  private createSnapshot(): SnapshotResponse {
    const now = Math.floor(Date.now() / 1000);
    const instances = Array.from(this.sql.exec<InstanceRow>(
      `SELECT zone_server_id, instance_epoch, revision, last_received_at,
              ce_last_seen_json AS event_last_seen_json, area_tracks_json, updated_at
       FROM instance_state WHERE last_received_at >= ? ORDER BY last_received_at DESC`,
      now - 86_400
    )).map(row => this.toSnapshotInstance({
      zoneServerID: row.zone_server_id,
      instanceEpoch: row.instance_epoch,
      revision: row.revision,
      lastReceivedAt: row.last_received_at,
      eventLastSeen: JSON.parse(row.event_last_seen_json) as Record<string, DurableEventState>,
      areaTracks: this.parseAreaTracks(row.area_tracks_json, row.event_last_seen_json, row.last_received_at),
      updatedAt: row.updated_at
    }, now));

    return {
      type: "snapshot",
      serverTime: now,
      dataCenterID: this.dataCenterID,
      revision: this.revision,
      instances
    };
  }

  private toSnapshotInstance(state: DurableInstanceState, now = Math.floor(Date.now() / 1000)): SnapshotInstance {
    const eventLastSeen = this.toSnapshotEvents(state.eventLastSeen);
    const lastReceivedAt = this.getLatestEventSpawnedAt(state.eventLastSeen) || state.lastReceivedAt;
    const areaTracks = Object.fromEntries(Object.entries(state.areaTracks).map(([areaCode, collection]) => [
      areaCode,
      this.toSnapshotTracks(collection, now)
    ]));

    return {
      zoneServerID: state.zoneServerID,
      instanceEpoch: state.instanceEpoch,
      revision: state.revision,
      lastReceivedAt,
      eventLastSeen,
      areaTracks,
      updatedAt: state.updatedAt,
      expiresAt: lastReceivedAt + INSTANCE_RETENTION_SECONDS
    };
  }

  private toSnapshotTracks(
    collection: DurableAreaTrackCollection,
    now = Math.floor(Date.now() / 1000)
  ): SnapshotInstanceTrack[] {
    const tracks = Object.values(collection.tracks)
      .filter(track => track.lastReceivedAt >= now - INSTANCE_RETENTION_SECONDS)
      .sort((left, right) => left.ordinal - right.ordinal);
    const groups: DurableInstanceTrackState[][] = [];

    for (const track of tracks) {
      const group = groups.find(candidate => candidate.every(member => !this.areTracksSeparated(member, track)));
      if (group)
        group.push(track);
      else
        groups.push([track]);
    }

    return groups.map(group => this.toSnapshotTrack(this.mergeTrackGroup(group)));
  }

  private areTracksSeparated(
    left: DurableInstanceTrackState,
    right: DurableInstanceTrackState
  ): boolean {
    if (haveTrackConflict(left, right))
      return true;
    if (haveTrackCEMatch(left, right))
      return false;
    return left.conflictingTrackIDs.includes(right.trackID) ||
      right.conflictingTrackIDs.includes(left.trackID);
  }

  private mergeTrackGroup(tracks: DurableInstanceTrackState[]): DurableInstanceTrackState {
    const canonical = tracks.slice().sort((left, right) => left.ordinal - right.ordinal)[0];
    const eventLastSeen: Record<string, DurableEventState> = {};
    const sourceIDs = new Set<string>();

    for (const track of tracks.slice().sort((left, right) => left.lastReceivedAt - right.lastReceivedAt)) {
      for (const sourceID of track.sourceIDs)
        sourceIDs.add(sourceID);
      for (const [key, event] of Object.entries(track.eventLastSeen)) {
        const current = eventLastSeen[key];
        if (!current || event.lastSpawnedAt > current.lastSpawnedAt) {
          eventLastSeen[key] = {
            ...event,
            sourceIDs: [...event.sourceIDs]
          };
          continue;
        }
        if (event.lastSpawnedAt === current.lastSpawnedAt) {
          const eventSources = new Set([...current.sourceIDs, ...event.sourceIDs]);
          current.sourceIDs = [...eventSources];
          current.sourceCount = eventSources.size > 1 ? 2 : 1;
          current.observedState = event.observedState;
        }
      }
    }

    return {
      ...canonical,
      firstObservedAt: Math.min(...tracks.map(track => track.firstObservedAt)),
      lastReceivedAt: Math.max(...tracks.map(track => track.lastReceivedAt)),
      eventLastSeen,
      sourceIDs: [...sourceIDs]
    };
  }

  private toSnapshotTrack(track: DurableInstanceTrackState): SnapshotInstanceTrack {
    const lastReceivedAt = this.getTrackActivityAt(track);
    return {
      trackID: track.trackID,
      ordinal: track.ordinal,
      firstObservedAt: track.firstObservedAt,
      lastReceivedAt,
      expiresAt: lastReceivedAt + TRACK_ACTIVE_WINDOW_SECONDS,
      eventLastSeen: this.toSnapshotEvents(track.eventLastSeen)
    };
  }

  private getTrackActivityAt(track: DurableInstanceTrackState): number {
    return this.getLatestEventSpawnedAt(track.eventLastSeen) || track.lastReceivedAt;
  }

  private getLatestEventSpawnedAt(events: Record<string, DurableEventState>): number {
    return Object.values(events).reduce((latest, event) => Math.max(latest, event.lastSpawnedAt), 0);
  }

  private toSnapshotEvents(
    events: Record<string, DurableEventState>
  ): Record<string, Omit<DurableEventState, "sourceIDs" | "firstReceivedAt">> {
    return Object.fromEntries(Object.entries(events).map(([key, event]) => [key, {
      territoryID: event.territoryID,
      eventType: event.eventType,
      eventID: event.eventID,
      lastSpawnedAt: event.lastSpawnedAt,
      observedState: event.observedState,
      sourceCount: event.sourceCount
    }]));
  }

  private parseAreaTracks(
    value: string | null,
    eventLastSeenJSON: string,
    lastReceivedAt: number
  ): Record<string, DurableAreaTrackCollection> {
    if (value) {
      try {
        const parsed = JSON.parse(value) as Record<string, DurableAreaTrackCollection>;
        if (Object.keys(parsed).length > 0) {
          for (const collection of Object.values(parsed)) {
            for (const track of Object.values(collection.tracks)) {
              track.conflictDetectionStartedAt = Number.isSafeInteger(track.conflictDetectionStartedAt)
                ? track.conflictDetectionStartedAt
                : track.lastReceivedAt;
              track.conflictingTrackIDs = Array.isArray(track.conflictingTrackIDs)
                ? track.conflictingTrackIDs.filter(trackID => typeof trackID === "string")
                : [];
            }
          }
          return parsed;
        }
      } catch (error) {
        console.warn(JSON.stringify({ event: "instance.area_tracks_parse_failed", error: String(error) }));
      }
    }

    const eventLastSeen = JSON.parse(eventLastSeenJSON) as Record<string, DurableEventState>;
    const areaTracks: Record<string, DurableAreaTrackCollection> = {};
    for (const event of Object.values(eventLastSeen)) {
      const areaCode = getAreaForTerritory(event.territoryID)?.code;
      if (!areaCode) continue;
      const collection = areaTracks[areaCode] ?? {
        nextTrackOrdinal: 2,
        reporterTrackIDs: {},
        tracks: {}
      } satisfies DurableAreaTrackCollection;
      if (Object.keys(collection.tracks).length === 0) {
        const trackID = `${areaCode}-1`;
        collection.tracks[trackID] = {
          trackID,
          ordinal: 1,
          firstObservedAt: lastReceivedAt,
          lastReceivedAt,
          conflictDetectionStartedAt: lastReceivedAt,
          conflictingTrackIDs: [],
          eventLastSeen: {},
          sourceIDs: []
        };
      }
      const track = Object.values(collection.tracks)[0];
      track.eventLastSeen[`${event.territoryID}:${event.eventType}:${event.eventID}`] = event;
      areaTracks[areaCode] = collection;
    }
    return areaTracks;
  }

  private createResult(
    eventType: ReportResult["eventType"],
    eventID: number,
    spawnedAt: number,
    status: ReportResult["status"],
    revision = 0
  ): ReportResult {
    return { eventType, eventID, spawnedAt, status, revision };
  }

  private updateActivityWindow(windowStartedAt: number, reporterEpochID: string, zoneServerID: number): number {
    let rowsWritten = this.sql.exec(
      `INSERT OR IGNORE INTO activity_window (window_started_at, reporter_count, instance_count)
       VALUES (?, 0, 0)`,
      windowStartedAt
    ).rowsWritten;
    rowsWritten += this.sql.exec(
      `INSERT OR IGNORE INTO reporter_instance_count
       (window_started_at, zone_server_id, reporter_count) VALUES (?, ?, 0)`,
      windowStartedAt,
      zoneServerID
    ).rowsWritten;

    const reporterRows = Array.from(this.sql.exec<CountRow>(
      `SELECT 1 AS count FROM reporter_instance_window
       WHERE window_started_at = ? AND zone_server_id = ? AND reporter_epoch_id = ?`,
      windowStartedAt,
      zoneServerID,
      reporterEpochID
    ));
    if (reporterRows.length === 0) {
      rowsWritten += this.sql.exec(
        `INSERT INTO reporter_instance_window
         (window_started_at, zone_server_id, reporter_epoch_id) VALUES (?, ?, ?)`,
        windowStartedAt,
        zoneServerID,
        reporterEpochID
      ).rowsWritten;
      rowsWritten += this.sql.exec(
        `UPDATE reporter_instance_count SET reporter_count = reporter_count + 1
         WHERE window_started_at = ? AND zone_server_id = ?`,
        windowStartedAt,
        zoneServerID
      ).rowsWritten;
    }

    const instanceRows = Array.from(this.sql.exec<CountRow>(
      `SELECT 1 AS count FROM instance_window
       WHERE window_started_at = ? AND zone_server_id = ?`,
      windowStartedAt,
      zoneServerID
    ));
    if (instanceRows.length === 0) {
      rowsWritten += this.sql.exec(
        "INSERT INTO instance_window (window_started_at, zone_server_id) VALUES (?, ?)",
        windowStartedAt,
        zoneServerID
      ).rowsWritten;
      rowsWritten += this.sql.exec(
        "UPDATE activity_window SET instance_count = instance_count + 1 WHERE window_started_at = ?",
        windowStartedAt
      ).rowsWritten;
    }
    return rowsWritten;
  }

  private updateRequestWindow(windowStartedAt: number, rowsWritten: number): RequestWindowRow {
    return this.sql.exec<RequestWindowRow>(
      `INSERT INTO request_window (window_started_at, request_count, rows_written) VALUES (?, 1, ?)
       ON CONFLICT(window_started_at) DO UPDATE SET
         request_count = request_count + 1, rows_written = rows_written + excluded.rows_written
       RETURNING request_count, rows_written`,
      windowStartedAt, rowsWritten + 1
    ).one();
  }

  private broadcast(message: InstanceUpdatedMessage | InstanceExpiredMessage): void {
    const payload = JSON.stringify(message);
    for (const webSocket of this.ctx.getWebSockets()) {
      if (webSocket.readyState !== WebSocket.OPEN)
        continue;

      try {
        webSocket.send(payload);
      } catch (error) {
        console.warn(JSON.stringify({ event: "websocket.broadcast_failed", error: String(error) }));
      }
    }
  }

  private getNextAlarm(): number {
    const interval = 3_600_000;
    const maintenanceAt = (Math.floor(Date.now() / interval) + 1) * interval;
    return Math.min(maintenanceAt, this.eventSnapshots.nextRetryAt ?? maintenanceAt);
  }
}

function getTargetReporterCount(reportRequestsPerHour: number, sqlRowsWrittenPerHour: number): number {
  const utilization = Math.max(
    reportRequestsPerHour / REPORT_REQUEST_BUDGET_PER_DATA_CENTER_HOUR,
    sqlRowsWrittenPerHour / SQL_WRITE_BUDGET_PER_DATA_CENTER_HOUR
  );
  if (utilization >= 1)
    return 1;
  if (utilization >= 0.5)
    return 2;
  return 3;
}

const DAILY_REPORT_REQUEST_BUDGET = 70_000;
const REPORT_REQUEST_BUDGET_PER_DATA_CENTER_HOUR = DAILY_REPORT_REQUEST_BUDGET / DATA_CENTERS.length / 24;
const DAILY_REPORT_SQL_WRITE_BUDGET = 70_000;
const SQL_WRITE_BUDGET_PER_DATA_CENTER_HOUR = DAILY_REPORT_SQL_WRITE_BUDGET / DATA_CENTERS.length / 24;
