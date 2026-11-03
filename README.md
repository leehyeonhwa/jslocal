# jslocal — 티베로(Tibero) 한글 인코딩 진단 도구

한글이 `????`, `二쇰Ц`, `íê¸`, `��` 처럼 깨질 때 **어디서** 깨졌는지 찾아내는 Node.js 도구 모음입니다.
의존성 없이 동작하는 진단 CLI, CP949(MSWIN949) 변환기, 깨짐 패턴 복구기, Tibero ODBC 연동 예제로 이루어져 있습니다.

```
node bin/tb-encoding-doctor.js              # 접속 없이 환경/인코딩 점검
node bin/tb-encoding-doctor.js --connect    # DB 에 붙어 한글 왕복(insert→select) 검증
node bin/tb-encoding-doctor.js --check "íê¸"  # 깨진 문자열의 깨짐 경로 추적 + 복구
```

이미 깨진 데이터를 되살리거나 MSWIN949 → UTF8 이관을 준비한다면 [docs/troubleshooting.md](docs/troubleshooting.md) 를 보세요.

---

## 1. 한글은 세 군데 중 하나에서 깨진다

값 하나가 화면에 뜨기까지 인코딩 변환은 최소 세 번 일어납니다. 셋 중 하나만 어긋나도 깨집니다.

```
 [애플리케이션/터미널]  ←→  [Tibero 클라이언트 라이브러리]  ←→  [Tibero 서버]
      Node = 항상 UTF-8         TB_NLS_LANG 의 캐릭터셋            NLS_CHARACTERSET
            (1)                          (2)                            (3)
```

| 지점 | 무엇으로 정해지나 | 어긋나면 생기는 일 |
|---|---|---|
| (1) 앱/터미널 | Node 문자열은 내부적으로 UTF-16, 출력은 UTF-8 고정. 터미널은 `LANG`/코드페이지 | **화면만** 깨진다. DB 값은 멀쩡할 수 있다 |
| (2) 클라이언트 | `TB_NLS_LANG` (예: `KOREAN_KOREA.UTF8`) | 진짜로 깨진 값이 **저장된다**. 가장 흔한 원인 |
| (3) 서버 | DB 생성 시 정한 `NLS_CHARACTERSET` | 저장 자체가 불가능한 문자가 `?` 로 바뀐다 |

**핵심 규칙: (2)는 (3)과 같은 값으로 맞춘다.** 서버가 `UTF8` 이면 `TB_NLS_LANG=KOREAN_KOREA.UTF8`,
서버가 `MSWIN949` 면 `KOREAN_KOREA.MSWIN949`. 이러면 클라이언트-서버 사이에 변환이 아예 일어나지 않습니다.

> 서로 다르게 두고도 정상 동작할 수는 있습니다(Tibero 가 변환해 줍니다). 다만 그 경우
> 앱이 실제로 만들어내는 바이트열까지 클라이언트 설정과 일치해야 하므로, 맞출 곳이 하나 더 늘어납니다.

---

## 2. 현재 설정 확인하기

### 서버(DB) 캐릭터셋

```sql
-- 아래 중 되는 것으로 확인 (버전에 따라 뷰 이름이 다릅니다)
SELECT PARAMETER, VALUE FROM NLS_DATABASE_PARAMETERS WHERE PARAMETER LIKE '%CHARACTERSET%';
SELECT NAME, VALUE FROM V$NLS_PARAMETERS;
```

`NLS_CHARACTERSET` 이 `CHAR`/`VARCHAR`/`CLOB` 의 캐릭터셋, `NLS_NCHAR_CHARACTERSET` 이 `NCHAR`/`NVARCHAR2` 용입니다.

> **DB 캐릭터셋은 데이터베이스를 만들 때 정해집니다.** 운영 중 바꾸는 건 사실상 재구축 + 데이터 이관입니다.
> 신규 구축이라면 고민 없이 `UTF8` 로 만드세요.

### 클라이언트 캐릭터셋

```bash
echo $TB_NLS_LANG        # 예: KOREAN_KOREA.UTF8
echo $LANG               # 예: ko_KR.UTF-8 (터미널 표시용)
```

```bash
# 셸에 설정 (보통 .bash_profile 에)
export TB_NLS_LANG=KOREAN_KOREA.UTF8

# Windows
set TB_NLS_LANG=KOREAN_KOREA.MSWIN949
chcp 949          # 콘솔 코드페이지도 맞춰야 화면이 안 깨진다 (UTF-8 은 chcp 65001)
```

### 한 번에 점검

```bash
node bin/tb-encoding-doctor.js --connect
```

```
| 4. DB 접속 및 한글 왕복 검증
[OK  ] 접속: DSN=TIBERO;UID=scott;PWD=***;
[OK  ] DB 캐릭터셋: UTF8
[WARN] 서버/클라이언트 조합: UTF8(서버) ↔ MSWIN949(클라이언트). ...
[OK  ] 왕복 #0: "한글 인코딩 테스트" (LENGTH=10, LENGTHB=26)
[FAIL] 왕복 #2 불일치: "똠방각하 펲시 쒜프" -> "?방각하 ?시 쒜프"
       -> 깨짐 경로 추정: ...
```

---

## 3. 증상별 원인 대응표

| 화면에 보이는 것 | 원인 | 조치 |
|---|---|---|
| `????` (물음표) | DB 캐릭터셋이 해당 문자를 표현 못 함. 이미 `?` 로 **저장됨** | DB 캐릭터셋 확인. MSWIN949 에 이모지/확장한자를 넣으려던 것이면 UTF8 로 가야 함 |
| `二쇰Ц 議고쉶` 같은 엉뚱한 한글 | UTF-8 바이트를 CP949 로 읽음 (또는 그 반대) | `TB_NLS_LANG` 을 DB 캐릭터셋과 일치시킴 |
| `íê¸`, `ì£¼ë¬¸` | UTF-8 바이트를 Latin-1 로 읽음. JDBC/웹 계층에서 흔함 | 커넥터·서블릿·파일 읽기의 인코딩 지정. `--check` 로 복구 가능 |
| `��` (U+FFFD) | 잘못된 바이트를 UTF-8 로 읽다 실패. **원본 소실** | 문자열로는 복구 불가. 올바른 설정으로 DB 에서 다시 읽어야 함 |
| DB 값은 맞는데 콘솔만 깨짐 | 터미널 인코딩 | `LANG=ko_KR.UTF-8`, Windows 는 `chcp` |
| `값이 너무 큽니다` / `too large for column` | UTF8 에서 한글 1자 = 3바이트 | `VARCHAR(n)` 을 3배로 늘리거나 `VARCHAR(n CHAR)` 사용 |
| 한글 정렬/`LIKE '김%'` 이상 | 캐릭터셋별 바이트 순서 차이 | `NLS_SORT`, 캐릭터셋 확인 |

깨진 문자열을 손에 들고 있다면 원인을 직접 추적할 수 있습니다.

```bash
$ node bin/tb-encoding-doctor.js --check "ì£¼ë¬¸ì´ ì •ìƒ ì ‘ìˆ˜ë˜ì—ˆìŠµë‹ˆë‹¤"
[WARN] 판정: 깨짐 (utf8-as-latin1)
[OK  ] 복구 결과: "주문이 정상 접수되었습니다"
```

---

## 4. 바이트 세만틱 — `VARCHAR(10)` 에 한글 5자가 안 들어가는 이유

Tibero 의 `VARCHAR(n)` 은 기본이 **바이트** 기준입니다.

| 캐릭터셋 | 한글 1자 | `VARCHAR(10)` 에 들어가는 한글 |
|---|---|---|
| UTF8 | 3바이트 | 3자 |
| MSWIN949 / EUCKR | 2바이트 | 5자 |

```bash
$ node examples/column-size.js 한글다섯글자 10
캐릭터셋   바이트  VARCHAR(10) 수용
UTF8          18   초과 8바이트
MSWIN949      12   초과 2바이트
```

- `LENGTH()` 는 문자 수, `LENGTHB()` 는 바이트 수를 돌려줍니다. 둘을 같이 조회하면 캐릭터셋을 역산할 수 있습니다.
- 문자 수 기준으로 잡고 싶으면 `VARCHAR2(10 CHAR)` 처럼 선언합니다(세션 기본값은 `NLS_LENGTH_SEMANTICS`).
- MSWIN949 → UTF8 이관 시 **컬럼 크기를 1.5배로 늘려야** 합니다. 안 늘리면 이관 중 `value too large` 가 납니다.
- 애플리케이션에서 미리 자를 때는 반드시 바이트 기준으로, 그리고 멀티바이트 문자를 반으로 쪼개지 않도록:
  `charset.truncateToBytes(value, 400, 'UTF8')`.

---

## 5. MSWIN949 로도 저장할 수 없는 문자

`MSWIN949`(CP949)는 17,048자를 담습니다. 현대 한글 11,172자는 전부 들어가지만, 그 밖은 못 담습니다.

| 문자 | UTF8 | MSWIN949 | EUCKR |
|---|---|---|---|
| `한글` | O | O | O |
| `똠`, `펲`, `믜` (확장 음절) | O | O | **X → `?`** |
| `🙂` 이모지 | O | **X → `?`** | X |
| 확장 한자(𠀋 등) | O | **X → `?`** | X |

- `EUCKR` 은 완성형 2,350자뿐이라 확장 음절이 유실됩니다. 레거시 DB 라면 최소한 `MSWIN949` 여야 합니다.
- 이모지를 받는 서비스라면 `UTF8` 외에는 선택지가 없습니다.

```js
import { charset } from './src/index.js';
charset.unstorableChars('리뷰 잘 봤어요 🙂', 'MSWIN949');
// [ { char: '🙂', codePoint: 'U+1F642', index: 10 } ]
```

---

## 6. Node.js 에서 Tibero 붙이기 (ODBC)

Node 용 Tibero 네이티브 드라이버는 없습니다. **unixODBC + Tibero ODBC 드라이버** 위에서 `odbc` 패키지를 씁니다.

```bash
# 1) unixODBC (Tibero ODBC 드라이버와 odbc 패키지 빌드에 모두 필요)
sudo apt-get install unixodbc unixodbc-dev     # RHEL: yum install unixODBC unixODBC-devel

# 2) Node 패키지
npm install odbc
```

`~/.odbcinst.ini`:

```ini
[Tibero]
Description = Tibero ODBC Driver
Driver      = /home/tibero/tibero6/client/lib/libtbodbc.so
```

`~/.odbc.ini`:

```ini
[TIBERO]
Driver   = Tibero
SID      = tibero
Server   = 127.0.0.1
Port     = 8629
User     = scott
Password = tiger
```

```bash
export TB_HOME=/home/tibero/tibero6
export LD_LIBRARY_PATH=$TB_HOME/client/lib:$LD_LIBRARY_PATH
export TB_NLS_LANG=KOREAN_KOREA.UTF8
export ODBCINI=$HOME/.odbc.ini

TB_DSN=TIBERO TB_USER=scott TB_PASSWORD=tiger node examples/roundtrip.js
```

`isql -v TIBERO scott tiger` 로 먼저 ODBC 계층이 붙는지 확인하면 문제 범위를 절반으로 줄일 수 있습니다.

### 코드에서 지킬 것 하나

**문자열은 SQL 에 이어붙이지 말고 바인드 변수로 넘깁니다.**

```js
// 좋음 - 값이 파라미터로 전달된다
await connection.query('INSERT INTO T (TXT) VALUES (?)', [name]);

// 나쁨 - SQL 문 전체가 클라이언트 캐릭터셋으로 변환되며, 깨짐과 SQL 인젝션에 모두 취약
await connection.query(`INSERT INTO T (TXT) VALUES ('${name}')`);
```

---

## 7. JDBC 를 쓰는 경우 (참고)

```
jdbc:tibero:thin:@호스트:8629:SID
```

- JVM 기본 인코딩이 아니라 **`TB_NLS_LANG` 과 DB 캐릭터셋**이 기준입니다. `-Dfile.encoding=UTF-8` 만으로는 부족합니다.
- `íê¸` 형태로 깨진다면 JDBC 가 아니라 그 위(서블릿 `request.setCharacterEncoding`, 파일 읽기, HTTP 헤더)를 먼저 보세요.
- 드라이버 jar 버전이 서버 버전과 맞는지 확인하세요(`tibero6-jdbc.jar` 등).

---

## 8. API

```js
import { cp949, charset, mojibake, tibero } from './src/index.js';
```

### `cp949` — MSWIN949 변환 (외부 의존성 없음)

Node 내장 `TextDecoder('euc-kr')` 는 ICU 의 EUC-KR 컨버터라 CP949 **확장 음절**(`똠`, `펲` 등 8,822자)을
디코딩하지 못합니다. 그래서 `src/data/cp949-table.js` 에 전체 매핑(17,048자)을 생성해 두고 직접 변환합니다.

| 함수 | 설명 |
|---|---|
| `encode(text, {onUnmappable, subset})` | 문자열 → CP949 `Buffer`. `subset: 'EUCKR'` 로 완성형 제한 |
| `decode(bytes)` | CP949 `Buffer` → 문자열 (해석 불가 바이트는 `�`) |
| `canEncode(text, subset)` / `unmappableChars(text, subset)` | 표현 가능 여부 / 불가 문자 목록 |
| `bytesOf(char, subset)` | 문자 하나의 바이트를 16진수로 (`'한'` → `'c7d1'`) |

### `charset` — 캐릭터셋 메타데이터와 길이 계산

| 함수 | 설명 |
|---|---|
| `byteLength(text, charset)` / `charLength(text)` | 바이트 수 / 문자 수 |
| `fitsColumn(text, size, {charset, semantics})` | `VARCHAR(size)` 수용 여부와 초과 바이트 |
| `truncateToBytes(text, maxBytes, charset)` | 문자를 쪼개지 않고 바이트 기준 자르기 |
| `unstorableChars(text, charset)` | 해당 캐릭터셋에서 유실될 문자 |
| `parseNlsLang('KOREAN_KOREA.MSWIN949')` | `{language, territory, charset}` |
| `diagnosePair(server, client)` | 서버/클라이언트 조합 진단 |

### `mojibake` — 깨짐 판별과 복구

| 함수 | 설명 |
|---|---|
| `analyze(text)` | 깨짐 여부, 추정 경로, 복구값, 후보 목록 |
| `repair(text)` | 복구 가능하면 복구본, 아니면 원본 |
| `looksBroken(text)` / `textScore(text)` | 깨짐 의심 / 정상도 점수 |
| `corrupt(text, pattern)` | 테스트용으로 일부러 깨뜨리기 |

변환을 3단계까지 조합해 탐색하므로 이중 인코딩도 복구합니다.
단, `�` (U+FFFD)가 박힌 문자열은 그 시점에 원본 바이트가 사라진 것이라 복구할 수 없습니다.

### `tibero` — 접속과 왕복 검증

| 함수 | 설명 |
|---|---|
| `loadConfig(env)` / `buildConnectionString(cfg)` | `TB_*` 환경변수 → 접속 문자열 |
| `maskConnectionString(s)` | 로그용 비밀번호 마스킹 |
| `connect(cfg)` | `odbc` 커넥션 (호출자가 `close()`) |
| `readServerNls(conn)` / `pickDatabaseCharset(params)` | 서버 NLS 조회 |
| `roundtrip(conn, {samples})` | 임시 테이블로 insert→select 왕복 검증 |

---

## 9. 예제

| 파일 | DB 필요 | 내용 |
|---|---|---|
| `examples/repair-broken-text.js` | X | 깨진 문자열 추적/복구 |
| `examples/column-size.js` | X | 캐릭터셋별 컬럼 크기 계산 |
| `examples/connect-odbc.js` | O | 접속 + 한글 왕복 최소 예제 |
| `examples/roundtrip.js` | O | 여러 유형의 한글 왕복 검증 |

## 10. 개발

```bash
npm test                                   # 단위 테스트 (DB 불필요, 가짜 Tibero 커넥션 포함)
npm run test:integration                   # 실제 Tibero 통합 테스트 (TB_* 미설정 시 skip)
python3 tools/gen-cp949-table.py > src/data/cp949-table.js   # 매핑 테이블 재생성
```

테스트 DB 계정 생성, ODBC 준비, CI 설정(`TB_TEST_REQUIRED=1`)은 [docs/testing.md](docs/testing.md) 를 보세요.

`src/data/cp949-table.js` 는 자동 생성 파일입니다. Python 의 `cp949` 코덱(= Microsoft codepage 949)을
기준으로 뽑았고, 17,048개 전 문자에 대해 양방향 일치를 테스트로 검증합니다.
