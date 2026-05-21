import { useEffect, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { SessionList } from "./components/SessionList";
import { useAppStore } from "./state/appStore";

export function App() {
  const [showSettings, setShowSettings] = useState(false);
  const loadChannelConfig = useAppStore((state) => state.loadChannelConfig);
  const loadExtractionRules = useAppStore((state) => state.loadExtractionRules);
  const refreshPageContext = useAppStore((state) => state.refreshPageContext);

  useEffect(() => {
    void Promise.all([loadChannelConfig(), loadExtractionRules()]).then(() => refreshPageContext());
  }, [loadChannelConfig, loadExtractionRules, refreshPageContext]);

  return (
    <main className="app-shell">
      <section className="app-header">
        <h1 className="app-title">Browser AI Assistant</h1>
        <button className="ui-button-secondary" type="button" onClick={() => setShowSettings((value) => !value)}>
          设置
        </button>
      </section>
      <section className={showSettings ? "p-4" : "grid gap-4 p-4 md:grid-cols-[180px_1fr]"}>
        {showSettings ? (
          <SettingsPanel />
        ) : (
          <>
            <SessionList />
            <ChatPanel />
          </>
        )}
      </section>
    </main>
  );
}
