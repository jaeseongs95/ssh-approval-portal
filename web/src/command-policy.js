/** Owner-only editor: command names and measured thresholds, never argument allowlists. */
export function createCommandPolicyEditor({ document, api, error }) {
  if (document.body.dataset.commandAutomation !== 'true') return;
  const root = document.createElement('details'); root.className = 'request';
  const heading = document.createElement('summary'); heading.textContent = '명령 자동 실행 정책'; root.append(heading);
  const note = document.createElement('p'); note.textContent = '명령셋은 이름만 매칭합니다. 위험 징후가 있으면 전체 실행문을 평가합니다. 모델 점수는 실측 후 설정하세요.'; root.append(note);
  const form = document.createElement('form'); root.append(form);
  const field = (label, tag = 'input', type = 'text') => {
    const box = document.createElement('label'); box.style.display = 'block'; box.textContent = label + ' ';
    const input = document.createElement(tag); if (tag === 'input') input.type = type;
    box.append(input); form.append(box); return input;
  };
  const target = field('대상 서버', 'select'), commands = field('사전 승인 명령 이름 — 줄마다 하나', 'textarea');
  const denied = field('금지할 명령 이름 — 줄마다 하나', 'textarea');
  const disclosure = field('외부 평가에 명령·대상 맥락 전송 허용', 'input', 'checkbox');
  const execution = field('검증한 점수 기준으로 모델 자동 실행 활성화', 'input', 'checkbox');
  const fallback = field('Jev 평가 불가 시 대체 평가자', 'select');
  for (const [value, label] of [['', '없음'], ['luna', 'Luna'], ['sonnet', 'Sonnet']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; fallback.append(option); }
  const scores = {};
  for (const provider of ['jev', 'luna', 'sonnet']) {
    const model = field(`${provider} 검증한 모델 ID`), probability = field(`${provider} 최소 안전 점수 (0~1)`, 'input', 'number');
    const confidence = field(`${provider} 최소 confidence (0~1)`, 'input', 'number'), evidence = field(`${provider} 검증 보고서 참조`);
    for (const input of [probability, confidence]) { input.min = '0'; input.max = '1'; input.step = 'any'; }
    scores[provider] = { model, probability, confidence, evidence };
  }
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = '정책 불러오기'; root.insertBefore(refresh, form);
  const save = document.createElement('button'); save.type = 'submit'; save.textContent = '정책 저장'; form.append(save);
  const status = document.createElement('p'); status.setAttribute('aria-live', 'polite'); root.append(status);
  document.getElementById('updated').before(root); form.hidden = true;
  let snapshot;
  const names = input => input.value.split(/\s+/).filter(Boolean);
  const show = () => {
    const rule = snapshot.targets.find(item => item.targetId === target.value);
    commands.value = (rule?.commands ?? []).join('\n'); denied.value = (rule?.deniedCommands ?? []).join('\n');
    disclosure.checked = rule?.externalDisclosure ?? false; execution.checked = rule?.modelExecution ?? false; fallback.value = rule?.fallback ?? '';
    for (const [provider, inputs] of Object.entries(scores)) {
      const threshold = rule?.thresholds[provider];
      inputs.model.value = threshold?.model ?? (provider === 'jev' ? 'jev-1.13.0' : '');
      inputs.probability.value = threshold?.minLowRisk ?? ''; inputs.confidence.value = threshold?.minConfidence ?? ''; inputs.evidence.value = threshold?.validationRef ?? '';
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
  form.onsubmit = async event => {
    event.preventDefault(); if (!snapshot) return; save.disabled = true;
    try {
      const binding = snapshot.bindings.find(item => item.targetId === target.value), thresholds = {};
      for (const [provider, inputs] of Object.entries(scores)) {
        if (!inputs.probability.value && !inputs.confidence.value && !inputs.evidence.value) continue;
        thresholds[provider] = { model: inputs.model.value, questionVersion: 'ssh-command-risk-v2',
          minLowRisk: Number(inputs.probability.value), minConfidence: Number(inputs.confidence.value), validationRef: inputs.evidence.value };
      }
      const rule = { targetId: binding.targetId, targetRevision: binding.targetRevision, profile: binding.profile,
        commands: names(commands), deniedCommands: names(denied), externalDisclosure: disclosure.checked, modelExecution: execution.checked,
        fallback: fallback.value || null, thresholds };
      await api('/api/command-policy', 'POST', { expectedRevision: snapshot.revision,
        policy: { targets: [...snapshot.targets.filter(item => item.targetId !== binding.targetId), rule] } });
      await refresh.onclick(); status.textContent += ' · 저장됨';
    } catch (failure) { error(failure.message); } finally { save.disabled = false; }
  };
}
