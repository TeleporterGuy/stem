import type { TaskNotifyPayload } from '../shared/types';

/** Preserve every scheduled notification until the user acknowledges it. */
export function enqueueTaskAlert(queue: TaskNotifyPayload[], alert: TaskNotifyPayload): TaskNotifyPayload[] {
  return [...queue, alert];
}

/** Remove only the alert currently being shown, revealing the next FIFO entry. */
export function dismissTaskAlert(queue: TaskNotifyPayload[]): TaskNotifyPayload[] {
  return queue.length ? queue.slice(1) : queue;
}
