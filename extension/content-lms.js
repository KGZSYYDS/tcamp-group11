// 畅课 / 内部网 content script：
// 1) 转发 page-hook 捕获的接口数据（MAIN world 注入见 manifest）
// 2) 响应 popup 的「采集当前页面」：DOM 直接提取通知标题与正文（SSR 页面也能用）
(function () {
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== "szu-cal-hook" || data.type !== "api") return;
    chrome.runtime.sendMessage({
      type: "captured",
      payload: Object.assign({}, data.payload, { origin: window.location.origin }),
    });
  });

  function extractPage() {
    // 标题：优先正文标题标签，其次 document.title（去掉站点名后缀）
    var heading = document.querySelector("h1, h2, .title, .notice-title, .news-title");
    var title = heading && heading.innerText.trim().length >= 4
      ? heading.innerText.trim()
      : document.title.replace(/[-_|—–].*$/, "").trim();

    // 正文：在常见正文容器中选文本最长者；找不到则退回 body
    var candidates = document.querySelectorAll(
      "article, .article, .content, .detail, #content, main, .notice-content, .news-content, .article-content"
    );
    var best = null;
    var bestLen = 0;
    candidates.forEach(function (el) {
      var t = el.innerText.trim();
      if (t.length > bestLen && t.length < 30000) {
        best = el;
        bestLen = t.length;
      }
    });
    var content = (bestLen > 200 ? best : document.body).innerText.trim();

    return {
      title: title || "未命名通知",
      content: content.slice(0, 8000),
      department: "",
      publishedAt: "",
      url: window.location.href,
    };
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.type === "extract-page") {
      try {
        sendResponse({ notice: extractPage() });
      } catch (e) {
        sendResponse({ error: String(e) });
      }
      return true;
    }
    if (message.type === "scan-board") {
      scanBoard()
        .then(sendResponse)
        .catch(function (e) {
          sendResponse({ state: "error", message: String(e) });
        });
      return true; // 异步
    }
    return false;
  });

  // ---------- 公文通自动采集（页面上下文，同站请求 cookie 必带） ----------

  var GWT_BOARD = "https://www1.szu.edu.cn/board/";
  var GWT_ORIGIN = "https://www1.szu.edu.cn";

  // fetch 的 text() 固定按 UTF-8 解码，老 ASP 系统的 GBK 页面会乱码。
  // 按 Content-Type 声明的编码解码，含替换字符时自动回退 GB18030。
  async function fetchText(url) {
    var res = await fetch(url, { credentials: "include" });
    var buf = await res.arrayBuffer();
    var ct = res.headers.get("content-type") || "";
    var m = ct.match(/charset=([\w-]+)/i);
    var charset = m ? m[1].toLowerCase() : "utf-8";
    if (charset === "gb2312" || charset === "gbk") charset = "gb18030";
    var text;
    try {
      text = new TextDecoder(charset).decode(buf);
    } catch (e) {
      text = new TextDecoder("utf-8").decode(buf);
    }
    if (text.indexOf("�") !== -1 && charset !== "gb18030") {
      try {
        var alt = new TextDecoder("gb18030").decode(buf);
        if (alt.indexOf("�") === -1) text = alt;
      } catch (e) {}
    }
    return text;
  }

  function htmlToText(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractLinks(html, origin) {
    var out = [];
    var seen = new Set();
    var re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html))) {
      var href = m[1];
      var text = htmlToText(m[2]).trim();
      if (text.length < 6 || text.length > 120) continue;
      if (/javascript:|^#|logout|login/i.test(href)) continue;
      if (!/detail|view|info|article|notice|content|show|id=|\/\d+/i.test(href)) continue;
      var url = href;
      if (href.startsWith("/")) url = origin + href;
      else if (!/^https?:\/\//.test(href)) url = origin + "/board/" + href;
      if (!url.startsWith(origin)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ title: text, url });
    }
    return out;
  }

  async function scanBoard() {
    var html = await fetchText(GWT_BOARD);

    // 登录表单特征 + 认证平台关键词同时出现才判未登录（避免误报）
    if (/type=["']password["']/i.test(html) && /统一身份认证|authserver/.test(html)) {
      return { state: "needLogin" };
    }

    var links = extractLinks(html, GWT_ORIGIN);
    var store = await chrome.storage.local.get({
      knownNotices: [],
      pendingNotices: [],
    });
    var known = new Set(store.knownNotices);
    var fresh = links.filter(function (l) {
      return !known.has(l.url);
    });

    var toFetch = fresh.slice(0, 5); // 每轮最多 5 条详情
    var pending = [...store.pendingNotices];
    for (var item of toFetch) {
      try {
        var detail = await fetchText(item.url);
        var content = htmlToText(detail).slice(0, 8000);
        if (content.length > 30) {
          pending.push({
            title: item.title,
            content: content,
            department: "",
            publishedAt: "",
            url: item.url,
          });
        }
        known.add(item.url);
      } catch (e) {
        // 单条失败下轮重试
      }
    }

    await chrome.storage.local.set({
      knownNotices: Array.from(known).slice(-500),
      pendingNotices: pending.slice(-50),
    });
    return { state: "ok", newCount: toFetch.length };
  }
})();

