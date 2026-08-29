/**
 * 이미 깨진 채로 받은 문자열의 깨짐 경로를 추적하고 복구를 시도한다.
 * DB 접속 없이 동작한다.
 *
 *   node examples/repair-broken-text.js
 *   node examples/repair-broken-text.js "íê¸"
 */
import * as mojibake from '../src/mojibake.js';

const inputs = process.argv.slice(2);
const samples = inputs.length
  ? inputs
  : [
      mojibake.corrupt('주문이 정상 접수되었습니다', 'utf8-as-latin1'),
      mojibake.corrupt(mojibake.corrupt('이중 깨짐', 'utf8-as-latin1'), 'utf8-as-latin1'),
      mojibake.corrupt('복구 불가 사례', 'cp949-as-utf8'),
      '정상적인 한글 문장입니다',
    ];

for (const text of samples) {
  const a = mojibake.analyze(text);
  console.log('입력    :', JSON.stringify(text));
  console.log('점수    :', a.score.toFixed(3));
  console.log('판정    :', a.suspect ? `깨짐 (${a.pattern ?? '경로 불명'})` : '정상');
  if (a.repaired) console.log('복구    :', JSON.stringify(a.repaired));
  if (a.candidates.length) {
    for (const c of a.candidates) {
      console.log(`  후보  : ${c.pattern.padEnd(28)} ${c.score.toFixed(3).padStart(7)}  ${JSON.stringify(c.text)}`);
    }
  }
  console.log();
}
