const state = {
  dataCenters: [],
  languages: [],
  catalog: null,
  instances: new Map(),
  uiLanguageCode: "zh",
  selectedDataCenterID: 101,
  selectedZoneServerID: null,
  socket: null,
  reconnectAttempt: 0,
  reconnectTimer: 0,
  serverOffsetMS: 0,
  lastUpdateAt: 0,
  sort: "recent",
  eventSort: "default",
  instanceSearch: "",
  articleID: null,
  selectedAreaCode: null,
  areaSelectorOpen: false,
  selectionFromURL: false,
  map: null,
  mapImageOverlay: null,
  mapMarker: null,
  mapRequestToken: 0,
  copyToastTimer: 0
};

const elements = {
  articleContent: document.querySelector("#articleContent"),
  articleLanguageSelect: document.querySelector("#articleLanguageSelect"),
  articleView: document.querySelector("#articleView"),
  activeCount: document.querySelector("#activeCount"),
  areaList: document.querySelector("#areaList"),
  controlBand: document.querySelector(".control-band"),
  connectionStatus: document.querySelector("#connectionStatus"),
  copyToast: document.querySelector("#copyToast"),
  dataCenterName: document.querySelector("#dataCenterName"),
  dataCenterSelect: document.querySelector("#dataCenterSelect"),
  detailHeading: document.querySelector("#detailHeading"),
  emptyState: document.querySelector("#emptyState"),
  emptyStateText: document.querySelector("#emptyStateText"),
  instanceCount: document.querySelector("#instanceCount"),
  instanceList: document.querySelector("#instanceList"),
  instanceMeta: document.querySelector("#instanceMeta"),
  lastUpdate: document.querySelector("#lastUpdate"),
  mapCanvas: document.querySelector("#mapCanvas"),
  mapDialog: document.querySelector("#mapDialog"),
  mapDialogClose: document.querySelector("#mapDialogClose"),
  mapDialogTitle: document.querySelector("#mapDialogTitle"),
  mapStatus: document.querySelector("#mapStatus"),
  sortSelect: document.querySelector("#sortSelect"),
  instanceSearch: document.querySelector("#instanceSearch"),
  uiLanguageSelect: document.querySelector("#uiLanguageSelect"),
  workspace: document.querySelector(".workspace")
};

const uiLanguages = [
  { code: "zh", label: "简体中文", locale: "zh-CN", contentLanguageCode: "CHS", regionPriority: ["China"] },
  { code: "ja", label: "日本語", locale: "ja-JP", contentLanguageCode: "JA", regionPriority: ["Japan"] },
  { code: "en", label: "English", locale: "en-US", contentLanguageCode: "EN", regionPriority: ["North America", "Europe"] },
  { code: "de", label: "Deutsch", locale: "de-DE", contentLanguageCode: "DE", regionPriority: ["Europe", "North America"] },
  { code: "fr", label: "Français", locale: "fr-FR", contentLanguageCode: "FR", regionPriority: ["Europe", "North America"] },
  { code: "ko", label: "한국어", locale: "ko-KR", contentLanguageCode: "KO", regionPriority: ["Korea"] }
];

marked.use(markedAlert());

const copyConfiguration = {
  default: {
    enabled: true,
    cooldownMinutesByEventType: {},
    rules: []
  },
  gameplays: {
    SaveTheQueen: {
      enabled: true,
      cooldownMinutesByEventType: { CE: 80 },
      rules: [
        { eventType: "CE", eventIDs: [16, 32], format: "lastSeen" }
      ]
    },
    OccultCrescent: {
      enabled: true,
      cooldownMinutesByEventType: { CE: 60, FATE: 60 },
      rules: [
        { eventType: "CE", eventIDs: [48, 64], format: "lastSeen" }
      ],
      linkedGroups: [
        { areaCodes: ["SouthHorn"], eventType: "FATE", eventIDs: [1976, 1977], intervalMinutes: 30, predictionToleranceMinutes: 35 },
        { areaCodes: ["NorthHorn"], eventType: "FATE", eventIDs: [2073, 2072], intervalMinutes: 30, predictionToleranceMinutes: 35 }
      ]
    },
    Eureka: {
      enabled: false,
      cooldownMinutesByEventType: {},
      rules: []
    }
  }
};

async function initialize() {
  const [dataCenters, catalog] = await Promise.all([
    fetch("/assets/data-centers.json").then(response => response.json()),
    fetch("/assets/ce-catalog.json").then(response => response.json())
  ]);

  state.dataCenters = dataCenters.dataCenters;
  state.languages = dataCenters.languages;
  state.catalog = {
    ...catalog,
    areas: catalog.areas.map(area => ({
      ...area,
      events: [
        ...area.ces.map(ce => ({
          eventType: "CE",
          eventID: ce.ceID,
          iconID: ce.iconID,
          mapPosition: ce.mapPosition,
          order: ce.order,
          localizedNames: ce.localizedNames,
          triggerDescriptions: ce.triggerDescriptions
        })),
        ...area.fates.map(fate => ({
          eventType: "FATE",
          eventID: fate.fateID,
          iconID: fate.iconID,
          mapPosition: fate.mapPosition,
          order: fate.order,
          localizedNames: fate.localizedNames,
          triggerDescriptions: fate.triggerDescriptions
        }))
      ].sort((left, right) => left.order - right.order)
    }))
  };
  restoreUILanguage();
  restoreSelectionFromURL();
  restorePreferences();
  populateUILanguages();
  applyUILanguage();
  populateDataCenters();
  bindEvents();
  state.articleID = syncView();
  if (state.articleID)
    renderArticle();
  else {
    render();
    if (document.visibilityState === "visible")
      connect();
  }

  window.setInterval(() => {
    pruneExpiredInstances();
    updateRelativeTimes();
  }, 30_000);
}

function bindUILanguageSelect(select) {
  select.addEventListener("change", () => {
    state.uiLanguageCode = select.value;
    localStorage.setItem("ce-crowdsource-ui-language", state.uiLanguageCode);
    syncUILanguageSelects();
    applyUILanguage();
    populateDataCenters();
    if (state.articleID)
      renderArticle();
    else
      render();
  });
}

function bindEvents() {
  bindUILanguageSelect(elements.uiLanguageSelect);
  bindUILanguageSelect(elements.articleLanguageSelect);

  elements.dataCenterSelect.addEventListener("change", () => {
    state.selectedDataCenterID = Number(elements.dataCenterSelect.value);
    state.selectedZoneServerID = null;
    state.instances.clear();
    localStorage.setItem("ce-crowdsource-data-center", String(state.selectedDataCenterID));
    updateURL();
    render();
    connect();
  });

  elements.sortSelect.addEventListener("change", () => {
    state.sort = elements.sortSelect.value;
    localStorage.setItem("ce-crowdsource-instance-sort", state.sort);
    renderInstances();
  });

  elements.instanceSearch.addEventListener("input", () => {
    state.instanceSearch = elements.instanceSearch.value;
    renderInstances();
  });

  elements.areaList.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      if (!state.areaSelectorOpen) return;
      closeAreaSelector();
      return;
    }
    const options = [...elements.areaList.querySelectorAll(".region-option")];
    const currentIndex = options.indexOf(document.activeElement);
    if (currentIndex === -1) return;
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = currentIndex + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = currentIndex - 1;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = options.length - 1;
    else return;
    event.preventDefault();
    nextIndex = (nextIndex + options.length) % options.length;
    for (const option of options) option.tabIndex = -1;
    const nextOption = options[nextIndex];
    nextOption.tabIndex = 0;
    nextOption.focus();
  });

  elements.mapDialogClose.addEventListener("click", () => elements.mapDialog.close());
  elements.mapDialog.addEventListener("click", event => {
    if (event.target === elements.mapDialog)
      elements.mapDialog.close();
  });
  elements.mapDialog.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      elements.mapDialog.close();
    }
  });
  elements.mapDialog.addEventListener("close", () => {
    state.mapRequestToken += 1;
    clearMapSelection();
  });

  window.addEventListener("popstate", () => {
    restoreSelectionFromURL();
    state.articleID = syncView();
    populateDataCenters();
    if (state.articleID)
      renderArticle();
    else {
      render();
      connect();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible")
      connect();
    else
      disconnect();
  });
}

function restoreUILanguage() {
  const storedLanguage = localStorage.getItem("ce-crowdsource-ui-language");
  if (uiLanguages.some(language => language.code === storedLanguage)) {
    state.uiLanguageCode = storedLanguage;
    return;
  }

  const browserLanguage = navigator.language.toLowerCase();
  if (browserLanguage.startsWith("ko"))
    state.uiLanguageCode = "ko";
  else if (browserLanguage.startsWith("ja"))
    state.uiLanguageCode = "ja";
  else if (browserLanguage.startsWith("de"))
    state.uiLanguageCode = "de";
  else if (browserLanguage.startsWith("fr"))
    state.uiLanguageCode = "fr";
  else if (browserLanguage.startsWith("zh"))
    state.uiLanguageCode = "zh";
  else
    state.uiLanguageCode = "en";
}

function populateUILanguages() {
  for (const select of [elements.uiLanguageSelect, elements.articleLanguageSelect]) {
    const fragment = document.createDocumentFragment();
    for (const uiLanguage of uiLanguages) {
      const option = document.createElement("option");
      option.value = uiLanguage.code;
      option.textContent = uiLanguage.label;
      fragment.append(option);
    }

    select.replaceChildren(fragment);
    select.value = state.uiLanguageCode;
  }
}

function applyUILanguage() {
  document.documentElement.lang = getUILanguage().locale;
  document.title = t("siteTitle");
  for (const element of document.querySelectorAll("[data-i18n]"))
    element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll("[data-i18n-aria-label]"))
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  for (const element of document.querySelectorAll("[data-i18n-title]"))
    element.setAttribute("title", t(element.dataset.i18nTitle));
  for (const element of document.querySelectorAll("[data-i18n-placeholder]"))
    element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
  if (state.connectionLabelKey)
    setConnectionState(elements.connectionStatus.dataset.state, state.connectionLabelKey);
}

function getUILanguage() {
  return uiLanguages.find(language => language.code === state.uiLanguageCode);
}

function syncUILanguageSelects() {
  elements.uiLanguageSelect.value = state.uiLanguageCode;
  elements.articleLanguageSelect.value = state.uiLanguageCode;
}

function syncView() {
  const match = location.pathname.match(/^\/articles\/(\d+)\/?$/);
  const articleID = match ? match[1] : null;
  elements.controlBand.hidden = articleID !== null;
  elements.workspace.hidden = articleID !== null;
  elements.articleView.hidden = articleID === null;
  return articleID;
}

async function renderArticle() {
  const articleID = state.articleID;
  const languageCode = getUILanguage().contentLanguageCode.toLowerCase();
  elements.articleContent.replaceChildren();
  try {
    const response = await fetch(`/assets/articles/${articleID}_${languageCode}.md`);
    if (!response.ok)
      throw new Error(`Article ${articleID}_${languageCode} not found`);
    const markdown = await response.text();
    if (state.articleID !== articleID || getUILanguage().contentLanguageCode.toLowerCase() !== languageCode)
      return;
    elements.articleContent.innerHTML = marked.parse(markdown, { gfm: true });
  } catch {
    if (state.articleID !== articleID || getUILanguage().contentLanguageCode.toLowerCase() !== languageCode)
      return;
    const error = document.createElement("p");
    error.className = "article-error";
    error.textContent = t("articleLoadError");
    elements.articleContent.replaceChildren(error);
  }
}

function t(key, params = {}) {
  let text = uiTranslations[state.uiLanguageCode]?.[key] ?? uiTranslations.zh[key] ?? key;
  for (const [name, value] of Object.entries(params))
    text = text.replaceAll(`{${name}}`, String(value));
  return text;
}

function populateDataCenters() {
  const fragment = document.createDocumentFragment();
  const regions = new Map();
  if (!state.dataCenters.some(dataCenter => dataCenter.id === state.selectedDataCenterID))
    state.selectedDataCenterID = getSelectedLanguage().defaultDataCenterID;

  for (const dataCenter of state.dataCenters) {
    if (!regions.has(dataCenter.region))
      regions.set(dataCenter.region, []);
    regions.get(dataCenter.region).push(dataCenter);
  }

  const orderedRegions = [];
  for (const region of getUILanguage().regionPriority) {
    if (regions.has(region))
      orderedRegions.push(region);
  }
  for (const region of regions.keys()) {
    if (!orderedRegions.includes(region))
      orderedRegions.push(region);
  }

  for (const region of orderedRegions) {
    const group = document.createElement("optgroup");
    group.label = region;
    for (const dataCenter of regions.get(region)) {
      const option = document.createElement("option");
      option.value = String(dataCenter.id);
      option.textContent = dataCenter.name;
      group.append(option);
    }
    fragment.append(group);
  }

  elements.dataCenterSelect.replaceChildren(fragment);
  elements.dataCenterSelect.value = String(state.selectedDataCenterID);
}

function restoreSelectionFromURL() {
  const match = location.pathname.match(/^\/dc\/(\d+)(?:\/instance\/(\d+))?\/?$/);
  state.selectionFromURL = match !== null;
  if (!match) return;

  const dataCenterID = Number(match[1]);
  if (state.dataCenters.some(dataCenter => dataCenter.id === dataCenterID))
    state.selectedDataCenterID = dataCenterID;
  state.selectedZoneServerID = match[2] ? Number(match[2]) : null;
}

function restorePreferences() {
  const storedDataCenterID = Number(localStorage.getItem("ce-crowdsource-data-center"));
  if (!state.selectionFromURL && state.dataCenters.some(dataCenter => dataCenter.id === storedDataCenterID))
    state.selectedDataCenterID = storedDataCenterID;

  const storedSort = localStorage.getItem("ce-crowdsource-instance-sort");
  if (storedSort === "recent" || storedSort === "server")
    state.sort = storedSort;
  elements.sortSelect.value = state.sort;

  const storedEventSort = localStorage.getItem("ce-crowdsource-event-sort");
  if (storedEventSort === "default" || storedEventSort === "desc" || storedEventSort === "asc")
    state.eventSort = storedEventSort;
}

function updateURL() {
  const path = state.selectedZoneServerID === null
    ? `/dc/${state.selectedDataCenterID}`
    : `/dc/${state.selectedDataCenterID}/instance/${state.selectedZoneServerID}`;
  history.pushState(null, "", path);
}

function connect() {
  if (state.articleID || document.visibilityState !== "visible") return;

  window.clearTimeout(state.reconnectTimer);
  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close(1000, "selection_changed");
  }

  setConnectionState("connecting", "statusConnecting");
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/v1/realtime/${state.selectedDataCenterID}`);
  state.socket = socket;

  socket.addEventListener("open", () => {
    state.reconnectAttempt = 0;
    setConnectionState("online", "statusLive");
  });

  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (typeof message.serverTime === "number")
      state.serverOffsetMS = message.serverTime * 1000 - Date.now();

    if (message.type === "snapshot") {
      state.instances = new Map(message.instances.map(instance => [instance.zoneServerID, instance]));
    } else if (message.type === "instance.updated") {
      state.instances.set(message.instance.zoneServerID, message.instance);
    } else if (message.type === "instance.expired") {
      state.instances.delete(message.zoneServerID);
    }

    state.lastUpdateAt = Date.now();
    pruneExpiredInstances();
    updateConnectionTime();
    render();
  });

  socket.addEventListener("close", () => {
    if (state.socket === socket)
      scheduleReconnect();
  });
  socket.addEventListener("error", () => setConnectionState("offline", "statusDisconnected"));
}

function disconnect() {
  window.clearTimeout(state.reconnectTimer);
  const socket = state.socket;
  state.socket = null;
  if (!socket) return;
  socket.onclose = null;
  socket.close(1000, "page_hidden");
}

function scheduleReconnect() {
  if (state.socket === null || document.visibilityState !== "visible") return;
  setConnectionState("offline", "statusReconnecting");
  const delays = [1, 2, 5, 10, 30];
  const seconds = delays[Math.min(state.reconnectAttempt, delays.length - 1)];
  state.reconnectAttempt++;
  state.reconnectTimer = window.setTimeout(connect, (seconds + Math.random()) * 1000);
}

function updateConnectionTime() {
  const timeElement = elements.connectionStatus.querySelector(".status-time");
  const time = state.lastUpdateAt === 0
    ? ""
    : new Date(state.lastUpdateAt).toLocaleTimeString(getSelectedLanguage().locale, { hour12: false });
  timeElement.textContent = time;
  if (time === "") {
    timeElement.removeAttribute("dateTime");
    return;
  }
  timeElement.dateTime = new Date(state.lastUpdateAt).toISOString();
}

function setConnectionState(connectionState, labelKey) {
  state.connectionLabelKey = labelKey;
  elements.connectionStatus.dataset.state = connectionState;
  elements.connectionStatus.querySelector(".status-label").textContent = t(labelKey);
  updateConnectionTime();
}

function pruneExpiredInstances() {
  const now = getServerNowSeconds();
  for (const [zoneServerID, instance] of state.instances) {
    if (instance.lastReceivedAt < now - 86_400)
      state.instances.delete(zoneServerID);
  }

  if (state.selectedZoneServerID !== null && !state.instances.has(state.selectedZoneServerID))
    state.selectedZoneServerID = null;
}

function render() {
  renderSummary();
  renderInstances();
  renderDetails();
}

function renderSummary() {
  const dataCenter = state.dataCenters.find(item => item.id === state.selectedDataCenterID);
  const now = getServerNowSeconds();
  const activeCount = [...state.instances.values()].filter(instance => now - instance.lastReceivedAt < 3600).length;
  const count = state.instances.size;
  elements.activeCount.textContent = String(activeCount);
  elements.instanceCount.textContent = String(count);
  elements.dataCenterName.textContent = dataCenter?.name ?? `DC ${state.selectedDataCenterID}`;
  elements.lastUpdate.textContent = state.lastUpdateAt === 0
    ? "-"
    : new Date(state.lastUpdateAt).toLocaleTimeString
      (getSelectedLanguage().locale, { hour12: false, hour: "2-digit", minute: "2-digit" });
}

function renderInstances() {
  const visibleAreas = state.catalog.areas
    .filter(area => area.serverGroups.includes(getSelectedDataCenter().serverGroup));
  const gameplayEventKeys = new Map(state.catalog.gameplays.map(gameplay => [gameplay.code, new Set()]));
  for (const area of visibleAreas) {
    const eventKeys = gameplayEventKeys.get(area.gameplay);
    if (!eventKeys) continue;
    for (const territoryID of area.territoryIDs)
      for (const event of area.events)
        eventKeys.add(`${territoryID}:${event.eventType}:${event.eventID}`);
  }
  const query = state.instanceSearch.trim();
  const instances = [...state.instances.values()].filter(instance =>
    query === "" || String(instance.zoneServerID).includes(query));
  instances.sort(state.sort === "server"
    ? (left, right) => left.zoneServerID - right.zoneServerID
    : (left, right) => right.lastReceivedAt - left.lastReceivedAt);

  if (instances.length === 0 && query !== "") {
    const empty = document.createElement("p");
    empty.className = "instance-empty";
    empty.textContent = t("instanceSearchEmpty");
    elements.instanceList.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  const now = getServerNowSeconds();
  const activeInstances = instances.filter(instance => now - instance.lastReceivedAt < 3600);
  const idleInstances = instances.filter(instance => now - instance.lastReceivedAt >= 3600);
  for (const instance of activeInstances)
    fragment.append(createInstanceButton(instance, gameplayEventKeys));
  if (activeInstances.length > 0 && idleInstances.length > 0) {
    const divider = document.createElement("div");
    divider.className = "instance-divider";
    divider.setAttribute("role", "separator");
    fragment.append(divider);
  }
  for (const instance of idleInstances)
    fragment.append(createInstanceButton(instance, gameplayEventKeys));

  elements.instanceList.replaceChildren(fragment);
}

function createInstanceButton(instance, gameplayEventKeys) {
  const active = getServerNowSeconds() - instance.lastReceivedAt < 3600;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "instance-button";
  button.ariaCurrent = String(instance.zoneServerID === state.selectedZoneServerID);
  const gameplayIcons = state.catalog.gameplays.map(gameplay => {
    const eventKeys = gameplayEventKeys.get(gameplay.code) ?? [];
    const hasData = [...eventKeys].some(key => instance.eventLastSeen[key]);
    const gameplayName = gameplay.localizedNames[getSelectedLanguage().code] ?? gameplay.localizedNames.CHS;
    return `<img class="instance-gameplay-icon${hasData ? " has-data" : ""}" src="/assets/icons/${gameplay.iconID}.png" alt="${gameplayName}" title="${gameplayName}">`;
  }).join("");
  button.innerHTML = `
    <span class="instance-content">
      <span class="instance-top">
        <span class="instance-id">${instance.zoneServerID}</span>
        <span class="instance-state${active ? " active" : " idle"}">${active ? t("instanceActive") : t("instanceIdle")}</span>
      </span>
      <span class="instance-gameplays">${gameplayIcons}</span>
      <time class="instance-time" data-relative-time="${instance.lastReceivedAt}">${formatRelativeTime(instance.lastReceivedAt)}</time>
    </span>`;
  button.addEventListener("click", () => {
    state.selectedZoneServerID = instance.zoneServerID;
    state.areaSelectorOpen = false;
    updateURL();
    renderInstances();
    renderDetails();
  });
  return button;
}

function renderDetails() {
  const instance = state.selectedZoneServerID === null ? null : state.instances.get(state.selectedZoneServerID);
  elements.emptyState.hidden = instance !== null && instance !== undefined;
  elements.areaList.hidden = !instance;

  if (!instance) {
    elements.detailHeading.textContent = t("selectInstance");
    elements.instanceMeta.textContent = "";
    elements.emptyStateText.textContent = state.instances.size > 0
      ? t("noValidInstanceSelected")
      : t("noValidInstances");
    elements.areaList.replaceChildren();
    return;
  }

  elements.detailHeading.textContent = t("instanceId", { id: instance.zoneServerID });
  elements.instanceMeta.textContent = t("instanceMeta", { epoch: instance.instanceEpoch, revision: instance.revision });
  const serverGroup = getSelectedDataCenter().serverGroup;
  const areas = state.catalog.areas.filter(area => area.serverGroups.includes(serverGroup));
  if (areas.length === 0) {
    elements.areaList.replaceChildren();
    return;
  }

  const storedAreaCode = localStorage.getItem(getAreaStorageKey(serverGroup));
  if (!areas.some(area => area.code === state.selectedAreaCode))
    state.selectedAreaCode = areas.some(area => area.code === storedAreaCode)
      ? storedAreaCode
      : areas[0].code;

  const fragment = document.createDocumentFragment();
  const area = areas.find(item => item.code === state.selectedAreaCode);
  const section = document.createElement("section");
  section.className = "area-section";
  const observed = area.events.filter(event =>
    instance.eventLastSeen[`${area.territoryIDs[0]}:${event.eventType}:${event.eventID}`]).length;
  const contentLanguageCode = getSelectedLanguage().code;
  const chapterName = area.localizedNames[contentLanguageCode] ?? area.name;
  const mapName = area.mapNames[contentLanguageCode] ?? area.mapNames.CHS;
  const gameplay = state.catalog.gameplays.find(item => item.code === area.gameplay);
  const header = createAreaHeader(gameplay, chapterName, mapName, observed, area.events.length);
  const panel = createAreaPanel(instance, areas, contentLanguageCode);
  const copyProfile = getCopyProfile(area.gameplay);
  const copyEnabled = copyProfile.enabled !== false;
  section.append(header, panel);

  const wrapper = document.createElement("div");
  wrapper.className = "ce-table-wrap";
  const table = document.createElement("table");
  table.className = "ce-table";
  const sortState = state.eventSort === "desc"
    ? { ariaSort: "descending", indicator: "↓" }
    : state.eventSort === "asc"
      ? { ariaSort: "ascending", indicator: "↑" }
      : { ariaSort: "none", indicator: "↕" };
  table.innerHTML = `
    <colgroup><col style="width:${copyEnabled ? "54%" : "60%"}"><col style="width:${copyEnabled ? "31%" : "40%"}">${copyEnabled ? "<col style=\"width:15%\">" : ""}</colgroup>
    <thead><tr><th scope="col">${t("eventName")}</th><th scope="col" class="ce-sortable" aria-sort="${sortState.ariaSort}"><button type="button" class="ce-sort-button">${t("lastSeen")}<span class="ce-sort-indicator" aria-hidden="true">${sortState.indicator}</span></button></th>${copyEnabled ? `<th scope="col" class="ce-actions-heading">${t("copyColumn")}</th>` : ""}</tr></thead>`;
  table.querySelector(".ce-sort-button").addEventListener("click", () => {
    state.eventSort = state.eventSort === "default"
      ? "desc"
      : state.eventSort === "desc"
        ? "asc"
        : "default";
    localStorage.setItem("ce-crowdsource-event-sort", state.eventSort);
    renderDetails();
  });
  const body = document.createElement("tbody");
  const rows = [];
  const renderedLinkedGroups = new Set();

  for (const catalogEvent of area.events) {
    const linkedGroup = getLinkedCopyGroup(copyProfile, area, catalogEvent);
    if (linkedGroup) {
      if (renderedLinkedGroups.has(linkedGroup))
        continue;
      renderedLinkedGroups.add(linkedGroup);
      rows.push(createLinkedEventRows(area, linkedGroup, instance, contentLanguageCode, copyEnabled));
      continue;
    }

    const event = instance.eventLastSeen[
      `${area.territoryIDs[0]}:${catalogEvent.eventType}:${catalogEvent.eventID}`
    ];
    const row = document.createElement("tr");
    const name = catalogEvent.localizedNames[contentLanguageCode] ??
      `${catalogEvent.eventType} ${catalogEvent.eventID}`;
    const triggerDescription = catalogEvent.triggerDescriptions
      ? catalogEvent.triggerDescriptions[contentLanguageCode] ?? catalogEvent.triggerDescriptions.CHS ?? ""
      : t("naturalOccurrence");
    const icon = catalogEvent.iconID
      ? `<img src="/assets/icons/${catalogEvent.iconID}.png" alt="" width="20" height="20" class="ce-icon">`
      : "";
    const mapButton = catalogEvent.mapPosition
      ? `<button class="ce-map-link" type="button"><img src="/assets/icons/60561.png" alt="" width="20" height="20"></button>`
      : "";
    row.innerHTML = `
      <td class="ce-name"><span class="ce-name-inner">${icon}<span class="ce-name-content"><span class="ce-name-text"></span>${triggerDescription ? `<span class="ce-trigger"></span>` : ""}</span>${mapButton}</span></td>
      <td class="ce-last-seen">${event
        ? `<span class="ce-relative" data-relative-time="${event.lastSpawnedAt}">${formatRelativeTime(event.lastSpawnedAt)}</span><span class="ce-absolute">${formatAbsoluteTime(event.lastSpawnedAt)}</span>`
        : `<span class="ce-relative placeholder">-</span>`}</td>${copyEnabled ? `<td class="ce-actions"></td>` : ""}`;
    row.querySelector(".ce-name-text").textContent = name;
    if (triggerDescription)
      row.querySelector(".ce-trigger").textContent = triggerDescription;
    const mapButtonElement = row.querySelector(".ce-map-link");
    if (mapButtonElement) {
      mapButtonElement.setAttribute("aria-label", t("openMap"));
      mapButtonElement.title = t("openMap");
      mapButtonElement.addEventListener("click", () => openEventMap(area, catalogEvent, name));
    }
    if (copyEnabled) {
      const copyButton = createCopyButton(getCopyText(area, catalogEvent, instance, contentLanguageCode));
      copyButton.dataset.eventType = catalogEvent.eventType;
      copyButton.dataset.eventID = String(catalogEvent.eventID);
      row.querySelector(".ce-actions").append(copyButton);
    }
    rows.push({ event, rows: [row] });
  }

  if (state.eventSort !== "default") {
    rows.sort(state.eventSort === "desc"
      ? (left, right) => (right.event?.lastSpawnedAt ?? -Infinity) - (left.event?.lastSpawnedAt ?? -Infinity)
      : (left, right) => (left.event?.lastSpawnedAt ?? Infinity) - (right.event?.lastSpawnedAt ?? Infinity));
  }
  for (const { rows: rowGroup } of rows)
    body.append(...rowGroup);

  table.append(body);
  wrapper.append(table);
  section.append(wrapper);
  fragment.append(section);
  elements.areaList.replaceChildren(fragment);
}

function createLinkedEventRows(area, group, instance, contentLanguageCode, copyEnabled) {
  const entries = getLinkedGroupEntries(area, group);
  const records = entries.map(event => ({ event, lastSeen: getEventLastSeen(area, event, instance) }));
  const latest = records
    .filter(item => item.lastSeen)
    .reduce((current, item) => !current || item.lastSeen.lastSpawnedAt > current.lastSeen.lastSpawnedAt ? item : current, null);
  const now = getServerNowSeconds();
  const predictionToleranceMinutes = group.predictionToleranceMinutes ?? group.intervalMinutes + 5;
  const predictionExpiresAt = latest
    ? latest.lastSeen.lastSpawnedAt + predictionToleranceMinutes * 60
    : 0;
  const predictionActive = latest && now <= predictionExpiresAt;
  const latestIndex = predictionActive ? records.indexOf(latest) : -1;
  const nextIndex = predictionActive ? (latestIndex + 1) % records.length : -1;
  const refreshAt = predictionActive
    ? latest.lastSeen.lastSpawnedAt + group.intervalMinutes * 60
    : 0;
  const rows = [];
  for (const [index, catalogEvent] of entries.entries()) {
    const name = getLocalizedEventName(catalogEvent, contentLanguageCode);
    const triggerDescription = catalogEvent.triggerDescriptions
      ? catalogEvent.triggerDescriptions[contentLanguageCode] ?? catalogEvent.triggerDescriptions.CHS ?? ""
      : t("naturalOccurrence");
    const row = document.createElement("tr");
    row.className = "ce-linked-row";
    if (predictionActive)
      row.dataset.linkedPredictionExpires = String(predictionExpiresAt);
    row.innerHTML = `
      <td class="ce-name"><span class="ce-name-inner">${catalogEvent.iconID
      ? `<img src="/assets/icons/${catalogEvent.iconID}.png" alt="" width="20" height="20" class="ce-icon">`
      : ""}<span class="ce-name-content"><span class="ce-name-text"></span>${triggerDescription ? `<span class="ce-trigger"></span>` : ""}</span>${catalogEvent.mapPosition
      ? `<button class="ce-map-link" type="button"><img src="/assets/icons/60561.png" alt="" width="20" height="20"></button>`
      : ""}</span></td>
      <td class="ce-last-seen"></td>${copyEnabled ? `<td class="ce-actions"></td>` : ""}`;
    row.querySelector(".ce-name-text").textContent = name;
    if (triggerDescription)
      row.querySelector(".ce-trigger").textContent = triggerDescription;
    const mapButton = row.querySelector(".ce-map-link");
    if (mapButton) {
      mapButton.setAttribute("aria-label", t("openMap"));
      mapButton.title = t("openMap");
      mapButton.addEventListener("click", () => openEventMap(area, catalogEvent, name));
    }
    const statusCell = row.querySelector(".ce-last-seen");
    if (index === nextIndex) {
      statusCell.innerHTML = `
        <span class="ce-relative ce-linked-future" data-future-time="${refreshAt}">${formatFutureMinutes(refreshAt)}</span>
        <span class="ce-linked-future-time">${t("futureRefreshAt", { time: formatAbsoluteTime(refreshAt) })}</span>`;
    } else if (records[index].lastSeen) {
      statusCell.innerHTML = `
        <span class="ce-relative" data-relative-time="${records[index].lastSeen.lastSpawnedAt}">${formatRelativeTime(records[index].lastSeen.lastSpawnedAt)}</span>
        <span class="ce-absolute">${formatAbsoluteTime(records[index].lastSeen.lastSpawnedAt)}</span>`;
    } else {
      statusCell.innerHTML = `<span class="ce-relative placeholder">-</span>`;
    }
    if (copyEnabled) {
      const copyButton = createCopyButton(getCopyText(area, catalogEvent, instance, contentLanguageCode));
      copyButton.dataset.eventType = catalogEvent.eventType;
      copyButton.dataset.eventID = String(catalogEvent.eventID);
      row.querySelector(".ce-actions").append(copyButton);
    }
    rows.push(row);
  }

  return { event: latest?.lastSeen, rows };
}

function clearMapSelection() {
  state.mapImageOverlay?.remove();
  state.mapMarker?.remove();
  state.mapImageOverlay = null;
  state.mapMarker = null;
}

async function openEventMap(area, catalogEvent, eventName) {
  const requestToken = ++state.mapRequestToken;
  elements.mapDialogTitle.textContent = eventName;
  elements.mapStatus.textContent = t("mapLoading");
  elements.mapStatus.hidden = false;
  elements.mapCanvas.setAttribute("aria-busy", "true");
  if (!elements.mapDialog.open)
    elements.mapDialog.showModal();

  try {
    if (!state.map) {
      const L = YZWF.eorzeaMap.L;
      state.map = L.map(elements.mapCanvas, {
        attributionControl: false,
        crs: L.CRS.Simple,
        inertiaMaxSpeed: 5_000,
        maxBounds: [[0, 0], [2048, 2048]],
        maxBoundsViscosity: 1,
        maxZoom: 4,
        minZoom: -3,
        zoomSnap: 0,
        zoomControl: false
      });
      state.map.fitBounds([[0, 0], [2048, 2048]]);
    }
    if (requestToken !== state.mapRequestToken)
      return;

    clearMapSelection();
    state.map.mapInfo = {
      "#": String(area.mapID),
      id: String(area.mapID),
      sizeFactor: 100,
      "offset{X}": 0,
      "offset{Y}": 0
    };
    state.map.invalidateSize();

    const imageOverlay = YZWF.eorzeaMap.L.imageOverlay(
      `/assets/eorzea-map/maps/${area.mapID}.webp`,
      [[0, 0], [2048, 2048]],
      { interactive: false }
    );
    const imageLoaded = new Promise((resolve, reject) => {
      imageOverlay.once("load", resolve);
      imageOverlay.once("error", () => reject(new Error(`Failed to load map ${area.mapID}`)));
    });
    state.mapImageOverlay = imageOverlay;
    imageOverlay.addTo(state.map).bringToBack();
    await imageLoaded;
    if (requestToken !== state.mapRequestToken) {
      imageOverlay.remove();
      return;
    }

    const { x, y } = catalogEvent.mapPosition;
    const marker = YZWF.eorzeaMap.simpleMarker(
      x,
      y,
      "/assets/icons/60561.png",
      state.map.mapInfo
    );
    marker.bindTooltip(eventName, { className: "ce-map-tooltip", direction: "top", offset: [0, -14] });
    state.mapMarker = marker.addTo(state.map);
    state.map.fitBounds([[0, 0], [2048, 2048]], { animate: false });
    elements.mapStatus.hidden = true;
    elements.mapCanvas.removeAttribute("aria-busy");
  } catch (error) {
    console.error(error);
    if (requestToken !== state.mapRequestToken)
      return;
    clearMapSelection();
    elements.mapStatus.textContent = t("mapLoadError");
    elements.mapCanvas.removeAttribute("aria-busy");
  }
}

function getAreaStorageKey(serverGroup) {
  return `ce-crowdsource-area-${serverGroup}`;
}

function createAreaHeader(gameplay, chapterName, mapName, observedCount, eventCount) {
  const header = document.createElement("div");
  header.className = "area-header";
  header.role = "button";
  header.tabIndex = 0;
  header.ariaExpanded = String(state.areaSelectorOpen);
  header.setAttribute("aria-controls", "areaSelectorPanel");
  const icon = document.createElement("img");
  icon.className = "area-header-icon";
  icon.src = `/assets/icons/${gameplay.iconID}.png`;
  icon.width = 24;
  icon.height = 24;
  icon.alt = "";
  const heading = document.createElement("h3");
  heading.textContent = `${chapterName} · ${mapName}`;
  const count = document.createElement("span");
  count.className = "area-header-count";
  count.textContent = `${observedCount} / ${eventCount}`;
  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("class", "area-header-chevron");
  chevron.setAttribute("viewBox", "0 0 24 24");
  chevron.setAttribute("fill", "none");
  chevron.setAttribute("stroke", "currentColor");
  chevron.setAttribute("stroke-width", "2");
  chevron.setAttribute("stroke-linecap", "round");
  chevron.setAttribute("stroke-linejoin", "round");
  chevron.setAttribute("aria-hidden", "true");
  chevron.innerHTML = `<path d="m6 9 6 6 6-6"></path>`;
  header.append(icon, heading, count, chevron);
  header.addEventListener("click", toggleAreaSelector);
  header.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleAreaSelector();
    }
  });
  return header;
}

function toggleAreaSelector() {
  state.areaSelectorOpen = !state.areaSelectorOpen;
  renderDetails();
  const focusTarget = state.areaSelectorOpen
    ? elements.areaList.querySelector('.region-option[aria-pressed="true"]')
    : elements.areaList.querySelector(".area-header");
  focusTarget?.focus();
}

function closeAreaSelector() {
  if (!state.areaSelectorOpen) return;
  state.areaSelectorOpen = false;
  renderDetails();
  elements.areaList.querySelector(".area-header")?.focus();
}

function createAreaPanel(instance, areas, contentLanguageCode) {
  const panel = document.createElement("div");
  panel.className = "region-panel";
  panel.id = "areaSelectorPanel";
  panel.role = "group";
  panel.setAttribute("aria-label", t("areaSelectorAriaLabel"));
  panel.hidden = !state.areaSelectorOpen;
  for (const gameplay of state.catalog.gameplays) {
    const gameplayAreas = areas.filter(area => area.gameplay === gameplay.code);
    if (gameplayAreas.length === 0) continue;

    const group = document.createElement("section");
    group.className = "region-group";
    const head = document.createElement("div");
    head.className = "region-group-head";
    const icon = document.createElement("img");
    icon.className = "region-group-icon";
    icon.src = `/assets/icons/${gameplay.iconID}.png`;
    icon.width = 26;
    icon.height = 26;
    icon.alt = "";
    const gameplayName = gameplay.localizedNames[contentLanguageCode] ?? gameplay.localizedNames.CHS;
    const heading = document.createElement("h3");
    heading.className = "region-group-name";
    heading.textContent = gameplayName;
    head.append(icon, heading);
    group.append(head);

    const options = document.createElement("div");
    options.className = "region-group-options";
    for (const area of gameplayAreas) {
      const observed = area.events.filter(event =>
        instance.eventLastSeen[`${area.territoryIDs[0]}:${event.eventType}:${event.eventID}`]).length;
      const selected = area.code === state.selectedAreaCode;
      const option = document.createElement("button");
      option.type = "button";
      option.className = "region-option";
      option.dataset.areaCode = area.code;
      option.ariaPressed = String(selected);
      option.tabIndex = selected ? 0 : -1;
      option.innerHTML = `
        <svg class="region-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>
        <span class="region-option-name"></span>
        <span class="region-option-count">${observed} / ${area.events.length}</span>`;
      option.querySelector(".region-option-name").textContent =
        area.localizedNames[contentLanguageCode] ?? area.name;
      option.addEventListener("click", () => {
        state.selectedAreaCode = area.code;
        state.areaSelectorOpen = false;
        localStorage.setItem(getAreaStorageKey(getSelectedDataCenter().serverGroup), area.code);
        renderDetails();
        elements.areaList.querySelector(".area-header")?.focus();
      });
      options.append(option);
    }
    group.append(options);
    panel.append(group);
  }

  return panel;
}

function updateRelativeTimes() {
  const now = getServerNowSeconds();
  if ([...document.querySelectorAll("[data-linked-prediction-expires]")]
    .some(element => Number(element.dataset.linkedPredictionExpires) < now)) {
    renderDetails();
    renderSummary();
    return;
  }
  for (const element of document.querySelectorAll("[data-relative-time]"))
    element.textContent = formatRelativeTime(Number(element.dataset.relativeTime));
  for (const element of document.querySelectorAll("[data-future-time]"))
    element.textContent = formatFutureMinutes(Number(element.dataset.futureTime));
  updateCopyButtonTexts();
  renderSummary();
}

function getCopyProfile(gameplayCode) {
  return copyConfiguration.gameplays[gameplayCode] ?? copyConfiguration.default;
}

function getCopyRule(profile, area, catalogEvent) {
  return profile.rules?.find(rule =>
    (!rule.eventType || rule.eventType === catalogEvent.eventType) &&
    (!rule.eventIDs || rule.eventIDs.includes(catalogEvent.eventID)) &&
    (!rule.areaCodes || rule.areaCodes.includes(area.code)));
}

function getLinkedCopyGroup(profile, area, catalogEvent) {
  return profile.linkedGroups?.find(group =>
    group.eventType === catalogEvent.eventType &&
    group.areaCodes.includes(area.code) &&
    group.eventIDs.includes(catalogEvent.eventID));
}

function getLinkedGroupEntries(area, group) {
  return group.eventIDs
    .map(eventID => area.events.find(event =>
      event.eventType === group.eventType && event.eventID === eventID))
    .filter(Boolean);
}

function getEventLastSeen(area, catalogEvent, instance) {
  return instance.eventLastSeen[
    `${area.territoryIDs[0]}:${catalogEvent.eventType}:${catalogEvent.eventID}`
  ];
}

function getLocalizedEventName(catalogEvent, contentLanguageCode) {
  return catalogEvent.localizedNames[contentLanguageCode] ??
    catalogEvent.localizedNames.CHS ??
    `${catalogEvent.eventType} ${catalogEvent.eventID}`;
}

function getCopyText(area, catalogEvent, instance, contentLanguageCode) {
  const profile = getCopyProfile(area.gameplay);
  const linkedGroup = getLinkedCopyGroup(profile, area, catalogEvent);
  if (linkedGroup)
    return formatLinkedCopyText(area, linkedGroup, instance, contentLanguageCode);

  const name = getLocalizedEventName(catalogEvent, contentLanguageCode);
  const event = getEventLastSeen(area, catalogEvent, instance);
  const rule = getCopyRule(profile, area, catalogEvent);
  const cooldownMinutes = rule?.cooldownMinutes ??
    profile.cooldownMinutesByEventType?.[catalogEvent.eventType] ??
    null;
  const format = rule?.format ?? (cooldownMinutes === null ? "lastSeen" : "cooldown");
  return format === "lastSeen"
    ? formatLastSeenCopyText(name, event)
    : formatCooldownCopyText(name, event, cooldownMinutes);
}

function formatLastSeenCopyText(name, event) {
  return `${name}【${t("copyLastSeen", { time: formatCopyLastSeenTime(event) })}】`;
}

function formatCooldownCopyText(name, event, cooldownMinutes) {
  const now = getServerNowSeconds();
  const difference = event ? Math.max(0, now - event.lastSpawnedAt) : Number.POSITIVE_INFINITY;
  const status = difference >= cooldownMinutes * 60
    ? t("copyAvailable")
    : t("copyWaitingMinutes", { minutes: Math.max(1, Math.ceil((cooldownMinutes * 60 - difference) / 60)) });
  return `${name}（${status}）【${t("copyLastSeen", { time: formatCopyLastSeenTime(event) })}】`;
}

function formatCopyLastSeenTime(event) {
  if (!event)
    return t("copyNoRecord");
  if (getServerNowSeconds() - event.lastSpawnedAt >= 21_600)
    return t("copyLongAgo");
  return `${formatAbsoluteTime(event.lastSpawnedAt)}（${formatCopyRelativeTime(event.lastSpawnedAt)}）`;
}

function formatCopyRelativeTime(unixSeconds) {
  const difference = Math.max(0, getServerNowSeconds() - unixSeconds);
  if (difference < 60)
    return t("copySecondsAgo", { value: difference });
  if (difference < 3600)
    return t("copyMinutesAgo", { value: Math.floor(difference / 60) });
  return t("copyHoursAgo", { value: Math.floor(difference / 3600) });
}

function formatLinkedCopyText(area, group, instance, contentLanguageCode) {
  const entries = getLinkedGroupEntries(area, group);
  const records = entries.map(event => ({ event, lastSeen: getEventLastSeen(area, event, instance) }));
  if (records.every(item => !item.lastSeen))
    return `${entries.map(event => getLocalizedEventName(event, contentLanguageCode)).join("/")}【${t("copyNaturalRefresh")}】`;

  const latest = records
    .filter(item => item.lastSeen)
    .reduce((current, item) => item.lastSeen.lastSpawnedAt > current.lastSeen.lastSpawnedAt ? item : current);
  const now = getServerNowSeconds();
  const predictionToleranceMinutes = group.predictionToleranceMinutes ?? group.intervalMinutes + 5;
  if (now - latest.lastSeen.lastSpawnedAt > predictionToleranceMinutes * 60)
    return `${entries.map(event => getLocalizedEventName(event, contentLanguageCode)).join("/")}【${t("copyNaturalRefresh")}】`;

  const intervalSeconds = group.intervalMinutes * 60;
  const latestIndex = records.indexOf(latest);
  const nextIndex = (latestIndex + 1) % records.length;
  const nextEvent = entries[nextIndex];
  const refreshAt = latest.lastSeen.lastSpawnedAt + intervalSeconds;
  const nextName = getLocalizedEventName(nextEvent, contentLanguageCode);
  if (refreshAt <= now)
    return `${nextName}【${t("copyNaturalRefresh")}】`;
  const minutes = Math.ceil((refreshAt - now) / 60);
  return `${formatCopyRefreshTime(refreshAt)}（${t("copyWaitingMinutes", { minutes })}）${t("copyRefreshSuffix")}【${nextName}】`;
}

function formatCopyRefreshTime(unixSeconds) {
  return new Intl.DateTimeFormat(getSelectedLanguage().locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(unixSeconds * 1000));
}

function formatFutureMinutes(unixSeconds) {
  const minutes = Math.max(0, Math.ceil((unixSeconds - getServerNowSeconds()) / 60));
  return t("futureMinutes", { minutes });
}

function updateCopyButtonTexts() {
  const instance = state.selectedZoneServerID === null
    ? null
    : state.instances.get(state.selectedZoneServerID);
  const area = state.catalog?.areas.find(item => item.code === state.selectedAreaCode);
  if (!instance || !area)
    return;
  const contentLanguageCode = getSelectedLanguage().code;
  for (const button of document.querySelectorAll(".ce-copy-button")) {
    const catalogEvent = area.events.find(event =>
      event.eventType === button.dataset.eventType &&
      String(event.eventID) === button.dataset.eventID);
    if (catalogEvent)
      button.title = getCopyText(area, catalogEvent, instance, contentLanguageCode);
  }
}

function createCopyButton(copyText) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ce-copy-button";
  button.setAttribute("aria-label", t("copy"));
  button.title = copyText;
  button.innerHTML = `
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>`;
  button.addEventListener("click", async () => {
    try {
      await copyTextToClipboard(button.title);
      button.classList.add("is-copied");
      window.setTimeout(() => button.classList.remove("is-copied"), 1_200);
      showCopyToast();
    } catch (error) {
      console.error(error);
    }
  });
  return button;
}

function showCopyToast() {
  window.clearTimeout(state.copyToastTimer);
  elements.copyToast.textContent = t("copySuccess");
  elements.copyToast.setAttribute("aria-hidden", "false");
  elements.copyToast.classList.add("is-visible");
  state.copyToastTimer = window.setTimeout(() => {
    elements.copyToast.classList.remove("is-visible");
    elements.copyToast.setAttribute("aria-hidden", "true");
  }, 2_200);
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      console.debug("Clipboard API unavailable, using fallback.", error);
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied)
    throw new Error("Clipboard access is unavailable");
}

function getServerNowSeconds() {
  return Math.floor((Date.now() + state.serverOffsetMS) / 1000);
}

function getSelectedLanguage() {
  return state.languages.find(language => language.code === getUILanguage().contentLanguageCode);
}

function getSelectedDataCenter() {
  return state.dataCenters.find(dataCenter => dataCenter.id === state.selectedDataCenterID);
}

function formatAbsoluteTime(unixSeconds) {
  return new Intl.DateTimeFormat(getSelectedLanguage().locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(unixSeconds * 1000));
}

function formatRelativeTime(unixSeconds) {
  const difference = Math.max(0, getServerNowSeconds() - unixSeconds);
  const formatter = new Intl.RelativeTimeFormat(getSelectedLanguage().locale, { numeric: "always" });
  if (difference < 60) return formatter.format(-difference, "second");
  if (difference < 3600) return formatter.format(-Math.floor(difference / 60), "minute");
  return formatter.format(-Math.floor(difference / 3600), "hour");
}

initialize().catch(error => {
  console.error(error);
  setConnectionState("offline", "statusLoadError");
});
