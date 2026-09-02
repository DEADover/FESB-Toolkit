import React from "react";

export interface TabItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  badge?: string | number;
  /** subtle blue dot indicator when this tab has active/non-default state */
  dot?: boolean;
}

interface Props {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

export default function Tabs({ tabs, active, onChange, className }: Props) {
  return (
    <div role="tablist" className={`shrink-0 flex items-stretch border-b border-t-line bg-t-panel ${className ?? ""}`}>
      {tabs.map(tab => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.id)}
            className={`relative flex items-center gap-1.5 px-3 py-1.5 text-[12px] transition-colors whitespace-nowrap outline-none focus-visible:bg-t-hover/50 ${
              isActive
                ? "text-t-ink font-medium"
                : "text-t-ink3 hover:text-t-ink2 hover:bg-t-hover/50"
            }`}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.badge !== undefined && tab.badge !== 0 && tab.badge !== "" && (
              <span className={`text-[10px] px-1 py-0 rounded font-medium leading-4 ${
                isActive ? "bg-blue-500/15 text-blue-500" : "text-t-ink4"
              }`}>
                {tab.badge}
              </span>
            )}
            {tab.dot && !isActive && (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
            )}
            {isActive && (
              <span className="absolute -bottom-px left-2 right-2 h-0.5 bg-blue-600 rounded-full" />
            )}
          </button>
        );
      })}
    </div>
  );
}
