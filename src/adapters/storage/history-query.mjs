import { COMMAND_REQUEST_MAX_BYTES } from '../../contracts/ports.mjs';

// 기존 연결만 읽는다. 모든 본문을 복제하지 않고 후보의 공개 메타데이터만 순회한다.
export function journalHistoryReader(db) {
  const fields = ['kind', 'state', 'createdAt', 'targetId', 'targetRevision', 'profile', 'command', 'targetDisplayName'];
  const cli = ['agentCliContract', 'agentCliTargetId', 'agentCliTargetRevision', 'agentCliProfile', 'agentCliProvider'];
  const projection = [...fields.map(key => `CASE WHEN json_valid(body) THEN json_extract(body,'$.${key}') END AS ${key}`),
    ...cli.map(key => `CASE WHEN json_valid(body) THEN json_extract(body,'$.operation.${key}') END AS ${key}`)].join(',');
  return {
    *historyRows() {
      let count = 0;
      for (const row of db.prepare(`SELECT id,${projection} FROM requests`).iterate()) {
        if (++count > 10000) throw Error('History journal budget exceeded');
        yield row;
      }
    },
    historyJob(id) {
      const row = db.prepare('SELECT length(CAST(body AS BLOB)) AS bytes, CASE WHEN length(CAST(body AS BLOB))<=? THEN body END AS body FROM requests WHERE id=?').get(COMMAND_REQUEST_MAX_BYTES, id);
      if (!row) throw Error('History entry unavailable');
      if (!row.body) throw Object.assign(Error('History entry exceeds response budget'), { historyCode: 'HISTORY_ENTRY_TOO_LARGE', status: 413 });
      return JSON.parse(row.body);
    },
  };
}
