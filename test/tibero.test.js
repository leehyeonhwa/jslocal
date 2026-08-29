import test from 'node:test';
import assert from 'node:assert/strict';
import * as tibero from '../src/tibero.js';

test('환경변수에서 설정을 읽는다', () => {
  const cfg = tibero.loadConfig({
    TB_HOST: 'db.example.com',
    TB_DB: 'tibero',
    TB_USER: 'scott',
    TB_PASSWORD: 'tiger',
    TB_NLS_LANG: 'KOREAN_KOREA.UTF8',
  });
  assert.equal(cfg.host, 'db.example.com');
  assert.equal(cfg.port, '8629'); // 기본 포트
  assert.equal(cfg.nlsLang, 'KOREAN_KOREA.UTF8');
});

test('DSN 방식 접속 문자열', () => {
  const s = tibero.buildConnectionString({ dsn: 'TIBERO', user: 'scott', password: 'tiger' });
  assert.equal(s, 'DSN=TIBERO;UID=scott;PWD=tiger;');
});

test('드라이버 직접 지정 방식 접속 문자열', () => {
  const s = tibero.buildConnectionString({
    driver: '/opt/tibero/client/lib/libtbodbc.so',
    host: '10.0.0.5',
    port: '8629',
    database: 'tibero',
    user: 'scott',
    password: 'tiger',
  });
  assert.equal(
    s,
    'DRIVER=/opt/tibero/client/lib/libtbodbc.so;SERVER=10.0.0.5;PORT=8629;DB=tibero;UID=scott;PWD=tiger;',
  );
});

test('접속 대상이 없으면 명확히 실패한다', () => {
  assert.throws(() => tibero.buildConnectionString({}), /TB_DSN 또는 TB_DRIVER/);
});

test('비밀번호는 마스킹된다', () => {
  const masked = tibero.maskConnectionString('DSN=TIBERO;UID=scott;PWD=tiger;');
  assert.equal(masked, 'DSN=TIBERO;UID=scott;PWD=***;');
  assert.ok(!masked.includes('tiger'));
});

test('NLS 파라미터에서 DB 캐릭터셋을 고른다', () => {
  assert.equal(
    tibero.pickDatabaseCharset({ NLS_CHARACTERSET: 'UTF8', NLS_NCHAR_CHARACTERSET: 'UTF16' }),
    'UTF8',
  );
  assert.equal(tibero.pickDatabaseCharset({}), null);
});

test('기본 샘플에는 캐릭터셋별로 문제가 되는 문자가 들어 있다', () => {
  assert.ok(tibero.DEFAULT_SAMPLES.some((s) => s.includes('똠'))); // EUCKR 에서 유실
  assert.ok(tibero.DEFAULT_SAMPLES.some((s) => /\p{Extended_Pictographic}/u.test(s))); // MSWIN949 에서 유실
});
