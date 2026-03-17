import type { TaskPriority } from '../stores/tasks';

export const PRIORITY_COLORS: Record<TaskPriority, string> = {
  urgent: '#EF4444',
  high: '#F59E0B',
  medium: '#3B82F6',
  low: '#6B7280',
};
