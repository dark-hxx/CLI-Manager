import { create } from "zustand";
import { getDb } from "../lib/db";
import type { CommandTemplate, CreateTemplateInput, UpdateTemplateInput } from "../lib/types";

interface TemplateStore {
  templates: CommandTemplate[];
  fetchTemplates: () => Promise<void>;
  getForProject: (projectId: string | null) => CommandTemplate[];
  createTemplate: (input: CreateTemplateInput) => Promise<CommandTemplate>;
  updateTemplate: (id: string, input: UpdateTemplateInput) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;
}

export const useTemplateStore = create<TemplateStore>((set, get) => ({
  templates: [],

  fetchTemplates: async () => {
    const db = await getDb();
    const templates = await db.select<CommandTemplate[]>(
      "SELECT * FROM command_templates ORDER BY sort_order, name"
    );
    set({ templates });
  },

  getForProject: (projectId) => {
    const { templates } = get();
    return templates.filter(
      (t) => t.project_id === null || t.project_id === projectId
    );
  },

  createTemplate: async (input) => {
    const db = await getDb();
    const id = crypto.randomUUID();
    const template: CommandTemplate = {
      id,
      project_id: input.project_id ?? null,
      name: input.name,
      command: input.command,
      description: input.description ?? "",
      sort_order: 0,
    };
    await db.execute(
      `INSERT INTO command_templates (id, project_id, name, command, description, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [template.id, template.project_id, template.name, template.command, template.description, template.sort_order]
    );
    await get().fetchTemplates();
    return template;
  },

  updateTemplate: async (id, input) => {
    const db = await getDb();
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    for (const [key, val] of Object.entries(input)) {
      if (val !== undefined) {
        fields.push(`${key} = $${idx}`);
        values.push(val);
        idx++;
      }
    }
    if (fields.length === 0) return;
    values.push(id);
    await db.execute(
      `UPDATE command_templates SET ${fields.join(", ")} WHERE id = $${idx}`,
      values
    );
    await get().fetchTemplates();
  },

  deleteTemplate: async (id) => {
    const db = await getDb();
    await db.execute("DELETE FROM command_templates WHERE id = $1", [id]);
    await get().fetchTemplates();
  },
}));
