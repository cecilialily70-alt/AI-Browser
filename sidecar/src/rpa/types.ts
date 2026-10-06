export type RpaActionType = "fill" | "click" | "select" | "wait" | "navigate";

export interface RpaAction {
  step: number;
  type: RpaActionType;
  selector: string;
  dataKey?: string;
  value?: string;
  url?: string;
}

export type RpaRunState = "running" | "paused" | "complete";
