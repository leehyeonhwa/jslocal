/**
 * Tibero 연결 헬퍼 (ODBC 경유) + 한글 왕복 검증.
 *
 * Node 용 Tibero 네이티브 드라이버는 없으므로 unixODBC + Tibero ODBC 드라이버
 * (libtbodbc.so) 위에서 npm `odbc` 패키지를 쓴다. `odbc` 는 optionalDependency 라
 * 설치돼 있지 않으면 오프라인 점검만 동작한다.
 */

import * as tbdsn from './tbdsn.js';

/** 환경변수에서 접속 정보를 읽는다. */
export function loadConfig(env = process.env) {
  return {
    dsn: env.TB_DSN || null,
    alias: env.TB_ALIAS || null, // tbdsn.tbr 의 별칭 (tnsnames.ora 의 TNS 별칭과 같은 역할)
    tbdsnFile: tbdsn.findFile(env),
    driver: env.TB_DRIVER || null, // 예: '/home/tibero/tibero6/client/lib/libtbodbc.so'
    host: env.TB_HOST || null,
    port: env.TB_PORT || '8629',
    database: env.TB_DB || env.TB_SID || null,
    user: env.TB_USER || null,
    password: env.TB_PASSWORD || null,
    nlsLang: env.TB_NLS_LANG || env.NLS_LANG || null,
    connectionString: env.TB_CONNECTION_STRING || null,
  };
}

/** 접속 문자열을 만든다. 비밀번호는 포함되지만 로그에 찍지 말 것. */
export function buildConnectionString(cfg = loadConfig()) {
  if (cfg.connectionString) return cfg.connectionString;

  const parts = [];
  if (cfg.dsn) {
    parts.push(`DSN=${cfg.dsn}`);
  } else if (cfg.driver) {
    const target = cfg.alias && !cfg.host ? resolveAlias(cfg) : cfg;
    parts.push(`DRIVER=${cfg.driver}`);
    if (target.host) parts.push(`SERVER=${target.host}`);
    if (target.port) parts.push(`PORT=${target.port}`);
    if (target.database) parts.push(`DB=${target.database}`);
  } else {
    throw new Error(
      '접속 정보가 없습니다. TB_DSN 또는 TB_DRIVER + (TB_ALIAS 또는 TB_HOST/TB_PORT/TB_DB) 를 지정하세요.',
    );
  }
  if (cfg.user) parts.push(`UID=${cfg.user}`);
  if (cfg.password) parts.push(`PWD=${cfg.password}`);
  return `${parts.join(';')};`;
}

/**
 * tbdsn.tbr 별칭을 host/port/database 로 푼다.
 * 여러 INSTANCE(TAC) 가 있으면 첫 번째를 쓴다. ODBC 접속 문자열에는 failover 목록을
 * 담을 수 없으므로, 이중화가 필요하면 odbc.ini DSN 쪽에서 구성해야 한다.
 * @param {{alias: string, tbdsnFile?: string|null, tbdsn?: object}} cfg
 *   tbdsn 에 parse 결과를 직접 넣으면 파일을 읽지 않는다(테스트용).
 */
export function resolveAlias(cfg) {
  let aliases = cfg.tbdsn;
  if (!aliases) {
    if (!cfg.tbdsnFile) {
      throw new Error(
        `TB_ALIAS=${cfg.alias} 를 풀 tbdsn.tbr 을 찾지 못했습니다. ` +
          'TB_HOME 을 설정하거나($TB_HOME/client/config/tbdsn.tbr) TB_TBDSN_FILE 로 경로를 지정하세요.',
      );
    }
    aliases = tbdsn.readFile(cfg.tbdsnFile);
  }
  const entry = tbdsn.resolve(aliases, cfg.alias);
  if (!entry) {
    throw new Error(
      `tbdsn.tbr${cfg.tbdsnFile ? `(${cfg.tbdsnFile})` : ''} 에 별칭 '${cfg.alias}' 가 없습니다. ` +
        `정의된 별칭: ${Object.values(aliases).map((a) => a.name).join(', ') || '(없음)'}`,
    );
  }
  const first = entry.instances[0];
  if (!first?.host) throw new Error(`별칭 '${cfg.alias}' 에 INSTANCE(HOST=...) 가 없습니다.`);
  return {
    host: first.host,
    port: first.port ?? '8629',
    database: first.dbName,
    instances: entry.instances.length,
  };
}

/** 로그/출력용 마스킹된 접속 문자열. */
export function maskConnectionString(connectionString) {
  return String(connectionString).replace(/(PWD|PASSWORD)=[^;]*/gi, '$1=***');
}

/** odbc 모듈을 동적으로 로드한다. */
export async function loadOdbc() {
  try {
    return await import('odbc');
  } catch (err) {
    throw new Error(
      "`odbc` 패키지가 없습니다. `npm install odbc` 후 다시 실행하세요. " +
        '(unixODBC 개발 패키지와 Tibero ODBC 드라이버가 먼저 설치돼 있어야 합니다.)',
      { cause: err },
    );
  }
}

/** 커넥션 생성. 호출자가 close() 해야 한다. */
export async function connect(cfg = loadConfig()) {
  const odbc = await loadOdbc();
  const connectionString = buildConnectionString(cfg);
  return odbc.default?.connect
    ? odbc.default.connect(connectionString)
    : odbc.connect(connectionString);
}

async function tryQueries(connection, queries) {
  const errors = [];
  for (const sql of queries) {
    try {
      const rows = await connection.query(sql);
      return { sql, rows };
    } catch (err) {
      errors.push(`${sql} -> ${err.message}`);
    }
  }
  return { sql: null, rows: null, errors };
}

/**
 * 서버의 캐릭터셋/NLS 설정을 읽는다.
 * 딕셔너리 뷰 이름은 Tibero 버전에 따라 다르므로 후보를 순서대로 시도한다.
 */
export async function readServerNls(connection) {
  const result = await tryQueries(connection, [
    "SELECT PARAMETER, VALUE FROM NLS_DATABASE_PARAMETERS",
    "SELECT NAME, VALUE FROM V$NLS_PARAMETERS",
    "SELECT PARAMETER, VALUE FROM NLS_SESSION_PARAMETERS",
    "SELECT * FROM V$NLS_PARAMETERS",
  ]);
  if (!result.rows) return { available: false, errors: result.errors, parameters: {} };

  const parameters = {};
  for (const row of result.rows) {
    const keys = Object.keys(row);
    const key = row.PARAMETER ?? row.NAME ?? row[keys[0]];
    const value = row.VALUE ?? row[keys[1]];
    if (key != null) parameters[String(key).toUpperCase()] = value == null ? null : String(value);
  }
  return { available: true, sql: result.sql, parameters };
}

/** 서버가 보고하는 DB 캐릭터셋 이름. 못 찾으면 null. */
export function pickDatabaseCharset(parameters = {}) {
  return (
    parameters.NLS_CHARACTERSET ??
    parameters.NLS_CHARACTER_SET ??
    parameters.CHARACTERSET ??
    null
  );
}

export const DEFAULT_SAMPLES = [
  '한글 인코딩 테스트',
  '가나다라마바사 ABC 123',
  '똠방각하 펲시 쒜프', // EUCKR(완성형 2350자) 에서 깨지는 확장 음절
  '①②③ ㈜ ℡ ± × ÷',   // MSWIN949 에는 있으나 자주 말썽인 특수문자
  '이모지 🙂 와 한자 漢字',  // 이모지는 MSWIN949 저장 불가
];

/**
 * 임시 테이블을 만들어 한글을 넣고 다시 읽어 비교한다.
 * @param {*} connection
 * @param {{samples?: string[], tableName?: string, columnType?: string, keepTable?: boolean}} [options]
 */
export async function roundtrip(connection, options = {}) {
  const {
    samples = DEFAULT_SAMPLES,
    tableName = `TB_ENC_CHK_${process.pid}`,
    columnType = 'VARCHAR(400)',
    keepTable = false,
  } = options;

  const results = [];
  let created = false;
  try {
    await connection.query(`CREATE TABLE ${tableName} (ID NUMBER, TXT ${columnType})`);
    created = true;

    for (let i = 0; i < samples.length; i += 1) {
      const original = samples[i];
      const entry = { index: i, original, bound: null, ok: false, error: null };
      try {
        await connection.query(`INSERT INTO ${tableName} (ID, TXT) VALUES (?, ?)`, [i, original]);
        const rows = await connection.query(
          `SELECT TXT, LENGTH(TXT) AS CHAR_LEN, LENGTHB(TXT) AS BYTE_LEN FROM ${tableName} WHERE ID = ?`,
          [i],
        );
        const row = rows[0] ?? {};
        entry.bound = row.TXT ?? null;
        entry.charLength = row.CHAR_LEN ?? null;
        entry.byteLength = row.BYTE_LEN ?? null;
        entry.ok = entry.bound === original;
      } catch (err) {
        entry.error = err.message;
      }
      results.push(entry);
    }
  } finally {
    if (created && !keepTable) {
      try {
        await connection.query(`DROP TABLE ${tableName}`);
      } catch {
        /* 정리 실패는 무시 */
      }
    }
  }
  return { tableName, results, passed: results.every((r) => r.ok) };
}
