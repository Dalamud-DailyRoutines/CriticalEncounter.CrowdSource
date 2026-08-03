export type EventType = "CE" | "FATE";
export type ObservedState = "Register" | "Warmup" | "Battle" | "Preparing" | "Running";

export interface ReportEvent {
  eventType: EventType;
  eventID: number;
  spawnedAt: number;
  observedState: ObservedState;
}

export interface ReportRequest {
  schemaVersion: 2;
  currentWorldID: number;
  dataCenterID: number;
  territoryID: number;
  zoneServerID: number;
  observedAt: number;
  reporterEpochID: string;
  pluginVersion: string;
  events: ReportEvent[];
}

export interface NormalizedReport extends ReportRequest {
  receivedAt: number;
}

export interface ReportResult {
  eventType: EventType;
  eventID: number;
  spawnedAt: number;
  status: "accepted" | "duplicate" | "stale" | "invalid" | "retry";
  revision: number;
}

export interface ReportResponse {
  requestID: string;
  serverTime: number;
  samplingRate: number;
  activeReporterCount: number;
  activeInstanceCount: number;
  targetReporterCount: number;
  reportRequestsPerHour: number;
  results: ReportResult[];
}

export interface DurableEventState {
  territoryID: number;
  eventType: EventType;
  eventID: number;
  lastSpawnedAt: number;
  firstReceivedAt: number;
  observedState: ObservedState;
  sourceCount: 1 | 2;
  sourceIDs: string[];
}

export interface DurableInstanceState {
  zoneServerID: number;
  instanceEpoch: number;
  revision: number;
  lastReceivedAt: number;
  eventLastSeen: Record<string, DurableEventState>;
  updatedAt: number;
}

export interface SnapshotInstance extends Omit<DurableInstanceState, "eventLastSeen"> {
  expiresAt: number;
  eventLastSeen: Record<string, Omit<DurableEventState, "sourceIDs" | "firstReceivedAt">>;
}

export interface SnapshotResponse {
  type: "snapshot";
  serverTime: number;
  dataCenterID: number;
  revision: number;
  instances: SnapshotInstance[];
}

export interface InstanceUpdatedMessage {
  type: "instance.updated";
  serverTime: number;
  dataCenterID: number;
  revision: number;
  instance: SnapshotInstance;
}

export interface InstanceExpiredMessage {
  type: "instance.expired";
  serverTime: number;
  dataCenterID: number;
  revision: number;
  zoneServerID: number;
}

export type RealtimeMessage = SnapshotResponse | InstanceUpdatedMessage | InstanceExpiredMessage;

export interface Env {
  ASSETS: Fetcher;
  DATA_CENTER_STATE: DurableObjectNamespace;
  UPLOAD_API_KEY: string;
}
