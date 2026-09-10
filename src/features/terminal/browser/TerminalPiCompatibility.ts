import type { Terminal } from "@xterm/xterm";
import type { TerminalImeAnchor } from "../lib/terminalIme";
import type { TerminalBinaryFrame } from "../transport/PtyHostSocket";
import {
  containsPiOutputSignature,
  isPiTerminalContext,
  type TerminalCliContext,
} from "./TerminalCliContext";
import { createPiAnsiTransform } from "./TerminalPiAnsiTransform";
import { createPiTerminalDiagnostics } from "./TerminalPiDiagnostics";
import {
  resolvePiImeCompositionAnchor,
  resolvePiImeTextareaAnchor,
} from "./TerminalPiIme";
import { createPiOutputFilter } from "./TerminalPiOutputFilter";

const DETECTION_TAIL_LIMIT = 64;
const PI_DIAGNOSTIC_MARKER = "PI177-";

export interface PiTerminalCompatibility {
  readonly sessionId: string;
  updateContext(context: TerminalCliContext): void;
  resolveImeCompositionAnchor(terminal: Terminal, anchor: TerminalImeAnchor): TerminalImeAnchor;
  resolveImeTextareaAnchor(terminal: Terminal, anchor: TerminalImeAnchor): TerminalImeAnchor;
  shouldRefreshImeCompositionAnchor(): boolean;
  transformOutput(text: string): string;
  onFrame(frame: TerminalBinaryFrame, rawText: string, normalizedText: string): void;
  onWriteCommitted(terminal: Terminal, writtenText: string): void;
  reset(): void;
}

type DiagnosticPayload = Record<string, unknown>;
type DiagnosticEmitter = (message: string, payload: DiagnosticPayload) => void;

export function createPiTerminalCompatibility(
  sessionId: string,
  emit: DiagnosticEmitter,
  diagnosticsEnabled = import.meta.env.DEV,
): PiTerminalCompatibility {
  let piActive = false;
  let detectionTail = "";
  const ansiTransform = createPiAnsiTransform();
  const outputFilter = createPiOutputFilter();
  const diagnostics = createPiTerminalDiagnostics(sessionId, emit, diagnosticsEnabled);

  const activate = () => {
    if (piActive) return;
    piActive = true;
    diagnostics.setActive(true);
  };

  return {
    sessionId,
    updateContext(context) {
      if (isPiTerminalContext(context)) activate();
    },
    resolveImeCompositionAnchor(terminal, anchor) {
      return piActive ? resolvePiImeCompositionAnchor(terminal, anchor) : anchor;
    },
    resolveImeTextareaAnchor(terminal, anchor) {
      return piActive ? resolvePiImeTextareaAnchor(terminal, anchor) : anchor;
    },
    shouldRefreshImeCompositionAnchor() {
      return piActive;
    },
    transformOutput(text) {
      if (!piActive) return text;
      return ansiTransform.transform(outputFilter.transform(text));
    },
    onFrame(frame, rawText, normalizedText) {
      const detectionText = `${detectionTail}${rawText}`;
      if (containsPiOutputSignature(detectionText)) activate();
      if (detectionText.includes(PI_DIAGNOSTIC_MARKER)) diagnostics.setActive(true);
      detectionTail = detectionText.slice(-DETECTION_TAIL_LIMIT);
      diagnostics.onFrame(frame, rawText, normalizedText);
    },
    onWriteCommitted(terminal, writtenText) {
      diagnostics.onWriteCommitted(terminal, writtenText);
    },
    reset() {
      detectionTail = "";
      ansiTransform.reset();
      outputFilter.reset();
      diagnostics.reset();
    },
  };
}

export { isPiToolBackgroundRgb } from "./TerminalPiAnsiTransform";
export { resolvePiImeCompositionAnchor, resolvePiImeTextareaAnchor } from "./TerminalPiIme";
