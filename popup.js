const STORAGE_ENABLED_KEY = "cntStockOverlayEnabled";
const SUPPORTED_HOSTS = ["smartstore.naver.com", "brand.naver.com"];

const tabTitle = document.querySelector("#tab-title");
const statusText = document.querySelector("#status");
const toggleButton = document.querySelector("#toggle-button");
const productCount = document.querySelector("#product-count");
const badgeCount = document.querySelector("#badge-count");

let currentTab = null;
let overlayEnabled = true;

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isSupportedUrl(url) {
  try {
    const { hostname } = new URL(url);
    return SUPPORTED_HOSTS.includes(hostname);
  } catch (error) {
    return false;
  }
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      resolve(response);
    });
  });
}

function setToggleState(enabled) {
  overlayEnabled = enabled;
  toggleButton.textContent = enabled ? "오버레이 끄기" : "오버레이 켜기";
  toggleButton.setAttribute("aria-pressed", String(enabled));
}

function renderStats(state) {
  productCount.textContent = String(state?.productCount ?? 0);
  badgeCount.textContent = String(state?.matchedImageCount ?? 0);
}

async function refreshState() {
  currentTab = await getCurrentTab();
  tabTitle.textContent = currentTab?.title || currentTab?.url || "현재 탭 정보를 읽을 수 없습니다.";

  const supported = isSupportedUrl(currentTab?.url || "");
  toggleButton.disabled = !supported;

  const stored = await chrome.storage.local.get({ [STORAGE_ENABLED_KEY]: true });
  setToggleState(Boolean(stored[STORAGE_ENABLED_KEY]));

  if (!supported) {
    renderStats(null);
    statusText.textContent = "네이버 스마트스토어 또는 브랜드스토어 페이지에서 동작합니다.";
    return;
  }

  const state = await sendTabMessage(currentTab.id, { type: "cnt-stock-get-state" });
  renderStats(state);
  statusText.textContent = state
    ? "페이지 초기 데이터에서 재고 필드를 감지하면 상품 이미지에 배지를 표시합니다."
    : "페이지를 새로고침하면 확장이 자동으로 연결됩니다.";
}

async function toggleOverlay() {
  if (!currentTab?.id || toggleButton.disabled) {
    return;
  }

  const nextEnabled = !overlayEnabled;
  await chrome.storage.local.set({ [STORAGE_ENABLED_KEY]: nextEnabled });
  setToggleState(nextEnabled);
  await sendTabMessage(currentTab.id, { type: "cnt-stock-refresh" });
  await refreshState();
}

toggleButton.addEventListener("click", toggleOverlay);
refreshState().catch((error) => {
  tabTitle.textContent = "현재 탭 정보를 읽을 수 없습니다.";
  statusText.textContent = error.message;
});
