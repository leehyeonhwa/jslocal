# 티베로 한글 인코딩 문제 해결 상세

README 가 "무엇을 맞춰야 하는가"라면, 이 문서는 "이미 문제가 생겼을 때 무엇을 하는가"입니다.

---

## 0. 먼저 문제를 좁힌다

깨짐 조사는 **어느 계층까지 값이 멀쩡한지**를 이분 탐색하는 일입니다. 위에서부터 순서대로 확인하세요.

```
1. DB 에 저장된 바이트가 이미 깨졌나?      -> LENGTH()/LENGTHB() 로 확인 (아래 1번)
2. 클라이언트가 읽으면서 깨뜨렸나?          -> TB_NLS_LANG 바꿔가며 같은 행을 재조회
3. 애플리케이션 계층에서 깨뜨렸나?          -> 값을 그대로 파일에 써서 hexdump
4. 화면에만 깨져 보이나?                   -> 같은 값을 JSON.stringify / hex 로 출력
```

Node 라면 4번을 이렇게 확인합니다. 화면과 무관하게 실제 코드포인트를 보여줍니다.

```js
console.log([...value].map((c) => c.codePointAt(0).toString(16)).join(' '));
```

---

## 1. DB 안의 값이 이미 깨졌는지 확인

```sql
-- 바이트 수가 기대와 다르면 저장 시점에 이미 변환 사고가 났다는 뜻이다.
SELECT NAME, LENGTH(NAME) AS 문자수, LENGTHB(NAME) AS 바이트수 FROM 고객 WHERE ID = 1;
```

- UTF8 DB: 한글 1자 = 3바이트. `문자수*3 = 바이트수` 면 정상적인 한글.
- MSWIN949 DB: 한글 1자 = 2바이트.
- 바이트수가 문자수와 같다면 → ASCII 로 저장됐다는 뜻. `?` 로 뭉개졌을 가능성이 큽니다.

`?` 로 이미 바뀐 값은 **원본이 사라진 것**이라 복구할 수 없습니다. 원천(파일/타 시스템)에서 다시 적재해야 합니다.

```sql
-- 물음표로 뭉개진 행 찾기
SELECT ID, NAME FROM 고객 WHERE NAME LIKE '%?%';
```

---

## 2. 클라이언트 설정만 바꿔 같은 행을 다시 읽어 본다

DB 바이트는 멀쩡한데 클라이언트가 잘못 읽는 경우가 가장 흔합니다. **DB 를 건드리기 전에** 이걸 먼저 하세요.

```bash
TB_NLS_LANG=KOREAN_KOREA.UTF8     node examples/connect-odbc.js
TB_NLS_LANG=KOREAN_KOREA.MSWIN949 node examples/connect-odbc.js
```

둘 중 하나에서 값이 정상으로 나오면, 그 설정이 DB 캐릭터셋과 맞는 설정입니다.
데이터는 무사하니 애플리케이션 환경변수만 고치면 끝입니다.

---

## 3. 깨진 문자열을 손에 들고 있을 때

```bash
node bin/tb-encoding-doctor.js --check "깨진문자열"
```

판정 결과에 따른 대응:

| 판정 | 의미 | 대응 |
|---|---|---|
| `utf8-as-latin1` | UTF-8 바이트를 Latin-1 로 읽음 | 복구 가능. 웹/파일 계층 인코딩 설정을 고칠 것 |
| `utf8-as-cp949` | UTF-8 바이트를 CP949 로 읽음 | 복구 가능한 경우도 있으나, 보통 U+FFFD 가 섞여 일부 손실 |
| `... + ...` (조합) | 두 번 이상 잘못 변환됨 | 복구 가능. 단 파이프라인에 잘못된 지점이 둘 이상이라는 뜻 |
| `lossy (U+FFFD 포함)` | 읽는 시점에 이미 바이트가 버려짐 | 문자열로는 복구 불가. **올바른 설정으로 DB 에서 다시 읽어야 함** |

프로그램에서 일괄 복구:

```js
import { mojibake } from './src/index.js';

const fixed = rows.map((r) => ({ ...r, NAME: mojibake.repair(r.NAME) }));
```

> 복구는 **읽기 경로가 깨진 경우**의 임시방편입니다. 근본 대책은 `TB_NLS_LANG` 을 맞추는 것입니다.
> 복구본을 그대로 DB 에 UPDATE 하기 전에, 저장 경로가 고쳐졌는지부터 확인하세요. 안 고치면 다시 깨집니다.

---

## 4. MSWIN949 → UTF8 이관

레거시 Tibero(또는 Oracle) DB 를 UTF8 로 옮길 때 반드시 걸리는 두 가지입니다.

### (1) 컬럼 크기

한글이 2바이트에서 3바이트가 되므로 **바이트 세만틱 컬럼은 1.5배**가 필요합니다.

```sql
-- 이관 전에 실제로 넘치는 컬럼부터 찾는다
SELECT MAX(LENGTHB(NAME)) AS 현재최대, MAX(LENGTH(NAME)) * 3 AS UTF8예상최대 FROM 고객;
```

```sql
ALTER TABLE 고객 MODIFY (NAME VARCHAR(300));      -- 100 -> 300
-- 또는 아예 문자 세만틱으로
ALTER TABLE 고객 MODIFY (NAME VARCHAR2(100 CHAR));
```

애플리케이션에서 미리 자르는 코드가 있다면 거기도 같이 고쳐야 합니다.

```js
import { charset } from './src/index.js';
const safe = charset.truncateToBytes(name, 300, 'UTF8'); // 문자를 반으로 쪼개지 않는다
```

### (2) 이관 전 사전 점검

MSWIN949 → UTF8 은 문자 유실이 없습니다(CP949 ⊂ 유니코드). 반대 방향(UTF8 → MSWIN949)이 위험합니다.

```js
import { charset } from './src/index.js';

for (const row of rows) {
  const lost = charset.unstorableChars(row.CONTENT, 'MSWIN949');
  if (lost.length) console.log(row.ID, '유실 예정:', lost.map((c) => c.char).join(''));
}
```

이모지가 섞인 사용자 입력(리뷰, 댓글, 채팅)은 거의 반드시 걸립니다.

---

## 5. 파일 입출력 (덤프, CSV, 로그)

DB 는 멀쩡한데 파일로 뽑으면 깨지는 경우입니다. 파일에는 인코딩 정보가 없으므로 **양쪽이 약속**해야 합니다.

```bash
file -i data.csv          # 대략적인 인코딩 추정
iconv -f CP949 -t UTF-8 data.csv > data.utf8.csv
iconv -f UTF-8 -t CP949//TRANSLIT data.csv > data.cp949.csv   # 표현 불가 문자는 근사 변환
```

Node 에서 CP949 파일을 읽고 쓸 때는 이 저장소의 변환기를 그대로 쓸 수 있습니다.

```js
import fs from 'node:fs';
import { cp949 } from './src/index.js';

const text = cp949.decode(fs.readFileSync('legacy.csv'));            // CP949 -> 문자열
fs.writeFileSync('out.csv', cp949.encode(text, { onUnmappable: 'replace' })); // 문자열 -> CP949
```

엑셀에서 CSV 를 열 때 한글이 깨진다면 파일이 UTF-8 인데 엑셀이 CP949 로 읽는 것입니다.
UTF-8 BOM(`EF BB BF`)을 앞에 붙이면 대개 해결됩니다.

---

## 6. tbsql / 콘솔에서만 깨질 때

```bash
export TB_NLS_LANG=KOREAN_KOREA.UTF8
export LANG=ko_KR.UTF-8
tbsql sys/tibero
```

- **PuTTY / 터미널**: Window → Translation 의 문자셋을 `UTF-8` 로. `LANG` 과 반드시 같아야 합니다.
- **Windows cmd**: `chcp 949`(CP949) 또는 `chcp 65001`(UTF-8). `TB_NLS_LANG` 과 맞춥니다.
- 콘솔에서만 깨지고 애플리케이션에서는 정상이라면 **데이터는 무사합니다.** DB 를 고치지 마세요.

---

## 7. 정렬과 비교

캐릭터셋이 다르면 한글의 바이트 순서가 달라 `ORDER BY` 결과가 달라질 수 있습니다.

- UTF8/MSWIN949 모두 현대 한글은 가나다 순으로 정렬됩니다(코드포인트 순 = 가나다 순).
- 옛한글·한자·기호가 섞이면 순서가 달라집니다. 필요하면 `NLS_SORT` 를 확인하세요.
- `LIKE '김%'` 이 안 맞는다면 값 자체가 이미 깨졌을 가능성이 큽니다. 1번부터 다시 확인하세요.

---

## 8. 체크리스트

이관/구축 시 이 순서로 확인하면 대부분 예방됩니다.

- [ ] DB `NLS_CHARACTERSET` 확인 — 신규면 `UTF8`
- [ ] 모든 클라이언트(WAS, 배치, 개발 PC)의 `TB_NLS_LANG` 을 DB 와 동일하게
- [ ] 컬럼 크기를 바이트 기준으로 산정 (`한글 1자 = 3바이트`) 또는 `CHAR` 세만틱 사용
- [ ] 문자열은 SQL 이어붙이기 대신 바인드 변수로
- [ ] 이모지/확장 음절이 들어올 수 있는 컬럼인지 검토
- [ ] 배포 전 `node bin/tb-encoding-doctor.js --connect` 로 왕복 검증
