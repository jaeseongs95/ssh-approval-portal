/** Owner-only editor: command names and safety probability, never argument allowlists. */
export function createCommandPolicyEditor({ document, api, error }) {
  if (document.body.dataset.commandAutomation !== 'true') return;
  const root = document.createElement('details'); root.className = 'request';
  const heading = document.createElement('summary'); heading.textContent = '명령 자동 실행 정책'; root.append(heading);
  const note = document.createElement('p'); note.textContent = '명령셋은 이름만 매칭합니다. 위험도 피드백을 확인하고 OK 해야 등록됩니다. 등록된 명령은 Jev에 사용자가 명시적으로 승인한 것으로 전달합니다. Jev는 보조 도구이며 기존 실행 권한을 늘리지 않습니다. 안전 확률 기준은 0.9로 설정할 수 있으며 별도 confidence 문턱은 없습니다.'; root.append(note);
  const form = document.createElement('form'); root.append(form);
  const field = (label, tag = 'input', type = 'text') => {
    const box = document.createElement('label'); box.style.display = 'block'; box.textContent = label + ' ';
    const input = document.createElement(tag); if (tag === 'input') input.type = type;
    box.append(input); form.append(box); return input;
  };
  const target = field('대상 서버', 'select'), commands = field('사전 승인 명령 이름 — 줄마다 하나', 'textarea');
  const denied = field('금지할 명령 이름 — 줄마다 하나', 'textarea');
  const disclosure = field('외부 평가에 명령·대상 맥락·사용자 명시적 승인과 명령셋 전송 허용', 'input', 'checkbox');
  const execution = field('검증한 점수 기준으로 모델 자동 실행 활성화', 'input', 'checkbox');
  const fallback = field('Jev 평가 불가 시 대체 평가자', 'select');
  for (const [value, label] of [['', '없음'], ['luna', 'Luna'], ['sonnet', 'Sonnet']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; fallback.append(option); }
  const scores = {};
  for (const provider of ['jev', 'luna', 'sonnet']) {
    const model = field(`${provider} 모델 ID`), probability = field(`${provider} 최소 안전 확률 (0~1)`, 'input', 'number');
    const evidence = field(`${provider} 기준 근거 참조`);
    probability.min = '0'; probability.max = '1'; probability.step = 'any'; probability.placeholder = '0.9';
    scores[provider] = { model, probability, evidence };
  }
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = '정책 불러오기'; root.insertBefore(refresh, form);
  const reviewButton = document.createElement('button'); reviewButton.type = 'button'; reviewButton.textContent = '위험도 확인'; form.append(reviewButton);
  const feedback = document.createElement('div'); feedback.setAttribute('aria-live', 'polite'); form.append(feedback);
  const acknowledged = field('위험도 피드백을 확인했고 등록에 동의합니다 (OK)', 'input', 'checkbox'); acknowledged.disabled = true;
  const save = document.createElement('button'); save.type = 'submit'; save.textContent = '정책 저장'; save.disabled = true; form.append(save);
  const status = document.createElement('p'); status.setAttribute('aria-live', 'polite'); root.append(status);
  document.getElementById('updated').before(root); form.hidden = true;
  let snapshot, review, editRevision = 0;
  const invalidate = () => { editRevision++; review = undefined; acknowledged.checked = false; acknowledged.disabled = true; save.disabled = true; feedback.replaceChildren(); };
  form.oninput = event => { if (event.target !== acknowledged) invalidate(); };
  acknowledged.onchange = () => {
    if (review && Date.now() >= review.expiresAt) { invalidate(); error('피드백이 만료됐습니다. 위험도를 다시 확인하세요.'); return; }
    save.disabled = !review || !acknowledged.checked;
  };
  const names = input => input.value.split(/\s+/).filter(Boolean);
  const show = () => {
    invalidate();
    const rule = snapshot.targets.find(item => item.targetId === target.value);
    commands.value = (rule?.commands ?? []).join('\n'); denied.value = (rule?.deniedCommands ?? []).join('\n');
    disclosure.checked = rule?.externalDisclosure ?? false; execution.checked = rule?.modelExecution ?? false; fallback.value = rule?.fallback ?? '';
    for (const [provider, inputs] of Object.entries(scores)) {
      const threshold = rule?.thresholds[provider];
      inputs.model.value = threshold?.model ?? (provider === 'jev' ? 'jev-1.13.0' : '');
      inputs.probability.value = threshold?.minLowRisk ?? ''; inputs.evidence.value = threshold?.validationRef ?? '';
    }
  };
  target.onchange = show;
  refresh.onclick = async () => {
    refresh.disabled = true;
    try {
      snapshot = await api('/api/command-policy'); target.replaceChildren();
      for (const binding of snapshot.bindings) { const option = document.createElement('option'); option.value = binding.targetId; option.textContent = binding.displayName; target.append(option); }
      form.hidden = false; show(); status.textContent = `정책 revision ${snapshot.revision}`;
    } catch (failure) { error(failure.message); } finally { refresh.disabled = false; }
  };
  const proposal = () => {
      const binding = snapshot.bindings.find(item => item.targetId === target.value), thresholds = {};
      for (const [provider, inputs] of Object.entries(scores)) {
        if (!inputs.probability.value && !inputs.evidence.value) continue;
        const prior = snapshot.targets.find(item => item.targetId === target.value)?.thresholds[provider];
        if (prior && (prior.questionVersion !== 'ssh-command-risk-v3' || prior.basis !== 'safety-probability-v1') && inputs.evidence.value === prior.validationRef) throw Error('안전 확률 기준으로 재등록하려면 새 기준 근거 참조가 필요합니다.');
        thresholds[provider] = { model: inputs.model.value, questionVersion: 'ssh-command-risk-v3', basis: 'safety-probability-v1',
          minLowRisk: Number(inputs.probability.value), validationRef: inputs.evidence.value };
      }
      const rule = { targetId: binding.targetId, targetRevision: binding.targetRevision, profile: binding.profile,
        commands: names(commands), deniedCommands: names(denied), externalDisclosure: disclosure.checked, modelExecution: execution.checked,
        fallback: fallback.value || null, thresholds };
      return { expectedRevision: snapshot.revision, policy: { targets: [...snapshot.targets.filter(item => item.targetId !== binding.targetId), rule] } };
  };
  reviewButton.onclick = async () => {
    if (!snapshot) return;
    invalidate(); const revision = editRevision; reviewButton.disabled = true;
    try {
      const result = await api('/api/command-policy/review', 'POST', proposal());
      if (revision !== editRevision) return;
      review = result;
      const add = value => { const line = document.createElement('p'); line.textContent = value; feedback.append(line); };
      add(result.notice);
      for (const item of result.feedback) {
        const labels = { low_risk: '낮음', high_risk: '높음', uncertain: '판단 불충분' };
        add(`${item.targetId} · 위험도 ${labels[item.level]} · ${item.commands.join(', ') || '(빈 명령셋)'}`);
        if (item.assessment) add(`Jev 판정 ${labels[item.assessment.label]} · 안전 확률 ${item.assessment.probabilities.low_risk} · 참고 confidence ${item.assessment.confidence}`);
        else add('Jev 평가가 제공되지 않았습니다. 안전하다는 뜻이 아닙니다.');
        add(item.warning);
      }
      acknowledged.disabled = false;
    } catch (failure) { error(failure.message); } finally { reviewButton.disabled = false; }
  };
  form.onsubmit = async event => {
    event.preventDefault(); if (!snapshot || !review || !acknowledged.checked) return; save.disabled = true;
    try {
      await api('/api/command-policy', 'POST', { ...proposal(), reviewToken: review.reviewToken, acknowledged: true });
      await refresh.onclick(); status.textContent += ' · 저장됨';
    } catch (failure) { error(failure.message); invalidate(); }
  };
}
