# Naver Store Stock Overlay

네이버 스마트스토어/브랜드스토어 PLP의 초기 페이지 state에 포함된 재고 수량을 감지해 상품 이미지 위에 배지로 표시하는 Chrome Manifest V3 확장입니다.

## 로컬에서 실행

1. Chrome에서 `chrome://extensions`를 엽니다.
2. 오른쪽 위의 `Developer mode`를 켭니다.
3. `Load unpacked`를 누릅니다.
4. 이 폴더를 선택합니다: `/Users/leeteamin/Desktop/workspace/javascript/cnt_ext`
5. `https://smartstore.naver.com/...` 또는 `https://brand.naver.com/...` PLP 페이지를 새로고침합니다.

## 동작 방식

- `content.js`: 페이지 HTML 안의 `window.__PRELOADED_STATE__` inline JSON에서 상품번호와 재고 후보 필드를 추출하고 `/products/{id}` 링크의 이미지 위에 배지를 붙입니다.
- `popup.*`: 오버레이 켜기/끄기와 현재 감지 상태를 보여줍니다.

이 확장은 브라우저 요청 훅을 사용하지 않고, 페이지 HTML에 이미 포함된 초기 데이터만 읽습니다.

네이버 브랜드스토어 PLP는 최초 상품 리스트를 `window.__PRELOADED_STATE__`에 싣는 경우가 있습니다. 이 경우 `simpleProducts[].id`가 실제 `/products/{id}` 링크와 매칭되는 channel product id이고, `simpleProducts[].productNo`는 다른 내부 상품 번호라 링크 매칭에는 사용하지 않습니다.

오버레이 배지는 사이트 상품 DOM에 직접 붙이지 않고, 확장 전용 Shadow DOM 레이어에만 렌더링합니다. 이전 버전이 남긴 `cnt-stock-overlay` 요소와 `data-cnt-stock-overlay-container` 속성은 렌더링 전에 제거합니다.

배지는 문서 좌표 기준의 absolute 레이어에 배치해서 스크롤할 때 JS로 따라가는 지연이 생기지 않도록 합니다. 배지에 마우스를 올리면 해당 상품의 감지된 재고 정보와 원본 상품 객체 샘플을 JSON 팝오버로 표시합니다.

일부 PLP는 상품 이미지가 Swiper 캐러셀로 렌더링되어 같은 상품 링크가 `prev`/`active`/`next` 슬라이드에 반복됩니다. 이 확장은 inactive Swiper 슬라이드를 제외하고 상품 id별 최적 후보 하나만 선택해 중복 배지가 겹치지 않도록 합니다.

## 현재 매칭 규칙

- 지원 페이지: `smartstore.naver.com`, `brand.naver.com`
- 상품 링크: `/products/{id}`, `productNo=`, `channelProductNo=`
- 상품번호 후보: `channelProductNo`, `productNo`, `originProductNo`, `productId`, `nvMid` 등
- 재고 후보: `stockQuantity`, `availableStockQuantity`, `remainStockQuantity`, `inventoryQuantity`, `soldOut` 등
- `quantity`/`qty`는 `stock` 또는 `inventory` 계열 경로 안에 있을 때만 재고로 취급합니다.

네이버 페이지 state 스키마가 페이지/스토어마다 다를 수 있어서, 실제 PLP에서 감지되지 않으면 HTML에 포함된 초기 state의 상품번호/재고 필드명을 확인해 `content.js`의 후보 키를 보강하면 됩니다.
