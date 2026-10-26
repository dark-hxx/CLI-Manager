import { Profiler, useState } from "react";
import { createRoot } from "react-dom/client";
import { Conversation } from "../../apps/web-tap/src/Conversation";
import { createTranscriptSignals } from "../../apps/web-tap/src/transcriptSignals";
import { createTerminalStream } from "../../src/shared/lib/webTerminalStream";
import { connectBrowserSocket } from "../../src/shared/lib/webBrowserSocket";
import { translator } from "../../apps/web-tap/src/i18n";
import "../../apps/web-tap/src/styles.css";
import "../../apps/web-tap/src/chat.css";
import "../../apps/web-tap/src/turnRail.css";
import type { JsonObject, JsonValue } from "../../src/shared/types/webBrowser";

const signals = createTranscriptSignals(), stream = createTerminalStream();
stream.start("pty");
const metrics = { requests: 0, commitMs: [] as number[], scope: "initial" };
const language = new URLSearchParams(location.search).get("language") === "en-US" ? "en-US" : "zh-CN";
connectBrowserSocket({ afterSequence: () => 0, transcriptChanges: true, onUnauthorized() {}, onState() {},
  onMessage(message) { if (message.type === "transcript_changed" && message.deviceId === "fixture") signals.publish(message.sessionId); },
});
async function run(_: string, payload: JsonObject): Promise<JsonValue> {
  metrics.requests++;
  const response = await fetch("/fixture-transcript", { method: "POST", body: JSON.stringify(payload) });
  return response.json();
}
function Fixture() {
  const [active, setActive] = useState(true);
  Object.assign(window, { tapFixture: { metrics, active: setActive, wake: () => signals.publish("pty") } });
  return <div className="tap-session is-visible is-chat" style={{ height: "100vh" }}>
    <Profiler id="conversation" onRender={(_, __, elapsed) => metrics.commitMs.push(elapsed)}>
      <Conversation sessionId="pty" context={{ projectId: "project" }} scope={metrics.scope} supported incremental active={active}
        changes={signals} stream={stream} chatSize={15} run={run} t={translator(language)} onTerminal={() => {}} onReconnect={() => {}} />
    </Profiler>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
