import test from 'node:test';
import assert from 'node:assert/strict';
import * as charset from '../src/charset.js';

test('캐릭터셋 이름 정규화', () => {
  assert.equal(charset.normalizeCharset('utf8'), 'UTF8');
  assert.equal(charset.normalizeCharset('UTF-8'), 'UTF8');
  assert.equal(charset.normalizeCharset('ko_KR.UTF-8'), 'UTF8');
  assert.equal(charset.normalizeCharset('cp949'), 'MSWIN949');
  assert.equal(charset.normalizeCharset('KOREAN_KOREA.MSWIN949'), 'MSWIN949');
  assert.equal(charset.normalizeCharset('euc-kr'), 'EUCKR');
  assert.equal(charset.normalizeCharset('무엇'), null);
  assert.equal(charset.normalizeCharset(null), null);
});

test('바이트 길이: 한글은 UTF8 3바이트, MSWIN949 2바이트', () => {
  assert.equal(charset.byteLength('한글', 'UTF8'), 6);
  assert.equal(charset.byteLength('한글', 'MSWIN949'), 4);
  assert.equal(charset.byteLength('한글', 'UTF16'), 4);
  assert.equal(charset.byteLength('abc', 'UTF8'), 3);
  assert.equal(charset.charLength('한글abc'), 5);
});

test('EUC-KR 에서 확장 음절은 1바이트 "?" 로 대체된다', () => {
  assert.equal(charset.byteLength('똠', 'MSWIN949'), 2);
  assert.equal(charset.byteLength('똠', 'EUCKR'), 1);
  assert.deepEqual(
    charset.unstorableChars('똠방각하', 'EUCKR').map((c) => c.char),
    ['똠'],
  );
  assert.deepEqual(charset.unstorableChars('똠방각하', 'MSWIN949'), []);
  assert.deepEqual(charset.unstorableChars('아무거나 🙂', 'UTF8'), []);
  assert.deepEqual(
    charset.unstorableChars('한글', 'ASCII').map((c) => c.char),
    ['한', '글'],
  );
});

test('VARCHAR 컬럼 크기 판정 - 바이트 세만틱', () => {
  // UTF8 DB 의 VARCHAR(10) 에는 한글 3글자 + 1바이트만 들어간다.
  const r = charset.fitsColumn('한글테스트', 10, { charset: 'UTF8' });
  assert.equal(r.ok, false);
  assert.equal(r.used, 15);
  assert.equal(r.overflow, 5);
  assert.equal(r.unit, '바이트');

  // 같은 값이 MSWIN949 DB 에서는 들어간다.
  assert.equal(charset.fitsColumn('한글테스트', 10, { charset: 'MSWIN949' }).ok, true);

  // CHAR 세만틱이면 문자 수로 센다.
  const c = charset.fitsColumn('한글테스트', 10, { charset: 'UTF8', semantics: 'CHAR' });
  assert.equal(c.ok, true);
  assert.equal(c.used, 5);
});

test('바이트 기준 자르기는 문자를 반으로 쪼개지 않는다', () => {
  assert.equal(charset.truncateToBytes('한글테스트', 7, 'UTF8'), '한글');
  assert.equal(charset.truncateToBytes('한글테스트', 6, 'UTF8'), '한글');
  assert.equal(charset.truncateToBytes('한글테스트', 5, 'MSWIN949'), '한글');
  assert.equal(charset.byteLength(charset.truncateToBytes('한글테스트', 7, 'UTF8'), 'UTF8') <= 7, true);
});

test('NLS_LANG 파싱', () => {
  assert.deepEqual(charset.parseNlsLang('KOREAN_KOREA.MSWIN949'), {
    raw: 'KOREAN_KOREA.MSWIN949',
    language: 'KOREAN',
    territory: 'KOREA',
    charset: 'MSWIN949',
    normalizedCharset: 'MSWIN949',
  });
  assert.equal(charset.parseNlsLang('KOREAN_KOREA.UTF8').normalizedCharset, 'UTF8');
  assert.equal(charset.parseNlsLang('AMERICAN_AMERICA.US7ASCII').normalizedCharset, null);
  assert.equal(charset.parseNlsLang(''), null);
});

test('서버/클라이언트 조합 진단', () => {
  assert.equal(charset.diagnosePair('UTF8', 'UTF8').level, 'ok');
  assert.equal(charset.diagnosePair('MSWIN949', 'KOREAN_KOREA.MSWIN949').level, 'ok');
  assert.equal(charset.diagnosePair('UTF8', 'MSWIN949').level, 'warn');
  assert.equal(charset.diagnosePair('UTF8', null).level, 'warn');
  assert.equal(charset.diagnosePair('ASCII', 'UTF8').level, 'error');
  assert.equal(charset.diagnosePair(null, 'UTF8').level, 'error');
});
