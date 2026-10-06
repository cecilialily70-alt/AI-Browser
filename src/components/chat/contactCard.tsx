/**
 * 「聊天」视图的**每联系人卡片**（§5.7）：阶段 / 谁能说话 / 自动聊天 /
 * 最后收发 / 续盯 / 状态，展开看流水。
 *
 * 单独成文件的理由：这张卡片有自己的读取副作用（首屏预读流水尾部）与本地展开态，
 * 与 `ChatModeModal` 的「环境 / 保存 / 调度」手柄没关系。
 */

import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { formatInvokeError, getChatThreadMessages } from "../../lib/tauri";
import type { ChatTakeoverMode, ChatThreadMessage, ChatThreadRow } from "../../types";

export const STAGE_LABEL: Record<string, string> = {
  cold: "尚未接触",
  opening: "已开场",
  engaged: "有来有回",
  waiting: "等对方回",
  dormant: "静默",
  stopped: "已停止",
  handover: "待人工",
};

/** 与 Sidecar `USER_TAKEOVER_REASON` 逐字一致（用户在视图里点的接管） */
export const USER_TAKEOVER_REASON = "用户在设置里为该联系人选择了「接管 / 暂停」";

function stageBadgeClass(stage: string): string {
  if (stage === "stopped") return "badge";
  if (stage === "handover") return "badge badge-warning";
  if (stage === "engaged") return "badge badge-success";
  if (stage === "waiting" || stage === "dormant") return "badge badge-info";
  return "badge badge-primary";
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "—";
  const diffMs = Date.now() - time;
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return future ? "即将" : "刚刚";
  if (minutes < 60) return future ? `${minutes} 分钟后` : `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return future ? `${hours} 小时后` : `${hours} 小时前`;
  return future ? `${Math.round(hours / 24)} 天后` : `${Math.round(hours / 24)} 天前`;
}

/** 每联系人两个开关（§5.7）：缺省＝开；只有用户显式关掉才为关 */
export function FlagToggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <span className="flex items-center gap-1.5" title={hint}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={`ui-switch ${checked ? "ui-switch-on" : ""} ${disabled ? "opacity-50" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span
          className="ui-switch-knob"
          style={{ transform: checked ? "translateX(0.75rem)" : "translateX(0.125rem)" }}
        />
      </button>
      <span className={`text-caption ${checked ? "text-foreground/80" : "text-muted-foreground"}`}>
        {label}
      </span>
    </span>
  );
}

function TakeoverToggle({
  mode,
  disabled,
  onChange,
}: {
  mode: ChatTakeoverMode;
  disabled: boolean;
  onChange: (next: ChatTakeoverMode) => void;
}) {
  const human = mode === "human" || mode === "paused";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-caption text-muted-foreground">谁能说话：</span>
      <button
        type="button"
        className={`btn btn-compact h-6 text-caption ${!human ? "btn-primary" : "btn-ghost"}`}
        disabled={disabled || !human}
        title="交还给引擎：对方来消息会回，到点也会主动找话（仍受上面两个开关约束）"
        onClick={() => onChange("engine")}
      >
        引擎值守
      </button>
      <button
        type="button"
        className={`btn btn-compact h-6 text-caption ${human ? "btn-outline" : "btn-ghost"}`}
        disabled={disabled || human}
        title="我接管：引擎只记账、不开口（需要再说时点「引擎值守」交还）"
        onClick={() => onChange("human")}
      >
        我接管
      </button>
    </div>
  );
}

/** 一位联系人的卡片：阶段 / 接管 / 两开关 / 续盯与回访，展开看流水 */
export function ContactCard({
  profileId,
  contact,
  autoLoad,
  busy,
  purgeBlocked = false,
  flagsBusy,
  onPurge,
  onToggleFlags,
  onToggleTakeover,
}: {
  profileId: string;
  contact: ChatThreadRow;
  /** 卡片不在首屏时不要为了预览去读每个联系人的文件 */
  autoLoad: boolean;
  busy: boolean;
  /** 值守进行中：禁止清记忆（避免边写边删） */
  purgeBlocked?: boolean;
  /** 正在写入每联系人开关 / 接管 */
  flagsBusy: boolean;
  onPurge: (contact: ChatThreadRow) => void;
  /** 每联系人开关：`autoReply` / `followUp`（未设置＝开） */
  onToggleFlags: (
    contact: ChatThreadRow,
    field: "autoReply" | "followUp",
    next: boolean,
  ) => void;
  onToggleTakeover: (contact: ChatThreadRow, next: ChatTakeoverMode) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<ChatThreadMessage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * 首屏（autoLoad）就直接把流水尾部读回来 —— 卡片上必须能显示「对方最后」与「我方最后」，
   * 否则用户得逐张展开才看得见一半事实。展开时若先前只当作预览读过，不再重复读。
   */
  useEffect(() => {
    if ((!autoLoad && !expanded) || messages !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await getChatThreadMessages(
          profileId,
          contact.siteKey,
          contact.contactKey,
          80,
        );
        if (!cancelled) setMessages(rows);
      } catch (error) {
        if (!cancelled) setLoadError(formatInvokeError(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [autoLoad, expanded, messages, profileId, contact.siteKey, contact.contactKey]);

  const lastIn = useMemo(() => {
    if (!messages) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].direction === "in") return messages[index];
    }
    return null;
  }, [messages]);
  const lastOut = useMemo(() => {
    if (!messages) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].direction === "out") return messages[index];
    }
    return null;
  }, [messages]);

  const preview = (row: ChatThreadMessage | null): string => {
    if (!row) return messages ? "（暂无）" : "读取中…";
    const text = row.text.replace(/\s+/g, " ").trim();
    return text.length > 46 ? `${text.slice(0, 46)}…` : text;
  };

  // 只读回事实：没读到流水就不猜「在等谁」
  const waitingOn = !messages
    ? null
    : lastIn && lastOut && (lastIn.at ?? "") > (lastOut.at ?? "")
      ? "对方"
      : "我方";

  const autoReplyOn = contact.autoReply !== false;
  const humanTakeover = contact.takeover === "human" || contact.takeover === "paused";

  return (
    <div className="group-well ring-1 ring-inset ring-border-strong/30">
      <div className="flex items-start gap-2 p-3">
        <button
          type="button"
          className="icon-button mt-0.5 shrink-0"
          aria-label={expanded ? "收起流水" : "展开流水"}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-ui font-medium text-foreground">
              {contact.contactLabel || contact.contactKey}
            </span>
            <span className={stageBadgeClass(contact.stage)}>
              {STAGE_LABEL[contact.stage] ?? contact.stage}
            </span>
            {contact.stopped ? (
              <span className="badge badge-danger" title={contact.stopReason ?? ""}>
                已停止
              </span>
            ) : null}
            {humanTakeover ? (
              <span
                className="badge badge-warning"
                title={contact.takeoverReason ?? USER_TAKEOVER_REASON}
              >
                我接管 · 引擎只记账
              </span>
            ) : null}
            <span className="badge" title="站点">
              {contact.siteKey}
            </span>
          </div>

          <TakeoverToggle
            mode={contact.takeover}
            disabled={flagsBusy}
            onChange={(next) => onToggleTakeover(contact, next)}
          />
          {humanTakeover && contact.takeoverReason ? (
            <p className="text-caption text-warning">
              {contact.takeoverReason === USER_TAKEOVER_REASON
                ? "已由你接管：引擎不开口。想交还就点「引擎值守」。"
                : `引擎停手原因：${contact.takeoverReason}。确认可以交还时点「引擎值守」。`}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-caption text-muted-foreground">做什么：</span>
            <FlagToggle
              label="自动聊天"
              hint="开场搭话 + 对方来消息时回话（关掉＝这位不主动开口，只会记账）"
              checked={autoReplyOn}
              disabled={flagsBusy}
              onChange={(next) => onToggleFlags(contact, "autoReply", next)}
            />
          </div>
          {!autoReplyOn ? (
            <p className="text-caption text-warning">
              「自动聊天」关着 → 不会开场、也不会回话（对方没回时本来也不会主动追）。想让它聊就打开这个开关。
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-caption text-muted-foreground sm:grid-cols-2">
            <p className="truncate">
              <span className="text-foreground/70">对方最后：</span>
              {preview(lastIn)}
            </p>
            <p className="truncate">
              <span className="text-foreground/70">我方最后：</span>
              {preview(lastOut)}
            </p>
            <p>
              <span className="text-foreground/70">会话：</span>
              {contact.messageCount} 条流水
            </p>
            <p>
              <span className="text-foreground/70">下次续盯：</span>
              {formatRelative(contact.nextCheckAt)}
              {waitingOn ? ` · 等${waitingOn}` : ""}
            </p>
            <p>
              <span className="text-foreground/70">对方回复：</span>
              {formatRelative(contact.lastReplyAt)}
            </p>
            <p>
              <span className="text-foreground/70">我方最后发出：</span>
              {formatRelative(contact.lastContactAt)}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="btn-icon-danger shrink-0"
          title={
            purgeBlocked
              ? "值守进行中：请先点「停止」再删除"
              : "删除这位联系人的聊天记忆（并从要聊的人里移除）"
          }
          aria-label="删除这位联系人的聊天记忆"
          disabled={busy || purgeBlocked}
          onClick={() => onPurge(contact)}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {expanded ? (
        <div className="max-h-64 overflow-y-auto border-t border-border-strong/25 px-3 py-2">
          {loadError ? (
            <p className="text-caption text-destructive">{loadError}</p>
          ) : messages === null ? (
            <p className="text-caption text-muted-foreground">读取流水…</p>
          ) : messages.length === 0 ? (
            <p className="text-caption text-muted-foreground">还没有流水（尚未聊过）。</p>
          ) : (
            <ul className="space-y-1.5">
              {messages.map((message, index) => (
                <li
                  key={`${message.id}-${index}`}
                  className="flex gap-2 text-caption leading-5"
                >
                  <span
                    className={`shrink-0 font-medium ${
                      message.direction === "out" ? "text-primary-text" : "text-foreground"
                    }`}
                  >
                    {message.direction === "out" ? "我方" : "对方"}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-muted-foreground">
                    {message.text}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/70">
                    {formatRelative(message.ts ?? message.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
