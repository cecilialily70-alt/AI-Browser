/**
 * 站点描述符 / 连接器层（`buildChatSession` 的一段接线，§0.4 / R8）。
 *
 * 为什么单独一个模块：这一段是「可选的加速器」——描述符命中时用它把方向 / 就绪 / 送信
 * 钉得更准；没命中就回落通用模式，功能一个都不少。它自己不产生任何决策，只做
 * 「按当前页 URL 选描述符 → 建/复用连接器 → 健康度熔断」这套机械动作，
 * 与引擎相位、回访节奏、上下文落盘**没有任何耦合**，所以从装配函数里抽出来。
 *
 * 纪律：**本层不碰截图 / 全景 / SoM / a11y / digest**（§1.6 静音）；
 * 页对象的可变性由调用方用 getter 传进来（`page` / `containerSelector` 在装配函数里被重新赋值）。
 */
import type { Page } from "playwright-core";

import type { JsonLogger } from "../json-logger.js";
import { createDomConnector } from "../core/web_chat/descriptor/dom_connector.js";
import type { ChatConnector, ConnectorContact } from "../core/web_chat/descriptor/types.js";
import {
  builtinConnectorDirs,
  loadDescriptorDirs,
  pickDescriptor,
  resolveLearnedConnectorDir,
  type LoadedDescriptor,
} from "../core/web_chat/descriptor/registry.js";
import { newConnectorHealth, type ConnectorHealth } from "../core/web_chat/descriptor/health.js";
import type { ChatSitePolicy } from "../core/web_chat/site_detect.js";

/** 露给连接器的「联系人身份」最小形状（展示名 + 会话直链） */
export interface DescriptorContactRef {
  key: string;
  label: string;
  url: string | null;
}

export interface DescriptorLayerInput {
  logger: JsonLogger;
  userDataDir: string | null;
  policy: ChatSitePolicy;
  /** 用户写的目标（拿会话直链用；不猜） */
  contacts: readonly DescriptorContactRef[];
  /** 当前页（装配函数里会被重新赋值，所以用 getter） */
  getPage: () => Page | null;
  /** 当前容器（第一次就绪后才定位到，所以用 getter） */
  getContainerSelector: () => string | null;
  /** 「用当前打开的聊天窗口」时绑定的目标 */
  getCurrentTarget: () => DescriptorContactRef | null;
}

export interface DescriptorLayer {
  healthOf: (id: string) => ConnectorHealth;
  loadDescriptors: () => LoadedDescriptor[];
  descriptorFor: (url: string | null) => LoadedDescriptor | null;
  pageUrlOf: () => string | null;
  connectorContactOf: (contact: { key: string; label: string }) => ConnectorContact;
  connectorFor: (contact: { key: string; label: string }) => ChatConnector | null;
  disposeConnector: () => Promise<void>;
  /** 当前挂着的连接器（`waitForActivity` 的页内事件订阅优先用它） */
  getConnector: () => ChatConnector | null;
  /** 最近一次操作过的联系人（引擎的调用顺序保证了它是对的） */
  getLastConnectorContact: () => ConnectorContact | null;
}

/**
 * 建立描述符 / 连接器层。
 *
 * 懒加载 + 健康度熔断都在这里：一片值守里反复读描述符文件没有必要，加载失败一律
 * 如实记诊断并回落通用模式（不静默降级）。
 */
export function createDescriptorLayer(input: DescriptorLayerInput): DescriptorLayer {
  const { logger, policy } = input;

  let descriptors: LoadedDescriptor[] | null = null;
  const healthById = new Map<string, ConnectorHealth>();
  const healthOf = (id: string): ConnectorHealth => {
    const existing = healthById.get(id);
    if (existing) return existing;
    const created = newConnectorHealth(id);
    healthById.set(id, created);
    return created;
  };
  const loadDescriptors = (): LoadedDescriptor[] => {
    if (descriptors) return descriptors;
    const learnedDir = resolveLearnedConnectorDir(input.userDataDir);
    try {
      const result = loadDescriptorDirs({
        builtinDirs: builtinConnectorDirs(),
        learnedDirs: learnedDir ? [learnedDir] : [],
      });
      for (const item of result.diagnostics) {
        // 缺目录是常态（learned 目录还没学过）：不刷给用户；坏文件 / 解析失败才说
        if (item.code === "dir_missing") continue;
        logger.chatProgress(`网站适配文件有问题：${item.reason}`, {
          type: "chat_descriptor_diagnostic",
          phase: "booting",
          threadKey: null,
          code: item.code,
          path: item.path,
        });
      }
      descriptors = result.descriptors;
    } catch (error) {
      descriptors = [];
      logger.chatProgress("描述符加载失败，回落通用模式", {
        type: "chat_descriptor_diagnostic",
        phase: "booting",
        threadKey: null,
        code: "load_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return descriptors;
  };
  /** 按当前页 URL 选描述符（没有 / 都被熔断 → null = 通用模式） */
  const descriptorFor = (url: string | null): LoadedDescriptor | null => {
    if (!url) return null;
    try {
      return pickDescriptor(loadDescriptors(), url, { healthOf });
    } catch {
      return null;
    }
  };

  /**
   * 当前页的连接器（描述符命中时才有）。
   *
   * 纪律：**没有描述符就完全不存在**（返回 null，调用方走与改造前逐字相同的通用路径）。
   * 描述符只是「把方向 / 就绪 / 送信钉得更准」的加速器，不是必需品（宪法 §0.4 / R8）。
   */
  let connector: ChatConnector | null = null;
  let connectorKey: string | null = null;
  /** 最近一次操作过的联系人（连接器的事件订阅需要它；引擎的调用顺序保证了它是对的） */
  let lastConnectorContact: ConnectorContact | null = null;

  const pageUrlOf = (): string | null => {
    const page = input.getPage();
    if (!page) return null;
    try {
      return page.url();
    } catch {
      return null;
    }
  };

  /** 引擎只知道「联系人 / 容器」，连接器需要「展示名 + 会话直链」这一对稳定身份 */
  const connectorContactOf = (contact: { key: string; label: string }): ConnectorContact => {
    const target = input.getCurrentTarget();
    const seed =
      input.contacts.find((item) => item.key === contact.key) ??
      (target?.key === contact.key ? target : null);
    return { label: contact.label, url: seed?.url ?? null };
  };

  /** 成对销毁（幂等；收尾路径**不许抛**，否则会把整片的终态行吞掉） */
  const disposeConnector = async (): Promise<void> => {
    const current = connector;
    connector = null;
    connectorKey = null;
    lastConnectorContact = null;
    if (!current?.dispose) return;
    try {
      await current.dispose();
    } catch {
      /* 清理失败不该改变这一片的结论；页内资源最坏也只是随页面关闭而消失 */
    }
  };

  /**
   * 按当前页 URL 建立（或复用）连接器；未命中描述符 → null（通用模式）。
   *
   * 重建条件里带上容器：容器是「第一次就绪后才定位到的」，用它参与 key 就不会出现
   * 「连着一个容器还是 null 的连接器」。重建前**先销毁旧的**，页内哨兵才能按新配置装上去。
   */
  const connectorFor = (contact: { key: string; label: string }): ChatConnector | null => {
    const page = input.getPage();
    if (!page) return null;
    const url = pageUrlOf();
    const loaded = descriptorFor(url);
    if (!loaded) return null;
    const containerSelector = input.getContainerSelector();
    const key = `${loaded.descriptor.id}@${loaded.descriptor.version}|${url ?? ""}|${containerSelector ?? ""}`;
    if (connector && connectorKey === key) {
      lastConnectorContact = connectorContactOf(contact);
      return connector;
    }
    if (connector) void disposeConnector();
    try {
      connector = createDomConnector({
        page,
        descriptor: loaded,
        policy,
        initialContainerSelector: containerSelector,
        onHealth: (id, kind, decision) => {
          healthById.set(id, decision.health);
          // 「正常」每几秒刷一次 = 噪音；熔断 / 预警 / 自愈才说给人听
          if (decision.action === "ok" && decision.reason === "正常") return;
          logger.chatProgress(
            decision.health.disabled
              ? `这个网站的专用适配已停用，改用通用读法（${decision.reason}）`
              : `网站适配需要留意：${decision.reason}`,
            {
              type: "chat_descriptor_health",
              phase: "booting",
              threadKey: null,
              connectorKind: kind,
              action: decision.action,
              disabled: decision.health.disabled,
            },
          );
        },
      });
      connectorKey = key;
      logger.chatProgress(
        `已识别当前聊天网站（${loaded.descriptor.id}）`,
        {
          type: "chat_descriptor_selected",
          phase: "booting",
          threadKey: null,
          hostPattern: loaded.descriptor.match.hostPattern,
          connectorKind: loaded.source,
        },
      );
    } catch (error) {
      connector = null;
      connectorKey = null;
      logger.chatProgress("描述符连接器建立失败，回落通用模式", {
        type: "chat_descriptor_diagnostic",
        phase: "booting",
        threadKey: null,
        code: "connector_init_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    lastConnectorContact = connectorContactOf(contact);
    return connector;
  };

  return {
    healthOf,
    loadDescriptors,
    descriptorFor,
    pageUrlOf,
    connectorContactOf,
    connectorFor,
    disposeConnector,
    getConnector: () => connector,
    getLastConnectorContact: () => lastConnectorContact,
  };
}
