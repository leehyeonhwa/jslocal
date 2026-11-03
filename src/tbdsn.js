/**
 * tbdsn.tbr 파서 - Tibero 판 tnsnames.ora.
 *
 * 위치: $TB_HOME/client/config/tbdsn.tbr
 *
 *   tibero=(
 *       (INSTANCE=(HOST=127.0.0.1)
 *                 (PT=8629)
 *                 (DB_NAME=tibero)
 *       )
 *   )
 *
 *   # TAC / 이중화: INSTANCE 를 여러 개 두고 옵션을 붙인다
 *   tac=(
 *       (INSTANCE=(HOST=10.0.0.1)(PT=8629)(DB_NAME=tac))
 *       (INSTANCE=(HOST=10.0.0.2)(PT=8629)(DB_NAME=tac))
 *       (USE_FAILOVER=Y)
 *       (LOAD_BALANCE=Y)
 *   )
 *
 * Oracle 과 비교하면 HOST/PORT/SERVICE_NAME 대신 HOST/PT/DB_NAME 이고,
 * DESCRIPTION/ADDRESS_LIST 계층이 없다.
 */
import fs from 'node:fs';
import path from 'node:path';

/** 이 도구가 tbdsn.tbr 을 찾는 순서. */
export function candidatePaths(env = process.env) {
  const list = [];
  if (env.TB_TBDSN_FILE) list.push(env.TB_TBDSN_FILE);
  if (env.TB_HOME) list.push(path.join(env.TB_HOME, 'client', 'config', 'tbdsn.tbr'));
  return list;
}

/** 존재하는 첫 tbdsn.tbr 경로. 없으면 null. */
export function findFile(env = process.env) {
  return candidatePaths(env).find((p) => fs.existsSync(p)) ?? null;
}

function tokenize(text) {
  const tokens = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((rawLine, lineIndex) => {
    const line = rawLine.replace(/#.*$/, '');
    const re = /\s*([()=]|[^\s()=]+)/gy;
    let m;
    while ((m = re.exec(line)) && m[1] !== undefined) {
      tokens.push({ value: m[1], line: lineIndex + 1 });
    }
  });
  return tokens;
}

/**
 * 문법:
 *   file  := (KEY '=' value)*
 *   value := ATOM | group+
 *   group := '(' (KEY '=' value | group*) ')'
 * group 하나는 KEY=value 쌍 하나, 또는 안쪽 group 들의 쌍 목록을 만든다.
 * 결과 value 는 문자열이거나 [key, value] 쌍의 배열이다.
 */
function parsePairs(text) {
  const tokens = tokenize(text);
  let i = 0;
  const peek = () => tokens[i]?.value;
  const fail = (msg) => {
    const at = tokens[Math.min(i, tokens.length - 1)];
    throw new Error(`tbdsn.tbr 파싱 오류${at ? ` (${at.line}행 '${at.value}')` : ''}: ${msg}`);
  };
  const expect = (v) => {
    if (peek() !== v) fail(`'${v}' 가 와야 합니다`);
    i += 1;
  };
  const isAtom = (v) => v !== undefined && !'()='.includes(v);

  function parsePair() {
    const key = peek();
    if (!isAtom(key)) fail('이름이 와야 합니다');
    i += 1;
    expect('=');
    return [key.toUpperCase(), parseValue(), key];
  }

  function parseValue() {
    if (isAtom(peek())) {
      const v = peek();
      i += 1;
      return v;
    }
    if (peek() !== '(') fail('값이 와야 합니다');
    const pairs = [];
    while (peek() === '(') pairs.push(...parseGroup());
    return pairs;
  }

  function parseGroup() {
    expect('(');
    let pairs = [];
    if (isAtom(peek())) {
      pairs = [parsePair()];
    } else {
      while (peek() === '(') pairs.push(...parseGroup());
    }
    expect(')');
    return pairs;
  }

  const top = [];
  while (i < tokens.length) top.push(parsePair());
  return top;
}

const lookup = (pairs, ...keys) => {
  for (const key of keys) {
    const hit = pairs.find(([k]) => k === key);
    if (hit) return hit[1];
  }
  return undefined;
};

/**
 * tbdsn.tbr 텍스트를 별칭 → {name, instances, options} 맵으로 바꾼다.
 * 별칭 키는 대문자로 정규화한다(조회도 대소문자 무시).
 */
export function parse(text) {
  const aliases = {};
  for (const [key, body, name] of parsePairs(text)) {
    if (!Array.isArray(body)) {
      throw new Error(`tbdsn.tbr: 별칭 '${name}' 의 값이 괄호 목록이 아닙니다`);
    }
    const instances = [];
    const options = {};
    for (const [key, value] of body) {
      if (key === 'INSTANCE' && Array.isArray(value)) {
        instances.push({
          host: lookup(value, 'HOST') ?? null,
          port: lookup(value, 'PT', 'PORT') ?? null,
          dbName: lookup(value, 'DB_NAME', 'SID', 'DB') ?? null,
        });
      } else {
        options[key] = Array.isArray(value) ? Object.fromEntries(value) : value;
      }
    }
    aliases[key] = { name, instances, options };
  }
  return aliases;
}

/** 파일을 읽어 parse 한다. */
export function readFile(file) {
  return parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 별칭을 찾는다. 없으면 null.
 * @param {Record<string, ReturnType<typeof parse>[string]>} aliases
 */
export function resolve(aliases, alias) {
  if (!alias) return null;
  return aliases[String(alias).toUpperCase()] ?? null;
}

/** 별칭 하나를 tbdsn.tbr 형식 문자열로 만든다 (예제/문서 생성용). */
export function format({ name, instances, options = {} }) {
  const inst = instances.map(
    (x) => `    (INSTANCE=(HOST=${x.host})\n              (PT=${x.port ?? 8629})\n              (DB_NAME=${x.dbName})\n    )`,
  );
  const opts = Object.entries(options).map(([k, v]) => `    (${k}=${v})`);
  return `${name}=(\n${[...inst, ...opts].join('\n')}\n)\n`;
}
