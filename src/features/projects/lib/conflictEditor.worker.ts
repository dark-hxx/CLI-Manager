import { buildConflictEditorModel } from './conflictEditorModel';
import type { ConflictDetail } from './conflictProtocol';

self.onmessage = (event: MessageEvent<ConflictDetail>) => {
  self.postMessage(buildConflictEditorModel(event.data));
};
