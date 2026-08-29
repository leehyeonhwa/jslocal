import test from 'node:test';
import assert from 'node:assert/strict';
import * as mojibake from '../src/mojibake.js';

test('정상 한글은 깨짐으로 보지 않는다', () => {
  for (const s of ['한글 인코딩 테스트', '주문번호 A-1234 가 정상 처리되었습니다.', 'plain ascii text']) {
    assert.equal(mojibake.looksBroken(s), false, s);
    assert.equal(mojibake.repair(s), s);
  }
});

test('utf8-as-latin1 은 완전 복구된다', () => {
  const original = '한글 인코딩 테스트';
  const broken = mojibake.corrupt(original, 'utf8-as-latin1');
  assert.notEqual(broken, original);

  const analysis = mojibake.analyze(broken);
  assert.equal(analysis.suspect, true);
  assert.equal(analysis.pattern, 'utf8-as-latin1');
  assert.equal(analysis.repaired, original);
  assert.equal(mojibake.repair(broken), original);
});

test('이중 인코딩(utf8-as-latin1 두 번)도 복구된다', () => {
  const original = '이중 깨짐';
  const broken = mojibake.corrupt(mojibake.corrupt(original, 'utf8-as-latin1'), 'utf8-as-latin1');
  assert.equal(mojibake.repair(broken), original);
});

test('U+FFFD 가 박힌 문자열은 깨짐으로 판정하되 복구하지 않는다', () => {
  const broken = mojibake.corrupt('한글 인코딩', 'cp949-as-utf8');
  const analysis = mojibake.analyze(broken);
  assert.equal(analysis.suspect, true);
  assert.equal(analysis.lossy, true);
  assert.equal(analysis.repaired, null);
  assert.match(analysis.pattern, /복구 불가/);
});

test('점수: 정상 한글 > 깨진 문자열', () => {
  const ok = mojibake.textScore('한글 인코딩 테스트입니다');
  const bad = mojibake.textScore(mojibake.corrupt('한글 인코딩 테스트입니다', 'utf8-as-latin1'));
  assert.ok(ok > bad, `${ok} > ${bad}`);
  assert.ok(ok > 0.5);
  assert.ok(bad < 0);
});

test('빈 문자열/숫자 입력에도 안전하다', () => {
  assert.equal(mojibake.repair(''), '');
  assert.equal(mojibake.textScore(''), 0);
  assert.equal(mojibake.looksBroken('12345'), false);
});

test('corrupt 는 알 수 없는 패턴을 거부한다', () => {
  assert.throws(() => mojibake.corrupt('한글', 'nope'), /알 수 없는 패턴/);
});
