/**
 * 실제 테이블을 만들어 여러 종류의 한글을 넣고 왕복 검증한다.
 * 확장 음절(똠), 특수문자(㈜), 이모지까지 섞어서 어디서 깨지는지 본다.
 *
 *   TB_DSN=TIBERO TB_USER=scott TB_PASSWORD=tiger node examples/roundtrip.js
 */
import * as tibero from '../src/tibero.js';
import * as charset from '../src/charset.js';

const connection = await tibero.connect();
try {
  const nls = await tibero.readServerNls(connection);
  const dbCharset = tibero.pickDatabaseCharset(nls.parameters);
  console.log('DB 캐릭터셋:', dbCharset ?? '(알 수 없음)');
  console.log('클라이언트:', process.env.TB_NLS_LANG ?? '(TB_NLS_LANG 미설정)');
  console.log('---');

  const { results, passed } = await tibero.roundtrip(connection);
  for (const r of results) {
    const mark = r.error ? 'ERR ' : r.ok ? 'OK  ' : 'FAIL';
    console.log(`[${mark}] ${JSON.stringify(r.original)}`);
    if (r.error) console.log(`       ${r.error}`);
    else if (!r.ok) console.log(`       받은 값: ${JSON.stringify(r.bound)}`);
    else console.log(`       LENGTH=${r.charLength} LENGTHB=${r.byteLength}`);

    if (dbCharset) {
      const lost = charset.unstorableChars(r.original, dbCharset);
      if (lost.length) {
        console.log(`       ${dbCharset} 에 저장 불가: ${lost.map((c) => c.char).join(' ')}`);
      }
    }
  }
  console.log('---');
  console.log(passed ? '전부 통과' : '깨진 항목이 있습니다. README 의 원인별 대응표를 보세요.');
} finally {
  await connection.close();
}
