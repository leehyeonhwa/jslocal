# 테스트 환경 세팅

테스트는 두 층으로 나뉩니다.

| 명령 | 대상 | DB 필요 | 내용 |
|---|---|---|---|
| `npm test` | `test/*.test.js` | X | CP949 테이블, 길이 계산, 깨짐 복구, **가짜 Tibero 커넥션**으로 `roundtrip`/`readServerNls` 검증 |
| `npm run test:integration` | `test/integration/*.test.js` | O | 실제 Tibero 에 ODBC 로 붙어 한글 왕복·바이트 세만틱 검증 |
| `npm run test:all` | 둘 다 | 선택 | 접속 정보가 없으면 통합 테스트는 skip |

---

## 1. 단위 테스트 (DB 없이)

```bash
npm test
```

`test/helpers/fake-tibero.js` 의 `createFakeConnection()` 이 `odbc` 커넥션을 흉내 냅니다.

```js
import { createFakeConnection } from './helpers/fake-tibero.js';

const conn = createFakeConnection({
  serverCharset: 'MSWIN949',          // 저장 불가 문자는 '?' 로, LENGTHB 는 2바이트 기준
  nlsViews: ['V$NLS_PARAMETERS'],      // 버전별로 존재하는 딕셔너리 뷰 흉내
  onRead: (v) => mojibake.corrupt(v, 'utf8-as-latin1'), // 읽을 때 깨지는 클라이언트 흉내
  failOn: /^SELECT TXT/,               // 특정 SQL 에서 오류 주입
});
```

- `VARCHAR(n)` 은 바이트, `VARCHAR(n CHAR)` 는 문자 기준으로 크기를 검사해 초과 시 `TBR-12899` 를 던집니다.
- `src/tibero.js` 가 보내는 SQL 만 해석합니다. 새 SQL 을 추가했다면 fake 에도 패턴을 추가하세요
  (해석 못 하는 SQL 은 즉시 에러가 나므로 빠뜨릴 수 없습니다).

---

## 2. 통합 테스트 (실제 Tibero)

### 2-1. 준비물

| 항목 | 확인 방법 |
|---|---|
| Tibero 서버 (테스트용 인스턴스 권장) | `tbsql sys/...` 접속 |
| Tibero 클라이언트 라이브러리 (`libtbodbc.so`) | `ls $TB_HOME/client/lib/libtbodbc.so` |
| unixODBC + 개발 헤더 | `odbcinst -j` |
| Node `odbc` 패키지 | `npm install odbc` |

ODBC 드라이버/DSN 등록과 환경변수(`TB_HOME`, `LD_LIBRARY_PATH`, `ODBCINI`)는 [README 6장](../README.md#6-nodejs-에서-tibero-붙이기-odbc) 과 같습니다.
**`isql -v TIBERO jslocal_test jslocal_test` 가 먼저 붙어야 합니다.**

### 2-2. 테스트 전용 계정

```bash
tbsql sys/<비밀번호>@tibero @test/integration/setup-test-user.sql
```

`CREATE SESSION`, `CREATE TABLE` 권한과 `USR` 테이블스페이스 쿼터를 줍니다.
테스트는 `TB_IT_<pid>_*` 테이블을 만들고 끝나면 지웁니다.

### 2-3. 실행

ODBC DSN 대신 tbdsn.tbr 별칭으로 붙어도 됩니다. 테스트 DB 별칭(예: `tibero_test`)을 tbdsn.tbr 에 추가하고:

```bash
export TB_DRIVER=$TB_HOME/client/lib/libtbodbc.so TB_ALIAS=tibero_test
```

```bash
cp .env.example .env      # TB_DSN(또는 TB_DRIVER+TB_ALIAS) / TB_USER / TB_PASSWORD / TB_NLS_LANG 수정
set -a; . ./.env; set +a
npm run test:integration
```

접속 정보가 없거나 `odbc` 를 로드할 수 없으면 전부 **skip** 됩니다(이유가 출력됨).
CI 처럼 반드시 돌아야 하는 곳에서는 `TB_TEST_REQUIRED=1` 을 주면 skip 대신 **실패**합니다.

### 2-4. 무엇을 검증하나

| 테스트 | 실패하면 |
|---|---|
| `SELECT 1 FROM DUAL` | 접속/ODBC 계층 문제. `isql` 부터 확인 |
| NLS 파라미터 조회 | 딕셔너리 뷰 권한 또는 버전 차이. `readServerNls` 후보 SQL 확인 |
| 서버/클라이언트 조합이 `error` 아님 | DB 가 ASCII 이거나 캐릭터셋 인식 불가 |
| 표현 가능한 샘플 왕복 + `LENGTH`/`LENGTHB` 일치 | **`TB_NLS_LANG` 불일치**. 실패 메시지의 깨진 값을 `npm run doctor -- --check "<값>"` 으로 추적 |
| 표현 불가 샘플은 보존되지 않음 | DB 캐릭터셋이 보고된 것과 다름 (예: EUCKR 이라는데 `똠` 이 저장됨) |
| `VARCHAR(10)` 바이트 세만틱 | `NLS_LENGTH_SEMANTICS=CHAR` 로 설정된 DB. 의도된 것이면 무시 가능 |

통합 테스트는 DB 캐릭터셋을 먼저 읽고 그에 맞는 기대값을 계산하므로, UTF8 / MSWIN949 / EUCKR 어느 DB 에서도
같은 테스트를 그대로 돌릴 수 있습니다.
