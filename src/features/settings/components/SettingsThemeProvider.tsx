import type { ReactNode } from "react";
import {
  ActionIcon, Autocomplete, Badge, Button, Card, Checkbox, Combobox, Drawer, Input, InputWrapper,
  MantineThemeProvider, Menu, Modal, MultiSelect, Select, SegmentedControl, SimpleGrid, Switch, Table, Text, Tooltip, createTheme,
} from "@mantine/core";
import { DialogPresentationProvider } from "../../../shared/ui/dialog";
import { useI18n } from "../../../shared/i18n/index";

const dropdownClasses = {
  dropdown: "settings-scope settings-menu", option: "settings-menu-option", groupLabel: "settings-menu-group",
};

// 只覆盖此 React 子树的组件类名；Portal 仍继承主题，浮层根显式携带 CSS 变量作用域。
// 使用 MantineThemeProvider 而非另一个 MantineProvider，避免向 :root 写入设置专用变量。
const settingsTheme = createTheme({
  components: {
    SimpleGrid: SimpleGrid.extend({ defaultProps: { type: "container" } }),
    Input: Input.extend({ classNames: { input: "settings-input", wrapper: "settings-input-wrapper" } }),
    InputWrapper: InputWrapper.extend({ classNames: {
      root: "settings-field", label: "settings-field-label", description: "settings-field-description", error: "settings-field-error",
    } }),
    Button: Button.extend({ classNames: { root: "settings-button", label: "settings-button-label" } }),
    ActionIcon: ActionIcon.extend({ classNames: { root: "settings-action" } }),
    Switch: Switch.extend({ classNames: { root: "settings-switch", track: "settings-switch-track", label: "settings-field-label" } }),
    Checkbox: Checkbox.extend({ classNames: { label: "settings-field-label" } }),
    SegmentedControl: SegmentedControl.extend({ classNames: {
      root: "settings-segmented", indicator: "settings-segmented-indicator", label: "settings-segmented-label",
    } }),
    Card: Card.extend({ classNames: { root: "settings-card" } }),
    Text: Text.extend({ classNames: { root: "settings-text" } }),
    Badge: Badge.extend({ classNames: { root: "settings-badge" } }),
    Table: Table.extend({ classNames: { table: "settings-table", th: "settings-table-heading", td: "settings-table-cell" } }),
    // Select 系列以自己的 staticSelector 查询样式，不继承 Combobox 的主题 classNames。
    Combobox: Combobox.extend({ classNames: dropdownClasses }),
    Select: Select.extend({ classNames: dropdownClasses }),
    MultiSelect: MultiSelect.extend({ classNames: dropdownClasses }),
    Autocomplete: Autocomplete.extend({ classNames: dropdownClasses }),
    Menu: Menu.extend({ classNames: { dropdown: "settings-scope settings-menu", item: "settings-menu-option" } }),
    Modal: Modal.extend({ classNames: {
      content: "settings-scope settings-modal", header: "settings-modal-header", title: "settings-modal-title", body: "settings-modal-body",
    } }),
    Drawer: Drawer.extend({ classNames: {
      content: "settings-scope settings-drawer", header: "settings-modal-header", title: "settings-modal-title", body: "settings-modal-body",
    } }),
    Tooltip: Tooltip.extend({ classNames: { tooltip: "settings-tooltip" } }),
  },
});

export function SettingsThemeProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <MantineThemeProvider theme={settingsTheme}>
      <DialogPresentationProvider contentClassName="settings-scope settings-radix-dialog" closeLabel={t("common.close")}>
        {children}
      </DialogPresentationProvider>
    </MantineThemeProvider>
  );
}
