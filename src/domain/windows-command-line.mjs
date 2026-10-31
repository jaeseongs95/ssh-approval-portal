import { COMMAND_MAX_BYTES, utf8WithinLimit } from '../contracts/ports.mjs';

const moduleCommand = /^[a-z0-9_][a-z0-9_.-]*\\[a-z][a-z0-9]*-[a-z][a-z0-9]*$/i;
const executable = /^[a-z0-9_][a-z0-9_.+-]*\.(?:exe|com|cmd|bat)$/i;
const absoluteExecutable = /^[a-z]:[\\/].+\.(?:exe|com|cmd|bat|ps1)$/i;

export function windowsPolicyName(value) {
  if (!utf8WithinLimit(value, 512) || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/.test(value)) return null;
  if (moduleCommand.test(value) || executable.test(value)) return value.toLowerCase();
  if (!absoluteExecutable.test(value) || /[<>"|?*`$]/.test(value) || value.slice(2).includes(':')
    || value.split(/[\\/]/).slice(1).some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) return null;
  return value.replaceAll('/', '\\').toLowerCase();
}

/** Literal PowerShell 5.1 name-policy grammar, never a safety classification.
 * Bare extensionless names may resolve to aliases/functions, so require the
 * evaluator. Quotes contain literal arguments only; expansion, scriptblocks,
 * redirection and stop-parsing require whole-command assessment.
 */
export function windowsCommandLineNames(source) {
  const names = new Set(); let i = 0;
  const unknown = () => { throw Error('Unsupported PowerShell command structure'); };
  const whitespace = () => { while (source[i] === ' ' || source[i] === '\t') i++; };
  function word() {
    const quote = source[i] === "'" || source[i] === '"' ? source[i++] : null;
    let text = '';
    if (quote) {
      let closed = false;
      while (i < source.length) {
        const character = source[i++];
        if (character === quote) {
          if (quote === "'" && source[i] === "'") { text += "'"; i++; continue; }
          closed = true; break;
        }
        if (quote === '"' && /[$`]/.test(character)) unknown();
        text += character;
      }
      if (!closed || i < source.length && !/[ \t;|]/.test(source[i])) unknown();
    } else {
      while (i < source.length && !/[ \t;|]/.test(source[i])) {
        const character = source[i++];
        if (/['"`$@(){}\[\],&<>#~]/.test(character)) unknown();
        text += character;
      }
      if (!text || text === '--%') unknown();
    }
    return { text, quoted: Boolean(quote) };
  }
  try {
    if (!utf8WithinLimit(source, COMMAND_MAX_BYTES) || !source.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(source)) unknown();
    while (i < source.length) {
      whitespace();
      let callOperator = false;
      if (source[i] === '&') { callOperator = true; i++; whitespace(); }
      const head = word(), name = windowsPolicyName(head.text);
      if (!name || head.quoted && !callOperator) unknown();
      names.add(name);
      whitespace();
      while (i < source.length && source[i] !== ';' && source[i] !== '|') { word(); whitespace(); }
      if (i === source.length) break;
      const separator = source[i++]; whitespace();
      if (i === source.length) { if (separator === '|') unknown(); break; }
      if (source[i] === ';' || source[i] === '|') unknown();
    }
    return { names: [...names], complete: names.size > 0, usesSudo: false };
  } catch {
    return { names: [...names], complete: false, usesSudo: false };
  }
}
