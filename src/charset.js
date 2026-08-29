/**
 * Tibero 캐릭터셋 메타데이터와 바이트 길이 계산.
 *
 * 한글 깨짐/잘림 사고의 절반은 "문자 수"와 "바이트 수"를 헷갈려서 생긴다.
 * Tibero 의 VARCHAR(n) 은 기본이 바이트 세만틱이므로 UTF8 DB 에서
 * 한글 한 글자가 3바이트를 먹는다. VARCHAR(10) 에는 한글 3자 + 1바이트만 들어간다.
 */

import * as cp949 from './cp949.js';

/** @typedef {'UTF8'|'MSWIN949'|'EUCKR'|'UTF16'|'ASCII'} CharsetName */

const ALIASES = new Map(
  Object.entries({
    UTF8: 'UTF8',
    'UTF-8': 'UTF8',
    UTF88: 'UTF8',
    AL32UTF8: 'UTF8',
    MSWIN949: 'MSWIN949',
    CP949: 'MSWIN949',
    'WINDOWS-949': 'MSWIN949',
    WINDOWS949: 'MSWIN949',
    UHC: 'MSWIN949',
    KO16MSWIN949: 'MSWIN949',
    EUCKR: 'EUCKR',
    'EUC-KR': 'EUCKR',
    KSC5601: 'EUCKR',
    KO16KSC5601: 'EUCKR',
    UTF16: 'UTF16',
    'UTF-16': 'UTF16',
    AL16UTF16: 'UTF16',
    ASCII: 'ASCII',
    'US-ASCII': 'ASCII',
  }),
);

export const CHARSETS = {
  UTF8: {
    name: 'UTF8',
    hangulBytes: 3,
    unicode: true,
    description: '유니코드 가변 길이. 신규 구축은 사실상 이것만 쓴다.',
  },
  MSWIN949: {
    name: 'MSWIN949',
    hangulBytes: 2,
    unicode: false,
    description: 'CP949. 윈도우 한글 코드페이지. 레거시 Tibero/Oracle 이관 DB 에 많다.',
  },
  EUCKR: {
    name: 'EUCKR',
    hangulBytes: 2,
    unicode: false,
    description: 'KSC5601 완성형 2350자. MSWIN949 의 부분집합이라 "똠, 펲" 등이 안 들어간다.',
  },
  UTF16: {
    name: 'UTF16',
    hangulBytes: 2,
    unicode: true,
    description: '주로 NCHAR/NVARCHAR2 의 내부 표현.',
  },
  ASCII: {
    name: 'ASCII',
    hangulBytes: 0,
    unicode: false,
    description: '한글 저장 불가. 이 설정이면 무조건 깨진다.',
  },
};

/** 'ko_KR.UTF-8', 'utf8', 'MSWIN949' 등 다양한 표기를 정규 이름으로. */
export function normalizeCharset(input) {
  if (!input) return null;
  const raw = String(input).trim().toUpperCase();
  const tail = raw.includes('.') ? raw.slice(raw.lastIndexOf('.') + 1) : raw;
  return ALIASES.get(tail) ?? ALIASES.get(raw) ?? null;
}

/**
 * NLS_LANG / TB_NLS_LANG 문자열 파싱. 형식: LANGUAGE_TERRITORY.CHARSET
 * 예) KOREAN_KOREA.MSWIN949
 */
export function parseNlsLang(value) {
  if (!value) return null;
  const m = /^([^_.]*)(?:_([^.]*))?(?:\.(.*))?$/.exec(String(value).trim());
  if (!m) return null;
  return {
    raw: String(value).trim(),
    language: m[1] || null,
    territory: m[2] || null,
    charset: m[3] || null,
    normalizedCharset: normalizeCharset(m[3]),
  };
}

/**
 * 특정 캐릭터셋에서 문자열이 차지하는 바이트 수.
 * @param {string} text
 * @param {CharsetName|string} charset
 */
export function byteLength(text, charset = 'UTF8') {
  const name = normalizeCharset(charset);
  const s = String(text);
  switch (name) {
    case 'UTF8':
      return Buffer.byteLength(s, 'utf8');
    case 'UTF16':
      return s.length * 2;
    case 'ASCII':
      return s.length;
    case 'MSWIN949':
    case 'EUCKR':
      // 표현 불가 문자는 '?' 1바이트로 대체된다고 보고 길이만 계산한다.
      return cp949.encode(s, {
        onUnmappable: 'replace',
        subset: name === 'EUCKR' ? 'EUCKR' : 'CP949',
      }).length;
    default:
      throw new Error(`알 수 없는 캐릭터셋: ${charset}`);
  }
}

/** 문자 수 기준 길이(코드포인트 기준. Tibero 의 CHAR 세만틱과 같은 감각). */
export function charLength(text) {
  return [...String(text)].length;
}

/**
 * VARCHAR(size) 컬럼에 들어가는지 검사한다.
 * @param {string} text
 * @param {number} size 컬럼 선언 크기
 * @param {{charset?: string, semantics?: 'BYTE'|'CHAR'}} [options]
 */
export function fitsColumn(text, size, options = {}) {
  const { charset = 'UTF8', semantics = 'BYTE' } = options;
  const used = semantics === 'CHAR' ? charLength(text) : byteLength(text, charset);
  return {
    ok: used <= size,
    used,
    size,
    unit: semantics === 'CHAR' ? '문자' : '바이트',
    charset: normalizeCharset(charset),
    overflow: Math.max(0, used - size),
  };
}

/**
 * 바이트 기준으로 안전하게 자른다(멀티바이트 문자를 반으로 쪼개지 않는다).
 * ORA/TBR-12899("value too large for column") 회피용.
 */
export function truncateToBytes(text, maxBytes, charset = 'UTF8') {
  let out = '';
  let used = 0;
  for (const ch of String(text)) {
    const w = byteLength(ch, charset);
    if (used + w > maxBytes) break;
    out += ch;
    used += w;
  }
  return out;
}

/**
 * 해당 캐릭터셋으로 저장했을 때 유실되는 문자들.
 * UTF8/UTF16 은 항상 빈 배열.
 */
export function unstorableChars(text, charset = 'UTF8') {
  const name = normalizeCharset(charset);
  if (name === 'UTF8' || name === 'UTF16') return [];
  if (name === 'ASCII') {
    return [...String(text)]
      .map((ch, i) => ({ ch, i }))
      .filter(({ ch }) => ch.codePointAt(0) >= 0x80)
      .map(({ ch, i }) => ({
        char: ch,
        codePoint: `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
        index: i,
      }));
  }
  return cp949.unmappableChars(text, name === 'EUCKR' ? 'EUCKR' : 'CP949');
}

/**
 * 서버(DB) 캐릭터셋과 클라이언트 캐릭터셋 조합을 진단한다.
 * @returns {{level:'ok'|'warn'|'error', message:string, hint?:string}}
 */
export function diagnosePair(serverCharset, clientCharset) {
  const server = normalizeCharset(serverCharset);
  const client = normalizeCharset(clientCharset);

  if (!server) {
    return { level: 'error', message: `서버 캐릭터셋을 알 수 없습니다: ${serverCharset}` };
  }
  if (server === 'ASCII') {
    return {
      level: 'error',
      message: 'DB 캐릭터셋이 ASCII 입니다. 한글을 저장할 수 없습니다.',
      hint: 'DB 를 UTF8 로 재생성해야 합니다. 캐릭터셋은 create database 시점에 정해집니다.',
    };
  }
  if (!client) {
    return {
      level: 'warn',
      message: `클라이언트 캐릭터셋이 설정되지 않았습니다(TB_NLS_LANG 미설정 또는 인식 불가: ${clientCharset}).`,
      hint: `TB_NLS_LANG=KOREAN_KOREA.${server} 처럼 서버와 같은 값을 지정하세요.`,
    };
  }
  if (server === client) {
    return {
      level: 'ok',
      message: `서버/클라이언트 모두 ${server}. 변환이 일어나지 않습니다.`,
    };
  }
  if (server === 'EUCKR' && client === 'MSWIN949') {
    return {
      level: 'warn',
      message: 'EUCKR(서버) ↔ MSWIN949(클라이언트). 확장 음절("똠", "펲" 등)이 유실될 수 있습니다.',
      hint: '가능하면 양쪽을 MSWIN949 또는 UTF8 로 맞추세요.',
    };
  }
  if ((server === 'UTF8' && client === 'MSWIN949') || (server === 'MSWIN949' && client === 'UTF8')) {
    return {
      level: 'warn',
      message: `${server}(서버) ↔ ${client}(클라이언트). Tibero 가 자동 변환하지만, 클라이언트 설정이 실제 터미널/앱 인코딩과 다르면 깨집니다.`,
      hint: '설정을 서버와 동일하게 맞추는 것이 가장 안전합니다. 아니면 애플리케이션 쪽 인코딩까지 3중으로 일치시켜야 합니다.',
    };
  }
  return {
    level: 'warn',
    message: `${server}(서버) ↔ ${client}(클라이언트) 조합입니다. 변환이 발생합니다.`,
    hint: '가능하면 동일 캐릭터셋으로 맞추세요.',
  };
}
