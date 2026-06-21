// 톱니질문 트랙 — 실시간(전체 모드) 저장 어댑터. 수업 코드(?code=)로 들어온 학생이 gear 스키마 RPC로만 접근하고 board()를 폴링한다. 개인 모드는 이 파일을 로드하지 않음(오프라인 보장)
"use strict";

// app.js가 supabase-js·config.js 로드 후 호출.
//   GQT_makeSupabaseAdapter({ code, config, host })
//   host = { onBoard(board), announce(msg), busy() -> bool }   ── board = gear.board() 반환 JSON
// 패턴: 모든 쓰기는 "RPC → 즉시 poll(force)"로 서버 보드를 진실원천으로 다시 렌더(낙관적 로컬 변경·임시 id 없음).
window.GQT_makeSupabaseAdapter = function ({ code, config, host, groupNo }) {
  const POLL_MS = 2500;
  const client = window.supabase.createClient(config.url, config.anonKey);
  const db = client.schema(config.schema);   // 'gear'
  let timer = null, lastJson = "", pending = null, disposed = false;
  let gNo = (groupNo != null) ? groupNo : null;   // 모둠 번호(전체 모드는 null). 피커 경로는 setGroup으로 후입력

  // RPC가 raise한 한국어 메시지를 그대로 보이게 (잠금·잘못된 코드 등). 없으면 일반 안내
  function msgOf(error) {
    return (error && (error.message || error.hint || error.details)) || "연결에 문제가 있어요.";
  }

  async function fetchBoard() {
    const { data, error } = await db.rpc("board", { p_code: code });
    if (error) throw error;          // 잘못된/닫힌 코드 → P0002 throw
    return data;
  }

  // 폴링 1회 — 변경이 있고 사용자가 바쁘지 않으면 반영, 바쁘면(드래그·집기 중) stash 후 flush()에서 적용
  async function poll(force) {
    if (disposed) return;
    let data;
    try { data = await fetchBoard(); }
    catch (e) { return; }            // 일시 단절은 조용히 다음 폴링에 재시도(마지막 보드 유지)
    const s = JSON.stringify(data);
    if (s === lastJson) return;
    lastJson = s;
    if (!force && host.busy && host.busy()) { pending = data; return; }
    pending = null;
    host.onBoard(data);
  }

  // 쓰기 한 단위: RPC 성공 → 즉시 force 폴링으로 서버 반영분 렌더
  async function write(run) {
    try { await run(); await poll(true); return { ok: true }; }
    catch (e) { if (host.announce) host.announce(msgOf(e)); return { ok: false, why: "rpc" }; }
  }
  const ok = r => { if (r.error) throw r.error; };

  return {
    remote: true,
    get groupNo() { return gNo; },
    setGroup(n) { gNo = n; },

    async init() {
      const data = await fetchBoard();          // 코드 검증(throw 시 startRemote가 안내)
      lastJson = JSON.stringify(data);
      host.onBoard(data);
      timer = setInterval(() => poll(false), POLL_MS);
    },

    addQuestion(text) {
      return write(() => db.rpc("add_question", { p_code: code, p_text: text, p_group_no: gNo }).then(ok));
    },
    setType(id, type) {
      return write(() => db.rpc("set_question_type", { p_code: code, p_qid: id, p_type: type }).then(ok));
    },
    deleteQuestion(id) {
      return write(() => db.rpc("delete_question", { p_code: code, p_qid: id }).then(ok));
    },
    // 공유 장면(전체) — 서버가 '비어 있을 때만' 반영
    setScene(text) {
      return write(() => db.rpc("set_scene", { p_code: code, p_text: text }).then(ok));
    },
    // 모둠 장면(모둠) — 내 모둠 장면, '비어 있을 때만' 반영
    setGroupScene(text) {
      return write(() => db.rpc("set_group_scene", { p_code: code, p_group_no: gNo, p_text: text }).then(ok));
    },
    // ③ 잇기 — 실 식별자(threadId) 기준 저장(slot LWW, 다리는 포커스 가드). threadId 없으면 새 실 생성
    saveThread(threadId, slots, bridges) {
      return write(() => db.rpc("save_thread", { p_code: code, p_thread_id: threadId || null, p_slots: slots, p_bridges: bridges, p_group_no: gNo }).then(ok));
    },
    // 새 실 생성 → 새 실 id 반환(클라가 활성 실로 지정)
    async addThread() {
      try {
        const r = await db.rpc("save_thread", { p_code: code, p_thread_id: null, p_slots: { fact: null, infer: null, imagine: null }, p_bridges: { fact: "", infer: "" }, p_group_no: gNo });
        if (r.error) throw r.error;
        await poll(true);
        return r.data;   // 새 실 id
      } catch (e) { if (host.announce) host.announce(msgOf(e)); return null; }
    },
    deleteThread(threadId) {
      return write(() => db.rpc("delete_thread", { p_code: code, p_thread_id: threadId }).then(ok));
    },

    // 드래그·집기 끝나 idle이 되면 stash해 둔 보드를 반영
    flush() { if (pending) { const b = pending; pending = null; host.onBoard(b); } },
    dispose() { disposed = true; if (timer) clearInterval(timer); timer = null; }
  };
};
