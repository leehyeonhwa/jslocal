/**
 * 한글 깨짐(모지바케) 패턴 판별과 복구.
 *
 * 실무에서 마주치는 대표 4가지:
 *  1) utf8-as-cp949   : UTF-8 바이트를 CP949 로 읽음      "한글" -> "頊옩" 류
 *  2) utf8-as-latin1  : UTF-8 바이트를 Latin-1 로 읽음    "한글" -> "íê¸€"
 *  3) cp949-as-utf8   : CP949 바이트를 UTF-8 로 읽음      "한글" -> "��" (복구 불가)
 *  4) double-utf8     : 위 2번이 한 번 더 인코딩된 경우
 *
 * 1,2,4 는 원본 바이트가 살아 있으므로 되돌릴 수 있다.
 * 3 은 디코딩 시점에 U+FFFD 로 뭉개져 정보가 사라진 것이라 DB 쪽에서 다시 읽어야 한다.
 */

import * as cp949 from './cp949.js';

const HANGUL_SYLLABLE = /[가-힣]/;
const REPLACEMENT = '�';

/** 텍스트가 "정상적인 한글/영문 텍스트"에 가까운 정도. -1 ~ 1 */
export function textScore(text) {
  const s = String(text);
  if (s.length === 0) return 0;
  let good = 0;
  let bad = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfffd) {
      bad += 3; // 이미 정보가 날아간 표식
    } else if (cp >= 0xac00 && cp <= 0xd7a3) {
      good += 1.5; // 완성형 한글 음절
    } else if (cp < 0x80) {
      // ASCII: 인쇄 가능 문자만 인정
      good += cp === 0x0a || cp === 0x0d || cp === 0x09 || (cp >= 0x20 && cp < 0x7f) ? 1 : -2;
    } else if (cp >= 0x3130 && cp <= 0x318f) {
      good += 0.5; // 호환 자모 (ㄱ, ㅏ ...)
    } else if (cp >= 0x00a1 && cp <= 0x00ff) {
      bad += 1; // Latin-1 보충 - 한국어 텍스트에는 거의 안 나온다
    } else if (cp >= 0x0100 && cp <= 0x02af) {
      bad += 1; // 라틴 확장
    } else if (cp >= 0x4e00 && cp <= 0x9fff) {
      bad += 0.3; // 한자 - 정상일 수도 있어 약하게만
    } else if (cp >= 0x3000 && cp <= 0x303f) {
      good += 0.3; // CJK 문장부호
    } else {
      bad += 0.5;
    }
  }
  return (good - bad) / s.length;
}

/** 복구 후보 변환들. 실패하면 null 을 돌려준다. */
const TRANSFORMS = {
  'utf8-as-cp949': (text) => {
    const bytes = cp949.encode(text, { onUnmappable: 'throw' });
    const out = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return out;
  },
  'utf8-as-latin1': (text) => {
    const bytes = Buffer.from(text, 'latin1');
    // latin1 왕복이 무손실인지 확인 (U+00FF 초과 문자가 섞여 있으면 이 패턴이 아니다)
    if (bytes.toString('latin1') !== text) throw new Error('not latin1');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  },
  'cp949-as-utf8': (text) => {
    // UTF-8 로 잘못 읽힌 CP949. U+FFFD 가 남아 있으면 원복 불가.
    if (text.includes(REPLACEMENT)) throw new Error('lossy');
    const bytes = Buffer.from(text, 'utf8');
    return cp949.decode(bytes);
  },
};

/**
 * 어떤 변환이 이 문자열에 "말이 되는지" 판단한다.
 *
 * 이 게이트가 없으면 오탐이 난다. 예를 들어 Latin-1 로 두 번 깨진 문자열은
 * UTF-8 바이트를 CP949 로 읽어도 그럴싸한(그러나 뜻 없는) 한글이 나오는데,
 * 정상 한국어 텍스트가 통째로 Latin-1 영역에만 있는 경우는 없으므로
 * 그런 입력은 utf8-as-latin1 로만 해석한다.
 */
function isApplicable(pattern, text) {
  const hasNonLatin1 = /[^\u0000-\u00ff]/.test(text);
  return pattern === 'utf8-as-latin1' ? !hasNonLatin1 : hasNonLatin1;
}

const MAX_DEPTH = 3;

/**
 * 문자열이 깨진 것으로 보이는지 판별하고, 가능한 복구안을 찾는다.
 * 변환을 최대 3단계까지 조합해 탐색한다(이중 인코딩 대응).
 *
 * @param {string} text
 * @returns {{
 *   suspect: boolean,
 *   score: number,
 *   pattern: string|null,
 *   repaired: string|null,
 *   repairedScore: number|null,
 *   lossy: boolean,
 *   candidates: {pattern: string, text: string, score: number}[]
 * }}
 */
export function analyze(text) {
  const s = String(text);
  const score = textScore(s);
  const lossy = s.includes(REPLACEMENT);

  const candidates = [];
  const seen = new Set([s]);
  let frontier = [{ text: s, path: [] }];

  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const next = [];
    for (const node of frontier) {
      for (const [pattern, fn] of Object.entries(TRANSFORMS)) {
        if (!isApplicable(pattern, node.text)) continue;
        let out;
        try {
          out = fn(node.text);
        } catch {
          continue;
        }
        if (!out || seen.has(out)) continue;
        seen.add(out);
        const path = [...node.path, pattern];
        candidates.push({
          pattern: path.length === 1 ? path[0] : path.join(' + '),
          text: out,
          score: textScore(out),
        });
        next.push({ text: out, path });
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  // 복구안이 "확실히" 더 그럴듯할 때만 채택한다.
  const improved = best && best.score > score + 0.3 && HANGUL_SYLLABLE.test(best.text);

  return {
    suspect: lossy || score < 0.2 || Boolean(improved),
    score,
    pattern: improved
      ? best.pattern
      : lossy
        ? 'lossy (U+FFFD 포함 - 문자열만으로는 복구 불가, 원본 바이트를 다시 읽어야 함)'
        : null,
    repaired: improved ? best.text : null,
    repairedScore: improved ? best.score : null,
    lossy,
    candidates: candidates.slice(0, 4),
  };
}

/** 깨진 문자열이면 복구본을, 아니면 원본을 그대로 돌려준다. */
export function repair(text) {
  const result = analyze(text);
  return result.repaired ?? String(text);
}

/** 깨짐 의심 여부만 빠르게. */
export function looksBroken(text) {
  return analyze(text).suspect;
}

/**
 * 학습/테스트용: 정상 문자열을 일부러 깨뜨린다.
 * @param {string} text
 * @param {keyof typeof TRANSFORMS} pattern
 */
export function corrupt(text, pattern) {
  const s = String(text);
  switch (pattern) {
    case 'utf8-as-cp949':
      return cp949.decode(Buffer.from(s, 'utf8'));
    case 'utf8-as-latin1':
      return Buffer.from(s, 'utf8').toString('latin1');
    case 'cp949-as-utf8':
      return new TextDecoder('utf-8').decode(cp949.encode(s, { onUnmappable: 'replace' }));
    default:
      throw new Error(`알 수 없는 패턴: ${pattern}`);
  }
}
