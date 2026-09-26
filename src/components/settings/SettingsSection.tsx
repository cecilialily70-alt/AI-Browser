import type { ReactNode } from "react";

interface SettingsSectionProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
}

/**
 * 设置面板统一分区卡片：图标 + 标题 + 描述 + 内容。
 * 用于消除 GeneralSettingsTab / AiSettingsTab / ProxyPoolTab 之间
 * 重复的「圆角卡片 + 标题」样板代码。
 */
export function SettingsSection({ icon, title, description, children }: SettingsSectionProps) {
  return (
    <section className="space-y-3 rounded-lg bg-surface-muted p-4 ring-1 ring-inset ring-border-strong/35">
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-ui-lg font-semibold text-foreground">
          {icon ? <span className="text-primary">{icon}</span> : null}
          <span>{title}</span>
        </div>
        {description ? <p className="text-caption leading-5 text-muted-foreground">{description}</p> : null}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
