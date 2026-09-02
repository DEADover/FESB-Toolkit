import { BarChart2, History, Inbox, Network, Radar, Send, Settings2, Terminal } from "lucide-react";

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
const ITEMS: { id: View; icon: React.ReactNode; label: string; kbd: string }[] = [
  { id: "connection", icon: <Settings2 className="w-3.5 h-3.5" />, label: "Connection", kbd: "⌘1" },
  { id: "publisher", icon: <Send className="w-3.5 h-3.5" />, label: "Send", kbd: "⌘2" },
  { id: "subscriber", icon: <Inbox className="w-3.5 h-3.5" />, label: "Receive", kbd: "⌘3" },
  { id: "browser", icon: <Radar className="w-3.5 h-3.5" />, label: "Browser", kbd: "⌘4" },
  { id: "inspector", icon: <Network className="w-3.5 h-3.5" />, label: "Clients", kbd: "⌘5" },
  { id: "history", icon: <History className="w-3.5 h-3.5" />, label: "History", kbd: "⌘6" },
  { id: "stats", icon: <BarChart2 className="w-3.5 h-3.5" />, label: "Stats", kbd: "⌘7" },
  { id: "console", icon: <Terminal className="w-3.5 h-3.5" />, label: "Logs", kbd: "⌘8" },
];

export default function ViewTabs({ active, onChange }: Props) {
  return (
    <nav
      aria-label="AMQP"
      className="shrink-0 flex items-center gap-1 overflow-x-auto border-b border-t-line bg-t-panel px-2 py-1.5"
    >
      {ITEMS.map((item) => {
        const isActive = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            title={`${item.label}  ${item.kbd}`}
            aria-current={isActive ? "page" : undefined}
            className={`flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[12px] transition-colors ${
              isActive
                ? "bg-accent text-white"
                : "text-t-ink3 hover:bg-t-hover hover:text-t-ink"
            }`}
          >
            <span className="flex w-3.5 shrink-0 items-center justify-center">{item.icon}</span>
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
