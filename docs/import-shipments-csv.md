CSV로 과거 출고 데이터 가져오기

개요
- 운영 지표(출고 흐름 & 상위 실적)의 MoM/YoY 계산은 월별 SHIP 이벤트가 있어야 작동합니다.
- 간단한 CSV 업로더 함수를 추가해 과거 출고 데이터를 로컬(in‑memory)로 주입할 수 있습니다.

CSV 템플릿
- 파일: `public/templates/shipments_template.csv` (브라우저 경로: `/templates/shipments_template.csv`)
- 기본 헤더(샘플 파일과 동일): `발생일시, 거래처명, SKU(품번), 품명, 카테고리, 출고량`
- 열 이름 인식 규칙(대소문자 무관, 공백/괄호 무시):
  - 발생일시 → `발생일시`, `occurredAt` 중 하나
  - 거래처명 → `거래처명`, `partnerName` 중 하나 (`partnerId` 열을 추가하면 우선 적용)
  - SKU(품번) → `SKU(품번)`, `sku`, `품번` 등
  - 품명 → `품명`, `상품명`, `productName`
  - 카테고리 → `카테고리`, `category`
  - 출고량 → `출고량`, `출고수량`, `quantity`
- `partnerId`, `warehouseCode`, `locationCode` 열은 필요할 때만 추가하면 됩니다.

사용법
1) CSV 열기 및 수정: `public/templates/shipments_template.csv`에서 필요한 행을 추가합니다.
2) 앱 코드에서 함수 호출:

```ts
import { importShipmentsFromCsv } from '@/src/services/orders';

const csv = await fetch('/templates/shipments_template.csv').then(r => r.text());
const result = await importShipmentsFromCsv(csv);
console.log(result); // { addedOrders, addedLines, errors: [] }
```

동작 방식
- CSV 각 행을 `occurredAt`의 KST 날짜 + 거래처로 묶어 1개의 SalesOrder로 생성합니다.
- 묶음마다 1개의 `SHIP` 이벤트가 생성되고, SKU별 출고량이 합산됩니다.
- `partnerId`가 없고 `partnerName`만 있으면 샘플 고객 목록에서 이름으로 매칭합니다. 둘 다 없으면 임의 고객으로 지정됩니다.
- `category` 값은 바로 대시보드(카테고리 Top5, Worst5 필터)에 반영됩니다. 비어 있으면 `기타`로 처리됩니다.
- `품명`을 채우면 운영 지표의 이달 Top5/Worst5 SKU 표의 레이블 후보로 사용됩니다. 동일 SKU에 서로 다른 `품명`이 섞여 있는 경우, 카탈로그의 제품명(있다면)을 우선 표시하고, 없는 경우 해당 월에 가장 많이 등장한 명칭을 표시합니다.

제한 사항
- 간단 CSV 파서이므로 값에 콤마(,)나 인용부호가 포함된 고급 CSV는 지원하지 않습니다.
- 데이터는 메모리에만 저장됩니다(개발/데모 용도). 새로고침 시 사라집니다.
- 창고/로케이션 필터가 필요한 경우에는 `warehouseCode`, `locationCode` 열을 수동으로 추가해도 되며, 업로더가 자동으로 인식합니다(선택 사항).

팁
- MoM이 보이려면 전월 데이터, YoY까지 보려면 전년 동월 데이터도 함께 넣으세요.
