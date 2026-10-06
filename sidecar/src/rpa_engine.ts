/**
 * RPA 模板执行引擎 — 统一导出入口，向下兼容现有 import 路径。
 * 内部分离：template_parser / step_runner / error_handler / state_machine
 */
export { parseRpaActions, parseRpaData } from "./rpa/template_parser.js";
export { executeRpaAction } from "./rpa/step_runner.js";
export { RpaStateMachine } from "./rpa/state_machine.js";
export type { RpaAction, RpaActionType, RpaRunState } from "./rpa/types.js";
