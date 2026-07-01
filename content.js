(() => {
  const STORAGE_ENABLED_KEY = "cntStockOverlayEnabled";
  const OVERLAY_HOST_ID = "cnt-stock-overlay-root";
  const OVERLAY_CLASS = "cnt-stock-overlay";
  const POPOVER_CLASS = "cnt-stock-popover";
  const OVERLAY_CONTAINER_ATTR = "data-cnt-stock-overlay-container";
  const OVERLAY_ID_ATTR = "data-cnt-stock-product-id";
  const LEGACY_STYLE_ID = "cnt-stock-overlay-style";
  const PRODUCT_LINK_SELECTOR =
    'a[href*="/products/"], a[href*="productNo="], a[href*="channelProductNo="]';

  const PRODUCT_ID_KEYS = [
    "channelProductId",
    "channelProductNo",
    "productNo",
    "originProductNo",
    "productId",
    "productSeq",
    "mallProductId",
    "nvMid",
    "itemNo",
    "itemId",
    "id"
  ];

  const PRODUCT_HINT_KEYS = [
    "channelProductNo",
    "productNo",
    "originProductNo",
    "productId",
    "productName",
    "name",
    "productUrl",
    "representativeImageUrl",
    "imageUrl",
    "mobileImageUrl",
    "salePrice",
    "discountedSalePrice"
  ];

  const STOCK_KEYS = [
    "stockQuantity",
    "stockQty",
    "stockCount",
    "saleStockQuantity",
    "availableStockQuantity",
    "availableStock",
    "remainStockQuantity",
    "remainingStockQuantity",
    "usableStockQuantity",
    "inventoryQuantity",
    "inventoryQty"
  ];

  const CONTEXTUAL_STOCK_KEYS = ["quantity", "qty"];

  const SOLD_OUT_KEYS = [
    "soldOut",
    "soldout",
    "isSoldOut",
    "outOfStock",
    "soldOutYn",
    "stockYn",
    "saleStatus",
    "status"
  ];

  const productStocks = new Map();
  const seenInlineStateTexts = new Set();
  let overlayEnabled = true;
  let refreshTimer = null;
  let inlineStateTimer = null;
  let popoverHideTimer = null;

  function isPlainObject(value) {
    return Object.prototype.toString.call(value) === "[object Object]";
  }

  function parseStockValue(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }

    if (typeof value === "string") {
      const normalized = value.trim();

      if (/^(품절|sold\s*out|out\s*of\s*stock)$/i.test(normalized)) {
        return 0;
      }

      if (/^\d[\d,]*$/.test(normalized)) {
        return Number.parseInt(normalized.replaceAll(",", ""), 10);
      }
    }

    return null;
  }

  function parseSoldOutValue(value) {
    if (value === true) {
      return 0;
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();

      if (["y", "yes", "true", "soldout", "sold_out", "out_of_stock"].includes(normalized)) {
        return 0;
      }

      if (normalized.includes("품절") || normalized.includes("soldout")) {
        return 0;
      }
    }

    return null;
  }

  function objectHasAnyKey(object, keys) {
    return keys.some((key) => Object.prototype.hasOwnProperty.call(object, key));
  }

  function looksProductLike(object) {
    return objectHasAnyKey(object, PRODUCT_HINT_KEYS);
  }

  function looksSimpleProductLike(object) {
    return (
      Object.prototype.hasOwnProperty.call(object, "id") &&
      Object.prototype.hasOwnProperty.call(object, "productNo") &&
      (Object.prototype.hasOwnProperty.call(object, "stockQuantity") ||
        Object.prototype.hasOwnProperty.call(object, "productStatusType") ||
        Object.prototype.hasOwnProperty.call(object, "representativeImageUrl"))
    );
  }

  function normalizeProductId(value) {
    if (value === null || value === undefined) {
      return "";
    }

    const text = String(value).trim();

    if (!text || text.length > 40) {
      return "";
    }

    const match = text.match(/\d{4,}/);
    return match ? match[0] : "";
  }

  function pickProductId(object) {
    if (looksSimpleProductLike(object)) {
      const channelProductId = normalizeProductId(object.id);

      if (channelProductId) {
        return channelProductId;
      }
    }

    for (const key of PRODUCT_ID_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) {
        continue;
      }

      if (key === "id" && !looksProductLike(object)) {
        continue;
      }

      const productId = normalizeProductId(object[key]);

      if (productId) {
        return productId;
      }
    }

    return "";
  }

  function pickProductName(object) {
    for (const key of ["productName", "name", "displayName"]) {
      if (typeof object[key] === "string" && object[key].trim()) {
        return object[key].trim();
      }
    }

    return "";
  }

  function hasStockContext(object, context) {
    const pathText = context.path.join(".").toLowerCase();
    const keyText = Object.keys(object).join(".").toLowerCase();
    const haystack = `${pathText}.${keyText}`;
    const hasPositiveSignal =
      haystack.includes("stock") ||
      haystack.includes("inventory") ||
      haystack.includes("remain") ||
      haystack.includes("available");
    const hasOrderSignal =
      haystack.includes("orderamount") ||
      haystack.includes("totalorderamount") ||
      haystack.includes("product-benefit") ||
      haystack.includes("benefit");

    return hasPositiveSignal && !hasOrderSignal;
  }

  function pickStock(object, context) {
    for (const key of STOCK_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) {
        continue;
      }

      const stock = parseStockValue(object[key]);

      if (stock !== null) {
        return { key, stock };
      }
    }

    if (hasStockContext(object, context)) {
      for (const key of CONTEXTUAL_STOCK_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(object, key)) {
          continue;
        }

        const stock = parseStockValue(object[key]);

        if (stock !== null) {
          return { key, stock };
        }
      }
    }

    for (const key of SOLD_OUT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) {
        continue;
      }

      const stock = parseSoldOutValue(object[key]);

      if (stock !== null) {
        return { key, stock };
      }
    }

    return null;
  }

  function addRecord(records, productId, stockInfo, context, sourceObject, isDirectProductObject) {
    if (!productId || !stockInfo) {
      return;
    }

    const current =
      records.get(productId) ||
      {
        directStocks: [],
        nestedStocks: [],
        name: "",
        keys: new Set(),
        rawSamples: []
      };

    const sample = {
      stock: stockInfo.stock,
      key: stockInfo.key
    };

    if (isDirectProductObject) {
      current.directStocks.push(sample);
    } else {
      current.nestedStocks.push(sample);
    }

    if (!current.name && context.name) {
      current.name = context.name;
    }

    current.keys.add(stockInfo.key);

    if (current.rawSamples.length < 5) {
      current.rawSamples.push({
        key: stockInfo.key,
        path: context.path.join(".") || "(root)",
        directProductObject: isDirectProductObject,
        data: sourceObject
      });
    }

    records.set(productId, current);
  }

  function summarizeRecord(record) {
    if (record.directStocks.length > 0) {
      return record.directStocks[0].stock;
    }

    const uniqueNestedStocks = [...new Set(record.nestedStocks.map((sample) => sample.stock))];

    if (uniqueNestedStocks.length === 1) {
      return uniqueNestedStocks[0];
    }

    return uniqueNestedStocks.reduce((sum, stock) => sum + stock, 0);
  }

  function extractStockRecords(payload) {
    const records = new Map();
    const seenObjects = new WeakSet();

    function walk(node, context = { productId: "", name: "", path: [] }) {
      if (Array.isArray(node)) {
        for (const item of node) {
          walk(item, context);
        }
        return;
      }

      if (!isPlainObject(node) || seenObjects.has(node)) {
        return;
      }

      seenObjects.add(node);

      const ownProductId = pickProductId(node);
      const productId = ownProductId || context.productId;
      const name = pickProductName(node) || context.name;
      const nextContext = { ...context, productId, name };
      const stockInfo = pickStock(node, nextContext);

      addRecord(records, productId, stockInfo, nextContext, node, Boolean(ownProductId));

      for (const [key, value] of Object.entries(node)) {
        if (value && (Array.isArray(value) || isPlainObject(value))) {
          walk(value, { ...nextContext, path: [...nextContext.path, key] });
        }
      }
    }

    walk(payload);

    return [...records.entries()].map(([productId, record]) => ({
      productId,
      stock: summarizeRecord(record),
      name: record.name,
      keys: [...record.keys],
      rawSamples: record.rawSamples
    }));
  }

  function ensureOverlayRoot() {
    let host = document.getElementById(OVERLAY_HOST_ID);

    if (!host) {
      host = document.createElement("div");
      host.id = OVERLAY_HOST_ID;
      host.setAttribute("aria-hidden", "true");
      document.documentElement.append(host);
    }

    host.style.cssText = [
      "position: absolute",
      "top: 0",
      "left: 0",
      "z-index: 2147483647",
      "display: block",
      `width: ${Math.max(document.documentElement.scrollWidth, window.innerWidth)}px`,
      `height: ${Math.max(document.documentElement.scrollHeight, window.innerHeight)}px`,
      "margin: 0",
      "padding: 0",
      "border: 0",
      "background: transparent",
      "overflow: visible",
      "pointer-events: none"
    ].join(";");

    const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });

    const style = shadow.querySelector("style") || document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
      }

      .${OVERLAY_CLASS} {
        all: initial;
        position: absolute;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 34px;
        min-height: 24px;
        max-width: var(--cnt-stock-max-width, 160px);
        padding: 4px 8px;
        border: 1px solid rgb(255 255 255 / 82%);
        border-radius: 7px;
        color: #ffffff;
        background: #137a3a;
        box-shadow: 0 8px 18px rgb(0 0 0 / 22%);
        font: 800 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
        cursor: help;
        pointer-events: auto;
        white-space: nowrap;
        transform: translateX(-100%);
      }

      .${OVERLAY_CLASS}[data-cnt-stock-state="low"] {
        background: #bf5b00;
      }

      .${OVERLAY_CLASS}[data-cnt-stock-state="soldout"] {
        background: #a32929;
      }

      .${POPOVER_CLASS} {
        all: initial;
        position: absolute;
        z-index: 2;
        display: flex;
        flex-direction: column;
        width: min(360px, calc(100vw - 24px));
        max-height: min(560px, calc(100vh - 24px));
        overflow: hidden;
        border: 1px solid rgb(16 24 32 / 16%);
        border-radius: 10px;
        color: #17202a;
        background: #ffffff;
        box-shadow: 0 18px 50px rgb(0 0 0 / 28%);
        font: 12px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        pointer-events: auto;
      }

      .${POPOVER_CLASS} * {
        box-sizing: border-box;
      }

      .cnt-pop-head {
        display: flex;
        flex: 0 0 auto;
        gap: 10px;
        align-items: flex-start;
        padding: 11px 12px;
        border-bottom: 1px solid #e8edf2;
        background: #f8fafc;
      }

      .cnt-pop-thumb {
        flex: 0 0 auto;
        width: 48px;
        height: 48px;
        border: 1px solid #e3e9ef;
        border-radius: 8px;
        object-fit: cover;
        background: #eef2f6;
      }

      .cnt-pop-headtext {
        flex: 1 1 auto;
        min-width: 0;
      }

      .cnt-pop-name {
        display: block;
        color: #111820;
        font: 800 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        word-break: break-word;
      }

      .cnt-pop-sub {
        display: block;
        margin-top: 3px;
        color: #6b7785;
        font: 11px/1.3 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .cnt-pop-body {
        flex: 1 1 auto;
        overflow: auto;
        padding: 4px 0;
      }

      .cnt-pop-row {
        display: flex;
        gap: 10px;
        padding: 5px 12px;
        align-items: baseline;
      }

      .cnt-pop-key {
        flex: 0 0 60px;
        color: #6b7785;
        font: 600 11px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .cnt-pop-val {
        flex: 1 1 auto;
        color: #1d2630;
        font: 500 12px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        word-break: break-word;
      }

      .cnt-pop-stock {
        display: inline-flex;
        align-items: center;
        padding: 1px 8px;
        border-radius: 999px;
        color: #ffffff;
        background: #137a3a;
        font: 800 12px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .cnt-pop-stock[data-cnt-stock-state="low"] {
        background: #bf5b00;
      }

      .cnt-pop-stock[data-cnt-stock-state="soldout"] {
        background: #a32929;
      }

      .cnt-pop-strike {
        margin-left: 6px;
        color: #98a2ad;
        font-weight: 500;
        text-decoration: line-through;
      }

      .cnt-pop-meta {
        margin-top: 4px;
        padding-top: 6px;
        border-top: 1px solid #eef2f6;
      }

      .cnt-pop-meta .cnt-pop-val {
        color: #6b7785;
        font-size: 11px;
        word-break: break-all;
      }

      .${POPOVER_CLASS} details {
        margin: 4px 12px 12px;
      }

      .${POPOVER_CLASS} summary {
        cursor: pointer;
        color: #4a72b8;
        font: 600 11px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        list-style: revert;
        user-select: none;
      }

      .${POPOVER_CLASS} pre {
        box-sizing: border-box;
        max-height: 280px;
        margin: 8px 0 0;
        padding: 10px 12px 12px;
        overflow: auto;
        border-radius: 6px;
        color: #29333d;
        background: #f4f7fa;
        font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }
    `;

    if (!style.isConnected) {
      shadow.append(style);
    }

    return shadow;
  }

  const PRODUCT_STATUS_LABELS = {
    SALE: "판매중",
    OUTOFSTOCK: "품절",
    SOLDOUT: "품절",
    SUSPENSION: "판매중지",
    PROHIBITION: "판매금지",
    CLOSE: "판매종료",
    END: "판매종료",
    WAIT: "판매대기",
    DELETE: "삭제됨"
  };

  const DELIVERY_FEE_LABELS = {
    FREE: "무료배송",
    CONDITIONAL_FREE: "조건부 무료배송",
    PAID: "유료배송",
    PAY: "유료배송",
    CHARGE: "유료배송",
    DIFF: "착불"
  };

  function formatStock(stock) {
    return `${stock.toLocaleString("ko-KR")}개`;
  }

  const PURCHASE_POINT_KEYS = [
    "sellerPurchasePoint",
    "managerPurchasePoint",
    "sellerCustomerManagementPoint",
    "managerCustomerManagementPoint",
    "sellerPurchaseExtraPoint",
    "managerPurchaseExtraPoint"
  ];

  function formatPrice(value) {
    return `${value.toLocaleString("ko-KR")}원`;
  }

  function sumNumericKeys(object, keys) {
    if (!isPlainObject(object)) {
      return 0;
    }

    return keys.reduce(
      (total, key) => total + (typeof object[key] === "number" ? object[key] : 0),
      0
    );
  }

  function getMaxReviewReward(benefitsView) {
    if (!isPlainObject(benefitsView)) {
      return 0;
    }

    const pair = (sellerKey, managerKey) =>
      (typeof benefitsView[sellerKey] === "number" ? benefitsView[sellerKey] : 0) +
      (typeof benefitsView[managerKey] === "number" ? benefitsView[managerKey] : 0);

    return Math.max(
      pair("textReviewPoint", "managerTextReviewPoint"),
      pair("photoVideoReviewPoint", "managerPhotoVideoReviewPoint"),
      pair("afterUseTextReviewPoint", "managerAfterUseTextReviewPoint"),
      pair("afterUsePhotoVideoReviewPoint", "managerAfterUsePhotoVideoReviewPoint")
    );
  }

  function describeDelivery(product) {
    const info = product.productDeliveryInfo || {};

    if (product.freeDelivery || info.deliveryFeeType === "FREE") {
      return "무료배송";
    }

    const baseFee = typeof info.baseFee === "number" ? info.baseFee : null;

    if (info.deliveryFeeType === "CONDITIONAL_FREE") {
      const parts = [];

      if (typeof info.freeConditionalAmount === "number") {
        parts.push(`${info.freeConditionalAmount.toLocaleString("ko-KR")}원↑ 무료`);
      }

      if (baseFee) {
        parts.push(`기본 ${formatPrice(baseFee)}`);
      }

      return parts.length ? `조건부 무료 (${parts.join(" / ")})` : "조건부 무료배송";
    }

    if (baseFee !== null) {
      return formatPrice(baseFee);
    }

    return DELIVERY_FEE_LABELS[info.deliveryFeeType] || (info.deliveryFeeType ? String(info.deliveryFeeType) : "");
  }

  function formatTimestamp(value) {
    if (!value) {
      return "";
    }

    try {
      return new Date(value).toLocaleString("ko-KR");
    } catch (error) {
      return "";
    }
  }

  function getStockState(stock) {
    if (stock <= 0) {
      return "soldout";
    }

    if (stock <= 5) {
      return "low";
    }

    return "normal";
  }

  function getProductIdFromUrl(href) {
    try {
      const url = new URL(href, location.href);
      const pathMatch = url.pathname.match(/\/products\/(\d+)/);

      if (pathMatch) {
        return pathMatch[1];
      }

      for (const key of ["productNo", "channelProductNo", "productId", "id"]) {
        const value = normalizeProductId(url.searchParams.get(key));

        if (value) {
          return value;
        }
      }
    } catch (error) {
      return "";
    }

    return "";
  }

  function countDistinctProducts(root) {
    const ids = new Set();

    for (const anchor of root.querySelectorAll(PRODUCT_LINK_SELECTOR)) {
      const id = getProductIdFromUrl(anchor.getAttribute("href"));

      if (id) {
        ids.add(id);
      }
    }

    return ids.size;
  }

  function findProductImage(link) {
    // Smartstore/brand PLP cards nest the <img> inside the product link.
    const inside = link.querySelector("img");

    if (inside) {
      return inside;
    }

    // Naver Shopping search cards put the product link and its thumbnail <img>
    // as siblings inside a shared card wrapper, so the image is not a descendant
    // of the link. Climb toward the card wrapper and take its image, but stop
    // before an ancestor spans more than one product (that would be a container
    // shared by several cards, where the image would be ambiguous).
    let node = link.parentElement;

    for (let depth = 0; node && depth < 6; depth += 1) {
      if (countDistinctProducts(node) > 1) {
        break;
      }

      const image = node.querySelector("img");

      if (image) {
        return image;
      }

      node = node.parentElement;
    }

    return null;
  }

  function isInactiveSwiperSlide(link) {
    const slide = link.closest(".swiper-slide");
    return Boolean(slide && !slide.classList.contains("swiper-slide-active"));
  }

  function isElementRenderable(element) {
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function getBadgeRectTarget(link, image) {
    if (!isElementRenderable(link) || !isElementRenderable(image)) {
      return null;
    }

    const linkRect = link.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();

    if (
      linkRect.width > 0 &&
      linkRect.height > 0 &&
      linkRect.width >= imageRect.width * 0.8 &&
      linkRect.height >= imageRect.height * 0.8
    ) {
      return linkRect;
    }

    if (imageRect.width > 0 && imageRect.height > 0) {
      return imageRect;
    }

    return null;
  }

  function isRectInViewport(rect) {
    return (
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight
    );
  }

  function getCandidateScore(link, rect) {
    let score = rect.width * rect.height;
    const slide = link.closest(".swiper-slide");

    if (slide?.classList.contains("swiper-slide-active")) {
      score += 1_000_000;
    }

    if (!slide) {
      score += 900_000;
    }

    if (link.closest('[data-shp-inventory="list"]')) {
      score += 100_000;
    }

    if (isRectInViewport(rect)) {
      score += 50_000;
    }

    return score;
  }

  function collectOverlayCandidates() {
    const candidatesByProductId = new Map();
    const links = document.querySelectorAll(PRODUCT_LINK_SELECTOR);

    for (const link of links) {
      if (isInactiveSwiperSlide(link)) {
        continue;
      }

      const productId = getProductIdFromUrl(link.getAttribute("href"));
      const record = productStocks.get(productId);

      if (!record) {
        continue;
      }

      const image = findProductImage(link);
      const rect = image ? getBadgeRectTarget(link, image) : null;

      if (!image || !rect) {
        continue;
      }

      const candidate = {
        image,
        productId,
        record,
        rect,
        score: getCandidateScore(link, rect)
      };
      const previous = candidatesByProductId.get(productId);

      if (!previous || candidate.score > previous.score) {
        candidatesByProductId.set(productId, candidate);
      }
    }

    return [...candidatesByProductId.values()];
  }

  function removeOverlays() {
    document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((element) => element.remove());
    document.getElementById(OVERLAY_HOST_ID)?.remove();
    document.getElementById(LEGACY_STYLE_ID)?.remove();
    document
      .querySelectorAll(`[${OVERLAY_CONTAINER_ATTR}="true"]`)
      .forEach((element) => element.removeAttribute(OVERLAY_CONTAINER_ATTR));
  }

  function buildPopoverData(productId, record) {
    return {
      productId,
      stock: record.stock,
      stockText: formatStock(record.stock),
      name: record.name,
      stockKeys: record.keys,
      sourceUrl: record.sourceUrl,
      updatedAt: new Date(record.updatedAt).toISOString(),
      rawSamples: record.rawSamples || []
    };
  }

  function pickPrimaryProduct(record) {
    const samples = record.rawSamples || [];
    const objectSamples = samples.filter((sample) => isPlainObject(sample.data));

    if (objectSamples.length === 0) {
      return null;
    }

    const directSamples = objectSamples.filter((sample) => sample.directProductObject);
    const pool = directSamples.length > 0 ? directSamples : objectSamples;

    let best = pool[0].data;
    let bestScore = -1;

    for (const sample of pool) {
      const score = PRODUCT_HINT_KEYS.reduce(
        (count, key) => count + (Object.prototype.hasOwnProperty.call(sample.data, key) ? 1 : 0),
        0
      );

      if (score > bestScore) {
        bestScore = score;
        best = sample.data;
      }
    }

    return best;
  }

  function collectFacts(productId, record, product) {
    const facts = [];
    const stockState = getStockState(record.stock);

    facts.push({ label: "재고", value: formatStock(record.stock), stockState });

    if (product) {
      const status = product.productStatusType || product.saleStatus;

      if (status) {
        facts.push({ label: "상태", value: PRODUCT_STATUS_LABELS[status] || String(status) });
      }

      const salePrice =
        typeof product.salePrice === "number"
          ? product.salePrice
          : typeof product.dispSalePrice === "number"
          ? product.dispSalePrice
          : null;
      const discounted = product.benefitsView?.discountedSalePrice ?? product.discountedSalePrice;
      const discountedRatio = product.benefitsView?.discountedRatio ?? product.discountedRatio;

      if (typeof discounted === "number" && salePrice !== null && discounted < salePrice) {
        const ratioText = discountedRatio ? ` (${discountedRatio}%↓)` : "";
        facts.push({
          label: "가격",
          value: formatPrice(discounted) + ratioText,
          strike: formatPrice(salePrice)
        });
        facts.push({ label: "할인액", value: formatPrice(salePrice - discounted) });
      } else if (salePrice !== null) {
        facts.push({ label: "가격", value: formatPrice(salePrice) });
      }

      const purchasePoint = sumNumericKeys(product.benefitsView, PURCHASE_POINT_KEYS);

      if (purchasePoint > 0) {
        facts.push({ label: "적립", value: formatPrice(purchasePoint) });
      }

      const reviewReward = getMaxReviewReward(product.benefitsView);

      if (reviewReward > 0) {
        facts.push({ label: "리뷰적립", value: `최대 ${formatPrice(reviewReward)}` });
      }

      const review = product.reviewAmount || product;

      if (review && (review.totalReviewCount || review.averageReviewScore)) {
        const score = review.averageReviewScore ? `★ ${review.averageReviewScore}` : "리뷰";
        const count = (review.totalReviewCount || 0).toLocaleString("ko-KR");
        facts.push({ label: "리뷰", value: `${score} (${count})` });
      }

      const delivery = describeDelivery(product);

      if (delivery) {
        facts.push({ label: "배송", value: delivery });
      }

      const purchaseQuantity = product.purchaseQuantityInfo || {};
      const maxQuantity =
        purchaseQuantity.maxPurchaseQuantityPerOrder ??
        purchaseQuantity.maxPurchaseQuantityPerId ??
        purchaseQuantity.maxPurchaseQuantityPerTime;

      if (typeof maxQuantity === "number" && maxQuantity > 0) {
        facts.push({ label: "최대구매", value: formatStock(maxQuantity) });
      }

      const brand = product.naverShoppingSearchInfo?.brandName;
      const maker = product.naverShoppingSearchInfo?.manufacturerName;

      if (brand || maker) {
        facts.push({ label: "브랜드", value: [brand, maker].filter(Boolean).join(" / ") });
      }

      const store = product.channel?.channelName || product.mallName;

      if (store) {
        facts.push({ label: "스토어", value: store });
      }

      const category = product.category?.wholeCategoryName;

      if (category) {
        facts.push({ label: "카테고리", value: category.replaceAll(">", " › ") });
      }
    }

    facts.push({ label: "상품번호", value: productId });

    return facts;
  }

  function createFieldRow(fact) {
    const row = document.createElement("div");
    row.className = "cnt-pop-row";

    const key = document.createElement("span");
    key.className = "cnt-pop-key";
    key.textContent = fact.label;

    const value = document.createElement("span");
    value.className = "cnt-pop-val";

    if (fact.stockState) {
      const pill = document.createElement("span");
      pill.className = "cnt-pop-stock";
      pill.dataset.cntStockState = fact.stockState;
      pill.textContent = fact.value;
      value.append(pill);
    } else {
      value.textContent = fact.value;

      if (fact.strike) {
        const strike = document.createElement("span");
        strike.className = "cnt-pop-strike";
        strike.textContent = fact.strike;
        value.append(strike);
      }
    }

    row.append(key, value);
    return row;
  }

  function buildPopoverContent(productId, record) {
    const popover = document.createElement("section");
    popover.className = POPOVER_CLASS;

    const product = pickPrimaryProduct(record);

    const head = document.createElement("div");
    head.className = "cnt-pop-head";

    const imageUrl =
      product?.representativeImageUrl ||
      product?.imageUrl ||
      product?.mobileImageUrl ||
      product?.images?.[0]?.imageUrl;

    if (imageUrl) {
      const thumb = document.createElement("img");
      thumb.className = "cnt-pop-thumb";
      thumb.src = imageUrl;
      thumb.alt = "";
      thumb.loading = "lazy";
      thumb.referrerPolicy = "no-referrer";
      thumb.addEventListener("error", () => thumb.remove());
      head.append(thumb);
    }

    const headText = document.createElement("div");
    headText.className = "cnt-pop-headtext";

    const name = document.createElement("span");
    name.className = "cnt-pop-name";
    name.textContent = record.name || product?.name || product?.dispName || productId;
    headText.append(name);

    const channelName = product?.channel?.channelName;

    if (channelName) {
      const sub = document.createElement("span");
      sub.className = "cnt-pop-sub";
      sub.textContent = channelName;
      headText.append(sub);
    }

    head.append(headText);

    const body = document.createElement("div");
    body.className = "cnt-pop-body";

    for (const fact of collectFacts(productId, record, product)) {
      body.append(createFieldRow(fact));
    }

    const meta = document.createElement("div");
    meta.className = "cnt-pop-meta";

    if (record.keys?.length) {
      meta.append(createFieldRow({ label: "감지 키", value: record.keys.join(", ") }));
    }

    const updatedText = formatTimestamp(record.updatedAt);

    if (updatedText) {
      meta.append(createFieldRow({ label: "갱신", value: updatedText }));
    }

    if (record.sourceUrl) {
      meta.append(createFieldRow({ label: "출처", value: record.sourceUrl }));
    }

    if (meta.childElementCount > 0) {
      body.append(meta);
    }

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "원본 JSON 보기";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(buildPopoverData(productId, record), null, 2);
    details.append(summary, pre);
    body.append(details);

    popover.append(head, body);
    return popover;
  }

  function hidePopover(root) {
    window.clearTimeout(popoverHideTimer);
    root.querySelector(`.${POPOVER_CLASS}`)?.remove();
  }

  function scheduleHidePopover(root) {
    window.clearTimeout(popoverHideTimer);
    popoverHideTimer = window.setTimeout(() => hidePopover(root), 120);
  }

  function showPopover(root, anchor, productId, record) {
    window.clearTimeout(popoverHideTimer);
    root.querySelector(`.${POPOVER_CLASS}`)?.remove();

    const popover = buildPopoverContent(productId, record);

    popover.addEventListener("mouseenter", () => window.clearTimeout(popoverHideTimer));
    popover.addEventListener("mouseleave", () => scheduleHidePopover(root));
    root.append(popover);

    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const gap = 8;
    const viewportLeft =
      anchorRect.right + gap + popoverRect.width <= window.innerWidth - gap
        ? anchorRect.right + gap
        : Math.max(gap, anchorRect.right - popoverRect.width);
    const viewportTop = Math.min(
      Math.max(gap, anchorRect.top),
      Math.max(gap, window.innerHeight - popoverRect.height - gap)
    );

    popover.style.left = `${Math.max(0, window.scrollX + viewportLeft)}px`;
    popover.style.top = `${Math.max(0, window.scrollY + viewportTop)}px`;
  }

  function removeLegacyArtifacts() {
    document.getElementById(LEGACY_STYLE_ID)?.remove();
    document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((element) => element.remove());
    document
      .querySelectorAll(`[${OVERLAY_CONTAINER_ATTR}="true"]`)
      .forEach((element) => element.removeAttribute(OVERLAY_CONTAINER_ATTR));
  }

  function renderOverlays() {
    if (!overlayEnabled) {
      removeOverlays();
      return;
    }

    removeLegacyArtifacts();
    const root = ensureOverlayRoot();
    root
      .querySelectorAll(`.${OVERLAY_CLASS}, .${POPOVER_CLASS}`)
      .forEach((element) => element.remove());

    const seenImages = new WeakSet();

    for (const { image, productId, record, rect } of collectOverlayCandidates()) {
      if (seenImages.has(image)) {
        continue;
      }

      seenImages.add(image);

      const overlay = document.createElement("span");
      overlay.className = OVERLAY_CLASS;
      overlay.setAttribute(OVERLAY_ID_ATTR, productId);
      overlay.tabIndex = 0;
      overlay.style.left = `${Math.max(0, window.scrollX + rect.right - 8)}px`;
      overlay.style.top = `${Math.max(0, window.scrollY + rect.top + 8)}px`;
      overlay.style.setProperty("--cnt-stock-max-width", `${Math.max(48, rect.width - 16)}px`);

      overlay.textContent = formatStock(record.stock);
      overlay.dataset.cntStockState = getStockState(record.stock);
      overlay.title = record.name ? `${record.name} / ${formatStock(record.stock)}` : formatStock(record.stock);
      overlay.addEventListener("mouseenter", () => showPopover(root, overlay, productId, record));
      overlay.addEventListener("mouseleave", () => scheduleHidePopover(root));
      overlay.addEventListener("focus", () => showPopover(root, overlay, productId, record));
      overlay.addEventListener("blur", () => scheduleHidePopover(root));
      root.append(overlay);
    }
  }

  function scheduleRender() {
    if (refreshTimer !== null) {
      return;
    }

    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      renderOverlays();
    }, 80);
  }

  function isOverlayNode(node) {
    if (!(node instanceof Element)) {
      return false;
    }

    return node.id === OVERLAY_HOST_ID || Boolean(node.closest(`#${OVERLAY_HOST_ID}`));
  }

  function isOverlayMutation(mutation) {
    if (isOverlayNode(mutation.target)) {
      return true;
    }

    return [...mutation.addedNodes, ...mutation.removedNodes].every(isOverlayNode);
  }

  function extractAssignedJson(text, marker) {
    const markerIndex = text.indexOf(marker);

    if (markerIndex === -1) {
      return "";
    }

    const assignmentIndex = text.indexOf("=", markerIndex + marker.length);

    if (assignmentIndex === -1) {
      return "";
    }

    let startIndex = -1;

    for (let index = assignmentIndex + 1; index < text.length; index += 1) {
      if (text[index] === "{" || text[index] === "[") {
        startIndex = index;
        break;
      }

      if (!/\s/.test(text[index])) {
        return "";
      }
    }

    if (startIndex === -1) {
      return "";
    }

    const stack = [];
    let inString = false;
    let escaped = false;

    for (let index = startIndex; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }

        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }

      if (char === "}" || char === "]") {
        const opener = stack.pop();

        if ((char === "}" && opener !== "{") || (char === "]" && opener !== "[")) {
          return "";
        }

        if (stack.length === 0) {
          return text.slice(startIndex, index + 1);
        }
      }
    }

    return "";
  }

  // Naver's __PRELOADED_STATE__ is a JS object literal, not strict JSON: it can
  // contain bare `undefined`/`NaN`/`Infinity` values that JSON.parse rejects.
  // Replace those tokens (only when outside string literals) with null so the
  // whole payload still parses instead of being discarded.
  const NON_JSON_LITERALS = ["-Infinity", "undefined", "Infinity", "NaN"];

  function sanitizeJsonLiteral(text) {
    let result = "";
    let inString = false;
    let escaped = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        result += char;

        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }

        continue;
      }

      if (char === "\"") {
        inString = true;
        result += char;
        continue;
      }

      const literal = NON_JSON_LITERALS.find((candidate) => text.startsWith(candidate, index));

      if (literal) {
        result += "null";
        index += literal.length - 1;
        continue;
      }

      result += char;
    }

    return result;
  }

  function mergeRecords(records, sourceUrl) {
    let changed = false;

    for (const record of records) {
      const previous = productStocks.get(record.productId);

      if (
        !previous ||
        previous.stock !== record.stock ||
        previous.name !== record.name ||
        previous.sourceUrl !== sourceUrl
      ) {
        productStocks.set(record.productId, {
          ...record,
          sourceUrl,
          updatedAt: Date.now()
        });
        changed = true;
      }
    }

    return changed;
  }

  function readInlineProductState() {
    let changed = false;

    for (const script of document.scripts) {
      const text = script.textContent || "";

      if (!text.includes("__PRELOADED_STATE__")) {
        continue;
      }

      const jsonText = extractAssignedJson(text, "__PRELOADED_STATE__");

      if (!jsonText || seenInlineStateTexts.has(jsonText)) {
        continue;
      }

      seenInlineStateTexts.add(jsonText);

      try {
        changed =
          mergeRecords(
            extractStockRecords(JSON.parse(sanitizeJsonLiteral(jsonText))),
            "inline __PRELOADED_STATE__"
          ) ||
          changed;
      } catch (error) {
        // Ignore inline scripts that mention the marker but do not contain JSON state.
      }
    }

    if (changed) {
      scheduleRender();
    }
  }

  // Naver Shopping search (search.shopping.naver.com/ns/*) is a Next.js App
  // Router page. Its product list is streamed as React Server Component "flight"
  // data via many `self.__next_f.push([n, "<escaped chunk>"])` calls instead of a
  // single __PRELOADED_STATE__ assignment. Concatenating every pushed chunk
  // yields a stream of newline-separated `<hexId>:<json>` rows; the product cards
  // (channelProductId + stockQuantity) live inside one of those JSON rows.
  const NEXT_FLIGHT_PUSH = /self\.__next_f\.push\(\[\d+,"((?:[^"\\]|\\.)*)"\]\)/g;
  const FLIGHT_ROW_RELEVANT = /stock|inventory|remain|available|soldOut|channelProductId|productNo/i;
  const seenFlightRowTexts = new Set();

  function reconstructNextFlight() {
    const chunks = [];

    for (const script of document.scripts) {
      const text = script.textContent || "";

      if (!text.includes("__next_f")) {
        continue;
      }

      NEXT_FLIGHT_PUSH.lastIndex = 0;
      let match;

      while ((match = NEXT_FLIGHT_PUSH.exec(text)) !== null) {
        try {
          // The captured group is a JS string literal body; decode its escapes.
          chunks.push(JSON.parse(`"${match[1]}"`));
        } catch (error) {
          // Skip chunks whose escaped body is not a valid string literal.
        }
      }
    }

    return chunks.join("");
  }

  function readNextFlightState() {
    const flight = reconstructNextFlight();

    if (!flight) {
      return;
    }

    let changed = false;

    for (const row of flight.split("\n")) {
      const colonIndex = row.indexOf(":");

      if (colonIndex === -1) {
        continue;
      }

      const payload = row.slice(colonIndex + 1);
      const firstChar = payload[0];

      if (firstChar !== "{" && firstChar !== "[") {
        continue;
      }

      if (!FLIGHT_ROW_RELEVANT.test(payload) || seenFlightRowTexts.has(payload)) {
        continue;
      }

      seenFlightRowTexts.add(payload);

      try {
        changed =
          mergeRecords(
            extractStockRecords(JSON.parse(sanitizeJsonLiteral(payload))),
            "inline __next_f"
          ) || changed;
      } catch (error) {
        // A row can be incomplete while the flight is still streaming; drop it
        // from the seen set so a later read retries once more chunks arrive.
        seenFlightRowTexts.delete(payload);
      }
    }

    if (changed) {
      scheduleRender();
    }
  }

  function scheduleInlineStateRead() {
    if (inlineStateTimer !== null) {
      return;
    }

    inlineStateTimer = window.setTimeout(() => {
      inlineStateTimer = null;
      readInlineProductState();
      readNextFlightState();
    }, 80);
  }

  // SPA navigations fetch product/stock data over the network instead of
  // re-embedding it as an inline __PRELOADED_STATE__ script. inject.js (MAIN
  // world) forwards those JSON bodies here so they feed the same pipeline.
  const seenNetworkPayloads = new Set();

  function readNetworkPayload(text) {
    if (typeof text !== "string" || !text || seenNetworkPayloads.has(text)) {
      return;
    }

    seenNetworkPayloads.add(text);

    // Bound memory across a long SPA session.
    if (seenNetworkPayloads.size > 60) {
      seenNetworkPayloads.clear();
      seenNetworkPayloads.add(text);
    }

    let parsed;

    try {
      parsed = JSON.parse(sanitizeJsonLiteral(text));
    } catch (error) {
      return;
    }

    if (mergeRecords(extractStockRecords(parsed), "network")) {
      scheduleRender();
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data;

    if (!data || data.source !== "cnt-stock-net" || typeof data.payload !== "string") {
      return;
    }

    readNetworkPayload(data.payload);
  });

  function observeDomChanges() {
    const target = document.documentElement;

    if (!target) {
      return;
    }

    const observer = new MutationObserver((mutations) => {
      if (mutations.every(isOverlayMutation)) {
        return;
      }

      scheduleInlineStateRead();
      scheduleRender();
    });
    observer.observe(target, {
      childList: true,
      subtree: true
    });

    window.addEventListener("resize", scheduleRender, { passive: true });
  }

  function readEnabledSetting() {
    chrome.storage.local.get({ [STORAGE_ENABLED_KEY]: true }, (result) => {
      overlayEnabled = Boolean(result[STORAGE_ENABLED_KEY]);
      scheduleRender();
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_ENABLED_KEY]) {
      return;
    }

    overlayEnabled = Boolean(changes[STORAGE_ENABLED_KEY].newValue);
    scheduleRender();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "cnt-stock-get-state") {
      sendResponse({
        enabled: overlayEnabled,
        productCount: productStocks.size,
        matchedImageCount:
          document.getElementById(OVERLAY_HOST_ID)?.shadowRoot?.querySelectorAll(`.${OVERLAY_CLASS}`)
            .length || 0,
        pageUrl: location.href
      });
      return;
    }

    if (message?.type === "cnt-stock-refresh") {
      scheduleRender();
      sendResponse({
        ok: true,
        productCount: productStocks.size,
        matchedImageCount:
          document.getElementById(OVERLAY_HOST_ID)?.shadowRoot?.querySelectorAll(`.${OVERLAY_CLASS}`)
            .length || 0
      });
    }
  });

  readEnabledSetting();
  scheduleInlineStateRead();
  observeDomChanges();

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        scheduleInlineStateRead();
        scheduleRender();
      },
      { once: true }
    );
  } else {
    scheduleInlineStateRead();
    scheduleRender();
  }
})();
