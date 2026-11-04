import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Exercise the real shared wrapper/context. Only the Radix DOM/Portal boundary
// is replaced: SSR cannot mount a browser portal and does not verify focus.
const primitive = (tag) => React.forwardRef(({ children, ...props }, ref) =>
  React.createElement(tag, { ...props, ref }, children));
const radix = {
  Root: ({ open, children }) => open ? children : null,
  Portal: ({ children }) => children,
  Trigger: primitive('button'), Close: primitive('button'), Overlay: primitive('div'),
  Content: primitive('section'), Title: primitive('h2'), Description: primitive('p'),
};
const cn = (...classes) => classes.filter(Boolean).join(' ');
function loadComponent(path, imports) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  const modules = { react: React, 'react/jsx-runtime': jsxRuntime, ...imports };
  new Function('require', 'exports', compiled)((name) => {
    assert.ok(name in modules, `Unexpected dependency ${name}`);
    return modules[name];
  }, exports);
  return exports;
}
const dialog = loadComponent('../src/shared/ui/dialog.tsx', {
  '@radix-ui/react-dialog': radix,
  'lucide-react': { X: () => React.createElement('svg') },
  '../lib/utils': { cn },
});
const { ConfirmDialog } = loadComponent('../src/shared/ui/ConfirmDialog.tsx', {
  './dialog': dialog, './button': { Button: primitive('button') }, '../lib/utils': { cn },
});
const { Dialog, DialogContent, DialogPresentationProvider } = dialog;
const h = React.createElement;

test('shared dialogs receive an optional presentation scope while outside dialogs keep their defaults', () => {
  const content = () => h(Dialog, { open: true }, h(DialogContent, { className: 'caller-size', style: { zIndex: 220 } }, 'Details'));
  const outside = renderToStaticMarkup(content());
  const inside = renderToStaticMarkup(h(DialogPresentationProvider, {
    contentClassName: 'settings-scope settings-radix-dialog', closeLabel: 'Close',
  }, content()));
  assert.doesNotMatch(outside, /settings-scope|settings-radix-dialog/);
  assert.match(outside, /aria-label="关闭"/);
  assert.match(inside, /settings-scope settings-radix-dialog caller-size/);
  assert.match(inside, /aria-label="Close"/);
  for (const html of [inside, outside]) assert.match(html, /z-index:220/);
});

test('confirmation dialogs inherit settings presentation through the shared wrapper and keep pending controls disabled', () => {
  const html = renderToStaticMarkup(h(DialogPresentationProvider, {
    contentClassName: 'settings-scope settings-radix-dialog', closeLabel: 'Close',
  }, h(ConfirmDialog, {
    open: true, title: 'Delete provider', message: 'Confirm deletion', pending: true,
    zIndex: 220, contentClassName: 'caller-confirm', onConfirm() {}, onClose() {},
  })));
  assert.match(html, /settings-scope settings-radix-dialog/);
  assert.match(html, /caller-confirm/);
  assert.match(html, /aria-busy="true"/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  assert.doesNotMatch(html, /aria-label="Close"/);
});
