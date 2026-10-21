import { COMMAND_MAX_BYTES, utf8WithinLimit } from '../contracts/ports.mjs';

/** Name-policy grammar, never a shell evaluator or an argument risk classifier.
 * Unsupported/dynamic syntax is incomplete and takes the whole-line Jev path.
 * Bounded to the API's 32KiB UTF-8 command limit and 16 nested wrappers/substitutions.
 */
export function commandLineNames(source, nesting = 0) {
  const names = new Set(); let i = 0, usesSudo = false, complete = true;
  const unknown = () => { complete = false; throw Error('Unknown command structure'); };
  const reserved = new Set(['if','then','else','elif','fi','for','while','until','do','done','case','esac','function','select','time','!','{','}']);
  function invocation(words, depth) {
    if (!words.length || nesting + depth > 16) unknown();
    const head = words[0];
    usesSudo ||= head.text.split('/').at(-1) === 'sudo';
    if (head.dynamic || !/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(head.text) || reserved.has(head.text)) unknown();
    names.add(head.text);
    if (head.text === 'sudo') {
      usesSudo = true; let n = 1;
      while (words[n]?.text.startsWith('-')) {
        if (words[n].dynamic) unknown();
        const flag = words[n++].text;
        if (flag === '--') break;
        if (['-n','--non-interactive','-H','-E','--preserve-env','-S','-k'].includes(flag)) continue;
        if (['-u','--user','-g','--group','-h','--host','-p','--prompt','-C','-T','-R','-D'].includes(flag)) { if (!words[n] || words[n].dynamic) unknown(); n++; continue; }
        if (/^--(?:user|group|host|prompt|preserve-env)=/.test(flag)) continue;
        if (['-l','--list','-v','--validate','-V','--version','--help'].includes(flag) && n === words.length) return;
        unknown();
      }
      if (n === words.length) unknown();
      invocation(words.slice(n), depth + 1); return;
    }
    if (['sh','bash','dash','zsh'].includes(head.text)) {
      let code = -1;
      for (let n=1; n<words.length && /^[+-]/.test(words[n].text); n++) {
        const flag=words[n]; if (flag.dynamic) unknown();
        if (flag.text==='--') break;
        if (['--noprofile','--norc','--posix','--restricted'].includes(flag.text)) continue;
        if (!/^[+-][abefhkmnprtuvxBCEHPTilrs]*c?[abefhkmnprtuvxBCEHPTilrs]*$/.test(flag.text) || flag.text.startsWith('+') && flag.text.includes('c')) unknown();
        if (flag.text.includes('c')) { code=n+1; break; }
      }
      if (code<0) return;
      if (!words[code] || words[code].dynamic || depth>=16) unknown();
      const inner = commandLineNames(words[code].text, nesting + depth + 1);
      for (const name of inner.names) names.add(name);
      usesSudo ||= inner.usesSudo;
      if (!inner.complete) unknown();
      return;
    }
    // Registered programs own their argument capabilities, including interpreters.
    // Only literal nested shell syntax above contributes additional shell names.
  }
  function word(depth) {
    let text = '', dynamic = false, quote = '', started = false;
    while (i < source.length) {
      const c = source[i];
      if (!quote && /[ \t;&|()<>]/.test(c)) break;
      started = true;
      if (c === "'" && quote !== '"') { quote = quote === "'" ? '' : "'"; i++; continue; }
      if (c === '"' && quote !== "'") { quote = quote === '"' ? '' : '"'; i++; continue; }
      if (c === '\\' && quote !== "'") {
        i++; if (i === source.length) unknown();
        if (quote === '"' && !['$','`','"','\\'].includes(source[i])) text += '\\';
        text += source[i++]; continue;
      }
      if (c === '$' && quote !== "'") {
        dynamic = true;
        if (source[i+1] === '(' && source[i+2] !== '(') { i += 2; line(depth+1, true); text += '<substitution>'; continue; }
        // Parameter/arithmetic expansion can itself contain executable syntax.
        if (['{','('].includes(source[i+1])) unknown();
        const variable = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(source.slice(i));
        if (!variable) unknown(); text += variable[0]; i += variable[0].length; continue;
      }
      if (c === '`' && quote !== "'") {
        const end = source.indexOf('`', i + 1); if (end < 0) unknown();
        const program = source.slice(i + 1, end); if (program.includes('\\')) unknown();
        const inner = commandLineNames(program, nesting + depth + 1);
        for (const name of inner.names) names.add(name); usesSudo ||= inner.usesSudo;
        if (!inner.complete) unknown(); dynamic = true; text += '<substitution>'; i = end + 1; continue;
      }
      if (!quote && /[*?\[\]{}~]/.test(c)) dynamic = true;
      text += c; i++;
    }
    if (!started || quote) unknown();
    return { text, dynamic };
  }
  function line(depth, nested = false) {
    if (depth > 16) unknown();
    let words = [], needCommand = true;
    const flush = () => { invocation(words, depth); words = []; needCommand = false; };
    while (i < source.length) {
      if (/[ \t]/.test(source[i])) { i++; continue; }
      if (source[i] === '#') { i = source.length; break; }
      if (source[i] === ')') {
        if (!nested) unknown(); if (words.length) flush(); if (needCommand) unknown(); i++; return;
      }
      if (source[i] === '(') unknown();
      const descriptor = /^[0-9]+(?=[<>])/.exec(source.slice(i));
      if (descriptor) { i += descriptor[0].length; continue; }
      if (/[;&|]/.test(source[i])) {
        if (!words.length) unknown(); flush();
        const operator = source[i++], doubled = source[i] === operator && operator !== ';'; if (doubled) i++;
        needCommand = doubled || operator === '|'; continue;
      }
      if (/[<>]/.test(source[i])) {
        // Preserve redirection as part of the approved command's effects; only
        // extract substitutions in the destination, never classify path risk.
        const operator = source[i++]; if (source[i] === operator) { if (operator === '<') unknown(); i++; }
        if (source[i] === '(' || source[i] === '&') unknown();
        while (/[ \t]/.test(source[i] ?? '') && i < source.length) i++;
        word(depth); continue;
      }
      words.push(word(depth)); needCommand = true;
    }
    if (nested) unknown();
    if (words.length) flush(); if (needCommand) unknown();
  }
  try { if (!utf8WithinLimit(source, COMMAND_MAX_BYTES) || !source.length || nesting > 16 || /[\r\n\0]/.test(source)) unknown(); line(0); }
  catch { complete = false; }
  return { names: [...names], complete: complete && names.size > 0, usesSudo };
}
