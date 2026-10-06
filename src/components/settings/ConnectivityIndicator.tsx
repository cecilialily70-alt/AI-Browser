import type { ConnectivityStatus } from "../../types";

interface ConnectivityIndicatorProps {
  status: ConnectivityStatus;
}

export function ConnectivityIndicator({ status }: ConnectivityIndicatorProps) {
  if (status === "testing") {
    return <span className="text-caption text-muted-foreground">测试中…</span>;
  }
  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1 text-caption font-medium text-success">
        <span className="status-dot status-running" />
        已连接
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-caption font-medium text-destructive">
        <span className="status-dot bg-destructive" />
        未连接
      </span>
    );
  }
  return <span className="text-caption text-muted-foreground">未检测</span>;
}
