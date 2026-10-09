export const conflictInput = (page) => page.locator('[data-conflict-pane="result"] textarea.inputarea');

export async function conflictValue(page, role = 'result') {
  return page.evaluate(async (side) => {
    const { editor } = await window.__conflictTest.monaco();
    return editor.getModels().find((model) => model.uri.authority === 'conflict' && model.uri.path.endsWith('/' + side))?.getValue();
  }, role);
}

export async function replaceConflictText(page, text) {
  const input = conflictInput(page);
  await input.focus();
  await input.press('Control+A');
  await page.keyboard.insertText(text);
}
