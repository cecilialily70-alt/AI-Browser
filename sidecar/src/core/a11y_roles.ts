/**
 * A11y role 词汇表（纯校验，零 I/O）
 *
 * 用途：判断模型给出的期望 token（`must_appear_in_a11y` / `must_not_appear`）是不是
 * 一个**真能落在无障碍树上**的东西。
 *
 * 为什么必须有这一层（用户现场）：模型把「搜索结果列表」这种**网页可见文案**塞进了
 * `must_appear_in_a11y`。它永远匹配不到 `role:名称` 形式的 A11y 标签，于是几何上必然
 * 产出 violation —— 在 google 结果页判出"找不到搜索结果列表"，Arbiter 随即认为
 * 「计划与事实矛盾」。这就是最贵的一类误判：**事实是对的，判据是错的**。
 *
 * 为什么用词汇表而不是正则：正则分不清 `search_results`（模型编的假 role）与 `textbox`
 * （真 role）—— 两者都是"ASCII 单词"。只有闭集词表能判定"这个 role 在我们的 a11y 树上存在"。
 *
 * 为什么这份数据放在代码里而不是 `config/*.json`（刻意偏离引擎/词典的既有做法）：
 *   · 词典（引擎选择器、风险词）是**随站点与业务变化的政策数据**，必须可外部替换；
 *   · ARIA role 是 **W3C 标准的封闭词汇**，和 HTML 标签名同类 —— 是平台事实，不是站点差异。
 *     没有任何用户有理由去自定义它，把它外置只会多一个文件、一个加载失败模式，
 *     以及"配置缺失时静默退化成什么都过"的风险。
 * 若将来确实需要扩展（例如某站点自定义 role），再引入可选的外部覆盖即可。
 *
 * 词表构成：WAI-ARIA 1.2 全部角色 + Chrome `Accessibility.getFullAXTree` 实际会吐出的
 * 若干非标准 role（`node` / `StaticText` / `Iframe` 等，观察层会原样带出，见 extractor.ts）。
 */

const ARIA_ROLES: readonly string[] = [
  // —— widget 角色
  "button", "checkbox", "gridcell", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "progressbar", "radio", "scrollbar", "searchbox", "separator", "slider",
  "spinbutton", "switch", "tab", "tabpanel", "textbox", "treeitem",
  // —— 复合 widget 角色
  "combobox", "grid", "listbox", "menu", "menubar", "radiogroup", "tablist", "tree", "treegrid",
  // —— 文档结构角色
  "application", "article", "blockquote", "caption", "cell", "code", "columnheader", "definition",
  "deletion", "directory", "document", "emphasis", "feed", "figure", "generic", "group",
  "heading", "img", "image", "insertion", "list", "listitem", "mark", "math", "meter", "none",
  "note", "paragraph", "presentation", "row", "rowgroup", "rowheader", "strong", "subscript",
  "superscript", "table", "term", "time", "toolbar", "tooltip",
  // —— landmark 角色
  "banner", "complementary", "contentinfo", "form", "main", "navigation", "region", "search",
  // —— 实时区域角色
  "alert", "log", "marquee", "status", "timer",
  // —— 窗口角色
  "alertdialog", "dialog",
  // —— 抽象角色（规范上不该被作者使用，但 a11y 树可能透出）
  "command", "composite", "input", "landmark", "range", "roletype", "section", "sectionhead",
  "select", "structure", "widget", "window",
  // —— Chrome AX 的非标准 role（观察层原样带出，不收录会让真 token 被误丢）
  "node", "rootwebarea", "iframe", "inlinetextbox", "linebreak", "statictext", "listmarker",
  "descriptionlist", "descriptionlistterm", "descriptionlistdetail",
];

const ROLE_SET: ReadonlySet<string> = new Set(ARIA_ROLES);

/** 规范化：小写、去空白。token 里的 role 部分一律按这个口径比较 */
export function normalizeA11yRole(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** 该字符串是否是一个我们认可的 a11y role（闭集判定） */
export function isKnownA11yRole(value: unknown): boolean {
  const role = normalizeA11yRole(value);
  return role.length > 0 && ROLE_SET.has(role);
}

/**
 * 把期望 token 解析成 role（不被认可则为 null）。
 *
 * 合法形态只有两种：
 *   · `role`          —— 例：`textbox`、`button`
 *   · `role:名称`     —— 例：`textbox:搜索`、`button:登录`（名称可含任意语言，不做限制）
 * 自由文本（`搜索结果列表`、`下一页`、`search_results`）一律返回 null —— 它们不可能命中
 * `role:名称` 标签集，留着只会产出假矛盾。
 */
export function a11yRoleOfToken(token: unknown): string | null {
  const raw = String(token ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const colon = raw.indexOf(":");
  const head = colon > 0 ? raw.slice(0, colon) : raw;
  return isKnownA11yRole(head) ? normalizeA11yRole(head) : null;
}

/** 供日志/测试：当前词汇表规模 */
export function a11yRoleVocabularySize(): number {
  return ROLE_SET.size;
}
