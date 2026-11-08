// 后台：接口捕获存储、日历标签页同步、公文通定时自动采集。
// Service Worker 空闲挂起是 MV3 正常行为；状态全部存 chrome.storage。
const CALENDAR_URL = "https://szu-calendar.app.workbuddy.host/";
const GWT_BOARD = "https://www1.szu.edu.cn/board/";
const GWT_ORIGIN = "https://www1.szu.edu.cn";
const MAX_RECORDS = 300;

// ---------- 通用工具 ----------

function updateBadge(count) {
  chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
}

async function refreshBadge() {
  const { pendingNotices = [] } = await chrome.storage.local.get({
    pendingNotices: [],
  });
  updateBadge(pendingNotices.length);
}

// ---------- 接口捕获（串行写队列防竞争） ----------

let writeChain = Promise.resolve();
function saveCapture(payload) {
  writeChain = writeChain
    .then(async () => {
      const { captured = [] } = await chrome.storage.local.get({ captured: [] });
      const filtered = captured.filter((r) => r.url !== payload.url);
      filtered.push(payload);
      while (filtered.length > MAX_RECORDS) filtered.shift();
      await chrome.storage.local.set({ captured: filtered });
    })
    .catch(() => {});
}

async function setPending(value) {
  await chrome.storage.session.set({ pendingSync: value });
}

async function getPending() {
  const { pendingSync = null } = await chrome.storage.session.get({
    pendingSync: null,
  });
  return pendingSync;
}

// ---------- 公文通自动采集（在真实标签页内执行，cookie 必带） ----------

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // 超时 15s 也继续，让后续步骤自行判断
    }, 15000);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function scanGwt() {
  let tabId = null;
  let created = false;
  try {
    // 优先复用用户已打开的内部网标签页；否则后台新建（不抢占焦点）
    const tabs = await chrome.tabs.query({ url: "*://www1.szu.edu.cn/*" });
    if (tabs.length > 0) {
      tabId = tabs[0].id;
    } else {
      const tab = await chrome.tabs.create({ url: GWT_BOARD, active: false });
      tabId = tab.id;
      created = true;
      await waitForTabComplete(tabId);
    }

    // 被重定向到统一认证页 = 登录已过期（URL 判断，避免关键词误报）
    const tabInfo = await chrome.tabs.get(tabId);
    if (/authserver\.szu\.edu\.cn/.test(tabInfo.url || "")) {
      await chrome.storage.local.set({
        gwtStatus: { lastScan: Date.now(), state: "needLogin" },
      });
      return { state: "needLogin" };
    }

    // 页面上下文内完成列表 + 详情抓取（同站请求，cookie 必带）
    const result = await chrome.tabs.sendMessage(tabId, { type: "scan-board" });
    await chrome.storage.local.set({
      gwtStatus: { lastScan: Date.now(), ...result },
    });
    await refreshBadge();
    return result;
  } catch (e) {
    await chrome.storage.local.set({
      gwtStatus: { lastScan: Date.now(), state: "error", message: String(e) },
    });
    return { state: "error", message: String(e) };
  } finally {
    if (created && tabId !== null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {}
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("gwt-auto-scan", { periodInMinutes: 60 });
  refreshBadge();
  scanGwt(); // 安装 / 更新后立即检查一次
});

chrome.runtime.onStartup.addListener(() => {
  refreshBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "gwt-auto-scan") scanGwt();
});

// ---------- 消息路由 ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "captured") {
    saveCapture(message.payload);
    return false;
  }

  if (message.type === "getStats") {
    (async () => {
      const { captured = [], pendingNotices = [], gwtStatus = null } =
        await chrome.storage.local.get({
          captured: [],
          pendingNotices: [],
          gwtStatus: null,
        });
      sendResponse({
        count: captured.length,
        pendingCount: pendingNotices.length,
        gwtStatus,
      });
    })();
    return true;
  }

  if (message.type === "clearCaptured") {
    chrome.storage.local.set({ captured: [] }, () => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "exportCaptured") {
    chrome.storage.local.get({ captured: [] }, (result) => {
      sendResponse({ records: result.captured });
    });
    return true;
  }

  if (message.type === "getPendingNotices") {
    chrome.storage.local.get({ pendingNotices: [] }, (result) => {
      sendResponse({ notices: result.pendingNotices });
    });
    return true;
  }

  if (message.type === "clearPendingNotices") {
    (async () => {
      await chrome.storage.local.set({ pendingNotices: [] });
      updateBadge(0);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "scanNow") {
    (async () => {
      const result = await scanGwt();
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === "sync") {
    (async () => {
      await setPending({ payload: message.payload, createdAt: Date.now() });
      const tabs = await chrome.tabs.query({
        url: "https://szu-calendar.app.workbuddy.host/*",
      });
      if (tabs.length > 0) {
        await chrome.tabs.update(tabs[0].id, { active: true });
        try {
          await chrome.tabs.sendMessage(tabs[0].id, {
            type: "sync-payload",
            payload: message.payload,
          });
          await setPending(null);
        } catch (e) {
          // content script 未就绪时由 calendar-ready 兜底补发
        }
        sendResponse({ ok: true, reused: true });
      } else {
        await chrome.tabs.create({ url: CALENDAR_URL, active: true });
        sendResponse({ ok: true, reused: false });
      }
    })();
    return true;
  }

  if (message.type === "calendar-ready") {
    (async () => {
      const pending = await getPending();
      if (pending) {
        try {
          await chrome.tabs.sendMessage(sender.tab.id, {
            type: "sync-payload",
            payload: pending.payload,
          });
          await setPending(null);
        } catch (e) {}
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});
