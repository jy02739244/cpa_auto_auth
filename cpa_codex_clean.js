// ==UserScript==
// @name         CPA AuthFiles Non-Active Cleaner
// @namespace    openai_registor
// @version      1.0.0
// @description  右侧悬浮栏：获取失效/禁止文件并确认删除
// @author       local
// @match        *://*/management.html
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const BASE_ORIGIN = window.location.origin;
  const AUTH_FILES_URL = `${BASE_ORIGIN}/v0/management/auth-files`;
  const AUTH_FILE_STATUS_URL = `${BASE_ORIGIN}/v0/management/auth-files/status`;
  const API_CALL_URL = `${BASE_ORIGIN}/v0/management/api-call`;
  const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
  const DEFAULT_UA = "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal";
  const QUERY_CACHE_KEY = "tm_usage_query_cache_v1";
  const QUERY_CACHE_MAX_ENTRIES = 5000;
  const MANUAL_TOKEN_KEY = "tm_manual_auth_token";

  let pendingFiles = [];
  let usageQueryCache = loadUsageQueryCache();

  function getManualToken() {
    const manualSession = normalizeTokenString(sessionStorage.getItem(MANUAL_TOKEN_KEY) || "");
    if (manualSession) return manualSession;
    const manualLocal = normalizeTokenString(localStorage.getItem(MANUAL_TOKEN_KEY) || "");
    if (manualLocal) return manualLocal;
    return "";
  }

  function setManualToken(token) {
    const value = normalizeTokenString(String(token || ""));
    if (value) {
      sessionStorage.setItem(MANUAL_TOKEN_KEY, value);
      return;
    }
    sessionStorage.removeItem(MANUAL_TOKEN_KEY);
    localStorage.removeItem(MANUAL_TOKEN_KEY);
  }

  function authFailureHint(statusCode) {
    const code = Number(statusCode);
    return code === 401 || code === 403 ? "（登录态可能失效，可手动设置 token）" : "";
  }

  function normalizeTokenString(value) {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (/^Bearer\s+/i.test(trimmed)) {
      return trimmed.replace(/^Bearer\s+/i, "").trim();
    }
    return trimmed;
  }

  function getCachedToken() {
    return getManualToken();
  }

  function extractFileName(item) {
    for (const key of ["name", "id", "filename", "file_name"]) {
      const value = item?.[key];
      if (value) return String(value);
    }
    return null;
  }

  function extractAuthIndex(item) {
    for (const key of ["authIndex", "auth_index", "authindex"]) {
      const value = item?.[key];
      if (value) return String(value);
    }
    return null;
  }

  function extractChatgptAccountId(item) {
    for (const key of ["chatgpt_account_id", "chatgptAccountId", "account_id", "accountId"]) {
      const value = item?.[key];
      if (value) return String(value);
    }
    return null;
  }

  function extractType(item) {
    for (const key of ["type", "auth_type", "authType"]) {
      const value = item?.[key];
      if (value !== undefined && value !== null && value !== "") {
        return String(value);
      }
    }
    return "";
  }

  function getHeaders(token) {
    const normalizedToken = normalizeTokenString(token || "");
    const headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9",
      Referer: `${BASE_ORIGIN}/management.html`,
    };
    if (normalizedToken) {
      headers.authorization = `Bearer ${normalizedToken}`;
    }
    return headers;
  }

  function getCacheKey(item) {
    const auth = item?.authIndex ? String(item.authIndex) : "";
    if (auth) return `auth:${auth}`;
    const name = item?.name ? String(item.name) : "";
    if (name) return `name:${name}`;
    return "";
  }

  function loadUsageQueryCache() {
    try {
      const raw = localStorage.getItem(QUERY_CACHE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
      return {};
    } catch (_) {
      return {};
    }
  }

  function saveUsageQueryCache() {
    try {
      const entries = Object.entries(usageQueryCache);
      if (entries.length > QUERY_CACHE_MAX_ENTRIES) {
        entries.sort((a, b) => {
          const ta = Number(a?.[1]?.queriedAt || 0);
          const tb = Number(b?.[1]?.queriedAt || 0);
          return tb - ta;
        });
        usageQueryCache = Object.fromEntries(entries.slice(0, QUERY_CACHE_MAX_ENTRIES));
      }
      localStorage.setItem(QUERY_CACHE_KEY, JSON.stringify(usageQueryCache));
    } catch (_) {
      // ignore cache write errors
    }
  }

  function getCachedUsageForItem(item) {
    const key = getCacheKey(item);
    if (!key) return null;
    const cached = usageQueryCache[key];
    return cached && typeof cached === "object" ? cached : null;
  }

  function applyCachedUsageToItem(item, cachedEntry) {
    const cached = cachedEntry || getCachedUsageForItem(item);
    if (!cached) return false;

    item.usedPercent =
      cached.usedPercent === null || cached.usedPercent === undefined
        ? null
        : Number(cached.usedPercent);
    item.resetText = cached.resetText || "-";
    item.lastStatusCode =
      cached.statusCode === null || cached.statusCode === undefined
        ? null
        : cached.statusCode;
    item.lastBalancePayload = {
      title: `余额查询结果 - ${item.name}`,
      statusCode: cached.statusCode ?? null,
      bodyObj:
        cached.bodyObj && typeof cached.bodyObj === "object"
          ? cached.bodyObj
          : null,
      bodyText: cached.bodyText || "",
      bodyParsed: Boolean(cached.bodyParsed),
    };
    let needSave = false;
    if (item.name && !cached.name) {
      cached.name = item.name;
      needSave = true;
    }
    if (item.status && !cached.fileStatus) {
      cached.fileStatus = item.status;
      needSave = true;
    }
    if (needSave) saveUsageQueryCache();
    return true;
  }

  function updateUsageCacheForItem(item, result, snapshot) {
    const key = getCacheKey(item);
    if (!key) return;
    usageQueryCache[key] = {
      name: item?.name || "",
      fileStatus: item?.status || "",
      statusCode: result?.statusCode ?? null,
      usedPercent:
        snapshot?.usedPercent === null || snapshot?.usedPercent === undefined
          ? null
          : Number(snapshot.usedPercent),
      resetText: snapshot?.resetText || "-",
      bodyObj:
        result?.bodyObj && typeof result.bodyObj === "object"
          ? result.bodyObj
          : null,
      bodyText: result?.bodyText || "",
      bodyParsed: Boolean(result?.bodyParsed),
      queriedAt: Date.now(),
    };
    saveUsageQueryCache();
  }

  function normalizeFilesPayload(data) {
    const files = Array.isArray(data?.files)
      ? data.files.filter((x) => x && typeof x === "object")
      : Array.isArray(data)
      ? data.filter((x) => x && typeof x === "object")
      : [];

    const items = [];
    for (const item of files) {
      const name = extractFileName(item);
      const authIndex = extractAuthIndex(item);
      const chatgptAccountId = extractChatgptAccountId(item);
      const type = extractType(item);
      if (type.toLowerCase() !== "codex") continue;
      if (!name && !authIndex) continue;
      items.push({
        name: name || "(no-name)",
        authIndex: authIndex || "",
        status: String(item?.status ?? ""),
        type,
        chatgptAccountId: chatgptAccountId || "",
        usedPercent: null,
        resetText: "-",
        lastStatusCode: null,
        lastBalancePayload: null,
      });
    }
    items.forEach((x) => {
      applyCachedUsageToItem(x);
    });
    return items;
  }

  async function fetchAllFiles(token) {
    const resp = await fetch(AUTH_FILES_URL, {
      method: "GET",
      headers: getHeaders(token),
      credentials: "include",
    });
    if (!resp.ok) {
      throw new Error(`GET 失败: HTTP ${resp.status}${authFailureHint(resp.status)}`);
    }
    const data = await resp.json();
    return normalizeFilesPayload(data);
  }

  async function fetchNonActive(token) {
    const all = await fetchAllFiles(token);
    return all.filter((x) => String(x.status ?? "").toLowerCase() !== "active");
  }

  async function patchFileStatus(token, name, disabled) {
    const resp = await fetch(AUTH_FILE_STATUS_URL, {
      method: "PATCH",
      headers: {
        ...getHeaders(token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name,
        disabled: Boolean(disabled),
      }),
      credentials: "include",
    });

    let json = null;
    try {
      json = await resp.json();
    } catch (_) {
      json = null;
    }

    const ok = resp.ok && json?.status === "ok";
    return {
      ok,
      status: resp.status,
      disabled: json?.disabled,
      message: json?.status || JSON.stringify(json || {}),
    };
  }

  async function deleteByName(token, name) {
    const url = `${AUTH_FILES_URL}?name=${encodeURIComponent(name)}`;
    const resp = await fetch(url, {
      method: "DELETE",
      headers: getHeaders(token),
      credentials: "include",
    });

    let json = null;
    try {
      json = await resp.json();
    } catch (_) {
      json = null;
    }

    const ok = resp.status === 200 && (!json || json.status === "ok");
    return {
      name,
      ok,
      status: resp.status,
      message: ok ? "ok" : JSON.stringify(json || {}),
    };
  }

  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function parseApiCallBody(data) {
    const statusCode = data?.status_code ?? data?.statusCode ?? null;
    const rawBody = data?.body;

    if (typeof rawBody === "string") {
      const parsed = safeJson(rawBody);
      if (parsed && typeof parsed === "object") {
        return {
          statusCode,
          bodyObj: parsed,
          bodyText: JSON.stringify(parsed, null, 2),
          bodyParsed: true,
        };
      }
      return {
        statusCode,
        bodyObj: null,
        bodyText: rawBody,
        bodyParsed: false,
      };
    }

    if (rawBody && typeof rawBody === "object") {
      return {
        statusCode,
        bodyObj: rawBody,
        bodyText: JSON.stringify(rawBody, null, 2),
        bodyParsed: true,
      };
    }

    if (rawBody === null || rawBody === undefined) {
      return {
        statusCode,
        bodyObj: null,
        bodyText: "",
        bodyParsed: true,
      };
    }

    return {
      statusCode,
      bodyObj: null,
      bodyText: String(rawBody),
      bodyParsed: false,
    };
  }

  async function queryUsageByAuthIndex(token, fileItem) {
    if (!fileItem?.authIndex) {
      return {
        ok: false,
        name: fileItem?.name || "",
        authIndex: "",
        message: "missing authIndex",
      };
    }

    const header = {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "User-Agent": DEFAULT_UA,
    };
    if (fileItem.chatgptAccountId) {
      header["Chatgpt-Account-Id"] = fileItem.chatgptAccountId;
    }

    const body = {
      authIndex: fileItem.authIndex,
      method: "GET",
      url: USAGE_URL,
      header,
    };

    const resp = await fetch(API_CALL_URL, {
      method: "POST",
      headers: {
        ...getHeaders(token),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      credentials: "include",
    });

    const text = await resp.text();
    const data = safeJson(text);
    const parsed = data
      ? parseApiCallBody(data)
      : { statusCode: null, bodyObj: null, bodyText: text, bodyParsed: false };
    return {
      ok: resp.ok && parsed.statusCode === 200,
      name: fileItem.name,
      authIndex: fileItem.authIndex,
      http: resp.status,
      statusCode: parsed.statusCode,
      bodyObj: parsed.bodyObj,
      bodyText: parsed.bodyText,
      bodyParsed: parsed.bodyParsed,
      raw: data || null,
    };
  }

  function createSidebar() {
    const PANEL_WIDTH = 380;
    const TOGGLE_WIDTH = 44;
    const HIDDEN_X = PANEL_WIDTH;
    let isOpen = false;
    let queryAllRunning = false;
    let stopQueryAllRequested = false;

    const bar = document.createElement("div");
    bar.style.position = "fixed";
    bar.style.right = "0";
    bar.style.top = "50%";
    bar.style.transform = `translate(${HIDDEN_X}px, -50%)`;
    bar.style.width = `${PANEL_WIDTH}px`;
    bar.style.maxHeight = "92vh";
    bar.style.zIndex = "99999";
    bar.style.background = "#111827";
    bar.style.color = "#f9fafb";
    bar.style.border = "1px solid #374151";
    bar.style.borderRadius = "12px";
    bar.style.padding = "12px";
    bar.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";
    bar.style.fontFamily =
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    bar.style.transition = "transform 0.2s ease";
    bar.style.overflow = "visible";
    bar.style.display = "flex";
    bar.style.flexDirection = "column";

    let balanceModal = null;
    let filterModal = null;

    function ensureFilterModal() {
      if (filterModal) return filterModal;

      const fOverlay = document.createElement("div");
      fOverlay.style.position = "fixed";
      fOverlay.style.inset = "0";
      fOverlay.style.background = "rgba(0, 0, 0, 0.5)";
      fOverlay.style.zIndex = "100002";
      fOverlay.style.display = "none";

      const fPanel = document.createElement("div");
      fPanel.style.position = "absolute";
      fPanel.style.left = "50%";
      fPanel.style.top = "50%";
      fPanel.style.transform = "translate(-50%, -50%)";
      fPanel.style.width = "min(1200px, 92vw)";
      fPanel.style.height = "min(85vh, 960px)";
      fPanel.style.background = "linear-gradient(180deg, #0b1220 0%, #111827 100%)";
      fPanel.style.color = "#f8fafc";
      fPanel.style.border = "1px solid #334155";
      fPanel.style.borderRadius = "16px";
      fPanel.style.boxShadow = "0 20px 50px rgba(0, 0, 0, 0.5)";
      fPanel.style.display = "flex";
      fPanel.style.flexDirection = "column";
      fPanel.style.padding = "16px";

      const fHeader = document.createElement("div");
      fHeader.style.display = "flex";
      fHeader.style.alignItems = "center";
      fHeader.style.justifyContent = "space-between";
      fHeader.style.marginBottom = "10px";
      fHeader.style.flexShrink = "0";

      const fTitle = document.createElement("div");
      fTitle.textContent = "额度筛选结果";
      fTitle.style.fontSize = "16px";
      fTitle.style.fontWeight = "700";

      const fStats = document.createElement("div");
      fStats.style.fontSize = "12px";
      fStats.style.color = "#93c5fd";
      fStats.style.marginLeft = "12px";
      fStats.textContent = "";

      const fTitleRow = document.createElement("div");
      fTitleRow.style.display = "flex";
      fTitleRow.style.alignItems = "center";
      fTitleRow.appendChild(fTitle);
      fTitleRow.appendChild(fStats);
      fHeader.appendChild(fTitleRow);

      const fCloseBtn = document.createElement("button");
      fCloseBtn.textContent = "关闭";
      fCloseBtn.style.border = "0";
      fCloseBtn.style.borderRadius = "8px";
      fCloseBtn.style.padding = "6px 14px";
      fCloseBtn.style.cursor = "pointer";
      fCloseBtn.style.background = "#334155";
      fCloseBtn.style.color = "#fff";
      fCloseBtn.style.fontSize = "13px";
      fHeader.appendChild(fCloseBtn);

      /* ---- table header (fixed) ---- */
      const fTableHeader = document.createElement("div");
      fTableHeader.style.display = "flex";
      fTableHeader.style.alignItems = "center";
      fTableHeader.style.padding = "8px 4px";
      fTableHeader.style.borderBottom = "2px solid #334155";
      fTableHeader.style.fontSize = "12px";
      fTableHeader.style.fontWeight = "700";
      fTableHeader.style.color = "#94a3b8";
      fTableHeader.style.flexShrink = "0";
      const thCols = [
        { text: "#", width: "50px" },
        { text: "文件名称", width: "1" },
        { text: "已用百分比", width: "130px" },
        { text: "重置时间", width: "180px" },
        { text: "状态码", width: "70px" },
        { text: "查询时间", width: "160px" },
        { text: "操作", width: "120px" },
      ];
      thCols.forEach((col) => {
        const th = document.createElement("div");
        th.textContent = col.text;
        if (col.width === "1") {
          th.style.flex = "1";
          th.style.minWidth = "0";
        } else {
          th.style.width = col.width;
          th.style.flexShrink = "0";
        }
        th.style.padding = "0 4px";
        th.style.boxSizing = "border-box";
        fTableHeader.appendChild(th);
      });

      /* ---- table body (scrollable) ---- */
      const fTableBody = document.createElement("div");
      fTableBody.style.flex = "1";
      fTableBody.style.overflow = "auto";
      fTableBody.style.minHeight = "0";

      /* ---- pagination bar ---- */
      const fPager = document.createElement("div");
      fPager.style.display = "flex";
      fPager.style.alignItems = "center";
      fPager.style.justifyContent = "center";
      fPager.style.gap = "12px";
      fPager.style.padding = "10px 0 0";
      fPager.style.flexShrink = "0";

      const fPrevBtn = document.createElement("button");
      fPrevBtn.textContent = "上一页";
      fPrevBtn.style.border = "0";
      fPrevBtn.style.borderRadius = "6px";
      fPrevBtn.style.padding = "6px 14px";
      fPrevBtn.style.cursor = "pointer";
      fPrevBtn.style.background = "#2563eb";
      fPrevBtn.style.color = "#fff";
      fPrevBtn.style.fontSize = "12px";

      const fPageInfo = document.createElement("span");
      fPageInfo.style.fontSize = "12px";
      fPageInfo.style.color = "#cbd5e1";

      const fNextBtn = document.createElement("button");
      fNextBtn.textContent = "下一页";
      fNextBtn.style.border = "0";
      fNextBtn.style.borderRadius = "6px";
      fNextBtn.style.padding = "6px 14px";
      fNextBtn.style.cursor = "pointer";
      fNextBtn.style.background = "#2563eb";
      fNextBtn.style.color = "#fff";
      fNextBtn.style.fontSize = "12px";

      fPager.appendChild(fPrevBtn);
      fPager.appendChild(fPageInfo);
      fPager.appendChild(fNextBtn);

      /* ---- assemble panel ---- */
      fPanel.appendChild(fHeader);
      fPanel.appendChild(fTableHeader);
      fPanel.appendChild(fTableBody);
      fPanel.appendChild(fPager);
      fOverlay.appendChild(fPanel);
      document.body.appendChild(fOverlay);

      fCloseBtn.addEventListener("click", () => {
        fOverlay.style.display = "none";
      });
      fOverlay.addEventListener("click", (e) => {
        if (e.target === fOverlay) fOverlay.style.display = "none";
      });

      /* ---- state ---- */
      let fData = [];
      let fPage = 0;
      const PAGE_SIZE = 20;

      function renderPage() {
        fTableBody.innerHTML = "";
        const totalPages = Math.max(1, Math.ceil(fData.length / PAGE_SIZE));
        if (fPage >= totalPages) fPage = totalPages - 1;
        if (fPage < 0) fPage = 0;
        const start = fPage * PAGE_SIZE;
        const slice = fData.slice(start, start + PAGE_SIZE);

        slice.forEach((entry, i) => {
          const row = document.createElement("div");
          row.style.display = "flex";
          row.style.alignItems = "center";
          row.style.padding = "7px 4px";
          row.style.borderBottom = "1px solid #1e293b";
          row.style.fontSize = "12px";
          row.style.color = "#e2e8f0";
          if (i % 2 === 1) row.style.background = "rgba(30, 41, 59, 0.35)";

          /* # */
          const cIdx = document.createElement("div");
          cIdx.style.width = "50px";
          cIdx.style.flexShrink = "0";
          cIdx.style.padding = "0 4px";
          cIdx.textContent = String(start + i + 1);
          row.appendChild(cIdx);

          /* 文件名称 */
          const cKey = document.createElement("div");
          cKey.style.flex = "1";
          cKey.style.minWidth = "0";
          cKey.style.padding = "0 4px";
          cKey.style.wordBreak = "break-all";
          cKey.textContent = entry.name || entry.key;
          row.appendChild(cKey);

          /* 已用百分比 + mini progress bar */
          const cPct = document.createElement("div");
          cPct.style.width = "130px";
          cPct.style.flexShrink = "0";
          cPct.style.padding = "0 4px";
          const pctVal = entry.usedPercent === null || entry.usedPercent === undefined ? 0 : Number(entry.usedPercent);
          const pctLabel = document.createElement("div");
          pctLabel.textContent = `${pctVal}%`;
          pctLabel.style.marginBottom = "3px";
          pctLabel.style.fontSize = "11px";
          pctLabel.style.fontWeight = "700";
          pctLabel.style.color = pctVal >= 100 ? "#ef4444" : pctVal >= 80 ? "#f59e0b" : "#10b981";
          cPct.appendChild(pctLabel);
          const pctBg = document.createElement("div");
          pctBg.style.height = "5px";
          pctBg.style.width = "100%";
          pctBg.style.borderRadius = "999px";
          pctBg.style.background = "#1f2937";
          pctBg.style.overflow = "hidden";
          const pctFill = document.createElement("div");
          pctFill.style.height = "100%";
          pctFill.style.width = `${Math.max(0, Math.min(100, pctVal))}%`;
          pctFill.style.borderRadius = "999px";
          pctFill.style.background = pctVal >= 100 ? "#ef4444" : pctVal >= 80 ? "#f59e0b" : "#10b981";
          pctBg.appendChild(pctFill);
          cPct.appendChild(pctBg);
          row.appendChild(cPct);

          /* 重置时间 */
          const cReset = document.createElement("div");
          cReset.style.width = "180px";
          cReset.style.flexShrink = "0";
          cReset.style.padding = "0 4px";
          cReset.style.fontSize = "11px";
          cReset.textContent = entry.resetText || "-";
          row.appendChild(cReset);

          /* 状态码 */
          const cSc = document.createElement("div");
          cSc.style.width = "70px";
          cSc.style.flexShrink = "0";
          cSc.style.padding = "0 4px";
          const scVal = entry.statusCode;
          const scText = scVal === null || scVal === undefined ? "--" : String(scVal);
          const scBadge = document.createElement("span");
          scBadge.textContent = scText;
          scBadge.style.fontSize = "11px";
          scBadge.style.fontWeight = "700";
          scBadge.style.padding = "2px 6px";
          scBadge.style.borderRadius = "999px";
          if (scText === "--") {
            scBadge.style.background = "#1f2937";
            scBadge.style.color = "#cbd5e1";
          } else if (Number(scVal) === 200) {
            scBadge.style.background = "#064e3b";
            scBadge.style.color = "#a7f3d0";
          } else {
            scBadge.style.background = "#7f1d1d";
            scBadge.style.color = "#fecaca";
          }
          cSc.appendChild(scBadge);
          row.appendChild(cSc);

          /* 查询时间 */
          const cTime = document.createElement("div");
          cTime.style.width = "160px";
          cTime.style.flexShrink = "0";
          cTime.style.padding = "0 4px";
          cTime.style.fontSize = "11px";
          cTime.textContent = entry.queriedAt ? new Date(entry.queriedAt).toLocaleString() : "-";
          row.appendChild(cTime);

          /* 操作：详情 + 启用/禁用 */
          const cAct = document.createElement("div");
          cAct.style.width = "120px";
          cAct.style.flexShrink = "0";
          cAct.style.padding = "0 4px";
          cAct.style.display = "flex";
          cAct.style.gap = "4px";
          const detailBtn = document.createElement("button");
          detailBtn.textContent = "详情";
          detailBtn.style.border = "0";
          detailBtn.style.borderRadius = "6px";
          detailBtn.style.padding = "4px 8px";
          detailBtn.style.cursor = "pointer";
          detailBtn.style.background = "#2563eb";
          detailBtn.style.color = "#fff";
          detailBtn.style.fontSize = "11px";
          detailBtn.addEventListener("click", () => {
            const modal = ensureBalanceModal();
            modal.show({
              title: `余额查询结果 - ${entry.name || entry.key}`,
              statusCode: entry.statusCode ?? null,
              bodyObj: entry.bodyObj && typeof entry.bodyObj === "object" ? entry.bodyObj : null,
              bodyText: entry.bodyText || "",
              bodyParsed: Boolean(entry.bodyParsed),
            });
          });
          cAct.appendChild(detailBtn);

          const entryStatusLower = String(entry.fileStatus || "").toLowerCase();
          const isDisabled = entryStatusLower === "disabled";
          const toggleBtn = document.createElement("button");
          toggleBtn.textContent = isDisabled ? "启用" : "禁用";
          toggleBtn.style.border = "0";
          toggleBtn.style.borderRadius = "6px";
          toggleBtn.style.padding = "4px 8px";
          toggleBtn.style.cursor = "pointer";
          toggleBtn.style.background = isDisabled ? "#2563eb" : "#b91c1c";
          toggleBtn.style.color = "#fff";
          toggleBtn.style.fontSize = "11px";
          toggleBtn.addEventListener("click", async () => {
            const fileName = entry.name || "";
            if (!fileName) {
              alert("无法获取文件名，无法操作");
              return;
            }
            const token = getCachedToken().trim();
            if (!token) {
              alert("请先设置 token");
              return;
            }
            const setDisabled = !isDisabled;
            const busyLabel = setDisabled ? "禁用中" : "启用中";
            const doneLabel = setDisabled ? "已禁用" : "已启用";
            const failAction = setDisabled ? "禁用" : "启用";
            toggleBtn.disabled = true;
            toggleBtn.textContent = busyLabel;
            try {
              const res = await patchFileStatus(token, fileName, setDisabled);
              if (res.ok) {
                toggleBtn.textContent = doneLabel;
                toggleBtn.style.background = "#374151";
                toggleBtn.style.cursor = "default";
                const newStatus = setDisabled ? "disabled" : "active";
                entry.fileStatus = newStatus;
                if (entry.key && usageQueryCache[entry.key]) {
                  usageQueryCache[entry.key].fileStatus = newStatus;
                  saveUsageQueryCache();
                }
                if (setDisabled) row.style.opacity = "0.5";
              } else {
                toggleBtn.textContent = "失败";
                toggleBtn.disabled = false;
                alert(`${failAction}失败: ${res.message || res.status}`);
              }
            } catch (err) {
              toggleBtn.textContent = "失败";
              toggleBtn.disabled = false;
              alert(`${failAction}异常: ${err?.message || err}`);
            }
          });
          cAct.appendChild(toggleBtn);

          row.appendChild(cAct);

          fTableBody.appendChild(row);
        });

        /* update pager */
        fPageInfo.textContent = `第 ${fPage + 1} / ${totalPages} 页`;
        fPrevBtn.disabled = fPage <= 0;
        fPrevBtn.style.opacity = fPage <= 0 ? "0.5" : "1";
        fNextBtn.disabled = fPage >= totalPages - 1;
        fNextBtn.style.opacity = fPage >= totalPages - 1 ? "0.5" : "1";
      }

      fPrevBtn.addEventListener("click", () => {
        if (fPage > 0) { fPage -= 1; renderPage(); }
      });
      fNextBtn.addEventListener("click", () => {
        const totalPages = Math.max(1, Math.ceil(fData.length / PAGE_SIZE));
        if (fPage < totalPages - 1) { fPage += 1; renderPage(); }
      });

      filterModal = {
        overlay: fOverlay,
        show(data, threshold) {
          fData = data || [];
          fPage = 0;
          const totalCached = Object.keys(usageQueryCache).length;
          fTitle.textContent = `额度筛选结果 (>=${threshold}%)`;
          fStats.textContent = `匹配 ${fData.length} 条 / 总缓存 ${totalCached} 条`;
          renderPage();
          fOverlay.style.display = "block";
        },
      };
      return filterModal;
    }

    function ensureBalanceModal() {
      if (balanceModal) return balanceModal;

      const overlay = document.createElement("div");
      overlay.style.position = "fixed";
      overlay.style.inset = "0";
      overlay.style.background = "rgba(0, 0, 0, 0.45)";
      overlay.style.zIndex = "100003";
      overlay.style.display = "none";

      const panel = document.createElement("div");
      panel.style.position = "absolute";
      panel.style.left = "50%";
      panel.style.top = "50%";
      panel.style.transform = "translate(-50%, -50%)";
      panel.style.width = "min(1100px, 90vw)";
      panel.style.height = "min(82vh, 920px)";
      panel.style.background =
        "linear-gradient(180deg, #0b1220 0%, #111827 100%)";
      panel.style.color = "#f8fafc";
      panel.style.border = "1px solid #334155";
      panel.style.borderRadius = "16px";
      panel.style.boxShadow = "0 20px 50px rgba(0, 0, 0, 0.5)";
      panel.style.display = "flex";
      panel.style.flexDirection = "column";
      panel.style.padding = "16px";

      const header = document.createElement("div");
      header.style.display = "flex";
      header.style.alignItems = "center";
      header.style.justifyContent = "space-between";
      header.style.marginBottom = "8px";

      const title = document.createElement("div");
      title.textContent = "余额查询结果";
      title.style.fontSize = "16px";
      title.style.fontWeight = "700";
      header.appendChild(title);

      const statusBadge = document.createElement("div");
      statusBadge.textContent = "状态码: -";
      statusBadge.style.fontSize = "12px";
      statusBadge.style.fontWeight = "700";
      statusBadge.style.padding = "4px 8px";
      statusBadge.style.borderRadius = "999px";
      statusBadge.style.background = "#1f2937";
      statusBadge.style.color = "#cbd5e1";

      const rightBox = document.createElement("div");
      rightBox.style.display = "flex";
      rightBox.style.alignItems = "center";
      rightBox.style.gap = "8px";
      rightBox.appendChild(statusBadge);

      const closeBtn = document.createElement("button");
      closeBtn.textContent = "关闭";
      closeBtn.style.border = "0";
      closeBtn.style.borderRadius = "8px";
      closeBtn.style.padding = "6px 10px";
      closeBtn.style.cursor = "pointer";
      closeBtn.style.background = "#334155";
      closeBtn.style.color = "#fff";
      rightBox.appendChild(closeBtn);
      header.appendChild(rightBox);

      const contentRoot = document.createElement("div");
      contentRoot.style.flex = "1";
      contentRoot.style.width = "100%";
      contentRoot.style.overflow = "auto";
      contentRoot.style.boxSizing = "border-box";
      contentRoot.style.border = "1px solid #334155";
      contentRoot.style.borderRadius = "12px";
      contentRoot.style.padding = "12px";
      contentRoot.style.background = "#020617";
      contentRoot.style.color = "#f8fafc";
      contentRoot.style.fontFamily =
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

      function textOrDash(value) {
        if (value === undefined || value === null || value === "") return "-";
        if (typeof value === "object") return JSON.stringify(value);
        return String(value);
      }

      function formatUnix(value) {
        if (value === undefined || value === null || value === "") return "-";
        const n = Number(value);
        if (!Number.isFinite(n)) return String(value);
        try {
          return `${n} (${new Date(n * 1000).toLocaleString()})`;
        } catch (_) {
          return String(value);
        }
      }

      function formatSeconds(value) {
        if (value === undefined || value === null || value === "") return "-";
        const n = Number(value);
        if (!Number.isFinite(n)) return String(value);
        const d = Math.floor(n / 86400);
        const h = Math.floor((n % 86400) / 3600);
        const m = Math.floor((n % 3600) / 60);
        return `${n}s (${d}d ${h}h ${m}m)`;
      }

      function createSection(titleText, fields) {
        const card = document.createElement("div");
        card.style.background = "#0b1220";
        card.style.border = "1px solid #233044";
        card.style.borderRadius = "10px";
        card.style.padding = "10px";
        card.style.marginBottom = "10px";

        const h = document.createElement("div");
        h.textContent = titleText;
        h.style.fontSize = "13px";
        h.style.fontWeight = "700";
        h.style.marginBottom = "8px";
        h.style.color = "#cbd5e1";
        card.appendChild(h);

        const grid = document.createElement("div");
        grid.style.display = "grid";
        grid.style.gridTemplateColumns = "180px 1fr";
        grid.style.gap = "6px 10px";

        fields.forEach(([k, v]) => {
          const keyEl = document.createElement("div");
          keyEl.textContent = k;
          keyEl.style.color = "#94a3b8";
          keyEl.style.fontSize = "12px";

          const valEl = document.createElement("div");
          valEl.textContent = textOrDash(v);
          valEl.style.color = "#f8fafc";
          valEl.style.fontSize = "12px";
          valEl.style.wordBreak = "break-word";

          grid.appendChild(keyEl);
          grid.appendChild(valEl);
        });

        card.appendChild(grid);
        return card;
      }

      function createRawBlock(titleText, textValue) {
        const card = document.createElement("div");
        card.style.background = "#0b1220";
        card.style.border = "1px solid #233044";
        card.style.borderRadius = "10px";
        card.style.padding = "10px";
        card.style.marginBottom = "10px";

        const h = document.createElement("div");
        h.textContent = titleText;
        h.style.fontSize = "13px";
        h.style.fontWeight = "700";
        h.style.marginBottom = "8px";
        h.style.color = "#cbd5e1";
        card.appendChild(h);

        const pre = document.createElement("pre");
        pre.textContent = textValue || "";
        pre.style.margin = "0";
        pre.style.whiteSpace = "pre-wrap";
        pre.style.wordBreak = "break-word";
        pre.style.color = "#e2e8f0";
        pre.style.fontSize = "12px";
        pre.style.lineHeight = "1.45";
        card.appendChild(pre);

        return card;
      }

      function renderBodyPage(info) {
        contentRoot.innerHTML = "";
        const body = info?.bodyObj && typeof info.bodyObj === "object" ? info.bodyObj : null;

        if (!body) {
          const empty = document.createElement("div");
          empty.textContent = "响应体为空或不是有效 JSON，展示原始响应体内容：";
          empty.style.fontSize = "13px";
          empty.style.marginBottom = "8px";
          empty.style.color = "#fbbf24";
          contentRoot.appendChild(empty);
          contentRoot.appendChild(createRawBlock("Body 原文", info?.bodyText || ""));
          return;
        }

        const wrapper = document.createElement("div");
        wrapper.style.display = "grid";
        wrapper.style.gridTemplateColumns = "repeat(auto-fit, minmax(420px, 1fr))";
        wrapper.style.gap = "10px";

        const rate = body?.rate_limit || {};
        const ratePrimary = rate?.primary_window || {};
        const codeRate = body?.code_review_rate_limit || {};
        const codePrimary = codeRate?.primary_window || {};
        const promo = body?.promo || {};

        wrapper.appendChild(
          createSection("基础信息", [
            ["用户ID", body.user_id],
            ["账户ID", body.account_id],
            ["邮箱", body.email],
            ["套餐类型", body.plan_type],
          ])
        );

        wrapper.appendChild(
          createSection("主限流", [
            ["是否允许", rate.allowed],
            ["是否触顶", rate.limit_reached],
            ["已用百分比", ratePrimary.used_percent === undefined ? "-" : `${ratePrimary.used_percent}%`],
            ["窗口总时长", formatSeconds(ratePrimary.limit_window_seconds)],
            ["重置剩余时间", formatSeconds(ratePrimary.reset_after_seconds)],
            ["重置时间", formatUnix(ratePrimary.reset_at)],
            ["次级窗口", rate.secondary_window],
          ])
        );

        wrapper.appendChild(
          createSection("代码评审限流", [
            ["是否允许", codeRate.allowed],
            ["是否触顶", codeRate.limit_reached],
            ["已用百分比", codePrimary.used_percent === undefined ? "-" : `${codePrimary.used_percent}%`],
            ["窗口总时长", formatSeconds(codePrimary.limit_window_seconds)],
            ["重置剩余时间", formatSeconds(codePrimary.reset_after_seconds)],
            ["重置时间", formatUnix(codePrimary.reset_at)],
            ["次级窗口", codeRate.secondary_window],
          ])
        );

        wrapper.appendChild(
          createSection("附加信息", [
            ["附加限流", body.additional_rate_limits],
            ["积分", body.credits],
            ["活动ID", promo.campaign_id],
            ["活动文案", promo.message],
          ])
        );

        contentRoot.appendChild(wrapper);
        contentRoot.appendChild(
          createRawBlock("响应体原始 JSON（键名保持原始）", JSON.stringify(body, null, 2))
        );
      }

      closeBtn.addEventListener("click", () => {
        overlay.style.display = "none";
      });
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.style.display = "none";
      });

      panel.appendChild(header);
      panel.appendChild(contentRoot);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      balanceModal = {
        overlay,
        title,
        statusBadge,
        contentRoot,
        show(payload) {
          const info = payload || {};
          title.textContent = info.title || "余额查询结果";
          const sc = info.statusCode;
          statusBadge.textContent = `状态码: ${sc === null || sc === undefined ? "-" : sc}`;
          if (sc === null || sc === undefined || sc === "") {
            statusBadge.style.background = "#1f2937";
            statusBadge.style.color = "#cbd5e1";
          } else {
            const ok = Number(sc) === 200;
            statusBadge.style.background = ok ? "#064e3b" : "#7f1d1d";
            statusBadge.style.color = ok ? "#a7f3d0" : "#fecaca";
          }
          renderBodyPage(info);
          overlay.style.display = "block";
        },
      };
      return balanceModal;
    }

    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = "展开";
    toggleBtn.style.position = "absolute";
    toggleBtn.style.left = `-${TOGGLE_WIDTH}px`;
    toggleBtn.style.top = "50%";
    toggleBtn.style.transform = "translateY(-50%)";
    toggleBtn.style.zIndex = "1";
    toggleBtn.style.width = `${TOGGLE_WIDTH}px`;
    toggleBtn.style.height = "96px";
    toggleBtn.style.padding = "0";
    toggleBtn.style.border = "0";
    toggleBtn.style.borderRadius = "10px 0 0 10px";
    toggleBtn.style.cursor = "pointer";
    toggleBtn.style.background = "#2563eb";
    toggleBtn.style.color = "#fff";
    toggleBtn.style.fontSize = "13px";
    toggleBtn.style.fontWeight = "700";
    toggleBtn.style.writingMode = "vertical-rl";
    toggleBtn.style.letterSpacing = "2px";
    bar.appendChild(toggleBtn);

    const innerWrap = document.createElement("div");
    innerWrap.style.flex = "1";
    innerWrap.style.minHeight = "0";
    innerWrap.style.overflowY = "auto";
    innerWrap.style.overflowX = "hidden";
    innerWrap.style.display = "flex";
    innerWrap.style.flexDirection = "column";
    bar.appendChild(innerWrap);

    const title = document.createElement("div");
    title.textContent = "AuthFiles 清理";
    title.style.fontSize = "14px";
    title.style.fontWeight = "700";
    title.style.marginBottom = "8px";
    innerWrap.appendChild(title);

    const authHint = document.createElement("div");
    authHint.style.fontSize = "11px";
    authHint.style.color = "#93c5fd";
    authHint.style.marginBottom = "6px";
    authHint.textContent = "认证：仅使用手动 token；列表仅处理 type=codex";
    innerWrap.appendChild(authHint);

    const tokenRow = document.createElement("div");
    tokenRow.style.display = "flex";
    tokenRow.style.gap = "6px";
    tokenRow.style.marginBottom = "8px";

    const manualTokenInput = document.createElement("input");
    manualTokenInput.type = "password";
    manualTokenInput.placeholder = "手动 token（可选）";
    manualTokenInput.value = getManualToken();
    manualTokenInput.style.flex = "1";
    manualTokenInput.style.minWidth = "0";
    manualTokenInput.style.padding = "6px 8px";
    manualTokenInput.style.border = "1px solid #334155";
    manualTokenInput.style.borderRadius = "6px";
    manualTokenInput.style.background = "#0f172a";
    manualTokenInput.style.color = "#f8fafc";
    tokenRow.appendChild(manualTokenInput);

    const btnSaveToken = document.createElement("button");
    btnSaveToken.textContent = "保存";
    btnSaveToken.style.border = "0";
    btnSaveToken.style.borderRadius = "6px";
    btnSaveToken.style.padding = "6px 8px";
    btnSaveToken.style.cursor = "pointer";
    btnSaveToken.style.background = "#2563eb";
    btnSaveToken.style.color = "#fff";
    tokenRow.appendChild(btnSaveToken);

    const btnClearToken = document.createElement("button");
    btnClearToken.textContent = "清除";
    btnClearToken.style.border = "0";
    btnClearToken.style.borderRadius = "6px";
    btnClearToken.style.padding = "6px 8px";
    btnClearToken.style.cursor = "pointer";
    btnClearToken.style.background = "#6b7280";
    btnClearToken.style.color = "#fff";
    tokenRow.appendChild(btnClearToken);

    innerWrap.appendChild(tokenRow);

    const btnFetch = document.createElement("button");
    btnFetch.textContent = "失效文件";
    btnFetch.style.width = "100%";
    btnFetch.style.padding = "8px";
    btnFetch.style.marginBottom = "8px";
    btnFetch.style.border = "0";
    btnFetch.style.borderRadius = "8px";
    btnFetch.style.cursor = "pointer";
    btnFetch.style.background = "#2563eb";
    btnFetch.style.color = "#fff";
    innerWrap.appendChild(btnFetch);

    /* ---- Row: 查询余额 + 批量查询 ---- */
    const queryRow = document.createElement("div");
    queryRow.style.display = "flex";
    queryRow.style.gap = "6px";
    queryRow.style.marginBottom = "8px";

    const btnBatchQuery = document.createElement("button");
    btnBatchQuery.textContent = "查询余额";
    btnBatchQuery.style.flex = "1";
    btnBatchQuery.style.padding = "8px";
    btnBatchQuery.style.border = "0";
    btnBatchQuery.style.borderRadius = "8px";
    btnBatchQuery.style.cursor = "pointer";
    btnBatchQuery.style.background = "#059669";
    btnBatchQuery.style.color = "#fff";
    queryRow.appendChild(btnBatchQuery);

    const btnBatchQueryAll = document.createElement("button");
    btnBatchQueryAll.textContent = "批量查询";
    btnBatchQueryAll.style.flex = "1";
    btnBatchQueryAll.style.padding = "8px";
    btnBatchQueryAll.style.border = "0";
    btnBatchQueryAll.style.borderRadius = "8px";
    btnBatchQueryAll.style.cursor = "pointer";
    btnBatchQueryAll.style.background = "#0ea5e9";
    btnBatchQueryAll.style.color = "#fff";
    queryRow.appendChild(btnBatchQueryAll);

    innerWrap.appendChild(queryRow);

    /* ---- Row: 一键删除 + 一键启用 ---- */
    const actionRow = document.createElement("div");
    actionRow.style.display = "flex";
    actionRow.style.gap = "6px";
    actionRow.style.marginBottom = "8px";

    const btnBatchDelete = document.createElement("button");
    btnBatchDelete.textContent = "一键删除";
    btnBatchDelete.style.flex = "1";
    btnBatchDelete.style.padding = "8px";
    btnBatchDelete.style.border = "0";
    btnBatchDelete.style.borderRadius = "8px";
    btnBatchDelete.style.cursor = "pointer";
    btnBatchDelete.style.background = "#b91c1c";
    btnBatchDelete.style.color = "#fff";
    actionRow.appendChild(btnBatchDelete);

    const btnBatchEnable = document.createElement("button");
    btnBatchEnable.textContent = "一键启用";
    btnBatchEnable.style.flex = "1";
    btnBatchEnable.style.padding = "8px";
    btnBatchEnable.style.border = "0";
    btnBatchEnable.style.borderRadius = "8px";
    btnBatchEnable.style.cursor = "pointer";
    btnBatchEnable.style.background = "#2563eb";
    btnBatchEnable.style.color = "#fff";
    actionRow.appendChild(btnBatchEnable);

    innerWrap.appendChild(actionRow);

    /* ---- Row: 清空记录 + 停止查询 ---- */
    const utilRow = document.createElement("div");
    utilRow.style.display = "flex";
    utilRow.style.gap = "6px";
    utilRow.style.marginBottom = "8px";

    const btnClearHistory = document.createElement("button");
    btnClearHistory.textContent = "清空记录";
    btnClearHistory.style.flex = "1";
    btnClearHistory.style.padding = "8px";
    btnClearHistory.style.border = "0";
    btnClearHistory.style.borderRadius = "8px";
    btnClearHistory.style.cursor = "pointer";
    btnClearHistory.style.background = "#f59e0b";
    btnClearHistory.style.color = "#111827";
    btnClearHistory.style.fontWeight = "700";
    utilRow.appendChild(btnClearHistory);

    const btnStopQueryAll = document.createElement("button");
    btnStopQueryAll.textContent = "停止查询";
    btnStopQueryAll.style.flex = "1";
    btnStopQueryAll.style.padding = "8px";
    btnStopQueryAll.style.border = "0";
    btnStopQueryAll.style.borderRadius = "8px";
    btnStopQueryAll.style.cursor = "pointer";
    btnStopQueryAll.style.background = "#6b7280";
    btnStopQueryAll.style.color = "#fff";
    btnStopQueryAll.disabled = true;
    btnStopQueryAll.style.opacity = "0.6";
    utilRow.appendChild(btnStopQueryAll);

    innerWrap.appendChild(utilRow);

    /* ---- Row: 筛选下拉 + 筛选按钮 ---- */
    const filterRow = document.createElement("div");
    filterRow.style.display = "flex";
    filterRow.style.gap = "6px";
    filterRow.style.marginBottom = "8px";

    const filterSelect = document.createElement("select");
    filterSelect.style.flex = "1";
    filterSelect.style.minWidth = "0";
    filterSelect.style.padding = "6px 8px";
    filterSelect.style.border = "1px solid #334155";
    filterSelect.style.borderRadius = "6px";
    filterSelect.style.background = "#0f172a";
    filterSelect.style.color = "#f8fafc";
    filterSelect.style.fontSize = "12px";
    [70, 50, 30, 10].forEach((v) => {
      const opt = document.createElement("option");
      opt.value = String(v);
      opt.textContent = `>= ${v}%`;
      filterSelect.appendChild(opt);
    });
    filterRow.appendChild(filterSelect);

    const btnFilterByUsage = document.createElement("button");
    btnFilterByUsage.textContent = "筛选高额度";
    btnFilterByUsage.style.border = "0";
    btnFilterByUsage.style.borderRadius = "6px";
    btnFilterByUsage.style.padding = "6px 12px";
    btnFilterByUsage.style.cursor = "pointer";
    btnFilterByUsage.style.background = "#7c3aed";
    btnFilterByUsage.style.color = "#fff";
    btnFilterByUsage.style.fontSize = "12px";
    btnFilterByUsage.style.fontWeight = "700";
    btnFilterByUsage.style.whiteSpace = "nowrap";
    filterRow.appendChild(btnFilterByUsage);

    innerWrap.appendChild(filterRow);

    const status = document.createElement("div");
    status.style.fontSize = "12px";
    status.style.marginBottom = "6px";
    status.textContent = "状态：待操作";
    innerWrap.appendChild(status);

    const querySummary = document.createElement("div");
    querySummary.style.fontSize = "11px";
    querySummary.style.color = "#93c5fd";
    querySummary.style.marginBottom = "8px";
    querySummary.textContent = "统计：成功 0，失败 0";
    innerWrap.appendChild(querySummary);

    const listNote = document.createElement("div");
    listNote.style.fontSize = "11px";
    listNote.style.color = "#fbbf24";
    listNote.style.marginBottom = "8px";
    listNote.textContent = "备注：全量查询时，列表仅显示失败项。";
    innerWrap.appendChild(listNote);

    function showBalanceResult(payload) {
      if (!payload) return;
      const modal = ensureBalanceModal();
      modal.show(payload);
    }

    function setQueryAllControlState(running) {
      queryAllRunning = running;
      btnFetch.disabled = running;
      btnBatchQuery.disabled = running;
      btnBatchQueryAll.disabled = running;
      btnBatchDelete.disabled = running;
      btnBatchEnable.disabled = running;
      btnClearHistory.disabled = running;
      btnSaveToken.disabled = running;
      btnClearToken.disabled = running;
      manualTokenInput.disabled = running;
      btnStopQueryAll.disabled = !running;
      btnStopQueryAll.style.opacity = running ? "1" : "0.6";
      if (running) {
        btnStopQueryAll.style.background = "#dc2626";
      } else {
        btnStopQueryAll.style.background = "#6b7280";
      }
    }

    function updateQuerySummary(success, failed, extraText) {
      const suffix = extraText ? ` | ${extraText}` : "";
      querySummary.textContent = `统计：成功 ${success}，失败 ${failed}${suffix}`;
    }

    const listContainer = document.createElement("div");
    listContainer.style.flex = "1";
    listContainer.style.minHeight = "120px";
    listContainer.style.overflow = "auto";
    listContainer.style.boxSizing = "border-box";
    listContainer.style.border = "1px solid #4b5563";
    listContainer.style.borderRadius = "8px";
    listContainer.style.padding = "8px";
    listContainer.style.background = "#0b1220";
    innerWrap.appendChild(listContainer);

    function formatResetTime(primaryWindow) {
      if (!primaryWindow || typeof primaryWindow !== "object") return "-";
      const resetAt = primaryWindow.reset_at;
      if (resetAt !== undefined && resetAt !== null && resetAt !== "") {
        const ts = Number(resetAt);
        if (Number.isFinite(ts)) {
          return new Date(ts * 1000).toLocaleString();
        }
      }
      const after = primaryWindow.reset_after_seconds;
      if (after !== undefined && after !== null && after !== "") {
        const sec = Number(after);
        if (Number.isFinite(sec)) {
          const d = Math.floor(sec / 86400);
          const h = Math.floor((sec % 86400) / 3600);
          const m = Math.floor((sec % 3600) / 60);
          return `${sec}s (${d}天 ${h}小时 ${m}分后)`;
        }
        return String(after);
      }
      return "-";
    }

    function parseUsageSnapshot(bodyObj) {
      if (!bodyObj || typeof bodyObj !== "object") {
        return { usedPercent: null, resetText: "-" };
      }
      const primary = bodyObj?.rate_limit?.primary_window;
      const usedRaw = primary?.used_percent;
      const usedNum = Number(usedRaw);
      const usedPercent = Number.isFinite(usedNum)
        ? Math.max(0, Math.min(100, usedNum))
        : null;
      return {
        usedPercent,
        resetText: formatResetTime(primary),
      };
    }

    function renderPendingList() {
      listContainer.innerHTML = "";
      if (!pendingFiles.length) {
        const empty = document.createElement("div");
        empty.textContent = "暂无匹配文件，请先点击上方获取按钮";
        empty.style.fontSize = "12px";
        empty.style.color = "#94a3b8";
        listContainer.appendChild(empty);
        return;
      }

      pendingFiles.forEach((item, idx) => {
        const card = document.createElement("div");
        card.style.border = "1px solid #334155";
        card.style.borderRadius = "8px";
        card.style.padding = "8px";
        card.style.marginBottom = "8px";
        card.style.background = "#111827";

        const nameLine = document.createElement("div");
        nameLine.textContent = `${idx + 1}. ${item.name}`;
        nameLine.style.fontSize = "12px";
        nameLine.style.fontWeight = "700";
        nameLine.style.wordBreak = "break-all";
        nameLine.style.marginBottom = "6px";
        card.appendChild(nameLine);

        const metaLine = document.createElement("div");
        metaLine.textContent = `authIndex=${item.authIndex || "-"} | status=${item.status || "-"}`;
        metaLine.style.fontSize = "11px";
        metaLine.style.color = "#94a3b8";
        metaLine.style.wordBreak = "break-all";
        metaLine.style.marginBottom = "8px";
        card.appendChild(metaLine);

        const usageWrap = document.createElement("div");
        usageWrap.style.marginBottom = "8px";

        const statusCodeRow = document.createElement("div");
        statusCodeRow.style.display = "flex";
        statusCodeRow.style.alignItems = "center";
        statusCodeRow.style.gap = "6px";
        statusCodeRow.style.marginBottom = "6px";

        const statusCodeLabel = document.createElement("span");
        statusCodeLabel.textContent = "状态码:";
        statusCodeLabel.style.fontSize = "11px";
        statusCodeLabel.style.color = "#94a3b8";
        statusCodeRow.appendChild(statusCodeLabel);

        const statusCodeBadge = document.createElement("span");
        const sc = item.lastStatusCode;
        const scText = sc === null || sc === undefined || sc === "" ? "--" : String(sc);
        const is200 = Number(sc) === 200;
        statusCodeBadge.textContent = scText;
        statusCodeBadge.style.fontSize = "11px";
        statusCodeBadge.style.fontWeight = "700";
        statusCodeBadge.style.padding = "2px 8px";
        statusCodeBadge.style.borderRadius = "999px";
        if (scText === "--") {
          statusCodeBadge.style.background = "#1f2937";
          statusCodeBadge.style.color = "#cbd5e1";
        } else if (is200) {
          statusCodeBadge.style.background = "#064e3b";
          statusCodeBadge.style.color = "#a7f3d0";
        } else {
          statusCodeBadge.style.background = "#7f1d1d";
          statusCodeBadge.style.color = "#fecaca";
        }
        statusCodeRow.appendChild(statusCodeBadge);
        usageWrap.appendChild(statusCodeRow);

        const usageText = document.createElement("div");
        usageText.style.fontSize = "11px";
        usageText.style.color = "#cbd5e1";
        usageText.style.marginBottom = "5px";
        const usedLabel =
          item.usedPercent === null || item.usedPercent === undefined
            ? "未查询"
            : `${item.usedPercent}%`;
        const resetLabel = item.resetText || "-";
        usageText.textContent = `已用百分比: ${usedLabel} | 重置时间: ${resetLabel}`;
        usageWrap.appendChild(usageText);

        const progressBg = document.createElement("div");
        progressBg.style.height = "8px";
        progressBg.style.width = "100%";
        progressBg.style.borderRadius = "999px";
        progressBg.style.background = "#1f2937";
        progressBg.style.overflow = "hidden";

        const progressFill = document.createElement("div");
        const pct =
          item.usedPercent === null || item.usedPercent === undefined
            ? 0
            : Math.max(0, Math.min(100, Number(item.usedPercent)));
        progressFill.style.height = "100%";
        progressFill.style.width = `${pct}%`;
        progressFill.style.transition = "width 0.2s ease";
        progressFill.style.background =
          pct >= 100 ? "#ef4444" : pct >= 80 ? "#f59e0b" : "#10b981";
        progressBg.appendChild(progressFill);

        usageWrap.appendChild(progressBg);
        card.appendChild(usageWrap);

        const actions = document.createElement("div");
        actions.style.display = "flex";
        actions.style.gap = "4px";

        const statusLower = String(item.status || "").toLowerCase();
        const toggleToDisabled = statusLower !== "disabled";
        const toggleLabel = toggleToDisabled ? "禁用" : "启用";
        const toggleBusyLabel = toggleToDisabled ? "禁用中" : "启用中";
        const toggleDoneLabel = toggleToDisabled ? "已禁用" : "已启用";

        const rowBalanceBtn = document.createElement("button");
        rowBalanceBtn.textContent = "余额";
        rowBalanceBtn.style.flex = "1";
        rowBalanceBtn.style.border = "0";
        rowBalanceBtn.style.borderRadius = "6px";
        rowBalanceBtn.style.padding = "6px 4px";
        rowBalanceBtn.style.minWidth = "0";
        rowBalanceBtn.style.fontSize = "11px";
        rowBalanceBtn.style.cursor = "pointer";
        rowBalanceBtn.style.background = "#059669";
        rowBalanceBtn.style.color = "#fff";

        const rowDeleteBtn = document.createElement("button");
        rowDeleteBtn.textContent = "删除";
        rowDeleteBtn.style.flex = "1";
        rowDeleteBtn.style.border = "0";
        rowDeleteBtn.style.borderRadius = "6px";
        rowDeleteBtn.style.padding = "6px 4px";
        rowDeleteBtn.style.minWidth = "0";
        rowDeleteBtn.style.fontSize = "11px";
        rowDeleteBtn.style.cursor = "pointer";
        rowDeleteBtn.style.background = "#dc2626";
        rowDeleteBtn.style.color = "#fff";

        const rowToggleBtn = document.createElement("button");
        rowToggleBtn.textContent = toggleLabel;
        rowToggleBtn.style.flex = "1";
        rowToggleBtn.style.border = "0";
        rowToggleBtn.style.borderRadius = "6px";
        rowToggleBtn.style.padding = "6px 4px";
        rowToggleBtn.style.minWidth = "0";
        rowToggleBtn.style.fontSize = "11px";
        rowToggleBtn.style.cursor = "pointer";
        rowToggleBtn.style.background = toggleToDisabled ? "#dc2626" : "#2563eb";
        rowToggleBtn.style.color = "#fff";

        const rowDetailBtn = document.createElement("button");
        rowDetailBtn.textContent = "详情";
        rowDetailBtn.style.flex = "1";
        rowDetailBtn.style.border = "0";
        rowDetailBtn.style.borderRadius = "6px";
        rowDetailBtn.style.padding = "6px 4px";
        rowDetailBtn.style.minWidth = "0";
        rowDetailBtn.style.fontSize = "11px";
        rowDetailBtn.style.cursor = "pointer";
        rowDetailBtn.style.background = "#334155";
        rowDetailBtn.style.color = "#fff";
        rowDetailBtn.disabled = !item.lastBalancePayload;
        rowDetailBtn.style.opacity = item.lastBalancePayload ? "1" : "0.6";

        rowBalanceBtn.addEventListener("click", async () => {
          const token = getCachedToken().trim();
          if (!item.authIndex) {
            status.textContent = `状态：${item.name} 缺少 authIndex`;
            return;
          }

          rowBalanceBtn.disabled = true;
          rowDeleteBtn.disabled = true;
          rowToggleBtn.disabled = true;
          rowDetailBtn.disabled = true;
          status.textContent = `状态：查询余额中 - ${item.name}`;
          try {
            const res = await queryUsageByAuthIndex(token, item);
            const snapshot = parseUsageSnapshot(res.bodyObj);
            item.usedPercent = snapshot.usedPercent;
            item.resetText = snapshot.resetText;
            item.lastStatusCode = res.statusCode;
            updateUsageCacheForItem(item, res, snapshot);
            item.lastBalancePayload = {
              title: `余额查询结果 - ${item.name}`,
              statusCode: res.statusCode,
              bodyObj: res.bodyObj,
              bodyText: res.bodyText,
              bodyParsed: res.bodyParsed,
            };
            showBalanceResult(item.lastBalancePayload);
            rowDetailBtn.disabled = false;
            rowDetailBtn.style.opacity = "1";
            renderPendingList();
            if (res.ok) {
              status.textContent = `状态：余额查询成功 - ${item.name}`;
            } else {
              const code = res.statusCode ?? res.http ?? "-";
              status.textContent = `状态：余额查询失败 - ${item.name} | 状态码 ${code}${authFailureHint(
                code
              )}`;
            }
          } catch (err) {
            status.textContent = `状态：余额查询失败 - ${err?.message || err}`;
          } finally {
            rowBalanceBtn.disabled = false;
            rowDeleteBtn.disabled = false;
            rowToggleBtn.disabled = false;
            rowDetailBtn.disabled = !item.lastBalancePayload;
            rowDetailBtn.style.opacity = item.lastBalancePayload ? "1" : "0.6";
          }
        });

        rowDetailBtn.addEventListener("click", () => {
          if (!item.lastBalancePayload) {
            status.textContent = `状态：${item.name} 暂无可查看详情，请先查询余额`;
            return;
          }
          showBalanceResult(item.lastBalancePayload);
          status.textContent = `状态：已打开 ${item.name} 的余额详情`;
        });

        rowDeleteBtn.addEventListener("click", async () => {
          const token = getCachedToken().trim();
          if (!item.name || item.name === "(no-name)") {
            status.textContent = "状态：该文件缺少 name，无法删除";
            return;
          }

          const ok = window.confirm(`确认删除文件：${item.name} ?`);
          if (!ok) return;

          rowBalanceBtn.disabled = true;
          rowDeleteBtn.disabled = true;
          rowToggleBtn.disabled = true;
          rowDetailBtn.disabled = true;
          status.textContent = `状态：删除中 - ${item.name}`;
          try {
            const res = await deleteByName(token, item.name);
            if (res.ok) {
              pendingFiles = pendingFiles.filter((x) => x !== item);
              renderPendingList();
              status.textContent = `状态：已删除 ${item.name}`;
            } else {
              status.textContent = `状态：删除失败 ${item.name} | HTTP ${res.status}${authFailureHint(
                res.status
              )}`;
              rowBalanceBtn.disabled = false;
              rowDeleteBtn.disabled = false;
              rowToggleBtn.disabled = false;
              rowDetailBtn.disabled = !item.lastBalancePayload;
              rowDetailBtn.style.opacity = item.lastBalancePayload ? "1" : "0.6";
            }
          } catch (err) {
            status.textContent = `状态：删除失败 ${item.name} | ${err?.message || err}`;
            rowBalanceBtn.disabled = false;
            rowDeleteBtn.disabled = false;
            rowToggleBtn.disabled = false;
            rowDetailBtn.disabled = !item.lastBalancePayload;
            rowDetailBtn.style.opacity = item.lastBalancePayload ? "1" : "0.6";
          }
        });

        rowToggleBtn.addEventListener("click", async () => {
          const token = getCachedToken().trim();
          if (!item.name || item.name === "(no-name)") {
            status.textContent = "状态：该文件缺少 name，无法切换状态";
            return;
          }

          const ok = window.confirm(`确认${toggleLabel}文件：${item.name} ?`);
          if (!ok) return;

          rowBalanceBtn.disabled = true;
          rowDeleteBtn.disabled = true;
          rowToggleBtn.disabled = true;
          rowDetailBtn.disabled = true;
          status.textContent = `状态：${toggleBusyLabel} - ${item.name}`;
          try {
            const res = await patchFileStatus(token, item.name, toggleToDisabled);
            if (res.ok) {
              item.status = res.disabled === true ? "disabled" : "active";
              renderPendingList();
              status.textContent = `状态：${toggleDoneLabel} ${item.name}`;
            } else {
              status.textContent = `状态：切换失败 ${item.name} | HTTP ${res.status}${authFailureHint(res.status)}`;
              rowBalanceBtn.disabled = false;
              rowDeleteBtn.disabled = false;
              rowToggleBtn.disabled = false;
              rowDetailBtn.disabled = !item.lastBalancePayload;
              rowDetailBtn.style.opacity = item.lastBalancePayload ? "1" : "0.6";
            }
          } catch (err) {
            status.textContent = `状态：切换失败 ${item.name} | ${err?.message || err}`;
            rowBalanceBtn.disabled = false;
            rowDeleteBtn.disabled = false;
            rowToggleBtn.disabled = false;
            rowDetailBtn.disabled = !item.lastBalancePayload;
            rowDetailBtn.style.opacity = item.lastBalancePayload ? "1" : "0.6";
          }
        });

        actions.appendChild(rowBalanceBtn);
        actions.appendChild(rowDetailBtn);
        actions.appendChild(rowDeleteBtn);
        actions.appendChild(rowToggleBtn);
        card.appendChild(actions);
        listContainer.appendChild(card);
      });
    }

    function setOpen(open) {
      isOpen = open;
      bar.style.transform = isOpen ? "translate(0, -50%)" : `translate(${HIDDEN_X}px, -50%)`;
      toggleBtn.textContent = isOpen ? "收起" : "展开";
    }

    toggleBtn.addEventListener("click", () => {
      setOpen(!isOpen);
    });

    btnClearHistory.addEventListener("click", () => {
      const ok = window.confirm("确认清空本地历史查询记录吗？");
      if (!ok) return;
      usageQueryCache = {};
      try {
        localStorage.removeItem(QUERY_CACHE_KEY);
      } catch (_) {
        // ignore
      }
      pendingFiles.forEach((item) => {
        item.usedPercent = null;
        item.resetText = "-";
        item.lastStatusCode = null;
        item.lastBalancePayload = null;
      });
      renderPendingList();
      updateQuerySummary(0, 0, "已清空历史");
      status.textContent = "状态：历史记录已清空";
    });

    btnFilterByUsage.addEventListener("click", () => {
      const threshold = Number(filterSelect.value);
      const entries = Object.entries(usageQueryCache);
      const matched = [];
      entries.forEach(([key, cached]) => {
        if (
          cached &&
          cached.usedPercent !== null &&
          cached.usedPercent !== undefined &&
          Number.isFinite(Number(cached.usedPercent)) &&
          Number(cached.usedPercent) >= threshold
        ) {
          matched.push({
            key,
            name: cached.name || cached.bodyObj?.email || (key.startsWith("name:") ? key.slice(5) : key),
            fileStatus: cached.fileStatus || "",
            usedPercent: Number(cached.usedPercent),
            resetText: cached.resetText || "-",
            statusCode: cached.statusCode ?? null,
            queriedAt: cached.queriedAt || null,
            bodyObj: cached.bodyObj || null,
            bodyText: cached.bodyText || "",
            bodyParsed: Boolean(cached.bodyParsed),
          });
        }
      });
      matched.sort((a, b) => b.usedPercent - a.usedPercent);
      const modal = ensureFilterModal();
      modal.show(matched, threshold);
      status.textContent = `状态：筛选完成，>=${threshold}% 共 ${matched.length} 条`;
    });

    btnStopQueryAll.addEventListener("click", () => {
      if (!queryAllRunning) return;
      stopQueryAllRequested = true;
      status.textContent = "状态：已请求停止，等待当前批次完成...";
    });

    btnSaveToken.addEventListener("click", () => {
      const value = manualTokenInput.value.trim();
      setManualToken(value);
      status.textContent = value
        ? "状态：已保存手动 token（仅当前标签页会话）"
        : "状态：输入为空，已清除手动 token";
    });

    btnClearToken.addEventListener("click", () => {
      setManualToken("");
      manualTokenInput.value = "";
      status.textContent = "状态：已清除手动 token";
    });

    btnBatchQueryAll.addEventListener("click", async () => {
      const token = getCachedToken().trim();
      if (!token) {
        status.textContent = "状态：请先手动设置 token";
        return;
      }
      if (queryAllRunning) {
        status.textContent = "状态：批量全量查询正在执行中";
        return;
      }

      stopQueryAllRequested = false;
      setQueryAllControlState(true);
      updateQuerySummary(0, 0, "准备中");
      status.textContent = "状态：正在拉取全部文件...";

      try {
        const allFiles = await fetchAllFiles(token);
        const total = allFiles.length;
        let processed = 0;
        let success = 0;
        let failed = 0;
        let cacheHit = 0;
        const failedItems = [];

        pendingFiles = [];
        renderPendingList();

        for (let start = 0; start < allFiles.length; start += 6) {
          if (stopQueryAllRequested) break;

          const chunk = allFiles.slice(start, start + 6);
          status.textContent = `状态：全量查询中 ${processed}/${total}（每批6个）`;

          const results = await Promise.all(
            chunk.map(async (item) => {
              const cached = getCachedUsageForItem(item);
              if (cached) {
                applyCachedUsageToItem(item, cached);
                return { item, ok: Number(item.lastStatusCode) === 200, fromCache: true };
              }
              if (!item?.authIndex) {
                item.lastStatusCode = "NO_AUTH";
                item.usedPercent = null;
                item.resetText = "-";
                return { item, ok: false, fromCache: false };
              }
              try {
                const res = await queryUsageByAuthIndex(token, item);
                const snapshot = parseUsageSnapshot(res.bodyObj);
                item.usedPercent = snapshot.usedPercent;
                item.resetText = snapshot.resetText;
                item.lastStatusCode = res.statusCode;
                updateUsageCacheForItem(item, res, snapshot);
                item.lastBalancePayload = {
                  title: `余额查询结果 - ${item.name}`,
                  statusCode: res.statusCode,
                  bodyObj: res.bodyObj,
                  bodyText: res.bodyText,
                  bodyParsed: res.bodyParsed,
                };
                return { item, ok: Number(res.statusCode) === 200, fromCache: false };
              } catch (_) {
                item.lastStatusCode = "ERR";
                item.usedPercent = null;
                item.resetText = "-";
                return { item, ok: false, fromCache: false };
              }
            })
          );

          results.forEach((r) => {
            processed += 1;
            if (r.fromCache) cacheHit += 1;
            if (r.ok) {
              success += 1;
            } else {
              failed += 1;
              failedItems.push(r.item);
            }
          });

          pendingFiles = failedItems.slice();
          renderPendingList();
          updateQuerySummary(
            success,
            failed,
            `已处理 ${processed}/${total} | 缓存命中 ${cacheHit}${stopQueryAllRequested ? "（停止中）" : ""}`
          );
          status.textContent = `状态：全量查询中 ${processed}/${total}（成功 ${success}，失败 ${failed}）`;
        }

        pendingFiles = pendingFiles.filter(Boolean);
        renderPendingList();
        if (stopQueryAllRequested) {
          status.textContent = "状态：全量查询已停止（列表仅显示失败项）";
        } else {
          status.textContent = `状态：全量查询完成，成功 ${success}，失败 ${failed}（列表仅显示失败项）`;
        }
        updateQuerySummary(success, failed, `缓存命中 ${cacheHit}`);
      } catch (err) {
        status.textContent = `状态：全量查询失败 - ${err?.message || err}`;
      } finally {
        setQueryAllControlState(false);
        stopQueryAllRequested = false;
      }
    });

    btnBatchQuery.addEventListener("click", async () => {
      const token = getCachedToken().trim();
      if (!token) {
        status.textContent = "状态：请先手动设置 token";
        return;
      }
      if (!pendingFiles.length) {
        status.textContent = "状态：没有可查询文件，请先获取文件";
        return;
      }

      btnFetch.disabled = true;
      btnBatchQuery.disabled = true;
      btnBatchQueryAll.disabled = true;
      btnBatchDelete.disabled = true;
      btnBatchEnable.disabled = true;
      btnClearHistory.disabled = true;
      btnStopQueryAll.disabled = true;

      let okCount = 0;
      let failCount = 0;
      let cacheHit = 0;
      updateQuerySummary(okCount, failCount, `已处理 0/${pendingFiles.length}`);
      for (let i = 0; i < pendingFiles.length; i += 1) {
        const item = pendingFiles[i];
        if (!item?.authIndex) {
          failCount += 1;
          renderPendingList();
          updateQuerySummary(okCount, failCount, `已处理 ${i + 1}/${pendingFiles.length}`);
          status.textContent = `状态：批量查询余额中 ${i + 1}/${pendingFiles.length}（成功 ${okCount}，失败 ${failCount}）`;
          continue;
        }
        const cached = getCachedUsageForItem(item);
        if (cached) {
          applyCachedUsageToItem(item, cached);
          cacheHit += 1;
          if (Number(item.lastStatusCode) === 200) okCount += 1;
          else failCount += 1;
          renderPendingList();
          updateQuerySummary(
            okCount,
            failCount,
            `已处理 ${i + 1}/${pendingFiles.length} | 缓存命中 ${cacheHit}`
          );
          status.textContent = `状态：批量查询余额中 ${i + 1}/${pendingFiles.length}（成功 ${okCount}，失败 ${failCount}）`;
          continue;
        }
        status.textContent = `状态：批量查询余额中 ${i + 1}/${pendingFiles.length}（成功 ${okCount}，失败 ${failCount}）`;
        try {
          const res = await queryUsageByAuthIndex(token, item);
          const snapshot = parseUsageSnapshot(res.bodyObj);
          item.usedPercent = snapshot.usedPercent;
          item.resetText = snapshot.resetText;
          item.lastStatusCode = res.statusCode;
          updateUsageCacheForItem(item, res, snapshot);
          item.lastBalancePayload = {
            title: `余额查询结果 - ${item.name}`,
            statusCode: res.statusCode,
            bodyObj: res.bodyObj,
            bodyText: res.bodyText,
            bodyParsed: res.bodyParsed,
          };
          if (res.ok) okCount += 1;
          else failCount += 1;
        } catch (_) {
          failCount += 1;
        }
        renderPendingList();
        updateQuerySummary(
          okCount,
          failCount,
          `已处理 ${i + 1}/${pendingFiles.length} | 缓存命中 ${cacheHit}`
        );
      }

      status.textContent = `状态：批量查询完成，成功 ${okCount}，失败 ${failCount}`;
      btnFetch.disabled = false;
      btnBatchQuery.disabled = false;
      btnBatchQueryAll.disabled = false;
      btnBatchDelete.disabled = false;
      btnBatchEnable.disabled = false;
      btnClearHistory.disabled = false;
      btnStopQueryAll.disabled = true;
      btnStopQueryAll.style.opacity = "0.6";
    });

    btnBatchDelete.addEventListener("click", async () => {
      const token = getCachedToken().trim();
      if (!token) {
        status.textContent = "状态：请先手动设置 token";
        return;
      }
      if (!pendingFiles.length) {
        status.textContent = "状态：没有可删除文件，请先获取文件";
        return;
      }

      const ok = window.confirm(`确认一键删除 ${pendingFiles.length} 个文件？`);
      if (!ok) return;

      btnFetch.disabled = true;
      btnBatchQuery.disabled = true;
      btnBatchQueryAll.disabled = true;
      btnBatchDelete.disabled = true;
      btnBatchEnable.disabled = true;
      btnClearHistory.disabled = true;
      btnStopQueryAll.disabled = true;

      const failedItems = [];
      let success = 0;
      for (let i = 0; i < pendingFiles.length; i += 1) {
        const item = pendingFiles[i];
        const name = item?.name || "";
        if (!name || name === "(no-name)") {
          failedItems.push(item);
          continue;
        }
        status.textContent = `状态：批量删除中 ${i + 1}/${pendingFiles.length}`;
        try {
          const res = await deleteByName(token, name);
          if (res.ok) {
            success += 1;
          } else {
            failedItems.push(item);
          }
        } catch (_) {
          failedItems.push(item);
        }
      }

      pendingFiles = failedItems;
      renderPendingList();
      status.textContent = `状态：批量删除完成，成功 ${success}，失败 ${failedItems.length}`;
      updateQuerySummary(success, failedItems.length, "一键删除结果");
      btnFetch.disabled = false;
      btnBatchQuery.disabled = false;
      btnBatchQueryAll.disabled = false;
      btnBatchDelete.disabled = false;
      btnBatchEnable.disabled = false;
      btnClearHistory.disabled = false;
      btnStopQueryAll.disabled = true;
      btnStopQueryAll.style.opacity = "0.6";
    });

    btnBatchEnable.addEventListener("click", async () => {
      const token = getCachedToken().trim();
      if (!token) {
        status.textContent = "状态：请先手动设置 token";
        return;
      }
      if (!pendingFiles.length) {
        status.textContent = "状态：没有可启用文件，请先获取文件";
        return;
      }

      const ok = window.confirm(`确认一键启用 ${pendingFiles.length} 个文件？`);
      if (!ok) return;

      btnFetch.disabled = true;
      btnBatchQuery.disabled = true;
      btnBatchQueryAll.disabled = true;
      btnBatchDelete.disabled = true;
      btnBatchEnable.disabled = true;
      btnClearHistory.disabled = true;
      btnStopQueryAll.disabled = true;

      let success = 0;
      let failed = 0;
      let skipped = 0;
      updateQuerySummary(success, failed, `已处理 0/${pendingFiles.length}`);

      for (let i = 0; i < pendingFiles.length; i += 1) {
        const item = pendingFiles[i];
        const name = item?.name || "";
        if (!name || name === "(no-name)") {
          failed += 1;
          updateQuerySummary(success, failed, `已处理 ${i + 1}/${pendingFiles.length} | 跳过 ${skipped}`);
          status.textContent = `状态：批量启用中 ${i + 1}/${pendingFiles.length}（成功 ${success}，失败 ${failed}）`;
          continue;
        }

        if (String(item.status || "").toLowerCase() === "active") {
          skipped += 1;
          updateQuerySummary(success, failed, `已处理 ${i + 1}/${pendingFiles.length} | 跳过 ${skipped}`);
          status.textContent = `状态：批量启用中 ${i + 1}/${pendingFiles.length}（成功 ${success}，失败 ${failed}）`;
          continue;
        }

        status.textContent = `状态：批量启用中 ${i + 1}/${pendingFiles.length}（成功 ${success}，失败 ${failed}）`;
        try {
          const res = await patchFileStatus(token, name, false);
          if (res.ok) {
            item.status = res.disabled === true ? "disabled" : "active";
            success += 1;
          } else {
            failed += 1;
          }
        } catch (_) {
          failed += 1;
        }

        renderPendingList();
        updateQuerySummary(success, failed, `已处理 ${i + 1}/${pendingFiles.length} | 跳过 ${skipped}`);
      }

      renderPendingList();
      status.textContent = `状态：批量启用完成，成功 ${success}，失败 ${failed}${skipped ? `，跳过 ${skipped}` : ""}`;
      btnFetch.disabled = false;
      btnBatchQuery.disabled = false;
      btnBatchQueryAll.disabled = false;
      btnBatchDelete.disabled = false;
      btnBatchEnable.disabled = false;
      btnClearHistory.disabled = false;
      btnStopQueryAll.disabled = true;
      btnStopQueryAll.style.opacity = "0.6";
    });

    btnFetch.addEventListener("click", async () => {
      const token = getCachedToken().trim();
      if (!token) {
        status.textContent = "状态：请先手动设置 token";
        return;
      }

      status.textContent = "状态：获取中...";
      btnFetch.disabled = true;
      btnBatchEnable.disabled = true;
      try {
        pendingFiles = await fetchNonActive(token);
        renderPendingList();
        status.textContent = `状态：已获取 ${pendingFiles.length} 个失效文件`;
        updateQuerySummary(0, 0, "已重置");
      } catch (err) {
        status.textContent = `状态：获取失败 - ${err?.message || err}`;
      } finally {
        btnFetch.disabled = false;
        btnBatchEnable.disabled = false;
      }
    });

    renderPendingList();

    document.body.appendChild(bar);
  }

  function init() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", createSidebar, { once: true });
    } else {
      createSidebar();
    }
  }

  init();
})();
