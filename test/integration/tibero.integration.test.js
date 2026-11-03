/**
 * 실제 Tibero 대상 통합 테스트.
 *
 *   npm run test:integration
 *
 * 접속 정보(TB_DSN 또는 TB_DRIVER/TB_HOST… 또는 TB_CONNECTION_STRING)가 없거나
 * `odbc` 패키지가 없으면 전부 skip 된다. CI 처럼 "반드시 돌아야 하는" 환경에서는
 * TB_TEST_REQUIRED=1 을 주면 skip 대신 실패한다.
 *
 * 테스트 계정에는 CREATE TABLE 권한이 필요하다(docs/testing.md 참고).
 * 만드는 테이블은 TB_IT_<pid>_* 이름이고 끝나면 DROP 한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as tibero from '../../src/tibero.js';
import * as charset from '../../src/charset.js';

const cfg = tibero.loadConfig();
const hasTarget = Boolean(cfg.dsn || cfg.driver || cfg.connectionString);
const required = process.env.TB_TEST_REQUIRED === '1';

let skipReason = null;
if (!hasTarget) {
  skipReason = 'TB_DSN / TB_DRIVER / TB_CONNECTION_STRING 미설정';
} else {
  try {
    await tibero.loadOdbc();
  } catch (err) {
    skipReason = err.message;
  }
}

if (skipReason && required) {
  test('통합 테스트 사전 조건', () => {
    assert.fail(`TB_TEST_REQUIRED=1 이지만 실행할 수 없습니다: ${skipReason}`);
  });
}

const tablePrefix = `TB_IT_${process.pid}`;

test('Tibero 통합 테스트', { skip: skipReason ?? false }, async (t) => {
  const connection = await tibero.connect(cfg);
  t.after(() => connection.close());
  t.diagnostic(`접속: ${tibero.maskConnectionString(tibero.buildConnectionString(cfg))}`);

  let dbCharset = null;

  await t.test('간단한 쿼리가 실행된다 (SELECT 1 FROM DUAL)', async () => {
    const rows = await connection.query('SELECT 1 AS ONE FROM DUAL');
    assert.equal(Number(rows[0].ONE), 1);
  });

  await t.test('서버 NLS 파라미터에서 DB 캐릭터셋을 읽는다', async () => {
    const nls = await tibero.readServerNls(connection);
    assert.equal(nls.available, true, (nls.errors ?? []).join('\n'));
    dbCharset = tibero.pickDatabaseCharset(nls.parameters);
    assert.ok(dbCharset, `NLS_CHARACTERSET 없음: ${JSON.stringify(nls.parameters)}`);
    assert.ok(charset.normalizeCharset(dbCharset), `이 도구가 모르는 캐릭터셋: ${dbCharset}`);
    t.diagnostic(`DB 캐릭터셋: ${dbCharset} / TB_NLS_LANG: ${cfg.nlsLang ?? '(미설정)'}`);
  });

  await t.test('서버/클라이언트 캐릭터셋 조합이 error 수준이 아니다', () => {
    const client = charset.parseNlsLang(cfg.nlsLang)?.charset ?? null;
    const verdict = charset.diagnosePair(dbCharset, client);
    t.diagnostic(`${verdict.level}: ${verdict.message}`);
    assert.notEqual(verdict.level, 'error', `${verdict.message} ${verdict.hint ?? ''}`);
  });

  await t.test('DB 캐릭터셋으로 표현 가능한 샘플은 그대로 왕복된다', async () => {
    const storable = tibero.DEFAULT_SAMPLES.filter(
      (s) => charset.unstorableChars(s, dbCharset).length === 0,
    );
    assert.ok(storable.length > 0);
    const rt = await tibero.roundtrip(connection, {
      samples: storable,
      tableName: `${tablePrefix}_RT`,
    });
    for (const r of rt.results) {
      assert.equal(r.error, null, `${JSON.stringify(r.original)}: ${r.error}`);
      assert.equal(r.bound, r.original, `깨짐: ${JSON.stringify(r.original)} -> ${JSON.stringify(r.bound)}`);
      assert.equal(Number(r.charLength), charset.charLength(r.original), `LENGTH: ${r.original}`);
      assert.equal(
        Number(r.byteLength),
        charset.byteLength(r.original, dbCharset),
        `LENGTHB 가 ${dbCharset} 기준과 다름: ${r.original}`,
      );
    }
  });

  await t.test('DB 캐릭터셋으로 표현 불가능한 샘플은 원본 그대로 돌아오지 않는다', async (st) => {
    const unstorable = tibero.DEFAULT_SAMPLES.filter(
      (s) => charset.unstorableChars(s, dbCharset).length > 0,
    );
    if (unstorable.length === 0) {
      st.skip(`${dbCharset} 는 모든 샘플을 저장할 수 있음`);
      return;
    }
    const rt = await tibero.roundtrip(connection, {
      samples: unstorable,
      tableName: `${tablePrefix}_LOSS`,
    });
    for (const r of rt.results) {
      st.diagnostic(`${JSON.stringify(r.original)} -> ${r.error ?? JSON.stringify(r.bound)}`);
      assert.equal(r.ok, false, `${dbCharset} 인데 ${JSON.stringify(r.original)} 가 보존됨`);
    }
  });

  await t.test('VARCHAR(10) 은 바이트 세만틱으로 동작한다', async () => {
    const samples = ['한글세', '한글다섯자'];
    const rt = await tibero.roundtrip(connection, {
      samples,
      tableName: `${tablePrefix}_SZ`,
      columnType: 'VARCHAR(10)',
    });
    for (const r of rt.results) {
      const fit = charset.fitsColumn(r.original, 10, { charset: dbCharset });
      if (fit.ok) {
        assert.equal(r.bound, r.original, `${r.original} (${fit.used}바이트) 은 들어가야 함`);
      } else {
        assert.ok(r.error, `${r.original} (${fit.used}바이트) 은 거부돼야 함. 받은 값: ${r.bound}`);
      }
    }
  });
});
