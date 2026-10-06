/**
 * 观察包管线配置：静默窗、截图、遮罩预算。
 * 全景截图为多帧视口数组（禁止竖向拼接长图）。
 */

export const PAGE_PIPELINE_CONFIG = {
  /** 视口内有意义突变后的静默窗（ms） */
  quietMs: 800,
  /** 静默等待硬上限（ms），永不因动画挂死 */
  deadlineMs: 4_000,
  /** Agent 观察路径更短的静默（SERP 热区动画多） */
  agentQuietMs: 600,
  agentDeadlineMs: 3_000,
  /** 判定「有意义」的最小元素面积（px²） */
  minMutationArea: 80,
  /** 全景最多视口帧数 */
  panoramaMaxFrames: 5,
  /** JPEG 质量 0–100 */
  jpegQuality: 48,
  /** 单帧最长边（px） */
  maxShotEdge: 1024,
  /** 帧间滚动后短暂等待（ms） */
  scrollSettleMs: 120,
  /** 结构哈希近似相同的阈值（0–1，1=完全相同）—— 用于 Delta Skip */
  structureSimilarityReuse: 0.92,
  /** 同遮罩指纹短窗（ms） */
  overlayRecurrenceWindowMs: 15_000,
  /** 同指纹出现次数达到后停止追逐 */
  overlayRecurrenceStopAt: 3,
  /** 无障碍树文本上限 */
  a11yMaxChars: 6_000,
  /** Agent 索引 DOM 提取硬超时（ms）— 百度等多 frame 页可卡 evaluate */
  extractTimeoutMs: 12_000,

  // ——— 观察自愈（失败不靠模型自觉，运行时自己重试/降级）———
  /** 单次观察的最大抽取尝试次数（含首抽） */
  observeMaxAttempts: 3,
  /** 观察自愈总预算（ms）：等待 + 重抽合计超过即停，绝不挂死 */
  observeHealBudgetMs: 9_000,
  /** 第 2、3 次尝试前的静默阶梯（ms），不足则按预算截断 */
  observeRetryBackoffMs: [500, 1_400],
  /** 降级观察：正文取用上限（字符） */
  degradedTextChars: 2_000,
  /** 降级观察：正文读取超时（ms） */
  degradedTextTimeoutMs: 1_500,

  // ——— 元素去噪（硬丢装饰/离屏垃圾，软降权重复噪音）———
  /** 非可填控件的最小可点边长（px），低于视为装饰性元素 */
  denoiseMinEdgePx: 6,
  /** 完全落在视口左/上方向外这么多像素外的元素（离屏抽屉、影子菜单副本） */
  denoiseOffscreenTolerancePx: 1_500,
  /** 同一 (类型, 文案) 的重复噪音（链接/按钮）超过此数量即逐条降权 */
  denoiseMaxPerLabel: 3,
  /** 每条重复噪音的降权分（排名用，分越大越靠后） */
  denoiseRepeatPenalty: 6,

  // ——— 意图→目标关联仲裁（同行「文案/外链」与「勾选控件」的归属裁决）———
  /** 总开关：观察层为同行文案补充「真正该点的是哪个 index」 */
  affinityArbitration: true,
  /** 单轮最多探测的参照元素数（外链/按钮/容器），超出按可见性截断 */
  affinityMaxPeers: 40,
  /** 关联查找向上追溯的祖先层数上限 */
  affinityMaxDepth: 4,
  /** 每个祖先容器内最多扫描的候选控件数（防重型页面卡顿） */
  affinityMaxScan: 60,
  /** 接受一条关联的最低置信分（0–1） */
  affinityMinScore: 0.45,
  /** 页面内关联探测的时间预算（ms）：超预算立即收尾，绝不把观察卡死 */
  affinityProbeBudgetMs: 1_200,

  // ——— Set-of-Mark（把 index 编号画进截图，图文同源）———
  /** 总开关：截图前注入编号标记，使模型可以用视觉交叉验证 index */
  somMarks: true,
  /** 单帧最多标注的编号数（超上限时优先保留离视口最近的） */
  somMaxMarks: 60,

  // ——— 像素核对（动作后视觉验证）———
  // 成本：每次核对 = 1 张「动作前」+ 多张轮询截图（见到变化即停）。所以这里全是「什么时候不做」的闸门：
  // 少一次核对只是少一条辅助证据，多拍一堆无用截图却是每一步都要付的固定开销。
  /** 总开关：动作前后抓低分辨率指纹比对，给模型「这一下有没有让画面动」的客观事实 */
  visualVerify: true,
  /**
   * 单步最多做几次核对（每步重置）。超出后本步剩余动作直接跳过核对：
   * 一轮里连点十几个同类目标时，前几次的结论已足够说明「这种点法有效/无效」。
   */
  visualVerifyMaxPerStep: 4,
  /**
   * 目标自带可靠 DOM 回读（勾选态 / 字段值）时跳过核对。
   * 观察层能读到 checked 的控件（checkbox/radio/switch），点完后 checkedAfter 就是决定性证据，
   * 再拍两张图纯属白花 —— 这是实测里占比最高的一类无用截图。
   */
  visualVerifySkipStateful: true,

  // ——— 视觉重定位（index 失效时靠图找回目标）———
  /** 总开关：index 失效时允许「重新编号 + 问视觉模型找回目标」 */
  visionRelocate: true,
  /** 单步最多重定位次数：预算的意义是「救一次」，不是「无限重试」 */
  visionRelocateMaxPerStep: 1,
} as const;
