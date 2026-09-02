import { BarChart2, History, Inbox, Network, Radar, Send, Settings2, Terminal } from "lucide-react";

import { useAmqpText, type AmqpKey } from "../i18n";
import { View } from "../types";

interface Props {
  active: View;
  onChange: (v: View) => void;
}

/**
 * Экраны раздела — вкладками, а не боковой панелью.
 *
 * В отдельном приложении это была своя вертикальная панель слева. Внутри
 * FESB Toolkit слева уже стоит панель разделов, и вторая рядом с ней читалась
 * бы как ошибка. Порядок и подписи те же, горячие клавиши те же — сменилось
 * только направление.
 */
const ITEMS: { id: View; icon: React.ReactNode; label: AmqpKey; kbd: string }[] = [
  { id: "connection", icon: <Settings2 className="w-3.5 h-3.5" />, label: "tab.connection", kbd: "⌘1" },
  { id: "publisher", icon: <Send className="w-3.5 h-3.5" />, label: "tab.publisher", kbd: "⌘2" },
  { id: "subscriber", icon: <Inbox className="w-3.5 h-3.5" />, label: "tab.subscriber", kbd: "⌘3" },
  { id: "browser", icon: <Radar className="w-3.5 h-3.5" />, label: "tab.browser", kbd: "⌘4" },
  { id: "inspector", icon: <Network className="w-3.5 h-3.5" />, label: "tab.inspector", kbd: "⌘5" },
  { id: "history", icon: <History className="w-3.5 h-3.5" />, label: "tab.history", kbd: "⌘6" },
  { id: "stats", icon: <BarChart2 className="w-3.5 h-3.5" />, label: "tab.stats", kbd: "⌘7" },
  { id: "console", icon: <Terminal className="w-3.5 h-3.5" />, label: "tab.console", kbd: "⌘8" },
];

export default function ViewTabs({ active, onChange }: Props) {
  const t = useAmqpText();

  return (
    // Дорожка с пилюлями — тот же переключатель, что у отборов на других
    // экранах: рамка, подложка и выделение акцентом.
    <nav
      aria-label="AMQP"
      className="flex shrink-0 items-center gap-0.5 overflow-x-auto rounded-xl border border-line-strong bg-surface-2 p-1"
    >
      {ITEMS.map((item) => {
        const isActive = active === item.id;
        const label = t(item.label);
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            title={`${label}  ${item.kbd}`}
            aria-current={isActive ? "page" : undefined}
            className={`flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[12.5px] transition-colors ${
              isActive
                ? "bg-accent text-white"
                : "text-t-ink3 hover:bg-t-hover hover:text-t-ink"
            }`}
          >
            <span className="flex w-3.5 shrink-0 items-center justify-center">{item.icon}</span>
            {label}
          </button>
        );
      })}
    </nav>
  );
}
