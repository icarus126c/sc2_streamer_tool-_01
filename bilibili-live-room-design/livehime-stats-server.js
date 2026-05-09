const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const port = Number(process.env.PORT || 27392);
const host = "127.0.0.1";
const dataPath = path.join(__dirname, "livehime-stats-data.json");
const replayConfigPath = path.join(__dirname, "replay-config.json");
const mmrApiConfigPath = path.join(__dirname, "mmr-api-config.json");
const CN_MMR_ESTIMATE_DEFAULT_K = 44;
const CN_MMR_ESTIMATE_SCALE = 850;

let state = loadState();
const clients = new Set();
const replayConfig = loadReplayConfig();
let mmrApiConfig = loadMmrApiConfig();
const seenReplayKeys = new Set(state.processedReplays || []);
const seenReplayPaths = new Set(state.processedReplayPaths || []);
const pendingReplayChecks = new Map();
let activeMmrApiRefresh = null;
let mmrApiTimer = null;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${host}:${port}`);

  if (url.pathname === "/" || url.pathname === "/view") {
    sendHtml(response, renderPage(false));
    return;
  }

  if (url.pathname === "/control") {
    sendHtml(response, renderPage(true));
    return;
  }

  if (url.pathname === "/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });
    response.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }

  if (url.pathname === "/state") {
    sendJson(response, snapshot());
    return;
  }

  if (url.pathname === "/ticker") {
    if (request.method === "GET") {
      const text = url.searchParams.get("text");
      if (text !== null) {
        updateTickerText(text);
        saveState();
        broadcast();
      }
      sendJson(response, { ok: true, tickerText: state.tickerText });
      return;
    }
    if (request.method === "POST") {
      readBody(request, (body) => {
        updateTickerText(body.text ?? body.tickerText ?? "");
        saveState();
        broadcast();
        sendJson(response, { ok: true, tickerText: state.tickerText });
      });
      return;
    }
  }

  if (url.pathname === "/action" && request.method === "POST") {
    readBody(request, (body) => {
      const action = body.action;
      if (action === "win") addResult("W");
      if (action === "loss") addResult("L");
      if (action === "undo") undo();
      if (action === "pause") togglePause();
      if (action === "reset") resetStats();
      if (action === "scanLatest") scanLatestReplay(true);
      if (action === "clearPending") clearPendingReplay();
      if (action === "refreshMmrApi") refreshMmrFromApi({ force: true });
      if (action === "mmrApiConfig") updateMmrApiConfig(body);
      if (action === "title") {
        state.title = String(body.title || "星灵折跃频道").slice(0, 32);
      }
      if (action === "ticker") updateTickerText(body.tickerText ?? body.text ?? "");
      if (action === "overlay") updateOverlayInfo(body);
      saveState();
      broadcast();
      sendJson(response, snapshot());
    });
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.listen(port, host, () => {
  console.log(`SC2 直播姬统计工具已启动`);
  console.log(`直播姬网页源: http://${host}:${port}/view`);
  console.log(`控制页面:     http://${host}:${port}/control`);
  startReplayWatcher();
  startMmrApiRefresher();
});

function defaults() {
  return {
    title: "星灵折跃频道",
    subtitle: "本次直播战况",
    tickerText: "欢迎来到星灵折跃频道",
    startedAt: Date.now(),
    elapsedBeforePause: 0,
    paused: false,
    wins: 0,
    losses: 0,
    history: [],
    processedReplays: [],
    processedReplayPaths: [],
    pendingReplays: [],
    replayHistory: [],
    lastMatch: null,
    mmrApi: defaultMmrApiState(),
    overlay: defaultOverlay()
  };
}

function loadState() {
  try {
    return normalizeState({ ...defaults(), ...readJsonFile(dataPath) });
  } catch {
    return defaults();
  }
}

function defaultOverlay() {
  return {
    currentMmr: "--",
    showInfoLine: true,
    chromeOpacity: 100,
    theme: "protoss",
    matchups: {
      vT: { wins: 0, losses: 0 },
      vZ: { wins: 0, losses: 0 },
      vP: { wins: 0, losses: 0 }
    }
  };
}

function defaultMmrApiState() {
  return {
    provider: "sc2pulse",
    status: "idle",
    message: "",
    lastUpdatedAt: null,
    lastTriedAt: null,
    toonHandle: "",
    race: "",
    rating: null,
    source: ""
  };
}

function normalizeState(input) {
  const normalized = { ...defaults(), ...input };
  normalized.tickerText = String(input.tickerText ?? defaults().tickerText).slice(0, 160);
  normalized.overlay = mergeOverlay(input.overlay);
  normalized.history = Array.isArray(normalized.history) ? normalized.history : [];
  normalized.pendingReplays = Array.isArray(normalized.pendingReplays) ? normalized.pendingReplays : [];
  normalized.processedReplays = Array.isArray(normalized.processedReplays) ? normalized.processedReplays : [];
  normalized.processedReplayPaths = Array.isArray(normalized.processedReplayPaths) ? normalized.processedReplayPaths : [];
  normalized.replayHistory = Array.isArray(normalized.replayHistory) ? normalized.replayHistory : [];
  normalized.mmrApi = { ...defaultMmrApiState(), ...(input.mmrApi || {}) };
  const processedKeys = new Set(normalized.processedReplays);
  const processedPaths = new Set(normalized.processedReplayPaths);
  const historyReplayKeys = new Set(normalized.history.map((entry) => entry?.replay?.key).filter(Boolean));
  const historyReplayPaths = new Set(normalized.history.map((entry) => entry?.replay?.path).filter(Boolean));
  normalized.pendingReplays = normalized.pendingReplays.filter((replay) => {
    if (!replay) return false;
    if (processedKeys.has(replay.key) || processedPaths.has(replay.path)) return false;
    if (historyReplayKeys.has(replay.key) || historyReplayPaths.has(replay.path)) return false;
    return true;
  });
  return normalized;
}

function mergeOverlay(input = {}) {
  const overlay = defaultOverlay();
  overlay.currentMmr = String(input.currentMmr ?? overlay.currentMmr);
  overlay.showInfoLine = input.showInfoLine !== false && input.showInfoLine !== "false" && input.showInfoLine !== "0";
  overlay.chromeOpacity = clampNumber(input.chromeOpacity ?? overlay.chromeOpacity, 0, 100);
  overlay.theme = normalizeTheme(input.theme ?? overlay.theme);
  for (const key of Object.keys(overlay.matchups)) {
    overlay.matchups[key].wins = Number(input.matchups?.[key]?.wins ?? overlay.matchups[key].wins) || 0;
    overlay.matchups[key].losses = Number(input.matchups?.[key]?.losses ?? overlay.matchups[key].losses) || 0;
  }
  return overlay;
}

function saveState() {
  fs.writeFileSync(dataPath, JSON.stringify(state, null, 2), "utf8");
}

function updateTickerText(text) {
  state.tickerText = String(text || defaults().tickerText).slice(0, 160);
}

function addResult(result, replayOverride = null) {
  if (result === "W") state.wins += 1;
  if (result === "L") state.losses += 1;
  const replay = replayOverride || state.pendingReplays.shift() || null;
  if (replayOverride) {
    state.pendingReplays = state.pendingReplays.filter((item) => item.key !== replayOverride.key && item.path !== replayOverride.path);
  }
  const matchupKey = replay?.parsed ? getMatchupKey(replay.parsed) : null;
  if (replay?.parsed) updateOverlayFromMatch(replay.parsed, result);
  const entry = {
    result,
    at: Date.now(),
    replay,
    matchupKey
  };
  state.history.push(entry);
  if (replay) {
    state.replayHistory.push(entry);
    rememberReplay(replay.key);
    rememberReplayPath(replay.path);
  }
  if (replay?.parsed && mmrApiConfig.enabled && mmrApiConfig.updateAfterReplay) refreshMmrFromApi({ match: replay.parsed, force: true });
  updateReplaySubtitle();
}

function undo() {
  const last = state.history.pop();
  const result = typeof last === "string" ? last : last?.result;
  if (result === "W") state.wins = Math.max(0, state.wins - 1);
  if (result === "L") state.losses = Math.max(0, state.losses - 1);
  if (last?.replay) {
    state.pendingReplays.unshift(last.replay);
    state.replayHistory = state.replayHistory.filter((entry) => entry.at !== last.at);
  }
  if (last?.matchupKey) decrementMatchup(last.matchupKey, result);
  updateReplaySubtitle();
}

function togglePause() {
  if (state.paused) {
    state.startedAt = Date.now() - state.elapsedBeforePause;
    state.paused = false;
  } else {
    state.elapsedBeforePause = Date.now() - state.startedAt;
    state.paused = true;
  }
}

function resetStats() {
  state.startedAt = Date.now();
  state.elapsedBeforePause = 0;
  state.paused = false;
  state.wins = 0;
  state.losses = 0;
  state.history = [];
  state.pendingReplays = [];
  state.replayHistory = [];
  state.processedReplays = [];
  state.processedReplayPaths = [];
  state.lastMatch = null;
  state.overlay = defaultOverlay();
  state.subtitle = "本次直播战况";
  state.tickerText = defaults().tickerText;
}

function snapshot() {
  const games = state.wins + state.losses;
  const elapsed = state.paused ? state.elapsedBeforePause : Date.now() - state.startedAt;
  cleanupPendingReplays();
  const pendingReplay = state.pendingReplays[0] || null;
  return {
    ...state,
    games,
    elapsed,
    duration: formatDuration(elapsed),
    winrate: games > 0 ? `${Math.round((state.wins / games) * 100)}%` : "--",
    streak: pendingReplay ? "回放待确认" : getStreak(),
    pendingReplay,
    lastMatch: state.lastMatch,
    tickerText: state.tickerText,
    overlay: state.overlay,
    mmrApi: state.mmrApi,
    mmrApiEnabled: mmrApiConfig.enabled,
    mmrApiConfig: publicMmrApiConfig(),
    overlayLine: buildOverlayLine(),
    matchDetail: buildDetailMatchText(state.lastMatch),
    replayWatching: replayConfig.enabled ? replayConfig.watchRoots : []
  };
}

function getStreak() {
  const results = getHistoryResults();
  if (results.length === 0) return "待折跃";
  const last = results[results.length - 1];
  let count = 0;
  for (let index = results.length - 1; index >= 0; index -= 1) {
    if (results[index] !== last) break;
    count += 1;
  }
  return last === "W" ? `${count} 连胜` : `${count} 连败`;
}

function getHistoryResults() {
  return state.history
    .map((entry) => (typeof entry === "string" ? entry : entry?.result))
    .filter((result) => result === "W" || result === "L");
}

function cleanupPendingReplays() {
  const before = state.pendingReplays.length;
  const historyReplayKeys = new Set(state.history.map((entry) => entry?.replay?.key).filter(Boolean));
  const historyReplayPaths = new Set(state.history.map((entry) => entry?.replay?.path).filter(Boolean));
  state.pendingReplays = state.pendingReplays.filter((replay) => {
    if (!replay) return false;
    if (seenReplayKeys.has(replay.key) || seenReplayPaths.has(replay.path)) return false;
    if (historyReplayKeys.has(replay.key) || historyReplayPaths.has(replay.path)) return false;
    return true;
  });
  if (state.pendingReplays.length !== before) saveState();
}

function loadReplayConfig() {
  const defaultRoot = path.join(process.env.USERPROFILE || "", "Documents", "StarCraft II");
  const defaultToonIds = findToonIdsFromReplayFolders(defaultRoot);
  const defaults = {
    enabled: true,
    watchRoots: [defaultRoot],
    playerToonIds: defaultToonIds,
    playerNames: [],
    preferReplayFolderToonId: true,
    autoRecordParsedResults: true,
    settleMs: 3500,
    rescanMs: 10000
  };
  try {
    const config = { ...defaults, ...readJsonFile(replayConfigPath) };
    fs.writeFileSync(replayConfigPath, JSON.stringify(config, null, 2), "utf8");
    return config;
  } catch {
    fs.writeFileSync(replayConfigPath, JSON.stringify(defaults, null, 2), "utf8");
    return defaults;
  }
}

function defaultMmrApiConfig() {
  return {
    enabled: false,
    provider: "sc2pulse",
    baseUrl: "https://sc2pulse.nephest.com/sc2",
    queue: "LOTV_1V1",
    race: "auto",
    toonHandle: "",
    preferReplaySelf: true,
    updateAfterReplay: true,
    cnMmrEstimate: false,
    cnMmrEstimateK: CN_MMR_ESTIMATE_DEFAULT_K,
    refreshMs: 120000,
    timeoutMs: 12000,
    userAgent: "sc2-livehime-stats-overlay"
  };
}

function loadMmrApiConfig() {
  const defaults = defaultMmrApiConfig();
  try {
    const config = normalizeMmrApiConfig({ ...defaults, ...readJsonFile(mmrApiConfigPath) });
    writeMmrApiConfig(config);
    return config;
  } catch {
    writeMmrApiConfig(defaults);
    return defaults;
  }
}

function writeMmrApiConfig(config) {
  fs.writeFileSync(mmrApiConfigPath, JSON.stringify(config, null, 2), "utf8");
}

function publicMmrApiConfig() {
  return {
    enabled: !!mmrApiConfig.enabled,
    provider: mmrApiConfig.provider,
    queue: mmrApiConfig.queue,
    race: mmrApiConfig.race,
    toonHandle: mmrApiConfig.toonHandle,
    preferReplaySelf: !!mmrApiConfig.preferReplaySelf,
    updateAfterReplay: !!mmrApiConfig.updateAfterReplay,
    cnMmrEstimate: !!mmrApiConfig.cnMmrEstimate,
    cnMmrEstimateK: mmrApiConfig.cnMmrEstimateK,
    refreshMs: mmrApiConfig.refreshMs
  };
}

function normalizeMmrApiConfig(input = {}) {
  const defaults = defaultMmrApiConfig();
  const race = String(input.race || defaults.race).toUpperCase();
  const toonHandle = normalizeToonHandleInput(input.toonHandle || "");
  return {
    ...defaults,
    ...input,
    enabled: input.enabled === true || input.enabled === "true" || input.enabled === "1" || input.enabled === "on",
    provider: "sc2pulse",
    baseUrl: String(input.baseUrl || defaults.baseUrl).trim() || defaults.baseUrl,
    queue: String(input.queue || defaults.queue).trim() || defaults.queue,
    race: ["AUTO", "TERRAN", "PROTOSS", "ZERG", "RANDOM"].includes(race) ? race.toLowerCase() : "auto",
    toonHandle,
    preferReplaySelf: !toonHandle && input.preferReplaySelf !== false && input.preferReplaySelf !== "false" && input.preferReplaySelf !== "0",
    updateAfterReplay: input.updateAfterReplay !== false && input.updateAfterReplay !== "false" && input.updateAfterReplay !== "0",
    cnMmrEstimate: input.cnMmrEstimate === true || input.cnMmrEstimate === "true" || input.cnMmrEstimate === "1" || input.cnMmrEstimate === "on",
    cnMmrEstimateK: clampNumber(input.cnMmrEstimateK ?? defaults.cnMmrEstimateK, 8, 80),
    refreshMs: clampNumber(input.refreshMs ?? defaults.refreshMs, 30000, 1800000),
    timeoutMs: clampNumber(input.timeoutMs ?? defaults.timeoutMs, 3000, 30000),
    userAgent: String(input.userAgent || defaults.userAgent).trim() || defaults.userAgent
  };
}

function normalizeToonHandleInput(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const full = text.match(/([1235]-S2-\d-\d+)/i);
  if (full) return full[1].toUpperCase();
  const urlStyle = text.match(/[?&]toonHandle=([^&]+)/i);
  if (urlStyle) return decodeURIComponent(urlStyle[1]).toUpperCase();
  if (/^battlenet::\/\/starcraft\/profile\/[1235]\/\d+$/i.test(text)) return text;
  return "";
}

function updateMmrApiConfig(body) {
  const nextConfig = { ...mmrApiConfig };
  if ("enabled" in body || "mmrApiEnabled" in body) nextConfig.enabled = body.enabled ?? body.mmrApiEnabled;
  if ("race" in body) nextConfig.race = body.race;
  if ("toonHandle" in body) nextConfig.toonHandle = body.toonHandle;
  if ("preferReplaySelf" in body) nextConfig.preferReplaySelf = body.preferReplaySelf;
  if ("updateAfterReplay" in body) nextConfig.updateAfterReplay = body.updateAfterReplay;
  if ("cnMmrEstimate" in body) nextConfig.cnMmrEstimate = body.cnMmrEstimate;
  if ("cnMmrEstimateK" in body) nextConfig.cnMmrEstimateK = body.cnMmrEstimateK;
  if (Number(body.refreshSeconds) > 0) nextConfig.refreshMs = Number(body.refreshSeconds) * 1000;
  if ("refreshMs" in body) nextConfig.refreshMs = body.refreshMs;
  mmrApiConfig = normalizeMmrApiConfig(nextConfig);
  writeMmrApiConfig(mmrApiConfig);
  startMmrApiRefresher();
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function startReplayWatcher() {
  if (!replayConfig.enabled) return;
  seedExistingReplays();
  for (const root of replayConfig.watchRoots) {
    if (!fs.existsSync(root)) {
      console.log(`回放监听目录不存在: ${root}`);
      continue;
    }
    try {
      fs.watch(root, { recursive: true }, (_eventType, filename) => {
        if (!filename || !String(filename).toLowerCase().endsWith(".sc2replay")) return;
        scheduleReplayCheck(path.join(root, filename));
      });
      console.log(`正在监听 SC2 回放: ${root}`);
    } catch (error) {
      console.log(`无法监听回放目录: ${root}`);
      console.log(error.message);
    }
  }
  setInterval(() => scanLatestReplay(false), replayConfig.rescanMs);
}

function seedExistingReplays() {
  for (const replay of findReplayFiles()) {
    seenReplayKeys.add(replay.key);
    seenReplayPaths.add(replay.path);
  }
}

function scanLatestReplay(forceImport) {
  const files = findReplayFiles()
    .filter((replay) => forceImport || !seenReplayKeys.has(replay.key))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = files[0];
  if (!newest) return;
  if (!forceImport && newest.mtimeMs < Date.now() - 2 * 60 * 1000) return;
  if (forceImport) {
    const replay = toReplayRecord(newest.path, { mtimeMs: newest.mtimeMs, size: newest.size }, true);
    addPendingReplay(replay, true);
    return;
  }
  scheduleReplayCheck(newest.path);
}

function findReplayFiles() {
  const results = [];
  for (const root of replayConfig.watchRoots) {
    walkReplayFiles(root, results);
  }
  return results;
}

function walkReplayFiles(dir, results) {
  if (!dir || !fs.existsSync(dir)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkReplayFiles(fullPath, results);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".sc2replay")) continue;
    try {
      const stat = fs.statSync(fullPath);
      results.push(toReplayRecord(fullPath, stat, false));
    } catch {
      // The game may still be writing the file.
    }
  }
}

function scheduleReplayCheck(fullPath) {
  if (pendingReplayChecks.has(fullPath)) clearTimeout(pendingReplayChecks.get(fullPath));
  const timer = setTimeout(() => {
    pendingReplayChecks.delete(fullPath);
    importReplayWhenStable(fullPath);
  }, replayConfig.settleMs);
  pendingReplayChecks.set(fullPath, timer);
}

function importReplayWhenStable(fullPath) {
  let firstStat;
  try {
    firstStat = fs.statSync(fullPath);
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      const secondStat = fs.statSync(fullPath);
      if (firstStat.size !== secondStat.size) {
        scheduleReplayCheck(fullPath);
        return;
      }
      const replay = toReplayRecord(fullPath, secondStat, true);
      if (seenReplayKeys.has(replay.key) || seenReplayPaths.has(replay.path)) return;
      addPendingReplay(replay);
      console.log(`检测到新回放: ${replay.name}`);
    } catch {
      // Ignore disappearing temporary files.
    }
  }, 1000);
}

function addPendingReplay(replay, force = false) {
  if (!replay) return;
  if (!force && (seenReplayKeys.has(replay.key) || seenReplayPaths.has(replay.path))) return;
  if (replayConfig.autoRecordParsedResults && replay.parsed?.selfResult) {
    rememberReplay(replay.key);
    rememberReplayPath(replay.path);
    state.lastMatch = replay.parsed;
    addResult(replay.parsed.selfResult, replay);
    saveState();
    broadcast();
    return;
  }
  const alreadyPending = state.pendingReplays.some((item) => item.key === replay.key);
  if (!alreadyPending) state.pendingReplays.push(replay);
  rememberReplay(replay.key);
  rememberReplayPath(replay.path);
  updateReplaySubtitle();
  saveState();
  broadcast();
}

function toReplayRecord(fullPath, stat, shouldParse = true) {
  const name = path.basename(fullPath);
  const parsed = shouldParse ? parseReplay(fullPath) : null;
  return {
    key: `${fullPath}|${Math.floor(stat.mtimeMs)}|${stat.size}`,
    path: fullPath,
    name,
    map: parsed?.map || name.replace(/\.SC2Replay$/i, ""),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    parsed
  };
}

function rememberReplay(key) {
  if (!key) return;
  seenReplayKeys.add(key);
  state.processedReplays = Array.from(new Set([...(state.processedReplays || []), key])).slice(-300);
}

function rememberReplayPath(replayPath) {
  if (!replayPath) return;
  seenReplayPaths.add(replayPath);
  state.processedReplayPaths = Array.from(new Set([...(state.processedReplayPaths || []), replayPath])).slice(-300);
}

function clearPendingReplay() {
  const replay = state.pendingReplays.shift();
  if (replay) {
    rememberReplay(replay.key);
    rememberReplayPath(replay.path);
  }
  updateReplaySubtitle();
}

function updateReplaySubtitle() {
  const pending = state.pendingReplays[0];
  if (!pending && state.subtitle?.startsWith("检测到新回放")) state.subtitle = "本次直播战况";
}

function buildDetailMatchText(match) {
  return buildOverlayLine();
}

function buildOverlayLine() {
  const overlay = mergeOverlay(state.overlay);
  return [
    `当前MMR ${overlay.currentMmr || "--"}`,
    `vT ${formatScore(overlay.matchups.vT)}`,
    `vZ ${formatScore(overlay.matchups.vZ)}`,
    `vP ${formatScore(overlay.matchups.vP)}`
  ].join(" | ");
}

function formatScore(score) {
  return `${Number(score?.wins || 0)}-${Number(score?.losses || 0)}`;
}

function startMmrApiRefresher() {
  if (mmrApiTimer) {
    clearInterval(mmrApiTimer);
    mmrApiTimer = null;
  }
  if (!mmrApiConfig.enabled) {
    state.mmrApi = { ...state.mmrApi, status: "disabled", message: "线上 MMR API 未启用" };
    broadcast();
    return;
  }
  refreshMmrFromApi({ force: true });
  const refreshMs = clampNumber(mmrApiConfig.refreshMs, 30000, 1800000);
  mmrApiTimer = setInterval(() => refreshMmrFromApi(), refreshMs);
}

function refreshMmrFromApi(options = {}) {
  if (!mmrApiConfig.enabled) {
    state.mmrApi = { ...state.mmrApi, status: "disabled", message: "线上 MMR API 未启用" };
    return null;
  }
  if (activeMmrApiRefresh) return activeMmrApiRefresh;
  activeMmrApiRefresh = refreshMmrFromApiInner(options)
    .catch((error) => {
      state.mmrApi = {
        ...state.mmrApi,
        status: "error",
        message: `线上 MMR 刷新失败：${error.message}`,
        lastTriedAt: Date.now(),
        source: "sc2pulse"
      };
    })
    .finally(() => {
      activeMmrApiRefresh = null;
      saveState();
      broadcast();
    });
  return activeMmrApiRefresh;
}

async function refreshMmrFromApiInner(options = {}) {
  const match = options.match || state.lastMatch;
  let toonHandle = resolveMmrApiToonHandle(match);
  const race = resolveMmrApiRace(match);
  state.mmrApi = {
    ...state.mmrApi,
    provider: mmrApiConfig.provider,
    status: "loading",
    message: toonHandle ? "正在刷新线上 MMR..." : "缺少 toonHandle，等待下一盘录像识别账号",
    lastTriedAt: Date.now(),
    toonHandle,
    race
  };
  broadcast();
  if (!toonHandle) {
    state.mmrApi.status = "missing-account";
    saveState();
    return null;
  }
  if (!isToonHandle(toonHandle)) {
    state.mmrApi.message = "正在把 Battle.net 资料链接转换为 SC2 Pulse 账号...";
    broadcast();
    const resolved = await fetchSc2PulseToonHandleByQuery(toonHandle);
    if (!resolved) {
      state.mmrApi = {
        ...state.mmrApi,
        status: "not-found",
        message: "没有从 Battle.net 资料链接找到 SC2 Pulse 账号，已保留原 MMR",
        lastTriedAt: Date.now(),
        source: "sc2pulse"
      };
      return null;
    }
    toonHandle = resolved;
    mmrApiConfig.toonHandle = resolved;
    mmrApiConfig.preferReplaySelf = false;
    writeMmrApiConfig(mmrApiConfig);
    state.mmrApi.toonHandle = resolved;
  }
  const result = await fetchSc2PulseMmr(toonHandle, race);
  if (!result?.rating) {
    const isCn = /^5-S2-/i.test(toonHandle);
    state.mmrApi = {
      ...state.mmrApi,
      status: "not-found",
      message: isCn ? "SC2 Pulse 当前没有国服天梯数据，已保留原 MMR" : "线上 API 暂时没有这个账号的天梯数据，已保留原 MMR",
      lastTriedAt: Date.now(),
      source: "sc2pulse"
    };
    return null;
  }
  state.overlay.currentMmr = String(result.rating);
  state.mmrApi = {
    ...state.mmrApi,
    status: "ok",
    message: `线上 MMR 已更新：${result.rating}`,
    lastUpdatedAt: Date.now(),
    lastTriedAt: Date.now(),
    toonHandle,
    race: result.race || race,
    rating: result.rating,
    source: "sc2pulse",
    lastPlayed: result.lastPlayed || null
  };
  return result;
}

function resolveMmrApiToonHandle(match) {
  if (mmrApiConfig.toonHandle) return String(mmrApiConfig.toonHandle).trim();
  if (!mmrApiConfig.preferReplaySelf) return "";
  const self = match?.selfPlayers?.[0] || null;
  const region = normalizeRegionId(self?.region);
  const realm = Number(self?.realm || 1);
  const toonId = Number(self?.toonId || match?.folderToonId || 0);
  if (!region || !toonId) return "";
  return `${region}-S2-${realm}-${toonId}`;
}

function isToonHandle(value) {
  return /^[1235]-S2-\d-\d+$/i.test(String(value || "").trim());
}

function resolveMmrApiRace(match) {
  const configured = String(mmrApiConfig.race || "auto").toUpperCase();
  if (["TERRAN", "PROTOSS", "ZERG", "RANDOM"].includes(configured)) return configured;
  return raceNameToApi(match?.selfPlayers?.[0]?.race) || "";
}

function normalizeRegionId(region) {
  const value = String(region || "").toUpperCase();
  if (value === "US") return 1;
  if (value === "EU") return 2;
  if (value === "KR") return 3;
  if (value === "CN") return 5;
  const number = Number(region);
  return [1, 2, 3, 5].includes(number) ? number : 0;
}

function raceNameToApi(race) {
  const short = shortRace(race);
  if (short === "T") return "TERRAN";
  if (short === "P") return "PROTOSS";
  if (short === "Z") return "ZERG";
  if (short === "R") return "RANDOM";
  return "";
}

function raceCodeFromTeam(team) {
  const id = typeof team.legacyId === "string" ? team.legacyId : team.legacyId?.id;
  const code = String(id || "").split(".").pop();
  const mapping = { 1: "TERRAN", 2: "PROTOSS", 3: "ZERG", 4: "RANDOM" };
  if (mapping[code]) return mapping[code];
  const raceGames = team.members?.[0]?.raceGames || {};
  return Object.entries(raceGames).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] || "";
}

async function fetchSc2PulseMmr(toonHandle, race) {
  const baseUrl = String(mmrApiConfig.baseUrl || "https://sc2pulse.nephest.com/sc2").replace(/\/$/, "");
  const url = new URL(`${baseUrl}/api/character-teams`);
  url.searchParams.set("toonHandle", toonHandle);
  url.searchParams.set("queue", mmrApiConfig.queue || "LOTV_1V1");
  url.searchParams.set("limit", "12");
  const teams = await fetchJson(url.toString(), {
    timeoutMs: clampNumber(mmrApiConfig.timeoutMs, 3000, 30000),
    userAgent: mmrApiConfig.userAgent
  });
  if (!Array.isArray(teams) || teams.length === 0) return null;
  const ranked = teams
    .map((team) => ({ team, race: raceCodeFromTeam(team) }))
    .filter((entry) => Number.isFinite(Number(entry.team.rating)))
    .sort((a, b) => Date.parse(b.team.lastPlayed || 0) - Date.parse(a.team.lastPlayed || 0));
  const selected = ranked.find((entry) => race && entry.race === race) || ranked[0];
  if (!selected) return null;
  return {
    rating: Number(selected.team.rating),
    race: selected.race,
    lastPlayed: selected.team.lastPlayed || null
  };
}

async function fetchSc2PulseToonHandleByQuery(query) {
  const baseUrl = String(mmrApiConfig.baseUrl || "https://sc2pulse.nephest.com/sc2").replace(/\/$/, "");
  const url = new URL(`${baseUrl}/api/characters`);
  url.searchParams.set("query", query);
  const rows = await fetchJson(url.toString(), {
    timeoutMs: clampNumber(mmrApiConfig.timeoutMs, 3000, 30000),
    userAgent: mmrApiConfig.userAgent
  });
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const character = rows[0]?.members?.character;
  const region = normalizeRegionId(character?.region);
  const realm = Number(character?.realm || 1);
  const toonId = Number(character?.battlenetId || 0);
  if (!region || !toonId) return "";
  return `${region}-S2-${realm}-${toonId}`;
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { "User-Agent": options.userAgent || "sc2-livehime-stats-overlay" }
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(options.timeoutMs || 12000, () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", reject);
  });
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function updateOverlayFromMatch(match, result) {
  const self = match.selfPlayers?.[0];
  const estimated = updateCnMmrEstimate(match, result);
  if (!estimated && self?.mmr !== undefined && self?.mmr !== null) {
    state.overlay.currentMmr = String(self.mmr);
  }
  const matchupKey = getMatchupKey(match);
  if (!matchupKey) return;
  if (result === "W") state.overlay.matchups[matchupKey].wins += 1;
  if (result === "L") state.overlay.matchups[matchupKey].losses += 1;
}

function updateCnMmrEstimate(match, result) {
  if (!mmrApiConfig.cnMmrEstimate) return false;
  const self = match?.selfPlayers?.[0];
  if (normalizeRegionId(self?.region) !== 5) return false;
  const opponent = (match.opponents || [])[0] || (match.players || []).find((player) => !player.isSelf);
  const opponentMmr = normalizeMmrNumber(opponent?.mmr);
  if (!opponentMmr) return false;
  const current = normalizeMmrNumber(state.overlay.currentMmr);
  const selfReplayMmr = normalizeMmrNumber(self?.mmr);
  let seed = current || selfReplayMmr;
  const suspiciousReplayMmr = !selfReplayMmr || selfReplayMmr < 1000 || Math.abs(selfReplayMmr - opponentMmr) > 1200;
  if (!seed || (suspiciousReplayMmr && Math.abs(seed - opponentMmr) > 1200)) {
    seed = opponentMmr + (result === "W" ? 24 : -24);
  }
  const score = result === "W" ? 1 : 0;
  const expected = 1 / (1 + Math.pow(10, (opponentMmr - seed) / CN_MMR_ESTIMATE_SCALE));
  const delta = clampNumber(mmrApiConfig.cnMmrEstimateK, 8, 80) * (score - expected);
  const estimated = Math.round(seed + delta);
  state.overlay.currentMmr = String(Math.max(0, estimated));
  state.mmrApi = {
    ...state.mmrApi,
    status: "estimated",
    message: `国服 MMR 估算：${estimated}（对手 ${opponentMmr}，${result === "W" ? "胜" : "负"}，公开样本校准）`,
    source: "cn-estimate",
    rating: estimated,
    lastUpdatedAt: Date.now()
  };
  return true;
}

function normalizeMmrNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number);
}

function decrementMatchup(matchupKey, result) {
  const score = state.overlay.matchups?.[matchupKey];
  if (!score) return;
  if (result === "W") score.wins = Math.max(0, score.wins - 1);
  if (result === "L") score.losses = Math.max(0, score.losses - 1);
}

function getMatchupKey(match) {
  const opponent = (match.opponents || [])[0];
  const race = shortRace(opponent?.race);
  if (race === "T") return "vT";
  if (race === "Z") return "vZ";
  if (race === "P") return "vP";
  return null;
}

function updateOverlayInfo(body) {
  state.overlay = mergeOverlay({
    currentMmr: body.currentMmr,
    showInfoLine: body.showInfoLine,
    chromeOpacity: body.chromeOpacity,
    theme: body.theme,
    matchups: {
      vT: { wins: body.vTWins, losses: body.vTLosses },
      vZ: { wins: body.vZWins, losses: body.vZLosses },
      vP: { wins: body.vPWins, losses: body.vPLosses }
    }
  });
}

function normalizeTheme(theme) {
  const value = String(theme || "protoss").toLowerCase();
  return ["protoss", "terran", "zerg", "minimal"].includes(value) ? value : "protoss";
}

function shortRace(race) {
  if (!race) return "";
  if (/prot/i.test(race)) return "P";
  if (/zerg/i.test(race)) return "Z";
  if (/terr/i.test(race)) return "T";
  if (/rand/i.test(race)) return "R";
  return race;
}

function formatSeconds(seconds) {
  if (typeof seconds !== "number") return "";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function parseReplay(fullPath) {
  const parserPath = path.join(__dirname, "parse-sc2-replay.py");
  if (!fs.existsSync(parserPath)) return null;
  const result = spawnSync("python", [parserPath, fullPath, replayConfigPath], {
    cwd: __dirname,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    windowsHide: true,
    timeout: 20000
  });
  if (result.error || result.status !== 0) {
    const error = result.error?.message || result.stderr || result.stdout;
    console.log(`回放解析失败: ${path.basename(fullPath)} ${String(error).trim()}`);
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (!parsed.ok) {
      console.log(`回放解析失败: ${path.basename(fullPath)} ${parsed.error || "unknown error"}`);
      return null;
    }
    return parsed;
  } catch (error) {
    console.log(`回放解析输出异常: ${error.message}`);
    return null;
  }
}

function findToonIdsFromReplayFolders(root) {
  if (!root || !fs.existsSync(root)) return [];
  const ids = new Set();
  const replays = [];
  walkReplayPathsOnly(root, replays);
  const pattern = new RegExp("\\\\Accounts\\\\[^\\\\]+\\\\[0-9]+-S2-[0-9]+-([0-9]+)\\\\Replays\\\\", "i");
  for (const replayPath of replays) {
    const normalized = `${replayPath}\\`;
    const match = normalized.match(pattern);
    if (match) ids.add(Number(match[1]));
  }
  return Array.from(ids);
}

function walkReplayPathsOnly(dir, results) {
  if (!dir || !fs.existsSync(dir)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkReplayPathsOnly(fullPath, results);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".sc2replay")) results.push(fullPath);
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function broadcast() {
  const message = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const client of clients) client.write(message);
}

setInterval(broadcast, 1000);

function readBody(request, callback) {
  let raw = "";
  request.on("data", (chunk) => {
    raw += chunk;
  });
  request.on("end", () => {
    try {
      callback(JSON.parse(raw || "{}"));
    } catch {
      callback({});
    }
  });
}

function sendJson(response, payload) {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, html) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function renderPage(control) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SC2 Live Stats</title>
    <style>
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: ${control ? "#071014" : "transparent"};
        color: #eefcff;
        font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
      }
      body { display: grid; place-items: center; }
      .wrap { display: grid; gap: 14px; padding: ${control ? "24px" : "0"}; }
      .hud {
        --chrome: 1;
        --line-display: block;
        --accent: 56, 228, 255;
        --edge: 255, 213, 140;
        --panel-a: 2, 8, 12;
        --panel-b: 5, 19, 24;
        --title: #f4fdff;
        --muted: #8feeff;
        --sigil-radius: 50%;
        --sigil-clip: polygon(50% 0, 100% 26%, 100% 74%, 50% 100%, 0 74%, 0 26%);
        --compact: 0;
        position: relative;
        width: 1240px;
        height: calc((112px - (22px * var(--compact))) + (20px * var(--line-on, 1)));
        display: grid;
        grid-template-columns: 288px 1fr 246px;
        align-items: center;
        gap: 18px;
        padding: calc(16px - (5px * var(--compact))) 24px calc(16px - (5px * var(--compact))) 28px;
        background: radial-gradient(circle at 9% 50%, rgba(var(--accent),calc(.22 * var(--chrome))), transparent 30%), linear-gradient(90deg, rgba(var(--panel-a),calc(.70 * var(--chrome))), rgba(var(--panel-b),calc(.56 * var(--chrome))) 45%, rgba(var(--panel-a),calc(.48 * var(--chrome))));
        border: 1px solid rgba(var(--edge),calc(.48 * var(--chrome)));
        border-left: 5px solid rgba(var(--edge),calc(.82 * var(--chrome)));
        border-right: 5px solid rgba(var(--accent),calc(.72 * var(--chrome)));
        clip-path: polygon(0 0, calc(100% - 34px) 0, 100% 34px, 100% 100%, 34px 100%, 0 calc(100% - 34px));
        box-shadow: inset 0 0 24px rgba(var(--accent),calc(.10 * var(--chrome))), 0 0 18px rgba(var(--accent),calc(.22 * var(--chrome)));
      }
      .hud::marker { content: ""; }
      .hud::before, .hud::after {
        content: "";
        position: absolute;
        left: 34px;
        right: 34px;
        height: 2px;
        background: linear-gradient(90deg, transparent, rgba(var(--accent),var(--chrome)), rgba(238,252,255,calc(.82 * var(--chrome))), transparent);
        box-shadow: 0 0 12px rgba(var(--accent),calc(.68 * var(--chrome)));
      }
      .hud::before { top: 8px; }
      .hud::after {
        bottom: 8px;
        background: linear-gradient(90deg, transparent, rgba(var(--edge),var(--chrome)), rgba(255,245,220,calc(.74 * var(--chrome))), transparent);
        box-shadow: 0 0 10px rgba(var(--edge),calc(.50 * var(--chrome)));
      }
      .brand { min-width: 0; padding-left: 54px; position: relative; }
      .brand::before {
        content: "";
        position: absolute;
        left: 8px;
        top: 50%;
        width: 34px;
        height: 34px;
        display: grid;
        place-items: center;
        transform: translateY(-50%);
        border: 1px solid rgba(var(--accent),calc(.72 * var(--chrome)));
        background: radial-gradient(circle, rgba(var(--accent),calc(.82 * var(--chrome))) 0 26%, transparent 28% 42%, rgba(var(--edge),calc(.45 * var(--chrome))) 44% 58%, transparent 60%), rgba(var(--panel-a),calc(.42 * var(--chrome)));
        box-shadow: 0 0 12px rgba(var(--accent),calc(.38 * var(--chrome)));
        border-radius: var(--sigil-radius);
        clip-path: var(--sigil-clip);
      }
      h1 { margin: 0; font-size: 28px; line-height: 1.1; font-weight: 800; letter-spacing: 0; color: var(--title); text-shadow: 0 0 10px rgba(var(--accent),.42); }
      .subtitle {
        margin-top: 7px;
        max-width: 290px;
        color: var(--muted);
        font-size: 15px;
        white-space: nowrap;
        overflow: hidden;
      }
      .subtitle-track {
        display: inline-block;
        min-width: 100%;
        padding-left: var(--ticker-offset, 0);
        animation: ticker var(--ticker-speed, 18s) linear infinite;
      }
      .subtitle-track[data-static="true"] {
        animation: none;
        padding-left: 0;
      }
      @keyframes ticker {
        from { transform: translateX(0); }
        to { transform: translateX(-100%); }
      }
      .timer { position: relative; display: grid; justify-items: end; gap: 6px; padding-right: 8px; white-space: nowrap; }
      .timer-label { color: #ffd58c; font-size: 13px; }
      .timer-value { font-variant-numeric: tabular-nums; font-size: 34px; line-height: 1; font-weight: 800; color: #effdff; text-shadow: 0 0 12px rgba(56,228,255,.58); }
      .timer::after { content: ""; width: 52px; height: 4px; background: rgba(var(--accent),var(--chrome)); box-shadow: 0 0 12px rgba(var(--accent),calc(.76 * var(--chrome))); }
      .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; align-items: stretch; }
      .stat { min-width: 0; display: grid; align-content: center; min-height: 64px; padding: 8px 12px 9px; background: linear-gradient(180deg, rgba(0,0,0,calc(.28 * var(--chrome))), rgba(0,0,0,calc(.16 * var(--chrome)))); border: 1px solid rgba(var(--accent),calc(.26 * var(--chrome))); border-radius: 4px; }
      .label { color: rgba(238,252,255,.64); font-size: 13px; line-height: 1; }
      .value { margin-top: 7px; font-size: 26px; line-height: 1; font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .good { color: #78ffc1; }
      .bad { color: #ff7891; }
      .controls { display: ${control ? "grid" : "none"}; grid-template-columns: repeat(8, 1fr); gap: 10px; width: 1240px; }
      button, input {
        min-height: 44px;
        color: #eefcff;
        background: rgba(6,18,24,.92);
        border: 1px solid rgba(56,228,255,.48);
        border-radius: 6px;
        font: inherit;
        font-weight: 700;
      }
      button { cursor: pointer; }
      button:hover { border-color: rgba(255,213,140,.86); box-shadow: 0 0 12px rgba(56,228,255,.32); }
      .fields { display: ${control ? "grid" : "none"}; grid-template-columns: 1fr auto; gap: 10px; width: 1240px; }
      .ticker-fields { display: ${control ? "grid" : "none"}; grid-template-columns: 1fr auto; gap: 10px; width: 1240px; }
      .overlay-fields { display: ${control ? "grid" : "none"}; grid-template-columns: 1.2fr repeat(6, 1fr) auto; gap: 10px; width: 1240px; }
      .display-fields { display: ${control ? "grid" : "none"}; grid-template-columns: 160px 190px 1fr 120px; gap: 10px; width: 1240px; align-items: center; color: rgba(238,252,255,.82); }
      .mmr-api-fields { display: ${control ? "grid" : "none"}; grid-template-columns: 170px 170px 170px 1fr 140px auto; gap: 10px; width: 1240px; align-items: center; color: rgba(238,252,255,.82); }
      .estimate-fields { display: ${control ? "grid" : "none"}; grid-template-columns: 210px 160px 1fr; gap: 10px; width: 1240px; align-items: center; color: rgba(238,252,255,.82); }
      .display-fields label, .mmr-api-fields label, .estimate-fields label { min-height: 44px; display: flex; align-items: center; gap: 8px; padding: 0 12px; background: rgba(6,18,24,.72); border: 1px solid rgba(56,228,255,.32); border-radius: 6px; }
      select { min-height: 44px; color: #eefcff; background: rgba(6,18,24,.92); border: 1px solid rgba(56,228,255,.48); border-radius: 6px; font: inherit; font-weight: 700; padding: 0 12px; }
      input[type="checkbox"] { min-height: 0; width: 18px; height: 18px; }
      input { padding: 0 12px; }
      .note { display: ${control ? "block" : "none"}; color: rgba(238,252,255,.72); font-size: 14px; }
      .replay-line { display: ${control ? "block" : "none"}; width: 1240px; min-height: 22px; color: #ffd58c; font-size: 15px; }
      .match-strip {
        display: var(--line-display);
        position: absolute;
        left: 34px;
        right: 34px;
        bottom: 16px;
        color: rgba(255, 213, 140, .92);
        font-size: 15px;
        line-height: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        pointer-events: none;
      }
      .stats, .brand, .timer { transform: translateY(calc((-8px * var(--line-on, 1)) + (2px * var(--compact)))); }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="hud">
        <div class="brand">
          <h1 id="title">星灵折跃频道</h1>
          <div class="subtitle"><span class="subtitle-track" id="tickerText">欢迎来到星灵折跃频道</span></div>
        </div>
        <section class="stats">
          <div class="stat"><div class="label">场数</div><div class="value" id="games">0</div></div>
          <div class="stat"><div class="label">胜 / 负</div><div class="value"><span class="good" id="wins">0</span> / <span class="bad" id="losses">0</span></div></div>
          <div class="stat"><div class="label">胜率</div><div class="value" id="winrate">--</div></div>
          <div class="stat"><div class="label">当前状态</div><div class="value" id="streak">待折跃</div></div>
        </section>
        <div class="timer">
          <div class="timer-label">直播时间</div>
          <div class="timer-value" id="duration">00:00:00</div>
        </div>
        <div class="match-strip" id="matchStrip">等待新回放</div>
      </section>
      <section class="controls">
        <button data-action="win">胜 W</button>
        <button data-action="loss">负 L</button>
        <button data-action="undo">撤销 U</button>
        <button data-action="pause" id="pauseBtn">暂停 P</button>
        <button data-action="reset">重置 R</button>
        <button data-action="scanLatest">扫最新</button>
        <button data-action="clearPending">忽略回放</button>
        <button data-action="refreshMmrApi">刷新线上MMR</button>
      </section>
      <section class="fields">
        <input id="titleInput" placeholder="标题" />
        <button id="saveTitle">更新标题</button>
      </section>
      <section class="ticker-fields">
        <input id="tickerInput" placeholder="滚动字幕，可用接口 /ticker?text=你的文字 动态更新" />
        <button id="saveTicker">更新滚动字幕</button>
      </section>
      <section class="overlay-fields">
        <input id="currentMmrInput" placeholder="当前MMR" />
        <input id="vTWinsInput" placeholder="vT胜" />
        <input id="vTLossesInput" placeholder="vT负" />
        <input id="vZWinsInput" placeholder="vZ胜" />
        <input id="vZLossesInput" placeholder="vZ负" />
        <input id="vPWinsInput" placeholder="vP胜" />
        <input id="vPLossesInput" placeholder="vP负" />
        <button id="saveOverlay">更新比分</button>
      </section>
      <section class="display-fields">
        <label><input id="showInfoLineInput" type="checkbox" />显示底部信息</label>
        <select id="themeInput">
          <option value="protoss">神族样式</option>
          <option value="terran">人族样式</option>
          <option value="zerg">虫族样式</option>
          <option value="minimal">极简样式</option>
        </select>
        <input id="chromeOpacityInput" type="range" min="0" max="100" step="5" />
        <span id="chromeOpacityLabel">透明度 100%</span>
      </section>
      <section class="mmr-api-fields">
        <label><input id="mmrApiEnabledInput" type="checkbox" />启用线上MMR</label>
        <label><input id="mmrApiReplayInput" type="checkbox" />无手动账号时自动识别</label>
        <select id="mmrApiRaceInput">
          <option value="auto">按录像种族</option>
          <option value="terran">人族</option>
          <option value="protoss">神族</option>
          <option value="zerg">虫族</option>
          <option value="random">随机</option>
        </select>
        <input id="mmrApiToonInput" placeholder="账号 3-S2-1-8609924，或 battlenet:: 资料链接，可留空" />
        <input id="mmrApiRefreshInput" type="number" min="30" max="1800" step="30" placeholder="刷新秒数" />
        <button id="saveMmrApi">保存线上MMR</button>
      </section>
      <section class="estimate-fields">
        <label><input id="cnMmrEstimateInput" type="checkbox" />国服MMR估算</label>
        <input id="cnMmrKInput" type="number" min="8" max="80" step="1" placeholder="校准K值 44" />
        <span>国服 replay 的自身 MMR 异常时，用对手 MMR 和胜负估算；默认 K=44、分差尺度=850，来自 SC2 Pulse 公开逐局变化样本，不使用你的未定级录像校准。</span>
      </section>
      <div class="replay-line" id="replayLine">回放监听启动中...</div>
      <div class="replay-line" id="mmrApiLine">线上 MMR API 未启用</div>
      <div class="note">直播姬网页源填 /view；这个控制页填 /control。新回放出现后会显示“回放待确认”，按 W/L 会把这场记成胜/负。</div>
    </main>
    <script>
      const source = new EventSource("/events");
      source.onmessage = (event) => render(JSON.parse(event.data));
      fetch("/state").then((response) => response.json()).then(render);
      document.querySelectorAll("[data-action]").forEach((button) => {
        button.addEventListener("click", () => action(button.dataset.action));
      });
      document.getElementById("saveTitle")?.addEventListener("click", () => {
        action("title", {
          title: document.getElementById("titleInput").value
        });
      });
      document.getElementById("saveTicker")?.addEventListener("click", () => {
        action("ticker", {
          tickerText: document.getElementById("tickerInput").value
        });
      });
      document.getElementById("saveOverlay")?.addEventListener("click", () => {
        saveOverlay();
      });
      document.getElementById("saveMmrApi")?.addEventListener("click", () => {
        saveMmrApiConfig();
      });
      document.getElementById("mmrApiEnabledInput")?.addEventListener("change", () => {
        saveMmrApiConfig();
      });
      document.getElementById("mmrApiToonInput")?.addEventListener("input", () => {
        syncMmrApiManualMode();
      });
      document.getElementById("showInfoLineInput")?.addEventListener("change", saveOverlay);
      document.getElementById("themeInput")?.addEventListener("change", saveOverlay);
      document.getElementById("chromeOpacityInput")?.addEventListener("input", () => {
        document.getElementById("chromeOpacityLabel").textContent = "透明度 " + document.getElementById("chromeOpacityInput").value + "%";
        saveOverlay();
      });
      window.addEventListener("keydown", (event) => {
        const key = event.key.toLowerCase();
        if (key === "w") action("win");
        if (key === "l") action("loss");
        if (key === "u") action("undo");
        if (key === "p") action("pause");
        if (key === "r") action("reset");
      });
      function action(action, extra = {}) {
        if (action === "reset" && !confirm("重置本次直播统计？")) return;
        fetch("/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...extra })
        });
      }
      function render(data) {
        applyDisplaySettings(data.overlay);
        document.getElementById("title").textContent = data.title;
        renderTicker(data.tickerText);
        document.getElementById("duration").textContent = data.duration;
        document.getElementById("games").textContent = data.games;
        document.getElementById("wins").textContent = data.wins;
        document.getElementById("losses").textContent = data.losses;
        document.getElementById("winrate").textContent = data.winrate;
        document.getElementById("streak").textContent = data.streak;
        const replayLine = document.getElementById("replayLine");
        if (replayLine) {
          replayLine.textContent = data.pendingReplay
            ? "待确认回放：" + data.pendingReplay.name
            : data.overlayLine || "监听目录：" + (data.replayWatching?.join("；") || "未启用");
        }
        const mmrApiLine = document.getElementById("mmrApiLine");
        if (mmrApiLine) {
          mmrApiLine.textContent = formatMmrApiLine(data);
        }
        const matchStrip = document.getElementById("matchStrip");
        matchStrip.textContent = data.overlayLine || "当前MMR -- | vT 0-0 | vZ 0-0 | vP 0-0";
        const pauseBtn = document.getElementById("pauseBtn");
        if (pauseBtn) pauseBtn.textContent = data.paused ? "继续 P" : "暂停 P";
        const titleInput = document.getElementById("titleInput");
        const tickerInput = document.getElementById("tickerInput");
        if (titleInput && !titleInput.value) titleInput.value = data.title;
        if (tickerInput && document.activeElement !== tickerInput) tickerInput.value = data.tickerText || "";
        fillOverlayInputs(data.overlay);
        fillMmrApiInputs(data.mmrApiConfig);
      }
      function renderTicker(text) {
        const ticker = document.getElementById("tickerText");
        const value = text || "欢迎来到星灵折跃频道";
        ticker.textContent = value;
        const shouldScroll = value.length > 14;
        ticker.dataset.static = shouldScroll ? "false" : "true";
        ticker.style.setProperty("--ticker-offset", shouldScroll ? "100%" : "0");
        ticker.style.setProperty("--ticker-speed", Math.max(12, Math.min(36, value.length * 0.55)) + "s");
      }
      function formatMmrApiLine(data) {
        if (!data.mmrApiEnabled) return "线上 MMR API：未启用（可在控制台勾选启用）";
        const api = data.mmrApi || {};
        const base = "线上 MMR API：" + (api.message || api.status || "等待刷新");
        const account = api.toonHandle ? " | " + api.toonHandle : "";
        const race = api.race ? " | " + api.race : "";
        return base + account + race;
      }
      function fillOverlayInputs(overlay) {
        const map = {
          currentMmrInput: overlay?.currentMmr ?? "--",
          vTWinsInput: overlay?.matchups?.vT?.wins ?? 0,
          vTLossesInput: overlay?.matchups?.vT?.losses ?? 0,
          vZWinsInput: overlay?.matchups?.vZ?.wins ?? 0,
          vZLossesInput: overlay?.matchups?.vZ?.losses ?? 0,
          vPWinsInput: overlay?.matchups?.vP?.wins ?? 0,
          vPLossesInput: overlay?.matchups?.vP?.losses ?? 0
        };
        for (const [id, value] of Object.entries(map)) {
          const input = document.getElementById(id);
          if (input && document.activeElement !== input) input.value = value;
        }
        const showInput = document.getElementById("showInfoLineInput");
        if (showInput && document.activeElement !== showInput) showInput.checked = overlay?.showInfoLine !== false;
        const themeInput = document.getElementById("themeInput");
        if (themeInput && document.activeElement !== themeInput) themeInput.value = overlay?.theme || "protoss";
        const chromeInput = document.getElementById("chromeOpacityInput");
        if (chromeInput && document.activeElement !== chromeInput) chromeInput.value = overlay?.chromeOpacity ?? 100;
        const chromeLabel = document.getElementById("chromeOpacityLabel");
        if (chromeLabel) chromeLabel.textContent = "透明度 " + (overlay?.chromeOpacity ?? 100) + "%";
      }
      function fillMmrApiInputs(config) {
        const enabledInput = document.getElementById("mmrApiEnabledInput");
        if (enabledInput && document.activeElement !== enabledInput) enabledInput.checked = !!config?.enabled;
        const replayInput = document.getElementById("mmrApiReplayInput");
        const hasManualToon = !!config?.toonHandle;
        if (replayInput && document.activeElement !== replayInput) replayInput.checked = !hasManualToon && config?.preferReplaySelf !== false;
        if (replayInput) replayInput.disabled = hasManualToon;
        const raceInput = document.getElementById("mmrApiRaceInput");
        if (raceInput && document.activeElement !== raceInput) raceInput.value = config?.race || "auto";
        const toonInput = document.getElementById("mmrApiToonInput");
        if (toonInput && document.activeElement !== toonInput) toonInput.value = config?.toonHandle || "";
        const refreshInput = document.getElementById("mmrApiRefreshInput");
        if (refreshInput && document.activeElement !== refreshInput) refreshInput.value = Math.round((config?.refreshMs || 120000) / 1000);
        const estimateInput = document.getElementById("cnMmrEstimateInput");
        if (estimateInput && document.activeElement !== estimateInput) estimateInput.checked = !!config?.cnMmrEstimate;
        const estimateKInput = document.getElementById("cnMmrKInput");
        if (estimateKInput && document.activeElement !== estimateKInput) estimateKInput.value = config?.cnMmrEstimateK || 44;
        syncMmrApiManualMode();
      }
      function syncMmrApiManualMode() {
        const replayInput = document.getElementById("mmrApiReplayInput");
        const toonInput = document.getElementById("mmrApiToonInput");
        if (!replayInput || !toonInput) return;
        const hasManualToon = !!toonInput.value.trim();
        replayInput.disabled = hasManualToon;
        if (hasManualToon) replayInput.checked = false;
      }
      function saveOverlay() {
        action("overlay", {
          currentMmr: document.getElementById("currentMmrInput").value,
          vTWins: document.getElementById("vTWinsInput").value,
          vTLosses: document.getElementById("vTLossesInput").value,
          vZWins: document.getElementById("vZWinsInput").value,
          vZLosses: document.getElementById("vZLossesInput").value,
          vPWins: document.getElementById("vPWinsInput").value,
          vPLosses: document.getElementById("vPLossesInput").value,
          showInfoLine: document.getElementById("showInfoLineInput").checked,
          chromeOpacity: document.getElementById("chromeOpacityInput").value,
          theme: document.getElementById("themeInput").value
        });
      }
      function saveMmrApiConfig() {
        const toonHandle = document.getElementById("mmrApiToonInput").value.trim();
        action("mmrApiConfig", {
          enabled: document.getElementById("mmrApiEnabledInput").checked,
          preferReplaySelf: toonHandle ? false : true,
          race: document.getElementById("mmrApiRaceInput").value,
          toonHandle,
          refreshSeconds: document.getElementById("mmrApiRefreshInput").value,
          cnMmrEstimate: document.getElementById("cnMmrEstimateInput").checked,
          cnMmrEstimateK: document.getElementById("cnMmrKInput").value
        });
      }
      function applyDisplaySettings(overlay) {
        const hud = document.querySelector(".hud");
        const chrome = Math.max(0, Math.min(100, Number(overlay?.chromeOpacity ?? 100))) / 100;
        const showLine = overlay?.showInfoLine !== false;
        const theme = getTheme(overlay?.theme);
        hud.style.setProperty("--chrome", String(chrome));
        hud.style.setProperty("--line-on", showLine ? "1" : "0");
        hud.style.setProperty("--line-display", showLine ? "block" : "none");
        for (const [key, value] of Object.entries(theme)) hud.style.setProperty(key, value);
      }
      function getTheme(name) {
        const themes = {
          protoss: {
            "--accent": "56, 228, 255",
            "--edge": "255, 213, 140",
            "--panel-a": "2, 8, 12",
            "--panel-b": "5, 19, 24",
            "--title": "#f4fdff",
            "--muted": "#8feeff",
            "--sigil-radius": "50%",
            "--sigil-clip": "polygon(50% 0, 100% 26%, 100% 74%, 50% 100%, 0 74%, 0 26%)",
            "--compact": "0"
          },
          terran: {
            "--accent": "88, 169, 255",
            "--edge": "180, 205, 232",
            "--panel-a": "5, 9, 13",
            "--panel-b": "18, 30, 39",
            "--title": "#f0f7ff",
            "--muted": "#9fc8ff",
            "--sigil-radius": "3px",
            "--sigil-clip": "polygon(8% 0, 92% 0, 100% 22%, 100% 78%, 92% 100%, 8% 100%, 0 78%, 0 22%)",
            "--compact": "0"
          },
          zerg: {
            "--accent": "176, 97, 255",
            "--edge": "116, 255, 141",
            "--panel-a": "12, 4, 18",
            "--panel-b": "30, 9, 36",
            "--title": "#fff4ff",
            "--muted": "#d7a8ff",
            "--sigil-radius": "58% 42% 62% 38%",
            "--sigil-clip": "polygon(50% 0, 82% 14%, 100% 50%, 82% 86%, 50% 100%, 18% 86%, 0 50%, 18% 14%)",
            "--compact": "0"
          },
          minimal: {
            "--accent": "230, 236, 240",
            "--edge": "160, 168, 174",
            "--panel-a": "0, 0, 0",
            "--panel-b": "12, 14, 16",
            "--title": "#ffffff",
            "--muted": "#c8d0d6",
            "--sigil-radius": "50%",
            "--sigil-clip": "circle(50% at 50% 50%)",
            "--compact": "1"
          }
        };
        return themes[name] || themes.protoss;
      }
    </script>
  </body>
</html>`;
}
