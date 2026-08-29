#!/usr/bin/env node
/**
 * tb-encoding-doctor - Tibero 한글 인코딩 진단기
 *
 *   node bin/tb-encoding-doctor.js                # 오프라인 점검만
 *   node bin/tb-encoding-doctor.js --connect      # DB 접속 후 한글 왕복 검증까지
 *   node bin/tb-encoding-doctor.js --check "..."  # 깨진 문자열 원인 추적/복구
 *   node bin/tb-encoding-doctor.js --json         # 결과를 JSON 으로
 */

import fs from 'node:fs';
import process from 'node:process';
import * as cp949 from '../src/cp949.js';
import * as charsetLib from '../src/charset.js';
import * as mojibake from '../src/mojibake.js';
import * as tibero from '../src/tibero.js';

const argv = process.argv.slice(2);
const opts = {
  connect: argv.includes('--connect'),
  json: argv.includes('--json'),
  help: argv.includes('--help') || argv.includes('-h'),
  check: null,
};
const checkIdx = argv.indexOf('--check');
if (checkIdx !== -1) opts.check = argv[checkIdx + 1] ?? '';

const ESC = String.fromCharCode(27); // ANSI escape
const color = process.stdout.isTTY && !opts.json;
const paint = (code, s) => (color ? `${ESC}[${code}m${s}${ESC}[0m` : s);
const bold = (s) => paint('1', s);
const dim = (s) => paint('2', s);
const MARK = { ok: 'OK  ', warn: 'WARN', error: 'FAIL', info: '    ' };
const TINT = { ok: '32', warn: '33', error: '31', info: '2' };

const report = { sections: [], summary: { ok: 0, warn: 0, error: 0, info: 0 } };
let section = null;

function begin(title) {
  section = { title, checks: [] };
  report.sections.push(section);
  if (!opts.json) console.log(`\n${bold(`| ${title}`)}`);
}

function add(level, label, detail, hint) {
  section.checks.push({ level, label, detail: detail ?? null, hint: hint ?? null });
  report.summary[level] = (report.summary[level] ?? 0) + 1;
  if (opts.json) return;
  const tag = paint(TINT[level], `[${MARK[level]}]`);
  console.log(`${tag} ${label}${detail ? `: ${detail}` : ''}`);
  if (hint) console.log(`       ${dim(`-> ${hint}`)}`);
}

function usage() {
  console.log(`tb-encoding-doctor - Tibero 한글 인코딩 진단

사용법:
  node bin/tb-encoding-doctor.js [옵션]

옵션:
  --connect          TB_* 환경변수로 DB 에 접속해 왕복(insert/select) 검증까지 수행
  --check <문자열>   깨진 문자열의 깨짐 경로를 추적하고 복구를 시도
  --json             결과를 JSON 으로 출력
  -h, --help         이 도움말

접속 환경변수:
  TB_DSN             odbc.ini 에 등록한 DSN 이름 (권장)
  TB_DRIVER          DSN 없이 쓸 때 드라이버 경로 (예: .../client/lib/libtbodbc.so)
  TB_HOST TB_PORT TB_DB
  TB_USER TB_PASSWORD
  TB_NLS_LANG        예: KOREAN_KOREA.UTF8 / KOREAN_KOREA.MSWIN949
`);
}

/* ------------------------------------------------------------------ */

function checkRuntime() {
  begin('1. Node 런타임');
  add('info', 'Node 버전', process.version);
  add('info', '플랫폼', `${process.platform}/${process.arch}`);

  if (cp949.isSupported()) {
    add('ok', 'CP949 변환기', `내장 테이블 ${cp949.TOTAL_CHARS}자 (외부 의존성 없음)`);
  } else {
    add('error', 'CP949 변환기', 'src/data/cp949-table.js 로드 실패');
  }

  add(
    'info',
    'stdout',
    `${process.stdout.isTTY ? 'tty' : 'pipe'} (Node 는 항상 UTF-8 로 write 합니다)`,
  );

  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || null;
  if (!locale) {
    add(
      'warn',
      '셸 로케일',
      '미설정',
      'LANG=ko_KR.UTF-8 등을 설정하세요. 터미널이 UTF-8 이 아니면 화면 출력만 깨져 보일 수 있습니다.',
    );
  } else if (charsetLib.normalizeCharset(locale) === 'UTF8') {
    add('ok', '셸 로케일', locale);
  } else {
    add(
      'warn',
      '셸 로케일',
      locale,
      '터미널 인코딩과 문자열 인코딩이 다르면 "화면만" 깨집니다. DB 값 자체는 멀쩡할 수 있습니다.',
    );
  }
}

function checkClientEnv() {
  begin('2. Tibero 클라이언트 환경');

  const raw = process.env.TB_NLS_LANG || process.env.NLS_LANG || null;
  const parsed = charsetLib.parseNlsLang(raw);
  if (!raw) {
    add(
      'warn',
      'TB_NLS_LANG',
      '미설정',
      '미설정이면 클라이언트 캐릭터셋이 무엇인지 아무도 보장하지 않습니다. KOREAN_KOREA.UTF8 처럼 명시하세요.',
    );
  } else if (!parsed?.normalizedCharset) {
    add(
      'error',
      'TB_NLS_LANG',
      raw,
      '형식은 LANGUAGE_TERRITORY.CHARSET 입니다. 예: KOREAN_KOREA.MSWIN949',
    );
  } else {
    add('ok', 'TB_NLS_LANG', `${raw} (charset=${parsed.normalizedCharset})`);
  }

  add(process.env.TB_HOME ? 'ok' : 'info', 'TB_HOME', process.env.TB_HOME ?? '미설정');

  for (const key of ['ODBCINI', 'ODBCSYSINI', 'TB_ODBC_INI']) {
    const value = process.env[key];
    if (!value) continue;
    const exists = fs.existsSync(value);
    add(exists ? 'ok' : 'warn', key, `${value}${exists ? '' : ' (경로 없음)'}`);
  }

  const cfg = tibero.loadConfig();
  const hasTarget = cfg.dsn || cfg.driver || cfg.connectionString;
  add(
    hasTarget ? 'ok' : 'info',
    '접속 설정',
    hasTarget
      ? tibero.maskConnectionString(tibero.buildConnectionString(cfg))
      : 'TB_DSN/TB_DRIVER 미설정 (--connect 불가)',
  );
}

function checkOfflineEncoding() {
  begin('3. 오프라인 인코딩 자체 점검');

  const sample = '한글 인코딩 테스트 Tibero';
  const roundtripped = cp949.decode(cp949.encode(sample));
  if (roundtripped === sample) {
    add('ok', 'CP949 왕복', JSON.stringify(sample));
  } else {
    add('error', 'CP949 왕복 실패', `${JSON.stringify(sample)} -> ${JSON.stringify(roundtripped)}`);
  }

  if (!opts.json) {
    console.log(dim('\n       문자열별 길이 (컬럼 크기 산정용)'));
    console.log(dim('       문자열                     문자수  UTF8  MSWIN949  EUCKR'));
  }
  const lengths = [];
  for (const text of tibero.DEFAULT_SAMPLES) {
    const row = {
      text,
      chars: charsetLib.charLength(text),
      utf8: charsetLib.byteLength(text, 'UTF8'),
      mswin949: charsetLib.byteLength(text, 'MSWIN949'),
      euckr: charsetLib.byteLength(text, 'EUCKR'),
    };
    lengths.push(row);
    if (!opts.json) {
      const chars = [...text];
      const label = chars.length > 22 ? `${chars.slice(0, 21).join('')}...` : text;
      console.log(
        dim(
          `       ${label.padEnd(25, ' ')} ${String(row.chars).padStart(5)} ${String(row.utf8).padStart(5)} ${String(row.mswin949).padStart(9)} ${String(row.euckr).padStart(6)}`,
        ),
      );
    }
  }
  section.lengths = lengths;

  for (const [name, hint] of [
    ['MSWIN949', 'DB 캐릭터셋이 MSWIN949 면 이런 문자는 "?" 로 바뀌어 저장됩니다. 이모지/확장한자를 다룬다면 UTF8 이어야 합니다.'],
    ['EUCKR', 'EUCKR 은 완성형 2350자뿐이라 "똠, 펲, 믜" 같은 확장 음절이 유실됩니다. MSWIN949 나 UTF8 을 쓰세요.'],
  ]) {
    const bad = tibero.DEFAULT_SAMPLES.flatMap((t) => charsetLib.unstorableChars(t, name));
    if (bad.length) {
      add('warn', `${name} 저장 불가 문자`, bad.map((u) => `${u.char}(${u.codePoint})`).join(', '), hint);
    } else {
      add('ok', `${name} 표현 가능`, '샘플 전부 변환 가능');
    }
  }

  // 대표적인 깨짐 패턴을 스스로 만들어 보고 탐지되는지 확인한다.
  for (const pattern of ['utf8-as-latin1', 'utf8-as-cp949', 'cp949-as-utf8']) {
    const broken = mojibake.corrupt('한글 인코딩', pattern);
    const analysis = mojibake.analyze(broken);
    add(
      analysis.suspect ? 'ok' : 'warn',
      `깨짐 탐지(${pattern})`,
      `${JSON.stringify(broken)} -> ${
        analysis.repaired ? `복구 ${JSON.stringify(analysis.repaired)}` : '복구 불가(원본 바이트 유실)'
      }`,
    );
  }
}

function checkString(text) {
  begin('문자열 진단');
  const analysis = mojibake.analyze(text);
  add('info', '입력', JSON.stringify(text));
  add('info', '정상도 점수', analysis.score.toFixed(3));
  if (!analysis.suspect) {
    add('ok', '판정', '깨진 문자열로 보이지 않습니다.');
  } else if (analysis.repaired) {
    add('warn', '판정', `깨짐 (${analysis.pattern})`);
    add('ok', '복구 결과', JSON.stringify(analysis.repaired));
  } else {
    add(
      'error',
      '판정',
      analysis.pattern ?? '깨짐 의심',
      '문자열에 이미 U+FFFD 가 박혀 원본을 알 수 없습니다. DB 에서 올바른 클라이언트 캐릭터셋으로 다시 읽어야 합니다.',
    );
  }
  if (analysis.candidates.length && !opts.json) {
    console.log(dim('\n       후보 해석'));
    for (const c of analysis.candidates) {
      console.log(
        dim(
          `       ${c.pattern.padEnd(22)} ${c.score.toFixed(3).padStart(7)}  ${JSON.stringify(c.text)}`,
        ),
      );
    }
  }
  section.analysis = analysis;
}

async function checkDatabase() {
  begin('4. DB 접속 및 한글 왕복 검증');
  let connection;
  try {
    connection = await tibero.connect();
    add('ok', '접속', tibero.maskConnectionString(tibero.buildConnectionString()));
  } catch (err) {
    add(
      'error',
      '접속 실패',
      err.message,
      err.cause ? String(err.cause.message ?? err.cause) : undefined,
    );
    return;
  }

  try {
    const nls = await tibero.readServerNls(connection);
    if (!nls.available) {
      add('warn', 'NLS 파라미터 조회 실패', (nls.errors ?? []).join(' | '));
    } else {
      const dbCharset = tibero.pickDatabaseCharset(nls.parameters);
      add('info', '조회 SQL', nls.sql);
      add(dbCharset ? 'ok' : 'warn', 'DB 캐릭터셋', dbCharset ?? '알 수 없음');
      if (nls.parameters.NLS_NCHAR_CHARACTERSET) {
        add('info', 'NCHAR 캐릭터셋', nls.parameters.NLS_NCHAR_CHARACTERSET);
      }
      const clientCharset =
        charsetLib.parseNlsLang(process.env.TB_NLS_LANG || process.env.NLS_LANG)?.charset ?? null;
      const verdict = charsetLib.diagnosePair(dbCharset, clientCharset);
      add(verdict.level, '서버/클라이언트 조합', verdict.message, verdict.hint);
      section.nls = nls.parameters;
    }

    const rt = await tibero.roundtrip(connection);
    section.roundtrip = rt;
    for (const r of rt.results) {
      if (r.error) {
        add('error', `왕복 #${r.index}`, `${JSON.stringify(r.original)} -> 오류: ${r.error}`);
      } else if (r.ok) {
        add(
          'ok',
          `왕복 #${r.index}`,
          `${JSON.stringify(r.original)} (LENGTH=${r.charLength}, LENGTHB=${r.byteLength})`,
        );
      } else {
        const analysis = mojibake.analyze(String(r.bound ?? ''));
        add(
          'error',
          `왕복 #${r.index} 불일치`,
          `${JSON.stringify(r.original)} -> ${JSON.stringify(r.bound)}`,
          analysis.pattern
            ? `깨짐 경로 추정: ${analysis.pattern}${
                analysis.repaired ? ` / 복구값 ${JSON.stringify(analysis.repaired)}` : ''
              }`
            : '클라이언트 캐릭터셋(TB_NLS_LANG)과 DB 캐릭터셋을 맞추세요.',
        );
      }
    }
  } finally {
    try {
      await connection.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */

async function main() {
  if (opts.help) {
    usage();
    return 0;
  }

  if (opts.check !== null) {
    checkString(opts.check);
  } else {
    checkRuntime();
    checkClientEnv();
    checkOfflineEncoding();
    if (opts.connect) await checkDatabase();
    else if (!opts.json) {
      console.log(dim('\n       (--connect 를 주면 실제 DB 왕복 검증까지 수행합니다)'));
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const { ok = 0, warn = 0, error = 0 } = report.summary;
    console.log(
      `\n${bold('결과')}: ${paint('32', `${ok} OK`)}, ${paint('33', `${warn} WARN`)}, ${paint('31', `${error} FAIL`)}`,
    );
  }
  return report.summary.error > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
