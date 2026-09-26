/**
 * 将 BU registry 动作暴露为 OpenAI function tools。
 * 旧天枢台靠 tool_choice:required 才能稳定驱动模型；纯 JSON AgentOutput 对多数国产模型过脆。
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions.mjs";
import { PLAN_TOOL_NAME } from "./plan_expects.js";
import { listExposedActions } from "./registry.js";

const PARAMS: Record<string, ChatCompletionTool["function"]["parameters"]> = {
  navigate: {
    type: "object",
    properties: {
      url: { type: "string" },
      new_tab: {
        type: "boolean",
        description:
          "true = 新开一个标签页再打开该 URL（新页追加在最后）。需要在别的标签保留当前页面时用；默认 false 在当前标签导航",
      },
    },
    required: ["url"],
  },
  go_back: { type: "object", properties: {} },
  wait: {
    type: "object",
    properties: { seconds: { type: "number" } },
  },
  click: {
    type: "object",
    properties: {
      index: { type: "number", description: "browser_state 中的 [index]" },
      coordinate_x: { type: "number" },
      coordinate_y: { type: "number" },
    },
  },
  input: {
    type: "object",
    properties: {
      index: { type: "number" },
      text: { type: "string" },
      clear: { type: "boolean" },
    },
    required: ["index", "text"],
  },
  scroll: {
    type: "object",
    properties: {
      down: { type: "boolean" },
      pages: { type: "number" },
      index: { type: "number" },
    },
  },
  send_keys: {
    type: "object",
    properties: { keys: { type: "string" } },
    required: ["keys"],
  },
  find_text: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  switch: {
    type: "object",
    properties: {
      tab_id: {
        type: "string",
        description:
          "browser_state 里的稳定 id（如 t2）或位置别名（*2 / 2）。稳定 id 关掉别的标签后不变；找不到会报错，不会落到别的标签",
      },
    },
    required: ["tab_id"],
  },
  close: {
    type: "object",
    properties: {
      tab_id: {
        type: "string",
        description:
          "同 switch：稳定 id（t2）或位置别名（*2）。关最后一个标签会失败",
      },
    },
    required: ["tab_id"],
  },
  extract: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "要提取的问题（走二次 LLM 总结；会改写原文，搬运数值别用它）",
      },
    },
    required: ["query"],
  },
  read_tab: {
    type: "object",
    properties: {
      tab_id: {
        type: "string",
        description:
          "要读哪个标签：稳定 id（t2）或位置别名（*2）。**缺省 = 当前活动标签**",
      },
      selectors: {
        type: "array",
        description:
          "确定性取值清单（零 LLM、原样字符串）。要搬运数值就用它，不要用 extract",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "给这个值起的名字，回执里用它标注" },
            selector: { type: "string", description: "CSS 选择器" },
            attr: {
              type: "string",
              description: "读属性而不是值/文本（如 data-id、href）",
            },
            all: { type: "boolean", description: "true = 取全部匹配（最多 50 个）" },
          },
          required: ["selector"],
        },
      },
      text: {
        type: "boolean",
        description: "true = 额外附上该标签的可见正文（截断 8000 字符，不总结）",
      },
    },
  },
  create_environment: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "新环境名字（可选）。不填会按时间自动命名",
      },
      proxy_id: {
        type: "number",
        description: "可选：代理池里的代理 id；不填则用环境默认的 GeoIP 直连",
      },
      use_geoip: {
        type: "boolean",
        description: "是否启用 GeoIP（默认 true，与「新建环境」表单一致）",
      },
    },
  },
  delete_environment: {
    type: "object",
    properties: {
      profile_id: {
        type: "string",
        description: "要删除的环境 id（环境列表里的数字）",
      },
      reason: {
        type: "string",
        description: "为什么删它（会展示给用户确认，必须写清依据）",
      },
    },
    required: ["profile_id"],
  },
  fill_from_tab: {
    type: "object",
    properties: {
      from_tab: {
        type: "string",
        description: "数据来源标签（稳定 id / *N）。缺省 = 当前活动标签",
      },
      from_selector: {
        type: "string",
        description: "来源元素的选择器（读它的 value / 文本）",
      },
      from_attr: { type: "string", description: "读属性而不是值/文本" },
      index: {
        type: "number",
        description:
          "目标输入框在**当前活动标签** browser_state 里的编号（要填别的标签请先 switch 过去）",
      },
    },
    required: ["from_selector", "index"],
  },
  search_page: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      regex: { type: "boolean" },
      max_results: { type: "number" },
    },
    required: ["pattern"],
  },
  find_elements: {
    type: "object",
    properties: {
      selector: { type: "string" },
      max_results: { type: "number" },
    },
    required: ["selector"],
  },
  dropdown_options: {
    type: "object",
    properties: { index: { type: "number" } },
    required: ["index"],
  },
  select_dropdown: {
    type: "object",
    properties: { index: { type: "number" }, text: { type: "string" } },
    required: ["index", "text"],
  },
  screenshot: {
    type: "object",
    properties: { file_name: { type: "string" } },
  },
  write_file: {
    type: "object",
    properties: {
      file_name: { type: "string" },
      content: { type: "string" },
      append: { type: "boolean" },
    },
    required: ["file_name", "content"],
  },
  replace_file: {
    type: "object",
    properties: {
      file_name: { type: "string" },
      old_str: { type: "string" },
      new_str: { type: "string" },
    },
    required: ["file_name", "old_str", "new_str"],
  },
  read_file: {
    type: "object",
    properties: { file_name: { type: "string" } },
    required: ["file_name"],
  },
  evaluate: {
    type: "object",
    properties: { code: { type: "string" } },
    required: ["code"],
  },
  upload_file: {
    type: "object",
    properties: { index: { type: "number" }, path: { type: "string" } },
    required: ["index", "path"],
  },
  download: {
    type: "object",
    properties: {
      ordinal: { type: "number", description: "第几张内容图，从 1 开始。图标和过小的图会被忽略" },
      index: { type: "number", description: "browser_state 里的图片/链接编号" },
      url: { type: "string", description: "直接保存这个资源地址" },
      filename: { type: "string" },
    },
  },
  restart_browser: { type: "object", properties: {} },
  save_as_pdf: {
    type: "object",
    properties: { file_name: { type: "string" } },
  },
  done: {
    type: "object",
    properties: {
      text: { type: "string" },
      success: { type: "boolean" },
    },
    required: ["text"],
  },
  scrape_page_data: {
    type: "object",
    properties: {
      targetDescription: { type: "string" },
      autoScroll: { type: "boolean" },
    },
  },
  page_summary: {
    type: "object",
    properties: {
      save_report: {
        type: "boolean",
        description: "是否把总结报告额外落盘为 Markdown 文件（默认 false，只回结论）",
      },
    },
  },
  ask_user: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  },
  fetch_email_otp: {
    type: "object",
    properties: {
      index: {
        type: "number",
        description: "可选：邮箱验证码字段的 browser_state index；省略则自动选第一个邮箱类空字段",
      },
      timeout_ms: { type: "number", description: "等待邮件超时（毫秒），默认 45000" },
      since_iso: { type: "string", description: "只看该时间之后的邮件（ISO）；默认近 15 分钟" },
      from_hint: { type: "string", description: "可选发件人提示（通用，非站点硬编码）" },
      subject_hint: { type: "string", description: "可选主题提示（通用）" },
    },
  },
  fetch_sms_otp: {
    type: "object",
    properties: {
      index: {
        type: "number",
        description: "可选：短信验证码字段的 browser_state index；省略则自动选第一个短信类空字段",
      },
      timeout_ms: { type: "number", description: "等待短信超时（毫秒），默认 90000" },
      activation_id: {
        type: "string",
        description: "可选：覆盖设置中的接码订单/激活 ID",
      },
    },
  },
  handover_to_human: {
    type: "object",
    properties: { reason: { type: "string" } },
    required: ["reason"],
  },
  ask_vision_locate: {
    type: "object",
    properties: {
      query: { type: "string" },
      click: { type: "boolean" },
    },
    required: ["query"],
  },
  click_viewport: {
    type: "object",
    properties: {
      xPercent: { type: "number" },
      yPercent: { type: "number" },
    },
    required: ["xPercent", "yPercent"],
  },
  list_skills: { type: "object", properties: {} },
  recall_skill: {
    type: "object",
    properties: {
      skill_id: {
        type: "string",
        description: "本地技能 id，如 form-filling / auth-hitl",
      },
    },
    required: ["skill_id"],
  },
  detect_page_blockers: { type: "object", properties: {} },
  solve_captcha: {
    type: "object",
    properties: {
      strategy: {
        type: "string",
        description:
          "可选强制策略：image_text_read（图片字符：静态图/GIF 动图） | slider_gap_drag | math_image_solve | point_select_click | press_hold_captcha（长按按钮 / Arkose「按住不放」）",
      },
      auto_fill: {
        type: "boolean",
        description: "图片字符/算式：默认 true，求解后立即填",
      },
      auto_submit: {
        type: "boolean",
        description: "图片字符/算式：默认 true，填后立即点提交/验证答案",
      },
      page_hint: { type: "string", description: "页面说明摘要" },
    },
  },
  solve_animated_captcha: {
    type: "object",
    properties: {
      strategy: {
        type: "string",
        description: "可选强制策略；兼容别名，推荐改用 solve_captcha",
      },
      auto_fill: { type: "boolean", description: "默认 true，本工具内立即填" },
      auto_submit: { type: "boolean", description: "默认 true，本工具内立即提交" },
      page_hint: { type: "string", description: "页面说明摘要" },
    },
  },
  solve_slider_captcha: {
    type: "object",
    properties: {
      page_hint: { type: "string", description: "页面说明摘要" },
    },
  },
  solve_math_captcha: {
    type: "object",
    properties: {
      auto_fill: { type: "boolean", description: "默认 true" },
      auto_submit: { type: "boolean", description: "默认 true，点「验证答案」" },
      page_hint: { type: "string", description: "页面说明摘要" },
    },
  },
  solve_point_select_captcha: {
    type: "object",
    properties: {
      page_hint: { type: "string", description: "页面说明摘要" },
    },
  },
  [PLAN_TOOL_NAME]: {
    type: "object",
    properties: {
      plan: {
        type: "array",
        description:
          "完整的新计划（整表替换）。每项为字符串，或 {text, expects} 对象；expects 描述「做完这一步后页面应该变成什么样」，用于运行时零成本自检",
        items: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                text: { type: "string" },
                expects: {
                  type: "object",
                  properties: {
                    url_pattern: {
                      type: "string",
                      description: "子串或通配符（如 baidu.com、/user/*/profile），不要写正则",
                    },
                    must_appear_in_a11y: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "应出现的 A11y 控件语义。只允许 role（textbox/button/link/heading…）或 role:名称（如 textbox:搜索、button:登录）；禁止填网页可见文案（如「搜索结果列表」）或自造 role，否则本地直接丢弃",
                    },
                    must_not_appear: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "不该再出现的 A11y 控件语义，写法同上（如 button:验证码提交）",
                    },
                    state_change: {
                      type: "string",
                      enum: ["url_changed", "dom_reloaded", "none"],
                      description: "优先 url_changed；dom_reloaded 运行时无法核实",
                    },
                  },
                },
              },
              required: ["text"],
            },
          ],
        },
      },
      current_index: { type: "number", description: "从 0 开始：当前正在做第几项" },
      reason: { type: "string", description: "一句话说明为什么改计划" },
    },
    required: ["plan"],
  },
};

const DESC: Record<string, string> = {
  navigate: "打开 URL",
  go_back: "浏览器后退",
  wait: "等待秒数",
  click: "按 browser_state 的 index 点击（或坐标）",
  input: "按 index 向输入框填入文本",
  scroll: "滚动页面",
  send_keys: "发送键盘按键",
  find_text: "滚动直到找到文本",
  switch: "切换标签页",
  close: "关闭标签页",
  extract: "用二次 LLM 提取页面信息",
  read_tab:
    "确定性读页面（可指定任意标签）：按选择器原样取值，零 LLM、不改写。要搬运/上报数值用它；要 LLM 总结才用 extract",
  fill_from_tab:
    "跨标签搬运：从 from_tab 的 from_selector 原样取值，填进当前标签的 [index]。值不经过模型转述；要填别的标签请先 switch",
  create_environment:
    "新建一个浏览器环境（走宿主落库）。**新环境不会接管当前任务**，本任务仍在原环境；要在新环境干活需用户启动后再派发新任务。每次任务最多建 3 个",
  delete_environment:
    "删除一个环境（不可逆，**强制人工确认**；用户拒绝即失败，禁止换说法重试）。每次任务最多删 2 个",
  search_page: "页内文本搜索（零成本）",
  find_elements: "CSS 查询元素",
  dropdown_options: "列出下拉选项",
  select_dropdown: "选择下拉项",
  screenshot: "截图（下一轮视觉或存盘）",
  write_file: "写工作区文件",
  replace_file: "替换文件片段",
  read_file: "读工作区文件",
  evaluate: "执行页内 JS（禁止指纹 API）",
  upload_file: "上传文件",
  download: "把第 N 张内容图、某个 index 或资源 URL 保存到下载目录（scraper/<环境>）",
  restart_browser:
    "关掉当前环境浏览器并立刻用同一 CDP 端口重新打开。标签和未保存表单会清空，下一步必须重新导航。独占本轮",
  save_as_pdf: "保存 PDF",
  done: "结束任务并交付结果（须为该步唯一动作）",
  scrape_page_data: "天枢台混合爬虫",
  page_summary:
    "总结/分析**当前打开的页面**（站点定位 / 主要功能与栏目 / 内容要点 / 注意 / 不确定），只读不导航、不滚动。信息型目标（总结这个网站、分析当前页面）首选；要落盘报告传 save_report=true",
  ask_user: "向用户提问并等待",
  fetch_email_otp:
    "邮箱 OTP 通道取码并填入邮箱验证码字段（默认 IMAP/临时邮；网页邮箱须设置显式启用且非默认）；失败再 ask_user。禁止自己打开网页邮箱、禁止改指纹、禁止用于短信/TOTP/图形验证码/支付字段",
  fetch_sms_otp:
    "短信接码平台取码并填入短信验证码字段（须设置中显式启用；默认关）；失败再 ask_user。禁止用于邮箱/TOTP/图形验证码/支付字段",
  handover_to_human: "人工接管",
  ask_vision_locate: "视觉定位：先描述再给坐标（语言球/图标救赎）",
  click_viewport: "按视口百分比点击",
  list_skills: "列出本地 Agent Skills 目录",
  recall_skill: "按 skill_id 召回 SKILL.md 全文到 read_state",
  detect_page_blockers: "按需检测验证码/登录墙/Cookie/风控（禁每步例行）",
  solve_captcha:
    "独占本轮：自动分发 GIF/滑块/算式/点选/长按(Arkose)/Token；组件未渲染会自动等待（勿反复重发）；失败勿换同策略别名空转；未支持类型报错勿死磕",
  solve_animated_captcha:
    "solve_captcha 兼容别名（与分发后同路径，勿在失败后改用本别名顶次数）",
  solve_slider_captcha:
    "独占本轮：强制滑块缺口（与 solve_captcha 分发后同路径）",
  solve_math_captcha:
    "独占本轮：强制算式图（与 solve_captcha 分发后同路径；失败勿用本别名顶次数）",
  solve_point_select_captcha:
    "独占本轮：强制点选（裁剪验证区→JSON坐标→拟人贝塞尔点击）",
  [PLAN_TOOL_NAME]:
    "修正/重建计划（整表替换）。可带每项的 expects（url_pattern/must_appear_in_a11y/state_change），系统会零成本自检该步是否真的推进；不改浏览器，可与其它动作同轮",
};

export function buildRegistryOpenAiTools(): ChatCompletionTool[] {
  return listExposedActions().map((name) => ({
    type: "function" as const,
    function: {
      name,
      description: DESC[name] ?? name,
      parameters: PARAMS[name] ?? { type: "object", properties: {} },
    },
  }));
}
