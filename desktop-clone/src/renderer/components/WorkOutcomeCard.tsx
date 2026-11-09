import type { WorkTask } from '../../shared/work';

export function WorkOutcomeCard({ task }: { task: WorkTask }) {
  if (task.status === 'running' || task.status === 'completed' || task.status === 'cancelled') return null;
  if (task.status === 'awaiting-input') return <div role="status" className="my-2 text-xs text-muted-foreground" data-work-status={task.status}>Waiting for your answer</div>;
  const title = task.status === 'blocked' ? 'Work needs attention' : task.status === 'waiting' ? 'Waiting for input' : task.status === 'paused' ? 'Work paused' : 'Work stopped';
  return <section role="status" data-slot="work-outcome-card" data-work-status={task.status} className="my-4 rounded-xl border border-border bg-muted/30 p-4">
    <div className="mb-2 text-sm font-medium">{title}</div>
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{task.summary || 'Progress has been saved.'}</p>
  </section>;
}
