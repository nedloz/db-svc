// Форматирование HTML письма для показа в редакторе: теги блоков — каждый на своей строке
// с отступом, короткие абзацы остаются одной строкой, длинные теги разбиваются по атрибутам.
// Текст, пробелы внутри строки и сами атрибуты не меняются, кроме схлопывания пробелов.
// Для разметки писем этого достаточно; полноценным парсером HTML функция не является.

const INDENT = '  ';
const MAX_LINE = 100;
const VOID = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'col']);
const BLOCK = new Set([
  'html', 'head', 'body', 'title', 'meta', 'link', 'style', 'script', 'div', 'p', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'blockquote',
  'center', 'hr', 'br', 'section', 'header', 'footer',
]);
// Блоки, содержимое которых — строка текста; если она короткая, блок пишется одной строкой.
const TEXT_BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'title']);

const TOKEN_RE = /(<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>)/;
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

function parseTag(token) {
  const m = /^<(\/?)([a-zA-Z][\w:-]*)([\s\S]*?)(\/?)>$/.exec(token);
  if (!m) return null;
  return { closing: m[1] === '/', name: m[2].toLowerCase(), rest: m[3], selfClosing: m[4] === '/' };
}

function attrs(rest) {
  return [...rest.matchAll(ATTR_RE)].map((a) => (a[2] === undefined ? a[1] : `${a[1]}=${a[2]}`));
}

function normalizeTag(token, tag) {
  if (tag.closing) return `</${tag.name}>`;
  const parts = attrs(tag.rest);
  return `<${tag.name}${parts.length ? ` ${parts.join(' ')}` : ''}${tag.selfClosing ? ' /' : ''}>`;
}

// Открывающий тег, не влезающий в строку, — по одному атрибуту на строку.
function splitTag(token, tag, pad) {
  const parts = attrs(tag.rest);
  if (token.length + pad.length <= MAX_LINE || parts.length < 2) return [pad + token];
  return [`${pad}<${tag.name}`, ...parts.map((p) => `${pad}${INDENT}${p}`), `${pad}${tag.selfClosing ? '/>' : '>'}`];
}

export function formatHtml(source) {
  const tokens = String(source || '').split(TOKEN_RE).filter((t) => t !== '');
  const lines = [];
  let depth = 0;
  let raw = null; // внутри <style>/<script> текст не трогаем
  const pad = () => INDENT.repeat(Math.max(0, depth));

  // Содержимое до закрывающего тега, если в нём нет блочных тегов: [токены, индекс закрытия] или null.
  function inlineBody(from, name) {
    const body = [];
    for (let i = from; i < tokens.length; i += 1) {
      const t = parseTag(tokens[i]);
      if (t && t.closing && t.name === name) return [body, i];
      if (t && BLOCK.has(t.name)) return null;
      if (!t && /^<!--/.test(tokens[i]) === false && tokens[i].startsWith('<!')) return null;
      body.push(tokens[i]);
    }
    return null;
  }

  const collapse = (s) => s.replace(/\s+/g, ' ');

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const tag = parseTag(token);

    if (raw) {
      if (tag && tag.closing && tag.name === raw) {
        raw = null;
        depth -= 1;
        lines.push(pad() + normalizeTag(token, tag));
      } else if (token.trim()) {
        token.replace(/^\n+|\s+$/g, '').split('\n').forEach((l) => lines.push(`${pad()}${l.trim()}`));
      }
      continue;
    }

    if (!tag) {
      if (/^<!/.test(token)) {
        lines.push(/^<!--/.test(token) ? pad() + token : token.trim());
      } else if (collapse(token).trim()) {
        lines.push(pad() + collapse(token).trim());
      }
      continue;
    }

    if (!BLOCK.has(tag.name)) {
      // Строчный тег вне компактного блока: тянем за собой всё до закрывающего.
      const inner = tag.closing || VOID.has(tag.name) || tag.selfClosing ? null : inlineBody(i + 1, tag.name);
      if (inner) {
        const [body, end] = inner;
        const text = collapse(body.join('')).trim();
        const one = normalizeTag(token, tag) + text + `</${tag.name}>`;
        if (one.length + pad().length <= MAX_LINE) lines.push(pad() + one);
        else {
          lines.push(...splitTag(normalizeTag(token, tag), tag, pad()));
          if (text) lines.push(`${pad()}${INDENT}${text}`);
          lines.push(`${pad()}</${tag.name}>`);
        }
        i = end;
      } else {
        lines.push(pad() + normalizeTag(token, tag));
      }
      continue;
    }

    if (tag.closing) {
      depth -= 1;
      lines.push(pad() + normalizeTag(token, tag));
      continue;
    }

    // Компактный абзац: <p>текст <a>ссылка</a></p> одной строкой, если влезает.
    if (TEXT_BLOCK.has(tag.name) && !tag.selfClosing) {
      const inner = inlineBody(i + 1, tag.name);
      if (inner) {
        const [body, end] = inner;
        const one = normalizeTag(token, tag) + collapse(body.join('')).trim() + `</${tag.name}>`;
        if (one.length + pad().length <= MAX_LINE) {
          lines.push(pad() + one);
          i = end;
          continue;
        }
      }
    }

    lines.push(...splitTag(normalizeTag(token, tag), tag, pad()));
    if (VOID.has(tag.name) || tag.selfClosing) continue;
    depth += 1;
    if (tag.name === 'style' || tag.name === 'script') raw = tag.name;
  }
  return `${lines.join('\n')}\n`;
}
