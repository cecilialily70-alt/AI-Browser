/**
 * 聊天事件 kind → 「中文标签 + 色调 + 是否进值守日志」的**唯一一张表**（§5.7）。
 *
 * 纪律：
 * - **不做子串猜测**。色调跟着 kind 走，表里没有的 kind 一律中性 —— 不猜。
 * - 表必须是**完备**的：侧车与宿主发射的每个 kind 都要在这里有一条。
 *   `sidecar/tests/chat-settings-parity.mjs` 会扫源码断言「发射的 kind 集合 ⊆ 这张表的键」。
 * - 视图只出现「普通人能看懂、且与聊天有关的事」：读到消息、写了回复、发出去了、
 *   等对方、转人工、卡住了。相位机内部流转 / 描述符健康度「正常」刷屏 / 目录探测
 *   **不进值守日志**（协议仍可发射，排查走侧车 JSONL）。
 */

export type ChatEventTone = "muted" | "success" | "warning";

export interface ChatEventStyle {
  /** 日志行的中文标签（消息为空时的兜底） */
  label: string;
  tone: ChatEventTone;
  /**
   * 是否进「值守日志」面板。缺省 true。
   * 标 false 的事件仍会进侧车 JSONL，只是不打扰普通人。
   */
  showInLog?: boolean;
}

/** kind → 标签与色调（一个 kind 一行，便于测试按行解析） */
export const CHAT_EVENT_STYLES: Record<string, ChatEventStyle> = {
  // —— 引擎：相位与生命周期 ——
  chat_start: { label: "开始值守", tone: "success" },
  chat_state: { label: "收尾", tone: "muted" },
  chat_state_update: { label: "状态", tone: "muted" },
  // 相位机内部流转：普通人看「相位 deciding → drafting」毫无意义 → 不进面板
  chat_phase: { label: "阶段", tone: "muted", showInLog: false },
  chat_state_resumed: { label: "恢复上次状态", tone: "muted" },
  chat_state_resume_skipped: { label: "未恢复上次状态", tone: "warning" },
  chat_stop_requested: { label: "请求停止", tone: "muted" },
  chat_note: { label: "记录", tone: "muted" },
  chat_no_targets: { label: "没有要聊的对象", tone: "warning" },

  // —— 引擎：会话与页面 ——
  chat_tab: { label: "打开聊天页", tone: "muted" },
  chat_target_resolved: { label: "确定对象", tone: "muted" },
  chat_contact_open: { label: "打开会话", tone: "muted" },
  chat_page_ready: { label: "页面就绪", tone: "muted" },
  chat_page_not_ready: { label: "页面未就绪", tone: "warning" },
  chat_read: { label: "读消息", tone: "muted" },
  chat_wait: { label: "等对方回话", tone: "muted" },
  chat_wait_fallback_poll: { label: "等待方式降级", tone: "warning" },
  chat_reply_watch: { label: "已排续盯", tone: "muted" },
  chat_turn_limit: { label: "本轮到上限", tone: "warning" },

  // —— 引擎：起草、发送与对账 ——
  chat_draft_retry: { label: "重写草稿", tone: "muted" },
  chat_draft_rejected: { label: "草稿被拦", tone: "warning" },
  // 「已提交」与「已发送并确认」成对刷两行 → 只留终态
  chat_send_submitted: { label: "正在发送", tone: "success", showInLog: false },
  chat_send: { label: "已发送", tone: "success" },
  chat_send_soft_confirm: { label: "已发送（页面回读未命中，已继续）", tone: "muted" },
  chat_composer_method_fallback: { label: "改用备用方式写入", tone: "muted", showInLog: false },
  chat_send_unconfirmed: { label: "发送未确认", tone: "warning" },
  chat_outbox_reconcile: { label: "发件对账", tone: "muted", showInLog: false },
  chat_opted_out: { label: "对方态度偏拒绝", tone: "muted" },
  chat_pending_drain: { label: "续发待发句", tone: "muted" },
  chat_pending_saved: { label: "待发句留到下片", tone: "muted" },
  chat_send_interrupted: { label: "对方插话已停发", tone: "warning" },
  chat_inbound_burst: { label: "对方连发已合批", tone: "muted" },
  chat_contacts_discovered: { label: "自动纳入新人", tone: "muted" },
  chat_contacts_discover_failed: { label: "扫描列表失败", tone: "warning" },

  // —— 引擎：开场 / 本轮不发 ——
  chat_followup_sent: { label: "主动发出", tone: "success" },
  chat_followup_skipped: { label: "本轮不发", tone: "muted" },

  // —— 引擎：记忆与上下文 ——
  chat_memory_compacted: { label: "记忆整理", tone: "muted", showInLog: false },
  chat_memory_retry: { label: "重试整理记忆", tone: "muted", showInLog: false },
  chat_memory_failed: { label: "记忆整理失败", tone: "warning" },
  chat_persist: { label: "已记一笔", tone: "muted", showInLog: false },
  chat_context_unavailable: { label: "上下文不可用", tone: "warning" },
  chat_context_write_failed: { label: "上下文写入失败", tone: "warning" },
  chat_context_legacy_dir: { label: "沿用旧聊天记录", tone: "muted", showInLog: false },

  // —— 引擎：人工优先与人工介入 ——
  chat_takeover_detected: { label: "检测到非本引擎发出的消息", tone: "muted" },
  chat_takeover_baseline_unknown: { label: "首次读数不判接管", tone: "muted", showInLog: false },
  chat_auto_reply_off: { label: "该联系人已关「自动聊天」", tone: "muted" },
  chat_patrol_yield: { label: "本片让位（会续盯）", tone: "muted" },
  chat_handover: { label: "转人工", tone: "warning" },

  // —— 站点描述符与学习（正常 ok / 缺目录不发射；真有问题时进面板）——
  chat_descriptor_selected: { label: "已识别聊天网站", tone: "muted", showInLog: false },
  chat_descriptor_health: { label: "网站适配状态", tone: "warning" },
  chat_descriptor_diagnostic: { label: "网站适配提示", tone: "warning" },
  chat_learn: { label: "站点学习", tone: "muted" },
  chat_learn_done: { label: "学习结束", tone: "muted" },

  // —— 宿主：调度器与看门狗（P8） ——
  chat_patrol_launch: { label: "自动拉起值守", tone: "muted" },
  chat_patrol_queue: { label: "排队等待席位", tone: "muted" },
  chat_patrol_resumed: { label: "恢复自动值守", tone: "success" },
  chat_watchdog_stall: { label: "值守卡住了", tone: "warning" },
  chat_watchdog_stop: { label: "看门狗中止", tone: "warning" },
  chat_watchdog_restart: { label: "看门狗重启", tone: "warning" },
};

const TONE_CLASS: Record<ChatEventTone, string> = {
  muted: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
};

/**
 * `reason` 代码 → 中文（用户看到的必须是话，不是 `contact_off` / `explicit_targets`）。
 * 未知代码**不拼进日志**（宁可不写，也不甩蛇形英文）。
 */
const REASON_LABELS: Readonly<Record<string, string>> = {
  disabled: "主动追发未启用（产品已下线）",
  chat_off: "「自动聊天」关着（引擎不会主动开口）",
  contact_off: "该联系人已关闭定时回访（不主动追；产品已下线）",
  stopped: "该联系人已停止",
  replied: "对方已回复",
  not_due: "对方没有未回复消息，继续盯守",
  round_exhausted: "本轮回访次数已用尽",
  no_new_angle: "没有新角度",
  daily_cap: "已达当日发送上限",
  quiet_hours: "处于静默时段",
  due: "到点回访（产品已下线）",
  opening: "首次开场",
  empty_roster: "没有要聊的对象",
  no_passing_draft: "草稿没通过去重",
  give_up: "连续重复，放弃本轮",
  send_not_confirmed: "发送未确认",
  slice_complete: "本片干完，即将续盯",
  slice_elapsed: "本片时间到，即将续盯",
  no_targets: "本次没有要聊的对象",
  explicit_targets: "按你指定的对象开页",
  own_tab_fallback: "用的是上次值守留下的聊天标签",
  user_window: "用的是你当前打开的窗口",
  adopted_existing_tab: "复用已有聊天标签",
  no_open_window: "没有可用的当前窗口",
  chat_site_without_conversation: "聊天站已开但还没点进具体会话",
};

export interface FormattedChatEvent {
  text: string;
  tone: string;
  /** false = 值守日志面板应跳过 */
  showInLog: boolean;
}

/**
 * 一行日志的文案与色调。
 * - 有完整中文消息时**直接用消息**（不再叠「标签 · 消息」制造复读）。
 * - reason 只在有中文译名时追加；未知代码不甩给用户。
 * - 未知 kind 不猜色调（中性），但原样显示 kind 以免事件隐身。
 */
export function formatChatEvent(event: {
  kind?: string;
  msg?: string;
  reason?: string;
}): FormattedChatEvent {
  const kind = String(event.kind ?? "chat_note");
  const style = CHAT_EVENT_STYLES[kind];
  const showInLog = style ? style.showInLog !== false : true;
  const msg = String(event.msg ?? "").trim();
  const code = event.reason ? String(event.reason) : "";
  const reasonZh = code ? REASON_LABELS[code] ?? "" : "";
  const reasonSuffix =
    reasonZh && (!msg || !msg.includes(reasonZh)) ? `（${reasonZh}）` : "";

  let text: string;
  if (msg) {
    text = `${msg}${reasonSuffix}`;
  } else if (style) {
    text = `${style.label}${reasonSuffix}`;
  } else {
    text = `${kind}${reasonSuffix}`;
  }

  return {
    text,
    tone: TONE_CLASS[style ? style.tone : "muted"],
    showInLog,
  };
}
