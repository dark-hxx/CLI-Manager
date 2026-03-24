import { create } from "zustand";
import { getDb } from "../lib/db";
import type { CommandTemplate, CreateTemplateInput, UpdateTemplateInput } from "../lib/types";

interface TemplateStore {
  templates: CommandTemplate[];
  sessionTemplates: Record<string, CommandTemplate[]>;
  fetchTemplates: () => Promise<void>;
  getForProject: (projectId: string | null) => CommandTemplate[];
  getForContext: (projectId: string | null, sessionId: string | null) => CommandTemplate[];
  createTemplate: (input: CreateTemplateInput) => Promise<CommandTemplate>;
  createSessionTemplate: (sessionId: string, input: CreateTemplateInput) => Promise<CommandTemplate>;
  updateTemplate: (id: string, input: UpdateTemplateInput) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;
  deleteSessionTemplate: (sessionId: string, id: string) => void;
  pruneSessionTemplates: (activeSessionIds: string[]) => void;
}

export const useTemplateStore = create<TemplateStore>((set, get) => ({
  templates: [],
  sessionTemplates: {},

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

  getForContext: (projectId, sessionId) => {
    const persistent = get().getForProject(projectId);
    if (!sessionId) return persistent;
    const transient = get().sessionTemplates[sessionId] ?? [];
    return [...persistent, ...transient];
  },

  createTemplate: async (input) => {
    if (input.session_id) {
      return get().createSessionTemplate(input.session_id, input);
    }
    const db = await getDb();
    const id = crypto.randomUUID();
    const template: CommandTemplate = {
      id,
      project_id: input.project_id ?? null,
      session_id: null,
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

  createSessionTemplate: async (sessionId, input) => {
    const template: CommandTemplate = {
      id: crypto.randomUUID(),
      project_id: input.project_id ?? null,
      session_id: sessionId,
      name: input.name,
      command: input.command,
      description: input.description ?? "",
      sort_order: 0,
    };
    set((state) => {
      const current = state.sessionTemplates[sessionId] ?? [];
      return {
        sessionTemplates: {
          ...state.sessionTemplates,
          [sessionId]: [...current, template],
        },
      };
    });
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

  deleteSessionTemplate: (sessionId, id) => {
    set((state) => {
      const current = state.sessionTemplates[sessionId] ?? [];
      const next = current.filter((item) => item.id !== id);
      return {
        sessionTemplates: {
          ...state.sessionTemplates,
          [sessionId]: next,
        },
      };
    });
  },

  pruneSessionTemplates: (activeSessionIds) => {
    const active = new Set(activeSessionIds);
    set((state) => {
      const next: Record<string, CommandTemplate[]> = {};
      for (const [sessionId, templates] of Object.entries(state.sessionTemplates)) {
        if (active.has(sessionId)) {
          next[sessionId] = templates;
        }
      }
      return { sessionTemplates: next };
    });
  },
}));
