import dataCenterData from "../web/public/assets/data-centers.json";
import dynamicEventCatalog from "../web/public/assets/dynamic-event-catalog.json";
import type { EventType } from "./models";

interface WorldEntry {
  id: number;
  name: string;
}

interface DataCenterEntry {
  id: number;
  name: string;
  region: string;
  serverGroup: string;
  languageCodes: string[];
  worlds: WorldEntry[];
}

interface CEEntry {
  ceID: number;
  iconID: number;
  order: number;
  localizedNames: Record<string, string>;
  canCoexist?: boolean;
}

interface FATEEntry {
  fateID: number;
  iconID: number;
  order: number;
  localizedNames: Record<string, string>;
}

interface CatalogEventEntry {
  eventType: EventType;
  eventID: number;
  iconID: number;
  order: number;
  localizedNames: Record<string, string>;
  canCoexist?: boolean;
}

interface RawEventArea {
  code: string;
  gameplay: string;
  name: string;
  localizedNames: Record<string, string>;
  mapNames: Record<string, string>;
  serverGroups: string[];
  territoryIDs: number[];
  ces: CEEntry[];
  fates: FATEEntry[];
}

export interface EventArea extends RawEventArea {
  events: CatalogEventEntry[];
}

interface GameplayEntry {
  code: string;
  iconID: number;
  localizedNames: Record<string, string>;
  trackResetWindowSeconds?: number;
}

export const DATA_CENTERS = dataCenterData.dataCenters as DataCenterEntry[];
export const EVENT_AREAS = (dynamicEventCatalog.areas as RawEventArea[]).map(area => ({
  ...area,
  events: [
    ...area.ces.map(ce => ({
      eventType: "CE" as const,
      eventID: ce.ceID,
      iconID: ce.iconID,
      order: ce.order,
      localizedNames: ce.localizedNames,
      canCoexist: ce.canCoexist
    })),
    ...area.fates.map(fate => ({
      eventType: "FATE" as const,
      eventID: fate.fateID,
      iconID: fate.iconID,
      order: fate.order,
      localizedNames: fate.localizedNames
    }))
  ].sort((left, right) => left.order - right.order)
}));

export const GAMEPLAYS = dynamicEventCatalog.gameplays as GameplayEntry[];

const WORLD_TO_DATA_CENTER = new Map<number, number>();
const TERRITORY_TO_AREA = new Map<number, EventArea>();
const TERRITORY_TO_EVENT_KEYS = new Map<number, Set<string>>();
const GAMEPLAY_TRACK_RESET_WINDOW = new Map<string, number>();
const COEXIST_EVENT_KEYS = new Set<string>();

for (const dataCenter of DATA_CENTERS) {
  for (const world of dataCenter.worlds)
    WORLD_TO_DATA_CENTER.set(world.id, dataCenter.id);
}

for (const area of EVENT_AREAS) {
  for (const territoryID of area.territoryIDs) {
    TERRITORY_TO_AREA.set(territoryID, area);
    TERRITORY_TO_EVENT_KEYS.set(
      territoryID,
      new Set(area.events.map(event => `${event.eventType}:${event.eventID}`))
    );
  }
}

for (const gameplay of GAMEPLAYS)
  GAMEPLAY_TRACK_RESET_WINDOW.set(
    gameplay.code,
    typeof gameplay.trackResetWindowSeconds === "number" && gameplay.trackResetWindowSeconds > 0
      ? gameplay.trackResetWindowSeconds
      : 0
  );

for (const area of EVENT_AREAS) {
  for (const event of area.events) {
    if (event.eventType === "CE" && event.canCoexist) {
      for (const territoryID of area.territoryIDs)
        COEXIST_EVENT_KEYS.add(`${territoryID}:${event.eventType}:${event.eventID}`);
    }
  }
}

export function getDataCenterForWorld(worldID: number): number | undefined {
  return WORLD_TO_DATA_CENTER.get(worldID);
}

export function hasDataCenter(dataCenterID: number): boolean {
  return DATA_CENTERS.some(dataCenter => dataCenter.id === dataCenterID);
}

export function getServerGroupForDataCenter(dataCenterID: number): string | undefined {
  return DATA_CENTERS.find(dataCenter => dataCenter.id === dataCenterID)?.serverGroup;
}

export function getAreaForTerritory(territoryID: number): EventArea | undefined {
  return TERRITORY_TO_AREA.get(territoryID);
}

export function getTrackResetWindowSeconds(gameplayCode: string): number {
  return GAMEPLAY_TRACK_RESET_WINDOW.get(gameplayCode) ?? 0;
}

export function canEventCoexist(territoryID: number, eventType: EventType, eventID: number): boolean {
  return COEXIST_EVENT_KEYS.has(`${territoryID}:${eventType}:${eventID}`);
}

export function hasEvent(territoryID: number, eventType: EventType, eventID: number): boolean {
  return TERRITORY_TO_EVENT_KEYS.get(territoryID)?.has(`${eventType}:${eventID}`) ?? false;
}

export function getDataCenterName(dataCenterID: number): string {
  return DATA_CENTERS.find(dataCenter => dataCenter.id === dataCenterID)?.name ?? `DC ${dataCenterID}`;
}
