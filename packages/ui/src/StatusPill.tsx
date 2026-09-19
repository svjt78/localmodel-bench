import type { ReactNode } from "react";

export type StatusTone = "neutral" | "success" | "warning" | "error" | "accent";

export interface StatusPillProps {
  tone: StatusTone;
  label: string;
  pulse?: boolean;
  icon?: ReactNode;
}

export function StatusPill({ tone, label, pulse, icon }: StatusPillProps) {
  return (
    <span className={`status-pill status-pill--${tone}`}>
      <span className={`status-pill__dot${pulse ? " status-pill__dot--pulse" : ""}`} aria-hidden="true" />
      {icon}
      <span className="status-pill__label">{label}</span>
    </span>
  );
}
