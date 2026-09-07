
import type { FileEditorPaneProps } from "../types/fileEditorModel";
import { useFileEditorController } from "../hooks/useFileEditorController";
import { FileEditorPaneView } from "./FileEditorPaneView";
export function FileEditorPane(props: FileEditorPaneProps) {
  return <FileEditorPaneView {...useFileEditorController(props)} />;
}
