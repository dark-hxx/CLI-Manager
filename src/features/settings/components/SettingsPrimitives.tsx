import { useId, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

interface SettingsSectionProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  open?: boolean;
  onToggle?: () => void;
  actions?: ReactNode;
}

export function SettingsSection({ title, description, children, className = "", open = true, onToggle, actions }: SettingsSectionProps) {
  const id = useId();
  const heading = <span id={`${id}-title`} className="settings-section-title">{title}</span>;
  return (
    <section className={`settings-section ${className}`} aria-labelledby={`${id}-title`}>
      <div className="settings-section-heading">
        <div className="settings-section-heading-row">
          {onToggle ? (
            <button type="button" className="settings-section-toggle" onClick={onToggle} aria-expanded={open} aria-controls={id}>
              {heading}
              <ChevronDown size={16} aria-hidden="true" className={open ? "rotate-180" : ""} />
            </button>
          ) : <h3>{heading}</h3>}
          {actions}
        </div>
        {description && <div className="settings-description">{description}</div>}
      </div>
      {open && <div id={id} className="settings-section-body">{children}</div>}
    </section>
  );
}

interface SettingsRowProps {
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  children: ReactNode;
  stacked?: boolean;
  className?: string;
}

// 控件保留自己的 label/aria-label；容器不嵌套 label，避免多控件行的点击歧义。
export function SettingsRow({ title, description, leading, children, stacked = false, className = "" }: SettingsRowProps) {
  return (
    <div className={`settings-row ${className}`} data-stacked={stacked || undefined}>
      <div className="settings-row-copy">
        {leading && <span className="settings-row-icon" aria-hidden="true">{leading}</span>}
        <div className="settings-row-text">
          <div className="settings-row-label">{title}</div>
          {description && <div className="settings-description">{description}</div>}
        </div>
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}
