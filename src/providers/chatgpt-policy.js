import {
  DEFAULT_ANSWER_TIER,
  CONVERSATION_CHANGE_INTERVAL_MS,
  CONTEXT_ARCHIVE_DIR,
  MAX_CONVERSATION_TURNS,
  PROBE_ENABLED,
  PROBE_PROMPT,
  PRO_ANSWER_TIER,
  PRO_PROBE_RECHECK_AFTER_CLOSE_MS,
  POST_RESPONSE_CONVERSATION_COOLDOWN_MS,
  REFRESH_BEFORE_NEW_CHAT,
  RESPONSE_TIMEOUT_MS,
  SEND_INTERVAL_MS,
} from "../config.js";
export const probeInstructions = PROBE_ENABLED
  ? `实验性网络身份探针已显式启用：仅在用户要求身份核对时使用，非 mini 的 model_slug 不等于已经验证为 Pro。探针不会强制选择 Pro 档位。同一页面会话复用缓存，关闭后保留 ${Math.round(PRO_PROBE_RECHECK_AFTER_CLOSE_MS / 3_600_000)} 小时；forceProbe 仅用于用户明确要求重新验证。`
  : "临时 Pro 身份探针默认停用。不得调用 chatgpt_probe_pro_identity，也不得用 requestPro=true 调用 chatgpt_route_new_chat；这些调用会在新建临时对话或发送测试消息前停止。普通极高路由使用 requestPro=false。";
export function chatgptInstructions() {
return `默认保持专用浏览器和 ChatGPT 页面常驻，除非用户明确要求，否则绝不调用 chatgpt_close_browser。发送最小间隔 ${SEND_INTERVAL_MS / 1_000} 秒，对话变更最小间隔 ${CONVERSATION_CHANGE_INTERVAL_MS / 1_000} 秒，回答完成后再等 ${POST_RESPONSE_CONVERSATION_COOLDOWN_MS / 1_000} 秒才切换；这些是下限，不保证免于限流。新建前的额外刷新当前${REFRESH_BEFORE_NEW_CHAT ? "开启" : "关闭"}，由 CHATGPT_WEB_REFRESH_BEFORE_NEW_CHAT 控制。每次发送前仍刷新当前对话，并校验 URL、草稿和附件；检测到变化则停止。对话达到 ${MAX_CONVERSATION_TURNS} 轮或出现 maximum-length 错误时，原子发送会先读取完整 transcript 并归档到 ${CONTEXT_ARCHIVE_DIR}，再新建普通对话；直接 submit_prompt 则拦截。新任务优先用 chatgpt_route_new_chat，普通请求使用页面可用档位“${DEFAULT_ANSWER_TIER}”。${probeInstructions}`;
}
