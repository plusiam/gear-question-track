// 톱니질문 트랙 — 상태(단일 진실원천)·렌더·3단계 상호작용·저장/내보내기 로직
"use strict";
// ===== 상수 (콘텐츠 무관, 앱 내장) =====
const LS_KEY = "gqt:v1";
const TYPES = ["fact", "infer", "imagine"];
const KO = { fact: "사실", infer: "추론", imagine: "상상" };
const HINT = { fact: "책에 그대로", infer: "책 바탕 추론", imagine: "책 넘어 상상" };
// 다리(bridge)는 출발 소켓 키: fact=사실→추론, infer=추론→상상
const CONNECTOR = { fact: "그렇다면 왜?", infer: "그 마음이 맞다면, 그때는?" };
const MAXLEN = 80;

// ===== 상태 (단일 진실원천) =====
function newThread(id) { return { id, slots: { fact: null, infer: null, imagine: null }, bridges: { fact: "", infer: "" } }; }
function freshState() {
  return { version: 1, seq: 0, phase: "create", title: "", scene: "",
    questions: [], threads: [newThread("th1")], activeThreadId: "th1" };
}
let S = freshState();
let selectedId = null; // picking 상태(저장 안 함)
let isDragging = false; // 드래그 중(폴링 클로버 가드용 — 저장 안 함)
let appReady = false;  // 초기 렌더 끝나야 true — 복원된 완성 상태에서 로드 시 효과음 울리지 않게
let soundOn = true;
let roomCode = null;   // 실시간 방 코드(모둠 선택 저장 키)
let lastBoard = null;  // 마지막 board(모둠 선택 후 재투영용)
let bridgeSaveTimer = null; // 모둠 ③ 다리 저장 디바운스

const activeThread = () => S.threads.find(t => t.id === S.activeThreadId) || S.threads[0];
const qById = id => S.questions.find(q => q.id === id);

// ===== 저장 / 복원 — storage adapter 경유 (개인=Local·현행 / 공유=Supabase는 P2) =====
// 모든 mutator는 save()만 부른다. 모드별 저장처는 adapter 한 곳에서 갈린다.
const LocalAdapter = {
  remote: false,
  load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (o && o.version === 1 && Array.isArray(o.questions)) return o;
    } catch (e) { /* 손상 JSON → graceful reset */ }
    return null;
  },
  push(state) { try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* 용량/프라이빗 모드 무시 */ } },
  onRemoteChange() {},   // 개인 모드는 원격 변경 없음
  dispose() {}
};
let adapter = LocalAdapter;   // 실시간(?code=)이면 startRemote에서 SupabaseAdapter로 교체
// 실시간 모드는 서버 RPC가 저장을 맡으므로 로컬 push를 건너뛴다(단일 차단점 — 모든 로컬 mutator가 안전해짐)
function save() { if (adapter.remote) return; adapter.push(S); }
function loadSaved() { return adapter.load(); }
const hasContent = st => st && (st.title || st.scene || (st.questions && st.questions.length));

// 외부/저장 상태를 현재 상태로 안전하게 채택(정규화 — 손상·부분 데이터 방어)
function adoptState(o) {
  S = o;
  S.version = 1;
  S.title = S.title || ""; S.scene = S.scene || "";
  S.questions = Array.isArray(S.questions) ? S.questions.filter(q => q && q.id && typeof q.text === "string") : [];
  S.threads = (Array.isArray(S.threads) && S.threads.length ? S.threads : [newThread("th1")]).map(t => ({
    id: t.id || "th1",
    slots: Object.assign({ fact: null, infer: null, imagine: null }, t.slots || {}),
    bridges: Object.assign({ fact: "", infer: "" }, t.bridges || {})
  }));
  S.activeThreadId = S.threads.find(t => t.id === S.activeThreadId) ? S.activeThreadId : S.threads[0].id;
  S.phase = ["create", "classify", "connect"].includes(S.phase) ? S.phase : "create";
  S.seq = S.seq || S.questions.reduce((m, q) => Math.max(m, +(String(q.id).slice(1)) || 0), 0);
}

// ===== 순수 mutator (각자 저장) =====
// 실시간 모드에서 title·scene은 교사 소유(읽기 전용)
function setTitle(v) { if (adapter.remote) return; S.title = v; save(); }
function setScene(v) { if (adapter.remote) return; S.scene = v; save(); }
function setPhase(p) { S.phase = p; save(); render(); }

// 질문 입력 검증(빈/길이/중복) — 로컬·실시간 양쪽이 공유
function qValidation(text) {
  const t = (text || "").trim();
  if (!t) return { ok: false, why: "empty" };
  if (t.length > MAXLEN) return { ok: false, why: "long" };
  if (S.questions.some(q => q.text === t)) return { ok: false, why: "dup" };
  return { ok: true, t };
}
function addQuestion(text) {
  const v = qValidation(text);
  if (!v.ok) return v;
  S.questions.push({ id: "q" + (++S.seq), text: v.t, type: null });
  save(); render();
  return { ok: true };
}
function deleteQuestion(id) {
  if (adapter.remote) { if (selectedId === id) selectedId = null; adapter.deleteQuestion(id); return; }
  S.questions = S.questions.filter(q => q.id !== id);
  // 참조 무결성 ⒜ : 삭제된 질문을 참조하는 슬롯 비우기
  S.threads.forEach(th => TYPES.forEach(k => { if (th.slots[k] === id) th.slots[k] = null; }));
  if (selectedId === id) selectedId = null;
  save(); render();
}
function setType(id, type) {
  if (adapter.remote) { adapter.setType(id, type); return; }
  const q = qById(id); if (!q) return;
  q.type = type;
  // 참조 무결성 ⒝ : 이미 슬롯에 꽂힌 질문이 유형이 바뀌면 그 슬롯에서 뺀다(유형 불일치)
  S.threads.forEach(th => TYPES.forEach(k => { if (th.slots[k] === id && k !== type) th.slots[k] = null; }));
  save(); render();
}
function setSlot(type, id) {
  if (adapter.remote && adapter.groupNo == null) return; // 전체 모드엔 ③ 없음
  const th = activeThread();
  if (id) {
    const q = qById(id);
    if (!q || q.type !== type) return; // 유형 맞는 카드만
    // 같은 질문이 다른 슬롯에 있었다면 제거(중복 방지)
    TYPES.forEach(k => { if (th.slots[k] === id) th.slots[k] = null; });
  }
  th.slots[type] = id;
  if (adapter.remote) { adapter.saveThread(th.slots, th.bridges); render(); return; } // 모둠: 실 통째로 저장(slot은 LWW)
  save(); render();
}
function setBridge(srcSlot, text) {
  if (adapter.remote && adapter.groupNo == null) return; // 전체 모드엔 ③ 없음
  const th = activeThread();
  th.bridges[srcSlot] = text;                            // 낙관적 로컬(입력칸은 그대로)
  if (adapter.remote) { clearTimeout(bridgeSaveTimer); bridgeSaveTimer = setTimeout(() => adapter.saveThread(th.slots, th.bridges), 500); return; }
  save();
}
function resetAll() { if (adapter.remote) return; S = freshState(); selectedId = null; save(); syncInputs(); render(); }

// JSON 결과 내보내기 / 불러오기 (학생 작성 결과 전체)
function downloadJson() {
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.download = ((S.title || "톱니질문").replace(/[\\/:*?"<>|]+/g, "_")) + ".json";
  a.href = url; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce("결과를 파일(.json)로 저장했어요.");
}
function importJsonText(text) {
  if (adapter.remote) { announce("실시간 방에서는 불러오기를 쓸 수 없어요."); return false; }
  let o; try { o = JSON.parse(text); } catch (e) { announce("불러올 수 없는 파일이에요."); return false; }
  if (!o || o.version !== 1 || !Array.isArray(o.questions)) { announce("이 도구의 결과 파일이 아니에요."); return false; }
  if (hasContent(S) && !confirm("지금 내용을 덮어쓰고 불러올까요?")) return false;
  adoptState(o); clearSelect(); save(); syncInputs(); updCounter(); render();
  announce("결과를 불러왔어요."); return true;
}
function importJsonFile(file) {
  const r = new FileReader();
  r.onload = () => importJsonText(r.result);
  r.onerror = () => announce("파일을 읽지 못했어요.");
  r.readAsText(file);
}

// ===== 보조 =====
let toastTimer = null;
function announce(m) {
  document.getElementById("liveRegion").textContent = m;       // 스크린리더
  const t = document.getElementById("toast");                  // 화면에 보이는 확인
  t.textContent = m; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
}
let audioCtx = null;
function blip() {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "triangle"; o.frequency.value = 560;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.15);
    o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.16);
  } catch (e) {}
}

// 카드 DOM 생성 (질문 텍스트는 textContent — 학생 입력 주입 방지)
function makeCard(q, opts = {}) {
  const el = document.createElement("div");
  el.className = "card";
  el.dataset.id = q.id;
  el.dataset.type = q.type || "null";
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  const labKo = q.type ? KO[q.type] : "안 나눔";
  el.setAttribute("aria-label", `${labKo} 질문: ${q.text}`);
  const lab = document.createElement("span");
  lab.className = "c-label lab-" + (q.type || "null");
  lab.textContent = labKo;
  const txt = document.createElement("span");
  txt.className = "c-text"; txt.textContent = q.text;
  el.append(lab, txt);
  if (opts.deletable) {
    const del = document.createElement("button");
    del.className = "c-del"; del.type = "button"; del.textContent = "✕";
    del.setAttribute("aria-label", "이 질문 지우기");
    del.addEventListener("click", e => { e.stopPropagation(); deleteQuestion(q.id); announce("질문을 지웠어요."); });
    el.appendChild(del);
  }
  if (opts.pickable) bindPick(el, q.id, { onTap: opts.onTap });
  if (opts.onClick) {
    el.addEventListener("click", opts.onClick);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opts.onClick(); } });
  }
  return el;
}

// ===== 렌더 =====
function render() {
  // 스텝퍼·패널
  document.querySelectorAll(".stepper button").forEach(b =>
    b.setAttribute("aria-current", String(b.dataset.phase === S.phase)));
  document.querySelectorAll(".panel").forEach(p =>
    p.classList.toggle("active", p.id === "panel-" + S.phase));
  if (S.phase === "create") renderCreate();
  else if (S.phase === "classify") renderClassify();
  else renderConnect();
}

function renderCreate() {
  document.getElementById("scene-show").textContent = S.scene || "";
  const list = document.getElementById("create-list");
  list.textContent = "";
  if (!S.questions.length) {
    const n = document.createElement("div"); n.className = "empty-note";
    n.textContent = "아직 만든 질문이 없어요. 위에 적어서 추가해요.";
    list.appendChild(n); return;
  }
  // 실시간(공유 발산) 모드에선 남의 질문 삭제 방지 — 삭제 버튼 숨김
  S.questions.forEach(q => list.appendChild(makeCard(q, { deletable: !adapter.remote })));
}

function renderClassify() {
  const unsortedWrap = document.getElementById("classify-unsorted");
  unsortedWrap.textContent = "";
  const h = document.createElement("h3"); h.textContent = "아직 안 나눈 질문";
  unsortedWrap.appendChild(h);
  const unsorted = S.questions.filter(q => !q.type);
  if (!unsorted.length) {
    const n = document.createElement("div"); n.className = "empty-note";
    n.textContent = S.questions.length ? "다 나눴어요! ③ 잇기로 가요." : "① 만들기에서 질문을 먼저 만들어요.";
    unsortedWrap.appendChild(n);
  } else {
    const box = document.createElement("div"); box.className = "list";
    unsorted.forEach(q => box.appendChild(makeCard(q, { pickable: true })));
    unsortedWrap.appendChild(box);
  }
  const cols = document.getElementById("classify-cols");
  cols.textContent = "";
  TYPES.forEach(type => {
    const col = document.createElement("div");
    col.className = "col"; col.dataset.type = type; col.tabIndex = 0; col.setAttribute("role", "button");
    col.setAttribute("aria-label", `${KO[type]} 칸`);
    const head = document.createElement("div"); head.className = "col-head";
    head.innerHTML = `<span>${KO[type]}</span>`;
    const hint = document.createElement("div"); hint.className = "col-hint"; hint.textContent = HINT[type];
    const body = document.createElement("div"); body.className = "col-body";
    S.questions.filter(q => q.type === type).forEach(q => body.appendChild(makeCard(q, { pickable: true })));
    col.append(head, hint, body);
    bindDrop(col, type, "classify");
    cols.appendChild(col);
  });
}

function renderConnect() {
  const th = activeThread();
  document.getElementById("export-title").textContent = S.title ? ("📖 " + S.title) : "";
  const track = document.getElementById("connect-track");
  track.textContent = "";
  TYPES.forEach((type, i) => {
    const sk = document.createElement("div");
    sk.className = "socket"; sk.dataset.type = type; sk.tabIndex = 0; sk.setAttribute("role", "button");
    const filled = th.slots[type];
    sk.setAttribute("aria-label", `${KO[type]} 소켓, ${filled ? "채워짐" : "비어 있음"}`);
    if (filled) sk.classList.add("snapped");
    const head = document.createElement("div"); head.className = "sk-head";
    head.innerHTML = `<span class="gear" aria-hidden="true">⚙</span><span>${["①","②","③"][i]} ${KO[type]}</span>`;
    const hint = document.createElement("div"); hint.className = "sk-hint"; hint.textContent = HINT[type];
    const body = document.createElement("div"); body.className = "sk-body";
    if (filled) {
      const q = qById(filled);
      if (q) body.appendChild(makeCard(q, { onClick: () => { setSlot(type, null); announce(`${KO[type]} 소켓을 비웠어요.`); } }));
    } else {
      const n = document.createElement("div"); n.className = "empty-note"; n.textContent = "여기에 끼워요"; body.appendChild(n);
    }
    sk.append(head, hint, body);
    bindDrop(sk, type, "connect");
    track.appendChild(sk);
    // 소켓 사이 다리(마지막 뒤엔 없음)
    if (i < TYPES.length - 1) {
      const br = document.createElement("div"); br.className = "bridge";
      const conn = document.createElement("div"); conn.className = "conn"; conn.textContent = "↳ " + CONNECTOR[type];
      const inp = document.createElement("input"); inp.type = "text"; inp.placeholder = "다리 한 줄 (선택)";
      inp.value = th.bridges[type] || ""; inp.setAttribute("aria-label", `${KO[type]}에서 다음으로 잇는 다리 한 줄`);
      inp.addEventListener("input", e => setBridge(type, e.target.value));
      // 모둠 ③: 다 적고 바깥을 누르면 최종 저장(디바운스 취소) + 폴링 재반영
      inp.addEventListener("blur", () => { if (adapter.remote && adapter.groupNo != null) { clearTimeout(bridgeSaveTimer); adapter.saveThread(activeThread().slots, activeThread().bridges); } });
      br.append(conn, inp); track.appendChild(br);
    }
  });
  // 완성 배너 + 효과
  const complete = TYPES.every(t => th.slots[t]);
  const banner = document.getElementById("doneBanner");
  banner.classList.toggle("show", complete);
  if (complete && !render._wasComplete && appReady) { blip(); announce("세 톱니가 모두 채워졌어요. 한 실 완성!"); }
  render._wasComplete = complete;

  // 고를 수 있는 풀 (분류된 것, 슬롯에 든 건 제외)
  const pool = document.getElementById("connect-pool");
  pool.textContent = "";
  TYPES.forEach(type => {
    const pcol = document.createElement("div"); pcol.className = "pcol";
    const h = document.createElement("h3");
    h.innerHTML = `<span class="c-label lab-${type}">${KO[type]}</span>`;
    pcol.appendChild(h);
    const avail = S.questions.filter(q => q.type === type && th.slots[type] !== q.id);
    if (!avail.length) {
      const n = document.createElement("div"); n.className = "empty-note";
      n.textContent = `${KO[type]} 질문이 아직 없어요`;
      pcol.appendChild(n);
    } else {
      const box = document.createElement("div"); box.className = "list";
      avail.forEach(q => box.appendChild(makeCard(q, {
        pickable: true,
        onTap: () => { setSlot(type, q.id); blip(); announce(`${KO[type]} 질문을 끼웠어요.`); }
      })));
      pcol.appendChild(box);
    }
    pool.appendChild(pcol);
  });
}

// ===== pick→place (탭 2단계 + 키보드 + 드래그) — 분류/잇기 공용 =====
function selectCard(id) {
  clearSelect();
  selectedId = id;
  document.querySelectorAll(`.card[data-id="${id}"]`).forEach(el => el.classList.add("selected"));
  document.querySelectorAll(".col, .socket").forEach(z => { if (acceptable(z, id)) z.classList.add("droppable"); });
  announce("질문을 집었어요. 들어갈 칸을 누르세요.");
}
function clearSelect() {
  selectedId = null;
  document.querySelectorAll(".card.selected").forEach(el => el.classList.remove("selected"));
  document.querySelectorAll(".droppable, .over").forEach(z => z.classList.remove("droppable", "over"));
  // idle 복귀 — 폴링 중 stash해 둔 보드가 있으면 지금 반영(클로버 가드)
  if (adapter.remote && adapter.flush) adapter.flush();
}
function acceptable(zone, id) {
  // 분류 칸은 아무 카드나, 잇기 소켓은 유형 일치만
  if (zone.classList.contains("col")) return true;
  const q = qById(id);
  return q && q.type === zone.dataset.type;
}
function placeInto(zone, id) {
  const type = zone.dataset.type;
  if (zone.classList.contains("col")) { setType(id, type); announce(`${KO[type]}(으)로 나눴어요.`); }
  else { if (!acceptable(zone, id)) return; setSlot(type, id); blip(); announce(`${KO[type]} 소켓에 끼웠어요.`); }
  clearSelect();
}

function bindPick(el, id, opts = {}) {
  let sx = 0, sy = 0, moved = false, dragging = false, pid = null;
  el.addEventListener("pointerdown", e => {
    if (e.button && e.button !== 0) return;
    pid = e.pointerId; sx = e.clientX; sy = e.clientY; moved = false; dragging = false;
    el.setPointerCapture(pid);
  });
  el.addEventListener("pointermove", e => {
    if (pid === null) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!dragging && Math.hypot(dx, dy) > 8) {
      dragging = true; isDragging = true; moved = true; el.classList.add("dragging"); clearSelect();
      document.querySelectorAll(".col, .socket").forEach(z => { if (acceptable(z, id)) z.classList.add("droppable"); });
    }
    if (dragging) { el.style.transform = `translate(${dx}px,${dy}px) scale(1.04)`; highlight(e.clientX, e.clientY, id); }
  });
  el.addEventListener("pointerup", e => {
    if (pid === null) return;
    try { el.releasePointerCapture(pid); } catch (x) {}
    pid = null;
    if (dragging) {
      el.classList.remove("dragging"); el.style.transform = "";
      isDragging = false; // 드롭 직전 idle 처리 — placeInto→clearSelect의 flush가 stash 보드를 반영
      const z = zoneAt(e.clientX, e.clientY, id);
      document.querySelectorAll(".over").forEach(o => o.classList.remove("over"));
      if (z) placeInto(z, id); else clearSelect();
      dragging = false;
    } else {
      if (opts.onTap) opts.onTap();
      else if (selectedId === id) clearSelect(); else selectCard(id);
    }
  });
  el.addEventListener("pointercancel", () => { if (pid !== null) { try { el.releasePointerCapture(pid); } catch (x) {} } pid = null; isDragging = false; el.classList.remove("dragging"); el.style.transform = ""; clearSelect(); });
  el.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (opts.onTap) opts.onTap(); else if (selectedId === id) clearSelect(); else selectCard(id); }
    else if (e.key === "Escape") clearSelect();
  });
}
function bindDrop(zone, type, mode) {
  zone.addEventListener("click", () => { if (selectedId && acceptable(zone, selectedId)) placeInto(zone, selectedId); });
  zone.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (selectedId && acceptable(zone, selectedId)) placeInto(zone, selectedId); }
    else if (e.key === "Escape") clearSelect();
  });
}
function zoneAt(x, y, id) {
  let best = null, bd = Infinity;
  document.querySelectorAll(".col, .socket").forEach(z => {
    if (!acceptable(z, id)) return;
    const r = z.getBoundingClientRect();
    if (x < r.left - 30 || x > r.right + 30 || y < r.top - 30 || y > r.bottom + 30) return;
    const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
    if (d < bd) { bd = d; best = z; }
  });
  return best;
}
function highlight(x, y, id) {
  const z = zoneAt(x, y, id);
  document.querySelectorAll(".col, .socket").forEach(k => k.classList.toggle("over", k === z));
}

// ===== 입력 바인딩 =====
function syncInputs() {
  document.getElementById("f-title").value = S.title || "";
  const fs = document.getElementById("f-scene");
  if (document.activeElement !== fs) fs.value = S.scene || "";   // 장면 타이핑 중이면 폴링이 덮지 않게(클로버 가드)
}
// 실시간 공유 장면: 비어 있을 때만 학생이 편집 가능, 정해지면 읽기 전용(모두에게 동기화)
function applyRemoteSceneState() {
  if (!adapter.remote) return;
  const fs = document.getElementById("f-scene");
  const empty = !(S.scene && S.scene.trim());
  fs.readOnly = !empty;
  fs.classList.toggle("ro", !empty);
  fs.placeholder = empty ? "아직 장면이 없어요. 함께 정해 적고 바깥을 누르면 친구들에게도 보여요." : "";
}
document.getElementById("f-title").addEventListener("input", e => setTitle(e.target.value));
document.getElementById("f-scene").addEventListener("input", e => {
  setScene(e.target.value);                                   // 로컬: S 저장 / 실시간: no-op(커밋은 blur에서)
  if (!adapter.remote) document.getElementById("scene-show").textContent = e.target.value;
});
// 실시간 공유 장면 커밋 — 다 적고 바깥을 누르면(blur) 한 번 전송
document.getElementById("f-scene").addEventListener("blur", async e => {
  if (!adapter.remote) return;
  const v = e.target.value.trim();
  if (!v || (S.scene && S.scene.trim())) return;             // 빈 값·이미 정해진 장면은 전송 안 함
  const r = adapter.groupNo != null ? await adapter.setGroupScene(v) : await adapter.setScene(v);
  if (r && r.ok) announce("장면을 정했어요. 친구들에게도 보여요.");
});

const newq = document.getElementById("f-newq");
const counter = document.getElementById("newq-counter");
function updCounter() { const n = newq.value.length; counter.textContent = `${n} / ${MAXLEN}자`; counter.classList.toggle("warn", n >= MAXLEN); }
newq.addEventListener("input", updCounter);
function announceVal(why) {
  if (why === "empty") announce("질문을 적어 주세요.");
  else if (why === "dup") announce("이미 있는 질문이에요.");
  else if (why === "long") announce("질문이 너무 길어요.");
}
async function doAdd() {
  if (adapter.remote) {
    const v = qValidation(newq.value);                 // 로컬 선검증(빈/중복/길이) — 서버 왕복 절약
    if (!v.ok) { announceVal(v.why); return; }
    const r = await adapter.addQuestion(v.t);           // RPC → 폴링까지 마친 뒤 입력 비움(임시 id 없음)
    if (r.ok) { newq.value = ""; updCounter(); newq.focus(); announce("질문을 추가했어요."); }
    return;
  }
  const r = addQuestion(newq.value);
  if (r.ok) { newq.value = ""; updCounter(); newq.focus(); announce("질문을 추가했어요."); }
  else announceVal(r.why);
}
document.getElementById("btn-add").addEventListener("click", doAdd);
newq.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doAdd(); } });

document.querySelectorAll(".stepper button").forEach(b => b.addEventListener("click", () => { clearSelect(); setPhase(b.dataset.phase); }));
document.getElementById("btn-reset").addEventListener("click", () => { if (confirm("적은 내용을 모두 지우고 새로 시작할까요?")) { resetAll(); announce("새로 시작해요."); } });
document.addEventListener("keydown", e => { if (e.key === "Escape") clearSelect(); });

// 효과음 끄기 토글
document.getElementById("btn-sound").addEventListener("click", e => {
  soundOn = !soundOn;
  e.currentTarget.setAttribute("aria-pressed", String(soundOn));
  e.currentTarget.textContent = soundOn ? "🔊 소리" : "🔇 소리";
});
// JSON 결과 저장 / 불러오기
document.getElementById("btn-export-json").addEventListener("click", downloadJson);
const fileInput = document.getElementById("file-json");
document.getElementById("btn-import-json").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", e => { const f = e.target.files[0]; if (f) importJsonFile(f); e.target.value = ""; });

// 인쇄 / 이미지 저장
document.getElementById("btn-print").addEventListener("click", () => window.print());
document.getElementById("btn-png").addEventListener("click", async () => {
  if (typeof html2canvas === "undefined") { announce("이미지 저장을 쓸 수 없어요. 인쇄를 이용해요."); return; }
  try {
    await document.fonts.ready;                  // 웹폰트 로드 전 캡처 방지
    const canvas = await html2canvas(document.getElementById("export-target"), { scale: 2, backgroundColor: "#ffffff" });
    const a = document.createElement("a");
    a.download = (S.title || "톱니질문") + ".png";
    a.href = canvas.toDataURL("image/png"); a.click();
    announce("이미지로 저장했어요.");
  } catch (e) { announce("이미지 저장에 실패했어요. 인쇄를 이용해요."); }
});

// ===== 실시간 투영·UI =====
// 서버 보드(board())를 로컬 상태 S로 투영 — 항상 보드가 진실원천.
//  전체(class): 공유 풀·공유 장면, ①②만(③ 숨김).  모둠(group): 내 모둠 것만, ③ 잇기 켜짐.
function applyBoard(board) {
  const sess = (board && board.session) || {};
  S.title = sess.title || "";
  const g = adapter.groupNo;
  const allQ = (board && Array.isArray(board.questions)) ? board.questions : [];
  if (g != null) {
    // 모둠 모드 — 내 모둠 질문·실·장면만
    const grp = (board.groups || []).find(x => x.group_no === g);
    S.scene = (grp && grp.scene) || "";
    S.questions = allQ.filter(q => q.group_no === g).map(q => ({ id: q.id, text: q.text, type: q.type || null }));
    const th = (board.threads || []).find(t => t.group_no === g);
    S.threads = [ th
      ? { id: "th1", slots: Object.assign({ fact: null, infer: null, imagine: null }, th.slots || {}),
                     bridges: Object.assign({ fact: "", infer: "" }, th.bridges || {}) }
      : newThread("th1") ];
    S.activeThreadId = "th1";
  } else {
    // 전체 모드 — 공유 풀, ③ 없음
    S.scene = sess.scene || "";
    S.questions = allQ.map(q => ({ id: q.id, text: q.text, type: q.type || null }));
    S.threads = [newThread("th1")];
    S.activeThreadId = "th1";
    if (S.phase === "connect") S.phase = "classify";
  }
}
function setConnectVisible(show) {
  const b = document.querySelector('.stepper button[data-phase="connect"]');
  if (b) b.style.display = show ? "" : "none";
}
function bridgeFocused() { const a = document.activeElement; return !!(a && a.closest && a.closest(".bridge")); }
// 모둠 세션인데 모둠 미선택 → 번호 피커
function showGroupPicker() {
  const sec = document.getElementById("groupPicker"), grid = document.getElementById("gp-grid");
  if (!sec || !grid) return;
  if (!grid.childElementCount) {
    for (let n = 1; n <= 8; n++) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "gp-btn"; b.textContent = n + " 모둠";
      b.addEventListener("click", () => pickGroup(n));
      grid.appendChild(b);
    }
  }
  document.body.classList.add("picking-group");
  sec.hidden = false;
}
function pickGroup(n) {
  adapter.setGroup(n);
  try { localStorage.setItem("gqt:group:" + roomCode, String(n)); } catch (e) {}
  document.getElementById("groupPicker").hidden = true;
  document.body.classList.remove("picking-group");
  const rb = document.getElementById("roomBar");
  if (rb) { const gt = rb.querySelector(".rb-group"); if (gt) gt.textContent = " · " + n + "모둠"; }
  if (lastBoard) { applyBoard(lastBoard); syncInputs(); applyRemoteSceneState(); setConnectVisible(true); render(); }
  announce(n + "모둠으로 들어왔어요.");
}
function configureRemoteUI(code) {
  document.body.classList.add("remote");
  const cbtn = document.querySelector('.stepper button[data-phase="connect"]');
  if (cbtn) cbtn.style.display = "none";                          // ③ 잇기 숨김
  ["btn-reset", "btn-import-json"].forEach(id => { const b = document.getElementById(id); if (b) b.style.display = "none"; });
  document.getElementById("f-title").readOnly = true;            // 제목은 교사 소유
  applyRemoteSceneState();                                       // 장면은 비었을 때만 학생 편집(이후 board 따라 갱신)
  const rb = document.getElementById("roomBar");
  if (rb) { rb.hidden = false; const c = rb.querySelector(".rb-code"); if (c) c.textContent = code; }
  if (S.phase === "connect") S.phase = "classify";
}
function showRoomError(msg) {
  document.body.innerHTML = "";
  const wrap = document.createElement("div"); wrap.className = "room-error";
  const p = document.createElement("p"); p.textContent = msg;
  const a = document.createElement("a"); a.href = "./index.html"; a.className = "btn ghost"; a.textContent = "← 홈으로";
  wrap.append(p, a); document.body.appendChild(wrap);
}
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = src;
    s.onload = res; s.onerror = () => rej(new Error("로드 실패: " + src));
    document.head.appendChild(s);
  });
}

// ===== 시작 — 수업 코드(?code=)면 실시간, 아니면 개인 모드(오프라인) =====
function startLocal() {
  const resumeBar = document.getElementById("resumeBar");
  const saved = loadSaved();
  if (hasContent(saved)) { adoptState(saved); resumeBar.classList.add("show"); /* 복원했음을 '보이게' */ }
  document.getElementById("btn-new").addEventListener("click", () => { resumeBar.classList.remove("show"); resetAll(); });
  document.getElementById("btn-keep").addEventListener("click", () => { resumeBar.classList.remove("show"); });
  syncInputs(); updCounter(); render(); appReady = true;
  // 손글씨/둥근 웹폰트 미리 로드 (첫 PNG 내보내기에서 손글씨 누락 방지 — 실패해도 시스템 글꼴 폴백)
  if (document.fonts && document.fonts.load) { document.fonts.load('400 16px "Gaegu"'); document.fonts.load('400 16px "Jua"'); }
}
function readPreGroup(code) {
  const g = new URLSearchParams(location.search).get("g");
  const v = g || (() => { try { return localStorage.getItem("gqt:group:" + code); } catch (e) { return null; } })();
  const n = parseInt(v, 10);
  return (n >= 1 && n <= 12) ? n : null;   // 모둠 모드가 아니면 onBoard에서 무시됨
}
async function startRemote(code) {
  roomCode = code;
  try {
    if (!window.supabase) await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
    if (!window.GQT_CONFIG) await loadScript("./js/config.js");
    await loadScript("./js/supabase-adapter.js");
  } catch (e) { showRoomError("실시간 기능을 불러오지 못했어요. 인터넷 연결을 확인해 주세요."); return; }
  configureRemoteUI(code);
  const host = {
    onBoard(board) {
      lastBoard = board;
      const isGroup = board.session && board.session.mode === "group";
      if (!isGroup && adapter.groupNo != null) adapter.setGroup(null);   // 전체 세션이면 (저장된) 모둠 무시
      if (isGroup && adapter.groupNo == null) { showGroupPicker(); return; }
      const rbg = document.querySelector("#roomBar .rb-group");
      if (rbg) rbg.textContent = isGroup ? " · " + adapter.groupNo + "모둠" : "";
      applyBoard(board); syncInputs(); applyRemoteSceneState(); setConnectVisible(isGroup); render();
    },
    announce,
    busy() { return isDragging || selectedId !== null || bridgeFocused(); }  // 다리 입력 중엔 폴링이 덮지 않게
  };
  adapter = window.GQT_makeSupabaseAdapter({ code, config: window.GQT_CONFIG, host, groupNo: readPreGroup(code) });
  updCounter();
  try { await adapter.init(); }
  catch (e) { showRoomError("잘못되었거나 닫힌 수업 코드예요. 홈에서 코드를 다시 확인해 주세요."); return; }
  appReady = true;
}

const ROOM = (window.GQT_ROOM_CODE || "").trim().toUpperCase();
if (ROOM) startRemote(ROOM); else startLocal();

// 테스트 훅 (상태 척추 검증용)
window.GQT = { get S() { return S; }, addQuestion, deleteQuestion, setType, setSlot, setBridge, setTitle, setScene, setPhase, resetAll, save, loadSaved, serialize: () => JSON.stringify(S), importJsonText };
