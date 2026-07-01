// Runs in the page's MAIN world so it can wrap the page's own fetch/XHR.
// Naver Store is an SPA: after the first load, navigating to other pages pulls
// product/stock data over the network (fetch/XHR) instead of re-embedding it in
// an inline __PRELOADED_STATE__ script. We forward relevant JSON response bodies
// to the isolated content script (content.js) via window.postMessage, which then
// parses them with the same extraction pipeline used for the inline state.
(() => {
  const CHANNEL = "cnt-stock-net";

  // Cheap pre-filter: only forward bodies that look like they carry stock/product
  // data, so we do not serialize and post every unrelated JSON response.
  const RELEVANT = /stock|inventory|remain|available|productNo|channelProductNo|soldOut|saleStatus|productStatusType/i;

  function forward(text) {
    if (typeof text !== "string" || text.length === 0 || !RELEVANT.test(text)) {
      return;
    }

    try {
      window.postMessage({ source: CHANNEL, payload: text }, "*");
    } catch (error) {
      // Ignore postMessage failures.
    }
  }

  const originalFetch = window.fetch;

  if (typeof originalFetch === "function") {
    window.fetch = function patchedFetch(...args) {
      const result = originalFetch.apply(this, args);

      try {
        result
          .then((response) => {
            try {
              const contentType = response.headers.get("content-type") || "";

              if (contentType.includes("json")) {
                response
                  .clone()
                  .text()
                  .then(forward)
                  .catch(() => {});
              }
            } catch (error) {
              // Ignore responses we cannot inspect.
            }

            return response;
          })
          .catch(() => {});
      } catch (error) {
        // Ignore.
      }

      return result;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    this.addEventListener("load", () => {
      try {
        const responseType = this.responseType;

        if (responseType === "" || responseType === "text") {
          forward(this.responseText);
        } else if (responseType === "json" && this.response) {
          forward(JSON.stringify(this.response));
        }
      } catch (error) {
        // Ignore responses we cannot read.
      }
    });

    return originalSend.apply(this, args);
  };

  // Keep open patched only to preserve a stable reference order; no behavior change.
  XMLHttpRequest.prototype.open = function patchedOpen(...args) {
    return originalOpen.apply(this, args);
  };
})();
