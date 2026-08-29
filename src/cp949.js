/**
 * CP949(= MSWIN949 = Windows-949 = UHC) 인코더/디코더. 외부 의존성 없음.
 *
 * 왜 직접 구현했나:
 *   Node 의 `TextDecoder('euc-kr')` 는 ICU 의 EUC-KR(KS X 1001) 컨버터라서
 *   CP949 확장 음절('똠', '펲', '믜' 등 8,822자)을 디코딩하지 못한다.
 *   Tibero 의 MSWIN949 는 확장 영역까지 포함하는 CP949 이므로
 *   src/data/cp949-table.js (자동 생성) 를 기준으로 직접 변환한다.
 *
 * EUC-KR(KSC5601, 완성형 2350자)은 두 바이트가 모두 0xA1~0xFE 인 부분집합이다.
 * 그래서 { subset: 'EUCKR' } 옵션 하나로 두 캐릭터셋을 함께 다룰 수 있다.
 */

import { ROWS, TOTAL_DOUBLE_BYTE_CHARS } from './data/cp949-table.js';

/** @typedef {'CP949'|'EUCKR'} Cp949Subset */

let encodeMap = null; // codePoint -> (lead << 8 | trail)
let decodeMap = null; // (lead << 8 | trail) -> char

function buildMaps() {
  if (encodeMap) return;
  encodeMap = new Map();
  decodeMap = new Map();
  for (const [leadKey, runs] of Object.entries(ROWS)) {
    const lead = Number(leadKey);
    for (const [start, text] of runs) {
      let trail = start;
      for (const ch of text) {
        const key = (lead << 8) | trail;
        decodeMap.set(key, ch);
        const cp = ch.codePointAt(0);
        // 중복 매핑(일부 한자)은 바이트 값이 작은 쪽을 정규 표현으로 삼는다.
        if (!encodeMap.has(cp)) encodeMap.set(cp, key);
        trail += 1;
      }
    }
  }
}

/** EUC-KR(완성형) 영역인지: 두 바이트 모두 0xA1~0xFE. */
function isEucKrBytes(key) {
  const lead = key >> 8;
  const trail = key & 0xff;
  return lead >= 0xa1 && lead <= 0xfe && trail >= 0xa1 && trail <= 0xfe;
}

function lookup(codePoint, subset) {
  buildMaps();
  const key = encodeMap.get(codePoint);
  if (key === undefined) return undefined;
  if (subset === 'EUCKR' && !isEucKrBytes(key)) return undefined;
  return key;
}

/** 이 런타임에서 CP949 변환이 가능한지(테이블이 정상 로드됐는지). */
export function isSupported() {
  try {
    buildMaps();
    return encodeMap.size > 0;
  } catch {
    return false;
  }
}

/** 테이블에 들어 있는 2바이트 문자 수(정상값 17048). */
export const TOTAL_CHARS = TOTAL_DOUBLE_BYTE_CHARS;

/**
 * 문자열 -> CP949(또는 EUC-KR) 바이트.
 * @param {string} text
 * @param {{onUnmappable?: 'throw'|'replace'|'skip', replacement?: number, subset?: Cp949Subset}} [options]
 * @returns {Buffer}
 */
export function encode(text, options = {}) {
  const { onUnmappable = 'throw', replacement = 0x3f /* '?' */, subset = 'CP949' } = options;
  const out = [];
  let index = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) {
      out.push(cp);
    } else {
      const key = lookup(cp, subset);
      if (key !== undefined) {
        out.push(key >> 8, key & 0xff);
      } else if (onUnmappable === 'replace') {
        out.push(replacement);
      } else if (onUnmappable === 'skip') {
        // 버린다
      } else {
        throw new Error(
          `${subset === 'EUCKR' ? 'EUC-KR' : 'CP949(MSWIN949)'} 로 표현할 수 없는 문자: ` +
            `${JSON.stringify(ch)} (U+${cp.toString(16).toUpperCase().padStart(4, '0')}, 문자 위치 ${index})`,
        );
      }
    }
    index += ch.length;
  }
  return Buffer.from(out);
}

/**
 * CP949 바이트 -> 문자열. 해석 불가 바이트는 U+FFFD 로 바뀐다.
 * @param {Buffer|Uint8Array|number[]} bytes
 * @returns {string}
 */
export function decode(bytes) {
  buildMaps();
  const buf = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let out = '';
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      continue;
    }
    const trail = buf[i + 1];
    const ch = trail === undefined ? undefined : decodeMap.get((b << 8) | trail);
    if (ch === undefined) {
      out += '�';
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** 문자열 전체가 해당 캐릭터셋으로 손실 없이 표현되는지. */
export function canEncode(text, subset = 'CP949') {
  return unmappableChars(text, subset).length === 0;
}

/**
 * 표현할 수 없는 문자 목록.
 * MSWIN949 DB 라면 여기 걸린 문자는 저장 시 '?' 로 바뀌어 원본이 사라진다.
 * @param {string} text
 * @param {Cp949Subset} [subset]
 * @returns {{char: string, codePoint: string, index: number}[]}
 */
export function unmappableChars(text, subset = 'CP949') {
  const bad = [];
  let index = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x80 && lookup(cp, subset) === undefined) {
      bad.push({
        char: ch,
        codePoint: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
        index,
      });
    }
    index += ch.length;
  }
  return bad;
}

/** 디버깅용: 문자 하나의 CP949 바이트를 16진수로. */
export function bytesOf(ch, subset = 'CP949') {
  const cp = String(ch).codePointAt(0);
  if (cp < 0x80) return cp.toString(16).padStart(2, '0');
  const key = lookup(cp, subset);
  return key === undefined ? null : key.toString(16).padStart(4, '0');
}
