const msgEl = document.getElementById("msg");
const countEl = document.getElementById("count");

function setMsg(text, cls) {
  msgEl.textContent = text;
  msgEl.className = "msg " + (cls || "");
}

function refreshCount() {
  chrome.runtime.sendMessage({ type: "getStats" }, (res) => {
    if (!res) return;
    countEl.textContent = res.count;
    document.getElementById("pendingCount").textContent = res.pendingCount || 0;
    const info = document.getElementById("scanInfo");
    if (res.gwtStatus && res.gwtStatus.lastScan) {
      const t = new Date(res.gwtStatus.lastScan);
      const hh = String(t.getHours()).padStart(2, "0");
      const mm = String(t.getMinutes()).padStart(2, "0");
      let stateText = "检查正常";
      if (res.gwtStatus.state === "needLogin") stateText = "内部网登录已过期，请重新登录";
      if (res.gwtStatus.state === "error") stateText = "检查失败（网络问题）";
      info.textContent = `上次检查 ${hh}:${mm} · ${stateText}`;
    }
  });
}

document.getElementById("sync").addEventListener("click", () => {
  setMsg("正在解析…");
  chrome.runtime.sendMessage({ type: "exportCaptured" }, (res) => {
    const records = (res && res.records) || [];
    if (records.length === 0) {
      setMsg("还没有捕获数据：请先在畅课页面打开课程 / 作业列表", "err");
      return;
    }
    const payload = window.SzuCalParser.parse(records);
    // 关键词过滤（仅作用于通知）
    const keyword = document.getElementById("keyword").value.trim();
    if (keyword && payload.notices) {
      payload.notices = payload.notices.filter(
        (n) => n.title.indexOf(keyword) !== -1 || n.content.indexOf(keyword) !== -1
      );
    }
    // 合并自动采集的待解析通知
    chrome.storage.local.get({ pendingNotices: [] }, (store) => {
      payload.notices = [...(payload.notices || []), ...store.pendingNotices];
      const noticeCount = payload.notices.length;
      if (payload.ddls.length === 0 && payload.courses.length === 0 && noticeCount === 0) {
        setMsg("未识别到作业、课程或通知，请点「导出样本」发给开发者适配", "err");
        return;
      }
      chrome.runtime.sendMessage({ type: "sync", payload }, (res) => {
        if (res && res.ok) {
          setMsg(
            `已发送：${payload.ddls.length} 条作业、${payload.courses.length} 门课程、${noticeCount} 条通知，请到日历页确认导入`,
            "ok"
          );
          // 待解析通知已交付日历页，清空队列与角标
          chrome.runtime.sendMessage({ type: "clearPendingNotices" }, () => {
            refreshCount();
          });
        } else {
          setMsg("发送失败，请重试", "err");
        }
      });
    });
  });
});

// 采集当前页面为通知：DOM 提取，不依赖接口，SSR 页面也能用
document.getElementById("extract").addEventListener("click", () => {
  setMsg("正在提取当前页面…");
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) {
      setMsg("未找到当前标签页", "err");
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { type: "extract-page" }, (res) => {
      if (chrome.runtime.lastError || !res || !res.notice) {
        setMsg("请在公文通 / 畅课的通知详情页使用此功能", "err");
        return;
      }
      const notice = res.notice;
      if (!notice.content || notice.content.length < 30) {
        setMsg("当前页面内容太少，无法作为通知采集", "err");
        return;
      }
      const payload = { ddls: [], courses: [], notices: [notice] };
      chrome.runtime.sendMessage({ type: "sync", payload }, (syncRes) => {
        if (syncRes && syncRes.ok) {
          setMsg("已发送 1 条通知，请到日历页点「AI 解析」", "ok");
        } else {
          setMsg("发送失败，请重试", "err");
        }
      });
    });
  });
});

// 关键词记忆
chrome.storage.local.get({ keyword: "" }, (res) => {
  document.getElementById("keyword").value = res.keyword;
});
document.getElementById("keyword").addEventListener("input", (e) => {
  chrome.storage.local.set({ keyword: e.target.value.trim() });
});

document.getElementById("export").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "exportCaptured" }, (res) => {
    const records = (res && res.records) || [];
    if (records.length === 0) {
      setMsg("暂无数据可导出", "err");
      return;
    }
    const blob = new Blob([JSON.stringify(records, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download(
      { url, filename: "szu-cal-sample.json", saveAs: true },
      () => {
        setMsg("样本已导出，发给开发者即可", "ok");
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    );
  });
});

document.getElementById("clear").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "clearCaptured" }, () => {
    refreshCount();
    setMsg("已清空", "muted");
  });
});

document.getElementById("scanNow").addEventListener("click", () => {
  setMsg("正在检查公文通…");
  chrome.runtime.sendMessage({ type: "scanNow" }, (res) => {
    if (res && res.state === "needLogin") {
      setMsg("内部网登录已过期：请先在新标签页登录 www1.szu.edu.cn", "err");
    } else if (res && res.state === "ok") {
      setMsg(`检查完成，新增 ${res.newCount} 条待解析通知`, "ok");
    } else {
      setMsg("检查失败，请稍后重试", "err");
    }
    refreshCount();
  });
});

refreshCount();
