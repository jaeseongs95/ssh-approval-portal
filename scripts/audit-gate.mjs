/** Deployment reports must contain one final Gate, independent of test-result prose. */
export function requireAuditPass(report) {
  const refuse = () => { throw Error('Independent audit gate must be one unambiguous PASS'); };
  if (typeof report !== 'string' || report.length > 262144) refuse();
  const headings = [...report.matchAll(/^##[ \t]+Gate[ \t]*\r?$/gm)];
  if (headings.length !== 1) refuse();
  const remaining = report.slice(headings[0].index + headings[0][0].length);
  const boundary = remaining.search(/^#{1,2}[ \t]+/m);
  const section = (boundary < 0 ? remaining : remaining.slice(0, boundary)).replace(/[*_`]/g, '').trim();
  const verdicts = section.match(/\b(?:PASS|FAIL|BLOCKED)\b/g) ?? [];
  if (verdicts.length !== 1 || verdicts[0] !== 'PASS' || !/^PASS(?:\s*(?:[-—:·]|$))/.test(section.split(/\r?\n/)[0])) refuse();
  return 'PASS';
}
