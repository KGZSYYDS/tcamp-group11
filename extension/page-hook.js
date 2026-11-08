// 注入教学平台页面主世界：包裹 XHR / fetch，记录 JSON 接口响应。
// 只读数据，不修改页面行为，不读取任何密码字段。
(function () {
  if (window.__SZU_CAL_HOOKED__) return;
  window.__SZU_CAL_HOOKED__ = true;

  var MAX_BODY = 1024 * 1024; // 单个响应最多记录 1MB，防止大文件撑爆存储

  function report(url, method, body) {
    try {
      var text = typeof body === "string" ? body : JSON.stringify(body);
      if (!text || text.length > MAX_BODY) return;
      var json = typeof body === "string" ? JSON.parse(text) : body;
      if (typeof json !== "object" || json === null) return;
      window.postMessage(
        {
          source: "szu-cal-hook",
          type: "api",
          payload: { url: String(url), method: method, time: Date.now(), body: json },
        },
        window.location.origin
      );
    } catch (e) {
      /* 非 JSON 响应直接忽略 */
    }
  }

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__szuCalMethod = method;
    this.__szuCalUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    xhr.addEventListener("load", function () {
      try {
        var type = xhr.getResponseHeader("content-type") || "";
        if (type.indexOf("json") === -1) return;
        report(xhr.__szuCalUrl, xhr.__szuCalMethod, xhr.responseText);
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var method = (init && init.method) || (input && input.method) || "GET";
    return origFetch.apply(this, arguments).then(function (response) {
      try {
        var type = response.headers.get("content-type") || "";
        if (type.indexOf("json") !== -1) {
          response
            .clone()
            .text()
            .then(function (text) {
              report(url, method, text);
            })
            .catch(function () {});
        }
      } catch (e) {}
      return response;
    });
  };
})();
