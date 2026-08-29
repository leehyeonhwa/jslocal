import test from 'node:test';
import assert from 'node:assert/strict';
import * as cp949 from '../src/cp949.js';

test('한글/영문 왕복', () => {
  for (const s of ['한글', 'Tibero 티베로 6.0', '가나다 ABC 123 !@#', '']) {
    assert.equal(cp949.decode(cp949.encode(s)), s);
  }
});

test('알려진 바이트 값', () => {
  assert.equal(cp949.encode('한글').toString('hex'), 'c7d1b1db');
  assert.equal(cp949.decode(Buffer.from('c7d1b1db', 'hex')), '한글');
  // 확장 음절: Node 내장 euc-kr 디코더로는 읽히지 않는 영역
  assert.equal(cp949.bytesOf('똠'), '8c63');
  assert.equal(cp949.decode(Buffer.from('8c63', 'hex')), '똠');
});

test('테이블 크기는 CP949 표준과 같다', () => {
  assert.equal(cp949.TOTAL_CHARS, 17048);
  assert.equal(cp949.isSupported(), true);
});

test('11172개 현대 한글 음절 전부 표현 가능', () => {
  const missing = [];
  for (let cp = 0xac00; cp <= 0xd7a3; cp += 1) {
    const ch = String.fromCodePoint(cp);
    if (!cp949.canEncode(ch)) missing.push(ch);
  }
  assert.deepEqual(missing, []);
});

test('EUC-KR 부분집합은 확장 음절을 거부한다', () => {
  assert.ok(cp949.canEncode('똠', 'CP949'));
  assert.ok(!cp949.canEncode('똠', 'EUCKR'));
  assert.ok(cp949.canEncode('한글', 'EUCKR'));
  assert.equal(cp949.bytesOf('똠', 'EUCKR'), null);
});

test('표현 불가 문자 처리', () => {
  assert.throws(() => cp949.encode('🙂'), /표현할 수 없는 문자/);
  assert.equal(cp949.encode('a🙂b', { onUnmappable: 'replace' }).toString('latin1'), 'a?b');
  assert.equal(cp949.encode('a🙂b', { onUnmappable: 'skip' }).toString('latin1'), 'ab');

  const bad = cp949.unmappableChars('한글 🙂 끝');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].char, '🙂');
  assert.equal(bad[0].codePoint, 'U+1F642');
});

test('깨진 바이트는 U+FFFD 로', () => {
  assert.equal(cp949.decode(Buffer.from([0x61, 0xff, 0x62])), 'a�b');
  assert.equal(cp949.decode(Buffer.from([0xc7])), '�'); // 선두 바이트만 남은 경우
});
