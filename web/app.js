const el = id => document.getElementById(id);
async function api(path, method = 'GET') {
  const r = await fetch(path, { method, headers: { Authorization: 'Bearer ' + el('token').value } });
  const value = await r.json(); if (!r.ok) throw Error(value.error ?? '요청 실패'); return value;
}
async function load() {
  try {
    const jobs = await api('/api/requests'); el('jobs').replaceChildren();
    for (const job of jobs.reverse()) {
      const box = document.createElement('article'), title = document.createElement('p'), details = document.createElement('pre');
      title.textContent = `${job.target} · ${job.kind} · ${job.state} · ${job.id}`;
      details.textContent = job.kind === 'command' ? job.command : JSON.stringify(job.operation, null, 2);
      box.append(title, details);
      if (job.state === 'pending') for (const action of ['approve', 'deny']) {
        const b = document.createElement('button'); b.textContent = action === 'approve' ? '승인·실행' : '거부';
        b.onclick = async () => { b.disabled = true; try { await api(`/api/${job.id}/${action}`, 'POST'); await load(); } catch (e) { title.textContent = e.message; b.disabled = false; } }; box.append(b);
      }
      if (job.result) { const result = document.createElement('pre'); result.textContent = JSON.stringify(job.result, null, 2); box.append(result); }
      if (job.state === 'completed' && job.kind === 'download') {
        const b = document.createElement('button'); b.textContent = '파일 저장'; b.onclick = async () => {
          try { const r = await api(`/api/${job.id}/download`, 'POST'); location.assign(r.downloadUrl); } catch (e) { title.textContent = e.message; }
        }; box.append(b);
      }
      el('jobs').append(box);
    }
  } catch (e) { el('jobs').textContent = e.message; }
}
el('load').onclick = load;
