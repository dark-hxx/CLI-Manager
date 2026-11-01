import Editor, { type EditorProps, type OnMount } from "@monaco-editor/react";
import { useEffect, useRef } from "react";
import { fileEditorModels, syncFileEditorModels } from "../api/fileEditorModels";

export function ResidentFileEditor(props: EditorProps & { path: string }) {
  const releaseRef = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    // Monaco's wrapper disposes the view during the same commit. Defer model
    // reclamation until it has saved the cursor/scroll state and detached it.
    const release = releaseRef.current;
    releaseRef.current = null;
    queueMicrotask(() => release?.());
  }, []);
  const onMount: OnMount = (editor, monaco) => {
    releaseRef.current?.();
    const model = editor.getModel();
    if (model) releaseRef.current = fileEditorModels.acquire(props.path, model);
    syncFileEditorModels();
    props.onMount?.(editor, monaco);
  };
  return <Editor {...props} key={props.path} keepCurrentModel saveViewState onMount={onMount} />;
}
