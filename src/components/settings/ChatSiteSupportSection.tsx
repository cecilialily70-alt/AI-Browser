import { listen } from "@tauri-apps/api/event";
import { Loader2, RefreshCw, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createToast } from "../../lib/toast";
import type { ToastMessage } from "../../lib/toast";
import {
  chatConnectorDelete,
  chatConnectorStatus,
  chatLearnSite,
  fetchProfiles,
  formatInvokeError,
} from "../../lib/tauri";
import type {
  ChatConnectorItem,
  ChatConnectorStatusPayload,
  ChatLearnCheck,
  ChatLearnDonePayload,
  ChatStateEvent,
  Profile,
} from "../../types";
import { SettingsSection } from "./SettingsSection";

interface ChatSiteSupportSectionProps {
  saving: boolean;
  onToast: (toast: ToastMessage) => void;
  onError: (message: string) => void;
}

const CAPABILITY_LABEL: Record<string, string> = {
  send: "发消息",
  sendImage: "发图",
  history: "读历史",
  subscribe: "页内事件",
  presence: "在线/未读",
  threads: "会话列表",
};

function capabilitiesText(item: ChatConnectorItem): string {
  const ok = Object.entries(item.capabilities)
    .filter(([, value]) => value)
    .map(([key]) => CAPABILITY_LABEL[key] ?? key);
  return ok.length > 0 ? ok.join(" · ") : "只读（无声明能力）";
}

/** 差异清单：报错型（红）与需要留意（黄）分开展示，且**带期望值与实际值** */
function CheckList({ checks }: { checks: ChatLearnCheck[] }) {
  if (checks.length === 0) return null;
  const fatal = checks.filter((check) => check.severity === "fatal");
  const warn = checks.filter((check) => check.severity !== "fatal");
  const render = (list: ChatLearnCheck[], tone: string) => (
    <ul className="space-y-1">
      {list.map((check) => (
        <li key={`${check.field}:${check.actual}`} className={tone}>
          <span className="font-mono">{check.field}</span>
          <span className="ml-1 text-muted-foreground">
            期望「{check.expected}」，实际「{check.actual}」
          </span>
          {check.detail ? (
            <span className="ml-1 text-muted-foreground">（{check.detail}）</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="space-y-1.5 rounded-md bg-card/50 px-3 py-2 ring-1 ring-inset ring-border-strong/30">
      <p className="text-ui text-foreground">自检差异（这几项没过就不会保存）</p>
      {fatal.length > 0 ? render(fatal, "text-warning") : null}
      {warn.length > 0 ? render(warn, "text-muted-foreground") : null}
    </div>
  );
}

/**
 * 「站点支持」——站点描述符的总览 / 学习 / 删除。
 *
 * 三条产品口径（§3.5 / §5.7）：
 * ① **加站点 = 加描述符**，不是改代码：内置描述符随包发，学来的落在该环境自己的目录里
 *   （`connectors/_learned`，随环境删除一并清掉）；
 * ② 学习是**显式动作**：要有正在运行的浏览器，点一次学一次，不自动学、不后台学；
 * ③ 只报事实：能力边界、为什么不可用、自检差异、读写各验过没有 —— 不美化，也不吓人。
 */
export function ChatSiteSupportSection({
  saving,
  onToast,
  onError,
}: ChatSiteSupportSectionProps) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState<string>("");
  const [status, setStatus] = useState<ChatConnectorStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [learning, setLearning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<ChatLearnDonePayload | null>(null);
  const [url, setUrl] = useState("");
  const [selfLabel, setSelfLabel] = useState("");
  const [selfUrl, setSelfUrl] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const running = useMemo(
    () => profiles.filter((profile) => profile.status === "running"),
    [profiles],
  );
  const current = useMemo(
    () => profiles.find((profile) => String(profile.id) === profileId) ?? null,
    [profiles, profileId],
  );
  const canLearn = Boolean(profileId) && current?.status === "running" && !learning && !saving;

  const loadStatus = useCallback(
    async (target: string) => {
      if (!target) {
        setStatus(null);
        return;
      }
      setLoading(true);
      try {
        setStatus(await chatConnectorStatus(target));
      } catch (error) {
        setStatus(null);
        onError(formatInvokeError(error));
      } finally {
        setLoading(false);
      }
    },
    [onError],
  );

  // 环境列表：优先选中**正在运行**的那个（学习需要活浏览器）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchProfiles();
        if (cancelled) return;
        setProfiles(list);
        const preferred = list.find((profile) => profile.status === "running") ?? list[0];
        if (preferred) {
          setProfileId(String(preferred.id));
        }
      } catch (error) {
        if (!cancelled) onError(formatInvokeError(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onError]);

  useEffect(() => {
    if (!profileId) return;
    void loadStatus(profileId);
  }, [profileId, loadStatus]);

  // 学习进度：只收与学习有关的 `chat-state`（§5.7：不复用通用监视日志）
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<ChatStateEvent>("chat-state", (event) => {
      const kind = event.payload?.kind ?? "";
      if (kind !== "chat_learn" && kind !== "chat_learn_done") return;
      if (profileId && event.payload?.profileId && event.payload.profileId !== profileId) return;
      const line = event.payload?.msg ?? "";
      if (line) {
        setLog((prev) => [...prev.slice(-199), line]);
      }
      if (kind === "chat_learn_done") {
        const payload = event.payload as unknown as ChatLearnDonePayload;
        setResult(payload);
        setLearning(false);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [profileId]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  const startLearn = async (options?: { maxRounds?: number }) => {
    if (!profileId) return;
    setLearning(true);
    setResult(null);
    setLog([`开始学习：${url.trim() || "当前打开的聊天窗口"}`]);
    try {
      const slice = await chatLearnSite({
        profileId,
        url: url.trim() || null,
        siteLabel: selfLabel.trim() || null,
        selfTestContact: selfLabel.trim() ? { label: selfLabel.trim(), url: selfUrl.trim() || null } : null,
        maxRounds: options?.maxRounds,
      });
      // 终态同时会经 chat-state 事件到达；这里用返回载荷兜底（事件丢了也不会「什么都没发生」）
      const payload = slice.actions as unknown as ChatLearnDonePayload | null;
      if (payload) setResult(payload);
      onToast(
        createToast(
          payload?.ok ? "success" : "info",
          payload?.ok ? "站点学习完成" : `站点学习未完成：${slice.msg || "见差异清单"}`,
        ),
      );
      await loadStatus(profileId);
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setLearning(false);
    }
  };

  const removeLearned = async (item: ChatConnectorItem) => {
    // 删除用的是**文件名干**（`siteKey`），不是 id：`whatsapp-web` 的文件叫 `whatsapp.com.json`。
    // 这个 key 由 Sidecar 一处拆好随总览下发，前端不自己拆路径（两套命名约定必然分叉）。
    const siteKey = item.siteKey;
    if (!siteKey) {
      onError("这个学来的站点规则缺少可用标识，无法安全删除（请刷新后重试）");
      return;
    }
    if (
      !window.confirm(
        `删除学来的站点规则「${item.id}」？\n\n会清掉该环境里这份已学习的规则。之后该站点会退回通用读法（随包内置的规则不受影响）。`,
      )
    ) {
      return;
    }
    setDeleting(item.id);
    try {
      const payload = await chatConnectorDelete(profileId, siteKey);
      onToast(
        createToast(
          payload.ok ? "success" : "info",
          payload.ok ? "已删除学来的描述符" : `没删掉：${payload.reason ?? "未知原因"}`,
        ),
      );
      await loadStatus(profileId);
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setDeleting(null);
    }
  };

  const items = status?.items ?? [];

  return (
    <SettingsSection
      icon={<Sparkles size={16} />}
      title="站点支持（描述符）"
      description="聊天模式靠「站点描述符」认识每个聊天站：内置的随包发布，学来的存在该环境自己的目录里。加一个站点 = 加一份描述符，不需要改代码。"
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[12rem] flex-1 space-y-1">
            <span className="block text-caption text-muted-foreground">环境（学习需要它正在运行）</span>
            <select
              className="field-input h-8 w-full"
              value={profileId}
              disabled={learning || saving}
              onChange={(event) => setProfileId(event.target.value)}
            >
              {profiles.length === 0 ? <option value="">（没有环境）</option> : null}
              {[...profiles]
                .sort((a, b) => {
                  const ar = a.status === "running" ? 0 : 1;
                  const br = b.status === "running" ? 0 : 1;
                  return ar - br || a.name.localeCompare(b.name, "zh");
                })
                .map((profile) => (
                  <option
                    key={profile.id}
                    value={String(profile.id)}
                    disabled={profile.status !== "running"}
                  >
                    {profile.name}
                    {profile.status === "running" ? "（运行中）" : "（需先启动）"}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-outline h-8 px-3"
            disabled={!profileId || loading}
            onClick={() => void loadStatus(profileId)}
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            刷新
          </button>
        </div>

        {running.length === 0 ? (
          <p className="text-caption leading-5 text-warning">
            当前没有正在运行的环境：可以查看内置描述符，但要「学习本站」请先启动一个环境并把会话页打开。
          </p>
        ) : null}

        <div className="space-y-2 rounded-md bg-card/50 px-3 py-2 ring-1 ring-inset ring-border-strong/30">
          <p className="text-ui text-foreground">学习本站</p>
          <label className="block space-y-1">
            <span className="block text-caption text-muted-foreground">
              站点地址（留空 = 用此刻打开的那个聊天窗口）
            </span>
            <input
              className="field-input h-8 w-full"
              placeholder="https://…（留空即用当前打开的聊天页）"
              value={url}
              disabled={learning}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="block text-caption text-muted-foreground">
                写入自测对象（可留空；**填你自己的会话/收藏夹**）
              </span>
              <input
                className="field-input h-8 w-full"
                placeholder="例如：收藏夹 / 我自己"
                value={selfLabel}
                disabled={learning}
                onChange={(event) => setSelfLabel(event.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="block text-caption text-muted-foreground">该会话链接（可选）</span>
              <input
                className="field-input h-8 w-full"
                placeholder="https://…"
                value={selfUrl}
                disabled={learning}
                onChange={(event) => setSelfUrl(event.target.value)}
              />
            </label>
          </div>
          <p className="text-caption leading-5 text-muted-foreground">
            不给自测对象就只验「读」并如实标注「写入未验证」；给了会向它发一条固定文案的自检消息
            （<code>接口自检 …</code>）再读回来逐字核对 —— 所以千万别填别人的会话。
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-primary h-8 px-3"
              disabled={!canLearn}
              onClick={() => void startLearn()}
            >
              {learning ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {learning ? "学习中…" : "学习本站"}
            </button>
            {learning ? (
              <span className="text-caption text-muted-foreground">
                正在采集页面结构与真值、让模型给草案、再逐条机器自检；期间该环境不能再跑别的任务。
              </span>
            ) : null}
          </div>

          {log.length > 0 ? (
            <div
              ref={logRef}
              className="max-h-40 overflow-y-auto rounded bg-surface-muted/60 px-2 py-1.5 font-mono text-caption leading-5 text-muted-foreground"
            >
              {log.map((line, index) => (
                <div key={`${index}:${line}`}>{line}</div>
              ))}
            </div>
          ) : null}

          {result ? (
            <div className="space-y-2 rounded-md bg-surface-muted/60 px-3 py-2 text-caption leading-5">
              <p className={result.ok ? "text-success" : "text-warning"}>
                {result.ok ? "学习完成" : "学习未完成"}：
                {result.ok
                  ? `${result.descriptorId}（${result.readVerified ? "读已验" : "读未验"}／${
                      result.sendVerified ? "写已验" : "写未验证"
                    }）`
                  : result.outcome === "cancelled"
                    ? "已取消"
                    : "见下面的差异清单"}
              </p>
              {result.savedPaths ? (
                <p className="text-muted-foreground">
                  已保存到：<span className="font-mono">{result.savedPaths.descriptorPath}</span>
                </p>
              ) : null}
              <p className="text-muted-foreground">
                轮次 {result.attempts} · 模型调用 {result.usage.calls} 次（输入约{" "}
                {result.usage.promptTokens} / 输出约 {result.usage.completionTokens}）。
                单次费用未记录（模型单价随配置变化，这里不猜）。
              </p>
              <CheckList checks={result.checks} />
              {!result.ok && result.outcome !== "cancelled" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-outline h-7 px-2 text-caption"
                    disabled={learning || !canLearn}
                    onClick={() => void startLearn({ maxRounds: 4 })}
                  >
                    <RefreshCw size={12} />
                    多调几轮再学一次（最多 4 轮）
                  </button>
                  <span className="text-muted-foreground">
                    每一轮都会按上一轮的差异重新推断；仍不通过就照旧如实报差异，不会硬凑一份能过校验的假描述符。
                  </span>
                </div>
              ) : null}
              {result.schemaDiagnostics.length > 0 ? (
                <div className="text-muted-foreground">
                  <p>结构校验未通过项：</p>
                  <ul className="list-inside list-disc">
                    {result.schemaDiagnostics.map((item) => (
                      <li key={`${item.path}:${item.reason}`}>
                        <span className="font-mono">{item.path}</span> {item.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* ——— 现有描述符 ——— */}
        {status && !status.builtinPresent ? (
          <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-caption leading-5 text-warning ring-1 ring-inset ring-warning/30">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            <span>
              随包的内置站点规则目录缺失：安装包可能不完整。
              这不影响已经学来的站点，但内置站点会全部退回通用读法。
            </span>
          </p>
        ) : null}

        {loading ? (
          <p className="text-caption text-muted-foreground">读取站点支持中…</p>
        ) : items.length === 0 ? (
          <p className="text-caption text-muted-foreground">
            还没有任何描述符：该站点会走通用读法（能读但容易读错）。用上面的「学习本站」给它学一份。
          </p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-start justify-between gap-3 rounded-md bg-card/50 px-3 py-2 ring-1 ring-inset ring-border-strong/30"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="flex items-center gap-2 text-ui text-foreground">
                    <span className="truncate">{item.id}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-caption ${
                        item.learned ? "bg-primary/10 text-primary" : "bg-surface-muted text-muted-foreground"
                      }`}
                    >
                      {item.learned ? "学来的" : "内置"}
                    </span>
                    <span className="text-caption text-muted-foreground">v{item.version}</span>
                    {item.health?.disabled ? (
                      <span className="rounded bg-warning/10 px-1.5 py-0.5 text-caption text-warning">
                        已熔断
                      </span>
                    ) : null}
                  </p>
                  <p className="truncate text-caption text-muted-foreground">
                    {item.hostPattern} · {capabilitiesText(item)}
                  </p>
                  {item.meta ? (
                    <p className="text-caption text-muted-foreground">
                      学于 {new Date(item.meta.savedAt).toLocaleString()} · 轮次 {item.meta.rounds} ·
                      {item.meta.readVerified ? " 读已验" : " 读未验"}／
                      {item.meta.sendVerified ? "写已验" : "写未验证"}
                      {item.meta.verifySummary ? ` · ${item.meta.verifySummary}` : ""}
                    </p>
                  ) : null}
                  {item.health?.reason ? (
                    <p className="text-caption text-warning">最近失败原因：{item.health.reason}</p>
                  ) : null}
                </div>
                {item.learned ? (
                  <button
                    type="button"
                    className="btn btn-ghost h-7 shrink-0 px-2 text-caption text-warning"
                    disabled={deleting === item.id || learning || !item.siteKey}
                    onClick={() => void removeLearned(item)}
                  >
                    {deleting === item.id ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}
                    删除
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {status?.diagnostics && status.diagnostics.length > 0 ? (
          <div className="rounded-md bg-warning/10 px-3 py-2 text-caption leading-5 text-warning ring-1 ring-inset ring-warning/30">
            <p className="font-medium">描述符诊断：</p>
            <ul className="mt-1 list-inside list-disc">
              {status.diagnostics.map((item) => (
                <li key={`${item.code}:${item.path}`}>
                  <span className="font-mono">{item.code}</span> {item.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {status?.learnedDir ? (
          <p className="text-caption leading-5 text-muted-foreground">
            学来的站点规则只保存在该环境自己的目录里（删除环境会一并清掉，不会带给新建的环境）。
            <button
              type="button"
              className="ml-1 text-primary-text underline-offset-2 hover:underline"
              title={status.learnedDir}
              onClick={() => {
                const path = status.learnedDir;
                if (!path) return;
                void navigator.clipboard?.writeText(path).then(
                  () => onToast(createToast("success", "已复制存放路径")),
                  () => onError("复制失败"),
                );
              }}
            >
              复制路径
            </button>
          </p>
        ) : null}
      </div>
    </SettingsSection>
  );
}
