import { useXTermController } from "../hooks/useXTermController";
import { XTermView } from "./XTermView";
import type { Props } from "../types/xTermModel";

export function XTermTerminal(props: Props) {
  return <XTermView {...useXTermController(props)} />;
}
