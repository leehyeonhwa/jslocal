import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tbdsn from '../src/tbdsn.js';
import * as tibero from '../src/tibero.js';

const EXAMPLE = new URL('../examples/tbdsn.tbr', import.meta.url);

test('예제 tbdsn.tbr 을 파싱한다 (단일 인스턴스, TAC, 주석)', () => {
  const aliases = tbdsn.readFile(EXAMPLE);
  assert.deepEqual(Object.keys(aliases), ['TIBERO', 'TIBERO_TEST', 'TAC']);
  assert.deepEqual(aliases.TIBERO.instances, [{ host: '127.0.0.1', port: '8629', dbName: 'tibero' }]);
  assert.equal(aliases.TIBERO.name, 'tibero');
  assert.equal(aliases.TAC.instances.length, 2);
  assert.deepEqual(aliases.TAC.options, { USE_FAILOVER: 'Y', LOAD_BALANCE: 'Y' });
});

test('한 줄 형식, 바깥 괄호 생략, 대소문자 무시', () => {
  const aliases = tbdsn.parse('dev=((instance=(host=db1)(pt=18629)(db_name=DEV)))\nqa=(INSTANCE=(HOST=db2)(DB_NAME=QA))');
  assert.deepEqual(tbdsn.resolve(aliases, 'DEV').instances[0], { host: 'db1', port: '18629', dbName: 'DEV' });
  assert.deepEqual(tbdsn.resolve(aliases, 'qa').instances[0], { host: 'db2', port: null, dbName: 'QA' });
  assert.equal(tbdsn.resolve(aliases, 'nope'), null);
});

test('괄호가 안 맞으면 행 번호와 함께 실패한다', () => {
  assert.throws(() => tbdsn.parse('tibero=(\n  (INSTANCE=(HOST=a)(PT=1)\n'), /파싱 오류 \(2행/);
  assert.throws(() => tbdsn.parse('tibero=127.0.0.1'), /괄호 목록이 아닙니다/);
});

test('format 결과는 다시 parse 된다', () => {
  const entry = tbdsn.readFile(EXAMPLE).TAC;
  const again = tbdsn.parse(tbdsn.format(entry)).TAC;
  assert.deepEqual(again.instances, entry.instances);
  assert.deepEqual(again.options, entry.options);
});

test('TB_HOME 아래 client/config/tbdsn.tbr 을 찾는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tbhome-'));
  try {
    assert.equal(tbdsn.findFile({ TB_HOME: home }), null);
    fs.mkdirSync(path.join(home, 'client', 'config'), { recursive: true });
    const file = path.join(home, 'client', 'config', 'tbdsn.tbr');
    fs.copyFileSync(EXAMPLE, file);
    assert.equal(tbdsn.findFile({ TB_HOME: home }), file);
    // TB_TBDSN_FILE 이 우선
    assert.equal(tbdsn.findFile({ TB_HOME: home, TB_TBDSN_FILE: EXAMPLE.pathname }), EXAMPLE.pathname);

    const cfg = tibero.loadConfig({ TB_HOME: home, TB_DRIVER: '/x/libtbodbc.so', TB_ALIAS: 'tibero', TB_USER: 'u', TB_PASSWORD: 'p' });
    assert.equal(
      tibero.buildConnectionString(cfg),
      'DRIVER=/x/libtbodbc.so;SERVER=127.0.0.1;PORT=8629;DB=tibero;UID=u;PWD=p;',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('별칭 접속: TAC 는 첫 INSTANCE, 명시한 TB_HOST 가 별칭보다 우선', () => {
  const aliases = tbdsn.readFile(EXAMPLE);
  assert.equal(
    tibero.buildConnectionString({ driver: 'D', alias: 'tac', tbdsn: aliases }),
    'DRIVER=D;SERVER=10.0.0.1;PORT=8629;DB=tac;',
  );
  assert.equal(
    tibero.buildConnectionString({ driver: 'D', alias: 'tac', host: 'h', port: '1', database: 'x', tbdsn: aliases }),
    'DRIVER=D;SERVER=h;PORT=1;DB=x;',
  );
});

test('별칭을 못 풀면 이유를 알려준다', () => {
  const aliases = tbdsn.readFile(EXAMPLE);
  assert.throws(
    () => tibero.buildConnectionString({ driver: 'D', alias: 'prod', tbdsn: aliases }),
    /별칭 'prod' 가 없습니다.*tibero, tibero_test, tac/,
  );
  assert.throws(
    () => tibero.buildConnectionString({ driver: 'D', alias: 'prod', tbdsnFile: null }),
    /tbdsn.tbr 을 찾지 못했습니다/,
  );
});
