import Editor, { type OnMount } from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { configureMonaco } from "@/lib/monacoSetup";
import type { NativeProviderConfigFormat } from "./nativeProviderConfigView";

configureMonaco();

type MonacoEditor = Parameters<OnMount>[0];

// 未确认回声队列的上限：正常落后只有几次按键，这个上限只用于兜住"父组件永不原样回灌"的极端情况，
// 同时避免队列长期持有几十份完整文档副本。
const PENDING_EMISSION_LIMIT = 64;


interface NativeProviderCodeEditorProps {
  format: NativeProviderConfigFormat;
  value: string;
  path: string;
  ariaLabel: string;
  height?: string;
  readOnly?: boolean;
  invalid?: boolean;
  onChange?: (value: string) => void;
}

export function NativeProviderCodeEditor({
  format,
  value,
  path,
  ariaLabel,
  height = "260px",
  readOnly = false,
  invalid = false,
  onChange,
}: NativeProviderCodeEditorProps) {
  const editorRef = useRef<MonacoEditor | null>(null);
  const onChangeRef = useRef(onChange);
  const pathRef = useRef(path);
  // 本编辑器已经吐给父组件、但还没在 props 里回灌回来的值，按发出顺序排队。
  // 受控 state 落后模型多少次按键都能靠它识别"自己的回声"，只落后一次的假设撑不住快速输入。
  const pendingEmissionsRef = useRef<string[]>([]);
  const applyingExternalRef = useRef(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const handleMount = useCallback<OnMount>((instance) => {
    editorRef.current = instance;
  }, []);

  // 订阅回调保持稳定：@monaco-editor/react 每次 onChange 身份变化都会 dispose 并重建
  // onDidChangeModelContent 订阅，设置页的 1 秒失败切换轮询会让这件事每秒发生一次。
  const handleChange = useCallback((next: string | undefined) => {
    if (applyingExternalRef.current) return;
    const text = next ?? "";
    const pending = pendingEmissionsRef.current;
    pending.push(text);
    if (pending.length > PENDING_EMISSION_LIMIT) {
      pending.splice(0, pending.length - PENDING_EMISSION_LIMIT);
    }
    onChangeRef.current?.(text);
  }, []);

  // 受控值同步由本组件接管（只给 <Editor> 传 defaultValue，不传 value）。
  // 库内置的同步会在 value 与模型不一致时用 executeEdits + forceMoveMarkers 整篇替换：
  // 快速连续输入时 React 提交的 props 可能落后模型若干次按键，每次落后都整篇改写一遍，
  // 结果就是光标塌到最后一行、以及恢复后的光标偏移把后续字符插到错位置（如 "12345" 敲成 "124"35）。
  // 因此只要模型比 props 新，就完全不写模型——用户看到的模型才是权威，props 会自己追上来。
  useEffect(() => {
    if (pathRef.current !== path) {
      pathRef.current = path;
      // 换文档等于换模型，旧文档的回声记录对新模型没有意义。
      pendingEmissionsRef.current = [];
    }
    const instance = editorRef.current;
    const model = instance?.getModel();
    if (!instance || !model) return;
    const current = model.getValue();
    const pending = pendingEmissionsRef.current;
    const acknowledged = pending.indexOf(value);
    if (acknowledged >= 0) {
      // 父组件按序回灌了我们发出的某个值：确认到这一条，更早的都可以丢。
      // 无论模型是正好等于它还是已经继续往前走，都不该回写模型。
      pending.splice(0, acknowledged + 1);
      return;
    }
    if (current === value) {
      pending.length = 0;
      return;
    }
    // 真正的外部替换（刷新、保存回填、切换供应商、生成配置）：整篇替换前记下选区与滚动位置，
    // 替换后恢复，Monaco 会把越界位置钳到合法范围。只读预览面板刷新时也不再跳回顶部。
    pending.length = 0;
    const selections = instance.getSelections();
    const scrollTop = instance.getScrollTop();
    const scrollLeft = instance.getScrollLeft();
    // 模型级编辑：只读编辑器上 executeEdits 会被拦掉，pushEditOperations 不受 readOnly 影响。
    applyingExternalRef.current = true;
    try {
      model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: value }], () => null);
    } finally {
      applyingExternalRef.current = false;
    }
    if (selections && selections.length > 0) instance.setSelections(selections);
    instance.setScrollTop(scrollTop);
    instance.setScrollLeft(scrollLeft);
  }, [path, value]);

  const options = useMemo(() => ({
    automaticLayout: true,
    ariaLabel,
    fontSize: 13,
    folding: true,
    minimap: { enabled: false },
    padding: { top: 10, bottom: 10 },
    readOnly,
    scrollBeyondLastLine: false,
    tabSize: 2,
    wordWrap: "on" as const,
  }), [ariaLabel, readOnly]);

  return (
    <div
      className={`min-w-0 overflow-hidden rounded-lg border ${invalid ? "border-red-400" : "border-border/60"}`}
      aria-invalid={invalid}
    >
      <Editor
        path={path}
        height={height}
        language={format === "json" ? "json" : "ini"}
        theme="vs"
        defaultValue={value}
        onMount={handleMount}
        onChange={onChange ? handleChange : undefined}
        options={options}
      />
    </div>
  );
}
