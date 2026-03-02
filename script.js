const MOCK_MODE = true;
const THEME_STORAGE_KEY = "swlm-theme";
const CHART_MAX_POINTS = 120;
const CONNECTION_TIMEOUT_MS = 5000;

let lastChartUpdateMs = 0;
let lastDataTimestampMs = null;
let connectionWatchdogTimer = null;

(() => {
  const API_CONFIG = {
    dataUrl: "/api/data",
    logsUrl: "/api/logs",
    pollIntervalMs: 1000,
    maxHistoryPoints: 1800, // 30 minutes at 1s sampling
  };

  const MOCK_SIM_CONFIG = {
    mainFlowMin: 3.0,
    mainFlowMax: 6.0,
    pressureMin: 98,
    pressureMax: 105,
    leakIntervalMinSec: 15,
    leakIntervalMaxSec: 25,
    leakDurationMinSec: 5,
    leakDurationMaxSec: 10,
  };

  const mockState = {
    clockMs: Date.now(),
    inLeak: false,
    leakRemainingSec: 0,
    untilNextLeakSec: 0,
    uptimeSec: 0,
    forceCriticalFlowDiff: 0,
  };

  function randomInRange(min, max) {
    return min + Math.random() * (max - min);
  }

  function randomInt(min, max) {
    return Math.floor(randomInRange(min, max + 1));
  }

  function ensureMockInitialized() {
    if (mockState.untilNextLeakSec <= 0) {
      mockState.untilNextLeakSec = randomInt(
        MOCK_SIM_CONFIG.leakIntervalMinSec,
        MOCK_SIM_CONFIG.leakIntervalMaxSec
      );
    }
  }

  function generateMockPayload() {
    ensureMockInitialized();

    const dtSec = API_CONFIG.pollIntervalMs / 1000;
    mockState.clockMs += API_CONFIG.pollIntervalMs;
    mockState.uptimeSec += dtSec;

    const wasInLeak = mockState.inLeak;
    let justStartedLeak = false;
    let justEndedLeak = false;

    if (mockState.inLeak) {
      mockState.leakRemainingSec -= dtSec;
      if (mockState.leakRemainingSec <= 0) {
        mockState.inLeak = false;
        mockState.forceCriticalFlowDiff = 0;
        mockState.untilNextLeakSec = randomInt(
          MOCK_SIM_CONFIG.leakIntervalMinSec,
          MOCK_SIM_CONFIG.leakIntervalMaxSec
        );
      }
    } else {
      mockState.untilNextLeakSec -= dtSec;
      if (mockState.untilNextLeakSec <= 0) {
        mockState.inLeak = true;
        mockState.leakRemainingSec = randomInt(
          MOCK_SIM_CONFIG.leakDurationMinSec,
          MOCK_SIM_CONFIG.leakDurationMaxSec
        );
      }
    }

    if (!wasInLeak && mockState.inLeak) {
      justStartedLeak = true;
    } else if (wasInLeak && !mockState.inLeak) {
      justEndedLeak = true;
    }

    const baseMainFlow = randomInRange(
      MOCK_SIM_CONFIG.mainFlowMin,
      MOCK_SIM_CONFIG.mainFlowMax
    );

    let mainFlow = baseMainFlow;
    let branchFlow;
    let flowDifference;

    if (mockState.inLeak) {
      if (mockState.forceCriticalFlowDiff > 0) {
        flowDifference = mockState.forceCriticalFlowDiff;
      } else {
        flowDifference = randomInRange(2.0, 5.0);
      }
      branchFlow = Math.max(0, mainFlow - flowDifference);
    } else {
      // Normal operation: branch flow only slightly lower than main
      flowDifference = randomInRange(0.05, 0.3);
      branchFlow = Math.max(0, mainFlow - flowDifference);
    }

    const pressure = randomInRange(
      MOCK_SIM_CONFIG.pressureMin,
      MOCK_SIM_CONFIG.pressureMax
    );

    // Leak probability based on flow difference
    const leakProbability = Math.max(
      0,
      Math.min(100, flowDifference * 20)
    );

    const timestamp = new Date(mockState.clockMs).toISOString();

    const data = {
      timestamp,
      mainFlow,
      branchFlow,
      flowDifference,
      pressure,
      leakProbability,
      uptime: mockState.uptimeSec,
      wifiStrength: -65 + Math.round(randomInRange(-5, 5)),
      systemStatus: mockState.inLeak ? "LEAK" : "NORMAL",
    };

    const logs = [];
    if (justStartedLeak) {
      logs.push({
        timestamp,
        severity: "WARNING",
        message: "Simulated leak started",
      });
    } else if (justEndedLeak) {
      logs.push({
        timestamp,
        severity: "INFO",
        message: "Simulated leak ended",
      });
    }

    return { data, logs };
  }

  const SEVERITY = {
    NORMAL: "NORMAL",
    MINOR: "MINOR",
    MODERATE: "MODERATE",
    CRITICAL: "CRITICAL",
  };

  const FLOW_THRESHOLDS = {
    NORMAL_MAX: 0.5,
    MINOR_MAX: 1.5,
    MODERATE_MAX: 3.0,
    REQUIRED_CONSECUTIVE: 5,
  };

  const DOM = {};

  const state = {
    connected: true,
    mode: "live", // 'live' | 'replay'
    dataHistory: [],
    logs: [],
    timestamps: [],
    availability: {
      totalSeconds: 0,
      upSeconds: 0,
    },
    lastTimestamp: null,
    aboveThresholdDurationSec: 0,
    aboveThresholdCount: 0,
    currentLeak: null,
    leakEvents: [],
    totalWaterMonitoredLiters: 0,
    totalWaterLostLiters: 0,
    leakHistoryForCsv: [],
    charts: null,
    timeWindowSeconds: 60,
    isSimulationMode: true,
    ui: {
      activeView: "live",
      theme: "dark",
      entryCompleted: false,
      navigationLocked: false,
      lastGaugeProb: null,
    },
    replay: {
      activeEvent: null,
      sliderLocked: false,
    },
  };

  function initDomRefs() {
    DOM.clock = document.getElementById("clock");
    DOM.uptimeValue = document.getElementById("uptimeValue");
    DOM.wifiStrengthValue = document.getElementById("wifiStrengthValue");
    DOM.wifiQualityLabel = document.getElementById("wifiQualityLabel");
    DOM.wifiBars = Array.from(
      document.querySelectorAll(".wifi-bars .bar")
    );
    DOM.systemStatusIndicator = document.getElementById(
      "systemStatusIndicator"
    );
    DOM.systemStatusText = document.getElementById("systemStatusText");
    DOM.simulationModeBadge = document.getElementById("simulationModeBadge");
    DOM.connectionBanner = document.getElementById("connectionBanner");

    DOM.mainFlowValue = document.getElementById("mainFlowValue");
    DOM.branchFlowValue = document.getElementById("branchFlowValue");
    DOM.flowDiffValue = document.getElementById("flowDiffValue");
    DOM.pressureValue = document.getElementById("pressureValue");
    DOM.leakProbGauge = document.getElementById("leakProbGauge");
    DOM.leakProbValue = document.getElementById("leakProbValue");
    DOM.leakSeverityValue = document.getElementById("leakSeverityValue");
    DOM.leakDurationValue = document.getElementById("leakDurationValue");
    DOM.leakRateValue = document.getElementById("leakRateValue");
    DOM.waterLostValue = document.getElementById("waterLostValue");

    DOM.leakSection = document.getElementById("leakSection");
    DOM.leakIcon = document.getElementById("leakIcon");
    DOM.waterStream = document.querySelector(".water-stream");

    DOM.timeFilterGroup = document.getElementById("timeFilterGroup");
    DOM.toggleMainFlow = document.getElementById("toggleMainFlow");
    DOM.toggleBranchFlow = document.getElementById("toggleBranchFlow");
    DOM.toggleDiff = document.getElementById("toggleDiff");
    DOM.togglePressure = document.getElementById("togglePressure");

    DOM.classificationRows = Array.from(
      document.querySelectorAll(".classification-table tbody tr")
    );
    DOM.classificationBox = document.getElementById("classificationBox");
    DOM.classificationText = document.getElementById("classificationText");

    DOM.logTableBody = document.getElementById("logTableBody");
    DOM.downloadCsvBtn = document.getElementById("downloadCsvBtn");

    DOM.totalWaterMonitored = document.getElementById("totalWaterMonitored");
    DOM.totalLeakEvents = document.getElementById("totalLeakEvents");
    DOM.longestLeakDuration = document.getElementById("longestLeakDuration");
    DOM.averageLeakSize = document.getElementById("averageLeakSize");
    DOM.estimatedTotalWaterLost =
      document.getElementById("estimatedTotalWaterLost");
    DOM.systemAvailability = document.getElementById("systemAvailability");

    DOM.replaySelect = document.getElementById("replaySelect");
    DOM.replaySlider = document.getElementById("replaySlider");
    DOM.replayTimestamp = document.getElementById("replayTimestamp");
    DOM.replayPlayBtn = document.getElementById("replayPlayBtn");
    DOM.alarmSound = document.getElementById("alarmSound");
    DOM.triggerLeakBtn = document.getElementById("triggerLeakBtn");
    DOM.resetSystemBtn = document.getElementById("resetSystemBtn");
    DOM.leakAlertOverlay = document.getElementById("leakAlertOverlay");
    DOM.entryScreen = document.getElementById("entryScreen");
    DOM.enterSystemBtn = document.getElementById("enterSystemBtn");
    DOM.sidebar = document.getElementById("sidebar");
    DOM.sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
    DOM.navItems = Array.from(document.querySelectorAll(".nav-item"));
    DOM.themeToggleBtn = document.getElementById("themeToggleBtn");
    DOM.simulationToggleBtn = document.getElementById("simulationToggleBtn");
    DOM.alarmIndicator = document.getElementById("alarmIndicator");
    DOM.views = {
      live: document.getElementById("view-live"),
      analytics: document.getElementById("view-analytics"),
      history: document.getElementById("view-history"),
      simulation: document.getElementById("view-simulation"),
      system: document.getElementById("view-system"),
      team: document.getElementById("view-team"),
      export: document.getElementById("view-export"),
    };
  }

  function loadThemePreference() {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "light" || stored === "dark") {
        state.ui.theme = stored;
      }
    } catch {
      // ignore
    }
  }

  function saveThemePreference() {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, state.ui.theme);
    } catch {
      // ignore
    }
  }

  function applyTheme() {
    const theme = state.ui.theme === "light" ? "light" : "dark";
    const isLight = theme === "light";
    document.body.classList.toggle("light-mode", isLight);
    document.body.classList.toggle("theme-light", isLight);
    if (DOM.themeToggleBtn) {
      DOM.themeToggleBtn.textContent = theme === "light" ? "☀" : "🌙";
    }
  }

  function updateSimulationUi() {
    if (!DOM.simulationModeBadge) return;
    if (state.isSimulationMode) {
      DOM.simulationModeBadge.classList.remove("hidden");
    } else {
      DOM.simulationModeBadge.classList.add("hidden");
    }
  }

  function startClock() {
    function update() {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      const ss = String(now.getSeconds()).padStart(2, "0");
      DOM.clock.textContent = `${hh}:${mm}:${ss}`;
    }
    update();
    setInterval(update, 1000);
  }

  function classifySeverity(flowDifference) {
    if (flowDifference < FLOW_THRESHOLDS.NORMAL_MAX) {
      return SEVERITY.NORMAL;
    }
    if (flowDifference < FLOW_THRESHOLDS.MINOR_MAX) {
      return SEVERITY.MINOR;
    }
    if (flowDifference < FLOW_THRESHOLDS.MODERATE_MAX) {
      return SEVERITY.MODERATE;
    }
    return SEVERITY.CRITICAL;
  }

  function formatDuration(seconds) {
    if (!seconds || seconds < 1) return "0s";
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function formatUptime(seconds) {
    if (!seconds || seconds < 1) return "0s";
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor((seconds / 3600) % 24);
    const d = Math.floor(seconds / 86400);
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    if (s && !d && !h) parts.push(`${s}s`);
    return parts.join(" ");
  }

  function formatNumber(value, decimals = 1) {
    if (value == null || Number.isNaN(value)) return "--";
    return value.toFixed(decimals);
  }

  function evaluateWifiQuality(dbm) {
    if (typeof dbm !== "number") return { label: "Unknown", bars: 0, class: "" };
    if (dbm >= -60) return { label: "Excellent", bars: 4, class: "good" };
    if (dbm >= -70) return { label: "Good", bars: 3, class: "good" };
    if (dbm >= -80) return { label: "Fair", bars: 2, class: "ok" };
    return { label: "Poor", bars: 1, class: "bad" };
  }

  class DataService {
    constructor(config) {
      this.config = config;
      this.timer = null;
    }

    start() {
      if (this.timer) return;
      this.poll();
      this.timer = setInterval(() => this.poll(), this.config.pollIntervalMs);
    }

    stop() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }

    async poll() {
      if (state.mode !== "live") return;

      if (state.isSimulationMode) {
        const { data, logs } = generateMockPayload();
        handleNewPayload(data, logs);
        return;
      }

      try {
        const [dataRes, logsRes] = await Promise.all([
          fetch(this.config.dataUrl),
          fetch(this.config.logsUrl),
        ]);

        if (!dataRes.ok || !logsRes.ok) {
          this.handleConnectionChange(false);
          return;
        }

        const data = await dataRes.json();
        const logs = await logsRes.json();
        handleNewPayload(data, logs);
      } catch {
        handleConnectionLoss();
      }
    }

  }

  function setConnectionState(isConnected) {
    if (state.connected === isConnected) return;
    state.connected = isConnected;
    updateConnectionBanner(isConnected);
  }

  function updateConnectionBanner(isConnected) {
    if (!DOM.connectionBanner) return;
    DOM.connectionBanner.classList.toggle("hidden", isConnected);
  }

  function scheduleConnectionWatchdog() {
    if (connectionWatchdogTimer) {
      clearTimeout(connectionWatchdogTimer);
    }
    if (state.isSimulationMode) return;
    connectionWatchdogTimer = setTimeout(() => {
      if (!lastDataTimestampMs) return;
      const delta = Date.now() - lastDataTimestampMs;
      if (delta >= CONNECTION_TIMEOUT_MS) {
        setConnectionState(false);
      }
    }, CONNECTION_TIMEOUT_MS);
  }

  function handleConnectionLoss() {
    if (state.isSimulationMode) return;
    setConnectionState(false);
  }

  function handleNewPayload(data, logs) {
    lastDataTimestampMs = Date.now();
    setConnectionState(true);
    scheduleConnectionWatchdog();
    const timestamp = data.timestamp ? new Date(data.timestamp) : new Date();
    const flowDiff = data.flowDifference ?? 0;
    const mainFlow = data.mainFlow ?? 0;
    const branchFlow = data.branchFlow ?? 0;
    const pressure = data.pressure ?? 0;
    const leakProbability = data.leakProbability ?? 0;
    const uptime = data.uptime ?? 0;
    const wifiStrength = data.wifiStrength ?? null;

    const severityByDiff = classifySeverity(flowDiff);

    const previousTimestamp = state.lastTimestamp;
    const nowMs = timestamp.getTime();
    let deltaSec = 1;
    if (previousTimestamp) {
      const diffSec = (nowMs - previousTimestamp.getTime()) / 1000;
      if (diffSec > 0.2 && diffSec < 10) {
        deltaSec = diffSec;
      }
    }
    state.lastTimestamp = timestamp;

    state.availability.totalSeconds += deltaSec;
    if (state.connected) {
      state.availability.upSeconds += deltaSec;
    }

    state.totalWaterMonitoredLiters += (mainFlow * deltaSec) / 60;

    if (flowDiff > FLOW_THRESHOLDS.NORMAL_MAX) {
      state.aboveThresholdDurationSec += deltaSec;
      state.aboveThresholdCount += 1;
    } else {
      state.aboveThresholdDurationSec = 0;
      state.aboveThresholdCount = 0;
    }

    const leakActive =
      state.aboveThresholdCount >= FLOW_THRESHOLDS.REQUIRED_CONSECUTIVE &&
      severityByDiff !== SEVERITY.NORMAL;

    if (leakActive) {
      if (!state.currentLeak) {
        state.currentLeak = {
          id: state.leakEvents.length + 1,
          startTime: timestamp,
          durationSec: 0,
          maxDiff: flowDiff,
          peakSeverity: severityByDiff,
          totalVolumeLiters: 0,
          startIndex: state.dataHistory.length,
        };
      } else {
        state.currentLeak.durationSec += deltaSec;
        state.currentLeak.maxDiff = Math.max(state.currentLeak.maxDiff, flowDiff);
        if (
          severityRank(severityByDiff) >
          severityRank(state.currentLeak.peakSeverity)
        ) {
          state.currentLeak.peakSeverity = severityByDiff;
        }
      }
      const addedLiters = (flowDiff * deltaSec) / 60;
      state.currentLeak.totalVolumeLiters += addedLiters;
      state.totalWaterLostLiters += addedLiters;
    } else if (state.currentLeak) {
      state.currentLeak.endTime = timestamp;
      state.currentLeak.endIndex = state.dataHistory.length;
      state.leakEvents.push(state.currentLeak);
      state.currentLeak = null;
      populateReplaySelect();
    }

    const point = {
      timestamp,
      mainFlow,
      branchFlow,
      flowDifference: flowDiff,
      pressure,
      leakProbability,
      leakSeverity: severityByDiff,
      systemStatus: data.systemStatus || (leakActive ? "LEAK" : "NORMAL"),
      uptime,
      wifiStrength,
      leakActive,
    };

    state.dataHistory.push(point);
    state.timestamps.push(timestamp);
    if (state.dataHistory.length > API_CONFIG.maxHistoryPoints) {
      state.dataHistory.shift();
      state.timestamps.shift();
    }

    state.logs = Array.isArray(logs) ? logs.slice(-200) : [];

    state.leakHistoryForCsv.push({
      timestamp: timestamp.toISOString(),
      mainFlow,
      branchFlow,
      difference: flowDiff,
      severity: severityByDiff,
    });
    if (state.leakHistoryForCsv.length > API_CONFIG.maxHistoryPoints) {
      state.leakHistoryForCsv.shift();
    }

    updateHeader(point);
    updateMetrics(point);
    updateClassification(point);
    updatePipeline(point);
    updateAnalytics();
    updateLogs();
    updateCharts(point);
  }

  function severityRank(sev) {
    switch (sev) {
      case SEVERITY.NORMAL:
        return 0;
      case SEVERITY.MINOR:
        return 1;
      case SEVERITY.MODERATE:
        return 2;
      case SEVERITY.CRITICAL:
        return 3;
      default:
        return 0;
    }
  }

  function updateHeader(point) {
    const uptimeSeconds = point.uptime ?? 0;
    DOM.uptimeValue.textContent = formatUptime(uptimeSeconds);

    if (!state.connected) {
      DOM.wifiStrengthValue.textContent = "-- dBm";
      DOM.wifiQualityLabel.textContent = "Disconnected";
      DOM.wifiBars.forEach((bar) => {
        bar.classList.remove("active", "good", "ok", "bad");
        const level = Number(bar.dataset.level || 0);
        if (level === 1) {
          bar.classList.add("active", "bad");
        }
      });
    } else if (typeof point.wifiStrength === "number") {
      const quality = evaluateWifiQuality(point.wifiStrength);
      DOM.wifiStrengthValue.textContent = `${point.wifiStrength} dBm`;
      DOM.wifiQualityLabel.textContent = quality.label;
      DOM.wifiBars.forEach((bar) => {
        bar.classList.remove("active", "good", "ok", "bad");
        const level = Number(bar.dataset.level || 0);
        if (level <= quality.bars && quality.bars > 0) {
          bar.classList.add("active", quality.class);
        }
      });
    } else {
      DOM.wifiStrengthValue.textContent = "-- dBm";
      DOM.wifiQualityLabel.textContent = "Unknown";
      DOM.wifiBars.forEach((bar) => {
        bar.classList.remove("active", "good", "ok", "bad");
      });
    }

    const severity = point.leakSeverity;
    const systemStatus =
      !state.connected
        ? "SUSPICIOUS"
        : point.systemStatus ||
          (severity === SEVERITY.NORMAL ? "NORMAL" : "LEAK");

    DOM.systemStatusIndicator.classList.remove(
      "status-normal",
      "status-suspicious",
      "status-leak"
    );

    let statusText = "NORMAL";
    if (systemStatus === "LEAK" || severity === SEVERITY.CRITICAL) {
      DOM.systemStatusIndicator.classList.add("status-leak");
      statusText = "LEAK";
    } else if (
      systemStatus === "SUSPICIOUS" ||
      severity === SEVERITY.MINOR ||
      severity === SEVERITY.MODERATE
    ) {
      DOM.systemStatusIndicator.classList.add("status-suspicious");
      statusText = "SUSPICIOUS";
    } else {
      DOM.systemStatusIndicator.classList.add("status-normal");
      statusText = "NORMAL";
    }
    DOM.systemStatusText.textContent = statusText;
  }

  function updateMetrics(point) {
    DOM.mainFlowValue.textContent = formatNumber(point.mainFlow, 1);
    DOM.branchFlowValue.textContent = formatNumber(point.branchFlow, 1);
    DOM.flowDiffValue.textContent = formatNumber(point.flowDifference, 2);
    DOM.pressureValue.textContent = formatNumber(point.pressure, 1);

    const prob = Math.max(0, Math.min(100, point.leakProbability || 0));
    const roundedProb = Math.round(prob);
    if (state.ui.lastGaugeProb !== roundedProb) {
      state.ui.lastGaugeProb = roundedProb;
      DOM.leakProbValue.textContent = `${roundedProb}%`;
      const probDeg = prob * 3.6;

      let color = "#22c55e";
      if (prob >= 80 || point.leakSeverity === SEVERITY.CRITICAL) {
        color = "#ef4444";
      } else if (prob >= 60 || point.leakSeverity === SEVERITY.MODERATE) {
        color = "#f97316";
      } else if (prob >= 40 || point.leakSeverity === SEVERITY.MINOR) {
        color = "#eab308";
      }
      DOM.leakProbGauge.style.setProperty("--gauge-value", String(probDeg));
      DOM.leakProbGauge.style.setProperty("--gauge-color", color);
    }

    DOM.leakSeverityValue.textContent = point.leakSeverity;
    DOM.leakSeverityValue.classList.remove(
      "severity-normal",
      "severity-minor",
      "severity-moderate",
      "severity-critical"
    );
    switch (point.leakSeverity) {
      case SEVERITY.MINOR:
        DOM.leakSeverityValue.classList.add("severity-minor");
        break;
      case SEVERITY.MODERATE:
        DOM.leakSeverityValue.classList.add("severity-moderate");
        break;
      case SEVERITY.CRITICAL:
        DOM.leakSeverityValue.classList.add("severity-critical");
        break;
      default:
        DOM.leakSeverityValue.classList.add("severity-normal");
        break;
    }

    const leakActive = point.leakActive && !!state.currentLeak;
    const leakDurationSec = leakActive ? state.currentLeak.durationSec : 0;
    DOM.leakDurationValue.textContent = formatDuration(leakDurationSec);

    const currentLeakRate = leakActive ? point.flowDifference : 0;
    DOM.leakRateValue.textContent = formatNumber(currentLeakRate, 2);

    const leakVolume = leakActive
      ? state.currentLeak.totalVolumeLiters
      : state.totalWaterLostLiters;
    DOM.waterLostValue.textContent = formatNumber(leakVolume, 2);
  }

  function updateClassification(point) {
    DOM.classificationRows.forEach((row) => row.classList.remove("active"));
    let activeKey = "normal";
    switch (point.leakSeverity) {
      case SEVERITY.MINOR:
        activeKey = "minor";
        break;
      case SEVERITY.MODERATE:
        activeKey = "moderate";
        break;
      case SEVERITY.CRITICAL:
        activeKey = "critical";
        break;
      default:
        activeKey = "normal";
    }
    const row = DOM.classificationRows.find(
      (r) => r.dataset.range === activeKey
    );
    if (row) row.classList.add("active");

    DOM.classificationBox.classList.remove(
      "severity-normal",
      "severity-minor",
      "severity-moderate",
      "severity-critical"
    );
    switch (point.leakSeverity) {
      case SEVERITY.MINOR:
        DOM.classificationBox.classList.add("severity-minor");
        break;
      case SEVERITY.MODERATE:
        DOM.classificationBox.classList.add("severity-moderate");
        break;
      case SEVERITY.CRITICAL:
        DOM.classificationBox.classList.add("severity-critical");
        break;
      default:
        DOM.classificationBox.classList.add("severity-normal");
        break;
    }
    DOM.classificationText.textContent = point.leakSeverity;
  }

  function updatePipeline(point) {
    const leakActive =
      point.leakActive ||
      point.leakSeverity === SEVERITY.MODERATE ||
      point.leakSeverity === SEVERITY.CRITICAL;

    DOM.leakSection.classList.toggle("leak-active", leakActive);
    DOM.leakIcon.classList.toggle("hidden", !leakActive);

    const criticalOrModerate =
      point.leakSeverity === SEVERITY.CRITICAL ||
      point.leakSeverity === SEVERITY.MODERATE;

    if (!state.alarmActive) state.alarmActive = false;
    const shouldAlarmBeActive = criticalOrModerate;

    if (DOM.alarmSound) {
      if (shouldAlarmBeActive && !state.alarmActive) {
        state.alarmActive = true;
        if (DOM.alarmSound.paused) {
          DOM.alarmSound.play().catch(() => {});
        }
      } else if (!shouldAlarmBeActive && state.alarmActive) {
        state.alarmActive = false;
        DOM.alarmSound.pause();
        DOM.alarmSound.currentTime = 0;
      }
    }

    if (DOM.alarmIndicator) {
      DOM.alarmIndicator.classList.toggle("alarm-active", shouldAlarmBeActive);
    }

    if (DOM.leakAlertOverlay) {
      const show =
        point.systemStatus === "LEAK" ||
        point.leakSeverity === SEVERITY.CRITICAL ||
        point.leakActive;
      DOM.leakAlertOverlay.classList.toggle("hidden", !show);
    }

    if (DOM.waterStream) {
      const hasFlow = (point.mainFlow ?? 0) > 0;
      DOM.waterStream.classList.toggle("paused", !hasFlow);
      DOM.waterStream.classList.toggle("fast", hasFlow && leakActive);
    }
  }

  function updateAnalytics() {
    const m3Approx = state.totalWaterMonitoredLiters / 1000;
    DOM.totalWaterMonitored.textContent = formatNumber(m3Approx, 2);

    DOM.totalLeakEvents.textContent = String(state.leakEvents.length);

    let longest = 0;
    state.leakEvents.forEach((ev) => {
      if (ev.durationSec > longest) longest = ev.durationSec;
    });
    if (state.currentLeak && state.currentLeak.durationSec > longest) {
      longest = state.currentLeak.durationSec;
    }
    DOM.longestLeakDuration.textContent = formatDuration(longest);

    const totalLost = state.totalWaterLostLiters;
    DOM.estimatedTotalWaterLost.textContent = formatNumber(totalLost, 2);

    if (state.leakEvents.length > 0) {
      const avgSize = totalLost / state.leakEvents.length;
      DOM.averageLeakSize.textContent = formatNumber(avgSize, 2);
    } else {
      DOM.averageLeakSize.textContent = "0.0";
    }

    const { totalSeconds, upSeconds } = state.availability;
    let availabilityPct = 100;
    if (totalSeconds > 5) {
      availabilityPct = (upSeconds / totalSeconds) * 100;
    }
    DOM.systemAvailability.textContent = `${availabilityPct.toFixed(1)}%`;
  }

  function normalizeLogEntry(entry) {
    if (!entry || typeof entry !== "object") {
      return {
        timestamp: "",
        message: "",
        severity: "NORMAL",
      };
    }
    const ts = entry.timestamp || entry.time || "";
    const severity =
      entry.severity ||
      entry.level ||
      (entry.type && String(entry.type).toUpperCase()) ||
      "NORMAL";
    const message =
      entry.event ||
      entry.message ||
      entry.description ||
      JSON.stringify(entry);
    return { timestamp: ts, message, severity: severity.toUpperCase() };
  }

  function updateLogs() {
    const logs = state.logs.slice(-150);
    DOM.logTableBody.innerHTML = "";
    logs.forEach((raw) => {
      const entry = normalizeLogEntry(raw);
      const tr = document.createElement("tr");
      tr.dataset.severity = entry.severity;

      const timeCell = document.createElement("td");
      timeCell.textContent = entry.timestamp;
      const eventCell = document.createElement("td");
      eventCell.textContent = entry.message;
      const sevCell = document.createElement("td");
      sevCell.textContent = entry.severity;

      tr.appendChild(timeCell);
      tr.appendChild(eventCell);
      tr.appendChild(sevCell);
      DOM.logTableBody.appendChild(tr);
    });

    const tbody = DOM.logTableBody;
    tbody.scrollTop = tbody.scrollHeight;
  }

  function buildCharts() {
    if (!window.Chart) return;

    const baseOptions = {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: "index",
      },
      plugins: {
        legend: {
          labels: {
            color: "#e5e7eb",
            font: {
              family: "Share Tech Mono",
              size: 10,
            },
          },
        },
        tooltip: {
          callbacks: {
            label(ctx) {
              const label = ctx.dataset.label || "";
              const value = ctx.parsed.y;
              return `${label}: ${Number(value).toFixed(2)}`;
            },
          },
        },
        zoom: {
          pan: {
            enabled: true,
            mode: "x",
          },
          zoom: {
            wheel: {
              enabled: true,
            },
            pinch: {
              enabled: true,
            },
            mode: "x",
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#9ca3af",
            maxRotation: 0,
            autoSkip: true,
            font: {
              family: "Share Tech Mono",
              size: 10,
            },
          },
          grid: {
            color: "rgba(55,65,81,0.5)",
          },
        },
        y: {
          ticks: {
            color: "#9ca3af",
            font: {
              family: "Share Tech Mono",
              size: 10,
            },
          },
          grid: {
            color: "rgba(31,41,55,0.7)",
          },
        },
      },
    };

    const mainBranchCtx = document
      .getElementById("mainBranchChart")
      .getContext("2d");
    const diffCtx = document.getElementById("diffChart").getContext("2d");
    const pressureCtx = document
      .getElementById("pressureChart")
      .getContext("2d");

    const mainBranchChart = new Chart(mainBranchCtx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "Main Flow",
            data: [],
            borderColor: "#22d3ee",
            borderWidth: 2,
            tension: 0.35,
            pointRadius: 0,
          },
          {
            label: "Branch Flow",
            data: [],
            borderColor: "#22c55e",
            borderWidth: 2,
            tension: 0.35,
            pointRadius: 0,
          },
        ],
      },
      options: baseOptions,
    });

    const diffChart = new Chart(diffCtx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "Flow Difference",
            data: [],
            borderColor: "#f97316",
            borderWidth: 2,
            tension: 0.35,
            pointRadius: 0,
          },
        ],
      },
      options: baseOptions,
    });

    const pressureChart = new Chart(pressureCtx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "Pressure",
            data: [],
            borderColor: "#6366f1",
            borderWidth: 2,
            tension: 0.35,
            pointRadius: 0,
          },
        ],
      },
      options: baseOptions,
    });

    state.charts = { mainBranchChart, diffChart, pressureChart };
  }

  function timeLabelFromDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  function updateCharts(point) {
    if (!state.charts) return;
    const now = Date.now();
    if (now - lastChartUpdateMs < 2000) {
      return;
    }
    lastChartUpdateMs = now;
    const { mainBranchChart, diffChart, pressureChart } = state.charts;
    const label = timeLabelFromDate(point.timestamp);

    mainBranchChart.data.labels.push(label);
    mainBranchChart.data.datasets[0].data.push(point.mainFlow);
    mainBranchChart.data.datasets[1].data.push(point.branchFlow);

    diffChart.data.labels.push(label);
    diffChart.data.datasets[0].data.push(point.flowDifference);

    pressureChart.data.labels.push(label);
    pressureChart.data.datasets[0].data.push(point.pressure);

    trimChartData(mainBranchChart);
    trimChartData(diffChart);
    trimChartData(pressureChart);

    applyTimeWindow(mainBranchChart);
    applyTimeWindow(diffChart);
    applyTimeWindow(pressureChart);

    mainBranchChart.update("none");
    diffChart.update("none");
    pressureChart.update("none");
  }

  function trimChartData(chart) {
    const max = CHART_MAX_POINTS;
    const { labels, datasets } = chart.data;
    while (labels.length > max) labels.shift();
    datasets.forEach((ds) => {
      while (ds.data.length > max) ds.data.shift();
    });
  }

  function applyTimeWindow(chart) {
    const windowSize = Math.min(state.timeWindowSeconds, CHART_MAX_POINTS);
    const labels = chart.data.labels;
    const len = labels.length;
    if (len <= windowSize) return;
    const start = len - windowSize;
    chart.data.labels = labels.slice(start);
    chart.data.datasets.forEach((ds) => {
      ds.data = ds.data.slice(start);
    });
  }

  function attachChartControls() {
    if (!state.charts) return;
    DOM.timeFilterGroup.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const seconds = Number(btn.dataset.window || 60);
      state.timeWindowSeconds = seconds;
      Array.from(DOM.timeFilterGroup.querySelectorAll(".seg-btn")).forEach(
        (b) => b.classList.remove("active")
      );
      btn.classList.add("active");

      const { mainBranchChart, diffChart, pressureChart } = state.charts;
      reapplyWindowForChart(mainBranchChart);
      reapplyWindowForChart(diffChart);
      reapplyWindowForChart(pressureChart);
    });

    function reapplyWindowForChart(chart) {
      const fullLen = chart.data.labels.length;
      const windowSize = Math.min(
        Math.min(state.timeWindowSeconds, CHART_MAX_POINTS),
        fullLen
      );
      if (windowSize <= 0) return;
      const start = fullLen - windowSize;
      chart.data.labels = chart.data.labels.slice(start);
      chart.data.datasets.forEach((ds) => {
        ds.data = ds.data.slice(start);
      });
      chart.update("none");
    }

    DOM.toggleMainFlow.addEventListener("change", () => {
      state.charts.mainBranchChart.data.datasets[0].hidden =
        !DOM.toggleMainFlow.checked;
      state.charts.mainBranchChart.update("none");
    });
    DOM.toggleBranchFlow.addEventListener("change", () => {
      state.charts.mainBranchChart.data.datasets[1].hidden =
        !DOM.toggleBranchFlow.checked;
      state.charts.mainBranchChart.update("none");
    });
    DOM.toggleDiff.addEventListener("change", () => {
      state.charts.diffChart.data.datasets[0].hidden =
        !DOM.toggleDiff.checked;
      state.charts.diffChart.update("none");
    });
    DOM.togglePressure.addEventListener("change", () => {
      state.charts.pressureChart.data.datasets[0].hidden =
        !DOM.togglePressure.checked;
      state.charts.pressureChart.update("none");
    });
  }

  function populateReplaySelect() {
    const select = DOM.replaySelect;
    const activeValue = select.value;
    select.innerHTML = "";

    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "None (Live Mode)";
    select.appendChild(noneOpt);

    state.leakEvents.forEach((ev) => {
      const option = document.createElement("option");
      option.value = String(ev.id);
      const start = ev.startTime;
      const end = ev.endTime || ev.startTime;
      const duration = ev.durationSec || (end - start) / 1000 || 0;
      option.textContent = `Leak #${ev.id} • ${timeLabelFromDate(
        start
      )} • ${formatDuration(duration)} • ${ev.peakSeverity}`;
      select.appendChild(option);
    });

    select.value = activeValue || "";
    updateReplayControlsEnabled();
  }

  function updateReplayControlsEnabled() {
    const hasEvents = state.leakEvents.length > 0;
    DOM.replaySelect.disabled = !hasEvents;
    DOM.replayPlayBtn.disabled = !hasEvents;
    if (!hasEvents) {
      DOM.replaySlider.disabled = true;
      DOM.replayTimestamp.textContent = "--";
    }
  }

  function enterReplayMode() {
    if (!state.replay.activeEvent) return;
    state.mode = "replay";
    dataService.stop();
    DOM.replayPlayBtn.textContent = "Return to Live";
    const ev = state.replay.activeEvent;
    configureReplaySlider(ev);
    renderReplaySnapshot(ev, 0);
  }

  function exitReplayMode() {
    state.mode = "live";
    state.replay.activeEvent = null;
    DOM.replaySelect.value = "";
    DOM.replaySlider.disabled = true;
    DOM.replayTimestamp.textContent = "--";
    DOM.replayPlayBtn.textContent = "Enter Replay";
    dataService.start();
  }

  function configureReplaySlider(ev) {
    const duration = ev.durationSec || 1;
    DOM.replaySlider.min = "0";
    DOM.replaySlider.max = String(Math.max(1, Math.floor(duration)));
    DOM.replaySlider.value = "0";
    DOM.replaySlider.disabled = false;
  }

  function renderReplaySnapshot(ev, secondsOffset) {
    const history = state.dataHistory;
    if (!history.length) return;

    const startIndex =
      typeof ev.startIndex === "number" ? ev.startIndex : 0;
    const endIndex =
      typeof ev.endIndex === "number"
        ? ev.endIndex
        : history.length - 1;
    if (startIndex > endIndex) return;

    const range = endIndex - startIndex + 1;
    const clamped = Math.max(0, Math.min(range - 1, secondsOffset));
    const index = startIndex + clamped;
    const point = history[index];
    if (!point) return;

    DOM.replayTimestamp.textContent = `${point.timestamp.toLocaleString()}`;

    updateHeader(point);
    updateMetrics(point);
    updateClassification(point);
    updatePipeline(point);

    if (!state.charts) return;
    const { mainBranchChart, diffChart, pressureChart } = state.charts;

    const labels = [];
    const mainData = [];
    const branchData = [];
    const diffData = [];
    const pressureData = [];

    for (let i = startIndex; i <= endIndex; i++) {
      const p = history[i];
      labels.push(timeLabelFromDate(p.timestamp));
      mainData.push(p.mainFlow);
      branchData.push(p.branchFlow);
      diffData.push(p.flowDifference);
      pressureData.push(p.pressure);
    }

    mainBranchChart.data.labels = labels;
    mainBranchChart.data.datasets[0].data = mainData;
    mainBranchChart.data.datasets[1].data = branchData;
    diffChart.data.labels = labels;
    diffChart.data.datasets[0].data = diffData;
    pressureChart.data.labels = labels;
    pressureChart.data.datasets[0].data = pressureData;

    mainBranchChart.update("none");
    diffChart.update("none");
    pressureChart.update("none");
  }

  function attachReplayControls() {
    DOM.replaySelect.addEventListener("change", (e) => {
      const value = e.target.value;
      if (!value) {
        if (state.mode === "replay") {
          exitReplayMode();
        }
        return;
      }
      const id = Number(value);
      const event = state.leakEvents.find((ev) => ev.id === id);
      state.replay.activeEvent = event || null;
      if (state.mode === "replay" && event) {
        configureReplaySlider(event);
        renderReplaySnapshot(event, 0);
      }
    });

    DOM.replayPlayBtn.addEventListener("click", () => {
      if (state.mode === "live") {
        if (!state.replay.activeEvent && state.leakEvents.length) {
          state.replay.activeEvent = state.leakEvents[state.leakEvents.length - 1];
        }
        if (state.replay.activeEvent) {
          enterReplayMode();
        }
      } else {
        exitReplayMode();
      }
    });

    DOM.replaySlider.addEventListener("input", (e) => {
      if (!state.replay.activeEvent || state.mode !== "replay") return;
      const secondsOffset = Number(e.target.value || 0);
      renderReplaySnapshot(state.replay.activeEvent, secondsOffset);
    });
  }

  function attachCsvExport() {
    DOM.downloadCsvBtn.addEventListener("click", () => {
      const rows = state.leakHistoryForCsv;
      if (!rows.length) return;
      const header = [
        "timestamp",
        "mainFlow",
        "branchFlow",
        "difference",
        "severity",
      ];
      const lines = [header.join(",")];
      rows.forEach((row) => {
        const line = [
          row.timestamp,
          row.mainFlow ?? "",
          row.branchFlow ?? "",
          row.difference ?? "",
          row.severity ?? "",
        ]
          .map((v) => String(v).replace(/"/g, '""'))
          .join(",");
        lines.push(line);
      });
      const blob = new Blob([lines.join("\n")], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      a.download = `leak-history-${ts}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  function attachExportReport() {
    const exportCsvBtn = document.getElementById("exportCsvBtn");
    const exportPdfBtn = document.getElementById("exportPdfBtn");
    if (exportCsvBtn && DOM.downloadCsvBtn) {
      exportCsvBtn.addEventListener("click", () => {
        DOM.downloadCsvBtn.click();
      });
    }
    const downloadPdfBtn = document.getElementById("downloadPdfBtn");
    if (downloadPdfBtn && exportPdfBtn) {
      downloadPdfBtn.addEventListener("click", () => {
        window.print();
      });
      exportPdfBtn.addEventListener("click", () => {
        window.print();
      });
    } else if (exportPdfBtn) {
      exportPdfBtn.addEventListener("click", () => {
        window.print();
      });
    }
  }

  function setActiveView(viewKey) {
    const key = state.ui.views?.includes?.(viewKey) ? viewKey : viewKey;
    state.ui.activeView = viewKey;
    if (DOM.views) {
      Object.entries(DOM.views).forEach(([name, el]) => {
        if (!el) return;
        el.classList.toggle("active", name === viewKey);
      });
    }
    if (DOM.navItems) {
      DOM.navItems.forEach((btn) => {
        const target = btn.dataset.view;
        btn.classList.toggle("active", target === viewKey);
      });
    }
  }

  function attachViewNavigation() {
    if (DOM.navItems) {
      DOM.navItems.forEach((btn) => {
        btn.addEventListener("click", () => {
          if (state.ui.navigationLocked) return;
          state.ui.navigationLocked = true;
          setTimeout(() => {
            state.ui.navigationLocked = false;
          }, 200);
          const view = btn.dataset.view || "live";
          setActiveView(view);
        });
      });
    }
    if (DOM.sidebarToggleBtn && DOM.sidebar) {
      DOM.sidebarToggleBtn.addEventListener("click", () => {
        DOM.sidebar.classList.toggle("collapsed");
      });
    }
  }

  function attachThemeToggle() {
    if (!DOM.themeToggleBtn) return;
    DOM.themeToggleBtn.addEventListener("click", () => {
      state.ui.theme = state.ui.theme === "light" ? "dark" : "light";
      applyTheme();
      saveThemePreference();
    });
  }

  function attachEntryScreen() {
    if (!DOM.entryScreen || !DOM.enterSystemBtn) return;
    DOM.enterSystemBtn.addEventListener("click", () => {
      state.ui.entryCompleted = true;
      DOM.entryScreen.classList.add("hidden");
    });
  }

  function forceTriggerLeak() {
    if (!state.isSimulationMode) return;
    mockState.inLeak = true;
    mockState.leakRemainingSec = randomInt(
      MOCK_SIM_CONFIG.leakDurationMinSec,
      MOCK_SIM_CONFIG.leakDurationMaxSec
    );
    mockState.forceCriticalFlowDiff = 3.5;
    state.aboveThresholdDurationSec = FLOW_THRESHOLDS.SUSTAIN_SECONDS;
    mockState.clockMs += API_CONFIG.pollIntervalMs;
    mockState.uptimeSec += API_CONFIG.pollIntervalMs / 1000;
    const ts = new Date(mockState.clockMs).toISOString();
    const mainFlow = randomInRange(MOCK_SIM_CONFIG.mainFlowMin, MOCK_SIM_CONFIG.mainFlowMax);
    const flowDifference = 3.5;
    const branchFlow = Math.max(0, mainFlow - flowDifference);
    const data = {
      timestamp: ts,
      mainFlow,
      branchFlow,
      flowDifference,
      pressure: randomInRange(MOCK_SIM_CONFIG.pressureMin, MOCK_SIM_CONFIG.pressureMax),
      leakProbability: 85,
      uptime: mockState.uptimeSec,
      wifiStrength: -65,
      systemStatus: "LEAK",
    };
    const logs = [{ timestamp: ts, severity: "WARNING", message: "Triggered leak (manual)" }];
    handleNewPayload(data, logs);
  }

  function resetSystem() {
    if (DOM.alarmSound) {
      DOM.alarmSound.pause();
      DOM.alarmSound.currentTime = 0;
    }
    state.currentLeak = null;
    state.aboveThresholdDurationSec = 0;
    state.aboveThresholdCount = 0;
    state.totalWaterLostLiters = 0;
    state.leakEvents = [];
    if (state.isSimulationMode) {
      mockState.inLeak = false;
      mockState.leakRemainingSec = 0;
      mockState.forceCriticalFlowDiff = 0;
      mockState.untilNextLeakSec = randomInt(
        MOCK_SIM_CONFIG.leakIntervalMinSec,
        MOCK_SIM_CONFIG.leakIntervalMaxSec
      );
    }
    populateReplaySelect();
    updateReplayControlsEnabled();
    const last = state.dataHistory[state.dataHistory.length - 1];
    const normalPoint = last
      ? {
          ...last,
          flowDifference: 0.2,
          leakSeverity: SEVERITY.NORMAL,
          leakActive: false,
          systemStatus: "NORMAL",
          leakProbability: 10,
        }
      : {
          timestamp: new Date(),
          mainFlow: 4,
          branchFlow: 3.8,
          flowDifference: 0.2,
          pressure: 101,
          leakProbability: 10,
          leakSeverity: SEVERITY.NORMAL,
          leakActive: false,
          systemStatus: "NORMAL",
          uptime: mockState.uptimeSec || 0,
          wifiStrength: -65,
        };
    updateHeader(normalPoint);
    updateMetrics(normalPoint);
    updateClassification(normalPoint);
    updatePipeline(normalPoint);
    updateAnalytics();
  }

  function attachSimulationButtons() {
    if (DOM.simulationToggleBtn) {
      DOM.simulationToggleBtn.addEventListener("click", () => {
        state.isSimulationMode = !state.isSimulationMode;
        updateSimulationUi();
        if (!state.isSimulationMode) {
          // entering live mode: reset connection watchdog state
          lastDataTimestampMs = null;
          setConnectionState(true);
        } else {
          // back to simulation, clear watchdog
          if (connectionWatchdogTimer) {
            clearTimeout(connectionWatchdogTimer);
            connectionWatchdogTimer = null;
          }
          setConnectionState(true);
        }
      });
    }
    if (DOM.triggerLeakBtn) {
      DOM.triggerLeakBtn.addEventListener("click", forceTriggerLeak);
    }
    if (DOM.resetSystemBtn) {
      DOM.resetSystemBtn.addEventListener("click", resetSystem);
    }
  }

  const dataService = new DataService(API_CONFIG);

  function init() {
    initDomRefs();
    loadThemePreference();
    updateSimulationUi();
    applyTheme();
    attachEntryScreen();
    attachViewNavigation();
    attachThemeToggle();
    startClock();
    buildCharts();
    attachChartControls();
    attachReplayControls();
    attachCsvExport();
    attachExportReport();
    attachSimulationButtons();
    updateReplayControlsEnabled();
    dataService.start();
    document.body.addEventListener(
      "click",
      () => {
        if (DOM.alarmSound) {
          DOM.alarmSound.play().then(() => {
            DOM.alarmSound.pause();
            DOM.alarmSound.currentTime = 0;
          }).catch(() => {});
        }
      },
      { once: true }
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

