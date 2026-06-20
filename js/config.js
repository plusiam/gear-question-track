// 톱니질문 트랙 — Supabase 연결 설정 (실시간 모드에서만 로드)
// publishable 키는 클라이언트 공개 전제 — 보호는 RLS가 담당(키 자체는 비밀 아님).
// 개인 모드(app.html, 코드 없음)는 이 파일을 로드하지 않음 → 오프라인 보장.
window.GQT_CONFIG = {
  url: "https://ixoeijdakzyelolpxcyr.supabase.co",
  anonKey: "sb_publishable_2clnzpPAMA_JTlAEdplh4g_2p8tUTks",
  schema: "gear"
};
