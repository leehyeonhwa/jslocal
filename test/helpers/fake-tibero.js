/**
 * 실제 Tibero 없이 src/tibero.js 를 테스트하기 위한 가짜 ODBC 커넥션.
 *
 * - `odbc` 패키지의 Connection 처럼 `query(sql, params)` / `close()` 를 제공한다.
 * - src/tibero.js 가 실제로 보내는 SQL 몇 가지만 해석한다(범용 SQL 엔진이 아니다).
 * - 서버 캐릭터셋(serverCharset)을 흉내 낸다:
 *     * 저장할 수 없는 문자는 '?' 로 바뀌어 저장된다 (Tibero 와 같은 동작)
 *     * VARCHAR(n) / VARCHAR(n CHAR) 크기를 넘으면 TBR-12899 오류를 던진다
 *     * LENGTH / LENGTHB 는 각각 문자 수 / 서버 캐릭터셋 바이트 수
 * - onRead 로 "읽는 순간 깨지는" 클라이언트 설정 불일치를 흉내 낼 수 있다.
 */
import * as charset from '../../src/charset.js';

const NLS_VIEWS = ['NLS_DATABASE_PARAMETERS', 'V$NLS_PARAMETERS', 'NLS_SESSION_PARAMETERS'];

/**
 * @param {{
 *   serverCharset?: string,
 *   ncharCharset?: string,
 *   nlsViews?: string[],               // 존재하는 딕셔너리 뷰 (버전별 차이 흉내)
 *   onRead?: (value: string) => string, // SELECT 결과에 적용할 변환 (깨짐 흉내)
 *   failOn?: RegExp,                    // 이 SQL 에 매칭되면 오류
 * }} [options]
 */
export function createFakeConnection(options = {}) {
  const {
    serverCharset = 'UTF8',
    ncharCharset = 'UTF16',
    nlsViews = ['NLS_DATABASE_PARAMETERS'],
    onRead = (v) => v,
    failOn = null,
  } = options;

  /** @type {Map<string, {size: number|null, semantics: 'BYTE'|'CHAR', rows: Map<number, string>}>} */
  const tables = new Map();
  const log = [];
  let closed = false;

  function tbrError(code, message) {
    const err = new Error(`[Tibero][${code}] ${message}`);
    err.code = code;
    return err;
  }

  function store(value) {
    const lost = new Set(charset.unstorableChars(value, serverCharset).map((c) => c.index));
    return [...value].map((ch, i) => (lost.has(i) ? '?' : ch)).join('');
  }

  async function query(sql, params = []) {
    if (closed) throw tbrError('TBR-02068', 'connection closed');
    const text = sql.trim().replace(/\s+/g, ' ');
    log.push({ sql: text, params });
    if (failOn && failOn.test(text)) throw tbrError('TBR-99999', `injected failure: ${text}`);

    let m;
    if (/^SELECT 1 AS ONE FROM DUAL$/i.test(text)) return [{ ONE: 1 }];

    if ((m = /^SELECT (\w+), VALUE FROM ([\w$]+)$/i.exec(text)) || (m = /^SELECT \* FROM ([\w$]+)$/i.exec(text))) {
      const view = (m[2] ?? m[1]).toUpperCase();
      const keyCol = m[2] ? m[1].toUpperCase() : 'NAME';
      if (!NLS_VIEWS.includes(view) || !nlsViews.includes(view)) {
        throw tbrError('TBR-08033', `Specified schema object was not found: ${view}`);
      }
      return [
        { [keyCol]: 'NLS_CHARACTERSET', VALUE: serverCharset },
        { [keyCol]: 'NLS_NCHAR_CHARACTERSET', VALUE: ncharCharset },
      ];
    }

    if ((m = /^CREATE TABLE (\w+) \(ID NUMBER, TXT VARCHAR2?\((\d+)( CHAR| BYTE)?\)\)$/i.exec(text))) {
      const name = m[1].toUpperCase();
      if (tables.has(name)) throw tbrError('TBR-07062', `name is already used: ${name}`);
      tables.set(name, {
        size: Number(m[2]),
        semantics: m[3]?.trim().toUpperCase() === 'CHAR' ? 'CHAR' : 'BYTE',
        rows: new Map(),
      });
      return [];
    }

    if ((m = /^DROP TABLE (\w+)$/i.exec(text))) {
      if (!tables.delete(m[1].toUpperCase())) throw tbrError('TBR-08033', `table not found: ${m[1]}`);
      return [];
    }

    if ((m = /^INSERT INTO (\w+) \(ID, TXT\) VALUES \(\?, \?\)$/i.exec(text))) {
      const table = tables.get(m[1].toUpperCase());
      if (!table) throw tbrError('TBR-08033', `table not found: ${m[1]}`);
      const [id, value] = params;
      const stored = store(String(value));
      const fit = charset.fitsColumn(stored, table.size, {
        charset: serverCharset,
        semantics: table.semantics,
      });
      if (!fit.ok) {
        throw tbrError('TBR-12899', `value too large for column (actual: ${fit.used}, maximum: ${table.size})`);
      }
      table.rows.set(Number(id), stored);
      return [];
    }

    if ((m = /^SELECT TXT, LENGTH\(TXT\) AS CHAR_LEN, LENGTHB\(TXT\) AS BYTE_LEN FROM (\w+) WHERE ID = \?$/i.exec(text))) {
      const table = tables.get(m[1].toUpperCase());
      if (!table) throw tbrError('TBR-08033', `table not found: ${m[1]}`);
      const value = table.rows.get(Number(params[0]));
      if (value === undefined) return [];
      return [
        {
          TXT: onRead(value),
          CHAR_LEN: charset.charLength(value),
          BYTE_LEN: charset.byteLength(value, serverCharset),
        },
      ];
    }

    throw new Error(`fake-tibero: 해석할 수 없는 SQL: ${text}`);
  }

  return {
    query,
    async close() {
      closed = true;
    },
    // 테스트에서 상태를 들여다보기 위한 필드
    log,
    tables,
    get closed() {
      return closed;
    },
  };
}
