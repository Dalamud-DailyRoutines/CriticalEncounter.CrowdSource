import dataCenterData from "../web/public/assets/data-centers.json";
import ceCatalog from "../web/public/assets/ce-catalog.json";
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

interface EventArea extends RawEventArea {
  events: CatalogEventEntry[];
}

interface GameplayEntry {
  code: string;
  iconID: number;
  localizedNames: Record<string, string>;
  canGenerateTracks?: boolean;
}

export const DATA_CENTERS = dataCenterData.dataCenters as DataCenterEntry[];
export const EVENT_AREAS = (ceCatalog.areas as RawEventArea[]).map(area => ({
  ...area,
  events: [
    ...area.ces.map(ce => ({
      eventType: "CE" as const,
      eventID: ce.ceID,
      iconID: ce.iconID,
      order: ce.order,
      localizedNames: ce.localizedNames
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

export const GAMEPLAYS = ceCatalog.gameplays as GameplayEntry[];

const WORLD_TO_DATA_CENTER = new Map<number, number>();
const TERRITORY_TO_AREA = new Map<number, EventArea>();
const TERRITORY_TO_EVENT_KEYS = new Map<number, Set<string>>();
const GAMEPLAY_CAN_GENERATE_TRACKS = new Map<string, boolean>();

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
  GAMEPLAY_CAN_GENERATE_TRACKS.set(gameplay.code, gameplay.canGenerateTracks === true);

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

export function canGameplayGenerateTracks(gameplayCode: string): boolean {
  return GAMEPLAY_CAN_GENERATE_TRACKS.get(gameplayCode) ?? false;
}

export function hasEvent(territoryID: number, eventType: EventType, eventID: number): boolean {
  return TERRITORY_TO_EVENT_KEYS.get(territoryID)?.has(`${eventType}:${eventID}`) ?? false;
}

export function getDataCenterName(dataCenterID: number): string {
  return DATA_CENTERS.find(dataCenter => dataCenter.id === dataCenterID)?.name ?? `DC ${dataCenterID}`;
}
