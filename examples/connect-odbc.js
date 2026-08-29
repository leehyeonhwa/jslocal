/**
 * 가장 기본: Tibero 에 접속해 한글을 넣고 다시 읽는다.
 *
 *   TB_DSN=TIBERO TB_USER=scott TB_PASSWORD=tiger node examples/connect-odbc.js
 */
import * as tibero from '../src/tibero.js';
import * as mojibake from '../src/mojibake.js';

const connection = await tibero.connect();
console.log('접속:', tibero.maskConnectionString(tibero.buildConnectionString()));

try {
  // 1) 서버 NLS 확인
  const nls = await tibero.readServerNls(connection);
  console.log('DB 캐릭터셋:', tibero.pickDatabaseCharset(nls.parameters) ?? '(조회 실패)');

  // 2) 리터럴이 아니라 "바인드 변수"로 넣는다.
  //    문자열을 SQL 에 직접 이어붙이면 SQL 문 자체가 클라이언트 캐릭터셋으로
  //    변환되면서 깨질 여지가 커진다.
  const original = '한글 인코딩 테스트';
  const rows = await connection.query('SELECT ? AS TXT, LENGTH(?) AS C, LENGTHB(?) AS B FROM DUAL', [
    original,
    original,
    original,
  ]);

  const got = rows[0]?.TXT;
  console.log('보낸 값:', original);
  console.log('받은 값:', got);
  console.log('LENGTH(문자수):', rows[0]?.C, '/ LENGTHB(바이트수):', rows[0]?.B);

  if (got === original) {
    console.log('=> 정상. 인코딩 경로에 문제 없음.');
  } else {
    const analysis = mojibake.analyze(String(got ?? ''));
    console.log('=> 깨짐! 추정 경로:', analysis.pattern ?? '알 수 없음');
    if (analysis.repaired) console.log('   복구값:', analysis.repaired);
  }
} finally {
  await connection.close();
}
