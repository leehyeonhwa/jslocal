/**
 * "왜 VARCHAR(10) 에 한글 5글자가 안 들어가죠?" 를 눈으로 확인한다.
 * DB 접속 없이 동작한다.
 *
 *   node examples/column-size.js
 */
import * as charset from '../src/charset.js';

const value = process.argv[2] ?? '한글다섯글자';
const size = Number(process.argv[3] ?? 10);

console.log(`값: ${JSON.stringify(value)}  (문자 ${charset.charLength(value)}자)`);
console.log('');
console.log('캐릭터셋   바이트  VARCHAR(%d) 수용', size);
for (const cs of ['UTF8', 'MSWIN949', 'EUCKR']) {
  const fit = charset.fitsColumn(value, size, { charset: cs });
  const lost = charset.unstorableChars(value, cs);
  console.log(
    `${cs.padEnd(10)} ${String(fit.used).padStart(5)}   ${fit.ok ? 'OK' : `초과 ${fit.overflow}바이트`}` +
      (lost.length ? `   유실: ${lost.map((c) => c.char).join(' ')}` : ''),
  );
}
console.log('');
console.log(`UTF8 기준 ${size}바이트로 안전하게 자르면: ${JSON.stringify(charset.truncateToBytes(value, size, 'UTF8'))}`);
console.log('');
console.log('참고: Tibero 의 VARCHAR(n) 은 기본이 바이트 세만틱입니다.');
console.log('      문자 수로 잡으려면 VARCHAR(n CHAR) 로 선언하세요.');
