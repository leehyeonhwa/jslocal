/**
 * 가짜 Tibero 커넥션으로 readServerNls / roundtrip 의 동작을 검증한다.
 * 실제 DB 가 필요 없으므로 `npm test` 에 포함된다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as tibero from '../src/tibero.js';
import * as mojibake from '../src/mojibake.js';
import { createFakeConnection } from './helpers/fake-tibero.js';

test('readServerNls: 첫 번째 뷰로 캐릭터셋을 읽는다', async () => {
  const conn = createFakeConnection({ serverCharset: 'MSWIN949' });
  const nls = await tibero.readServerNls(conn);
  assert.equal(nls.available, true);
  assert.equal(nls.sql, 'SELECT PARAMETER, VALUE FROM NLS_DATABASE_PARAMETERS');
  assert.equal(tibero.pickDatabaseCharset(nls.parameters), 'MSWIN949');
  assert.equal(nls.parameters.NLS_NCHAR_CHARACTERSET, 'UTF16');
});

test('readServerNls: 뷰가 없으면 다음 후보(V$NLS_PARAMETERS)로 넘어간다', async () => {
  const conn = createFakeConnection({ nlsViews: ['V$NLS_PARAMETERS'] });
  const nls = await tibero.readServerNls(conn);
  assert.equal(nls.available, true);
  assert.equal(nls.sql, 'SELECT NAME, VALUE FROM V$NLS_PARAMETERS');
  assert.equal(tibero.pickDatabaseCharset(nls.parameters), 'UTF8');
});

test('readServerNls: 모든 후보가 실패하면 오류 목록을 돌려준다', async () => {
  const conn = createFakeConnection({ nlsViews: [] });
  const nls = await tibero.readServerNls(conn);
  assert.equal(nls.available, false);
  assert.equal(nls.errors.length, 4);
  assert.deepEqual(nls.parameters, {});
});

test('roundtrip: UTF8 서버는 기본 샘플을 전부 통과하고 LENGTHB 는 UTF8 바이트 수', async () => {
  const conn = createFakeConnection({ serverCharset: 'UTF8' });
  const rt = await tibero.roundtrip(conn);
  assert.equal(rt.passed, true, JSON.stringify(rt.results, null, 2));
  const first = rt.results[0];
  assert.equal(first.original, '한글 인코딩 테스트');
  assert.equal(first.charLength, 10);
  assert.equal(first.byteLength, 26);
  assert.equal(conn.tables.size, 0, '임시 테이블은 정리돼야 한다');
});

test('roundtrip: MSWIN949 서버는 이모지/확장 한자만 ? 로 바뀐다', async () => {
  const conn = createFakeConnection({ serverCharset: 'MSWIN949' });
  const rt = await tibero.roundtrip(conn);
  assert.equal(rt.passed, false);
  const failed = rt.results.filter((r) => !r.ok);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].original, '이모지 🙂 와 한자 漢字');
  assert.equal(failed[0].bound, '이모지 ? 와 한자 漢字');
  // 확장 음절은 MSWIN949 에서는 살아남는다
  assert.ok(rt.results.find((r) => r.original.includes('똠')).ok);
});

test('roundtrip: EUCKR 서버는 확장 음절(똠, 펲)도 유실된다', async () => {
  const conn = createFakeConnection({ serverCharset: 'EUCKR' });
  const rt = await tibero.roundtrip(conn);
  const ext = rt.results.find((r) => r.original.includes('똠'));
  assert.equal(ext.ok, false);
  assert.equal(ext.bound, '?방각하 ?시 쒜프'); // 쒜 는 완성형 2350자에 있다
});

test('roundtrip: VARCHAR(10) 바이트 세만틱 - UTF8 은 한글 4자부터 TBR-12899', async () => {
  const samples = ['한글세', '한글네자'];
  const utf8 = await tibero.roundtrip(createFakeConnection({ serverCharset: 'UTF8' }), {
    samples,
    columnType: 'VARCHAR(10)',
  });
  assert.equal(utf8.results[0].ok, true); // 9바이트
  assert.match(utf8.results[1].error, /TBR-12899/); // 12바이트

  const ms949 = await tibero.roundtrip(createFakeConnection({ serverCharset: 'MSWIN949' }), {
    samples,
    columnType: 'VARCHAR(10)',
  });
  assert.equal(ms949.passed, true); // 6, 8바이트

  const charSem = await tibero.roundtrip(createFakeConnection({ serverCharset: 'UTF8' }), {
    samples,
    columnType: 'VARCHAR(10 CHAR)',
  });
  assert.equal(charSem.passed, true);
});

test('roundtrip: 읽을 때 깨지면(클라이언트 설정 불일치) 불일치로 잡히고 복구 경로가 추정된다', async () => {
  const conn = createFakeConnection({
    onRead: (v) => mojibake.corrupt(v, 'utf8-as-latin1'),
  });
  const rt = await tibero.roundtrip(conn, { samples: ['주문이 정상 접수되었습니다'] });
  const r = rt.results[0];
  assert.equal(r.ok, false);
  assert.notEqual(r.bound, r.original);
  assert.equal(mojibake.repair(r.bound), r.original);
});

test('roundtrip: 값은 바인드 변수로 전달된다 (SQL 문자열에 한글이 들어가지 않는다)', async () => {
  const conn = createFakeConnection();
  await tibero.roundtrip(conn, { samples: ["따옴표' 포함"] });
  const inserts = conn.log.filter((e) => e.sql.startsWith('INSERT'));
  assert.equal(inserts.length, 1);
  assert.ok(!/[가-힣]/.test(inserts[0].sql));
  assert.deepEqual(inserts[0].params, [0, "따옴표' 포함"]);
});

test('roundtrip: 중간 오류가 나도 임시 테이블은 DROP 된다', async () => {
  const conn = createFakeConnection({ failOn: /^SELECT TXT/ });
  const rt = await tibero.roundtrip(conn, { samples: ['가', '나'] });
  assert.equal(rt.passed, false);
  assert.ok(rt.results.every((r) => /injected failure/.test(r.error)));
  assert.equal(conn.tables.size, 0);
  assert.ok(conn.log.some((e) => e.sql.startsWith('DROP TABLE')));
});

test('roundtrip: keepTable 이면 테이블을 남긴다', async () => {
  const conn = createFakeConnection();
  const rt = await tibero.roundtrip(conn, { samples: ['가'], tableName: 'KEEP_ME', keepTable: true });
  assert.equal(rt.tableName, 'KEEP_ME');
  assert.ok(conn.tables.has('KEEP_ME'));
});

test('roundtrip: CREATE TABLE 이 실패하면 예외가 그대로 올라온다', async () => {
  const conn = createFakeConnection({ failOn: /^CREATE TABLE/ });
  await assert.rejects(tibero.roundtrip(conn), /injected failure/);
});

test('src/index.js 에서 모든 모듈을 가져올 수 있다', async () => {
  const lib = await import('../src/index.js');
  for (const name of ['cp949', 'charset', 'mojibake', 'tibero']) {
    assert.equal(typeof lib[name], 'object', name);
  }
});
