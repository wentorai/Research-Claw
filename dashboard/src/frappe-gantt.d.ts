declare module 'frappe-gantt' {
  interface GanttTask {
    id: string;
    name: string;
    start: string;
    end: string;
    progress: number;
    dependencies?: string;
    custom_class?: string;
  }

  interface GanttOptions {
    view_mode?: 'Day' | 'Week' | 'Month' | 'Quarter Day' | 'Half Day';
    on_click?: (task: GanttTask) => void;
    on_date_change?: (task: GanttTask, start: Date, end: Date) => void;
    on_progress_change?: (task: GanttTask, progress: number) => void;
    on_view_change?: (mode: string) => void;
    custom_popup_html?: ((task: GanttTask) => string) | null;
    bar_height?: number;
    bar_corner_radius?: number;
    arrow_curve?: number;
    padding?: number;
    date_format?: string;
    language?: string;
  }

  export default class Gantt {
    constructor(
      wrapper: string | HTMLElement,
      tasks: GanttTask[],
      options?: GanttOptions,
    );
    change_view_mode(mode: GanttOptions['view_mode']): void;
    refresh(tasks: GanttTask[]): void;
  }
}
